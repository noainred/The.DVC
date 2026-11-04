/**
 * bareos/install/linkTarget.js — 배포 등록부 대상 연결(v2.879).
 *
 * 사용자 요청(2026-11-04): 완전 설치 대상 표의 '배포 등록부에 엣지 ‘agent-WA’ 의 SSH 대상이 없습니다' — 대상은 저장돼 있는데 에이전트 이름이
 *   다르게 들어간 경우 '다르게 들어간 Agent 명을 수정할 수 있는 기능' · '기존 설치된 목록에서 선택하게' · '오타나 다른 오류가 생기는 것 방지'.
 *
 * 그래서 이름을 **입력받지 않는다**:
 *  - 이름 = 그 행의 엣지(인벤토리를 올리는 인증된 엣지 이름) — 서버가 vcenterId 로 다시 구한다(화면이 보낸 이름을 쓰지 않는다).
 *  - 대상 = 이미 저장된 배포 대상 중 하나(목록에서 고른다). 다른 엣지가 쓰는 이름의 대상 · 다른 법인의 완전 설치 작업(전부 되돌림 아님)이 쓰는 대상 ·
 *    SSH 비밀번호 · 키가 없는 대상은 고를 수 없다.
 *  - 바꾸기 **전에** 그 대상에 SSH 로 접속해 그 서버 포탈의 이름(AGENT_NAME → COLLECTOR_DATACENTER → hostname — `agent/deploy.js effectiveAgentName`,
 *    포탈 config.js 와 같은 순서)이 그 엣지인지 확인한다. 다르면 바꾸지 않는다 — 엉뚱한 서버를 연결하면 완전 설치가 그 서버에 Bareos 를 설치하거나
 *    초기화한다(데이터 손실). 확인을 할 수 없으면(설정 파일을 정하지 못함 · 접속 실패) 바꾸지 않는다.
 *  - 바꾸는 것은 agentName 하나(`deployRegistry.setTargetAgentName`) — SSH 주소 · 계정 · 비밀 · 토큰 그대로 · 수집 서버 등록부는 건드리지 않는다.
 *  - 화면이 본 이름(expectName)과 지금 이름이 다르거나, SSH 동안 판정이 바뀌면(다른 연결 · 주소 변경) 바꾸지 않는다.
 */
import { withSsh, isSshAuthError } from '../../proxy/sshExec.js';
import { listInventory } from '../../central/inventory.js';
import { listTargetsRaw, setTargetAgentName } from '../../agent/deployRegistry.js';
import { resolvePortalUnit, effectiveAgentName } from '../../agent/deploy.js';
import { listInstallTargets, sshCredsFor } from './targets.js';
import { listInstallJobs, knownHostAddrs } from './job.js';

/** SSH 확인 시한(접속 + 명령 4개). 시한이면 세션을 실제로 끊는다(withSsh signal). */
export const LINK_SSH_MS = 30_000;
const fail = (code, message) => Object.assign(new Error(message), { code });
const lc = (s) => String(s ?? '').trim().toLowerCase();
const num = (v, d) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; };

/**
 * 고를 수 있는 배포 대상 목록(순수 · 비밀 없음).
 * @param {{ deployTargets?: object[], inventory?: object[], jobs?: object[] }} s
 * @returns {{ id, host, sshPort, username, agentName, hasPassword, hasKey, enabled, blocked, jobVcenterId?, jobVcenterName?, jobId? }[]}
 */
export function linkCandidates({ deployTargets = [], inventory = [], jobs = [] } = {}) {
  const live = new Map();
  for (const i of Array.isArray(inventory) ? inventory : []) { const a = lc(i?.agent); if (a && !live.has(a)) live.set(a, String(i.agent).trim()); }
  return (Array.isArray(deployTargets) ? deployTargets : []).filter((d) => d && d.id && d.host).map((d) => {
    const name = String(d.agentName || '').trim();
    const job = (Array.isArray(jobs) ? jobs : []).find((j) => j && !j.demo && j.targetId === d.id && j.status !== 'rolledback') || null;
    let blocked = '';
    if (name && live.has(lc(name))) blocked = `엣지 ‘${live.get(lc(name))}’ 가 쓰는 대상입니다`;
    else if (!d.password && !d.privateKey) blocked = 'SSH 비밀번호 · 키가 저장돼 있지 않아 그 서버인지 확인할 수 없습니다';
    return {
      id: String(d.id), host: String(d.host), sshPort: num(d.port, 22), username: String(d.username || ''), agentName: name,
      hasPassword: !!d.password, hasKey: !!d.privateKey, enabled: d.enabled !== false, blocked,
      ...(job ? { jobVcenterId: job.vcenterId, jobVcenterName: job.vcenterName || job.vcenterId, jobId: job.id } : {}),
    };
  }).sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }) || a.sshPort - b.sshPort);
}

