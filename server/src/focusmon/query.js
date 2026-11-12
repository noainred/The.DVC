/**
 * focusmon/query.js — 화면이 읽는 보기(v2.976): 개요 · 지표 비교 · 서버 상세 · iostat 비교 · 프로세스 · 기록이 있는 시간.
 *
 *  · 최근 구간(끝 시각 없음)은 **메모리만** 읽는다(장비 · DB 왕복 0 — 2초 조회). 과거 구간은 메모리에 없는 분만 DB 에서 풀어 읽는다.
 *  · 구간 = 1 · 5 · 10 · 30분(사용자 요청 2026-11-11). 차트 점은 최대 150칸(개요 90칸)으로 줄이고, 칸마다 **평균과 최고**를 함께 낸다(순간 급등이 사라지지 않게).
 *  · 표의 값은 ‘구간 끝 순간’ 또는 ‘구간 평균’(**시간 가중** — 표본이 덮는 시간 · 지연은 요청 수 × 시간 — rates.timeAverageIostat · v2.979). 못 읽은 값 · 요청 0건의 지연은 null.
 *  · 큰 조회(서버 20대 × 30분 과거 구간)는 대상마다 시간 기준 양보(createYielder)를 끼운다(docs/rules/perf-db.md v2.693).
 *  · 풀어 둔 DB 묶음은 작은 LRU(600)에 둔다 — 같은 과거 구간을 여러 화면이 볼 때 다시 풀지 않게.
 */
import * as store from './store.js';
import * as db from './db.js';
import { decodeBlock, decodeProcBlock } from './codec.js';
import { IOSTAT_COLS, summaryOf, aggregateIostat, timeAverageIostat, TOP_N } from './rates.js';
import { createYielder } from '../util/timeSlice.js';
import { pushAll } from '../util/pushAll.js';

export const WINDOWS = Object.freeze([1, 5, 10, 30]);
export const MAX_POINTS = 150;
export const OVERVIEW_POINTS = 90;
const LRU_MAX = 600;
const lru = new Map();

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/** 구간 정규화. end 가 지금에 가까우면(2초 안) 최근 구간으로 본다. */
export function normWindow({ win, end } = {}, now = Date.now()) {
  const w = WINDOWS.includes(Number(win)) ? Number(win) : 5;
  let e = end == null || end === '' ? null : Number(end);
  if (e != null && (!Number.isFinite(e) || e > now - 2_000)) e = null;
  if (e != null && e < now - 120 * 86_400_000) e = now - 120 * 86_400_000;
  const to = e ?? now;
  return { win: w, end: e, from: to - w * 60_000, to, past: e != null };
}

/** 묶음 읽기 도우미 — 열린 묶음(배열)과 닫힌 묶음(Float32 · NaN = null)을 같은 모양으로 읽는다. */
function val(b, key, i) {
  const a = b.cols.get(key);
  if (!a) return null;
  const x = a[i];
  return x == null || Number.isNaN(x) ? null : x;
}

function freezeDecoded(b) {
  const cols = new Map();
  for (const [k, arr] of b.cols) { const f = new Float32Array(arr.length); for (let i = 0; i < arr.length; i++) f[i] = arr[i] == null ? NaN : arr[i]; cols.set(k, f); }
  return { minute: b.minute, ts: Float64Array.from(b.ts), cols, meta: b.meta };
}

/** 대상 하나의 [from, to] 묶음들(시각 순). { blocks, partial } — DB 를 못 열었으면 partial. */
export async function blocksFor(id, from, to) {
  const fromMin = Math.floor(from / 60_000); const toMin = Math.floor(to / 60_000);
  const mem = store.memBlocks(id).filter((b) => b.minute >= fromMin && b.minute <= toMin);
  const memOldest = store.memOldestMinute(id);
  const needDbTo = memOldest == null ? toMin : Math.min(toMin, memOldest - 1);
  let dbBlocks = []; let partial = false;
  if (needDbTo >= fromMin) {
    const missing = [];
    for (let m = fromMin; m <= needDbTo; m++) { const hit = lru.get(`${id}|${m}`); if (hit) dbBlocks.push(hit); else missing.push(m); }
    if (missing.length) {
      const rows = await db.readMetric(id, missing[0], missing[missing.length - 1], 2000);
      if (rows == null) partial = true;
      for (const r of rows || []) {
        const d = decodeBlock(r.data);
        if (!d) continue;
        const f = freezeDecoded(d);
        lru.set(`${id}|${r.minute}`, f);
        if (lru.size > LRU_MAX) lru.delete(lru.keys().next().value);
        dbBlocks.push(f);
      }
    }
    dbBlocks = dbBlocks.filter((b) => b.minute >= fromMin && b.minute <= needDbTo);
  }
  const blocks = [...dbBlocks, ...mem].sort((a, b) => a.minute - b.minute);
  return { blocks, partial };
}

