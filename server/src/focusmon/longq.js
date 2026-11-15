/**
 * focusmon/longq.js — 긴 구간 조회(v3.13.0 ⑭ — 시안 History · 사용자 "기본값대로 모두 구현해줘" · 컨펌 ① ② ④).
 *
 *  · 구간 1시간 · 6시간 · 24시간 · 7일 · 30일(`LONG_WINDOWS` — 1~30분 단추와 시간 띠는 그대로). 칸 수는 `LONG_POINTS`(시안: 120 · 180 · 288 · 168 · 180).
 *  · 자료: 24시간까지는 1분 요약(fm_sum1), 그 위는 1시간 요약(fm_sum60 — 아직 끝나지 않은 시간은 1분 요약을 합쳐 덧붙인다).
 *    서버 상세의 1시간은 원본(query.serverDetail) — 여러 서버를 한 화면에 놓는 개요 · 비교는 1시간부터 요약(원본 60묶음 × 서버 수는 무겁다).
 *  · 칸마다 표본 수 가중 평균 · 최저 · 최고(띠) · 요약이 없는 칸은 null(‘수집하지 않은 시간’ — 0 이 아니다).
 *  · 결과는 60초 기억(`MEMO_MS` — 같은 요청이 2초마다 와도 요약을 다시 풀지 않는다 · 화면도 긴 구간은 60초마다 묻는다).
 *  · 겹쳐 보기(컨펌 ④): 같은 칸 수로 하루 · 이레 앞 구간을 옮겨 CPU · 메모리 평균선 — 그때 수집하지 않은 칸은 비운다.
 *  · 데모(목) 대상은 mock.demoSumRows(같은 요약 모양).
 */
import * as db from './db.js';
import * as store from './store.js';
import { decodeSum, mergeSums, sumCol } from './summary.js';
import { summaryOf } from './rates.js';
import { seriesKeyFor, sampleAt, blocksFor, LONG_WINDOWS } from './query.js';
import { isDemoTarget, demoSumRows } from './mock.js';
import { backfillState } from './rollup.js';
import { createYielder } from '../util/timeSlice.js';

export { LONG_WINDOWS } from './query.js';
export const LONG_POINTS = Object.freeze({ 60: 120, 360: 180, 1440: 288, 10080: 168, 43200: 180 });
export const MEMO_MS = 60_000;
/** 요약 출처 — 24시간까지 1분 요약 · 그 위 1시간 요약. */
export const sourceOf = (win) => (win <= 1440 ? 'm' : 'h');
export const isLong = (win) => LONG_WINDOWS.includes(Number(win));
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

const memo = new Map();
function memoGet(k, now) { const x = memo.get(k); return x && now - x.at < MEMO_MS ? x.v : null; }
function memoSet(k, v, now) { memo.set(k, { at: now, v }); if (memo.size > 300) memo.delete(memo.keys().next().value); }

/**
 * 대상 하나의 요약 행 [from, to] → [{t, span, s}] | null(DB 를 못 열었다).
 * 1시간 요약은 끝난 시간만 있으므로, 마지막 끝난 시간 뒤(지금 시간)는 1분 요약을 합쳐 덧붙인다.
 */
export async function sumRowsFor(id, from, to, src) {
  if (isDemoTarget(id)) return demoSumRows(id, from, to, src === 'm' ? 60_000 : 3_600_000);
  if (src === 'm') {
    const rows = await db.readSum1(id, Math.floor(from / 60_000), Math.floor(to / 60_000), 2000);
    if (rows == null) return null;
    const out = [];
    for (const r of rows) { const s = decodeSum(r.data); if (s && s.keys.length) out.push({ t: r.minute * 60_000, span: 60_000, s }); }
    return out;
  }
  const fh = Math.floor(from / 3_600_000); const th = Math.floor(to / 3_600_000);
  const rows = await db.readSum60(id, fh, th, 1000);
  if (rows == null) return null;
  const out = [];
  for (const r of rows) { const s = decodeSum(r.data); if (s && s.keys.length) out.push({ t: r.hour * 3_600_000, span: 3_600_000, s }); }
  const lastH = rows.length ? rows[rows.length - 1].hour : fh - 1;
  for (let h = lastH + 1; h <= th; h++) {
    const mr = await db.readSum1(id, h * 60, h * 60 + 59, 120);
    const m = mergeSums((mr || []).map((x) => decodeSum(x.data)).filter((s) => s && s.keys.length));
    if (m) out.push({ t: h * 3_600_000, span: 3_600_000, s: m, partial: true });
  }
  return out;
}

