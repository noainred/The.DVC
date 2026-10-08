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
  { key: 'total', label: '전체 합계' },
  { key: 'group', label: '그룹별 합산' },
  { key: 'server', label: '전체 서버' },
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

/** 점에서 그릴 값을 읽는 함수 — pick 이 키 문자열이면 그 필드, 함수면 그대로(v2.688: % 단위 선). */
const pickerOf = (pick) => (typeof pick === 'function' ? pick : (p) => n(p?.[pick]));
/** 값 → y 좌표(yMin~yMax 범위 밖은 가장자리로 자른다). yMin 기본 0(규칙 ④ — 확대 축만 0 이 아니다). */
const yOf = (v, h, yMin, yMax) => {
  const lo = n(yMin) ?? 0; const hi = n(yMax) ?? 1;
  const r = (hi - lo) || 1;
  return h - ((Math.min(hi, Math.max(lo, v)) - lo) / r) * h;
};

/**
 * 점 배열 → SVG path(공통 x 축 t0..t1). 온전한 점만 잇고, 간격이 gapMs 를 넘으면 끊는다.
 * @returns {{d:string, n:number, breaks:number}|null}  이을 점이 2개 미만이면 null(규칙 ⑤).
 */
export function pathFor(points, { t0, t1, w = 640, h = 150, yMin = 0, yMax = 1, gapMs = 18 * HOUR, pick = 'usedBytes' } = {}) {
  const val = pickerOf(pick);
  const pts = (points || []).filter((p) => p && !p.partial && val(p) != null && Number.isFinite(Number(p.ts)));
  if (pts.length < 2) return null;
  const span = (t1 - t0) || 1;
  const x = (ts) => ((ts - t0) / span) * w;
  let d = ''; let prev = null; let breaks = 0;
  for (const p of pts) {
    const join = prev != null && p.ts - prev <= gapMs;
    if (prev != null && !join) breaks += 1;
    d += `${join ? 'L' : 'M'}${x(p.ts).toFixed(1)},${yOf(val(p), h, yMin, yMax).toFixed(1)} `;
    prev = p.ts;
  }
  return { d: d.trim(), n: pts.length, breaks };
}

/** 점 좌표(온전한 점은 채운 점, 부분 합은 속이 빈 점). */
export function dotsFor(points, { t0, t1, w = 640, h = 150, yMin = 0, yMax = 1, pick = 'usedBytes' } = {}) {
  const val = pickerOf(pick);
  const span = (t1 - t0) || 1;
  return (points || [])
    .filter((p) => p && val(p) != null && Number.isFinite(Number(p.ts)) && p.ts >= t0 && p.ts <= t1)
    .map((p) => ({ x: ((p.ts - t0) / span) * w, y: yOf(val(p), h, yMin, yMax), partial: !!p.partial, p }));
}

/** 선을 끊는 간격 — 적재 간격의 1.5배(기록이 빠진 슬롯이 하나라도 있으면 끊는다, 규칙 ②). */
export function gapMsFor(intervalHours) {
  const h = n(intervalHours);
  return (h != null && h > 0 ? h : 12) * HOUR * 1.5;
}

/** x축 눈금 — 한국 시각. 1일은 'MM/DD HH:00', 그 밖은 'MM/DD'(v2.688 시안). */
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
    out.push({ at: i / (count - 1), label: days <= 1 ? `${mm}/${dd} ${hh}:00` : `${mm}/${dd}` });
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

/* ══════════════════════════════════════════════════════════════════════════════
 * v2.688 — 화면 재구성(시안 'BM Storage v2') + 그룹별 사용량·추이(사용자 요청).
 *   ⚠ 그룹 정렬은 **사용량(바이트) 많은 순**이다 — 시안은 사용률 순이었지만 사용자가 사용량 순을 골랐다(2026-10-03).
 *   ⚠ 추정(90% 도달 일수)은 **선형 추정**이라고 문장이 말한다. 증가가 0 이하이거나 온전한 점이 2개 미만이면 null.
 * ══════════════════════════════════════════════════════════════════════════════ */
