/**
 * views/tools/focusMonChart.js — 집중 모니터링 차트 좌표(순수 · v2.976).
 *
 *  · 값이 없는 칸(null)은 선을 끊는다 — 0 으로 그리지 않는다.
 *  · 세로축은 값에 맞춰 잡는다(지연이 수 ms 인 서버와 수천 ms 인 서버가 섞이면 로그 눈금을 고를 수 있다 — 사용자가 보낸 iostat 에 3,076 ms 가 있었다).
 *  · 사용률(%) 차트는 0~100 고정(서버끼리 높낮이를 그대로 비교).
 */
import { numOrNull } from '../../numOrNull.js';

const n = numOrNull;

/** 보기 좋은 상한(1 · 2 · 2.5 · 5 · 10 × 10^k). 값이 없으면 1. */
export function niceMax(v) {
  const x = n(v);
  if (x == null || x <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 2.5, 5, 10]) if (x <= m * p) return m * p;
  return 10 * p;
}

/** 세로 눈금 함수. log=true 면 log10(1+v) 비례. */
export function yScale({ max, log = false, top, bottom }) {
  const M = Math.max(1e-9, max);
  if (log) {
    const lm = Math.log10(1 + M);
    return (v) => bottom - (Math.log10(1 + Math.max(0, Math.min(v, M))) / lm) * (bottom - top);
  }
  return (v) => bottom - (Math.max(0, Math.min(v, M)) / M) * (bottom - top);
}

