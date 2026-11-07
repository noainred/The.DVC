/**
 * cvp/epRequests.js — EndpointLocation '지금 조회' 요청 큐(v2.934 SAN·CVP 설계 C-③). 엣지 위임 CVP 는 중앙이 직접 닿지 않는 것이 보통이라
 *   요청을 큐에 두고 엣지가 `/api/central/cvp-config` pull 때 `epNow` 로 가져가 현지에서 묻고 결과를 cvp-data push(ep)로 올린다.
 *   CVP 마다 한 건으로 모은다(같은 CVP 에 겹친 요청은 MAC 을 합친다 · 64개 상한). TTL 15분 — 가져가지 않으면 버리고 그 사실을 센다.
 *   비밀은 없다(MAC 목록뿐 — 엣지는 자기 등록부의 자격증명을 쓴다).
 */
export const EP_REQ_MACS_MAX = 64;
export const EP_REQ_TTL_MS = 15 * 60_000;
export const EP_TAKE_MAX = 10;
const _q = new Map();   // cvpId → { agent, macs:Set, at, takenAt }
let _expired = 0;

function sweep(now) {
  for (const [id, r] of _q) if (now - r.at > EP_REQ_TTL_MS) { _q.delete(id); _expired += 1; }
}
/** 요청을 둔다 — 같은 CVP 에 이미 있으면 MAC 을 합친다(상한). 반환: 큐에 남은 MAC 수. */
export function requestEndpointLookup(agent, cvpId, macs = [], now = Date.now()) {
  sweep(now);
  const id = String(cvpId);
  let r = _q.get(id);
  // 반증 M-5: 엣지 이름은 대소문자를 가리지 않는다(형제 큐 util/collectRequestQueue 의 lower=true 와 같다 — v2.611 CEN2611-02 의 같은 함정).
  if (!r || r.agent.toLowerCase() !== String(agent).toLowerCase()) { r = { agent: String(agent), macs: new Set(), at: now, takenAt: null }; _q.set(id, r); }
  for (const m of Array.isArray(macs) ? macs : []) { if (r.macs.size >= EP_REQ_MACS_MAX) break; if (/^[0-9a-f]{12}$/.test(m)) r.macs.add(m); }
  r.at = now; r.takenAt = null;
  return { queued: r.macs.size };
}
/** 엣지가 가져간다(그 agent 몫 · 한 번에 10건). 가져간 요청은 큐에서 지운다(결과는 push 로 온다 — 중앙이 기다리지 않는다). */
export function takeEndpointRequests(agent, now = Date.now()) {
  sweep(now);
  const out = [];
  for (const [id, r] of _q) {
    if (out.length >= EP_TAKE_MAX) break;
    if (r.agent.toLowerCase() !== String(agent).toLowerCase() || !r.macs.size) continue;
    out.push({ cvpId: id, macs: [...r.macs] });
    _q.delete(id);
  }
  return out;
}
export function pendingEndpointRequest(cvpId) { return _q.has(String(cvpId)); }
export function epRequestStats() { return { pending: _q.size, expired: _expired }; }
export function _resetEpRequests() { _q.clear(); _expired = 0; }
