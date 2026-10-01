/**
 * 중앙이 각 agent에서 push 받은 'GPU 게스트 수집 진단'을 보관(인메모리).
 * 웹 '수집 진단' 화면이 이 값을 읽어 어느 단계에서 막혔는지 보여준다.
 *
 * ⚠⚠ v2.598(감사 CENTRAL-01·02): 예전에는 본문 `diag` 를 **그대로 펼쳐** 저장했다(`{ ...diag }`).
 *   ① 크기·원소 수 상한이 없어 공유 토큰 하나로 중앙 메모리에 수십 MB 를 상주시킬 수 있었고
 *      (에이전트 이름도 본문 값이라 이름을 바꿔 가며 무한히 쌓였다) ② `vcenters: [null]`·`vcenters: 'x'`
 *   같은 형식 오염이 그대로 저장돼 소비처(3D 그래프·로그 연합 소스·health)가 **전 사용자에게 계속 500**
 *   이었다(저장형 poison). 이제 **아는 필드만** 담는 화이트리스트로 정제하고 에이전트 수에 상한을 둔다.
 *   소비처도 형식 가드를 둔다(방어선 2중 — 소비처 하나만 고치면 형제로 재발한다).
 */
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';

export const MAX_AGENTS = 256;          // 엣지 28곳(30+ 예정)보다 넉넉히 — 넘치면 가장 오래 보고 안 한 것을 뺀다
export const MAX_VCENTERS = 64;         // 엣지 하나가 담당하는 vCenter
export const MAX_RESULTS = 200;         // 폴러가 vCenter 당 200건까지만 싣는다(gpu/poller.js)
const AGENT_MAX_LEN = 64;

let omittedUnverified = 0;
let byAgent = new Map(); // agent명 → { at, receivedAt, mode, vcenters:[...], counts:{hosts,vms}, dropped? }

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
// v2.607(TIM2607-01): capStr — `.slice` 는 원문을 붙잡는다.
const str = (v, n) => (typeof v === 'string' ? capStr(v, n) : (typeof v === 'number' && Number.isFinite(v) ? String(v) : null));

function stopView(s) {
  if (!isObj(s)) return null;
  return { since: numOrNull(s.since), at: numOrNull(s.at), attempts: numOrNull(s.attempts), reason: str(s.reason, 300) };
}

function cleanResult(r) {
  return {
    vm: str(r.vm, 200), host: str(r.host, 200), vcenterId: str(r.vcenterId, 128),
    os: str(r.os, 40), account: str(r.account, 200), ok: r.ok === true,
    error: str(r.error, 500), util: numOrNull(r.util), utilNA: r.utilNA === true,
    mem: numOrNull(r.mem), gpus: numOrNull(r.gpus),
    ...(isObj(r.authStopped) ? { authStopped: stopView(r.authStopped) } : {}),
  };
}

const COUNT_KEYS = ['gpuHosts', 'vmsOnHost', 'gpuVms', 'onTools', 'candidates'];
function cleanVc(v) {
  const counts = {};
  if (isObj(v.counts)) for (const k of COUNT_KEYS) if (v.counts[k] !== undefined) counts[k] = numOrNull(v.counts[k]);
  const raw = Array.isArray(v.results) ? v.results : [];
  const results = raw.slice(0, MAX_RESULTS).filter(isObj).map(cleanResult);
  return {
    vcId: str(v.vcId, 128), at: numOrNull(v.at), stage: str(v.stage, 80), counts, results,
    error: str(v.error, 500),
    ...(isObj(v.authStopped) ? { authStopped: stopView(v.authStopped) } : {}),
    ...(v.authStoppedVms !== undefined ? { authStoppedVms: numOrNull(v.authStoppedVms) } : {}),
    ...(v.collected !== undefined ? { collected: numOrNull(v.collected) } : {}),
    // 조용히 자르지 않는다 — 몇 건을 뺐는지 화면이 말할 수 있게.
    ...(raw.length > results.length ? { resultsOmitted: raw.length - results.length } : {}),
  };
}

/**
 * 엣지가 보낸 진단을 **아는 필드만** 남겨 정제한다(순수). vcenters 는 언제나 배열이고 원소는 객체다.
 * 형식이 틀린 원소·상한 초과분은 버리고 개수를 `dropped` 로 밝힌다.
 */
export function sanitizeGpuGuestDiag(diag) {
  const d = isObj(diag) ? diag : {};
  const rawVcs = Array.isArray(d.vcenters) ? d.vcenters : [];
  const vcenters = rawVcs.slice(0, MAX_VCENTERS).filter(isObj).map(cleanVc);
  const dropped = rawVcs.length - vcenters.length + (d.vcenters !== undefined && !Array.isArray(d.vcenters) ? 1 : 0);
  return {
    at: numOrNull(d.at), mode: str(d.mode, 16), vcenters,
    ...(dropped > 0 ? { dropped } : {}),
  };
}

/**
 * v2.681(감사 R2F-02): 상한 퇴출이 검증 여부를 보지 않아, 공유 토큰으로 본문 이름을 바꿔 가며 256번 보내면 **개별 토큰으로
 *   검증된 엣지의 진단까지** 밀려났다(GPU 화면 guestWhy 가 그 법인을 '엣지 진단 보고 없음' 이라 말한다 — 거짓 원인).
 *   형제 규약(pullStats·ingestStats·bmusage pull)과 같게 — 퇴출은 **미검증부터**, 검증된 것으로 꽉 찼으면 미검증 새 이름은
 *   받지 않고 개수를 센다(`omittedUnverified`). 이미 검증된 기록을 미검증 요청이 덮어쓰지도 않는다.
 *   `opts.verified` 를 주지 않으면 미검증으로 본다(거부 기본값).
 * @returns {{stored:boolean, reason?:string}}
 */
export function setGpuGuestDiag(agent, diag, counts, opts = {}) {
  const key = capStr(agent || '?', AGENT_MAX_LEN) || '?';
  const verified = opts?.verified === true;
  const c = isObj(counts) ? { hosts: numOrNull(counts.hosts), vms: numOrNull(counts.vms) } : {};
  const prev = byAgent.get(key);
  if (prev && prev.verified === true && !verified) { omittedUnverified += 1; return { stored: false, reason: 'verified-entry' }; }
  // 재삽입으로 순서를 최신으로 옮긴다(Map 은 삽입 순서) — 상한 퇴출이 '가장 오래 보고 안 한 것' 이 되게.
  byAgent.delete(key);
  while (byAgent.size >= MAX_AGENTS) {
    let victim = null;
    for (const [k, v] of byAgent) { if (v.verified !== true) { victim = k; break; } }
    if (victim == null) {
      if (!verified) { omittedUnverified += 1; return { stored: false, reason: 'full-of-verified' }; }
      victim = byAgent.keys().next().value; // 전부 검증됨 — 새 검증 기록은 가장 오래된 것을 민다
    }
    byAgent.delete(victim);
  }
  byAgent.set(key, { ...sanitizeGpuGuestDiag(diag), receivedAt: Date.now(), counts: c, verified });
  return { stored: true };
}

/** 미검증 요청이라 받지 않은 진단 수(기동 뒤 누적). */
export function gpuGuestDiagOmitted() { return omittedUnverified; }

export function getAllGpuGuestDiag() {
  return [...byAgent.entries()].map(([agent, d]) => ({ agent, ...d }));
}

/** 테스트 전용 초기화. */
export function _resetGpuGuestDiagForTest() { byAgent = new Map(); omittedUnverified = 0; }