const TB = 1024 ** 4;
/** 경고 기준 — 웹 전역 pctColor 와 같은 75/90. */
export const WARN_PCT = 75;
export const CRIT_PCT = 90;

/** 온전한 점(부분 합 제외 · 사용량을 읽은 점)만 — from..to 안에서. */
function fullPoints(series, from = null, to = null) {
  const f = n(from); const t = n(to);
  return (Array.isArray(series?.points) ? series.points : []).filter((p) => p && !p.partial && n(p.usedBytes) != null
    && Number.isFinite(Number(p.ts)) && (f == null || p.ts >= f) && (t == null || p.ts <= t));
}

/** 기간 안 첫 온전한 점과 마지막 온전한 점의 사용량 차이(바이트). 부분 합 점은 뺀다. 2개 미만이면 null. */
export function changeOf(series, from = null, to = null) {
  const pts = fullPoints(series, from, to);
  if (pts.length < 2) return null;
  return n(pts[pts.length - 1].usedBytes) - n(pts[0].usedBytes);
}

/** 하루 평균 증가(바이트/일) — 온전한 점 2개 이상 · 시간 간격이 있을 때만. */
export function ratePerDay(series, from = null, to = null) {
  const pts = fullPoints(series, from, to);
  if (pts.length < 2) return null;
  const days = (pts[pts.length - 1].ts - pts[0].ts) / DAY;
  if (!(days > 0)) return null;
  return (n(pts[pts.length - 1].usedBytes) - n(pts[0].usedBytes)) / days;
}

/**
 * 90%(df 정의 — used/(used+avail)) 도달까지 남은 일수(선형 추정).
 * 증가가 0 이하 · 점 2개 미만 · 용량을 모름 → null. 이미 90% 이상이면 0.
 */
export function daysTo90(series, from = null, to = null) {
  const pts = fullPoints(series, from, to);
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  const u = n(last.usedBytes); const a = n(last.availBytes);
  if (u == null || a == null || u + a <= 0) return null;
  const target = (u + a) * (CRIT_PCT / 100);
  if (u >= target) return 0;
  const rate = ratePerDay(series, from, to);
  if (rate == null || rate <= 0) return null;
  return Math.ceil((target - u) / rate);
}

/** 그룹 이름 ↔ 이력 키 — 그룹 없음은 이력 키 '' · 화면 이름 '(그룹 없음)'(서버 agg.js 와 같은 규칙). */
export const NO_GROUP = '(그룹 없음)';
export const groupKeyOf = (name) => (name === NO_GROUP ? '' : String(name ?? ''));

