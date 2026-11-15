/**
 * focusmon/longq.js — 긴 구간 조회(v3.13.0 ⑭ — 시안 History · 사용자 "기본값대로 모두 구현해줘" · 컨펌 ① ② ④).
 *
 *  · 구간 1시간 · 6시간 · 24시간 · 7일 · 30일(`LONG_WINDOWS` — 1~30분 단추와 시간 띠는 그대로). 칸 수는 `LONG_POINTS`(40 · 180 · 288 · 168 · 180).
 *    칸 폭은 요약 간격 이상(1시간 = 1.5분 칸 — 반증 F1: 시안의 120칸이면 1분 요약 60줄이 30초 칸에 하나 걸러 들어가 비교 선이 그려지지 않았다).
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
export const LONG_POINTS = Object.freeze({ 60: 40, 360: 180, 1440: 288, 10080: 168, 43200: 180 });
/** 1시간 요약 경로에서 1분 요약으로 메우는 끝 시간 수(지금 시간 + 아직 롤업 전인 바로 앞 시간) — 가운데 빠진 시간은 메우지 않는다(반증 F5 — 따라잡는 동안 요청이 1초 넘게 막혔다). */
export const PARTIAL_HOURS = 2;
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
export async function sumRowsFor(id, from, to, src, y = createYielder(15)) {
  if (isDemoTarget(id)) return demoSumRows(id, from, to, src === 'm' ? 60_000 : 3_600_000);
  if (src === 'm') {
    const fm = Math.floor(from / 60_000); const tm = Math.floor(to / 60_000);
    const rows = await db.readSum1(id, fm, tm, Math.min(5000, tm - fm + 1));
    if (rows == null) return null;
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const s = decodeSum(rows[i].data); if (s && s.keys.length) out.push({ t: rows[i].minute * 60_000, span: 60_000, s });
      if ((i & 63) === 63) await y(); // 요청 경로 — 시간 기준 양보(perf-db)
    }
    return out;
  }
  const fh = Math.floor(from / 3_600_000); const th = Math.floor(to / 3_600_000);
  const rows = await db.readSum60(id, fh, th, Math.min(5000, th - fh + 1));
  if (rows == null) return null;
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const s = decodeSum(rows[i].data); if (s && s.keys.length) out.push({ t: rows[i].hour * 3_600_000, span: 3_600_000, s });
    if ((i & 63) === 63) await y();
  }
  // 끝의 지금 시간 · 아직 롤업 전인 바로 앞 시간만 1분 요약으로 메운다(PARTIAL_HOURS) — 칸 가운데는 실제로 덮은 구간(t0 ~ t1)의 가운데(반증 F12)
  const have = new Set(rows.map((r) => r.hour));
  for (let h = Math.max(fh, th - PARTIAL_HOURS + 1); h <= th; h++) {
    if (have.has(h)) continue;
    const mr = await db.readSum1(id, h * 60, Math.min(h * 60 + 59, Math.floor(to / 60_000)), 60); // 구간 끝 뒤의 분은 넣지 않는다(지난 구간)
    const m = mergeSums((mr || []).map((x) => decodeSum(x.data)).filter((s) => s && s.keys.length));
    if (m) out.push({ t: h * 3_600_000, span: 3_600_000, s: m, partial: true });
    await y();
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
    // 끝나지 않은 시간(partial)은 실제로 덮은 구간의 가운데 — 정시 가운데(+30분)면 지금보다 뒤라 버려졌다(반증 F12)
    const mid = r.partial && r.s?.t0 != null && r.s?.t1 != null ? (r.s.t0 + r.s.t1) / 2 : r.t + r.span / 2;
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
  const y = createYielder(15);
  let v = memoGet(key, now);
  if (!v) {
    const out = []; let partial = false;
    for (const id of ids) {
      const rows = await sumRowsFor(id, w.from, w.to, src, y);
      if (rows == null) partial = true;
      const series = {};
      for (const [k, sk] of [['cpu', 's.cpu'], ['mem', 's.mem'], ['net', 's.net'], ['disk', 's.disk']]) series[k] = sumBuckets(rows, sk, w.from, w.to, n).avg;
      out.push({ id, n: (rows || []).length, series });
      await y();
    }
    v = { targets: out, partial, points: n, src };
    memoSet(key, v, now);
  }
  // 끝 값(카드 숫자 · 줄)은 기억하지 않는다 — 메모리의 최근 표본에서 매번(반증 F8: 60초 기억에 끝 값까지 넣어 수집 중인데 표가 묵었다)
  const targets = [];
  for (const x of v.targets) { const last = await lastSampleOf(x.id, w.to); targets.push({ ...x, lastAt: last?.at ?? null, sum: last ? summaryOf(last.s) : null }); }
  return { targets, partial: v.partial, points: v.points, long: { src: v.src, building: backfillState().building } };
}