/** [from, to] 안의 (블록, 인덱스) 위치들. */
function positions(blocks, from, to) {
  const out = [];
  for (const b of blocks) for (let i = 0; i < b.ts.length; i++) { const t = b.ts[i]; if (t >= from && t <= to) out.push([b, i, t]); }
  return out;
}

/** 수집 공백으로 보는 틈 — 이보다 긴 표본 간격은 칸 폭 계산에서 뺀다(그 구간은 비워 둔다). */
export const GAP_MS = 60_000;
/**
 * 표본 간격(ms) — 60초 이하 간격들의 **90번째 백분위수**(큰 쪽). 표본이 2개 미만이면 null.
 * v2.977: 중앙값이었을 때 '계속 수집' 이 보는 화면이 없어 10초로 낮췄다가 2초로 돌아오면 칸 폭이 2초 기준이 돼 10초 구간의 선이 점으로 끊겼다
 * (시험 포탈에서 발견). 큰 쪽 간격으로 칸을 잡으면 촘촘한 구간은 평균으로 묶일 뿐 선이 끊기지 않는다.
 */
export function sampleSpacing(pos) {
  if (!pos || pos.length < 2) return null;
  const d = [];
  for (let i = 1; i < pos.length; i++) { const x = pos[i][2] - pos[i - 1][2]; if (x > 0 && x <= GAP_MS) d.push(x); }
  if (!d.length) return null;
  d.sort((a, b) => a - b);
  return d[Math.min(d.length - 1, Math.floor(d.length * 0.9))];
}

/**
 * 칸 나누기 — 칸마다 평균 · 최고 · 표본 수. 값이 없는 칸은 null(선이 끊긴다).
 * 칸 폭은 **표본 간격의 1.5배 이상**으로 넓힌다(칸 수를 줄인다) — 칸 폭이 수집 주기와 같거나 좁으면 표본이 칸 경계를 비켜 갈 때마다
 * 빈 칸이 생겨 '수집하지 않은 시간' 처럼 선이 끊겼다(2026-11-11 화면 검증 — 1분 구간 150칸은 2초 주기에서 칸 대부분이 비었다).
 * 칸 수가 바뀌어도 [from, to] 전체를 고르게 덮으므로 화면은 배열 길이로 x 를 나눈다.
 */
export function bucketize(pos, key, from, to, points, { fixed = false } = {}) {
  const n = fixed ? Math.max(1, points) : pointsFor(pos, from, to, points);
  const step = (to - from) / n;
  const sum = new Float64Array(n); const cnt = new Uint16Array(n); const mx = new Array(n).fill(null);
  for (const [b, i, t] of pos) {
    const v = val(b, key, i);
    if (v == null) continue;
    const k = Math.min(n - 1, Math.max(0, Math.floor((t - from) / step)));
    sum[k] += v; cnt[k] += 1;
    if (mx[k] == null || v > mx[k]) mx[k] = v;
  }
  const avg = new Array(n); for (let k = 0; k < n; k++) avg[k] = cnt[k] ? r2(sum[k] / cnt[k]) : null;
  return { avg, max: mx.map(r2) };
}

/** 한 서버의 칸 수 — 칸 폭이 표본 간격의 1.5배 이상이 되게(bucketize 규칙). 간격을 모르면 points. */
export function pointsFor(pos, from, to, points) {
  const sp = sampleSpacing(pos);
  return Math.max(1, sp ? Math.min(points, Math.max(2, Math.floor((to - from) / (sp * 1.5)))) : points);
}

/**
 * 여러 서버(장치)를 한 화면에서 비교할 때 쓰는 **공통 칸 수** — 가장 성긴 표본 간격에 맞춘다(v2.979 사용자 질문 '같은 길이에 칸이 더 촘촘한 건 왜' —
 * 서버마다 칸 수를 따로 정해 2초로 수집한 서버만 150칸, 10초 서버는 40칸이라 서버 × 시간 칸이 위아래로 맞지 않았다).
 * 촘촘한 서버는 넓은 칸 안에서 평균으로 묶인다. 표본이 없는 서버는 칸 수에 끼지 않는다.
 */
