/**
 * bmcheck/warranty.js — 물리서버 **보증 · 계약 만료** 판정 코어(v3.45 · 설계 docs/design/bm-feature-proposals ①). 순수.
 *
 *  · 값은 관리자가 올린 자산 원장(CSV)에서만 온다 — 포탈은 제조사에 조회하지 않는다(인터넷에 나가지 않는 설치가 기본).
 *  · 상태: expired(끝남) · soon(WARRANTY_SOON_DAYS 일 안에 끝남) · ok · unknown(원장에 없음 · 만료일 없음).
 *    **unknown 은 끝남에도 정상에도 넣지 않고 따로 센다**(원장에 없는 서버를 '보증 있음' 으로 읽지 않게).
 *  · 날짜는 날짜만(YYYY-MM-DD) — '오늘' 은 포탈의 날짜 경계(util/dayKey.js — 기본 한국 시각). 만료일 당일은 아직 보증 안이다(남은 0일).
 */
import { todayStamp } from '../util/dayKey.js';

export const WARRANTY_SOON_DAYS = 90;
export const ASSET_TEXT_MAX = 120;

const two = (n) => String(n).padStart(2, '0');
/**
 * 날짜 글자 → 'YYYY-MM-DD' 또는 ''(못 읽음). 받는 꼴: 2027-03-14 · 2027/03/14 · 2027.03.14 · 20270314(한 자리 월 · 일도 받는다).
 * 실제로 있는 날짜만(2027-02-30 은 '') · 1990~2100 년만.
 */
export function parseDay(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v).trim().slice(0, 24);
  let y; let m; let d;
  if (/^[0-9]{8}$/.test(s)) { y = Number(s.slice(0, 4)); m = Number(s.slice(4, 6)); d = Number(s.slice(6, 8)); }
  else {
    const p = s.split(/[-/.]/);
    if (p.length !== 3 || !p.every((x) => /^[0-9]{1,4}$/.test(x.trim()))) return '';
    y = Number(p[0].trim()); m = Number(p[1].trim()); d = Number(p[2].trim());
    if (p[0].trim().length !== 4) return '';
  }
  if (!(y >= 1990 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return '';
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return '';
  return `${y}-${two(m)}-${two(d)}`;
}
const dayNo = (day) => { const p = String(day).split('-').map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 86_400_000); };
/** a − b (일). 둘 다 parseDay 를 지난 글자여야 한다 — 아니면 null. */
export function dayDiff(a, b) {
  const x = parseDay(a); const y = parseDay(b);
  if (!x || !y) return null;
  return dayNo(x) - dayNo(y);
}
/** 구매일부터 오늘까지 꽉 찬 개월 수(음수면 null — 미래 구매일은 사용 기간이 아니다). */
export function monthsBetween(from, to) {
  const x = parseDay(from); const y = parseDay(to);
  if (!x || !y) return null;
  const a = x.split('-').map(Number); const b = y.split('-').map(Number);
  const n = (b[0] - a[0]) * 12 + (b[1] - a[1]) - (b[2] < a[2] ? 1 : 0);
  return n >= 0 ? n : null;
}

const text = (v) => (typeof v === 'string' ? v.trim().slice(0, ASSET_TEXT_MAX) : '');

/**
 * 원장 한 줄 → 화면 값.
 * @param {object|null} entry 원장 줄({ end, type, purchase, contract, eos, note }) — 없으면 null
 * @param {string} today 'YYYY-MM-DD'
 * @returns {{ state:'expired'|'soon'|'ok'|'unknown', why?:'no-entry'|'no-end', end:string, daysLeft:number|null, type:string, purchase:string,
 *            ageMonths:number|null, contract:string, eos:string, eosPassed:boolean|null, note:string }}
 */
export function warrantyOf(entry, today = todayStamp()) {
  const e = entry && typeof entry === 'object' ? entry : null;
  const end = e ? parseDay(e.end) : '';
  const purchase = e ? parseDay(e.purchase) : '';
  const eos = e ? parseDay(e.eos) : '';
  const daysLeft = end ? dayDiff(end, today) : null;
  const eosLeft = eos ? dayDiff(eos, today) : null;
  let state = 'unknown';
  if (daysLeft != null) state = daysLeft < 0 ? 'expired' : daysLeft <= WARRANTY_SOON_DAYS ? 'soon' : 'ok';
  return {
    state, ...(state === 'unknown' ? { why: e ? 'no-end' : 'no-entry' } : {}),
    end, daysLeft, type: text(e?.type), purchase, ageMonths: purchase ? monthsBetween(purchase, today) : null,
    contract: text(e?.contract), eos, eosPassed: eosLeft == null ? null : eosLeft < 0, note: text(e?.note),
  };
}
