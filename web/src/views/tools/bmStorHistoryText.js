/**
 * views/tools/bmStorHistoryText.js — 베어메탈 스토리지 디스크 사용량 **추이 차트**의 판정·좌표·문구(순수, v2.635).
 *
 * 사용자 요청(2026-09-28): 서버·그룹·합계 사용량을 12시간마다 별도 DB 에 저장하고 1일/7일/1달/분기/반기 차트로 본다.
 *
 * ── 이 모듈이 막는 거짓 ─────────────────────────────────────────────────────
 *  ① **부분 합(일부 서버를 못 읽은 시점)은 선으로 잇지 않는다** — 속이 빈 점으로만 둔다. 이으면 못 읽은 서버만큼
 *     '사용량이 줄었다' 는 거짓 하락이 그려진다(v2.606 '부분은 하한' 규약).
 *  ② **기록이 없던 슬롯은 선을 끊는다** — 간격이 적재 간격의 1.5배를 넘으면 새 선이다(`roomTempView.sparkPath` 규약).
 *  ③ ⚠ `v == null` 을 먼저 본다(`numOrNull`) — `Number(null) === 0` 이라 결측이 0 바이트로 둔갑한다.
 *  ④ **y축은 0 부터** — 용량 차트를 데이터 범위에 맞추면 1% 변화가 절벽처럼 보인다.
 *  ⑤ **점이 1개면 선을 그리지 않는다**(점만 찍는다) — 한 점을 선으로 만들면 추세가 있는 것처럼 보인다.
 *  ⑥ 기간 앞부분이 비어 있는 이유를 단정하지 않는다 — 적재를 늦게 시작했는지 보존 기간에서 지워졌는지 모른다(v2.578 D1).
 */
import { numOrNull } from '../../numOrNull.js';

const n = numOrNull;
const pad = (v) => String(v).padStart(2, '0');
/** epoch ms → 한국 시각 'YYYY-MM-DD' 또는 'MM-DD HH:MM'(브라우저 시간대와 무관하게 +9시간). */
function kst(ts, withTime = false) {
  const d = new Date(Number(ts) + 9 * 3_600_000);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return withTime ? `${day.slice(5)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
}
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** 보기 종류 — 사용자 요청의 '서버별 · 그룹별 · 합' 세 축. */
export const MODES = Object.freeze([
  { key: 'total', label: '합계' },
  { key: 'group', label: '그룹별' },
  { key: 'server', label: '서버별' },
]);

/** 서버가 주지 않을 때의 기간 목록(서버 `HISTORY_PERIODS` 와 같은 값 — 서버 응답이 오면 그것을 쓴다). */
export const FALLBACK_PERIODS = Object.freeze([
  { key: '1d', label: '1일', days: 1 },
  { key: '7d', label: '7일', days: 7 },
  { key: '1m', label: '1달', days: 30 },
  { key: '3m', label: '분기', days: 91 },
  { key: '6m', label: '반기', days: 182 },
]);

/** 바이트 → TB/GB. 못 읽은 값은 '—'(단위를 붙이지 않는다 — v2.575 unitText 규약). */
export function bytesText(b) {
  const v = n(b);
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1024 ** 4) return `${(v / 1024 ** 4).toFixed(abs >= 100 * 1024 ** 4 ? 0 : 1)} TB`;
  if (abs >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(abs >= 100 * 1024 ** 3 ? 0 : 1)} GB`;
  if (abs >= 1024 ** 2) return `${Math.round(v / 1024 ** 2)} MB`;
  return `${Math.round(v)} B`;
}

/** 기간 변화 — 부호를 말로 붙인다(0 이면 '변화 없음'). */
export function changeText(b) {
  const v = n(b);
  if (v == null) return '—';
  if (v === 0) return '변화 없음';
  return `${v > 0 ? '+' : '−'}${bytesText(Math.abs(v))}`;
}

/** 사용률 — df 와 같은 정의 used/(used+avail). 분모 0 이면 null. */
export function pctOf(p) {
  const u = n(p?.usedBytes); const a = n(p?.availBytes);
  if (u == null || a == null || u + a <= 0) return null;
  return Math.round((u / (u + a)) * 1000) / 10;
}

/** 계열 요약 — 온전한 점만 쓴다(부분 합으로 변화를 계산하면 거짓 하락이 된다). */
export function summaryOf(series) {
  const pts = Array.isArray(series?.points) ? series.points : [];
  const full = pts.filter((p) => !p.partial && n(p.usedBytes) != null);
  const partial = pts.filter((p) => p.partial).length;
  const last = full.length ? full[full.length - 1] : null;
  const first = full.length ? full[0] : null;
  return {
    points: pts.length,
    full: full.length,
    partial,
    last,
    lastPct: last ? pctOf(last) : null,
    change: full.length >= 2 ? n(last.usedBytes) - n(first.usedBytes) : null,
    changeDays: full.length >= 2 ? (last.ts - first.ts) / DAY : null,
  };
}

/** y축 최댓값 — 용량 최대(없으면 사용량 최대)의 105%. 0 부터 시작한다(규칙 ④). */
export function yMaxOf(series) {
  let hi = 0;
  for (const p of series?.points || []) {
    const t = n(p.totalBytes); const u = n(p.usedBytes);
    if (t != null && t > hi) hi = t;
    if (u != null && u > hi) hi = u;
  }
  return hi > 0 ? hi * 1.05 : 1;
}

