/**
 * components/vmperf/vmPerfText.js — VM · ESXi 호스트 성능 화면(v2.911 · 시안 docs/design/vm-perf ②~④)의 **순수** 보조(vitest 고정).
 *   기간 · 지표 상수 · 값 글자 · 구간 통계 · 과거 창 계산(◀ 이전 · 슬라이더 · 날짜로 이동) · 차트 좌표 · CSV.
 *   규약: 못 읽은 점(null)은 0 이 아니다 — 통계 분모에서 빼고 선을 끊는다(v3.10.9: 쓰는 곳 없던 vmMetricStats 는 지웠다 — 판정은 여기 하나) · 값이 없으면 단위를 붙이지 않는다('—') ·
 *   보관 주기 · 과부하 기준 · 갱신 주기는 응답 값을 쓴다(화면에 숫자를 박지 않는다 — 여기 상수는 기본값 표시용이 아니라 창 길이뿐).
 */

export const RANGES = Object.freeze([
  { k: 'realtime', label: '실시간 1시간', ms: 3_600_000, nav: false },
  { k: 'day', label: '24시간', ms: 86_400_000, nav: true },
  { k: 'week', label: '7일', ms: 7 * 86_400_000, nav: true },
  { k: 'month', label: '30일', ms: 30 * 86_400_000, nav: true },
  { k: 'year', label: '1년', ms: 365 * 86_400_000, nav: false },
]);
export const RANGE_KEYS = Object.freeze(RANGES.map((r) => r.k));
export const rangeOf = (k) => RANGES.find((r) => r.k === k) || RANGES[1];

export const METRICS = Object.freeze([
  { k: 'cpu', label: 'CPU 사용률', short: 'CPU', unit: '%', color: '#3b82f6' },
  { k: 'mem', label: '메모리 사용률', short: '메모리', unit: '%', color: '#a855f7' },
  { k: 'disk', label: '디스크 I/O', short: '디스크', unit: 'KBps', color: '#22d3ee' },
  { k: 'net', label: '네트워크 I/O', short: '네트워크', unit: 'KBps', color: '#22c55e' },
]);
export const METRIC_KEYS = Object.freeze(METRICS.map((m) => m.k));
export const metricOf = (k) => METRICS.find((m) => m.k === k) || METRICS[0];

/** 겹쳐 보기 — 같은 단위끼리만(% 와 KBps 를 한 축에 두지 않는다). */
export const OVERLAYS = Object.freeze([
  { k: 'one', label: '한 지표', keys: null },
  { k: 'cpumem', label: 'CPU + 메모리', keys: ['cpu', 'mem'] },
  { k: 'disknet', label: '디스크 + 네트워크', keys: ['disk', 'net'] },
]);
/** 겹쳐 보기 키와 고른 지표로 실제로 그릴 지표 목록. */
export function chartKeys(overlay, metric) {
  const o = OVERLAYS.find((x) => x.k === overlay);
  return o && o.keys ? [...o.keys] : [METRIC_KEYS.includes(metric) ? metric : 'cpu'];
}

import { numOrNull } from '../../numOrNull.js'; // 결측 판정은 한 벌(audit2617 스윕 — 사본 금지)
const num = numOrNull;

