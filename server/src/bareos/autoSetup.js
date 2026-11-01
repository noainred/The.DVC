/**
 * bareos/autoSetup.js — Bareos 서버 **자동 설정**(v2.821). 관리자가 Bareos 서버의 주소·SSH 계정(root)·비밀번호를 넣으면 포탈이
 * SSH 로 접속해 설정 탭의 '사전 준비' 를 대신한다.
 *
 *  ① Director(`setupDirector`): FileSet·JobDefs·복원 잡·Console·Profile 5개 리소스 파일을 `bareos-dir.d/<종류>/<이름>.conf` 로 넣고
 *     `bareos-dir -t`(문법 검사) → `bconsole reload` → **새 콘솔로 포탈이 실제 접속**에 성공하면 그때 포탈 설정의 콘솔을 그것으로 바꾼다.
 *  ② 사이트 FD(`setupFdIni`): 사이트 매핑의 INI 경로에 vCenter 자격증명 INI(bareos 소유 0600)를 쓴다.
 *  ③ 지문 읽기(`readFdThumbprint`): FD 에서 vCenter 443 인증서의 SHA1 지문을 읽어 화면이 보여 준다(쓰기 없음 — 관리자가 대조 후 ②에 넣는다).
 *  v2.823 법인별 Director(사용자 요청 '법인에 bareos 초기 설치만 하면 세부 설정을 포탈에서'): 모든 단계는 **Director 하나**(`directorId`)를 대상으로 한다.
 *  ④ 사전 점검(`preflight`): 쓰기 없이 패키지·서비스·Python·pyVmomi·VDDK·FD 플러그인 줄·설정 구성·기본 리소스 이름을 읽는다(못 읽은 것은 '확인 불가').
 *  ⑤ FD 플러그인 켜기(`setupFdPlugin`): 패키지 파일 `bareos-fd.d/client/myself.conf` 를 **제자리 수정**하는 유일한 예외 — Client 블록이 하나일 때만,
 *     없는 줄만 넣고(같은 값이면 그대로) **다른 값이면 거부**(사람이 정한 값을 덮지 않는다) · 쓰기 전 사본 · `bareos-fd -t` · 재시작 · 실패면 사본으로 원복.
 *  ⑥ Pool·Schedule(①의 선택 블록): VMware 전용 Full·Incr 풀과 야간 스케줄을 MARKER 파일로 넣는다(JobDefs 가 레벨별 풀을 고른다).
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
import { isResourceName, OWN_TYPES, OWN_PER_TYPE } from './names.js';
import { loadSettings, updateDirector, directorIssue, directorCred, directorById } from './settings.js';
import { bareosAuthGuard } from './service.js';
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
// v2.823 검토(P5 — 왕복 계수): Pool·Schedule 3개가 늘어 '재실행 + reload 실패 → 세션 안 되돌림(파일마다 쓰기·설치) → 다시 reload' 최악 경로가
//   reload 2회 + 약 53왕복이 됐다(372.5초 > 옛 세션 시한 360초). reload 를 두 번 세고 왕복을 60으로 잡는다.
export const BUDGET = Object.freeze({ sshReadyMs: 60_000, testMs: 60_000, reloadMs: 60_000, reloads: 2, roundTrips: 60, roundTripMs: 2_500, sessionMs: 420_000 });
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
export const VMWARE_POOL_FULL = 'PortalVmwareFull';
export const VMWARE_POOL_INCR = 'PortalVmwareIncr';
export const VMWARE_SCHEDULE = 'PortalVmwareNightly';
export const WEEKDAYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

/**
 * Pool·Schedule 입력 정규화(순수 — 화면 블록과 같은 판정). 둘 다 선택이다(없으면 null).
 * @returns {{ pools: {fullDays, incrDays, maxVolumeGB}|null, schedule: {fullDay, time}|null, issue?: string }}
 */
export function normVmwareExtras(b = {}) {
  let pools = null; let schedule = null;
  if (b.pools && typeof b.pools === 'object') {
    const n = (v, min, max) => { const x = Number(v); return Number.isInteger(x) && x >= min && x <= max ? x : null; };
    const fullDays = n(b.pools.fullDays, 1, 3650); const incrDays = n(b.pools.incrDays, 1, 3650); const maxVolumeGB = n(b.pools.maxVolumeGB, 1, 1024);
    if (fullDays === null || incrDays === null) return { pools, schedule, issue: '풀 보존 기간은 1~3650일(정수)로 적습니다.' };
    if (maxVolumeGB === null) return { pools, schedule, issue: '볼륨 최대 크기는 1~1024 GB(정수)로 적습니다.' };
    pools = { fullDays, incrDays, maxVolumeGB };
  }
  if (b.schedule && typeof b.schedule === 'object') {
    const fullDay = String(b.schedule.fullDay || '');
    const time = String(b.schedule.time || '');
    if (!WEEKDAYS.includes(fullDay)) return { pools, schedule, issue: '전체 백업 요일을 고르세요.' };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { pools, schedule, issue: '백업 시각은 HH:MM(00:00~23:59)으로 적습니다.' };
    schedule = { fullDay, time };
  }
  return { pools, schedule };
}

/**
 * Director 에 넣을 리소스(순수). 기본 5개 + 선택한 Pool 2개·Schedule 1개. 본문은 화면의 '사전 준비' 블록과 **글자까지 같다**
 * (`bareosAutoSetup.test.js` 가 웹 모듈과 대조). 풀을 만들면 JobDefs 가 레벨별 풀(Full → Full 풀, 증분·차등 → Incr 풀)을 고른다.
 * @returns {{ type: string, name: string, text: string }[]}
 */
