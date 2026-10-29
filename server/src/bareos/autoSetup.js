/**
 * bareos/autoSetup.js — Bareos 서버 **자동 설정**(v2.821). 관리자가 Bareos 서버의 주소·SSH 계정(root)·비밀번호를 넣으면 포탈이
 * SSH 로 접속해 설정 탭의 '사전 준비' 를 대신한다.
 *
 *  ① Director(`setupDirector`): FileSet·JobDefs·복원 잡·Console·Profile 5개 리소스 파일을 `bareos-dir.d/<종류>/<이름>.conf` 로 넣고
 *     `bareos-dir -t`(문법 검사) → `bconsole reload` → **새 콘솔로 포탈이 실제 접속**에 성공하면 그때 포탈 설정의 콘솔을 그것으로 바꾼다.
 *  ② 사이트 FD(`setupFdIni`): 사이트 매핑의 INI 경로에 vCenter 자격증명 INI(bareos 소유 0600)를 쓴다.
 *  ③ 지문 읽기(`readFdThumbprint`): FD 에서 vCenter 443 인증서의 SHA1 지문을 읽어 화면이 보여 준다(쓰기 없음 — 관리자가 대조 후 ②에 넣는다).
 *
 * 규칙(bareos/CLAUDE.md '자동 설정'):
 *  - **SSH 비밀번호·vCenter 비밀번호는 저장하지 않는다**(요청 1회만 쓰고 버린다) · 명령 인자에 싣지 않는다(SFTP 로 0600 임시 파일 → install).
 *    응답·감사·오류 문구에 싣지 않는다(검사 출력은 생성한 콘솔 비밀번호를 가린다).
 *  - **남의 파일을 덮어쓰지 않는다**: 대상 경로에 파일이 있으면 첫 줄이 `MARKER`(포탈이 만든 파일)일 때만 바꾸고, 아니면 **아무것도 쓰기 전에** 멈춘다.
 *    심링크·일반 파일이 아닌 것도 멈춘다.
 *  - **반쯤 적용된 상태를 남기지 않는다**: 쓰는 도중 실패하거나 `bareos-dir -t` 가 실패하면 새로 만든 파일은 지우고 바꾼 파일은 원래 내용으로 되돌린다
 *    (reload 전이라 Director 는 옛 설정 그대로다).
 *  - 원격 명령에 들어가는 값은 전부 화이트리스트를 지난 것(리소스 이름 `isResourceName` · 경로 `FD_PATH_RE` · 호스트 `HOST_RE`)이고 앞 글자 `-` 를 막는다.
 *  - root 만(`id -u` = 0) — sudo 경로는 두지 않는다(엣지 배포 `agent/deploy.js` 와 같은 규칙).
 *  - SSH 호스트키는 `proxy/sshExec.js withSsh` 의 단일 관문(장비 신뢰)을 그대로 지난다.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { withSsh } from '../proxy/sshExec.js';
import { remoteTmpDir } from '../agent/deploy.js';
import { openConsole } from './console.js';
import { probe } from './director.js';
import { isResourceName } from './names.js';
import { loadSettings, saveSettings, directorIssue } from './settings.js';
import { ipBlockReason, ssrfBlockReasonResolved } from '../util/ssrfBlock.js';

/**
 * 포탈이 만든 파일의 첫 줄 — 이 줄이 있는 파일만 다시 쓴다. 바꾸면 예전에 만든 파일을 '남의 파일' 로 본다(바꾸지 말 것).
 * ASCII 만(FD INI 의 첫 줄이기도 하다 — 플러그인이 C 로캘 Python 으로 인코딩 없이 읽어도 깨지지 않게).
 */
export const MARKER = '# managed-by: vmware-portal bareos auto-setup (rewritten on re-run)';
export const DIR_CONF_ROOT = '/etc/bareos/bareos-dir.d';
/**
 * 시한 예산(루트 규칙 'SSH 세션 예산 < 장비 시한' — 테스트가 산수를 고정). 세션 시한(withSsh signal)이 끝나면 연결을 끊으므로
 * 그 안에서 되돌리기가 돌 수 없다 — 단계 상한의 합이 세션 시한보다 작아야 한다. 고RTT(800ms+) 왕복 약 30회를 넉넉히 잡는다.
 */
