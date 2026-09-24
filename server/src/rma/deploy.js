/**
 * RMA 원격 배포(중앙 → 엣지 서버, SSH) — 포탈이 이미 설치된 서버에 RMA 인스턴스를 1개 이상
 * 띄운다(agent/deploy.js 의 SSH 배포 패턴). 한 서버에 여러 인스턴스(템플릿 유닛 %i) 또는 여러
 * 서버에 하나씩 — 어느 쪽이든 같은 법인(agent 토큰)으로 중앙에 붙고, 분배는 중앙 설정이 정한다.
 *
 * 절차(root SSH):
 *  1. `systemctl show vmware-portal` 로 설치 경로(PREFIX)·서비스 계정·portal.env 위치를 역추적
 *     (추측하지 않는다 — 다른 경로에 설치된 포탈에 엉뚱한 유닛을 쓰지 않게).
 *  2. 템플릿 유닛 `vmware-portal-rma@.service` 작성(unitTemplate.js — 패키지의 파일과 동일 본문).
 *  3. portal.env 에 RMA_* 키 upsert(RMA_PASSWORD·RMA_ALLOW_CUSTOM, 선택적으로 AGENT_NAME/CENTRAL_*).
 *  4. 인스턴스별 `rma-<name>.env`(RMA_PRIORITY) 작성 → `systemctl enable --now vmware-portal-rma@<name>`.
 *  5. sudoers 한 줄(포탈 재시작 프리셋) — visudo -cf 검증 후 설치.
 *
 * 셸 조립 규약: 값은 전부 화이트리스트 정규식 통과 후에만 삽입(선행 - 불가). 비밀번호는 셸에
 * 싣지 않고 SFTP 로 파일에 쓴다(env 파일은 KEY=VALUE 라 `'`·공백·`$` 등은 값에서 배제).
 */
import { withSsh } from '../proxy/sshExec.js';
import { appendSecretText, remoteTmpDir } from '../agent/deploy.js';   // v2.599(SEC2599-05): 토큰 블록을 SFTP 임시 파일로 붙인다(코어 하나)
import { renderUnit, RMA_SUDOERS } from './unitTemplate.js';

export const RE_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RE_PATH = /^\/[A-Za-z0-9._/-]{1,200}$/;
const RE_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const RE_ENV_VALUE = /^[A-Za-z0-9!@#%^&*()_+=.,:;~/?-]{0,256}$/; // KEY=VALUE 안전 집합(공백·따옴표·$·백틱·\ 배제)
const RE_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

const creds = (t) => ({ host: t.host, port: t.port || 22, username: t.username, password: t.password, privateKey: t.privateKey || undefined });

/** 입력 검증(순수). 오류면 사유, 정상이면 null. */
export function deployInputIssue(opts = {}) {
  const inst = Array.isArray(opts.instances) ? opts.instances : [];
  if (!inst.length) return '인스턴스를 1개 이상 지정하세요.';
  if (inst.length > 8) return '한 번에 최대 8개 인스턴스까지 배포할 수 있습니다.';
  const seen = new Set();
  for (const i of inst) {
    const name = String(i?.name || '').trim();
    if (!RE_INSTANCE.test(name)) return `인스턴스 이름 형식 오류: '${name.slice(0, 30)}' (영숫자·._-, 64자 이내, 선행 - 불가)`;
    if (seen.has(name.toLowerCase())) return `인스턴스 이름 중복: ${name}`;
    seen.add(name.toLowerCase());
    const pr = i?.priority;
    if (pr != null && pr !== '' && !(Number.isInteger(Number(pr)) && Number(pr) >= 0 && Number(pr) <= 1000)) return `'${name}' 우선순위는 0~1000 정수여야 합니다.`;
  }
  if (opts.password != null && opts.password !== '' && !RE_ENV_VALUE.test(String(opts.password))) return 'RMA 비밀번호에 허용되지 않는 문자가 있습니다(공백·따옴표·$·백틱·\\ 불가, 256자 이내).';
  if (opts.agentName && !RE_ENV_VALUE.test(String(opts.agentName))) return 'AGENT_NAME 형식 오류';
  if (opts.centralUrl && !RE_URL.test(String(opts.centralUrl).replace(/\/+$/, ''))) return 'CENTRAL_URL 형식 오류(http(s)://host[:port])';
  if (opts.centralToken && !RE_ENV_VALUE.test(String(opts.centralToken))) return '토큰 형식 오류';
  for (const u of listOf(opts.serviceUnits)) if (!/^[A-Za-z0-9][A-Za-z0-9@._-]{0,79}$/.test(u)) return `서비스 유닛 이름 형식 오류: ${u.slice(0, 30)}`;
  for (const r of listOf(opts.fileRoots)) if (!/^\/[A-Za-z0-9._/-]{0,200}$/.test(r)) return `파일 허용 루트 형식 오류: ${r.slice(0, 30)}`;
  for (const k of ['enabledCommands', 'enabledTests']) for (const id of listOf(opts[k])) if (!/^[A-Za-z0-9*._-]{1,40}$/.test(id)) return `${k} 항목 형식 오류: ${id.slice(0, 30)}`;
  if (opts.comment && !RE_ENV_VALUE.test(String(opts.comment))) return '코멘트에 허용되지 않는 문자가 있습니다(공백·따옴표 불가).';
  return null;
}
const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\s]+/)).map((x) => String(x).trim()).filter(Boolean);