export function directorResources({ defaults = {}, consoleName, consolePassword, restoreClient, restoreStorage, restorePool, pools = null, schedule = null }) {
  const fs = defaults.fileSet || 'PortalVmwareGeneric';
  const jd = defaults.jobDefs || 'PortalVmwareDefaults';
  const rj = defaults.restoreJob || 'PortalVmwareRestore';
  const plugin = defaults.pluginName || 'python3';
  const con = consoleName || 'portal';
  const out = [
    { type: 'fileset', name: fs, text: [
      'FileSet {', `  Name = "${fs}"`, '  Include {', '    Options { Signature = XXH128; Compression = LZ4 }', `    Plugin = "${plugin}:module_name=bareos-fd-vmware"`, '  }', '}',
    ].join('\n') },
    { type: 'jobdefs', name: jd, text: [
      'JobDefs {', `  Name = "${jd}"`, '  Type = Backup', '  Level = Incremental', `  FileSet = "${fs}"`, '  Messages = Standard', '  Priority = 10',
      '  Write Bootstrap = "/var/lib/bareos/%c.bsr"',
      ...(pools ? [`  Full Backup Pool = "${VMWARE_POOL_FULL}"`, `  Differential Backup Pool = "${VMWARE_POOL_INCR}"`, `  Incremental Backup Pool = "${VMWARE_POOL_INCR}"`] : []),
      '}',
    ].join('\n') },
    { type: 'job', name: rj, text: [
      'Job {', `  Name = "${rj}"`, '  Type = Restore', `  FileSet = "${fs}"`, `  Client = ${restoreClient}`, `  Storage = ${restoreStorage}`, `  Pool = ${restorePool}`, '  Where = /', '  Messages = Standard', '}',
    ].join('\n') },
    { type: 'console', name: con, text: [
      'Console {', `  Name = "${con}"`, `  Password = "${consolePassword}"`, '  Profile = "portal"', '}',
    ].join('\n') },
    { type: 'profile', name: 'portal', text: [
      'Profile {', '  Name = "portal"',
      '  Command ACL = .api, .jobs, .clients, .storages, .pools, .schedule, .jobdefs, .filesets, .bvfs_get_jobids, configure, run, restore, llist, list, cancel, enable, disable, delete, status, show, version, !*all*',
      '  Job ACL = *all*', '  Client ACL = *all*', '  Storage ACL = *all*', '  Pool ACL = *all*', '  Schedule ACL = *all*', '  FileSet ACL = *all*',
      '  Catalog ACL = *all*', '  Where ACL = *all*', '  Plugin Options ACL = *all*', '}',
    ].join('\n') },
  ];
  if (pools) {
    const pool = (name, days) => ({ type: 'pool', name, text: [
      'Pool {', `  Name = "${name}"`, '  Pool Type = Backup', '  Recycle = yes', '  AutoPrune = yes', `  Volume Retention = ${days} days`,
      `  Maximum Volume Bytes = ${pools.maxVolumeGB}G`, `  Label Format = "${name}-"`, '}',
    ].join('\n') });
    out.push(pool(VMWARE_POOL_FULL, pools.fullDays), pool(VMWARE_POOL_INCR, pools.incrDays));
  }
  if (schedule) {
    out.push({ type: 'schedule', name: VMWARE_SCHEDULE, text: [
      'Schedule {', `  Name = "${VMWARE_SCHEDULE}"`, `  Run = Full ${schedule.fullDay} at ${schedule.time}`,
      ...WEEKDAYS.filter((d) => d !== schedule.fullDay).map((d) => `  Run = Incremental ${d} at ${schedule.time}`), '}',
    ].join('\n') });
  }
  return out;
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
  // v2.822.3(C2-1 — 플러그인 소스 확인): bareos-fd-vmware 는 configparser.ConfigParser()(보간 켬)로 읽고 IOError 만 잡는다 —
  //   값의 '%' 는 보간 문법이라 InterpolationSyntaxError 로 그 사이트 백업이 전부 실패했다. '%%' 로 적으면 '%' 로 읽힌다.
  const ini = (v) => String(v).replace(/%/g, '%%');
  return [MARKER, '[vmware_plugin_options]', `vcserver=${vcserver}`, `vcuser=${ini(vcuser)}`, `vcpass=${ini(vcpass)}`, `vcthumbprint=${vcthumbprint}`, ''].join('\n');
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

/**
 * extra: 부른 쪽의 시한 신호(v2.824 엣지 대행 — 작업 ttl). 본 작업 세션에만 준다 — 되돌리기 세션(rollbackInNewSession·사본 복원)에는 주지 않는다
 * (시한이 지나 끊겼으니 되돌려야 한다 · 검토 P3).
 */
const runSsh = (ssh, fn, extra = null) => _ssh({ ...ssh }, fn, { signal: extra ? AbortSignal.any([AbortSignal.timeout(SESSION_MS), extra]) : AbortSignal.timeout(SESSION_MS) });

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
  // v2.822.3(S2-1 — 재현): 마지막 조각만 보면 **부모 디렉터리**가 심링크일 때(bareos-dir.d 는 bareos 소유 — 패키지가 chown -R) root 가 그 밖을 읽고 썼다.
  const r = await api.exec(`if ! ${canonDir(p)}; then echo LINK; elif [ -L ${p} ]; then echo LINK; elif [ -f ${p} ]; then echo FILE; head -c ${READ_MAX + 1} ${p}; elif [ -e ${p} ]; then echo OTHER; else echo NONE; fi`);
  const out = String(r?.stdout || '');
  const nl = out.indexOf('\n');
  const k = (nl < 0 ? out : out.slice(0, nl)).trim();
  if (k === 'NONE') return { state: 'none' };
  if (k !== 'FILE') return { state: 'notfile' };
  const old = nl < 0 ? '' : out.slice(nl + 1);
  if (old.length > READ_MAX) return { state: 'foreign' };
  return old.split('\n')[0] === MARKER ? { state: 'managed', old } : { state: 'foreign' };
}

/**
 * 부모 디렉터리가 정규 경로인가(심링크를 거치지 않는가) — 같은 셸 명령 안에서 install·rm·읽기 바로 앞에 둔다(창을 줄인다).
 * 남는 창(검사와 install 사이 바꿔치기)은 bareos 계정을 이미 쥔 경우뿐이고, 그 계정은 Director 로서 FD 를 부릴 수 있다(추정 — CLAUDE.md 에 기록).
 */
const canonDir = (p) => { const d = path.posix.dirname(p); return `[ "$(readlink -f -- ${d})" = "${d}" ]`; };

/** tmp(0700 root) 에 0600 으로 올리고 install 로 자리에 놓는다(내용은 명령 인자에 싣지 않는다). */
async function placeFile(api, tmp, i, content, dest, mode, owner = 'bareos', group = 'bareos') {
  const t = `${tmp}/f${i}`;
  await api.writeFile(t, content, 0o600);
  const r = await api.exec(`${canonDir(dest)} && install -o ${owner} -g ${group} -m ${mode} ${t} ${dest} && rm -f ${t}`);
  if (r?.code !== 0) throw fail('remote', `파일을 놓지 못했습니다(${dest} — 경로에 심링크가 있거나 쓰기 실패): ${tail(r?.stderr || r?.stdout, 300)}`);
}

