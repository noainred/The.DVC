/**
 * bmusage/maint/schedule.js — 리눅스 성능 8a단계 **정비 창 일정 계산**(순수 — 설계 PROFILES §20 ⑲ · 아트보드 Maint).
 *
 * 일정은 두 꼴뿐이다(RRULE 전부가 아니다 — 설계 ‘반복 일정의 범위’):
 *   · once     — 시작 · 끝(법인 시간대의 벽시계 'YYYY-MM-DDTHH:mm'). 길이 상한 24시간.
 *   · weekly   — 요일(0=일 … 6=토, 여러 개) · 시작 시각 'HH:mm' · 길이(분). 길이 상한 12시간.
 *   · monthly  — n째(1~4 · 5=마지막) 요일 · 시작 시각 · 길이(분). 길이 상한 12시간.
 * 시간대는 창마다 저장한 IANA 이름(법인 시간대 — 포탈에 법인 시간대 원천이 없어 창에 싣는다 · 기본 Asia/Seoul).
 *
 * ⚠ DST(서머타임) 규약 — 미리보기 5회로 사람이 확인한다(설계):
 *   · 없는 벽시계(봄 앞당김 — 예 Europe/Warsaw 02:30)는 **간격만큼 뒤로 민 시각**(03:30)으로 시작한다.
 *   · 두 번 있는 벽시계(가을 되돌림 — 02:30 이 두 번)는 **앞의 것**으로 시작한다.
 *   · 길이는 벽시계가 아니라 **실제 경과 분**이다(02:00~06:00 창이 되돌림 날에는 벽시계로 05:00 에 끝난다 — 4시간).
 * ⚠ 길이 상한은 저장 검사뿐 아니라 **계산에서도 다시 자른다**(capEnd) — 손으로 고친 파일 · 엣지 배포본이 상한을 넘겨도 억제가 상한보다 길어지지 않는다(억제 시한).
 * 오프셋 계산은 issues/sla.js 의 tzOffsetMin(Intl — 그 순간의 실제 오프셋) 하나를 쓴다(복제하지 않는다).
 */
import { tzOffsetMin, validTz } from '../../issues/sla.js';

export { validTz };
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const DEFAULT_TZ = 'Asia/Seoul';
export const SCHED_KINDS = Object.freeze(['once', 'weekly', 'monthly']);
/** 길이 상한(분) — 일회 24시간 · 반복 12시간(설계 그대로). 계산도 이 값으로 자른다. */
export const ONCE_MAX_MIN = 24 * 60;
export const RECUR_MAX_MIN = 12 * 60;
/** 한 번에 계산하는 발생 수 상한(미리보기 · 음영 · 제외 구간이 무한히 늘지 않게). */
export const OCC_MAX = 400;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/** 'YYYY-MM-DDTHH:mm' → 부품(달력에 없는 날 · 범위 밖이면 null). 24:00 은 받지 않는다(화면이 다음 날 00:00 으로 바꾼다). */
export function parseLocal(s) {
  const m = LOCAL_RE.exec(String(s ?? ''));
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || h > 23 || mi > 59) return null;
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, mo, d, h, mi };
}
/** 'HH:mm' → 분(0~1439) · 아니면 null. */
export function parseTime(s) {
  const m = TIME_RE.exec(String(s ?? ''));
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
}

/**
 * 법인 시간대의 벽시계 → UTC ms(위 DST 규약). 순수(Intl 만).
 *   두 후보(직전 · 직후 오프셋)로 되돌려 보고 맞는 것 중 이른 것을 고른다 — 둘 다 안 맞으면 없는 시각이라 직전 오프셋으로(간격만큼 뒤로 밀린다).
 */
