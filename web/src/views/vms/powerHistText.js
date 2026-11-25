/**
 * views/vms/powerHistText.js — VM 전원 이력 화면 문구 · 달력 계산(v3.39.0 · 시안 docs/design/vm-power-calendar A안 · ⑤). 순수 모듈(vitest).
 *   판정(구간 · 경계 불확실 · 기록 없음 · 처음 Power On)은 서버 vmpower/spans.js 하나 — 여기는 받은 조각(segments)을 날짜 · 달로 자르고 글로 바꿀 뿐이다.
 *   날짜 경계는 브라우저 지역 시각(사용자 시계)이다.
 */
import { numOrNull } from '../../numOrNull.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const STATES = Object.freeze(['on', 'off', 'est', 'unk']);
export const STATE_LABEL = Object.freeze({ on: '켜짐', off: '꺼짐', est: '경계 불확실', unk: '기록 없음' });
export const WEEKDAYS = Object.freeze(['일', '월', '화', '수', '목', '금', '토']);
/** 칠하는 색(CSS 변수 — powerHist.css 의 .pwh 범위). unk 는 빗금. */
export const STATE_FILL = Object.freeze({ on: 'var(--pwh-on)', off: 'var(--pwh-off)', est: 'var(--pwh-est)', unk: 'transparent' });
const HATCH = 'repeating-linear-gradient(135deg, var(--pwh-hatch) 0 2px, transparent 2px 5px)';