/** 되돌리기 — 새로 만든 것은 지우고 바꾼 것은 옛 내용으로. 실패해도 나머지는 계속한다(남은 것은 보고한다). */
async function rollback(api, tmp, placed) {
  const left = [];
  for (const [i, f] of placed.entries()) {
    try {
      if (f.old == null) {
        const r = await api.exec(`${canonDir(f.path)} && rm -f ${f.path}`);
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
/**
 * v2.824 엣지 대행: ctx 를 주면 중앙 설정 대신 그 값으로 한다(엣지는 중앙 bareos.json 이 없다 — bareos/edgeSetup.js).
 *   ctx = { dir, cur?: { directors, defaults }, site?, consolePassword?, save?(conn) → { director, droppedSecrets }, clearAuthStop?() }
 *   입력 판정(중앙 plan)은 라우트가 중앙에서 먼저 한다 — 엣지에서는 같은 판정을 다시 지난다(받은 값을 믿지 않는다).
 */
export function planDirector(b = {}, ctx = null) {
  const cur = ctx?.cur || loadSettings();
  const dir = ctx?.dir || directorById(b.directorId, cur);
  if (!dir) throw fail('invalid', '자동 설정할 법인 Director 를 고르세요(설정 › 법인별 Director 에서 먼저 추가합니다).');
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
  // 다른 법인 Director 가 같은 콘솔(주소:포트·이름)을 이미 쓰면 거부 — 두 항목이 한 콘솔을 나눠 쓰면 원장이 둘로 갈린다
  const lc = (x) => String(x || '').toLowerCase();
  const clash = cur.directors.find((o) => o.id !== dir.id && lc(o.host) === lc(ssh.host) && Number(o.port) === directorPort && o.consoleName === consoleName);
  if (clash) throw fail('invalid', `같은 콘솔(${ssh.host}:${directorPort} · ${consoleName})을 ‘${clash.name}’ Director 가 이미 씁니다 — 다른 콘솔 이름을 쓰세요.`);
  for (const k of ['fileSet', 'jobDefs', 'restoreJob']) {
    if (!isResourceName(cur.defaults[k] || '')) throw fail('invalid', `설정 탭 기본값의 ${k} 이름이 비어 있거나 올바르지 않습니다 — 먼저 기본값을 저장하세요.`);
  }
  const ex = normVmwareExtras(b);
  if (ex.issue) throw fail('invalid', ex.issue);
  return { dir, ssh, directorPort, consoleName, restoreClient: String(b.restoreClient), restoreStorage: String(b.restoreStorage), restorePool: String(b.restorePool), pools: ex.pools, schedule: ex.schedule, cur };
}

/**
 * Director 자동 설정 실행. 라우트가 권한·OTP 를 먼저 본다.
 * @returns {Promise<{ ok: true, files, test, reload, probe, settings, droppedSecrets }>}
 * @throws Error(code: invalid·conflict·remote·config-test·console-login, message 사람이 읽는 사유)
 */
export async function setupDirector(b = {}, ctx = null) {
  const { dir, ssh, directorPort, consoleName, restoreClient, restoreStorage, restorePool, pools, schedule, cur } = planDirector(b, ctx);
  const ri = await resolvedHostIssue(ssh.host);
  if (ri) throw fail('invalid', ri);
  // 엣지 대행은 새 콘솔 비밀번호를 **중앙이 만들어** 보낸다(중앙이 회신 ok 뒤 그 값으로 저장 — 계획서 2-3)
  const password = typeof ctx?.consolePassword === 'string' && /^[A-Za-z0-9_-]{32}$/.test(ctx.consolePassword) ? ctx.consolePassword : newConsolePassword();
  const clearStop = () => (ctx?.clearAuthStop ? ctx.clearAuthStop() : clearStaleAuthStop(dir.id));
  const res = directorResources({ defaults: cur.defaults, consoleName, consolePassword: password, restoreClient, restoreStorage, restorePool, pools, schedule })
    .map((r) => ({ ...r, path: `${DIR_CONF_ROOT}/${r.type}/${r.name}.conf`, content: `${MARKER}\n${r.text}\n`, mode: '0640' }));
  // v2.822.3(S2-5 — 재현): SSH 비밀번호를 부분 문자열로 가리면 '****-dir' 처럼 가린 자리가 곧 비밀번호가 됐다(감사·응답).
  //   생성 콘솔 비밀번호만 가리고, 출력에 SSH 비밀번호와 같은 글자가 있으면 출력 전체를 싣지 않는다.
  const mask = (t) => {
    const x = String(t ?? '');
    if (ssh.password.length >= 4 && x.includes(ssh.password)) return '(출력을 싣지 않습니다 — SSH 비밀번호와 같은 글자가 들어 있습니다)';
    return maskSecrets(x, [password]);
  };
  // 놓은 파일(옛 내용 포함)은 세션 밖에서도 안다 — 세션이 시한으로 끊기면 새 세션으로 되돌린다.
  const placed = [];
  let settled = false; // 세션 안에서 되돌렸거나(실패) 끝까지 갔다(성공)
  let reloadTried = false;

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
      const foreign = plan.filter((f) => f.state === 'foreign');
      if (foreign.length) throw fail('conflict', conflictMessage(foreign, consoleName), { paths: foreign.map((f) => f.path) });

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
        reloadTried = true;
        const rl = await api.exec(RELOAD_CMD, BUDGET.reloadMs);
        if (rl?.code !== 0) throw fail('remote', `Director reload(bconsole)가 실패했습니다(종료 코드 ${rl?.code ?? '—'}): ${tail(mask(rl?.stdout || rl?.stderr), 400) || '출력 없음'}`);
        settled = true;
        return { files: plan.map((f) => ({ path: f.path, action: f.action })), test: tail(mask(t?.stdout), 600), reload: tail(mask(rl?.stdout), 600) };
      } catch (e) {
        if (placed.length) {
          const left = await rollback(api, tmp, placed).catch(() => placed.map((x) => x.path));
          // 되돌리지 못한 것이 있으면(세션이 끊긴 경우 등) 바깥이 새 세션으로 다시 되돌린다.
          settled = !left.length;
          if (settled) {
            // v2.822.3(C2-4): reload 를 보냈다면(bconsole 이 시한으로 끝나도 Director 는 이미 읽었을 수 있다) 되돌린 뒤 다시 읽힌다 —
            //   안 그러면 Director 메모리만 새 콘솔 비밀번호가 되어 같은 이름 콘솔로 쓰던 연결이 끊긴다.
            let again = null;
            if (reloadTried) again = await api.exec(RELOAD_CMD, BUDGET.reloadMs).catch(() => null);
            e.message = `${e.message} — 넣은 파일을 되돌렸습니다${reloadTried ? (again?.code === 0 ? '(Director 를 다시 읽혔습니다)' : '(Director 를 다시 읽히지 못했습니다 — 직접 reload 하세요)') : ''}.`;
          }
        } else settled = true;
        throw e;
      } finally {
        await api.exec(`rm -rf ${tmp}`).catch(() => {});
      }
    }, ctx?.signal);
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
  const conn = { host: ssh.host, port: directorPort, name: consoleName, password, timeoutMs: dir.timeoutMs, tlsMaxVersion: dir.tlsMax };
  let pr = null; let lastErr = null;
  if (typeof ctx?.verifyConsole === 'function') {
    // v2.844 완전 설치: 담당이 엣지인 새 Director 는 중앙이 9101 에 붙지 않는다(한 서버 안에서만 통신 — 방화벽을 열지 않는다).
    //   서버 안 bconsole 로 새 콘솔 접속을 확인하고(실패면 아래와 같이 되돌림), 포탈(엣지) 접속은 설치 6단계가 엣지 경유로 확인한다.
    try { pr = await ctx.verifyConsole({ consoleName, password, directorPort }); } catch (e) { lastErr = e; }
  } else {
    for (let i = 0; i < 2 && !pr; i++) {
      if (i) await _sleep(2000);
      try { const s = await _openConsole(conn); try { pr = await probe(s); } finally { s.close?.(); } } catch (e) { lastErr = e; }
    }
  }
  if (!pr) {
    const rb = await rollbackInNewSession(ssh, placed, { reload: true });
    clearStop();
    const undone = !rb.left.length;
    throw fail('console-login', `포탈이 새 콘솔 ‘${consoleName}’ 로 접속하지 못했습니다(${lastErr?.code || 'error'}: ${mask(String(lastErr?.message || lastErr)).slice(0, 300)}). `
      + (undone ? `넣은 파일을 되돌리고 Director 를 다시 읽혔습니다(reload ${rb.reloaded === false ? '실패 — 직접 reload 하세요' : '완료'}). 포탈 설정은 바꾸지 않았습니다.`
        : `${leftText(rb)}. 포탈 설정은 바꾸지 않았습니다.`), { files: remote.files });
  }
  // v2.822.3(C2-5·I2-2 — 재현): 저장이 실패하면(비밀 정책 잠금·디스크) Director 만 새 비밀번호가 되고 생성 비밀번호는 잃는다 — 되돌린다.
  let saved;
  try {
    saved = ctx?.save ? ctx.save({ host: ssh.host, port: directorPort, consoleName, password }) : updateDirector(dir.id, { host: ssh.host, port: directorPort, consoleName, password });
  } catch (se) {
    const rb = await rollbackInNewSession(ssh, placed, { reload: true });
    clearStop();
    // 사유는 코드만(오류 원문에 CONFIG_DIR 경로가 실린다)
    throw fail('save', `새 콘솔 접속은 됐지만 포탈 설정을 저장하지 못했습니다(${se?.code || '저장 오류'}). `
      + (rb.left.length ? `${leftText(rb)}.` : `넣은 파일을 되돌리고 Director 를 다시 읽혔습니다(reload ${rb.reloaded === false ? '실패 — 직접 reload 하세요' : '완료'}). 포탈 설정은 그대로입니다.`), { files: remote.files });
  }
  return { ok: true, directorId: dir.id, files: remote.files, test: remote.test, reload: remote.reload, probe: pr, director: saved.director, droppedSecrets: saved.droppedSecrets };
}

/**
 * v2.822.3(P2-12): reload 뒤 되돌리기 전까지 주기 조회가 옛 비밀번호로 붙어 인증 실패(정지)를 남길 수 있다 — 되돌린 뒤에는 그 정지가
 * 사실이 아니므로 지운다(남기면 수동 조회가 성공할 때까지 주기 조회가 멈춘다).
 */
function clearStaleAuthStop(directorId) {
  try { const d = directorById(directorId); if (d) bareosAuthGuard.clearAuthStop(directorCred(d).id); } catch { /* 설정을 못 읽으면 그대로 */ }
}

/* ───────────────────────── ② 사이트 FD INI ───────────────────────── */

function siteOf(vcenterId, directorId = '', ctx = null) {
  const site = ctx?.site ? (ctx.site.vcenterId === String(vcenterId || '') ? ctx.site : null) : loadSettings().sites.find((s) => s.vcenterId === String(vcenterId || ''));
  if (!site) throw fail('invalid', '이 vCenter 의 사이트 매핑이 없습니다 — 설정 탭에서 매핑(FD·스토리지·풀·INI 경로)을 먼저 저장하세요.');
  // v2.823: 이 Director 편집 화면에서 연 단계는 이 Director 에 묶인 vCenter 만 다룬다(다른 법인 FD 에 쓰지 않게)
  if (directorId && site.directorId !== directorId) throw fail('invalid', '이 vCenter 는 이 Director 에 묶여 있지 않습니다.');
  if (!FD_PATH_RE.test(site.configFile) || /(^|\/)\.\.(\/|$)/.test(site.configFile)) throw fail('invalid', '사이트 매핑의 INI 경로가 올바르지 않습니다.');
  // v2.822.3(S2-2 — 재현): root 로 쓰는 경로는 /etc/bareos/ 아래 .ini 만(예전에는 /etc/cron.d·/etc/sudoers.d 같은 아무 절대 경로나 됐다).
  //   매핑 저장(normalizeSite)은 그대로 둔다 — 넣으면 예전 매핑이 로드 때 조용히 사라진다. 자동 설정만 거부한다.
  if (!/^\/etc\/bareos\/[A-Za-z0-9._/-]+\.ini$/.test(site.configFile)) throw fail('invalid', `자동 설정은 /etc/bareos/ 아래 .ini 경로에만 씁니다(지금 매핑: ${site.configFile}) — 매핑의 INI 경로를 바꾸거나 직접 넣으세요.`);
  if (!HOST_RE.test(site.vcserver)) throw fail('invalid', '사이트 매핑의 vcserver 주소가 올바르지 않습니다.');
  return site;
}

/**
 * 사이트 FD 에 vCenter 자격증명 INI 를 쓴다(bareos 소유 0600). vCenter 비밀번호는 이 요청에서만 쓰고 저장하지 않는다.
 * planFdIni = 입력 판정(원격 접속 없음 — 라우트가 OTP 전에 부른다).
 * @param {{ vcenterId, host, sshPort?, username?, password, vcuser, vcpass, vcthumbprint }} b
 */
export function planFdIni(b = {}, ctx = null) {
  const site = siteOf(b.vcenterId, b.directorId, ctx);
  const { ssh, issue } = normSsh(b);
  if (issue) throw fail('invalid', issue);
  const ui = iniValueIssue(b.vcuser, 'vCenter 계정', 128) || iniValueIssue(b.vcpass, 'vCenter 비밀번호', 256);
  if (ui) throw fail('invalid', ui);
  const vcthumbprint = normThumbprint(b.vcthumbprint);
  if (!vcthumbprint) throw fail('invalid', 'vCenter 인증서 SHA1 지문(16진 40자 — 콜론은 있어도 됩니다)을 넣으세요. ‘FD 에서 지문 읽기’ 로 읽은 값을 vCenter 화면의 값과 대조하세요.');
  return { site, ssh, vcthumbprint };
}

export async function setupFdIni(b = {}, ctx = null) {
  const { site, ssh, vcthumbprint } = planFdIni(b, ctx);
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
  }, ctx?.signal);
  return {
    ok: true, vcenterId: site.vcenterId, path: dest, action: out.action, plugin: out.plugin, pluginText: out.pluginText,
    ...(/%/.test(`${b.vcpass}${b.vcuser}`) ? { note: '값의 ‘%’ 는 플러그인 INI 해석(보간)에 맞춰 ‘%%’ 로 적었습니다.' } : {}),
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
export async function readFdThumbprint(b = {}, ctx = null) {
  const site = siteOf(b.vcenterId, b.directorId, ctx);
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
  }), ctx?.signal);
  const p = parseOpensslFingerprint(r.out?.stdout);
  if (!p.thumbprint) throw fail('remote', `FD 에서 ${target} 의 인증서를 읽지 못했습니다(openssl 없음·443 막힘·이름 해석 실패) — ${tail(r.out?.stdout || r.out?.stderr, 200) || '출력 없음'}`);
  return { ok: true, vcenterId: site.vcenterId, vcserver: v, ...p };
}