/**
 * 이 행에 이 대상을 연결해도 되는가(순수 — 던지면 거부). 화면도 같은 규칙으로 고를 수 없는 것을 잠근다(bareosInstallText linkChoices).
 * @param {object|null} row 완전 설치 대상 행(buildTargets)
 * @param {object|null} cand linkCandidates 의 한 항목
 * @param {{ expectName?: string }} [o] 화면이 본 그 대상의 이름
 */
export function linkDecision(row, cand, { expectName } = {}) {
  if (!row) throw fail('not-found', 'vCenter 를 찾을 수 없습니다.');
  if (!row.agent) throw fail('invalid', '이 vCenter 는 인벤토리를 올리는 엣지가 없어 연결할 엣지 이름이 없습니다.');
  if (row.targetId) throw fail('conflict', `엣지 ‘${row.agent}’ 는 이미 배포 등록부 대상(${row.sshHost || row.targetId})과 연결돼 있습니다 — 화면을 다시 읽으세요.`);
  if (!cand) throw fail('not-found', '고른 배포 대상을 찾을 수 없습니다(그사이 지워졌을 수 있습니다) — 화면을 다시 읽으세요.');
  if (cand.blocked) throw fail('conflict', `고를 수 없는 대상입니다 — ${cand.blocked}.`);
  if (cand.jobVcenterId && cand.jobVcenterId !== row.vcenterId) {
    throw fail('conflict', `법인 ‘${cand.jobVcenterName}’ 의 완전 설치 작업(${cand.jobId})이 쓰는 대상입니다 — 그 법인에서 전부 되돌린 뒤에 고르세요.`);
  }
  if (expectName !== undefined && cand.agentName !== String(expectName ?? '').trim()) {
    throw fail('conflict', `이 배포 대상의 에이전트 이름이 그사이 ‘${cand.agentName || '(없음)'}’ 로 바뀌었습니다 — 화면을 다시 읽고 고르세요.`);
  }
  return { row, cand };
}

/**
 * SSH 세션 안 — 그 서버 포탈의 이름을 읽는다(쓰기 없음). 이름 키 두 개(비밀 아님)와 hostname 만 읽는다(값 출력에 토큰이 실리지 않게 grep -E 로 그 두 줄만).
 * @returns {{ ok:true, name:string, hostname:string, fromEnv:boolean, root:boolean } | { ok:false, reason:string }}
 */
export async function readPortalIdentity(exec, portalPort) {
  const root = String((await exec('id -u')).stdout || '').trim() === '0';
  const inst = await resolvePortalUnit(exec, portalPort);
  if (inst.error) {
    return { ok: false, reason: `이 서버에서 포탈(:${portalPort})의 설정 파일을 정하지 못해 그 엣지인지 확인할 수 없습니다(바꾸지 않았습니다). 참고: ${String(inst.error).slice(0, 300)}` };
  }
  const nameLines = String((await exec(`grep -E '^(AGENT_NAME|COLLECTOR_DATACENTER)=' '${inst.envFile}' 2>/dev/null || true`)).stdout || '');
  const hostname = String((await exec('hostname 2>/dev/null || true')).stdout || '').trim().slice(0, 128);
  return { ok: true, name: effectiveAgentName(nameLines, hostname).slice(0, 128), hostname, fromEnv: /^(AGENT_NAME|COLLECTOR_DATACENTER)=/m.test(nameLines), root };
}

/**
 * 읽은 포탈 이름이 그 엣지인가(순수 — 데모도 이 함수로 판정한다). 같으면 null, 아니면 거부 문구.
 * 비교는 대소문자 무시(중앙의 엣지 이름 대조와 같다 — buildTargets 의 등록부 찾기도 대소문자 무시).
 */
export function identityIssue(where, idn, agent) {
  if (!idn?.ok) return `${where} — ${idn?.reason || '포탈 이름을 읽지 못했습니다(바꾸지 않았습니다).'}`;
  if (lc(idn.name) && lc(idn.name) === lc(agent)) return null;
  const hint = !idn.fromEnv && !idn.root ? ' 접속 계정이 root 가 아니라 portal.env 를 읽지 못했을 수 있습니다(호스트 이름으로 비교했습니다).' : '';
  return `${where} 의 포탈 이름은 ‘${idn.name || '모름'}’ 입니다(호스트 이름 ${idn.hostname || '모름'}) — 엣지 ‘${agent}’ 가 아닌 다른 서버입니다. 다른 대상을 고르세요(바꾸지 않았습니다).${hint}`;
}