/** 요약 행 → 칸 n 개(평균 · 최저 · 최고 · 표본 수). 칸 가운데 시각으로 나눈다. */
export function sumBuckets(rows, key, from, to, n) {
  const step = (to - from) / n;
  const s = new Float64Array(n); const c = new Float64Array(n); const lo = new Array(n).fill(null); const hi = new Array(n).fill(null);
  for (const r of rows || []) {
    const v = sumCol(r.s, key);
    if (!v || !(v.n > 0)) continue;
    const mid = r.t + r.span / 2;
    if (mid < from || mid > to) continue;
    const k = Math.min(n - 1, Math.max(0, Math.floor((mid - from) / step)));
    s[k] += v.a * v.n; c[k] += v.n;
    if (lo[k] == null || v.lo < lo[k]) lo[k] = v.lo;
    if (hi[k] == null || v.hi > hi[k]) hi[k] = v.hi;
  }
  const avg = new Array(n); for (let k = 0; k < n; k++) avg[k] = c[k] ? r2(s[k] / c[k]) : null;
  return { avg, min: lo.map(r2), max: hi.map(r2), cnt: Array.from(c) };
}

/** 지금 표본(끝 값 · 카드 줄) — 메모리의 최근 묶음에서(긴 구간도 끝 값은 원본). */
async function lastSampleOf(id, to) {
  const { blocks } = await blocksFor(id, to - 3 * 60_000, to);
  for (let bi = blocks.length - 1; bi >= 0; bi--) { const b = blocks[bi]; for (let i = b.ts.length - 1; i >= 0; i--) if (b.ts[i] <= to) return { s: sampleAt(b, i), at: b.ts[i] }; }
  return null;
}
const lastMetaOf = (rows) => { for (let i = (rows || []).length - 1; i >= 0; i--) if (rows[i].s?.meta) return rows[i].s.meta; return null; };

/** 개요(긴 구간) — 서버마다 4줄(평균) + 끝 값 요약. */
export async function longOverview(ids, w, now = Date.now()) {
  const src = sourceOf(w.win); const n = Math.min(90, LONG_POINTS[w.win]);
  const key = `ov|${ids.join(',')}|${w.win}|${Math.floor(w.to / MEMO_MS)}`;
  const hit = memoGet(key, now); if (hit) return hit;
  const y = createYielder(15);
  const out = []; let partial = false;
  for (const id of ids) {
    const rows = await sumRowsFor(id, w.from, w.to, src);
    if (rows == null) partial = true;
    const series = {};
    for (const [k, sk] of [['cpu', 's.cpu'], ['mem', 's.mem'], ['net', 's.net'], ['disk', 's.disk']]) series[k] = sumBuckets(rows, sk, w.from, w.to, n).avg;
    const last = await lastSampleOf(id, w.to);
    out.push({ id, n: (rows || []).length, lastAt: last?.at ?? null, sum: last ? summaryOf(last.s) : null, series });
    await y();
  }
  const v = { targets: out, partial, points: n, long: { src, building: backfillState().building } };
  memoSet(key, v, now);
  return v;
}

/** 지표 비교(긴 구간) — 같은 칸 수 · 칸 평균 · 최고 · 끝 값. */
export async function longCompare(ids, w, { metric = 'cpu', item = 'pct', scope = 'all' } = {}, now = Date.now()) {
  const src = sourceOf(w.win); const n = LONG_POINTS[w.win];
  const key = `cmp|${ids.join(',')}|${w.win}|${Math.floor(w.to / MEMO_MS)}|${metric}|${item}|${scope}`;
  const hit = memoGet(key, now); if (hit) return hit;
  const y = createYielder(15);
  const out = []; let partial = false;
  for (const id of ids) {
    const rows = await sumRowsFor(id, w.from, w.to, src);
    if (rows == null) partial = true;
    const sk = seriesKeyFor(metric, item, scope, lastMetaOf(rows));
    if (!sk) { out.push({ id, key: null, avg: [], max: [], last: null, missing: 'no-series' }); continue; }
    const b = sumBuckets(rows, sk, w.from, w.to, n);
    let last = null; let lastAt = null;
    for (let k = n - 1; k >= 0; k--) if (b.avg[k] != null) { last = b.avg[k]; lastAt = w.from + ((k + 0.5) * (w.to - w.from)) / n; break; }
    const has = (rows || []).some((r) => r.s.keys.includes(sk));
    out.push({ id, key: sk, avg: b.avg, max: b.max, last, lastAt, n: (rows || []).length, ...((rows || []).length && !has ? { missing: 'no-series' } : {}) });
    await y();
  }
  const v = { targets: out, partial, points: n, long: { src, building: backfillState().building } };
  memoSet(key, v, now);
  return v;
}