/* ───────────────────────── ④ 사전 점검(쓰기 없음 — v2.823) ───────────────────────── */

const PREFLIGHT_PKGS = Object.freeze(['bareos-director', 'bareos-storage', 'bareos-filedaemon', 'bareos-vmware-plugin', 'bareos-filedaemon-python3-plugin']);
/** v2.841 사전 점검 @@own — 종류·상한은 names.js(OWN_TYPES · OWN_PER_TYPE — 엣지 정제와 같이 쓴다). 첫 글자 → 상태. */
export { OWN_TYPES };
const OWN_STATE = Object.freeze({ M: 'managed', F: 'foreign', X: 'notfile' });
/** python3-fd 플러그인(.so)이 있을 수 있는 곳 — RHEL 계열 lib64 · Debian 계열 lib(추정 — 패키지 배치 기준). 고정 목록만 쓴다. */
export const FD_PLUGIN_DIRS = Object.freeze(['/usr/lib64/bareos/plugins', '/usr/lib/bareos/plugins']);
const FD_CLIENT_CONF = '/etc/bareos/bareos-fd.d/client/myself.conf';

/** 점검 스크립트 — 고정 글자만(사용자 값 없음). 구역마다 '@@이름' 줄로 나눈다. */
const PREFLIGHT_SCRIPT = [
  'echo @@id; id -u',
  `echo @@pkg; for p in ${PREFLIGHT_PKGS.join(' ')}; do if command -v rpm >/dev/null 2>&1; then v=$(rpm -q --qf '%{VERSION}' "$p" 2>/dev/null) || v=-; else v=$(dpkg-query -W -f='\${Version}' "$p" 2>/dev/null); [ -n "$v" ] || v=-; fi; echo "$p $v"; done`,
  'echo @@svc; for s in bareos-dir bareos-sd bareos-fd; do echo "$s $(systemctl is-active $s 2>/dev/null || true)"; done',
  'echo @@py; python3 -c \'import sys;print("%d.%d.%d" % sys.version_info[:3])\' 2>/dev/null || echo -',
  // v2.823 검토(C8): importlib.metadata 는 Python 3.8+ — 그 전 판에서는 import 로만 확인하고 버전은 '?'(설치됨 · 버전 모름)
  'echo @@pyvmomi; if python3 -c \'import pyVmomi\' 2>/dev/null; then python3 -c \'import importlib.metadata as m;print(m.version("pyvmomi"))\' 2>/dev/null || echo "?"; else echo -; fi',
  'echo @@vddk; ls -d /usr/lib/vmware-vix-disklib* /usr/lib64/vmware-vix-disklib* /opt/vmware-vix-disklib* 2>/dev/null | head -3',
  `echo @@plugdir; for d in ${FD_PLUGIN_DIRS.join(' ')}; do [ -e "$d/python3-fd.so" ] && echo "$d"; done`,
  `echo @@fdconf; if [ -f ${FD_CLIENT_CONF} ]; then grep -iE '^[[:space:]]*plugin[[:space:]]*(names|directory)[[:space:]]*=' ${FD_CLIENT_CONF} 2>/dev/null; else echo NOFILE; fi`,
  `echo @@layout; test -d ${DIR_CONF_ROOT} && echo D; test -e /etc/bareos/bareos-dir.conf && echo S; command -v bconsole >/dev/null 2>&1 && echo C`,
  `echo @@res; for t in client storage pool schedule; do for f in ${DIR_CONF_ROOT}/$t/*.conf; do [ -f "$f" ] && echo "$t $(basename "$f" .conf)"; done; done`,
  // v2.841(사용자 화면 — 2단계가 사람이 만든 console/admin.conf 에 막힘): 2단계가 쓸 수 있는 종류의 파일마다 '포탈이 만든 파일(M) · 남의 파일(F) ·
  //   일반 파일 아님(X)' 만 낸다(내용은 싣지 않는다 — 첫 줄을 표지와 비교한 결과 한 글자). 화면이 OTP 를 쓰기 **전에** 겹침을 알리고 빈 콘솔 이름을 고른다.
  //   판정은 pathState 와 같다(첫 줄 = MARKER) · 첫 줄이 길어도 200바이트만 읽는다 · 심링크·특수 파일은 읽지 않는다.
  `echo @@own; for t in ${OWN_TYPES.join(' ')}; do n=0; for f in ${DIR_CONF_ROOT}/$t/*.conf; do if [ -L "$f" ]; then k=X; elif [ ! -e "$f" ]; then continue; elif [ ! -f "$f" ]; then k=X; elif [ "$(head -c 200 "$f" | head -n 1)" = "${MARKER}" ]; then k=M; else k=F; fi; echo "$t $(basename "$f" .conf) $k"; n=$((n+1)); [ $n -ge ${OWN_PER_TYPE} ] && break; done; done`,
  'echo @@end',
].join('\n');

