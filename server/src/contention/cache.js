// CPU 경합·디스크 지연 캐시(v2.706 C2·C3) — vCenter 별 · moref 별 최근 5분 창 요약. 인메모리다.
// 재시작하면 비고 몇 주기에 걸쳐 다시 찬다 — 그동안 vm.perfc 가 없으면 화면은 '아직 측정하지 않았습니다' 라고 말한다(0 으로 채우지 않는다).

const _byVc = new Map();   // vcId -> Map(`${kind}:${ref}` -> perfc)
const _status = new Map(); // vcId -> { at, error, vmFetched, hostFetched, cut, missingCounters, backoffUntil }

function vcMap(vcId) {
  let m = _byVc.get(vcId);
  if (!m) { m = new Map(); _byVc.set(vcId, m); }
  return m;
}

/** 이번 주기에 다시 읽을 ref — 한 번도 안 읽은 것 먼저, 그다음 오래된 순. kind='vm'|'host'. */
export function pickDue(vcId, refs, kind, { now = Date.now(), periodMs, max }) {
  const m = vcMap(vcId);
  const due = [];
  for (const ref of refs) {
    const at = m.get(`${kind}:${ref}`)?.at || 0;
    if (!at || now - at >= periodMs) due.push([ref, at]);
  }
  due.sort((a, b) => a[1] - b[1]);
  return due.slice(0, Math.max(0, max)).map((x) => x[0]);
}

export function put(vcId, kind, ref, value) { vcMap(vcId).set(`${kind}:${ref}`, value); }
export function get(vcId, kind, ref) { return _byVc.get(vcId)?.get(`${kind}:${ref}`) || null; }

/** 인벤토리에서 사라진(또는 꺼진) 대상의 항목을 버린다 — 꺼진 VM 의 옛 경합 값을 '지금' 처럼 보이지 않게. */
export function prune(vcId, kind, liveRefs) {
  const m = _byVc.get(vcId);
  if (!m) return 0;
  const live = liveRefs instanceof Set ? liveRefs : new Set(liveRefs);
  let n = 0;
  for (const k of m.keys()) {
    if (!k.startsWith(`${kind}:`)) continue;
    if (!live.has(k.slice(kind.length + 1))) { m.delete(k); n += 1; }
  }
  return n;
}

export function setStatus(vcId, patch) { _status.set(vcId, { ...(_status.get(vcId) || {}), ...patch }); }
export function statusOf(vcId) { return _status.get(vcId) || null; }

/** 상태 요약(서비스 점검·엣지 로그 표·화면 머리말) — vCenter 별 캐시 크기·마지막 갱신·오류. 자격증명 없음. */
export function contentionStatus() {
  const vcenters = [];
  for (const [vcId, m] of _byVc) {
    let vms = 0; let hosts = 0;
    for (const k of m.keys()) { if (k.startsWith('vm:')) vms += 1; else if (k.startsWith('host:')) hosts += 1; }
    vcenters.push({ vcenterId: vcId, vms, hosts, ...(_status.get(vcId) || {}) });
  }
  for (const [vcId, st] of _status) if (!_byVc.has(vcId)) vcenters.push({ vcenterId: vcId, vms: 0, hosts: 0, ...st });
  return { vcenters: vcenters.slice(0, 64), omitted: Math.max(0, vcenters.length - 64) };
}

export function _resetContentionCache() { _byVc.clear(); _status.clear(); }
