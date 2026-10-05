// VM 구성 속성 캐시(B10, v2.697) — vCenter 별 · VM moref 별. 인메모리(재시작하면 비고 몇 주기에 걸쳐 다시 찬다 —
// 그동안 vm.cfg 가 없으면 화면은 '수집 중' 이라 말한다. 0·false 로 채우지 않는다).
//
// 왜 30초 인벤토리 요청에 싣지 않는가: 속성 16개 × 5,850 VM 은 매 주기 응답을 수 MB 늘리고, 장치 목록은 VM 당 수 KB 라
// 매 주기 수십 MB 다(28 vCenter · RTT 800ms 회선). 구성은 거의 바뀌지 않으므로 **오래된 것부터 주기당 상한만큼**
// 다시 읽는다 — 정상 상태 비용은 (VM 수 ÷ 갱신 주기 ÷ 폴 주기) ≈ 5,850 / 60 ≈ 100 VM/주기.

const _byVc = new Map(); // vcId -> Map(ref -> { cfg, dev })
const _status = new Map(); // vcId -> { cfgAt, devAt, cfgError, devError, cfgFetched, devFetched, backoffUntil }

function vcMap(vcId) {
  let m = _byVc.get(vcId);
  if (!m) { m = new Map(); _byVc.set(vcId, m); }
  return m;
}

/**
 * 이번 주기에 다시 읽을 VM ref — 한 번도 안 읽은 것 먼저, 그다음 오래된 순. kind='cfg'|'dev'.
 * `eligible`(선택) 로 대상을 좁힌다(예: 장치 목록은 템플릿 포함 전부).
 */
export function pickDue(vcId, refs, kind, { now = Date.now(), periodMs, max }) {
  const m = vcMap(vcId);
  const due = [];
  for (const ref of refs) {
    const e = m.get(ref)?.[kind];
    const at = e?.at || 0;
    if (!at || now - at >= periodMs) due.push([ref, at]);
  }
  due.sort((a, b) => a[1] - b[1]);
  return due.slice(0, Math.max(0, max)).map((x) => x[0]);
}

export function put(vcId, ref, kind, value) {
  const m = vcMap(vcId);
  const e = m.get(ref) || {};
  e[kind] = value;
  m.set(ref, e);
}

export function get(vcId, ref) { return _byVc.get(vcId)?.get(ref) || null; }

/** 인벤토리에서 사라진 VM 의 항목을 버린다(누수 방지 — v2.550.3 '대상 목록 기준 정리' 규약). */
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

/** 상태 요약(서비스 점검·엣지 로그 표용) — vCenter 별 캐시 크기·마지막 갱신·오류. 자격증명 없음. */
export function vmCfgStatus() {
  const vcenters = [];
  for (const [vcId, m] of _byVc) {
    let cfg = 0; let dev = 0;
    for (const e of m.values()) { if (e.cfg) cfg += 1; if (e.dev) dev += 1; }
    vcenters.push({ vcenterId: vcId, vms: m.size, cfg, dev, ...(_status.get(vcId) || {}) });
  }
  return { vcenters: vcenters.slice(0, 64), omitted: Math.max(0, vcenters.length - 64) };
}

export function _resetVmCfgCache() { _byVc.clear(); _status.clear(); }