const p2 = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD HH:mm'(지역 시각) · 값이 없으면 '—'. */
export function stampText(ts) {
  const t = numOrNull(ts);
  if (t == null) return '—';
  const d = new Date(t);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
const hmText = (ts) => { const d = new Date(ts); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };

/** 길이 → '3일 4시간' · '5시간 20분' · '7분'(0 이상). 값이 없으면 '—'. */
export function durText(ms) {
  const v = numOrNull(ms);
  if (v == null || v < 0) return '—';
  const m = Math.round(v / MIN);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mi = m % 60;
  if (d > 0) return `${d}일${h ? ` ${h}시간` : ''}`;
  if (h > 0) return `${h}시간${mi ? ` ${mi}분` : ''}`;
  return `${mi}분`;
}

/** 길이 범위 글 — 위 끝을 모르면 '… 이상', 거의 같으면 하나, 아니면 '아래 ~ 위'(관측 간격 안에서 바뀐 시각을 모른다). */
export function durRangeText(minMs, maxMs) {
  const lo = numOrNull(minMs);
  const hi = numOrNull(maxMs);
  if (lo == null) return '—';
  if (hi == null) return `${durText(lo)} 이상`;
  if (hi - lo < MIN) return durText(lo);
  return `${durText(lo)} ~ ${durText(hi)}`;
}

/** 전환 시각 글 — 정확하면 그 시각, 아니면 '앞 끝 ~ 뒤 끝 사이'(같은 날이면 뒤는 시:분만). */
export function whenText({ ts, lo, exact } = {}) {
  const t = numOrNull(ts);
  if (t == null) return '—';
  const l = numOrNull(lo);
  if (exact || l == null || l >= t) return stampText(t);
  return `${stampText(l)} ~ ${dayKey(l) === dayKey(t) ? hmText(t) : stampText(t).slice(5)} 사이`;
}

/** 출처 글. */
export function srcText(src, precision = {}) {
  if (src === 'event') return 'vCenter 이벤트';
  if (src === 'backfill') return `VM 추적 소급${precision.backfillMs ? ` · 정밀도 ${durText(precision.backfillMs)}` : ''}`;
  return `포탈 관측${precision.watchMs ? ` · 정밀도 ${durText(precision.watchMs)}` : ''}`;
}

/** 조각들을 [a, b) 로 자른 것(시간순). */
export function clipSegs(segments, a, b) {
  const out = [];
  for (const s of segments || []) {
    const x = Math.max(s.a, a);
    const y = Math.min(s.b, b);
    if (y > x) out.push({ a: x, b: y, st: s.st, src: s.src });
  }
  return out;
}
export function sumsOf(parts) {
  const s = { on: 0, off: 0, est: 0, unk: 0 };
  for (const p of parts || []) if (Object.hasOwn(s, p.st)) s[p.st] += p.b - p.a;
  return s;
}
/** 켜짐 비율(판정된 시간 = 켜짐 + 꺼짐 기준 — 경계 불확실 · 기록 없음은 분모에서 뺀다). 판정된 시간이 없으면 null. */
export function onRatio(sums) {
  const known = (sums?.on || 0) + (sums?.off || 0);
  return known > 0 ? sums.on / known : null;
}
export const pctText = (r, digits = 1) => (r == null ? '—' : `${(r * 100).toFixed(digits)}%`);

/** 하루 띠의 배경(가로 = 0시 → 24시). 칠할 조각이 없으면 null(기록 전 · 미래). */
export function dayBarStyle(parts, a, b) {
  if (!parts.length) return null;
  const span = b - a;
  const stops = [];
  let last = 0;
  for (const p of parts) {
    const x = (((p.a - a) / span) * 100).toFixed(2);
    const y = (((p.b - a) / span) * 100).toFixed(2);
    if (Number(x) > last) stops.push(`transparent ${last}% ${x}%`);
    stops.push(`${STATE_FILL[p.st] || 'transparent'} ${x}% ${y}%`);
    last = Number(y);
  }
  if (last < 100) stops.push(`transparent ${last}% 100%`);
  return { backgroundImage: `linear-gradient(90deg, ${stops.join(', ')}), ${HATCH}` };
}
/** 비율 띠(시간순이 아니라 켜짐 → 꺼짐 → 판정 못함 순). 칠할 것이 없으면 null. */
export function ratioBarStyle(sums) {
  const all = (sums?.on || 0) + (sums?.off || 0) + (sums?.est || 0) + (sums?.unk || 0);
  if (!(all > 0)) return null;
  const x = ((sums.on / all) * 100).toFixed(1);
  const y = (((sums.on + sums.off) / all) * 100).toFixed(1);
  return { backgroundImage: `linear-gradient(90deg, var(--pwh-on) 0 ${x}%, var(--pwh-off) ${x}% ${y}%, transparent ${y}% 100%), ${HATCH}` };
}

/** 최근 n 개월(offset 개월 앞으로 민 것) — [{y, m(1~12), start, end, title}] 오래된 달부터. */
export function monthsBack(now, n = 12, offset = 0) {
  const d = new Date(now);
  const out = [];
  for (let i = n - 1 + offset; i >= offset; i--) {
    const s = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const e = new Date(d.getFullYear(), d.getMonth() - i + 1, 1);
    out.push({ y: s.getFullYear(), m: s.getMonth() + 1, start: s.getTime(), end: e.getTime(), title: `${s.getFullYear()}년 ${s.getMonth() + 1}월` });
  }
  return out;
}

/**
 * 한 달의 달력 칸 — { blanks(첫 주 앞 빈칸 수), days: [{key, n, wd, start, end, parts, sums, changed, future, none, aria}] , sums }.
 *   none = 그 날 칠할 기록이 없다(기록 시작 전) · changed = 그 날 상태가 둘 이상(전원이 바뀐 날) · future = 아직 오지 않은 날.
 */
export function monthCells(month, segments, now) {
  const days = [];
  const total = { on: 0, off: 0, est: 0, unk: 0 };
  const first = new Date(month.start);
  for (let d = new Date(first); d.getTime() < month.end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const a = d.getTime();
    const b = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const future = a >= now;
    const parts = future ? [] : clipSegs(segments, a, Math.min(b, now));
    const sums = sumsOf(parts);
    for (const k of STATES) total[k] += sums[k];
    const kinds = ['on', 'off', 'est'].filter((k) => sums[k] > 0).length;
    const none = !future && !parts.length;
    const n = d.getDate();
    const wd = WEEKDAYS[d.getDay()];
    days.push({
      key: dayKey(a), n, wd, start: a, end: b, parts, sums, changed: kinds > 1, future, none,
      aria: `${month.m}월 ${n}일 ${wd}요일 — ${future ? '아직 오지 않은 날' : none ? '기록 전' : sumsText(sums)}`,
    });
  }
  return { blanks: first.getDay(), days, sums: total };
}

/** 합계 글 — '켜짐 3시간 · 꺼짐 21시간 · 판정 못함 10분'(0 인 것은 뺀다). */
export function sumsText(s) {
  const bits = [];
  if (s?.on) bits.push(`켜짐 ${durText(s.on)}`);
  if (s?.off) bits.push(`꺼짐 ${durText(s.off)}`);
  if ((s?.est || 0) + (s?.unk || 0)) bits.push(`판정 못함 ${durText((s.est || 0) + (s.unk || 0))}`);
  return bits.join(' · ') || '—';
}

/** 사실 한 칸(처음 · 마지막 Power On/Off) → { main, sub }. before = 기록 시작 전부터 그 상태(날짜를 지어내지 않는다). */
export function factText(f, precision = {}) {
  if (!f) return { main: '기록 없음', sub: '' };
  if (f.before != null) return { main: '기록 시작 전', sub: `${stampText(f.before).slice(0, 10)} 기록 시작 때 이미 이 상태` };
  return { main: whenText(f), sub: f.exact ? `vCenter 이벤트${f.user ? ` · ${f.user}` : ''}` : srcText(f.src, precision) };
}

/** 지금 상태 머리글 — '켜짐 · 13일 7시간째' / '꺼짐 · 26일째' · 시작을 모르면 '… 이상'. */
export function currentText(facts, now) {
  const c = facts?.current;
  if (!c) return facts?.gone ? { head: '지금 목록에 없음', since: '' } : { head: '기록 없음', since: '' };
  const label = STATE_LABEL[c.state] || c.state;
  if (c.before != null) return { head: `${label} · ${durText(now - c.before)} 이상`, since: `기록 시작(${stampText(c.before).slice(0, 10)}) 전부터` };
  return { head: `${label} · ${durText(now - c.ts)}째`, since: `${whenText(c)} 부터` };
}

/** 선택할 기본 날 — 최근에 전원이 바뀐 날(없으면 오늘). */
export function defaultDayKey(transitions, now) {
  const t = (transitions || [])[0];
  return t && numOrNull(t.ts) != null ? dayKey(t.ts) : dayKey(now);
}