export function commonPoints(posList, from, to, points) {
  let n = points;
  for (const pos of posList) if (pos && pos.length >= 2) n = Math.min(n, pointsFor(pos, from, to, points));
  return n;
}

/** 열에서 표본 하나를 되살린다(메타 + 열). 표 · 요약이 이 모양을 쓴다. */
export function sampleAt(b, i) {
  if (!b) return null;
  const meta = b.meta || { net: {}, dsk: {} };
  const g = (k) => val(b, k, i);
  const cores = [];
  for (let c = 0; c < 1024; c++) { if (!b.cols.has(`c.k${c}`)) break; cores.push(g(`c.k${c}`)); }
  const cpu = g('c.pct') == null ? null : { pct: g('c.pct'), usr: g('c.usr'), sys: g('c.sys'), iow: g('c.iow'), stl: g('c.stl'), irq: g('c.irq'), cores };
  const mem = g('m.pct') == null ? null : { pct: g('m.pct'), total: g('m.total'), used: g('m.used'), avail: g('m.avail'), bc: g('m.bc'), free: g('m.free'), swT: g('m.swT'), swU: g('m.swU'), dirty: g('m.dirty'), slab: g('m.slab') };
  const net = Object.entries(meta.net || {}).map(([n, m]) => ({ n, ...m, rx: g(`n.${n}.rx`), tx: g(`n.${n}.tx`), u: g(`n.${n}.u`), er: g(`n.${n}.er`), dr: g(`n.${n}.dr`) }));
  const dsk = Object.entries(meta.dsk || {}).map(([n, m]) => {
    const v = IOSTAT_COLS.map((c) => g(`d.${n}.${c}`));
    const fl = g(`d.${n}.fl`);
    const stuck = v[2] === 0 && v[3] === 0 && fl > 0 && v[12] != null && v[12] >= 99.5;
    return { n, ...m, v, fl, ...(stuck ? { stuck: true } : {}) };
  });
  const dtot = b.cols.has('t.util') ? IOSTAT_COLS.map((c) => g(`t.${c}`)) : null;
  return { ts: b.ts[i], cpu, mem, net, dsk, dtot, load: [g('l.1'), g('l.5'), g('l.15')], run: g('l.run'), blk: g('l.blk') };
}

function lastPos(pos) { return pos.length ? pos[pos.length - 1] : null; }

/**
 * 표본마다 덮는 시간(ms) — 표본 값은 '앞 표본부터 이 표본까지' 의 비율이므로 무게 = 앞 표본과의 간격(v2.979 반증 1).
 * 수집 공백(GAP_MS 초과)이나 구간의 첫 표본은 앞 간격을 모르므로 표본 간격(sampleSpacing — 없으면 다음 간격 · 그것도 없으면 2초)으로 둔다.
 */
export function sampleWeights(pos) {
  const n = pos.length;
  if (!n) return [];
  const fb = sampleSpacing(pos) ?? 2_000;
  const ok = (g) => g > 0 && g <= GAP_MS;
  const w = new Array(n);
  for (let k = 0; k < n; k++) {
    const g = k > 0 ? pos[k][2] - pos[k - 1][2] : (n > 1 ? pos[1][2] - pos[0][2] : 0);
    w[k] = ok(g) ? g : fb;
  }
  return w;
}