/** 설치 경로 역추적 — { prefix, user, configDir, envFile } 또는 { error }. 원격 출력은 재검증한다. */
export async function resolveInstall(exec) {
  const show = (await exec('systemctl show vmware-portal -p ExecStart,User,EnvironmentFiles 2>/dev/null || true').catch(() => ({ stdout: '' }))).stdout;
  const user = /\nUser=([^\n]+)/.exec('\n' + show)?.[1]?.trim() || '';
  const exe = /path=(\S+\/runtime\/node\/bin\/node)/.exec(show)?.[1] || '';
  const prefix = exe.replace(/\/runtime\/node\/bin\/node$/, '');
  const envFile = /EnvironmentFiles=(\S+)/.exec(show)?.[1] || '';
  const configDir = envFile.replace(/\/[^/]+$/, '');
  if (!prefix || !RE_PATH.test(prefix)) return { error: 'vmware-portal 서비스의 설치 경로를 확인할 수 없습니다 — 이 서버에 포탈(엣지)이 systemd 로 설치되어 있어야 합니다.' };
  if (!RE_USER.test(user)) return { error: `서비스 계정을 확인할 수 없습니다(User=${user.slice(0, 20)}).` };
  if (!RE_PATH.test(envFile) || !RE_PATH.test(configDir)) return { error: 'portal.env 위치(EnvironmentFile)를 확인할 수 없습니다.' };
  const agentJs = (await exec(`test -f ${prefix}/app/server/src/rma/agent.js && echo yes || echo no`).catch(() => ({ stdout: '' }))).stdout.trim();
  if (agentJs !== 'yes') return { error: `이 서버의 포탈에 RMA 코드(${prefix}/app/server/src/rma/agent.js)가 없습니다 — 엣지를 v2.416 이상으로 먼저 업그레이드하세요.` };
  return { prefix, user, configDir, envFile };
}

