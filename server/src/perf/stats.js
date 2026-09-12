/**
 * perf/stats.js — 서버 성능 측정의 **순수 계산부**(v2.498): 고정 버킷 히스토그램·백분위 근사·
 * 라우트 키 정규화·요약. 부수효과·타이머·I/O 가 없어 테스트로 고정한다.
 *
 * 왜 고정 버킷인가: 요청마다 표본을 배열에 쌓으면(정확한 백분위) 메모리가 트래픽에 비례하고
 * 정렬 비용이 든다. 12버킷 카운터는 요청당 `counts[i]++` 한 번(O(1), 상수 메모리)이고, 튜닝에
 * 필요한 것은 '이 라우트가 1초·3초·10초를 넘는 일이 얼마나 잦은가' 라서 버킷 해상도로 충분하다.
 * 백분위는 **버킷 경계 사이 선형 보간**이라 근사값이다 — 화면에 '근사' 임을 밝힌다(추정 금지 규칙).
 */

/** 버킷 상한(ms). 마지막 버킷은 이 값 초과(∞). */
export const BUCKETS_MS = Object.freeze([50, 100, 250, 500, 1000, 2000, 3000, 5000, 10_000, 20_000, 60_000]);
export const BUCKET_N = BUCKETS_MS.length + 1;

/** ms → 버킷 인덱스(0..BUCKET_N-1). 음수·NaN 은 0번. */
export function bucketIndex(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= BUCKETS_MS[0]) return 0;
  for (let i = 1; i < BUCKETS_MS.length; i++) if (v <= BUCKETS_MS[i]) return i;
  return BUCKETS_MS.length;
}

/**
 * 버킷 카운터에서 백분위(ms) 근사. 반환은 ms(숫자) 또는 표본이 없으면 null.
 * 마지막(∞) 버킷에 걸리면 마지막 경계(60000)를 하한으로 돌려주고, 호출부는 `maxMs` 와 함께 보여준다.
 */