/** 구간 평균 표본(표용) — 시간 가중(v2.979). coverMs = 평균이 덮는 시간(화면이 '30분 중 12분' 처럼 말하게). */
function averageSample(pos) {
  if (!pos.length) return null;
  const last = sampleAt(pos[pos.length - 1][0], pos[pos.length - 1][1]);
  const ws = sampleWeights(pos);
  const mean = (key) => { let s = 0; let n = 0; pos.forEach(([b, i], k) => { const v = val(b, key, i); if (v != null) { s += v * ws[k]; n += ws[k]; } }); return n ? r2(s / n) : null; };
  const sum = (key) => { let s = 0; let n = 0; for (const [b, i] of pos) { const v = val(b, key, i); if (v != null) { s += v; n += 1; } } return n ? s : null; };
  const out = { ...last, avg: true, coverMs: ws.reduce((a, x) => a + x, 0) };
  if (last.cpu) for (const k of ['pct', 'usr', 'sys', 'iow', 'stl', 'irq']) out.cpu = { ...out.cpu, [k]: mean(`c.${k}`) };
  if (last.cpu) out.cpu.cores = last.cpu.cores.map((_, c) => mean(`c.k${c}`));
  if (last.mem) for (const k of ['pct', 'used', 'avail', 'bc', 'free', 'swU', 'dirty', 'slab']) out.mem = { ...out.mem, [k]: mean(`m.${k}`) };
  out.net = last.net.map((x) => ({ ...x, rx: mean(`n.${x.n}.rx`), tx: mean(`n.${x.n}.tx`), u: mean(`n.${x.n}.u`), er: sum(`n.${x.n}.er`), dr: sum(`n.${x.n}.dr`) }));
  out.dsk = last.dsk.map((d) => {
    const rows = pos.map(([b, i]) => (b.cols.has(`d.${d.n}.util`) ? IOSTAT_COLS.map((c) => val(b, `d.${d.n}.${c}`, i)) : null));
    const v = timeAverageIostat(rows, ws);
    return { ...d, v, stuck: undefined, fl: mean(`d.${d.n}.fl`) };
  });
  const phys = out.dsk.filter((d) => d.k === 'disk');
  out.dtot = phys.length ? aggregateIostat(phys) : null;
  out.load = [mean('l.1'), mean('l.5'), mean('l.15')];
  return out;
}

/** 표본 → 요약(개요 카드). 같은 판정 함수(rates.summaryOf) 하나. */
const summarize = (s) => (s ? summaryOf(s) : null);

/* ── 보기 ─────────────────────────────────────────────────────────────────── */

/** 개요 — 서버마다 4줄(CPU · 메모리 · 네트워크 · 디스크) + 끝 값 · 요약. */
export async function overview(ids, w) {
  const y = createYielder(15);
  const out = []; let partial = false;
  for (const id of ids) {
    const { blocks, partial: p } = await blocksFor(id, w.from, w.to);
    partial = partial || p;
    const pos = positions(blocks, w.from, w.to);
    const lp = lastPos(pos);
    const last = lp ? sampleAt(lp[0], lp[1]) : null;
    const series = {};
    for (const [k, key] of [['cpu', 's.cpu'], ['mem', 's.mem'], ['net', 's.net'], ['disk', 's.disk']]) series[k] = bucketize(pos, key, w.from, w.to, OVERVIEW_POINTS).avg;
    out.push({ id, n: pos.length, lastAt: lp ? lp[2] : null, sum: summarize(last), series });
    await y();
  }
  return { targets: out, partial, points: OVERVIEW_POINTS };
}

/** 비교 항목 → 시리즈 이름. scope: 'all' | 'mount:<경로>' | 'dev:<장치>' · 네트워크는 'top' | 'if:<이름>'. */
export function seriesKeyFor(metric, item, scope, meta) {
  if (metric === 'cpu') return ['pct', 'usr', 'sys', 'iow', 'stl'].includes(item) ? `c.${item}` : 'c.pct';
  if (metric === 'mem') return item === 'swU' ? 'm.swU' : 'm.pct';
  if (metric === 'net') {
    const it = ['rx', 'tx', 'u', 'er', 'dr'].includes(item) ? item : 'u';
    const m = /^if:(.{1,32})$/.exec(String(scope || ''));
    if (m) return `n.${m[1]}.${it}`;
    return it === 'u' ? 's.net' : it === 'rx' ? 's.rx' : it === 'tx' ? 's.tx' : null;
  }
  if (metric === 'disk') {
    const col = IOSTAT_COLS.includes(item) ? item : 'wAwait';
    const sc = String(scope || 'all');
    if (sc === 'all') return `t.${col}`;
    const dm = /^dev:([A-Za-z0-9_.!:+-]{1,64})$/.exec(sc);
    if (dm) return `d.${dm[1]}.${col}`;
    const mm = /^mount:(\/[^\0]{0,199})$/.exec(sc);
    if (mm && meta?.dsk) { const hit = Object.entries(meta.dsk).find(([, d]) => d.mp === mm[1]); return hit ? `d.${hit[0]}.${col}` : null; }
    return null;
  }
  return null;
}