/* ───────── 실행(주입 가능 — 시험은 가짜 SSH · 가짜 스냅샷) ───────── */
const realSnapshot = () => ({
  rows: listInstallTargets({ knownHostAddrs: knownHostAddrs() }),
  inventory: listInventory(), deployTargets: listTargetsRaw(), jobs: listInstallJobs(),
});
const _busy = new Set();
let _d = { snapshot: realSnapshot, ssh: withSsh, creds: (id) => sshCredsFor(id), setName: setTargetAgentName };
export function _setLinkDepsForTest(d = {}) {
  _d = { snapshot: d.snapshot || realSnapshot, ssh: d.ssh || withSsh, creds: d.creds || ((id) => sshCredsFor(id)), setName: d.setName || setTargetAgentName };
  _busy.clear();
}

/** 개요에 싣는 목록(비밀 없음). */
export function listLinkCandidates() {
  const s = _d.snapshot();
  return linkCandidates(s);
}

/**
 * 연결 — 판정 → SSH 로 그 서버 포탈 이름 확인 → (판정 다시) → agentName 만 바꿈.
 * @param {{ vcenterId:string, targetId:string, expectName:string }} body
 */
export async function linkInstallTarget({ vcenterId, targetId, expectName } = {}) {
  const vc = typeof vcenterId === 'string' ? vcenterId : '';
  const tid = typeof targetId === 'string' ? targetId : '';
  if (!vc || !tid) throw fail('invalid', 'vCenter 와 배포 대상을 고르세요.');
  if (typeof expectName !== 'string') throw fail('invalid', '화면이 본 대상 이름이 없습니다 — 화면을 다시 읽으세요.');
  const keys = [`t:${tid}`, `v:${vc}`];
  if (keys.some((k) => _busy.has(k))) throw fail('conflict', '같은 대상 · 법인의 연결 확인이 진행 중입니다 — 끝난 뒤 다시 하세요.');
  keys.forEach((k) => _busy.add(k));
  try {
    const judge = () => {
      const s = _d.snapshot();
      const row = (s.rows || []).find((r) => r.vcenterId === vc) || null;
      const cand = linkCandidates(s).find((c) => c.id === tid) || null;
      linkDecision(row, cand, { expectName });
      const raw = (s.deployTargets || []).find((d) => d && d.id === tid);
      return { row, cand, raw };
    };
    const a = judge();
    const creds = _d.creds(tid);
    if (!creds) throw fail('not-found', '고른 배포 대상의 SSH 계정을 찾을 수 없습니다.');
    const portalPort = num(a.raw?.portalPort, 4000);
    const where = `${a.cand.host}${a.cand.sshPort !== 22 ? `:${a.cand.sshPort}` : ''}`;
    let idn;
    try {
      idn = await _d.ssh(creds, ({ exec }) => readPortalIdentity(exec, portalPort), { signal: AbortSignal.timeout(LINK_SSH_MS) });
    } catch (e) {
      if (isSshAuthError(e)) throw fail('ssh-auth', '저장된 SSH 계정으로 로그인하지 못했습니다(자동으로 다시 시도하지 않습니다).');
      throw e;   // 호스트 키 · 접속 실패 · 시한 — 라우트 sendErr 가 그대로 밝힌다(바꾸지 않았다)
    }
    const bad = identityIssue(where, idn, a.row.agent);
    if (bad) throw fail('conflict', bad);
    // SSH 동안 바뀌었으면(다른 연결 · 대상 수정) 바꾸지 않는다
    const b = judge();
    if (!b.raw || b.raw.host !== a.raw.host || num(b.raw.port, 22) !== num(a.raw.port, 22) || String(b.raw.username || '') !== String(a.raw.username || '')) {
      throw fail('conflict', '확인하는 동안 이 배포 대상의 SSH 주소 · 계정이 바뀌었습니다 — 화면을 다시 읽고 고르세요(바꾸지 않았습니다).');
    }
    const r = _d.setName(tid, b.row.agent, { expect: String(a.raw.agentName ?? '') });
    if (!r.ok) throw fail(r.code || 'conflict', r.reason);
    return {
      vcenterId: vc, vcenterName: b.row.vcenterName, agent: b.row.agent, targetId: tid, host: b.cand.host, sshPort: b.cand.sshPort,
      before: r.before, portalName: idn.name, hostname: idn.hostname,
    };
  } finally { keys.forEach((k) => _busy.delete(k)); }
}
