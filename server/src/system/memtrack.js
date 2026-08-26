/**
 * 포탈 프로세스 메모리 추적(누수 관찰) — process.memoryUsage() 스냅샷을 metrics 샘플러에
 * 실어 시계열 DB(samples)의 mem_* 계열로 적재하고, 최소자승 추세(MB/일)로 증가 신호를
 * 판정한다. 판정은 '누수 확정'이 아니라 관찰 신호다. 프로세스가 재시작되면 힙/RSS 가
 * 리셋되어 재시작을 가로지르는 기울기는 의미가 없으므로, 추세 계산은 항상 '현재 프로세스
 * 기동 이후' 구간으로 한정한다.
 *
 * 적재 볼륨: 5계열 × 샘플 1회 = 5행/주기(기본 60초). 기존 metrics 적재(호스트 온도·DS·GPU,
 * 주기당 수천 행)의 0.3% 미만이라 별도 보존정책 없이 metrics 전역 보존기간을 따른다.
 */

const MB = 1024 * 1024;
export const MEM_KEY = 'portal';

// field = process.memoryUsage() 키. heapUsed 가 누수 판정의 1차 신호(GC 후에도 남는 증가),
// rss 는 네이티브/버퍼/조각화 포함 실점유(2차 신호).
export const MEM_METRICS = [
  { metric: 'mem_rss', field: 'rss' },
  { metric: 'mem_heap_used', field: 'heapUsed' },
  { metric: 'mem_heap_total', field: 'heapTotal' },
  { metric: 'mem_ext', field: 'external' },
  { metric: 'mem_abuf', field: 'arrayBuffers' },
];

/** metrics DB insertMany 형식의 행으로 현재 메모리 스냅샷을 반환(MB, 소수 1자리). */
export function memSampleRows() {
  const mu = process.memoryUsage();
  return MEM_METRICS
    .filter((m) => Number.isFinite(mu[m.field]))
    .map((m) => ({ metric: m.metric, k: MEM_KEY, v: Number((mu[m.field] / MB).toFixed(1)) }));
}

// 시간당 1줄 상태 로그 — 링 버퍼(1000줄)·journal 을 어지럽히지 않으면서 UI 없이도
// (journalctl / 진단 화면 서버 로그) 사후 추적이 가능하게 남긴다.
const LOG_EVERY_MS = 3600_000;
let _lastLogTs = 0;
export function maybeLogMem(ts = Date.now()) {
  if (ts - _lastLogTs < LOG_EVERY_MS) return false;
  _lastLogTs = ts;
  const mu = process.memoryUsage();
  const f = (b) => (b / MB).toFixed(1);
  console.log(`[memtrack] rss=${f(mu.rss)}MB heap=${f(mu.heapUsed)}/${f(mu.heapTotal)}MB ext=${f(mu.external)}MB abuf=${f(mu.arrayBuffers || 0)}MB uptime=${(process.uptime() / 3600).toFixed(1)}h`);
  return true;
}

/**
 * 최소자승 선형 추세. points: [{ts(ms), v(MB)}] → { mbPerDay, r2, n, spanMs, deltaMB } 또는
 * null(표본 2개 미만/동일 시각). x 를 일 단위로 정규화해 ms 원값의 수치 불안정을 피한다.
 */
export function linearTrend(points) {
  const pts = (points || []).filter((p) => p && Number.isFinite(p.ts) && Number.isFinite(p.v));
  if (pts.length < 2) return null;
  const x0 = pts[0].ts;
  const n = pts.length;
  const xs = pts.map((p) => (p.ts - x0) / 86_400_000);
  const ys = pts.map((p) => p.v);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  // syy=0(완전 평탄)이면 결정계수가 정의되지 않는다 — 기울기 0이므로 1로 두어도 판정에 무해.
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return {
    mbPerDay: Number(slope.toFixed(2)),
    r2: Number(Math.max(0, Math.min(1, r2)).toFixed(3)),
    n,
    spanMs: pts[n - 1].ts - pts[0].ts,
    deltaMB: Number((ys[n - 1] - ys[0]).toFixed(1)),
  };
}

