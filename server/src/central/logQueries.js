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
// reqId -> { vcenterId, at }. take 로 pending 이 지워진 뒤에도 결과 보고의 **소유권 검증**을 위해
// reqId 가 어느 vCenter 소속인지 유지한다(TTL 로 정리). 이게 없으면 결과 보고에서 reqId 의 진짜
// vCenter 를 알 수 없어 소유권을 검사할 수 없다.
const reqVc = new Map();
const TTL = 2 * 60_000;
// v2.590 P11: 대기·실행 만료 — 엣지가 이 시간 안에 가져가지 않았거나(꺼짐·담당 아님) 가져간 뒤 결과를 보내지 않으면
// '영원히 pending' 이 아니라 **expired + 사유**다. 예전에는 결과가 한 번도 오지 않으면 상태가 끝나지 않았고
// pruneResults 는 결과 도착 때만 돌아 바인딩도 영원히 남았다.
export const QUERY_EXPIRE_MS = 60_000;
let seq = 0;

function newReqId() { return `lq_${Date.now().toString(36)}_${(seq++).toString(36)}`; }
/*
 * ⚠⚠ v2.583 감사 #35(확정 — 모의 시계로 재현): 예전에는 `reqVc`(소유자·vCenter 바인딩)를 **큐잉 시각**부터,
 *   `results` 를 **결과 시각**부터 2분으로 따로 지웠다. 결과는 항상 큐잉보다 늦으므로 바인딩이 **먼저** 사라지고,
 *   그 사이 결과 폴링 라우트의 `if (owner && …)`·`if (vcOf && …)` 가 빈 값으로 **통째로 건너뛰어** 남의(범위 밖)
 *   로그 조회 결과를 돌려줬다(v2.478 S6 IDOR 가드의 우회). 이제 결과가 **바인딩을 함께 들고** 있고, 바인딩은
 *   그 결과가 남아 있는 동안 지우지 않는다. 라우트는 바인딩이 없으면 **거부**한다(fail-closed).
 */
function pruneResults(now = Date.now()) {
  for (const [k, v] of results) if (now - v.at > TTL) results.delete(k);
  for (const [k, v] of reqVc) if (now - v.at > TTL && !results.has(k)) reqVc.delete(k);
  // 대기열의 만료분도 버린다 — 엣지가 한참 뒤에 켜져 아무도 기다리지 않는 조회를 실행하지 않게.
  for (const [vc, arr] of pending) {
    const keep = arr.filter((q) => now - q.at <= QUERY_EXPIRE_MS);
    if (keep.length) pending.set(vc, keep); else pending.delete(vc);
  }
}

/** reqId 의 바인딩(큐잉한 사용자·대상 vCenter). 모르는 reqId 면 null — 라우트는 그때 결과를 주지 않는다. */
export function bindingOfReq(reqId) {
  const id = String(reqId);
  const b = reqVc.get(id);
  if (b) return { owner: b.owner || '', vcenterId: b.vcenterId || '' };
  const r = results.get(id);
  if (r && (r.owner || r.reqVcenterId)) return { owner: r.owner || '', vcenterId: r.reqVcenterId || '' };
  return null;
}
/** reqId 가 발급된(=조회 대상) vCenter id. 소유권 검증용. 모르면 ''. */
export function vcenterOfReq(reqId) { return bindingOfReq(reqId)?.vcenterId || ''; }
/** reqId 를 큐잉한 사용자(v2.478, 감사 S6 IDOR): 결과 폴링은 그 사용자(또는 admin)만. */
export function ownerOfReq(reqId) { return bindingOfReq(reqId)?.owner || ''; }

export function enqueueLogQuery(vcenterId, filter = {}, owner = '') {
  pruneResults();
  const reqId = newReqId();
  const arr = pending.get(vcenterId) || [];
  arr.push({ reqId, filter, at: Date.now() });
  if (arr.length > 50) arr.splice(0, arr.length - 50);
  pending.set(vcenterId, arr);
  reqVc.set(reqId, { vcenterId, at: Date.now(), owner: String(owner || '') });
  return reqId;
}

export function takeLogQueries(vcenterIds = []) {
  const out = [];
  for (const vc of vcenterIds) {
    const arr = pending.get(vc);
    if (arr && arr.length) {
      const now = Date.now();
      for (const q of arr) {
        if (now - q.at > QUERY_EXPIRE_MS) continue; // 이미 만료 — 화면은 expired 를 받았다
        out.push({ reqId: q.reqId, vcenterId: vc, filter: q.filter });
        const b = reqVc.get(q.reqId); if (b) b.takenAt = now;
      }
      pending.delete(vc);
    }
  }
  return out;
}

export function setLogQueryResult(reqId, payload = {}) {
  const b = reqVc.get(String(reqId)) || {};
  results.set(reqId, {
    at: Date.now(), vcenterId: payload.vcenterId || '', total: payload.total || 0,
    rows: Array.isArray(payload.rows) ? payload.rows.slice(0, 2000) : [], dbKind: payload.dbKind || '',
    owner: b.owner || '', reqVcenterId: b.vcenterId || '', // 바인딩을 결과와 함께 든다(#35)
  });
  pruneResults();
}

export function getLogQueryResult(reqId, now = Date.now()) {
  const r = results.get(reqId);
  if (!r) {
    const b = reqVc.get(String(reqId));
    if (b) {
      // 담당 엣지가 가져갔는지로 사유를 나눈다 — 조치가 다르다(엣지가 꺼졌는가 / 엣지가 조회에 실패했는가).
      if (!b.takenAt && now - b.at > QUERY_EXPIRE_MS) return { state: 'expired', why: 'not-taken', waitedMs: now - b.at };
      if (b.takenAt && now - b.takenAt > QUERY_EXPIRE_MS) return { state: 'expired', why: 'no-result', waitedMs: now - b.at };
      return { state: b.takenAt ? 'running' : 'pending', waitedMs: now - b.at };
    }
    return { state: 'pending' };
  }
  return { state: 'done', total: r.total, rows: r.rows, dbKind: r.dbKind, at: r.at };
}