/** 점검 출력 → 구역별 줄(순수). */
function sections(text) {
  const out = {};
  let cur = null;
  for (const raw of String(text ?? '').split('\n').slice(0, 700)) {   // v2.841: @@own(종류 6 × 40줄)이 더해져 400 → 700
    const line = raw.slice(0, 400).replace(/\r$/, '');
    const m = /^@@([a-z]+)$/.exec(line.trim());
    if (m) { cur = m[1]; out[cur] = []; continue; }
    if (cur && line.trim()) out[cur].push(line.trim());
  }
  return out;
}

const verOk = (v) => /^\d+(\.\d+){0,3}/.test(v);
const verTuple = (v) => String(v).split('.').map((x) => parseInt(x, 10) || 0);

/**
 * 사전 점검 출력 해석(순수 — 테스트가 고정). 못 읽은 항목은 'unknown'(없음으로 단정하지 않는다).
 * @returns {{ items: {key,label,status:'ok'|'missing'|'warn'|'unknown',detail,hint}[], resources: {client,storage,pool,schedule}, pluginDir: string }}
 */
export function parsePreflight(text) {
  const s = sections(text);
  const items = [];
  const add = (key, label, status, detail, hint = '') => items.push({ key, label, status, detail: String(detail ?? '').slice(0, 200), hint });
  if (!s.end) add('output', '점검 출력', 'unknown', '점검 출력이 끝까지 오지 않았습니다(시한·연결 끊김)', '다시 점검하세요.');
  const id = (s.id || [])[0];
  if (id === undefined) add('root', 'root 권한', 'unknown', '읽지 못함');
  else add('root', 'root 권한', id === '0' ? 'ok' : 'missing', `id -u = ${id}`, id === '0' ? '' : '자동 설정은 root 계정으로 접속해야 합니다(sudo 경로는 쓰지 않습니다).');
  const pk = new Map((s.pkg || []).map((l) => { const [n, v] = l.split(/\s+/); return [n, v || '-']; }));
  for (const p of PREFLIGHT_PKGS) {
    const v = pk.get(p);
    if (v === undefined) add(`pkg:${p}`, p, 'unknown', '읽지 못함(rpm·dpkg 조회 실패)');
    else if (v === '-' || !verOk(v)) add(`pkg:${p}`, p, 'missing', '설치되지 않음', `${p} 패키지를 설치하세요.`);
    else add(`pkg:${p}`, p, 'ok', v);
  }
  const svc = new Map((s.svc || []).map((l) => { const [n, st] = l.split(/\s+/); return [n, st || '']; }));
  for (const n of ['bareos-dir', 'bareos-sd', 'bareos-fd']) {
    const st = svc.get(n);
    if (st === undefined || st === '') add(`svc:${n}`, `${n} 서비스`, 'unknown', '읽지 못함');
    else add(`svc:${n}`, `${n} 서비스`, st === 'active' ? 'ok' : 'missing', st, st === 'active' ? '' : `systemctl enable --now ${n}`);
  }
  const py = (s.py || [])[0];
  const pv = (s.pyvmomi || [])[0];
  if (!py || py === '-') add('python', 'Python 3', py === '-' ? 'missing' : 'unknown', py === '-' ? '없음' : '읽지 못함', 'python3 을 설치하세요(FD 의 VMware 플러그인이 씁니다).');
  else add('python', 'Python 3', 'ok', py);
  if (!pv || pv === '-') add('pyvmomi', 'pyVmomi', pv === '-' ? 'missing' : 'unknown', pv === '-' ? '설치되지 않음' : '읽지 못함', "python3 -m pip install 'pyvmomi>=8,<9' (Python 3.9 FD)");
  else if (pv === '?') add('pyvmomi', 'pyVmomi', 'warn', '설치됨 — 버전을 읽지 못했습니다(Python 3.8 미만은 importlib.metadata 가 없습니다)', 'python3 -m pip show pyvmomi 로 버전을 확인하세요(Python 3.10 미만이면 9.x 는 플러그인이 시작하지 못합니다).');
  else {
    const old = py && verOk(py) && (verTuple(py)[0] < 3 || (verTuple(py)[0] === 3 && verTuple(py)[1] < 10));
    if (verTuple(pv)[0] >= 9 && old) add('pyvmomi', 'pyVmomi', 'warn', `${pv} — Python ${py} 에서는 플러그인이 시작하지 못합니다`, "python3 -m pip install 'pyvmomi>=8,<9'");
    else add('pyvmomi', 'pyVmomi', 'ok', pv);
  }
  const vd = s.vddk || [];
  add('vddk', 'VDDK', vd.length ? 'ok' : 'unknown', vd.length ? vd.join(' · ') : '알려진 경로에서 찾지 못함', vd.length ? '' : '설치 경로가 다를 수 있습니다 — 첫 백업의 작업 로그로 확인하세요.');
  const pluginDir = (s.plugdir || []).find((d) => FD_PLUGIN_DIRS.includes(d)) || '';
  add('plugdir', 'python3-fd 플러그인', pluginDir ? 'ok' : (s.plugdir ? 'missing' : 'unknown'), pluginDir || '찾지 못함', pluginDir ? '' : 'bareos-filedaemon-python3-plugin 패키지를 설치하세요.');
  const fdLines = (s.fdconf || []).map((l) => l.replace(/\s+/g, ' '));
  const namesLine = fdLines.find((l) => /plugin ?names/i.test(l));
  if (!s.fdconf) add('fdplugin', 'FD 플러그인 줄', 'unknown', '읽지 못함');
  else if (fdLines.includes('NOFILE')) add('fdplugin', 'FD 플러그인 줄', 'missing', `${FD_CLIENT_CONF} 없음`, 'FD 설정 구성이 패키지 기본과 다릅니다 — 3단계는 이 파일이 있어야 합니다(직접 확인하세요).');
  else if (!namesLine) add('fdplugin', 'FD 플러그인 줄', 'missing', 'Plugin Names 없음', '3단계 ‘FD 플러그인 켜기’ 가 넣습니다.');
  else add('fdplugin', 'FD 플러그인 줄', /python3/i.test(namesLine) ? 'ok' : 'warn', namesLine, /python3/i.test(namesLine) ? '' : 'python3 이 아닌 값이 있습니다 — 3단계는 사람이 정한 값을 덮지 않습니다.');
  const lay = new Set(s.layout || []);
  if (!s.layout) add('layout', 'Director 설정 구성', 'unknown', '읽지 못함');
  else if (lay.has('S')) add('layout', 'Director 설정 구성', 'warn', '단일 파일(bareos-dir.conf)', '자동 설정은 bareos-dir.d 구성만 다룹니다.');
  else add('layout', 'Director 설정 구성', lay.has('D') ? 'ok' : 'missing', lay.has('D') ? 'bareos-dir.d(디렉터리 구성)' : 'bareos-dir.d 없음', lay.has('D') ? '' : 'bareos-director 패키지를 먼저 설치하세요.');
  if (s.layout) add('bconsole', 'bconsole', lay.has('C') ? 'ok' : 'missing', lay.has('C') ? '있음' : '없음', lay.has('C') ? '' : 'bareos-bconsole 패키지(Director reload 에 필요)');
  const resources = { client: [], storage: [], pool: [], schedule: [] };
  for (const l of s.res || []) {
    const [t, n] = l.split(/\s+/);
    if (resources[t] && isResourceName(n || '') && resources[t].length < 50) resources[t].push(n);
  }
  add('resources', '기본 리소스(파일 이름 기준)', s.res ? 'ok' : 'unknown',
    s.res ? ['client', 'storage', 'pool', 'schedule'].map((t) => `${t} ${resources[t].join(',') || '—'}`).join(' · ') : '읽지 못함',
    '이름은 설정 파일 이름에서 읽었습니다(리소스 Name 과 다를 수 있음 — 추정).');
  // v2.841: 2단계가 쓸 수 있는 종류의 파일과 그 주인(포탈 파일·남의 파일). 구역이 없으면(옛 엣지·출력 잘림) null — 겹침을 '없음' 으로 단정하지 않는다.
  let confFiles = null;
  if (s.own && s.end) {
    confFiles = [];
    for (const l of s.own) {
      const m = /^([a-z]{1,10}) (\S{1,64}) ([MFX])$/.exec(l);
      if (!m || !OWN_TYPES.includes(m[1]) || !isResourceName(m[2])) continue;
      confFiles.push({ type: m[1], name: m[2], state: OWN_STATE[m[3]] });
      if (confFiles.length >= OWN_TYPES.length * OWN_PER_TYPE) break;
    }
    const foreignConsoles = confFiles.filter((f) => f.type === 'console' && f.state !== 'managed').map((f) => f.name);
    add('consoles', '이미 있는 콘솔(사람이 만든 것)', 'ok', foreignConsoles.length ? foreignConsoles.slice(0, 10).join(', ') : '없음',
      foreignConsoles.length ? '2단계는 이 이름들을 덮지 않습니다 — 화면이 겹치지 않는 포탈 전용 콘솔 이름을 골라 둡니다.' : '');
  }
  return { items, resources, pluginDir, confFiles };
}