export function percentileFromBuckets(counts, p) {
  const total = (counts || []).reduce((a, b) => a + (Number(b) || 0), 0);
  if (!total) return null;
  const want = Math.max(1, Math.ceil((Math.min(100, Math.max(0, p)) / 100) * total));
  let acc = 0;
  for (let i = 0; i < BUCKET_N; i++) {
    const c = Number(counts[i]) || 0;
    if (acc + c >= want) {
      const lo = i === 0 ? 0 : BUCKETS_MS[i - 1];
      const hi = i >= BUCKETS_MS.length ? BUCKETS_MS[BUCKETS_MS.length - 1] : BUCKETS_MS[i];
      if (i >= BUCKETS_MS.length) return hi;               // ∞ 버킷 — 하한만 알 수 있다
      const within = c > 0 ? (want - acc) / c : 1;         // 버킷 안에서의 위치(선형 가정)
      return Math.round(lo + (hi - lo) * within);
    }
    acc += c;
  }
  return BUCKETS_MS[BUCKETS_MS.length - 1];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{12,}$/i;
const NUM_RE = /^\d+$/;
const MOREF_RE = /^(vm|host|datastore|domain|group|resgroup|network|dvportgroup)-[0-9a-z-]+$/i;

/**
 * 라우트 키 — 집계 카디널리티를 유계로 만든다. express 가 매칭한 템플릿(`req.baseUrl + req.route.path`)이
 * 있으면 그것을 쓰고, 없으면(정적·404·미매칭) 경로의 식별자 세그먼트를 `:id` 로 마스킹한다.
 * 마스킹 대상: 숫자 · UUID · 12자 이상 hex · vCenter moref(vm-123 등) · 콜론이 든 복합 id.
 * 쿼리스트링은 호출부가 이미 제거한다(검색어·vCenter id 유출 방지).
 */
export function routeKeyOf({ baseUrl = '', routePath = '', path = '' } = {}) {
  if (routePath) {
    const joined = `${baseUrl || ''}${routePath === '/' ? '' : routePath}`;
    return (joined || '/').slice(0, 120);
  }
  const raw = String(path || '/').split('?')[0];
  const parts = raw.split('/').map((seg) => {
    if (!seg) return seg;
    if (NUM_RE.test(seg) || UUID_RE.test(seg) || HEX_RE.test(seg) || MOREF_RE.test(seg) || seg.includes(':')) return ':id';
    return seg;
  });
  return (parts.join('/') || '/').slice(0, 120);
}

/** 라우트 누계 엔트리 생성. */
export const newRouteEntry = () => ({ n: 0, sumMs: 0, maxMs: 0, slowN: 0, errN: 0, lastTs: 0, counts: new Array(BUCKET_N).fill(0) });

/** 누계에 1건 반영(O(1)). slow 는 호출부 임계 판정 결과. */
export function addSample(entry, { ms = 0, status = 200, ts = 0, slow = false } = {}) {
  const e = entry;
  const v = Math.max(0, Number(ms) || 0);
  e.n += 1;
  e.sumMs += v;
  if (v > e.maxMs) e.maxMs = v;
  if (slow) e.slowN += 1;
  if (Number(status) >= 500) e.errN += 1;
  if (ts > e.lastTs) e.lastTs = ts;
  e.counts[bucketIndex(v)] += 1;
  return e;
}

/**
 * 화면용 요약(백분위는 버킷 보간 근사).
 * 백분위는 **관측된 최댓값을 넘지 않게 깎는다** — 4ms 요청 1건인 라우트가 'p95 50ms'(버킷 상한)로
 * 보이면 근사가 아니라 오정보다. 최댓값은 정확히 알고 있으므로 상한으로 쓴다.
 */
export function summarizeRoute(route, entry) {
  const e = entry || newRouteEntry();
  const cap = (v) => (v == null ? null : Math.min(v, Math.round(e.maxMs)));
  return {
    route,
    n: e.n,
    avgMs: e.n ? Math.round(e.sumMs / e.n) : null,
    p50Ms: cap(percentileFromBuckets(e.counts, 50)),
    p95Ms: cap(percentileFromBuckets(e.counts, 95)),
    p99Ms: cap(percentileFromBuckets(e.counts, 99)),
    maxMs: Math.round(e.maxMs),
    slowN: e.slowN,
    errN: e.errN,
    lastTs: e.lastTs || null,
    buckets: [...e.counts],
  };
}

/**
 * 상위 N 라우트 정렬 — '느린 건수' 우선, 같으면 p95, 같으면 건수. 튜닝은 '자주 느린 것' 부터다.
 * rows 는 summarizeRoute 결과 배열.
 */
export function rankRoutes(rows, limit = 60) {
  return [...(rows || [])]
    .sort((a, b) => (b.slowN - a.slowN) || ((b.p95Ms || 0) - (a.p95Ms || 0)) || (b.n - a.n))
    .slice(0, Math.max(1, limit));
}

/**
 * 이벤트 루프 창 요약들에서 '정체 구간' 만 고른다(화면 표·hang 판정 공용).
 * windows: [{ts, maxMs, p99Ms, meanMs}] · thresholdMs 이상인 것만.
 */
export function stallWindows(windows, thresholdMs) {
  const th = Math.max(1, Number(thresholdMs) || 1000);
  return (windows || []).filter((w) => Number(w?.maxMs) >= th);
}

/** 시계열 다운샘플 — 화면 차트용(최대 points 개). 균등 간격으로 고른다(평균 왜곡 방지: 최댓값 보존). */
export function downsampleMax(windows, points = 240) {
  const arr = windows || [];
  const n = Math.max(2, Number(points) || 240);
  if (arr.length <= n) return [...arr];
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * step); const b = Math.min(arr.length, Math.floor((i + 1) * step));
    let best = arr[a];
    for (let j = a + 1; j < b; j++) if (Number(arr[j]?.maxMs) > Number(best?.maxMs)) best = arr[j];
    if (best) out.push(best);
  }
  return out;
}