/** 지표 비교 — 서버마다 한 줄(칸 평균 · 최고) + 끝 값 · 순위. */
export async function compare(ids, w, { metric = 'cpu', item = 'pct', scope = 'all' } = {}) {
  const y = createYielder(15);
  const rows = []; let partial = false;
  for (const id of ids) {
    const { blocks, partial: p } = await blocksFor(id, w.from, w.to);
    partial = partial || p;
    const meta = blocks.length ? blocks[blocks.length - 1].meta : null;
    const key = seriesKeyFor(metric, item, scope, meta);
    rows.push({ id, key, blocks, pos: key ? positions(blocks, w.from, w.to) : [] });
    await y();
  }
  // 모든 서버가 같은 칸(시각)을 쓴다 — 서버 × 시간 칸이 위아래로 맞고, CSV 의 시각 열(points)과 값 배열 길이가 같다.
  const points = commonPoints(rows.filter((r) => r.key).map((r) => r.pos), w.from, w.to, MAX_POINTS);
  const out = [];
  for (const { id, key, blocks, pos } of rows) {
    if (!key) { out.push({ id, key: null, avg: [], max: [], last: null, missing: 'no-series' }); continue; }
    const { avg, max } = bucketize(pos, key, w.from, w.to, points, { fixed: true });
    let last = null; let lastAt = null;
    for (let k = pos.length - 1; k >= 0; k--) { const v = val(pos[k][0], key, pos[k][1]); if (v != null) { last = r2(v); lastAt = pos[k][2]; break; } }
    out.push({ id, key, avg, max, last, lastAt, n: pos.length, ...(pos.length && !blocks.some((b) => b.cols.has(key)) ? { missing: 'no-series' } : {}) });
    await y();
  }
  return { targets: out, partial, points };
}

/** 서버 상세 — 차트 · 표(끝 순간 또는 구간 평균) · 고른 장치의 처리량 · 지연. */
export async function serverDetail(id, w, { at = 'end', dev = '' } = {}) {
  const { blocks, partial } = await blocksFor(id, w.from, w.to);
  const pos = positions(blocks, w.from, w.to);
  const lp = lastPos(pos);
  const table = at === 'avg' ? averageSample(pos) : (lp ? sampleAt(lp[0], lp[1]) : null);
  const meta = blocks.length ? blocks[blocks.length - 1].meta : null;
  const P = MAX_POINTS; const SP = 60;
  const chart = (key, pts = P) => bucketize(pos, key, w.from, w.to, pts).avg;
  const charts = {
    cpu: { usr: chart('c.usr'), sys: chart('c.sys'), iow: chart('c.iow'), stl: chart('c.stl') },
    mem: chart('m.pct'), load: chart('l.1'),
    net: Object.keys(meta?.net || {}).slice(0, 64).map((n) => ({ n, rx: chart(`n.${n}.rx`, SP), tx: chart(`n.${n}.tx`, SP) })),
    dsk: Object.keys(meta?.dsk || {}).slice(0, 256).map((n) => ({ n, wAwait: chart(`d.${n}.wAwait`, SP) })),
  };
  let pick = /^[A-Za-z0-9_.!:+-]{1,64}$/.test(String(dev)) && meta?.dsk?.[dev] ? dev : null;
  if (!pick && table?.dsk?.length) {
    let best = null; for (const d of table.dsk) if (d.k === 'disk' && d.v[12] != null && (best == null || d.v[12] > best.v[12])) best = d;
    pick = best?.n || null;
  }
  const devChart = pick ? { n: pick, rMB: chart(`d.${pick}.rMB`), wMB: chart(`d.${pick}.wMB`), rAwait: chart(`d.${pick}.rAwait`), wAwait: chart(`d.${pick}.wAwait`) } : null;
  return { id, n: pos.length, firstAt: pos.length ? pos[0][2] : null, lastAt: lp ? lp[2] : null, coverMs: table?.coverMs ?? null, at, table, summary: summarize(table), charts, dev: devChart, points: P, sparkPoints: SP, partial, hello: store.helloOf(id) };
}