/** 그룹 색 — 이름 가나다순 자리로 정한다(사용량 순위가 바뀌어도 색이 바뀌지 않게). */
export const GROUP_PALETTE = Object.freeze(['#60a5fa', '#34e0b4', '#f59e0b', '#a855f7', '#f472b6', '#22d3ee', '#a3e635', '#fb7185', '#facc15', '#818cf8', '#2dd4bf', '#fb923c']);
export function groupColors(names) {
  const sorted = [...new Set((names || []).map(String))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  const m = new Map();
  sorted.forEach((nm, i) => m.set(nm, GROUP_PALETTE[i % GROUP_PALETTE.length]));
  return m;
}

/**
 * 그룹 정렬 — **사용량(바이트) 많은 순**(사용자 선택). 사용량을 못 읽은 그룹(null·0·서버 전부 미수집)은 뒤로,
 * 같으면 이름순. 원본을 바꾸지 않는다.
 */
export function sortGroupsByUsed(groups) {
  const used = (g) => { const v = n(g?.usedBytes); return v != null && n(g?.usedPct) != null ? v : -1; };
  return [...(groups || [])].sort((a, b) => (used(b) - used(a)) || String(a?.name).localeCompare(String(b?.name), 'ko', { numeric: true }));
}

/** 이력 계열 → key 별 Map(kind 하나만). */
export function seriesMap(series, kind) {
  const m = new Map();
  for (const s of Array.isArray(series) ? series : []) if (s?.kind === kind) m.set(String(s.key ?? ''), s);
  return m;
}

/**
 * 주의 카드 — 사용률 75% 이상이거나 90% 도달 추정이 30일 이내인 그룹.
 * 사용률이 null(마운트 미수집)인 그룹은 판정할 수 없으므로 빼고, 위험도 순(90% 이상·14일 이내 먼저)으로.
 * @param groups      /tools/bm-storage 의 groups
 * @param groupSeries Map<이력 키, 7일 계열> (seriesMap 결과)
 */
export function watchList(groups, groupSeries) {
  const out = [];
  for (const g of groups || []) {
    const pct = n(g?.usedPct);
    if (pct == null) continue;
    const s = groupSeries?.get?.(groupKeyOf(g.name)) || null;
    const days = s ? daysTo90(s) : null;
    if (!(pct >= WARN_PCT || (days != null && days <= 30))) continue;
    const crit = pct >= CRIT_PCT || (days != null && days <= 14);
    out.push({ key: groupKeyOf(g.name), name: g.name, pct, availBytes: n(g.availBytes), days, change: s ? changeOf(s) : null, level: crit ? 'crit' : 'warn' });
  }
  const rank = (w) => (w.level === 'crit' ? 0 : 1);
  return out.sort((a, b) => (rank(a) - rank(b)) || ((a.days ?? 1e9) - (b.days ?? 1e9)) || (b.pct - a.pct));
}

/** 일수 → '약 N일'(0 이면 '이미 90% 이상'). */
export function daysText(d) {
  const v = n(d);
  if (v == null) return '—';
  return v <= 0 ? '이미 90% 이상' : `약 ${v.toLocaleString()}일`;
}

/** 사용률 문구 — null 은 '—'(단위 없이). */
export function pctText(p) {
  const v = n(p);
  return v == null ? '—' : `${v.toFixed(1)}%`;
}

/** 계열의 마지막 온전한 점 요약(사용률·사용·전체·여유). */
export function lastOf(series) {
  const pts = fullPoints(series);
  const last = pts.length ? pts[pts.length - 1] : null;
  if (!last) return null;
  return { usedBytes: n(last.usedBytes), totalBytes: n(last.totalBytes), availBytes: n(last.availBytes), pct: pctOf(last), ts: last.ts };
}

/**
 * 추이 머리 문장 — { main, sub } (볼드는 **…** — BoldText 로 그린다).
 * @param mode 'total'|'group'|'server'
 * @param ctx  { periodLabel, series:[해당 보기 계열], scopeLabel?(서버 보기 그룹 필터 이름), groupOf?(서버키→그룹이름) , intervalHours }
 * @param focusKey 강조한 계열 키(그룹·서버) — 있으면 그 계열 문장
 */
export function headline(mode, ctx = {}, focusKey = null) {
  const per = ctx.periodLabel || '기간';
  const list = Array.isArray(ctx.series) ? ctx.series : [];
  if (focusKey != null && mode !== 'total') {
    const s = list.find((x) => String(x.key) === String(focusKey));
    if (s) {
      const l = lastOf(s);
      const ch = changeOf(s);
      return {
        main: `${s.name} 사용률은 지금 **${l ? pctText(l.pct) : '—'}**입니다.`,
        sub: `${per} 변화 ${ch == null ? '—' : changeText(ch)} · 여유 ${l ? bytesText(l.availBytes) : '—'} · 90% 도달 ${daysText(daysTo90(s))}${daysTo90(s) > 0 ? '(선형 추정)' : ''}`,
      };
    }
  }
  if (mode === 'total') {
    const s = list[0] || null;
    const ch = s ? changeOf(s) : null;
    const l = s ? lastOf(s) : null;
    const pts = Array.isArray(s?.points) ? s.points.length : 0;
    if (ch == null || !l) {
      return { main: `${per} 동안 전체 사용량 변화는 **—** 입니다(온전한 기록이 2개 미만).`, sub: `기록 ${pts}개 — 12시간마다 쌓이므로 다음 기록 뒤에 변화가 보입니다.` };
    }
    const rate = ratePerDay(s);
    const d = daysTo90(s);
    return {
      main: ch === 0
        ? `${per} 동안 전체 사용량은 **변화 없이** ${bytesText(l.usedBytes)}입니다.`
        : `${per} 동안 전체 사용량이 **${changeText(ch)}** ${ch > 0 ? '늘어' : '줄어'} ${bytesText(l.usedBytes)}가 되었습니다.`,
      sub: `하루 평균 ${rate == null ? '—' : bytesText(Math.abs(rate))}씩 ${rate != null && rate < 0 ? '줄고' : '늘고'} 있으며, ${d == null ? '증가 추세가 없어 90% 도달을 추정하지 않습니다' : d <= 0 ? '전체가 이미 90% 이상입니다' : `이 추세면 전체 90%까지 ${daysText(d)} 남았습니다(선형 추정)`}. 기록 ${pts}개.`,
    };
  }
  if (mode === 'group') {
    const rows = list.map((s) => ({ s, l: lastOf(s), ch: changeOf(s) }));
    const read = rows.filter((r) => r.l && r.l.pct != null);
    // v2.727(감사 E-07): 문장형 머리글에는 '—' 를 끼우지 않는다 — '읽은 그룹이 — 없습니다' 는 기호 오류처럼 읽힌다(값형 '변화는 — 입니다' 만 유지).
    if (!read.length) return { main: `${list.length}개 그룹 중 사용률을 읽은 그룹이 없습니다.`, sub: '온전한 기록이 쌓이면 보입니다.' };
    const top = [...read].sort((a, b) => b.l.pct - a.l.pct)[0];
    const warn = read.filter((r) => r.l.pct >= WARN_PCT).length;
    const grow = rows.filter((r) => r.ch != null).sort((a, b) => b.ch - a.ch)[0];
    return {
      main: `${list.length}개 그룹 중 사용률이 가장 높은 곳은 **${top.s.name} ${pctText(top.l.pct)}**입니다.`,
      sub: `75% 이상 그룹 ${warn}개 · ${grow ? `${per} 증가가 가장 큰 그룹은 ${grow.s.name}(${changeText(grow.ch)})입니다.` : '기간 증가를 계산할 기록이 부족합니다.'}`,
    };
  }
  // server
  const scope = ctx.scopeLabel ? `${ctx.scopeLabel} 그룹` : '전체';
  const rows = list.map((s) => ({ s, l: lastOf(s), ch: changeOf(s) }));
  const grow = rows.filter((r) => r.ch != null).sort((a, b) => b.ch - a.ch)[0];
  const warn = rows.filter((r) => r.l && r.l.pct != null && r.l.pct >= WARN_PCT).length;
  const crit = rows.filter((r) => r.l && r.l.pct != null && r.l.pct >= CRIT_PCT).length;
  return {
    main: grow
      ? `${scope} ${list.length}대 중 사용량이 가장 많이 늘어난 서버는 **${grow.s.name} ${changeText(grow.ch)}**입니다.`
      : `${scope} ${list.length}대 중 기간 변화를 계산할 수 있는 서버가 없습니다.`,
    sub: `75% 이상 ${warn}대 · 90% 이상 ${crit}대 · 선 색은 소속 그룹 색입니다.`,
  };
}

/**
 * 세로축 범위.
 *  - total + zoom(기본): 사용량 최소~최대 ±25% 여백, 5 TB 단위로 맞춤(0 아래로 가지 않는다)
 *  - total + capacity: 0 ~ 총 용량 최대 × 1.05
 *  - unit '%': 0~100
 *  - unit 'TB': 0 ~ 사용량 최대 × 1.1
 * @returns {{min:number,max:number,kind:'bytes'|'pct'}}
 */
export function yRange(mode, unit, scale, series) {
  const list = Array.isArray(series) ? series : [];
  if (mode !== 'total' && unit === 'pct') return { min: 0, max: 100, kind: 'pct' };
  let lo = Infinity; let hi = -Infinity; let cap = 0;
  for (const s of list) for (const p of s?.points || []) {
    const u = n(p?.usedBytes); const t = n(p?.totalBytes);
    if (u != null) { lo = Math.min(lo, u); hi = Math.max(hi, u); }
    if (t != null) cap = Math.max(cap, t);
  }
  if (!Number.isFinite(hi)) return { min: 0, max: 1, kind: 'bytes' };
  if (mode === 'total' && scale === 'capacity') return { min: 0, max: (cap > 0 ? cap : hi) * 1.05, kind: 'bytes' };
  if (mode === 'total') {
    const step = 5 * TB;
    const padB = Math.max((hi - lo) * 0.25, step);
    const min = Math.max(0, Math.floor((lo - padB) / step) * step);
    const max = Math.ceil((hi + padB) / step) * step;
    return { min, max: max > min ? max : min + step, kind: 'bytes' };
  }
  return { min: 0, max: hi > 0 ? hi * 1.1 : 1, kind: 'bytes' };
}

/** 세로축 눈금 5개(min..max) — 바이트는 bytesText, %는 정수. */
export function yTicks(range) {
  const out = [];
  for (let i = 0; i <= 4; i += 1) {
    const v = range.min + ((range.max - range.min) * i) / 4;
    out.push({ at: i / 4, label: range.kind === 'pct' ? `${Math.round(v)}%` : v === 0 ? '0' : bytesText(v) });
  }
  return out;
}

/** 서버 정렬(서버 목록) — 'pct'(사용률 높은 순) | 'avail'(여유 적은 순) | 'name'. 값 없는 행은 항상 뒤로. */
export function sortServers(rows, by = 'pct') {
  const val = (s) => (by === 'avail' ? (s?.ok ? n(s.availBytes) : null) : (s?.ok ? n(s.usedPct) : null));
  return [...(rows || [])].sort((a, b) => {
    if (by === 'name') return String(a?.name).localeCompare(String(b?.name), 'ko', { numeric: true });
    const x = val(a); const y = val(b);
    if (x == null && y == null) return String(a?.name).localeCompare(String(b?.name), 'ko', { numeric: true });
    if (x == null) return 1;
    if (y == null) return -1;
    return by === 'avail' ? x - y : y - x;
  });
}

/** 그룹 기여 — 전체 합계 보기의 오른쪽 목록. 증가분 대비 비율은 증가가 양수일 때만(그룹 중복 합산이라 합이 100% 를 넘을 수 있다). */
export function contributions(groupSeries, totalChange) {
  const tot = n(totalChange);
  return [...(groupSeries || [])].map((s) => {
    const ch = changeOf(s);
    const l = lastOf(s);
    return { key: String(s.key ?? ''), name: s.name, change: ch, pct: l ? l.pct : null, share: ch != null && tot != null && tot > 0 ? Math.round((ch / tot) * 100) : null };
  }).sort((a, b) => ((b.change ?? -Infinity) - (a.change ?? -Infinity)) || String(a.name).localeCompare(String(b.name), 'ko'));
}

/**
 * 지금 고른 기간의 응답만 돌려준다 — v2.689 B10-b. got = { period, data }.
 * 기간을 바꾼 조회가 실패하거나 아직 오지 않았을 때 이전 기간의 응답을 새 기간 라벨 아래 그리지 않는다
 * (기간 버튼은 '1달' 인데 차트·변화량은 '7일' 인 거짓). 맞지 않으면 null.
 */
export function historyForPeriod(got, period) {
  if (!got || got.data == null) return null;
  return String(got.period) === String(period) ? got.data : null;
}
