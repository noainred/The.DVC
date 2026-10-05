// 호스트 구성 캐시(v2.699) — vCenter 별 · 호스트 moref 별. 인메모리(재시작하면 비고 몇 주기에 걸쳐 다시 찬다 —
// 그동안 host.hcfg 가 없으면 화면은 '아직 읽지 않음' 이라 말한다). VM 캐시(vmcfg/cache.js)와 나눈 이유:
// 그 캐시의 prune 은 VM ref 집합 기준이라 같은 저장소에 두면 호스트 항목이 매 주기 지워진다.
const _byVc = new Map();
const _status = new Map();

export function pickDue(vcId, refs, { now = Date.now(), periodMs, max }) {
  const m = _byVc.get(vcId);
  const due = [];
  for (const ref of refs) {
    const at = m?.get(ref)?.at || 0;
    if (!at || now - at >= periodMs) due.push([ref, at]);
  }
  due.sort((a, b) => a[1] - b[1]);
  return due.slice(0, Math.max(0, max)).map((x) => x[0]);
}
export function put(vcId, ref, value) {
  let m = _byVc.get(vcId);
  if (!m) { m = new Map(); _byVc.set(vcId, m); }
  m.set(ref, value);
}
export function get(vcId, ref) { return _byVc.get(vcId)?.get(ref) || null; }
export function prune(vcId, liveRefs) {
  const m = _byVc.get(vcId);
  if (!m) return 0;
  const live = liveRefs instanceof Set ? liveRefs : new Set(liveRefs);
  let n = 0;
  for (const ref of m.keys()) if (!live.has(ref)) { m.delete(ref); n += 1; }
  return n;
}
export function setStatus(vcId, patch) { _status.set(vcId, { ...(_status.get(vcId) || {}), ...patch }); }
export function statusOf(vcId) { return _status.get(vcId) || null; }
export function hostCfgStatus() {
  const vcenters = [];
  for (const [vcId, m] of _byVc) vcenters.push({ vcenterId: vcId, hosts: m.size, ...(_status.get(vcId) || {}) });
  return { vcenters: vcenters.slice(0, 64), omitted: Math.max(0, vcenters.length - 64) };
}
export function _resetHostCfgCache() { _byVc.clear(); _status.clear(); }