// 판정 휴리스틱 임계값 — 확정이 아니라 관찰 신호. heapUsed 는 GC 대상이라 '지속'(r² 높음)
// 우상향이 중요하고, rss 는 allocator 조각화·페이지 캐시로 계단형 증가가 흔해 더 큰
// 기울기에서만 신호로 본다. 12시간 미만 관측은 워밍업(캐시 시드)과 구분이 안 돼 판정 보류.
export const TREND_THRESHOLDS = {
  minSpanMs: 12 * 3600_000, minN: 12,
  heapWatchMBd: 3, heapGrowMBd: 8,
  rssWatchMBd: 20, rssGrowMBd: 50,
  r2Watch: 0.4, r2Grow: 0.6,
};

/** heap/rss 추세(linearTrend 결과)로 관찰 판정을 낸다. */
export function assessTrend(heap, rss) {
  const T = TREND_THRESHOLDS;
  const basis = heap || rss;
  if (!basis || basis.spanMs < T.minSpanMs || basis.n < T.minN) {
    return { level: 'insufficient', text: '판정에 필요한 관측 구간(재시작 후 12시간 이상)이 아직 부족합니다.' };
  }
  if (heap && heap.mbPerDay >= T.heapGrowMBd && heap.r2 >= T.r2Grow) {
    return { level: 'growing', text: `힙 사용량이 지속 증가 추세입니다(+${heap.mbPerDay}MB/일, r²=${heap.r2}) — 누수 가능성, 관찰 필요.` };
  }
  if (rss && rss.mbPerDay >= T.rssGrowMBd && rss.r2 >= T.r2Grow) {
    return { level: 'growing', text: `RSS가 지속 증가 추세입니다(+${rss.mbPerDay}MB/일, r²=${rss.r2}) — 힙 외(네이티브/버퍼) 증가 포함, 관찰 필요.` };
  }
  if ((heap && heap.mbPerDay >= T.heapWatchMBd && heap.r2 >= T.r2Watch) ||
      (rss && rss.mbPerDay >= T.rssWatchMBd && rss.r2 >= T.r2Watch)) {
    return { level: 'watch', text: '완만한 증가 추세 — 캐시 워밍업일 수 있어 며칠 더 관찰이 필요합니다.' };
  }
  return { level: 'stable', text: '증가 추세 없음 — 안정.' };
}

const WINDOWS = {
  '6h': { ms: 6 * 3600_000, bucketMs: 5 * 60_000 },
  '24h': { ms: 24 * 3600_000, bucketMs: 10 * 60_000 },
  '7d': { ms: 7 * 86_400_000, bucketMs: 3600_000 },   // 1h 정배수 → 시간당 롤업 경로
  '30d': { ms: 30 * 86_400_000, bucketMs: 6 * 3600_000 },
};

const toMB = (b) => Number((b / MB).toFixed(1));

/** /admin/memtrack 응답 — 현재값 + 창(window)별 시계열 + 기동 이후 추세 판정. */
export function memtrackReport(db, windowKey = '24h') {
  const key = Object.prototype.hasOwnProperty.call(WINDOWS, windowKey) ? windowKey : '24h';
  const win = WINDOWS[key];
  const now = Date.now();
  const startedAt = now - process.uptime() * 1000;
  const since = now - win.ms;
  const series = {};
  for (const m of MEM_METRICS) series[m.field] = db.history(m.metric, MEM_KEY, since, win.bucketMs, 2000);
  // 추세는 재시작 리셋이 섞이지 않게 현재 프로세스 기동 이후 버킷만으로 계산한다.
  const sinceStart = (arr) => (arr || []).filter((p) => p.ts >= startedAt).map((p) => ({ ts: p.ts, v: p.avg }));
  const heapTrend = linearTrend(sinceStart(series.heapUsed));
  const rssTrend = linearTrend(sinceStart(series.rss));
  const mu = process.memoryUsage();
  return {
    now,
    startedAt,
    uptimeSec: Math.round(process.uptime()),
    window: key,
    current: {
      rssMB: toMB(mu.rss),
      heapUsedMB: toMB(mu.heapUsed),
      heapTotalMB: toMB(mu.heapTotal),
      externalMB: toMB(mu.external),
      arrayBuffersMB: toMB(mu.arrayBuffers || 0),
    },
    series,
    trend: { heapUsed: heapTrend, rss: rssTrend, verdict: assessTrend(heapTrend, rssTrend) },
    meta: db.meta('mem_rss'), // 수집 개시/최종 시각·총 표본 수
  };
}