export const BUDGET = Object.freeze({ sshReadyMs: 60_000, testMs: 60_000, reloadMs: 60_000, roundTrips: 40, roundTripMs: 2_500, sessionMs: 360_000 });
const SESSION_MS = BUDGET.sessionMs;
const RELOAD_CMD = "printf 'reload\\n' | timeout 45 bconsole 2>&1";
const READ_MAX = 1_048_576;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/;
const FD_PATH_RE = /^\/[A-Za-z0-9._/-]{1,250}$/;
const TMP_PREFIX = 'portal-bareos';

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/* ───────────────────────── 리소스 본문(웹 bareosText.js directorPrepBlock 과 같은 글 — 테스트가 대조) ───────────────────────── */

/**
 * Director 에 넣을 리소스 5개(순수). 본문은 화면의 '사전 준비' 블록과 **글자까지 같다**(`bareosAutoSetup.test.js` 가 웹 모듈과 대조).
 * @returns {{ type: string, name: string, text: string }[]}
 */
export function directorResources({ defaults = {}, consoleName, consolePassword, restoreClient, restoreStorage, restorePool }) {
  const fs = defaults.fileSet || 'PortalVmwareGeneric';
  const jd = defaults.jobDefs || 'PortalVmwareDefaults';
  const rj = defaults.restoreJob || 'PortalVmwareRestore';
  const plugin = defaults.pluginName || 'python3';
  const con = consoleName || 'portal';
  return [
    { type: 'fileset', name: fs, text: [
      'FileSet {', `  Name = "${fs}"`, '  Include {', '    Options { Signature = XXH128; Compression = LZ4 }', `    Plugin = "${plugin}:module_name=bareos-fd-vmware"`, '  }', '}',
    ].join('\n') },
    { type: 'jobdefs', name: jd, text: [
      'JobDefs {', `  Name = "${jd}"`, '  Type = Backup', '  Level = Incremental', `  FileSet = "${fs}"`, '  Messages = Standard', '  Priority = 10',
      '  Write Bootstrap = "/var/lib/bareos/%c.bsr"', '}',
    ].join('\n') },
    { type: 'job', name: rj, text: [
      'Job {', `  Name = "${rj}"`, '  Type = Restore', `  FileSet = "${fs}"`, `  Client = ${restoreClient}`, `  Storage = ${restoreStorage}`, `  Pool = ${restorePool}`, '  Where = /', '  Messages = Standard', '}',
    ].join('\n') },
    { type: 'console', name: con, text: [
      'Console {', `  Name = "${con}"`, `  Password = "${consolePassword}"`, '  Profile = "portal"', '}',
    ].join('\n') },
    { type: 'profile', name: 'portal', text: [
      'Profile {', '  Name = "portal"',
      '  Command ACL = .api, .jobs, .clients, .storages, .pools, .schedules, .jobdefs, .filesets, .bvfs_get_jobids, configure, run, restore, llist, list, cancel, enable, disable, status, version, !*all*',
      '  Job ACL = *all*', '  Client ACL = *all*', '  Storage ACL = *all*', '  Pool ACL = *all*', '  Schedule ACL = *all*', '  FileSet ACL = *all*',
      '  Catalog ACL = *all*', '  Where ACL = *all*', '  Plugin Options ACL = *all*', '}',
    ].join('\n') },
  ];
}

/** 생성 콘솔 비밀번호 — 설정 파일 따옴표 안에 그대로 들어가므로 base64url 글자만(따옴표·역슬래시 없음). */
export const newConsolePassword = () => crypto.randomBytes(24).toString('base64url');

/** vCenter 인증서 SHA1 지문 정규화 — 콜론·공백을 빼고 대문자 16진 40자. 아니면 ''. */
export function normThumbprint(v) {
  const s = String(v ?? '').replace(/[\s:]/g, '').toUpperCase();
  return /^[0-9A-F]{40}$/.test(s) ? s : '';
}