/** 지표 비교(긴 구간) — 같은 칸 수 · 칸 평균 · 최고 · 끝 값. */
export async function longCompare(ids, w, { metric = 'cpu', item = 'pct', scope = 'all' } = {}, now = Date.now()) {
  const src = sourceOf(w.win); const n = LONG_POINTS[w.win];
  const key = `cmp|${ids.join(',')}|${w.win}|${Math.floor(w.to / MEMO_MS)}|${metric}|${item}|${scope}`;
  const hit = memoGet(key, now); if (hit) return hit;
  const y = createYielder(15);
  const out = []; let partial = false;
  for (const id of ids) {
    const rows = await sumRowsFor(id, w.from, w.to, src, y);
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
  const y = createYielder(15);
  let v = memoGet(key, now);
  if (!v) {
    const rows = await sumRowsFor(id, w.from, w.to, src, y);
    const meta = lastMetaOf(rows) || { net: {}, dsk: {}, fs: {} };
    const B = (k, pts = n) => sumBuckets(rows, k, w.from, w.to, pts);
    const cpuPct = B('c.pct');
    const charts = {
      cpu: { usr: B('c.usr').avg, sys: B('c.sys').avg, iow: B('c.iow').avg, stl: B('c.stl').avg },
      band: { min: cpuPct.min, max: cpuPct.max, avg: cpuPct.avg },
      mem: B('m.pct').avg, load: B('l.1').avg, net: [], dsk: [], ext: {},
    };
    await y();
    charts.net = Object.entries(meta.net || {}).filter(([, m]) => m.k !== 'virt').slice(0, 64).map(([nm]) => ({ n: nm, rx: B(`n.${nm}.rx`, SP).avg, tx: B(`n.${nm}.tx`, SP).avg }));
    await y();
    charts.dsk = Object.entries(meta.dsk || {}).filter(([, m]) => m.k === 'disk').slice(0, 256).map(([nm]) => ({ n: nm, wAwait: B(`d.${nm}.wAwait`, SP).avg }));
    await y();
    for (const k of EXT) {
      let mx = null; let mxAt = null;
      for (const r of rows || []) { const c = sumCol(r.s, k); if (c && (mx == null || c.hi > mx)) { mx = c.hi; mxAt = r.t + r.span / 2; } }
      charts.ext[k] = { vals: B(k, SP).avg, max: r2(mx), maxAt: mxAt };
      await y();
    }
    const disks = Object.entries(meta.dsk || {}).filter(([, m]) => m.k === 'disk').map(([nm]) => nm);
    const pick = /^[A-Za-z0-9_.!:+-]{1,64}$/.test(String(dev)) && disks.includes(dev) ? dev : disks[0] || null;
    const devChart = pick ? { n: pick, rMB: B(`d.${pick}.rMB`).avg, wMB: B(`d.${pick}.wMB`).avg, rAwait: B(`d.${pick}.rAwait`).avg, wAwait: B(`d.${pick}.wAwait`).avg } : null;
    const shift = cmp === '1d' ? 86_400_000 : cmp === '7d' ? 7 * 86_400_000 : 0;
    let overlay = null;
    if (shift) {
      const cr = await sumRowsFor(id, w.from - shift, w.to - shift, src, y);
      overlay = { cmp, cpu: sumBuckets(cr, 'c.pct', w.from - shift, w.to - shift, n).avg, mem: sumBuckets(cr, 'm.pct', w.from - shift, w.to - shift, n).avg };
    }
    v = { id, n: (rows || []).length, firstAt: rows?.length ? rows[0].t : null, charts, dev: devChart, points: n, sparkPoints: SP, partial: rows == null, overlay, src, rows: (rows || []).length };
    memoSet(key, v, now);
  }
  // 끝 순간 표 · 요약 · 인사(hello)는 기억하지 않는다 — 매번 메모리의 최근 표본에서(반증 F8)
  const last = await lastSampleOf(id, w.to);
  const table = last ? last.s : null;
  const { src: s0, rows: nRows, ...rest } = v;
  return { ...rest, lastAt: last?.at ?? null, coverMs: null, at: 'end', table, summary: table ? summaryOf(table) : null, hello: store.helloOf(id),
    long: { src: s0, building: backfillState().building, rows: nRows } };
}

/** 시험용. */
export function _resetForTest() { memo.clear(); }