/** iostat 비교 — 고른 서버들의 장치 줄(13칸) + 차트에 올린 줄(최대 4) 추이. */
export async function iostatCompare(ids, w, { at = 'end', scope = 'phys', col = 'wAwait', pins = [] } = {}) {
  const y = createYielder(15);
  const rows = []; let partial = false;
  const posBy = new Map();
  for (const id of ids) {
    const { blocks, partial: p } = await blocksFor(id, w.from, w.to);
    partial = partial || p;
    const pos = positions(blocks, w.from, w.to);
    posBy.set(id, pos);
    const lp = lastPos(pos);
    const s = at === 'avg' ? averageSample(pos) : (lp ? sampleAt(lp[0], lp[1]) : null);
    const dsk = (s?.dsk || []).filter((d) => scope === 'all' || d.k === 'disk');
    rows.push({ id, lastAt: lp ? lp[2] : null, total: s?.dtot || null, devices: dsk.map((d) => ({ n: d.n, dn: d.dn || null, k: d.k, p: d.p || null, mp: d.mp || '', v: d.v, fl: d.fl ?? null, ...(d.stuck ? { stuck: true } : {}) })) });
    await y();
  }
  const c = IOSTAT_COLS.includes(col) ? col : 'wAwait';
  const series = [];
  const picked = [];
  for (const pin of (Array.isArray(pins) ? pins : []).slice(0, 4)) {
    const m = /^([a-z0-9-]{1,40})\/([A-Za-z0-9_.!:+-]{1,64})$/.exec(String(pin));
    if (m && posBy.has(m[1])) picked.push(m);
  }
  // 고정한 장치 선(최대 4)도 같은 칸 — 서버마다 수집 주기가 달라도 같은 시각끼리 비교한다(v2.979).
  const points = commonPoints(picked.map((m) => posBy.get(m[1])), w.from, w.to, MAX_POINTS);
  for (const m of picked) {
    const { avg, max } = bucketize(posBy.get(m[1]), `d.${m[2]}.${c}`, w.from, w.to, points, { fixed: true });
    series.push({ pin: `${m[1]}/${m[2]}`, avg, max });
  }
  return { rows, col: c, series, partial, points };
}

/* ── 프로세스 ─────────────────────────────────────────────────────────────── */

/** 이름 묶음 열쇠 — 숫자 덩어리를 `*` 로(ora_p001_ORCL · ora_p007_ORCL → ora_p*_ORCL). */
export const groupNameOf = (c) => String(c || '').replace(/\d+/g, '*').slice(0, 64);

async function procSnaps(id, from, to) {
  const fromMin = Math.floor(from / 60_000); const toMin = Math.floor(to / 60_000);
  const mem = store.memProcs(id);
  const memMins = [...mem.keys()];
  const memOldest = memMins.length ? Math.min(...memMins) : null;
  const snaps = [];
  const needTo = memOldest == null ? toMin : Math.min(toMin, memOldest - 1);
  if (needTo >= fromMin) {
    const rows = await db.readProc(id, fromMin, needTo, 120);
    for (const r of rows || []) for (const s of decodeProcBlock(r.data) || []) snaps.push(s);
  }
  for (const [m, list] of mem) if (m >= fromMin && m <= toMin) for (const s of list) snaps.push(s);
  return snaps.filter((s) => s && s.t >= from && s.t <= to).sort((a, b) => a.t - b.t);
}

/**
 * 프로세스 상위 30 — 서버별 · 통합 · 이름별 묶음. at = 'end'(구간 끝 표본) | 'avg'(구간 평균 — 상위 30에 들지 않은 표본은 0 으로 셈).
 * maskUser(u) — 비관리자 판본이면 사용자 이름을 가림 토큰으로(라우트가 넘긴다).
 */
