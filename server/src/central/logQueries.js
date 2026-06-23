/**
 * 엣지 로그 연합 조회 큐(인메모리). 로그 데이터는 각 엣지 포탈에 로컬 보관되므로, 중앙은
 * 데이터를 가지지 않고 '조회 요청'만 해당 엣지로 중계해 결과만 받아 UI에 전달한다.
 *
 *   UI → POST /api/tools/vclogs/federate(vcenterId, filter) → enqueueLogQuery → reqId
 *   Agent ← GET  /api/central/log-queries?vcenters=...        → takeLogQueries
 *   Agent → POST /api/central/log-query-result(reqId, ...)    → setLogQueryResult
 *   UI ← GET  /api/tools/vclogs/federate?reqId=...            → getLogQueryResult
 *
 * vCenterId 기준 키잉(그 vCenter를 수집하는 엣지가 응답).
 */

const pending = new Map(); // vcenterId -> [{ reqId, filter, at }]
const results = new Map();  // reqId -> { at, vcenterId, total, rows, dbKind }
const TTL = 2 * 60_000;
let seq = 0;

function newReqId() { return `lq_${Date.now().toString(36)}_${(seq++).toString(36)}`; }
function pruneResults() { const now = Date.now(); for (const [k, v] of results) if (now - v.at > TTL) results.delete(k); }

export function enqueueLogQuery(vcenterId, filter = {}) {
  const reqId = newReqId();
  const arr = pending.get(vcenterId) || [];
  arr.push({ reqId, filter, at: Date.now() });
  if (arr.length > 50) arr.splice(0, arr.length - 50);
  pending.set(vcenterId, arr);
  return reqId;
}

export function takeLogQueries(vcenterIds = []) {
  const out = [];
  for (const vc of vcenterIds) {
    const arr = pending.get(vc);
    if (arr && arr.length) { for (const q of arr) out.push({ reqId: q.reqId, vcenterId: vc, filter: q.filter }); pending.delete(vc); }
  }
  return out;
}

export function setLogQueryResult(reqId, payload = {}) {
  results.set(reqId, { at: Date.now(), vcenterId: payload.vcenterId || '', total: payload.total || 0, rows: Array.isArray(payload.rows) ? payload.rows.slice(0, 2000) : [], dbKind: payload.dbKind || '' });
  pruneResults();
}

export function getLogQueryResult(reqId) {
  const r = results.get(reqId);
  if (!r) return { state: 'pending' };
  return { state: 'done', total: r.total, rows: r.rows, dbKind: r.dbKind, at: r.at };
}