/**
 * 점 배열 → SVG path(공통 x 축 t0..t1). 온전한 점만 잇고, 간격이 gapMs 를 넘으면 끊는다.
 * @returns {{d:string, n:number, breaks:number}|null}  이을 점이 2개 미만이면 null(규칙 ⑤).
 */
export function pathFor(points, { t0, t1, w = 640, h = 150, yMax = 1, gapMs = 18 * HOUR, pick = 'usedBytes' } = {}) {
  const pts = (points || []).filter((p) => p && !p.partial && n(p[pick]) != null && Number.isFinite(Number(p.ts)));
  if (pts.length < 2) return null;
  const span = (t1 - t0) || 1;
  const x = (ts) => ((ts - t0) / span) * w;
  const y = (v) => h - (Math.min(yMax, Math.max(0, v)) / (yMax || 1)) * h;
  let d = ''; let prev = null; let breaks = 0;
  for (const p of pts) {
    const join = prev != null && p.ts - prev <= gapMs;
    if (prev != null && !join) breaks += 1;
    d += `${join ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(n(p[pick])).toFixed(1)} `;
    prev = p.ts;
  }
  return { d: d.trim(), n: pts.length, breaks };
}

/** 점 좌표(온전한 점은 채운 점, 부분 합은 속이 빈 점). */
export function dotsFor(points, { t0, t1, w = 640, h = 150, yMax = 1 } = {}) {
  const span = (t1 - t0) || 1;
  return (points || [])
    .filter((p) => n(p?.usedBytes) != null && Number.isFinite(Number(p.ts)) && p.ts >= t0 && p.ts <= t1)
    .map((p) => ({ x: ((p.ts - t0) / span) * w, y: h - (Math.min(yMax, Math.max(0, n(p.usedBytes))) / (yMax || 1)) * h, partial: !!p.partial, p }));
}

/** 선을 끊는 간격 — 적재 간격의 1.5배(기록이 빠진 슬롯이 하나라도 있으면 끊는다, 규칙 ②). */
export function gapMsFor(intervalHours) {
  const h = n(intervalHours);
  return (h != null && h > 0 ? h : 12) * HOUR * 1.5;
}

/** x축 눈금 — 한국 시각. 1일은 '일 시', 그 밖은 '월/일'. */
export function xTicksFor(t0, t1, days) {
  const a = n(t0); const b = n(t1);
  if (a == null || b == null || b <= a) return [];
  const count = 5;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const ts = a + ((b - a) * i) / (count - 1);
    const d = new Date(ts + 9 * HOUR);
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    out.push({ at: i / (count - 1), label: days <= 1 ? `${dd}일 ${hh}시` : `${mm}/${dd}` });
  }
  return out;
}

/** 기간·간격 안내 — '1일' 은 점이 적다는 사실을 말한다. */
export function pointsNote(period, intervalHours) {
  const h = n(intervalHours) || 12;
  const days = n(period?.days) || 7;
  const max = Math.floor((days * 24) / h) + 1;
  const base = `**${h}시간마다** 한 번 기록합니다(한국 시각 기준 슬롯) — 이 기간에는 계열마다 점이 **최대 ${max}개**입니다.`;
  return days <= 1 ? `${base} 1일 차트는 점이 적어 추세보다 **최근 두세 번의 기록**을 보여 줍니다.` : base;
}

/** 부분 합 안내 — 있을 때만. */
export function partialNote(count) {
  const c = n(count) || 0;
  if (c <= 0) return '';
  return `속이 빈 점 **${c}개**는 일부 서버를 못 읽은 시점의 **부분 합**입니다 — 실제보다 작을 수 있어 선으로 잇지 않았습니다.`;
}

/** 차트가 비었을 때 이유 — 한 문구로 덮지 않는다. */
export function emptyNote({ available = true, dbError = '', status = null, seriesCount = 0, mode = 'total' } = {}) {
  if (!available) return `이력 DB 를 열지 못했습니다 — ${dbError || '원인을 알 수 없습니다'}`;
  if (seriesCount > 0) return '';
  if (status?.idleReason) return `아직 기록이 없습니다 — ${status.idleReason}.`;
  if (mode === 'group') return '이 기간에 그룹 기록이 없습니다 — 서버에 그룹을 지정하면 다음 기록부터 쌓입니다.';
  const next = n(status?.nextSlotAt);
  const when = next ? ` 다음 기록 슬롯은 ${kst(next, true)}(KST) 입니다.` : '';
  return `이 기간에 기록이 없습니다 — 서버를 읽는 대로 현재 슬롯에 첫 기록을 남깁니다.${when}`;
}

/** 기간 앞부분이 비어 있을 때 — 원인을 단정하지 않는다(규칙 ⑥). */
export function spanNote(span, from, retentionDays) {
  const first = n(span?.first);
  const f = n(from);
  if (first == null || f == null || first <= f + 12 * HOUR) return '';
  const d = kst(first);
  const keep = n(retentionDays);
  return `가장 오래된 기록은 **${d}** 입니다 — 그 앞은 기록을 시작하기 전이거나 보존 기간(${keep ? `${keep}일` : '전부 보관'})에서 정리된 것입니다.`;
}
