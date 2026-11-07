// ESXi 경로 카운터 캐시(v2.934 C-①) — vCenter 별 · 호스트 moref 별 최근 표본 요약(storpath/parse.js summarizeHostPaths). 인메모리다.
// 재시작하면 비고 다음 주기(기본 1시간)에 다시 찬다 — 그동안 host.spath 가 없으면 귀속 엔진은 IPF · 타깃 포트 비율로 간다(0 으로 채우지 않는다).
// 모양은 contention/cache.js 와 같다(호스트 한 종류만).

const _byVc = new Map();   // vcId -> Map(ref -> spath)
const _status = new Map(); // vcId -> { at, error, fetched, cut, missingCounters, backoffUntil, ... }

function vcMap(vcId) {
  let m = _byVc.get(vcId);
  if (!m) { m = new Map(); _byVc.set(vcId, m); }
  return m;
}

/** 이번 주기에 다시 읽을 ref — 한 번도 안 읽은 것 먼저, 그다음 오래된 순. */
export function pickDue(vcId, refs, { now = Date.now(), periodMs, max }) {
  const m = vcMap(vcId);
  const due = [];
  for (const ref of refs) {
    const at = m.get(ref)?.at || 0;
    if (!at || now - at >= periodMs) due.push([ref, at]);
  }
  due.sort((a, b) => a[1] - b[1]);
  return due.slice(0, Math.max(0, max)).map((x) => x[0]);
}
export function put(vcId, ref, value) { vcMap(vcId).set(ref, value); }
export function get(vcId, ref) { return _byVc.get(vcId)?.get(ref) || null; }
/** 인벤토리에서 사라진(끊긴) 호스트의 항목을 버린다. */
export function prune(vcId, liveRefs) {
  const m = _byVc.get(vcId);
  if (!m) return 0;
  const live = liveRefs instanceof Set ? liveRefs : new Set(liveRefs);
  let n = 0;
  for (const k of [...m.keys()]) if (!live.has(k)) { m.delete(k); n += 1; }
  return n;
}
export function setStatus(vcId, patch) { _status.set(vcId, { ...(_status.get(vcId) || {}), ...patch }); }
export function statusOf(vcId) { return _status.get(vcId) || null; }
/** 상태 요약(서비스 점검 · 화면 머리말) — vCenter 별 캐시 크기 · 마지막 갱신 · 오류. 자격증명 없음. */
export function storPathStatus() {
  const vcenters = [];
  for (const [vcId, m] of _byVc) vcenters.push({ vcenterId: vcId, hosts: m.size, ...(_status.get(vcId) || {}) });
  for (const [vcId, st] of _status) if (!_byVc.has(vcId)) vcenters.push({ vcenterId: vcId, hosts: 0, ...st });
  return { vcenters: vcenters.slice(0, 64), omitted: Math.max(0, vcenters.length - 64) };
}
/** 그 vCenter 의 캐시를 통째로 버린다 — 삭제됐거나 접속처가 바뀌었다(hostcfg/cache.js CACHE_DROPPERS). */
export function dropVcCache(vcId) { _byVc.delete(vcId); _status.delete(vcId); }
export function _resetStorPathCache() { _byVc.clear(); _status.clear(); }