export async function procs(ids, w, { at = 'end', maskUser = (u) => u } = {}) {
  const y = createYielder(15);
  const per = []; const all = [];
  for (const id of ids) {
    const snaps = await procSnaps(id, w.from, w.to);
    let list = []; let total = null; let lastAt = null;
    if (snaps.length) {
      if (at === 'avg') {
        // 시간 가중(v2.979 — 표 평균과 같은 규칙): 스냅샷마다 앞 스냅샷과의 간격으로 무게를 준다. 상위 목록에 없던 스냅샷은 0 으로 센다(예전과 같다).
        const ws = sampleWeights(snaps.map((s) => [null, null, Number(s.t)]));
        const W = ws.reduce((a, x) => a + x, 0) || 1;
        const acc = new Map();
        snaps.forEach((s, k) => { for (const p of s.top || []) {
          const key = `${p.pid}|${p.sk ?? ''}|${p.c}`; // v2.981 반증 F8: 시작 tick 까지 — pid 를 다시 쓴 같은 이름 작업자를 한 줄로 섞지 않는다(세부 정보와 같은 열쇠)
          const a = acc.get(key) || { ...p, cpuSum: 0 };
          a.cpuSum += (p.cpu ?? 0) * ws[k]; a.rss = p.rss; a.th = p.th; a.et = p.et; a.u = p.u;
          acc.set(key, a);
        } });
        list = [...acc.values()].map((a) => ({ ...a, cpu: r2(a.cpuSum / W), sh: null, cpuSum: undefined }));
        list.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0));
        list = list.slice(0, TOP_N);
      } else {
        list = (snaps[snaps.length - 1].top || []).slice(0, TOP_N);
      }
      total = snaps[snaps.length - 1].n ?? null; lastAt = snaps[snaps.length - 1].t;
    }
    const rows = list.map((p) => ({ pid: p.pid, c: p.c, u: p.u ? maskUser(p.u) : null, cpu: p.cpu ?? null, sh: p.sh ?? null, rss: p.rss ?? null, th: p.th ?? null, et: p.et ?? null, sk: p.sk ?? null }));
    per.push({ id, total, lastAt, snaps: snaps.length, top: rows });
    for (const r of rows) all.push({ id, ...r });
    await y();
  }
  all.sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || String(a.id).localeCompare(String(b.id)));
  const groups = new Map();
  for (const r of all) {
    const g = groupNameOf(r.c);
    const x = groups.get(g) || { name: g, cpu: 0, procs: 0, servers: new Set() };
    x.cpu += r.cpu ?? 0; x.procs += 1; x.servers.add(r.id);
    groups.set(g, x);
  }
  const grp = [...groups.values()].map((x) => ({ name: x.name, cpu: r2(x.cpu), procs: x.procs, servers: [...x.servers] })).sort((a, b) => b.cpu - a.cpu).slice(0, 30);
  return { at, per, top: all.slice(0, TOP_N), groups: grp };
}

/**
 * 프로세스 세부 정보(v2.981 — 사용자 '프로세스를 클릭하면 어떤 프로세스인지 · 네트워크 · 디스크 · CPU' · 시안 ⑩).
 * 한 서버의 한 프로세스(pid + 시작 tick sk — pid 재사용을 가른다. sk 가 없는 옛 표본은 pid 만)를 구간 안의 상위 30 스냅샷에서 찾는다.
 *  · 상위 30 밖이었던 스냅샷은 **비운다**(그 프로세스 값을 모른다 — 0 이 아니다) · 덮은 시간(cover)으로 그 사실을 말한다.
 *  · 서버 전체 네트워크(s.rx · s.tx)는 같은 칸으로 **참고** — 리눅스는 프로세스별 네트워크 바이트를 /proc 에 남기지 않는다.
 *  · 같은 이름: 마지막 스냅샷 안의 같은 comm(상위 30 안의 것만) + 전체 수(ns).
 * 없으면 null(라우트 404).
 */
