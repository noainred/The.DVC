/**
 * 에이전트 위임 tcpdump 캡처 작업큐(인메모리). 중앙이 직접 못 가는 사설망 서버는 그 망의
 * 엣지 에이전트가 캡처를 대행한다. 큐잉(UI) → 인출(에이전트) → 캡처 → 결과 보고 → UI 폴링.
 * 캡처는 최대 120초 소요될 수 있어 결과 TTL을 넉넉히 둔다. 에이전트 이름 기준 키잉.
 */

const pending = new Map(); // agent -> [{ reqId, spec, at }]
const results = new Map();  // reqId -> { at, result }
const TTL = 5 * 60_000;
let seq = 0;

function newReqId() { return `cap_${Date.now().toString(36)}_${(seq++).toString(36)}`; }
function prune() { const now = Date.now(); for (const [k, v] of results) if (now - v.at > TTL) results.delete(k); }

export function enqueueCapture(agent, spec = {}) {
  const reqId = newReqId();
  const arr = pending.get(agent) || [];
  arr.push({ reqId, spec, at: Date.now() });
  if (arr.length > 20) arr.splice(0, arr.length - 20);
  pending.set(agent, arr);
  results.set(reqId, { at: Date.now(), result: null }); // pending 표식
  return reqId;
}

export function takeCaptureJobs(agent) {
  const arr = pending.get(agent);
  if (!arr || !arr.length) return [];
  pending.delete(agent);
  return arr.map((q) => ({ reqId: q.reqId, spec: q.spec }));
}

export function setCaptureResult(reqId, result) { results.set(reqId, { at: Date.now(), result }); prune(); }

export function getCaptureResult(reqId) {
  const r = results.get(reqId);
  if (!r) return { state: 'unknown' };
  return r.result ? { state: 'done', result: r.result } : { state: 'pending' };
}