/**
 * 2단계가 남의 파일에 막혔을 때의 안내(순수 — v2.841 사용자 화면: 'console/admin.conf' 하나로 멈추고 무엇을 바꿔야 하는지 몰랐다).
 * 콘솔은 사람이 쓰는 이름일 수 있다(webui·bconsole) — 덮지 않고 **포탈 전용 이름**을 쓰게 한다(그 콘솔의 비밀번호를 바꾸면 그 연결이 끊긴다).
 * @param {{ type, name, path }[]} foreign @param {string} consoleName 이번에 만들려던 콘솔 이름
 */
export function conflictMessage(foreign = [], consoleName = '') {
  const parts = [];
  const con = foreign.find((f) => f.type === 'console');
  if (con) {
    parts.push(`콘솔 ‘${consoleName}’ 은(는) 이미 있고 포탈이 만든 것이 아닙니다(${con.path}) — 사람이 쓰는 콘솔일 수 있어 덮지 않습니다. `
      // 예시 이름은 싣지 않는다 — 이 세션은 계획한 파일만 봤다(다른 이름이 비었는지 모른다 · 화면은 사전 점검 결과로 빈 이름을 골라 둔다)
      + '‘만들 콘솔 이름’ 을 사람이 쓰지 않는 포탈 전용 이름으로 바꿔 다시 실행하세요(기존 콘솔과 지금 연결은 그대로 둡니다).');
  }
  const prof = foreign.find((f) => f.type === 'profile');
  if (prof) parts.push(`Profile ‘${prof.name}’ 파일(${prof.path})이 포탈이 만든 것이 아닙니다 — 포탈 콘솔이 쓰는 이름이라 바꿀 수 없습니다. 그 파일을 확인하세요(다른 콘솔이 쓰는 Profile 이면 그대로 두고 그 이름을 바꿔야 합니다).`);
  const def = foreign.filter((f) => ['fileset', 'jobdefs', 'job'].includes(f.type));
  if (def.length) parts.push(`${def.map((f) => `${f.type} ‘${f.name}’`).join(' · ')} 파일이 포탈이 만든 것이 아닙니다 — 설정 탭 기본값(FileSet · JobDefs · 복원 잡 이름)을 다른 이름으로 저장한 뒤 다시 실행하세요.`);
  const ext = foreign.filter((f) => f.type === 'pool' || f.type === 'schedule');
  if (ext.length) parts.push(`${ext.map((f) => `${f.type} ‘${f.name}’`).join(' · ')} 파일이 포탈이 만든 것이 아닙니다 — 전용 Pool · Schedule 만들기를 끄고 다시 실행하거나 그 파일을 확인하세요.`);
  const known = new Set([con, prof, ...def, ...ext].filter(Boolean));
  const rest = foreign.filter((f) => !known.has(f));
  if (rest.length) parts.push(`포탈이 만든 것이 아닌 파일: ${rest.map((f) => f.path).join(', ')}`);
  return `이미 있는 설정 파일이 포탈이 만든 것이 아니라 덮어쓰지 않았습니다(아무것도 바꾸지 않았습니다). ${parts.join(' ')}`;
}