/** FD INI 값(vcuser·vcpass) 검사 — 줄바꿈·제어문자·앞뒤 공백 거부(INI 한 줄 · 앞뒤 공백은 파서가 지운다). @returns {string} 사유 */
export function iniValueIssue(v, what, max) {
  const s = typeof v === 'string' ? v : '';
  if (!s) return `${what}을(를) 입력하세요.`;
  if (s.length > max) return `${what}이(가) 너무 깁니다(${max}자 이하).`;
  if (s !== s.trim()) return `${what} 앞뒤에 공백이 있습니다.`;
  if (/[\u0000-\u001f\u007f]/.test(s)) return `${what}에 줄바꿈·제어 문자가 있습니다.`;
  return '';
}

/** FD 자격증명 INI 본문(순수). 첫 줄은 MARKER. */
export function fdIniText({ vcserver, vcuser, vcpass, vcthumbprint }) {
  return [MARKER, '[vmware_plugin_options]', `vcserver=${vcserver}`, `vcuser=${vcuser}`, `vcpass=${vcpass}`, `vcthumbprint=${vcthumbprint}`, ''].join('\n');
}

/** 출력에서 비밀을 가린다(검사 출력에 설정 줄이 그대로 실릴 수 있다). */
export function maskSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) if (typeof s === 'string' && s.length >= 4) out = out.split(s).join('****');
  return out;
}

const tail = (s, n = 1500) => { const t = String(s ?? '').trim(); return t.length > n ? `…${t.slice(-n)}` : t; };

/* ───────────────────────── 입력 정규화(순수) ───────────────────────── */