/**
 * `portal.env` 에 KEY=VALUE 를 upsert.
 *
 * ⚠⚠ **값에 개행이 있으면 그 줄 하나가 여러 줄이 되어 임의 키가 주입된다.**
 * 2026-09-21 감사가 이 경로를 지적했는데, **실제로는 주입되지 않았다** —
 * `deployInputIssue` 가 password·agentName·centralToken·comment·centralUrl·serviceUnits·
 * fileRoots·instance 이름 **8개 전부**에서 개행을 거부하는 것을 실행으로 확인했다
 * (JS 의 `$` 는 `m` 플래그 없이 **후행 개행 앞에서 매치하지 않는다** — Perl/Python 과 다르다).
 * 그러니 이것은 **결함 수정이 아니라 sink 방어**다(v2.574).
 *
 * 그럼에도 여기서 한 번 더 막는 이유: 지금 안전한 것은 **호출부 8곳이 각자 검사하기 때문**이고,
 * 새 키를 추가하는 사람이 그 검사를 빠뜨리면 그 순간 뚫린다. 불변조건은 **값이 파일에 닿는
 * 지점**이 갖는 것이 맞다(v2.561 '정직 장치를 무력화하는 강제변환이 가장 위험하다' 와 같은 판단).
 */
const ENV_INJECT_RE = /[\r\n\0]/;
async function upsertEnv({ exec, writeFile }, envFile, pairs) {
  if (!pairs.length) return;
  for (const [k, v] of pairs) {
    if (ENV_INJECT_RE.test(String(k)) || ENV_INJECT_RE.test(String(v))) {
      throw new Error(`env 값에 개행·NUL 이 있어 중단했습니다(키 주입 방지): ${String(k).slice(0, 40)}`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(k))) throw new Error(`env 키 형식 오류: ${String(k).slice(0, 40)}`);
  }
  const delScript = pairs.map(([k]) => `/^${k}=/d`).join(';');
  await exec(`sed -i '${delScript}' ${envFile} 2>/dev/null || true`);
  const block = '\n# --- RMA (auto-deployed) ---\n' + pairs.map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  // v2.599(SEC2599-05): 블록(CENTRAL_TOKEN 포함)을 printf 인자로 보내면 대상 호스트 ps·/proc/<pid>/cmdline 에 보인다.
  await appendSecretText({ exec, writeFile }, envFile, block);
}

/**
 * 배포 실행. target = SSH 접속 정보(root), opts = { instances:[{name,priority}], password, allowCustom, agentName, centralUrl, centralToken }
 * 반환 { ok, install, instances:[{name, active, log?}], sudoers, reason? }
 */