/**
 * 사전 점검 — SSH 로 읽기만 한다(쓰기 없음 · OTP 없음). 출력에 SSH 비밀번호와 같은 글자가 있으면 싣지 않는다(S2-5).
 * @param {{ directorId, host, sshPort?, username?, password }} b
 */
export async function preflight(b = {}, ctx = null) {
  const dir = ctx?.dir || directorById(b.directorId);
  if (!dir) throw fail('invalid', '점검할 법인 Director 를 고르세요.');
  const { ssh, issue } = normSsh(b);
  if (issue) throw fail('invalid', issue);
  const ri = await resolvedHostIssue(ssh.host);
  if (ri) throw fail('invalid', ri);
  const r = await runSsh(ssh, (api) => api.exec(PREFLIGHT_SCRIPT, 90_000), ctx?.signal);
  const out = String(r?.stdout || '');
  if (ssh.password.length >= 4 && out.includes(ssh.password)) throw fail('remote', '점검 출력에 SSH 비밀번호와 같은 글자가 들어 있어 결과를 싣지 않습니다.');
  return { ok: true, directorId: dir.id, host: ssh.host, ...parsePreflight(out) };
}

/* ───────────────────────── ⑤ FD 플러그인 켜기(v2.823) ───────────────────────── */

/** 주석·따옴표 밖 부분(순수). 설정 값에 '#' 이 들어간 줄은 다루지 않는다(myself.conf 기본 모양에는 없다 — 추정). */
const codePart = (line) => { let q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"') q = !q; else if (c === '#' && !q) return line.slice(0, i); } return line; };
const unquote = (v) => String(v ?? '').trim().replace(/^"(.*)"$/, '$1').trim();

/**
 * myself.conf 에 Plugin Directory·Plugin Names 를 넣는다(순수 — 테스트가 고정).
 *  · Client 블록이 **정확히 하나**이고 여러 줄일 때만 · 없는 줄만 넣는다(닫는 괄호 앞) · 같은 값이면 그대로 · **다른 값이면 거부**.
 * @returns {{ action: 'unchanged'|'updated', text: string, added: string[] } | { issue: string }}
 */
export function fdPluginEdit(text, pluginDir, pluginNames = 'python3') {
  // v2.823 검토(S7): SSH 출력은 UTF-8 로 읽힌다 — 깨진 글자(U+FFFD)가 있으면 되쓰면 원본이 바뀐다. 고치지 않는다.
  if (String(text ?? '').includes('\uFFFD')) return { issue: 'UTF-8 이 아닌 글자가 있어 그대로 다시 쓸 수 없습니다 — 직접 확인하세요.' };
  const lines = String(text ?? '').split('\n');
  const starts = [];
  lines.forEach((l, i) => { if (/^\s*client\s*\{/i.test(codePart(l))) starts.push(i); });
  if (starts.length !== 1) return { issue: `Client 블록이 ${starts.length}개입니다(하나일 때만 자동으로 고칩니다) — 직접 확인하세요.` };
  const start = starts[0];
  let depth = 0; let end = -1;
  for (let i = start; i < lines.length && end < 0; i++) {
    const c = codePart(lines[i]); let q = false;
    for (const ch of c) {
      if (ch === '"') q = !q;
      else if (!q && ch === '{') depth += 1;
      else if (!q && ch === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
  }
  if (end < 0) return { issue: 'Client 블록의 닫는 괄호를 찾지 못했습니다 — 직접 확인하세요.' };
  if (end === start) return { issue: '한 줄로 된 Client 블록은 자동으로 고치지 않습니다 — 직접 확인하세요.' };
  let names = null; let dirv = null;
  for (let i = start + 1; i < end; i++) {
    const c = codePart(lines[i].slice(0, 4096));   // 장비 출력 — 길이를 먼저 자른다(정규식 규약)
    // v2.823 검토(S8): 포함 파일(@…)의 값은 여기서 볼 수 없다 — 같은 지시어가 거기 있을 수 있어 고치지 않는다
    if (/^\s*@/.test(c)) return { issue: 'Client 블록 안에 포함 지시(@…)가 있습니다 — 포함된 파일의 값을 확인할 수 없어 자동으로 고치지 않습니다(직접 확인하세요).' };
    let m = /^\s*plugin\s*names\s*=\s*(.*?)\s*$/i.exec(c);
    if (m) { if (names !== null) return { issue: 'Plugin Names 줄이 두 번 있습니다 — 직접 확인하세요.' }; names = unquote(m[1]); continue; }
    m = /^\s*plugin\s*directory\s*=\s*(.*?)\s*$/i.exec(c);
    if (m) { if (dirv !== null) return { issue: 'Plugin Directory 줄이 두 번 있습니다 — 직접 확인하세요.' }; dirv = unquote(m[1]).slice(0, 300); while (dirv.endsWith('/')) dirv = dirv.slice(0, -1); }
  }
  if (names !== null && names !== pluginNames) return { issue: `이미 Plugin Names = "${names.slice(0, 80)}" 가 있습니다 — 사람이 정한 값을 덮지 않습니다(${pluginNames} 를 직접 넣으세요).` };
  if (dirv !== null && dirv !== pluginDir) return { issue: `이미 Plugin Directory = "${dirv.slice(0, 120)}" 가 있습니다 — 이 서버의 플러그인은 ${pluginDir} 에 있습니다(직접 확인하세요).` };
  const added = [];
  if (dirv === null) added.push(`  Plugin Directory = "${pluginDir}"`);
  if (names === null) added.push(`  Plugin Names = "${pluginNames}"`);
  if (!added.length) return { action: 'unchanged', text: String(text ?? ''), added };
  return { action: 'updated', text: [...lines.slice(0, end), ...added, ...lines.slice(end)].join('\n'), added: added.map((x) => x.trim()) };
}

const OWNER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
/** 사본으로 되돌리기 — conf 자리가 심링크면 따라 쓰지 않는다(S5 — root 가 링크 너머 파일을 덮지 않게). */
const restoreCmd = (conf, backup) => `${canonDir(conf)} && [ ! -L ${conf} ] && cp -p ${backup} ${conf} && systemctl restart bareos-fd`;

/** FD 플러그인 켜기 입력 판정(원격 접속 없음 — 라우트가 OTP 전에 부른다). */
export function planFdPlugin(b = {}, ctx = null) {
  const dir = ctx?.dir || directorById(b.directorId);
  if (!dir) throw fail('invalid', '법인 Director 를 고르세요.');
  const { ssh, issue } = normSsh(b);
  if (issue) throw fail('invalid', issue);
  return { dir, ssh };
}

/**
 * FD 의 myself.conf 에 python3 플러그인 줄을 넣고 bareos-fd 를 재시작한다. 실패하면 쓰기 전 사본으로 되돌리고 다시 재시작한다.
 * @returns {Promise<{ ok, action, pluginDir, backup?, added }>}
 */
export async function setupFdPlugin(b = {}, ctx = null) {
  const { dir, ssh } = planFdPlugin(b, ctx);
  const ri = await resolvedHostIssue(ssh.host);
  if (ri) throw fail('invalid', ri);
  const conf = FD_CLIENT_CONF;
  const mask = (t) => { const x = String(t ?? ''); return ssh.password.length >= 4 && x.includes(ssh.password) ? '(출력을 싣지 않습니다 — SSH 비밀번호와 같은 글자가 들어 있습니다)' : x; };
  let backup = '';
  let settled = true;
  let ownerMode = null;
  try {
    return await runSsh(ssh, async (api) => {
      await requireRoot(api.exec);
      const env = String((await api.exec(`command -v bareos-fd >/dev/null 2>&1 && echo F; for d in ${FD_PLUGIN_DIRS.join(' ')}; do [ -e "$d/python3-fd.so" ] && echo "P:$d"; done; command -v systemctl >/dev/null 2>&1 && echo Y`))?.stdout || '').split(/\s+/);
      if (!env.includes('F')) throw fail('invalid', '이 서버에 bareos-fd 가 없습니다 — bareos-filedaemon 패키지를 먼저 설치하세요.');
      if (!env.includes('Y')) throw fail('invalid', 'systemctl 이 없습니다 — bareos-fd 를 재시작할 수 없어 바꾸지 않습니다.');
      const pluginDir = (env.find((x) => x.startsWith('P:')) || '').slice(2);
      if (!FD_PLUGIN_DIRS.includes(pluginDir)) throw fail('invalid', 'python3-fd 플러그인(.so)을 찾지 못했습니다 — bareos-filedaemon-python3-plugin 패키지를 먼저 설치하세요.');
      const rd = await api.exec(`if ! ${canonDir(conf)}; then echo LINK; elif [ -L ${conf} ]; then echo LINK; elif [ -f ${conf} ]; then echo FILE; stat -c '%U %G %a' ${conf}; head -c ${READ_MAX + 1} ${conf}; else echo NONE; fi`);
      const out = String(rd?.stdout || '');
      const [kind, st, ...rest] = out.split('\n');
      if (kind?.trim() === 'NONE') throw fail('invalid', `${conf} 가 없습니다 — FD 설정 구성이 패키지 기본과 다릅니다(직접 확인하세요).`);
      if (kind?.trim() !== 'FILE') throw fail('conflict', `${conf} 가 일반 파일이 아닙니다(심링크·디렉터리) — 아무것도 바꾸지 않았습니다.`);
      const [owner, group, mode] = String(st || '').trim().split(/\s+/);
      if (!OWNER_RE.test(owner || '') || !OWNER_RE.test(group || '') || !/^[0-7]{3,4}$/.test(mode || '')) throw fail('remote', `${conf} 의 소유자·권한을 읽지 못했습니다 — 아무것도 바꾸지 않았습니다.`);
      ownerMode = { owner, group, mode };
      const old = rest.join('\n');
      if (old.length > READ_MAX) throw fail('conflict', `${conf} 가 너무 큽니다 — 아무것도 바꾸지 않았습니다.`);
      const ed = fdPluginEdit(old, pluginDir);
      if (ed.issue) throw fail('conflict', `${ed.issue} 아무것도 바꾸지 않았습니다.`);
      if (ed.action === 'unchanged') return { ok: true, directorId: dir.id, action: 'unchanged', pluginDir, added: [] };
      // v2.823 검토(C6): 임시 디렉터리를 사본·변경 **전에** 만든다 — 예전에는 그 실패가 '세션이 끊겨 …' 문구로 바뀐 것 없는 conf 를 덮고 FD 를 재시작했다
      const tmp = await remoteTmpDir(api.exec, TMP_PREFIX);
      try {
      backup = `${conf}.portal-bak.${Date.now()}`;
      // v2.823 검토(S5): cp 는 대상 심링크를 따라 쓴다 — 원본·사본 자리가 심링크가 아닐 때만(같은 명령 안에서 확인)
      const cp = await api.exec(`${canonDir(conf)} && [ ! -L ${conf} ] && [ ! -e ${backup} ] && cp -p ${conf} ${backup}`);
      if (cp?.code !== 0) throw fail('remote', `쓰기 전 사본을 만들지 못했습니다(${tail(mask(cp?.stderr), 200) || '심링크이거나 사본 자리가 이미 있습니다'}) — 아무것도 바꾸지 않았습니다.`);
      settled = false;
      let restored = false;
      const restore = async (why) => {
        restored = true;
        const back = await api.exec(`${restoreCmd(conf, backup)}`, BUDGET.reloadMs).catch(() => null);
        settled = back?.code === 0;
        return `${why} — ${settled ? `사본으로 되돌리고 bareos-fd 를 다시 시작했습니다(사본 ${backup})` : `되돌리지 못했습니다 — ${backup} 를 ${conf} 로 직접 되돌리세요`}.`;
      };
      try {
        await placeFile(api, tmp, 0, ed.text, conf, ownerMode.mode, ownerMode.owner, ownerMode.group);
        const t = await api.exec('bareos-fd -t 2>&1', BUDGET.testMs);
        if (t?.code !== 0) throw fail('config-test', await restore(`FD 설정 검사(bareos-fd -t)가 실패했습니다: ${tail(mask(t?.stdout || t?.stderr), 600)}`));
        const rs = await api.exec('systemctl restart bareos-fd 2>&1; sleep 2; systemctl is-active bareos-fd 2>&1', BUDGET.reloadMs);
        const active = String(rs?.stdout || '').trim().split('\n').pop() === 'active';
        if (!active) throw fail('remote', await restore(`bareos-fd 재시작 뒤 서비스가 돌지 않습니다(${tail(mask(rs?.stdout), 300) || '출력 없음'})`));
        settled = true;
        return { ok: true, directorId: dir.id, action: 'updated', pluginDir, backup, added: ed.added };
      } catch (e) {
        if (!settled && !restored) e.message = await restore(String(e?.message || e));   // 놓기 실패 등 — 반쯤 쓴 파일을 남기지 않는다
        throw e;
      }
      } finally {
        await api.exec(`rm -rf ${tmp}`).catch(() => {});
      }
    }, ctx?.signal);
  } catch (e) {
    // 세션이 끊겨(시한) 세션 안 되돌리기가 돌지 못했다 — 새 세션으로 사본을 되돌리고 다시 시작한다.
    if (!settled && backup) {
      const rb = await runSsh(ssh, (api) => api.exec(restoreCmd(conf, backup), BUDGET.reloadMs)).catch(() => null);
      e.message = `${mask(String(e?.message || e))} — ${rb?.code === 0 ? '세션이 끊겨 새 세션으로 사본을 되돌리고 bareos-fd 를 다시 시작했습니다' : `되돌리지 못했습니다 — ${backup} 를 ${conf} 로 직접 되돌리세요`}.`;
    }
    throw e;
  }
}

/**
 * v2.845 법인별 설정·계정(bareos/manage/apply.js)이 **같은 원격 파일 규칙**(MARKER · 남의 파일 거부 · 부모 심링크 · SFTP 임시 파일 → install · 되돌리기 · 새 세션 되돌리기)을
 * 그대로 쓰도록 내보낸다 — 규칙을 복제하지 않는다(판정 코어 하나).
 */
export const _remote = Object.freeze({ runSsh: (...a) => runSsh(...a), requireRoot, pathState, placeFile, rollback, rollbackInNewSession, canonDir, resolvedHostIssue, RELOAD_CMD, TMP_PREFIX, READ_MAX, FD_PATH_RE, HOST_RE, USER_RE });