/** 서버 상세 차트에 쓰는 요약 열 — CPU 구성 · 메모리 · 부하 · 장치 · 인터페이스 · 더할 지표. */
const EXT = ['k.cs', 'k.in', 'k.fk', 'l.run', 'q.D', 'q.Z', 'p.rt', 'p.lo', 'p.es', 'p.tw', 'v.si', 'v.so', 'v.mf', 'v.sc'];
/**
 * 서버 상세(긴 구간 — 6시간부터). 표는 끝 순간(원본 마지막 표본 · 긴 구간에는 '구간 평균' 이 없다 — 화면이 단추를 숨긴다).
 * @returns 차트(평균) · 띠(CPU 사용률 최저~최고) · 겹쳐 보기 · 출처 · 백필 상태
 */
export async function longServer(id, w, { dev = '', cmp = '' } = {}, now = Date.now()) {
  const src = sourceOf(w.win); const n = LONG_POINTS[w.win]; const SP = 60;
  const key = `srv|${id}|${w.win}|${Math.floor(w.to / MEMO_MS)}|${dev}|${cmp}`;
  const hit = memoGet(key, now); if (hit) return hit;
  const rows = await sumRowsFor(id, w.from, w.to, src);
  const meta = lastMetaOf(rows) || { net: {}, dsk: {}, fs: {} };
  const B = (k, pts = n) => sumBuckets(rows, k, w.from, w.to, pts);
  const cpuPct = B('c.pct');
  const charts = {
    cpu: { usr: B('c.usr').avg, sys: B('c.sys').avg, iow: B('c.iow').avg, stl: B('c.stl').avg },
    band: { min: cpuPct.min, max: cpuPct.max, avg: cpuPct.avg },
    mem: B('m.pct').avg, load: B('l.1').avg,
    net: Object.entries(meta.net || {}).filter(([, m]) => m.k !== 'virt').slice(0, 64).map(([nm]) => ({ n: nm, rx: B(`n.${nm}.rx`, SP).avg, tx: B(`n.${nm}.tx`, SP).avg })),
    dsk: Object.entries(meta.dsk || {}).filter(([, m]) => m.k === 'disk').slice(0, 256).map(([nm]) => ({ n: nm, wAwait: B(`d.${nm}.wAwait`, SP).avg })),
    ext: {},
  };
  for (const k of EXT) {
    let mx = null; let mxAt = null;
    for (const r of rows || []) { const c = sumCol(r.s, k); if (c && (mx == null || c.hi > mx)) { mx = c.hi; mxAt = r.t + r.span / 2; } }
    charts.ext[k] = { vals: B(k, SP).avg, max: r2(mx), maxAt: mxAt };
  }
  const disks = Object.entries(meta.dsk || {}).filter(([, m]) => m.k === 'disk').map(([nm]) => nm);
  const pick = /^[A-Za-z0-9_.!:+-]{1,64}$/.test(String(dev)) && disks.includes(dev) ? dev : disks[0] || null;
  const devChart = pick ? { n: pick, rMB: B(`d.${pick}.rMB`).avg, wMB: B(`d.${pick}.wMB`).avg, rAwait: B(`d.${pick}.rAwait`).avg, wAwait: B(`d.${pick}.wAwait`).avg } : null;
  const shift = cmp === '1d' ? 86_400_000 : cmp === '7d' ? 7 * 86_400_000 : 0;
  let overlay = null;
  if (shift) {
    const cr = await sumRowsFor(id, w.from - shift, w.to - shift, src);
    overlay = { cmp, cpu: sumBuckets(cr, 'c.pct', w.from - shift, w.to - shift, n).avg, mem: sumBuckets(cr, 'm.pct', w.from - shift, w.to - shift, n).avg };
  }
  const last = await lastSampleOf(id, w.to);
  const table = last ? last.s : null;
  const v = {
    id, n: (rows || []).length, firstAt: rows?.length ? rows[0].t : null, lastAt: last?.at ?? null, coverMs: null, at: 'end', table, summary: table ? summaryOf(table) : null,
    charts, dev: devChart, points: n, sparkPoints: SP, partial: rows == null, hello: store.helloOf(id), overlay,
    long: { src, building: backfillState().building, rows: (rows || []).length },
  };
  memoSet(key, v, now);
  return v;
}

/** 시험용. */
export function _resetForTest() { memo.clear(); }