export async function procDetail(id, w, { pid, sk = null, maskUser = (u) => u } = {}) {
  const snaps = await procSnaps(id, w.from, w.to);
  const match = (p) => p && p.pid === pid && (sk == null || p.sk == null || p.sk === sk);
  const hits = snaps.map((s) => ({ t: Number(s.t), p: (s.top || []).find(match) || null, s }));
  let last = null; for (const h of hits) if (h.p) last = h;
  if (!last) return null;
  const pos = hits.map((h) => [null, null, h.t]);
  const points = pointsFor(pos, w.from, w.to, 60);
  const step = (w.to - w.from) / points;
  const KEYS = ['cpu', 'us', 'sy', 'rss', 'io', 'rb', 'wb', 'mf'];
  const sum = Object.fromEntries(KEYS.map((k) => [k, new Float64Array(points)]));
  const cnt = Object.fromEntries(KEYS.map((k) => [k, new Uint16Array(points)]));
  for (const h of hits) {
    if (!h.p) continue;
    const b = Math.min(points - 1, Math.max(0, Math.floor((h.t - w.from) / step)));
    for (const k of KEYS) { const v = h.p[k]; if (isNum(v)) { sum[k][b] += v; cnt[k][b] += 1; } }
  }
  const series = Object.fromEntries(KEYS.map((k) => [k, Array.from(sum[k], (v, i) => (cnt[k][i] ? r2(v / cnt[k][i]) : null))]));
  // 구간 값 — 시간 가중(v2.979 와 같은 무게). 상위 30 에 든 시간만 평균에 넣고, 든 시간 · 전체 시간을 따로 준다.
  const ws = sampleWeights(pos);
  let inTop = 0; let total = 0;
  const acc = Object.fromEntries(KEYS.map((k) => [k, [0, 0]]));
  let maxCpu = null;
  hits.forEach((h, i) => {
    total += ws[i];
    if (!h.p) return;
    inTop += ws[i];
    for (const k of KEYS) { const v = h.p[k]; if (isNum(v)) { acc[k][0] += v * ws[i]; acc[k][1] += ws[i]; } }
    if (isNum(h.p.cpu) && (maxCpu == null || h.p.cpu > maxCpu)) maxCpu = h.p.cpu;
  });
  const avg = Object.fromEntries(KEYS.map((k) => [k, acc[k][1] ? r2(acc[k][0] / acc[k][1]) : null]));
  const p = last.p;
  const info = {
    pid: p.pid, c: p.c, u: p.u ? maskUser(p.u) : null, sk: p.sk ?? null, pp: p.pp ?? null, pc: p.pc ?? null, sv: p.sv ?? null,
    ni: p.ni ?? null, st: p.st ?? null, th: p.th ?? null, et: p.et ?? null, rss: p.rss ?? null, vsz: p.vsz ?? null, ns: p.ns ?? null,
    cpu: p.cpu ?? null, sh: p.sh ?? null, us: p.us ?? null, sy: p.sy ?? null, io: p.io ?? null, rb: p.rb ?? null, wb: p.wb ?? null, mf: p.mf ?? null,
  };
  const top = (last.s.top || []);
  const rank = top.indexOf(p) + 1;
  const sameList = top.filter((x) => x.c === p.c).slice(0, 10).map((x) => ({ pid: x.pid, u: x.u ? maskUser(x.u) : null, cpu: x.cpu ?? null, rss: x.rss ?? null, sk: x.sk ?? null, self: x === p }));
  // 서버 전체 네트워크(참고) — 같은 칸 수로
  const { blocks, partial } = await blocksFor(id, w.from, w.to);
  const npos = positions(blocks, w.from, w.to);
  const net = { rx: bucketize(npos, 's.rx', w.from, w.to, points, { fixed: true }).avg, tx: bucketize(npos, 's.tx', w.from, w.to, points, { fixed: true }).avg };
  // 디스크 대기를 아는지: 그 스냅샷의 da(엣지 · 수집기가 실은 값) → 없으면 HELLO
  const da = typeof last.s.da === 'boolean' ? last.s.da : (store.helloOf(id)?.dacct ?? null);
  return {
    id, pid: p.pid, sk: p.sk ?? null, lastAt: last.t, rank: rank > 0 ? rank : null, total: last.s.n ?? null,
    info, points, series, avg, max: { cpu: maxCpu }, cover: { inTopMs: Math.round(inTop), totalMs: Math.round(total), snaps: hits.length, hits: hits.filter((h) => h.p).length },
    same: { total: p.ns ?? sameList.length, list: sameList }, net, netPartial: partial, da,
  };
}

/* ── 기록이 있는 시간 ──────────────────────────────────────────────────────── */

/** 분 목록 → [[시작 분, 끝 분], …](이어진 구간). */
export function toRanges(minutes) {
  const s = [...new Set(minutes)].sort((a, b) => a - b);
  const out = [];
  for (const m of s) { const last = out[out.length - 1]; if (last && m === last[1] + 1) last[1] = m; else out.push([m, m]); }
  return out;
}

export async function coverage(ids, from, to) {
  const fromMin = Math.floor(from / 60_000); const toMin = Math.floor(to / 60_000);
  const all = [];
  let dbOk = true;
  for (const id of ids) {
    const mins = await db.coverage(id, fromMin, toMin);
    if (mins == null) dbOk = false; else pushAll(all, mins);
    for (const b of store.memBlocks(id)) if (b.minute >= fromMin && b.minute <= toMin) all.push(b.minute);
  }
  const oldest = await db.oldestMinute();
  return { from, to, ranges: toRanges(all), dbOk, oldestMinute: oldest };
}

export function _resetForTest() { lru.clear(); }
export { isNum as _isNum };
