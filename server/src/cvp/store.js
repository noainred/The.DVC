/**
 * cvp/store.js — 이 노드가 수집한 CVP 별 **상태**(인메모리, v2.608).
 *
 * 장비·포트·부품 값의 진실의 원천은 DB(`cvp/db.js` device_latest·port_latest)다 — 여기는 'CVP 한 대를 마지막으로
 * 읽은 결과' 만 둔다: { ok, collectedAt(서버가 실제로 읽은 시각), deviceCount, usedPaths, missing, seenFields, error,
 * authStopped, truncated, cvpVersion, durationMs }. 재시작하면 비고, 화면은 '이번 기동 뒤 아직 수집 전' 으로 말한다
 * (DB 의 장비 값은 그대로 보인다 — 수집 시각이 그 나이를 말한다).
 */
const _map = new Map();

export function putStatus(cvpId, st) { _map.set(String(cvpId), { ...st, cvpId: String(cvpId) }); }
export function getStatus(cvpId) { return _map.get(String(cvpId)) || null; }
export function allStatuses() { return [..._map.values()]; }
export function dropStatus(cvpId) { return _map.delete(String(cvpId)); }
/** 대상 목록 밖의 상태를 버린다(등록부에서 빠진 CVP 가 프로세스 수명 내내 남지 않게). */
export function keepOnly(ids) {
  const live = new Set([...ids].map(String));
  for (const k of [..._map.keys()]) if (!live.has(k)) _map.delete(k);
}
export function _resetForTest() { _map.clear(); }