export async function deployRma(target, opts = {}) {
  if (!target?.host || !target?.username) return { ok: false, reason: 'host/username 을 입력하세요.' };
  const issue = deployInputIssue(opts);
  if (issue) return { ok: false, reason: issue };
  try {
    const r = await withSsh(creds(target), async ({ exec, writeFile }) => {
      const idu = await exec('id -u');
      if (idu.stdout.trim() !== '0') return { ok: false, reason: 'RMA 배포는 root 권한이 필요합니다(systemd 유닛·sudoers 작성). root 로 접속하세요.' };
      const inst = await resolveInstall(exec);
      if (inst.error) return { ok: false, reason: inst.error };

      // 1) 템플릿 유닛
      await writeFile('/etc/systemd/system/vmware-portal-rma@.service', renderUnit(inst), 0o644);
      // 2) portal.env upsert — 비밀번호는 값 집합이 검증돼 있어 KEY=VALUE 로 안전.
      const pairs = [['RMA_ENABLED', 'true']];
      if (opts.password != null && opts.password !== '') pairs.push(['RMA_PASSWORD', String(opts.password)]);
      if (opts.clearPassword) pairs.push(['RMA_PASSWORD', '']);
      pairs.push(['RMA_ALLOW_CUSTOM', opts.allowCustom ? 'true' : 'false']);
      // v2.418 정책 키 — 지정된 것만 기록(비우면 기존 값 유지). 목록은 쉼표 구분.
      const units = listOf(opts.serviceUnits), roots = listOf(opts.fileRoots), ec = listOf(opts.enabledCommands), et = listOf(opts.enabledTests);
      if (opts.serviceUnits != null) pairs.push(['RMA_SERVICE_UNITS', units.join(',')]);
      if (opts.allowReboot != null) pairs.push(['RMA_ALLOW_REBOOT', opts.allowReboot ? 'true' : 'false']);
      if (roots.length) pairs.push(['RMA_FILE_ROOTS', roots.join(',')]);
      if (opts.enabledCommands != null) pairs.push(['RMA_ENABLED_COMMANDS', ec.join(',')]);
      if (opts.enabledTests != null) pairs.push(['RMA_ENABLED_TESTS', et.join(',')]);
      if (opts.remoteManage != null) pairs.push(['RMA_REMOTE_MANAGE', opts.remoteManage ? 'true' : 'false']);
      if (opts.comment) pairs.push(['RMA_COMMENT', String(opts.comment)]);
      if (opts.agentName) pairs.push(['AGENT_NAME', String(opts.agentName)]);
      if (opts.centralUrl) pairs.push(['CENTRAL_URL', String(opts.centralUrl).replace(/\/+$/, '')]);
      if (opts.centralToken) pairs.push(['CENTRAL_TOKEN', String(opts.centralToken)]);
      await upsertEnv({ exec, writeFile }, inst.envFile, pairs);
      // 3) sudoers(포탈 재시작 프리셋) — 문법 검증 실패 시 설치하지 않는다(sudo 전체가 깨지는 사고 방지).
      // v2.600 SEC2600-01: 고정 경로(/tmp/vmware-portal-rma.sudoers)는 대상 호스트의 로컬 사용자가 미리 만들어 두고
      // visudo 검사와 install 사이에 내용을 바꿔 **자기 sudoers 를 root 로 설치**시킬 수 있었다. root 소유 0700
      // mktemp 디렉터리 안에서 검증·설치하고 끝나면 지운다.
      const sudoDir = await remoteTmpDir(exec, 'vmware-portal-rma');
      const sudoTmp = `${sudoDir}/sudoers`;
      let vis;
      try {
        await writeFile(sudoTmp, RMA_SUDOERS(inst.user, { units: listOf(opts.serviceUnits), reboot: !!opts.allowReboot }), 0o440);
        vis = await exec(`visudo -cf ${sudoTmp} >/dev/null 2>&1 && install -m 0440 ${sudoTmp} /etc/sudoers.d/vmware-portal-rma && echo ok || echo fail`);
      } finally { await exec(`rm -rf ${sudoDir}`).catch(() => {}); }
      const sudoers = vis.stdout.trim() === 'ok';
      // 4) 인스턴스별 env + 기동
      await exec('systemctl daemon-reload');
      const results = [];
      for (const i of opts.instances) {
        const name = String(i.name).trim();
        const pr = i.priority != null && i.priority !== '' ? Number(i.priority) : 100;
        await writeFile(`${inst.configDir}/rma-${name}.env`, `RMA_INSTANCE=${name}\nRMA_PRIORITY=${pr}\n`, 0o640);
        await exec(`chown ${inst.user}:${inst.user} ${inst.configDir}/rma-${name}.env 2>/dev/null || true`);
        await exec(`systemctl enable vmware-portal-rma@${name} >/dev/null 2>&1; systemctl restart vmware-portal-rma@${name} 2>&1 || true`);
        let active = '';
        for (let k = 0; k < 6; k++) {
          active = (await exec(`systemctl is-active vmware-portal-rma@${name}`).catch(() => ({ stdout: '' }))).stdout.trim();
          if (active === 'active' || active === 'failed') break;
          await exec('sleep 1');
        }
        let log = '';
        if (active !== 'active') log = (await exec(`journalctl -u vmware-portal-rma@${name} --no-pager -n 30 2>&1`).catch(() => ({ stdout: '' }))).stdout.slice(-3000);
        results.push({ name, priority: pr, active, log });
      }
      const ok = results.every((r) => r.active === 'active');
      return { ok, install: inst, instances: results, sudoers, reason: ok ? undefined : '일부 인스턴스가 active 가 아닙니다 — 로그를 확인하세요(토큰/CENTRAL_URL 오류가 흔한 원인).' };
    });
    // v2.447(감사 S10): withSsh 는 { ok, log, ... } 를 돌려주는데 그 log 에는
    // `printf '…RMA_PASSWORD=<평문>…CENTRAL_TOKEN=<평문>' >> portal.env` 명령이 그대로 들어 있다.
    // 응답 본문은 브라우저 캐시·HAR·중계 프록시 로그에 남으므로 비밀은 싣지 않는다
    // (relaytopo/ops.js 가 같은 이유로 delete r.log 를 한다). 인스턴스별 journalctl 로그는 유지.
    if (r && typeof r === 'object') delete r.log;
    return r;
  } catch (err) { return { ok: false, reason: err.message }; }
}