/** KBps → KB/s · MB/s · GB/s (축 라벨이 짧게). */
export function fmtRate(kbps) {
  const v = num(kbps);
  if (v == null) return '—';
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} GB/s`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} MB/s`;
  return `${Math.round(v)} KB/s`;
}
/** 값 글자 — 결측은 단위 없이 '—'(v2.598 규약). % 는 소수 한 자리까지(정수면 그대로). */
export function fmtVal(v, unit) {
  const n = num(v);
  if (n == null) return '—';
  if (unit === 'KBps') return fmtRate(n);
  const r = Math.round(n * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)}${unit || ''}`;
}

/** 롤업(표본 간격 초) 글자 — 응답 `sampleSec` 그대로 말한다. */
export function rollupLabel(sec) {
  const s = num(sec);
  if (s == null) return '—';
  if (s === 20) return '20초';
  if (s === 300) return '5분 평균';
  if (s === 1800) return '30분 평균';
  if (s === 7200) return '2시간 평균';
  if (s === 86400) return '1일 평균';
  return s % 3600 === 0 ? `${s / 3600}시간 평균` : s % 60 === 0 ? `${s / 60}분 평균` : `${s}초 평균`;
}

const two = (n) => String(n).padStart(2, '0');
/** 'MM-DD HH:mm'(포탈 브라우저 시각). */
export function fmtClock(ms) {
  const n = num(ms);
  if (n == null) return '—';
  const d = new Date(n);
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
/** 'HH:mm'. */
export function fmtHm(ms) {
  const n = num(ms);
  if (n == null) return '—';
  const d = new Date(n);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}
/** 초 → '1시간 05분' · '35분' · '0분'. */
export function durText(sec) {
  const s = Math.max(0, Math.round(num(sec) ?? 0));
  const h = Math.floor(s / 3600); const m = Math.round((s % 3600) / 60);
  if (h > 0) return `${h}시간 ${two(m)}분`;
  return `${m}분`;
}

/**
 * 구간 통계 — 값이 있는 점만(결측은 분모에서 뺀다 · 하나도 없으면 전부 null). 최대 · 최저는 **시각도** 함께.
 * overloadPct 가 있으면 그 이상인 점의 수 × sampleSec = 과부하 지속 초(overSec) — % 지표에만 의미가 있다(호출자가 고른다).
 */
export function seriesStats(points, { overloadPct = null, sampleSec = null } = {}) {
  let sum = 0; let n = 0; let missing = 0;
  let max = null; let maxAt = null; let min = null; let minAt = null; let last = null; let over = 0;
  const th = num(overloadPct); const step = num(sampleSec);
  for (const p of points || []) {
    const v = num(p?.v);
    if (v == null) { missing += 1; continue; }
    n += 1; sum += v; last = v;
    if (max == null || v > max) { max = v; maxAt = p.t ?? null; }
    if (min == null || v < min) { min = v; minAt = p.t ?? null; }
    if (th != null && v >= th) over += 1;
  }
  if (!n) return { last: null, avg: null, max: null, maxAt: null, min: null, minAt: null, measured: 0, missing, overSec: null };
  return {
    last, avg: Math.round((sum / n) * 10) / 10, max, maxAt, min, minAt, measured: n, missing,
    overSec: th != null && step != null ? over * step : null,
  };
}

/**
 * ◀ 이전 구간으로 갈 수 있는 칸 수 — vCenter 보관 주기(응답 `retention` 초)에서 계산. 창이 보관 밖이면 vCenter 가 빈 답을 주므로
 * '그 창을 아직 보관하는 가장 거친 롤업으로도 점이 6개 이상' 인 범위까지만: 24시간 창은 2시간 평균(12점)까지 = 1달 보관 안 ·
 * 7일 · 30일 창은 1일 평균(7 · 30점)까지 = 1년 보관 안. 실시간 · 1년은 이동 없음. 보관 값을 모르면 0(지어내지 않는다).
 */
export function maxBackOf(rangeK, retention) {
  const r = rangeOf(rangeK);
  if (!r.nav) return 0;
  const keep = (k) => num(retention?.[k]);
  const lenSec = r.ms / 1000;
  const cover = rangeK === 'day' ? keep('month') : keep('year');
  if (cover == null || cover <= 0) return 0;
  return Math.max(0, Math.floor(cover / lenSec) - 1);
}

/**
 * 창(길이 ms 로) — anchorEnd 에서 back 칸 전. **공용 코어**(v2.923 — 베어메탈 추이 탭 · 확대 팝업이 같은 함수를 쓴다:
 * 그쪽 기간은 6시간 · 24시간 · 7일 · 30일이라 RANGES 키가 아니라 길이로 부른다 — 창 계산을 두 벌 두지 않는다).
 */
export function windowSpan(anchorEnd, back, spanMs) {
  const len = Math.max(1, num(spanMs) ?? 0);
  const b = Math.max(0, Math.floor(num(back) ?? 0));
  const end = (num(anchorEnd) ?? 0) - b * len;
  return { start: end - len, end };
}
/** 창 — anchorEnd(스크롤을 시작할 때의 창 끝) 에서 back 칸 전. back 0 = 최근(창 없음). */
export function windowOf(anchorEnd, back, rangeK) {
  return windowSpan(anchorEnd, back, rangeOf(rangeK).ms);
}
export function windowLabel(back, rangeK) {
  const b = Math.max(0, Math.floor(num(back) ?? 0));
  return b === 0 ? '최근 구간' : `${b}칸 전 (${rangeOf(rangeK).label} 단위)`;
}
export function windowRangeText(startMs, endMs) {
  if (num(startMs) == null || num(endMs) == null) return '';
  return `${fmtClock(startMs)} ~ ${fmtClock(endMs)}`;
}
/** '날짜로 이동' — 그 날짜(브라우저 시각)가 끝나는 시각(다음 날 0시)을 창 끝으로. 잘못된 날짜는 null. */
export function dateJumpEnd(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1, 0, 0, 0, 0);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}
/** 창 끝 → 날짜 input 값(그 창이 끝나는 날의 포탈 날짜). */
export function dateInputOf(endMs) {
  const n = num(endMs);
  if (n == null) return '';
  const d = new Date(n - 1);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}
/** 창 끝 ms → back 칸(길이 ms 로 · anchorEnd 기준 · 범위 밖은 잘라낸다) — windowSpan 의 짝(공용 코어). */
export function backForSpan(anchorEnd, endMs, spanMs, maxBack) {
  const len = Math.max(1, num(spanMs) ?? 0);
  const raw = Math.round(((num(anchorEnd) ?? 0) - (num(endMs) ?? 0)) / len);
  return Math.max(0, Math.min(Math.max(0, num(maxBack) ?? 0), raw));
}
/** 창 끝 ms → back 칸(anchorEnd 기준 · 범위 밖은 잘라낸다). */
export function backForEnd(anchorEnd, endMs, rangeK, maxBack) {
  return backForSpan(anchorEnd, endMs, rangeOf(rangeK).ms, maxBack);
}

/** % 지표는 0~100 고정 · KBps 는 최대값의 1.15배(0 이면 1)를 '보기 좋은' 수로 올린다. */
export function yMaxOf(unit, seriesList) {
  if (unit !== 'KBps') return 100;
  let m = 0;
  for (const pts of seriesList || []) for (const p of pts || []) { const v = num(p?.v); if (v != null && v > m) m = v; }
  if (m <= 0) return 1;
  const raw = m * 1.15;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * mag >= raw) || 10;
  return step * mag;
}

/** 시각 축 눈금 — 창 길이에 맞춰 4~6개 · 글자는 길이에 따라 HH:mm(하루 안) · MM-DD HH:mm(한 주) · MM-DD(그 밖). */
export function ticksOf(startMs, endMs, count = 5, { short = false } = {}) {
  const s = num(startMs); const e = num(endMs);
  if (s == null || e == null || e <= s) return [];
  const span = e - s;
  // short(좁은 화면): 하루 안은 HH:mm · 그 밖은 MM-DD 만(MM-DD HH:mm 은 400px 에서 겹친다 — v2.911 Chromium 확인).
  const fmt = span <= 86_400_000 * 1.5 ? fmtHm : (span <= 86_400_000 * 8 && !short) ? fmtClock : (ms) => fmtClock(ms).slice(0, 5);
  const out = [];
  for (let i = 0; i <= count; i++) {
    const ms = s + (span * i) / count;
    out.push({ ms, label: fmt(ms) });
  }
  return out;
}

/**
 * 차트 좌표 — 점은 시각으로 x 를 잡는다(창이 있으면 창 기준 · 없으면 첫~마지막 점). 결측(null)은 선을 끊는다(M 으로 다시 시작) ·
 * 값은 max 로 잘라 위로 넘치지 않게. 반환 pts 는 마우스 오버 상자가 쓴다(x · y · v · t).
 */
export function chartModel(points, { x0, x1, y0, y1, max, startMs = null, endMs = null } = {}) {
  const list = Array.isArray(points) ? points : [];
  const times = list.map((p) => num(Date.parse(p?.t)));
  const tMin = num(startMs) ?? Math.min(...times.filter((t) => t != null));
  const tMax = num(endMs) ?? Math.max(...times.filter((t) => t != null));
  const span = Number.isFinite(tMin) && Number.isFinite(tMax) && tMax > tMin ? tMax - tMin : null;
  const m = num(max) ?? 100;
  const pts = []; let d = ''; let pen = false;
  for (let i = 0; i < list.length; i++) {
    const v = num(list[i]?.v);
    const t = times[i];
    const x = span == null ? (list.length > 1 ? x0 + ((x1 - x0) * i) / (list.length - 1) : x0) : x0 + ((x1 - x0) * ((t ?? tMin) - tMin)) / span;
    if (v == null || t == null) { pen = false; pts.push({ x, y: null, v: null, t: list[i]?.t ?? null }); continue; }
    const y = y1 - ((y1 - y0) * Math.min(v, m)) / m;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
    pen = true;
    pts.push({ x, y, v, t: list[i].t });
  }
  return { path: d.trim(), pts, tMin: Number.isFinite(tMin) ? tMin : null, tMax: Number.isFinite(tMax) ? tMax : null };
}
/** 마우스 x(뷰박스 좌표)에 가장 가까운 점의 색인(값이 없는 점도 후보 — 상자가 '결측' 이라고 말한다). 점이 없으면 -1. */
export function hoverIndex(pts, x) {
  let best = -1; let dist = Infinity;
  for (let i = 0; i < (pts || []).length; i++) { const dx = Math.abs(pts[i].x - x); if (dx < dist) { dist = dx; best = i; } }
  return best;
}

/** CSV — 시각(ISO) + 지표 열(단위는 머리글에) · 결측은 빈 칸 · 쉼표 없는 수치뿐이라 따옴표 불필요. */
export function csvText(series, keys = METRIC_KEYS) {
  const ks = (keys || []).filter((k) => series?.[k]?.points);
  const head = ['time', ...ks.map((k) => `${k}(${series[k].unit || ''})`)].join(',');
  const byTime = new Map();
  for (const k of ks) for (const p of series[k].points) { if (!p?.t) continue; if (!byTime.has(p.t)) byTime.set(p.t, {}); byTime.get(p.t)[k] = num(p.v); }
  const rows = [...byTime.keys()].sort().map((t) => [t, ...ks.map((k) => (byTime.get(t)[k] == null ? '' : String(byTime.get(t)[k])))].join(','));
  return `${head}\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
}
/** 내려받을 파일 이름 — 이름의 경로 문자는 _ 로. */
export function csvFileName(name, rangeK, endMs) {
  const safe = String(name || 'entity').replace(/[^\w.-]+/g, '_').slice(0, 60);
  return `perf_${safe}_${rangeK}_${dateInputOf(endMs) || 'latest'}.csv`;
}
