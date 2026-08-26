import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linearTrend, assessTrend, memSampleRows, memtrackReport, MEM_METRICS, TREND_THRESHOLDS } from '../src/system/memtrack.js';

const DAY = 86_400_000;

// 기울기 10MB/일의 정확한 직선 — slope·r²·delta 가 해석적으로 맞아야 한다.
test('linearTrend: 정확한 직선의 기울기와 r²', () => {
  const pts = [];
  for (let h = 0; h <= 48; h++) pts.push({ ts: h * 3600_000, v: 100 + (10 * h) / 24 });
  const t = linearTrend(pts);
  assert.ok(Math.abs(t.mbPerDay - 10) < 0.01, `slope=${t.mbPerDay}`);
  assert.ok(t.r2 > 0.999);
  assert.equal(t.n, 49);
  assert.equal(t.spanMs, 48 * 3600_000);
  assert.ok(Math.abs(t.deltaMB - 20) < 0.11);
});

test('linearTrend: 평탄한 시계열은 기울기 0', () => {
  const pts = Array.from({ length: 30 }, (_, i) => ({ ts: i * 3600_000, v: 500 }));
  const t = linearTrend(pts);
  assert.equal(t.mbPerDay, 0);
});

test('linearTrend: 표본 부족/동일 시각은 null', () => {
  assert.equal(linearTrend([]), null);
  assert.equal(linearTrend([{ ts: 1, v: 1 }]), null);
  assert.equal(linearTrend([{ ts: 5, v: 1 }, { ts: 5, v: 2 }]), null); // sxx=0
  assert.equal(linearTrend(null), null);
});

test('assessTrend: 관측 12시간 미만이면 판정 보류(insufficient)', () => {
  const short = { mbPerDay: 100, r2: 1, n: 100, spanMs: 6 * 3600_000 };
  assert.equal(assessTrend(short, null).level, 'insufficient');
  const fewSamples = { mbPerDay: 100, r2: 1, n: TREND_THRESHOLDS.minN - 1, spanMs: 2 * DAY };
  assert.equal(assessTrend(fewSamples, null).level, 'insufficient');
  assert.equal(assessTrend(null, null).level, 'insufficient');
});

test('assessTrend: 힙 지속 증가는 growing', () => {
  const heap = { mbPerDay: 12, r2: 0.9, n: 200, spanMs: 3 * DAY };
  assert.equal(assessTrend(heap, null).level, 'growing');
});

test('assessTrend: 힙 평탄 + RSS 급증(네이티브 증가)도 growing', () => {
  const heap = { mbPerDay: 0.2, r2: 0.1, n: 200, spanMs: 3 * DAY };
  const rss = { mbPerDay: 60, r2: 0.8, n: 200, spanMs: 3 * DAY };
  assert.equal(assessTrend(heap, rss).level, 'growing');
});

test('assessTrend: 완만한 증가는 watch, 평탄은 stable', () => {
  const mild = { mbPerDay: 5, r2: 0.5, n: 200, spanMs: 3 * DAY };
  assert.equal(assessTrend(mild, null).level, 'watch');
  const flat = { mbPerDay: 0.3, r2: 0.05, n: 200, spanMs: 3 * DAY };
  assert.equal(assessTrend(flat, null).level, 'stable');
});

test('assessTrend: 기울기가 커도 r²가 낮으면(들쭉날쭉) growing 으로 단정하지 않음', () => {
  const noisy = { mbPerDay: 50, r2: 0.2, n: 200, spanMs: 3 * DAY };
  const v = assessTrend(noisy, null);
  assert.notEqual(v.level, 'growing');
});

test('memSampleRows: 5개 계열, 유한한 MB 값', () => {
  const rows = memSampleRows();
  assert.equal(rows.length, MEM_METRICS.length);
  const metrics = new Set(rows.map((r) => r.metric));
  for (const m of MEM_METRICS) assert.ok(metrics.has(m.metric), m.metric);
  // ext/abuf 는 소형 프로세스에서 0.0MB 로 반올림될 수 있어 0 허용 — rss/heap 만 양수 요구.
  for (const r of rows) {
    assert.equal(r.k, 'portal');
    assert.ok(Number.isFinite(r.v) && r.v >= 0, `${r.metric}=${r.v}`);
  }
  for (const m of ['mem_rss', 'mem_heap_used', 'mem_heap_total']) {
    const r = rows.find((x) => x.metric === m);
    assert.ok(r.v > 0, `${m}=${r.v}`);
  }
});

test('memtrackReport: 응답 구조 + 잘못된 window 는 24h 폴백', () => {
  const db = {
    history: () => [],
    meta: () => ({ firstTs: null, lastTs: null, count: 0 }),
  };
  const rep = memtrackReport(db, 'bogus');
  assert.equal(rep.window, '24h');
  assert.ok(rep.current.rssMB > 0);
  assert.ok(rep.uptimeSec >= 0);
  assert.ok(rep.startedAt <= rep.now);
  for (const m of MEM_METRICS) assert.ok(Array.isArray(rep.series[m.field]), m.field);
  // 표본이 없으면 판정은 보류여야 한다(허위 안정 판정 금지).
  assert.equal(rep.trend.verdict.level, 'insufficient');
  assert.equal(rep.trend.heapUsed, null);
});

test('memtrackReport: 기동 이전(직전 프로세스) 표본은 추세에서 제외', () => {
  // 기동 이전 구간에 가파른 증가를 심어도, 현재 프로세스 구간(평탄)만으로 판정해야 한다.
  const now = Date.now();
  const startedAt = now - Math.round(process.uptime() * 1000);
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push({ ts: startedAt - (50 - i) * 3600_000, avg: 100 + i * 40, min: 0, max: 0 }); // 이전 프로세스(가파름)
  rows.push({ ts: startedAt + 1, avg: 300, min: 0, max: 0 });
  rows.push({ ts: now, avg: 300, min: 0, max: 0 });
  const db = { history: () => rows, meta: () => ({ firstTs: rows[0].ts, lastTs: now, count: rows.length }) };
  const rep = memtrackReport(db, '7d');
  // 현재 프로세스 구간 표본은 2개(평탄) — 이전 프로세스의 +960MB/일이 새어들면 안 된다.
  assert.ok(rep.trend.heapUsed === null || Math.abs(rep.trend.heapUsed.mbPerDay) < 1,
    `이전 프로세스 기울기가 새어듦: ${JSON.stringify(rep.trend.heapUsed)}`);
});