/** 눈금 값들. 선형은 0 · 1/4 · … · max, 로그는 10^k. */
export function yTicks(max, log = false) {
  if (!log) return [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
  const out = [0];
  for (let k = 0; 10 ** k <= max * 1.0001 && k < 9; k++) out.push(10 ** k);
  return out;
}

/** 칸 배열 → SVG path(null 이면 끊는다). x0..x1 에 고르게. */
export function linePath(vals, { x0, x1, y }) {
  const L = Array.isArray(vals) ? vals.length : 0;
  if (!L) return '';
  const step = L > 1 ? (x1 - x0) / (L - 1) : 0;
  let d = ''; let pen = false;
  for (let i = 0; i < L; i++) {
    const v = n(vals[i]);
    if (v == null) { pen = false; continue; }
    d += `${pen ? 'L' : (d ? ' M' : 'M')}${(x0 + i * step).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** 아래를 채운 면(이어진 구간마다 닫는다). */
export function areaPath(vals, { x0, x1, y, base }) {
  const L = Array.isArray(vals) ? vals.length : 0;
  if (!L) return '';
  const step = L > 1 ? (x1 - x0) / (L - 1) : 0;
  let d = ''; let run = [];
  const flush = () => {
    if (run.length < 2) { run = []; return; }
    d += `M${run[0][0].toFixed(1)} ${base.toFixed(1)} ` + run.map(([x, yy]) => `L${x.toFixed(1)} ${yy.toFixed(1)}`).join(' ') + ` L${run[run.length - 1][0].toFixed(1)} ${base.toFixed(1)} Z `;
    run = [];
  };
  for (let i = 0; i < L; i++) {
    const v = n(vals[i]);
    if (v == null) { flush(); continue; }
    run.push([x0 + i * step, y(v)]);
  }
  flush();
  return d.trim();
}

/** 쌓은 면 — 층마다 아래 누적 위에. 칸 하나라도 null 이면 그 칸은 0 으로 쌓지 않고 끊는다. */
export function stackedAreas(layers, { x0, x1, y }) {
  const L = Math.max(0, ...layers.map((l) => (Array.isArray(l) ? l.length : 0)));
  const step = L > 1 ? (x1 - x0) / (L - 1) : 0;
  const acc = new Array(L).fill(0);
  const ok = new Array(L).fill(true);
  for (const l of layers) for (let i = 0; i < L; i++) if (n(l?.[i]) == null) ok[i] = false;
  return layers.map((l) => {
    const lo = acc.slice();
    for (let i = 0; i < L; i++) if (ok[i]) acc[i] += n(l[i]);
    let d = ''; let seg = [];
    const flush = () => {
      if (seg.length >= 2) {
        const top = seg.map((i) => `${(x0 + i * step).toFixed(1)} ${y(acc[i]).toFixed(1)}`);
        const bot = seg.slice().reverse().map((i) => `${(x0 + i * step).toFixed(1)} ${y(lo[i]).toFixed(1)}`);
        d += `M${top.join(' L')} L${bot.join(' L')} Z `;
      }
      seg = [];
    };
    for (let i = 0; i < L; i++) { if (ok[i]) seg.push(i); else flush(); }
    flush();
    return d.trim();
  });
}

/** 끝 이름표 — 겹치지 않게 아래로 민다(최소 간격 gap). [{key, y}] → {key: y}. */
export function spreadLabels(items, gap = 16) {
  const sorted = items.filter((x) => x.y != null).slice().sort((a, b) => a.y - b.y);
  const out = {}; let last = -Infinity;
  for (const it of sorted) { const y = Math.max(it.y, last + gap); out[it.key] = y; last = y; }
  return out;
}

/** 한 색 농담(어두움 → 밝음 14단). null 은 빈 칸 색. */
export const HEAT_RAMP = Object.freeze(['#17233b', '#0d366b', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb']);
export const HEAT_EMPTY = '#0a0e17';
export function heatColor(v, max, log = true) {
  const x = n(v);
  if (x == null) return HEAT_EMPTY;
  const M = Math.max(1e-9, max);
  const f = log ? Math.log10(1 + Math.max(0, x)) / Math.log10(1 + M) : Math.max(0, x) / M;
  return HEAT_RAMP[Math.max(0, Math.min(HEAT_RAMP.length - 1, Math.round(f * (HEAT_RAMP.length - 1))))];
}

/** 표 칸 바탕(그 열 최대 대비 로그 비율 — 큰 값 하나가 나머지를 지우지 않게). */
export function cellShade(v, colMax) {
  const x = n(v);
  if (x == null || x <= 0 || !(colMax > 0)) return '';
  const a = 0.04 + 0.42 * (Math.log(1 + x) / Math.log(1 + colMax));
  return `rgba(57,135,229,${a.toFixed(3)})`;
}

/** 시리즈들의 최대(null 무시). */
export function seriesMax(list) {
  let m = null;
  for (const a of list) for (const v of a || []) { const x = n(v); if (x != null && (m == null || x > m)) m = x; }
  return m;
}

/** x 좌표 → 칸 번호(마우스 오버). */
export function indexAt(px, { x0, x1, count }) {
  if (!(count > 0)) return null;
  if (count === 1) return 0;
  const i = Math.round(((px - x0) / (x1 - x0)) * (count - 1));
  return i < 0 || i >= count ? null : i;
}

/* ── 마우스 오버(툴팁) — v2.977 사용자 요청 ‘차트 툴팁’ ─────────────────────────── */

/** 그림 영역 안 비율(0~1) → 그 시리즈의 가장 가까운 칸 번호. 시리즈마다 칸 수가 다를 수 있다(표본 간격에 따라 bucketize 가 줄인다). */
export function indexAtFrac(f, len) {
  if (f == null || !Number.isFinite(f) || !(len > 0)) return null;
  return Math.round(Math.max(0, Math.min(1, f)) * (len - 1));
}
/** 비율 → 그 칸의 값(없으면 null — 0 아님). */
export function valueAtFrac(vals, f) {
  const i = indexAtFrac(f, Array.isArray(vals) ? vals.length : 0);
  return i == null ? null : n(vals[i]);
}
/** 칸 i 의 가운데 시각 — 서버 bucketize 는 [from, to] 를 len 칸으로 고르게 나눈다. */
export function timeAtIndex(i, len, from, to) {
  if (i == null || !(len > 0) || !(to > from)) return null;
  return from + ((i + 0.5) / len) * (to - from);
}
/** 칸 번호 → 그림 영역의 x(선 그리기와 같은 식 — linePath). */
export function xAtIndex(i, len, x0, x1) {
  if (i == null || !(len > 0)) return null;
  return len > 1 ? x0 + (i / (len - 1)) * (x1 - x0) : x0;
}
/**
 * 툴팁 줄 고르기 — 색을 준(고정한) 시리즈를 먼저 모두, 나머지는 그 시각 값이 큰 순으로 남은 자리만큼.
 * 값이 없는 시리즈는 뒤로(‘—’). [{key, label, color, vals, pinned}] → [{key, label, color, v}]
 */
export function tipRows(series, f, { limit = 8 } = {}) {
  const rows = series.map((s) => ({ key: s.key, label: s.label, color: s.color, pinned: !!s.pinned, v: valueAtFrac(s.vals, f) }));
  const by = (a, b) => (a.v == null) - (b.v == null) || (b.v ?? 0) - (a.v ?? 0);
  const pinned = rows.filter((r) => r.pinned).sort(by);
  const rest = rows.filter((r) => !r.pinned).sort(by).slice(0, Math.max(0, limit - pinned.length));
  return [...pinned, ...rest];
}