/** SSH 접속값 — host·port·username·password. @returns {{ ssh?: object, issue?: string }} */
export function normSsh(b = {}) {
  const host = String(b.host ?? '').trim();
  if (!HOST_RE.test(host)) return { issue: 'Bareos 서버 주소는 호스트 이름 또는 IP 만 적습니다(스킴·경로 없이).' };
  const block = ipBlockReason(host);
  if (block) return { issue: `이 주소에는 접속할 수 없습니다: ${block}` };
  const port = b.sshPort === undefined || b.sshPort === '' ? 22 : Number(b.sshPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { issue: 'SSH 포트가 올바르지 않습니다(1~65535).' };
  const username = String(b.username ?? '').trim() || 'root';
  if (!USER_RE.test(username)) return { issue: 'SSH 계정 이름이 올바르지 않습니다.' };
  if (typeof b.password !== 'string' || !b.password || b.password.length > 512) return { issue: 'SSH 비밀번호를 입력하세요.' };
  return { ssh: { host, port, username, password: b.password } };
}

/** 이름이 차단 대역(루프백·링크로컬 …)으로 해석되면 사유(IP 리터럴은 normSsh 가 이미 봤다). DNS 가 멈춰도 5초 뒤 통과 — 접속 단계가 어차피 실패한다. */
async function resolvedHostIssue(host) {
  const r = await Promise.race([ssrfBlockReasonResolved(host).catch(() => null), new Promise((res) => { const t = setTimeout(() => res(null), 5000); t.unref?.(); })]);
  return r ? `이 주소에는 접속할 수 없습니다: ${r}` : '';
}

/* ───────────────────────── 원격 단계(공용) ───────────────────────── */

let _ssh = withSsh;
let _openConsole = openConsole;
let _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 테스트 주입 — { ssh?(creds, fn, opts), openConsole?(conn), sleep?(ms) }. 인자 없이 부르면 실제 경로로 되돌린다. */
export function _setDepsForTest({ ssh = withSsh, openConsole: oc = openConsole, sleep } = {}) {
  _ssh = ssh; _openConsole = oc; _sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
}

const runSsh = (ssh, fn) => _ssh({ ...ssh }, fn, { signal: AbortSignal.timeout(SESSION_MS) });

async function requireRoot(exec) {
  const r = await exec('id -u');
  if (String(r?.stdout || '').trim() !== '0') throw fail('invalid', 'root 계정으로 접속해야 합니다(설정 파일을 bareos 소유로 쓰고 Director 를 reload 합니다 — sudo 경로는 쓰지 않습니다).');
}

/**
 * 대상 경로의 현재 상태. 'none'(없음) · 'managed'(포탈이 만든 파일 — old 내용 포함) · 'foreign'(남의 파일) · 'notfile'(심링크·디렉터리 등).
 * @param {string} p 화이트리스트를 지난 절대 경로
 */
async function pathState(api, p) {
  // 판정과 읽기를 root 명령 하나로(따로 하면 그 사이에 bareos 계정이 심링크로 바꿔 root 가 다른 파일을 읽을 수 있다).
  const r = await api.exec(`if [ -L ${p} ]; then echo LINK; elif [ -f ${p} ]; then echo FILE; head -c ${READ_MAX + 1} ${p}; elif [ -e ${p} ]; then echo OTHER; else echo NONE; fi`);
  const out = String(r?.stdout || '');
  const nl = out.indexOf('\n');
  const k = (nl < 0 ? out : out.slice(0, nl)).trim();
  if (k === 'NONE') return { state: 'none' };
  if (k !== 'FILE') return { state: 'notfile' };
  const old = nl < 0 ? '' : out.slice(nl + 1);
  if (old.length > READ_MAX) return { state: 'foreign' };
  return old.split('\n')[0] === MARKER ? { state: 'managed', old } : { state: 'foreign' };
}

/** tmp(0700 root) 에 0600 으로 올리고 install 로 자리에 놓는다(내용은 명령 인자에 싣지 않는다). */
async function placeFile(api, tmp, i, content, dest, mode) {
  const t = `${tmp}/f${i}`;
  await api.writeFile(t, content, 0o600);
  const r = await api.exec(`install -o bareos -g bareos -m ${mode} ${t} ${dest} && rm -f ${t}`);
  if (r?.code !== 0) throw fail('remote', `파일을 놓지 못했습니다(${dest}): ${tail(r?.stderr || r?.stdout, 300)}`);
}

/** 되돌리기 — 새로 만든 것은 지우고 바꾼 것은 옛 내용으로. 실패해도 나머지는 계속한다(남은 것은 보고한다). */
async function rollback(api, tmp, placed) {
  const left = [];
  for (const [i, f] of placed.entries()) {
    try {
      if (f.old == null) {
        const r = await api.exec(`rm -f ${f.path}`);
        if (r?.code !== 0) left.push(f.path);
      } else {
        await placeFile(api, tmp, `r${i}`, f.old, f.path, f.mode);
      }
    } catch { left.push(f.path); }
  }
  return left;
}

/** 세션이 끊긴 뒤(시한·콘솔 접속 실패)의 되돌리기 — 새 세션으로. reload 를 주면 되돌린 뒤 Director 를 다시 읽힌다. */
async function rollbackInNewSession(ssh, placed, { reload = false } = {}) {
  if (!placed.length) return { left: [], reloaded: null };
  try {
    return await runSsh(ssh, async (api) => {
      const tmp = await remoteTmpDir(api.exec, TMP_PREFIX);
      try {
        const left = await rollback(api, tmp, placed);
        let reloaded = null;
        if (reload) reloaded = (await api.exec(RELOAD_CMD, BUDGET.reloadMs))?.code === 0;
        return { left, reloaded };
      } finally { await api.exec(`rm -rf ${tmp}`).catch(() => {}); }
    });
  } catch (e) {
    return { left: placed.map((x) => x.path), reloaded: null, error: String(e?.message || e).slice(0, 200) };
  }
}

const leftText = (r) => (r.left?.length ? `되돌리지 못한 파일: ${r.left.join(', ')} — Director 호스트에서 직접 확인하세요${r.error ? `(${r.error})` : ''}` : '');

/* ───────────────────────── ① Director ───────────────────────── */

/**
 * Director 자동 설정 입력 판정(원격 접속 없음 — 라우트가 OTP 를 쓰기 **전에** 부른다: 입력 실수가 1회용 OTP 를 태우지 않게).
 * setupDirector 가 같은 함수를 다시 부른다(판정 한 곳).
 * @param {{ host, sshPort?, username?, password, directorPort?, consoleName?, restoreClient, restoreStorage, restorePool }} b
 * @throws Error(code 'invalid')
 */
export function planDirector(b = {}) {
  const { ssh, issue } = normSsh(b);
  if (issue) throw fail('invalid', issue);
  const directorPort = b.directorPort === undefined || b.directorPort === '' ? 9101 : Number(b.directorPort);
  const consoleName = String(b.consoleName ?? '').trim() || 'portal';
  if (!isResourceName(consoleName)) throw fail('invalid', '콘솔 이름은 영문·숫자·._- 64자 이하로 적습니다(파일 이름으로도 씁니다).');
  for (const [k, l] of [['restoreClient', '복원 잡의 FD 클라이언트'], ['restoreStorage', '복원 잡의 스토리지'], ['restorePool', '복원 잡의 풀']]) {
    if (!isResourceName(String(b[k] ?? ''))) throw fail('invalid', `${l} 이름을 Director 목록에서 고르세요(영문·숫자·._-).`);
  }
  const di = directorIssue({ host: ssh.host, port: directorPort, consoleName });
  if (di) throw fail('invalid', di);
  const cur = loadSettings();
  for (const k of ['fileSet', 'jobDefs', 'restoreJob']) {
    if (!isResourceName(cur.defaults[k] || '')) throw fail('invalid', `설정 탭 기본값의 ${k} 이름이 비어 있거나 올바르지 않습니다 — 먼저 기본값을 저장하세요.`);
  }
  return { ssh, directorPort, consoleName, restoreClient: String(b.restoreClient), restoreStorage: String(b.restoreStorage), restorePool: String(b.restorePool), cur };
}

/**
 * Director 자동 설정 실행. 라우트가 권한·OTP 를 먼저 본다.
 * @returns {Promise<{ ok: true, files, test, reload, probe, settings, droppedSecrets }>}
 * @throws Error(code: invalid·conflict·remote·config-test·console-login, message 사람이 읽는 사유)
 */
export async function setupDirector(b = {}) {
  const { ssh, directorPort, consoleName, restoreClient, restoreStorage, restorePool, cur } = planDirector(b);
  const ri = await resolvedHostIssue(ssh.host);
  if (ri) throw fail('invalid', ri);
  const password = newConsolePassword();
  const res = directorResources({ defaults: cur.defaults, consoleName, consolePassword: password, restoreClient, restoreStorage, restorePool })
    .map((r) => ({ ...r, path: `${DIR_CONF_ROOT}/${r.type}/${r.name}.conf`, content: `${MARKER}\n${r.text}\n`, mode: '0640' }));
  const mask = (t) => maskSecrets(t, [password, ssh.password]);
  // 놓은 파일(옛 내용 포함)은 세션 밖에서도 안다 — 세션이 시한으로 끊기면 새 세션으로 되돌린다.
  const placed = [];
  let settled = false; // 세션 안에서 되돌렸거나(실패) 끝까지 갔다(성공)

  let remote;
  try {
    remote = await runSsh(ssh, async (api) => {
      await requireRoot(api.exec);
      const env = String((await api.exec(
        `test -d ${DIR_CONF_ROOT} && echo D; test -e /etc/bareos/bareos-dir.conf && echo S; command -v bareos-dir >/dev/null 2>&1 && echo B; `
        + 'command -v bconsole >/dev/null 2>&1 && echo C; id -u bareos >/dev/null 2>&1 && echo U; command -v runuser >/dev/null 2>&1 && echo R',
      ))?.stdout || '').split(/\s+/);
      if (env.includes('S')) throw fail('invalid', '이 Director 는 단일 설정 파일(/etc/bareos/bareos-dir.conf)을 씁니다 — 그 파일이 있으면 bareos-dir.d 를 읽지 않으므로 자동 설정을 하지 않습니다. 사전 준비 블록을 그 파일에 직접 붙이세요.');
      if (!env.includes('D') || !env.includes('B')) throw fail('invalid', `이 서버에 Bareos Director 가 없습니다(${DIR_CONF_ROOT} 또는 bareos-dir 명령 없음) — bareos-director 패키지를 먼저 설치하세요.`);
      if (!env.includes('C')) throw fail('invalid', 'bconsole 명령이 없습니다 — Director reload 에 필요합니다(bareos-bconsole 패키지).');
      if (!env.includes('U')) throw fail('invalid', 'bareos 계정이 없습니다 — Bareos 패키지 설치가 끝나지 않았습니다.');

      // 1) 전부 살펴보고(쓰기 전에) 남의 파일이 하나라도 있으면 멈춘다.
      const plan = [];
      for (const f of res) {
        const st = await pathState(api, f.path);
        if (st.state === 'notfile') throw fail('conflict', `${f.path} 가 일반 파일이 아닙니다(심링크·디렉터리) — 확인 뒤 다시 시도하세요. 아무것도 바꾸지 않았습니다.`);
        plan.push({ ...f, state: st.state, old: st.old ?? null });
      }
      const foreign = plan.filter((f) => f.state === 'foreign').map((f) => f.path);
      if (foreign.length) throw fail('conflict', `이미 있는 설정 파일이 포탈이 만든 것이 아닙니다 — 덮어쓰지 않습니다(아무것도 바꾸지 않았습니다): ${foreign.join(', ')}`, { paths: foreign });

      // 2) 놓기 → 3) 검사 → 4) reload. 어느 단계든 실패하면 이 세션에서 되돌린다(reload 전이면 Director 는 옛 설정 그대로).
      const tmp = await remoteTmpDir(api.exec, TMP_PREFIX);
      try {
        for (const [i, f] of plan.entries()) {
          if (f.old === f.content) { f.action = 'unchanged'; continue; }
          await api.exec(`test -d ${path.posix.dirname(f.path)} || install -d -o bareos -g bareos -m 0750 ${path.posix.dirname(f.path)}`);
          placed.push({ path: f.path, old: f.old, mode: f.mode });
          await placeFile(api, tmp, i, f.content, f.path, f.mode);
          f.action = f.old == null ? 'created' : 'updated';
        }
        const t = await api.exec(env.includes('R') ? 'runuser -u bareos -- bareos-dir -t 2>&1' : 'bareos-dir -t 2>&1', BUDGET.testMs);
        if (t?.code !== 0) throw fail('config-test', `Director 설정 검사(bareos-dir -t)가 실패했습니다: ${tail(mask(t?.stdout || t?.stderr))}`);
        const rl = await api.exec(RELOAD_CMD, BUDGET.reloadMs);
        if (rl?.code !== 0) throw fail('remote', `Director reload(bconsole)가 실패했습니다(종료 코드 ${rl?.code ?? '—'}): ${tail(mask(rl?.stdout || rl?.stderr), 400) || '출력 없음'}`);
        settled = true;
        return { files: plan.map((f) => ({ path: f.path, action: f.action })), test: tail(mask(t?.stdout), 600), reload: tail(mask(rl?.stdout), 600) };
      } catch (e) {
        if (placed.length) {
          const left = await rollback(api, tmp, placed).catch(() => placed.map((x) => x.path));
          // 되돌리지 못한 것이 있으면(세션이 끊긴 경우 등) 바깥이 새 세션으로 다시 되돌린다.
          settled = !left.length;
          if (settled) e.message = `${e.message} — 넣은 파일을 되돌렸습니다.`;
        } else settled = true;
        throw e;
      } finally {
        await api.exec(`rm -rf ${tmp}`).catch(() => {});
      }
    });
  } catch (e) {
    // 세션이 시한으로 끊겼다(세션 안 되돌리기가 돌지 못함) — 새 세션으로 되돌리고 Director 를 다시 읽힌다.
    if (!settled && placed.length) {
      const rb = await rollbackInNewSession(ssh, placed, { reload: true });
      e.message = `${mask(String(e?.message || e))} — ${rb.left.length ? leftText(rb) : `세션이 끊겨 새 세션으로 넣은 파일을 되돌렸습니다(reload ${rb.reloaded === false ? '실패 — 직접 reload 하세요' : '완료'}).`}`;
    }
    throw e;
  }

  // 5) 포탈이 새 콘솔로 실제 접속 — 성공해야만 설정을 바꾼다. 실패하면 넣은 파일을 되돌리고 다시 reload 한다
  //    (그대로 두면 같은 이름 콘솔을 다시 만든 경우 Director 만 새 비밀번호가 되어 쓰던 연결이 끊긴다).
  const conn = { host: ssh.host, port: directorPort, name: consoleName, password, timeoutMs: cur.director.timeoutMs, tlsMaxVersion: cur.director.tlsMax };
  let pr = null; let lastErr = null;
  for (let i = 0; i < 2 && !pr; i++) {
    if (i) await _sleep(2000);
    try { const s = await _openConsole(conn); try { pr = await probe(s); } finally { s.close?.(); } } catch (e) { lastErr = e; }
  }
  if (!pr) {
    const rb = await rollbackInNewSession(ssh, placed, { reload: true });
    const undone = !rb.left.length;
    throw fail('console-login', `포탈이 새 콘솔 ‘${consoleName}’ 로 접속하지 못했습니다(${lastErr?.code || 'error'}: ${mask(String(lastErr?.message || lastErr)).slice(0, 300)}). `
      + (undone ? `넣은 파일을 되돌리고 Director 를 다시 읽혔습니다(reload ${rb.reloaded === false ? '실패 — 직접 reload 하세요' : '완료'}). 포탈 설정은 바꾸지 않았습니다.`
        : `${leftText(rb)}. 포탈 설정은 바꾸지 않았습니다.`), { files: remote.files });
  }
  const saved = saveSettings({ director: { host: ssh.host, port: directorPort, consoleName, password } });
  return { ok: true, files: remote.files, test: remote.test, reload: remote.reload, probe: pr, settings: saved.settings, droppedSecrets: saved.droppedSecrets };
}

/* ───────────────────────── ② 사이트 FD INI ───────────────────────── */

function siteOf(vcenterId) {
  const site = loadSettings().sites.find((s) => s.vcenterId === String(vcenterId || ''));
  if (!site) throw fail('invalid', '이 vCenter 의 사이트 매핑이 없습니다 — 설정 탭에서 매핑(FD·스토리지·풀·INI 경로)을 먼저 저장하세요.');
  if (!FD_PATH_RE.test(site.configFile) || /(^|\/)\.\.(\/|$)/.test(site.configFile)) throw fail('invalid', '사이트 매핑의 INI 경로가 올바르지 않습니다.');
  if (!HOST_RE.test(site.vcserver)) throw fail('invalid', '사이트 매핑의 vcserver 주소가 올바르지 않습니다.');
  return site;
}

/**
 * 사이트 FD 에 vCenter 자격증명 INI 를 쓴다(bareos 소유 0600). vCenter 비밀번호는 이 요청에서만 쓰고 저장하지 않는다.
 * planFdIni = 입력 판정(원격 접속 없음 — 라우트가 OTP 전에 부른다).
 * @param {{ vcenterId, host, sshPort?, username?, password, vcuser, vcpass, vcthumbprint }} b
 */
export function planFdIni(b = {}) {
  const site = siteOf(b.vcenterId);
  const { ssh, issue } = normSsh(b);
  if (issue) throw fail('invalid', issue);
  const ui = iniValueIssue(b.vcuser, 'vCenter 계정', 128) || iniValueIssue(b.vcpass, 'vCenter 비밀번호', 256);
  if (ui) throw fail('invalid', ui);
  const vcthumbprint = normThumbprint(b.vcthumbprint);
  if (!vcthumbprint) throw fail('invalid', 'vCenter 인증서 SHA1 지문(16진 40자 — 콜론은 있어도 됩니다)을 넣으세요. ‘FD 에서 지문 읽기’ 로 읽은 값을 vCenter 화면의 값과 대조하세요.');
  return { site, ssh, vcthumbprint };
}

export async function setupFdIni(b = {}) {
  const { site, ssh, vcthumbprint } = planFdIni(b);
  const ri = await resolvedHostIssue(ssh.host);
  if (ri) throw fail('invalid', ri);
  const content = fdIniText({ vcserver: site.vcserver, vcuser: b.vcuser, vcpass: b.vcpass, vcthumbprint });
  const dest = site.configFile;
  const dir = path.posix.dirname(dest);

  const out = await runSsh(ssh, async (api) => {
    await requireRoot(api.exec);
    if (String((await api.exec('id -u bareos >/dev/null 2>&1 && echo U'))?.stdout || '').trim() !== 'U') throw fail('invalid', '이 서버에 bareos 계정이 없습니다 — 사이트 FD(bareos-filedaemon)가 설치된 서버인지 확인하세요.');
    const st = await pathState(api, dest);
    if (st.state === 'notfile') throw fail('conflict', `${dest} 가 일반 파일이 아닙니다(심링크·디렉터리) — 아무것도 바꾸지 않았습니다.`);
    if (st.state === 'foreign') throw fail('conflict', `${dest} 에 포탈이 만들지 않은 파일이 있습니다 — 덮어쓰지 않습니다(아무것도 바꾸지 않았습니다). 지우거나 매핑의 INI 경로를 바꾼 뒤 다시 시도하세요.`, { paths: [dest] });
    const mk = await api.exec(`test -d ${dir} || install -d -o root -g bareos -m 0750 ${dir}`);
    if (mk?.code !== 0) throw fail('remote', `INI 폴더를 만들지 못했습니다(${dir}): ${tail(mk?.stderr, 200)}`);
    const tmp = await remoteTmpDir(api.exec, TMP_PREFIX);
    try {
      await placeFile(api, tmp, 0, content, dest, '0600');
    } finally {
      await api.exec(`rm -rf ${tmp}`).catch(() => {});
    }
    // 참고 정보(판정 아님): 플러그인 패키지 설치 여부.
    const pk = await api.exec('rpm -q bareos-vmware-plugin 2>/dev/null || dpkg-query -W bareos-vmware-plugin 2>/dev/null || echo NOPKG').catch(() => null);
    const pkText = String(pk?.stdout || '').trim();
    return { action: st.state === 'managed' ? 'updated' : 'created', plugin: !pkText || /NOPKG|not installed|no packages found/i.test(pkText) ? 'missing' : 'installed', pluginText: tail(pkText, 200) };
  });
  return {
    ok: true, vcenterId: site.vcenterId, path: dest, action: out.action, plugin: out.plugin, pluginText: out.pluginText,
    ...(b.vcpass.includes('%') ? { note: '비밀번호에 ‘%’ 가 있습니다 — 플러그인의 INI 해석 방식에 따라 ‘%%’ 로 적어야 할 수 있습니다(미확인). 첫 백업 로그로 확인하세요.' } : {}),
  };
}

/* ───────────────────────── ③ FD 에서 vCenter 지문 읽기 ───────────────────────── */

/** openssl 출력 → { thumbprint, subject, notAfter } (순수). */
export function parseOpensslFingerprint(text) {
  const s = String(text ?? '');
  const fp = /SHA1 Fingerprint=([0-9A-Fa-f:]+)/i.exec(s);   // OpenSSL 3 은 'sha1 Fingerprint=', 1.1 은 'SHA1 Fingerprint='
  const subj = /^subject=\s*(.+)$/m.exec(s);
  const end = /^notAfter=\s*(.+)$/m.exec(s);
  return { thumbprint: normThumbprint(fp?.[1] || ''), subject: (subj?.[1] || '').trim().slice(0, 300), notAfter: (end?.[1] || '').trim().slice(0, 64) };
}

/** 사이트 FD 에서 그 vCenter(vcserver:443)의 인증서 지문을 읽는다(쓰기 없음). FD 에서 보이는 값이어야 플러그인이 받는 값과 같다. */
export async function readFdThumbprint(b = {}) {
  const site = siteOf(b.vcenterId);
  const { ssh, issue } = normSsh(b);
  if (issue) throw fail('invalid', issue);
  const ri = await resolvedHostIssue(ssh.host);
  if (ri) throw fail('invalid', ri);
  const v = site.vcserver;   // 콜론 없음(settings.js — 플러그인 값 규칙이 ':' 를 거부한다) → IPv6 리터럴은 오지 않는다
  if (v.includes(':')) throw fail('invalid', '사이트 매핑의 vcserver 에 콜론이 있습니다.');
  const target = `${v}:443`;
  const sni = /^\d{1,3}(\.\d{1,3}){3}$/.test(v) ? '' : ` -servername ${v}`;
  const r = await runSsh(ssh, async (api) => ({
    out: await api.exec(`timeout 20 openssl s_client -connect ${target}${sni} </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha1 -subject -enddate 2>&1`, 40_000),
  }));
  const p = parseOpensslFingerprint(r.out?.stdout);
  if (!p.thumbprint) throw fail('remote', `FD 에서 ${target} 의 인증서를 읽지 못했습니다(openssl 없음·443 막힘·이름 해석 실패) — ${tail(r.out?.stdout || r.out?.stderr, 200) || '출력 없음'}`);
  return { ok: true, vcenterId: site.vcenterId, vcserver: v, ...p };
}