/** 서버의 RMA 인스턴스 목록 — [{ name, active, enabled }]. */
export async function listRmaInstances(target) {
  if (!target?.host || !target?.username) return { ok: false, reason: 'host/username 을 입력하세요.' };
  try {
    const r = await withSsh(creds(target), async ({ exec }) => {
      const out = (await exec("systemctl list-units --all --plain --no-legend 'vmware-portal-rma@*' 2>/dev/null || true")).stdout;
      const rows = [];
      for (const line of out.split('\n')) {
        const m = /^vmware-portal-rma@([A-Za-z0-9._-]+)\.service\s+\S+\s+(\S+)\s+(\S+)/.exec(line.trim());
        if (m) rows.push({ name: m[1], active: m[2], sub: m[3] });
      }
      const unit = (await exec('test -f /etc/systemd/system/vmware-portal-rma@.service && echo yes || echo no')).stdout.trim() === 'yes';
      const inst = await resolveInstall(exec);
      return { ok: true, unitInstalled: unit, install: inst.error ? null : inst, instances: rows };
    });
    // v2.447(감사 S10): withSsh 는 { ok, log, ... } 를 돌려주는데 그 log 에는
    // `printf '…RMA_PASSWORD=<평문>…CENTRAL_TOKEN=<평문>' >> portal.env` 명령이 그대로 들어 있다.
    // 응답 본문은 브라우저 캐시·HAR·중계 프록시 로그에 남으므로 비밀은 싣지 않는다
    // (relaytopo/ops.js 가 같은 이유로 delete r.log 를 한다). 인스턴스별 journalctl 로그는 유지.
    if (r && typeof r === 'object') delete r.log;
    return r;
  } catch (err) { return { ok: false, reason: err.message }; }
}

/** 인스턴스 제거(정지·비활성·env 삭제). 유닛 템플릿과 portal.env 의 RMA 키는 남긴다. */
export async function removeRmaInstance(target, name) {
  if (!target?.host || !target?.username) return { ok: false, reason: 'host/username 을 입력하세요.' };
  const n = String(name || '').trim();
  if (!RE_INSTANCE.test(n)) return { ok: false, reason: '인스턴스 이름 형식 오류' };
  try {
    const r = await withSsh(creds(target), async ({ exec }) => {
      const inst = await resolveInstall(exec);
      await exec(`systemctl disable --now vmware-portal-rma@${n} 2>&1 || true`);
      if (!inst.error) await exec(`rm -f ${inst.configDir}/rma-${n}.env`);
      return { ok: true, name: n };
    });
    // v2.447(감사 S10): withSsh 는 { ok, log, ... } 를 돌려주는데 그 log 에는
    // `printf '…RMA_PASSWORD=<평문>…CENTRAL_TOKEN=<평문>' >> portal.env` 명령이 그대로 들어 있다.
    // 응답 본문은 브라우저 캐시·HAR·중계 프록시 로그에 남으므로 비밀은 싣지 않는다
    // (relaytopo/ops.js 가 같은 이유로 delete r.log 를 한다). 인스턴스별 journalctl 로그는 유지.
    if (r && typeof r === 'object') delete r.log;
    return r;
  } catch (err) { return { ok: false, reason: err.message }; }
}