export function localToUtc(tz, y, mo, d, h, mi) {
  const L = Date.UTC(y, mo - 1, d, h, mi);
  const oA = tzOffsetMin(tz, L - 14 * HOUR);
  const oB = tzOffsetMin(tz, L + 14 * HOUR);
  const cands = [...new Set([oA, oB])].map((o) => L - o * MIN).filter((c) => (L - c) / MIN === tzOffsetMin(tz, c));
  if (cands.length) return Math.min(...cands);
  return L - oA * MIN;
}
/** UTC ms → 그 시간대의 벽시계 부품(+ 요일 0=일). */
export function utcToLocal(tz, ms) {
  const o = tzOffsetMin(tz, ms);
  const dt = new Date(ms + o * MIN);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), h: dt.getUTCHours(), mi: dt.getUTCMinutes(), dow: dt.getUTCDay(), offsetMin: o };
}
const pad = (v) => String(v).padStart(2, '0');
/** 벽시계 표기 'YYYY-MM-DD HH:mm'(화면 · 미리보기 — 서버가 만든다: 웹이 시간대 계산을 복제하지 않는다). */
export function fmtLocal(tz, ms) {
  const p = utcToLocal(tz, ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}
/** 그 달의 n째 요일(1~4 · 5=마지막) 날짜(1~31) — 순수 달력 계산(시간대 무관). */
export function nthWeekdayOfMonth(y, mo, nth, dow) {
  const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const firstHit = 1 + ((dow - first + 7) % 7);
  if (nth >= 5) { let d = firstHit; while (d + 7 <= days) d += 7; return d; }
  const d = firstHit + (nth - 1) * 7;
  return d <= days ? d : null;
}

/** 일정의 길이 상한(분) — 꼴에 따라. */
export const maxMinOf = (sched) => (sched?.kind === 'once' ? ONCE_MAX_MIN : RECUR_MAX_MIN);

/**
 * [from, to) 와 겹치는 발생 목록(시작 오름차순 · 상한 OCC_MAX). 각 발생 { start, end } — end 는 길이 상한으로 다시 자른다.
 *   잘못된 일정(형식 밖)이면 빈 목록(억제하지 않는다 — 모르는 일정을 억제로 읽지 않는다).
 */
export function occurrencesBetween(sched, tz, from, to, { max = OCC_MAX } = {}) {
  if (!sched || !SCHED_KINDS.includes(sched.kind) || !validTz(tz) || !(Number(to) > Number(from))) return [];
  const capMs = maxMinOf(sched) * MIN;
  const out = [];
  const push = (start, end) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const e = Math.min(end, start + capMs);
    if (e > from && start < to) out.push({ start, end: e });
  };
  if (sched.kind === 'once') {
    const a = parseLocal(sched.start); const b = parseLocal(sched.end);
    if (a && b) push(localToUtc(tz, a.y, a.mo, a.d, a.h, a.mi), localToUtc(tz, b.y, b.mo, b.d, b.h, b.mi));
    return out;
  }
  const tm = parseTime(sched.time);
  const dur = Number(sched.durMin);
  if (tm == null || !Number.isInteger(dur) || dur < 1) return [];
  const durMs = Math.min(dur, RECUR_MAX_MIN) * MIN;
  // 벽시계 날짜를 시간대 무관한 달력으로 센다 — 시작은 (from − 길이 − 하루)의 지역 날짜, 끝은 (to + 하루).
  const s0 = utcToLocal(tz, from - durMs - DAY);
  const e0 = utcToLocal(tz, to + DAY);
  let day = Date.UTC(s0.y, s0.mo - 1, s0.d);
  const last = Date.UTC(e0.y, e0.mo - 1, e0.d);
  const h = Math.floor(tm / 60); const mi = tm % 60;
  if (sched.kind === 'weekly') {
    const days = new Set(Array.isArray(sched.days) ? sched.days : []);
    if (!days.size) return [];
    for (; day <= last && out.length < max; day += DAY) {
      const dt = new Date(day);
      if (!days.has(dt.getUTCDay())) continue;
      const st = localToUtc(tz, dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), h, mi);
      push(st, st + durMs);
    }
    return out.slice(0, max);
  }
  // monthly — 달마다 한 번
  const nth = Number(sched.nth); const wd = Number(sched.weekday);
  if (!Number.isInteger(nth) || nth < 1 || nth > 5 || !Number.isInteger(wd) || wd < 0 || wd > 6) return [];
  let y = new Date(day).getUTCFullYear(); let mo = new Date(day).getUTCMonth() + 1;
  const ly = new Date(last).getUTCFullYear(); const lm = new Date(last).getUTCMonth() + 1;
  while ((y < ly || (y === ly && mo <= lm)) && out.length < max) {
    const d = nthWeekdayOfMonth(y, mo, nth, wd);
    if (d != null) { const st = localToUtc(tz, y, mo, d, h, mi); push(st, st + durMs); }
    mo += 1; if (mo > 12) { mo = 1; y += 1; }
  }
  return out.slice(0, max);
}

/** now 를 덮는 발생(없으면 null). */
export function occurrenceAt(sched, tz, now) {
  const occ = occurrencesBetween(sched, tz, now, now + 1, { max: 8 });
  return occ.find((o) => o.start <= now && now < o.end) || null;
}
/** now 이후 시작하는 발생 n개(미리보기 — 진행 중인 발생도 첫 칸에 넣는다). 반복은 최대 400일 앞까지 본다. */
export function nextOccurrences(sched, tz, now, n = 5) {
  const horizon = sched?.kind === 'once' ? 400 * DAY : 400 * DAY;
  return occurrencesBetween(sched, tz, now, now + horizon, { max: OCC_MAX }).filter((o) => o.end > now).slice(0, n);
}
