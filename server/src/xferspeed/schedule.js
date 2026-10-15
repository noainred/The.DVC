/**
 * xferspeed/schedule.js — 전송 속도 측정의 **실행 일정**(순수 — 파일·타이머 없음, v2.735).
 *
 * 사용자 요청(2026-10-13): "테스트 시간을 지정할 수 있는 기능 — ① 내가 원하는 시간에 실행/반복/주간반복/월간 반복
 * ② 30분/1시간 등 내가 원하는 간격으로 실행".
 *
 * ── 일정 하나의 모양 ────────────────────────────────────────────────────────
 *   { id, kind: 'once'|'daily'|'weekly'|'monthly', time: 'HH:MM', date?: 'YYYY-MM-DD'(once),
 *     days?: [0..6](weekly — 0 = 일요일), monthDays?: [1..31](monthly), enabled, since }
 *  · 시각은 **포탈 시각**(`util/dayKey.js` 오프셋, 기본 한국 시각)이다 — 서버 프로세스 TZ 에 기대지 않는다(v2.582 규약).
 *  · 매월 '그 달에 없는 날'(30일·31일·29일)은 **그 달 마지막 날**에 실행한다. 같은 날에 두 번 겹치면 한 번이다.
 *  · `since` 는 서버가 정한다(일정을 만들거나 바꾼 시각) — 그 이전 시각은 실행하지 않는다(만들자마자 지난 시각을 소급 실행하지 않는다).
 *
 * ── 지난 시각의 처리(planTick) ───────────────────────────────────────────────
 *  · 일정마다 '지금 이전의 가장 최근 시각' 하나만 본다. 그 시각이 처리 기록(`state.lastAt`)·`since` 보다 뒤이고
 *    지금과의 차이가 `GRACE_MS`(30분) 안이면 **실행**, 그보다 늦었으면 **놓침**으로 기록한다(몰아서 여러 번 실행하지 않는다).
 *  · 놓침 사유는 단정하지 않고 아는 것만 쓴다: 포탈이 꺼져 있었음(기동 전) / 이전 측정이 길어짐 / 자동 측정 꺼짐 / 늦음.
 *  · 간격 실행은 '마지막 실행 시작 + 간격' 이 지났을 때다 — 예약으로 실행해도 마지막 실행 시각이 바뀌므로 바로 이어 돌지 않는다.
 */
import { DAY_OFFSET_MIN } from '../util/dayKey.js';

export const SCHEDULE_KINDS = Object.freeze(['once', 'daily', 'weekly', 'monthly']);
export const SCHEDULE_MAX = 20;
export const GRACE_MS = 30 * 60_000;
/** 놓침 사유 — 웹 `xferSpeedText.MISSED_TEXT` 와 1:1(테스트 대조). `clock` = 시계가 뒤로 가 기록을 지금으로 다시 잡음(v2.740 B-09). */
export const MISSED_REASONS = Object.freeze(['down', 'busy', 'off', 'late', 'clock']);
/** 이만큼 넘게 지금보다 뒤인 기록은 '시계가 뒤로 간 흔적' 으로 본다(같은 프로세스가 Date.now() 로 쓴 값이라 정상이면 미래일 수 없다). */
export const CLOCK_TOL_MS = 2 * 60_000;

const DAY = 86_400_000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ID_RE = /^[a-z0-9-]{1,24}$/;
const SEARCH_DAYS = 400;

const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m = 1..12

function parseTime(v) {
  const m = TIME_RE.exec(String(v ?? '').trim());
  return m ? { h: Number(m[1]), mi: Number(m[2]) } : null;
}
function parseDate(v) {
  const m = DATE_RE.exec(String(v ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > lastDayOf(y, mo)) return null;
  return { y, mo, d };
}
const intList = (v, lo, hi) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n >= lo && n <= hi))].sort((a, b) => a - b);

/** 포탈 시각의 날짜 부분(y, mo 1~12, d, wd 0~6). */
export function localParts(ms, offsetMin = DAY_OFFSET_MIN) {
  const d = new Date(Number(ms) + offsetMin * 60_000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay() };
}
/** 포탈 시각 y-mo-d h:mi → epoch ms. */
export function localMs(y, mo, d, h, mi, offsetMin = DAY_OFFSET_MIN) {
  return Date.UTC(y, mo - 1, d, h, mi) - offsetMin * 60_000;
}

/**
 * 일정 하나를 검사·정리(순수). 잘못된 값은 고치지 않고 **사유**를 준다 — 저장 라우트가 400 으로 돌려준다
 * (조용히 버리면 사용자가 만든 일정이 사라진다).
 * @returns {{ok:true, sched:object}|{ok:false, field:string, reason:string}}
 */
export function checkSchedule(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!r) return { ok: false, field: 'kind', reason: '일정 형식이 아닙니다' };
  const kind = String(r.kind || '').trim();
  if (!SCHEDULE_KINDS.includes(kind)) return { ok: false, field: 'kind', reason: '종류는 1회·매일·매주·매월 중 하나입니다' };
  if (!parseTime(r.time)) return { ok: false, field: 'time', reason: '시각은 00:00~23:59 형식이어야 합니다' };
  const out = { id: ID_RE.test(String(r.id || '')) ? String(r.id) : '', kind, time: String(r.time).trim(), enabled: r.enabled !== false };
  if (kind === 'once') {
    if (!parseDate(r.date)) return { ok: false, field: 'date', reason: '날짜는 YYYY-MM-DD 형식의 실제 날짜여야 합니다' };
    out.date = String(r.date).trim();
  } else if (kind === 'weekly') {
    const days = intList(r.days, 0, 6);
    if (!days.length) return { ok: false, field: 'days', reason: '매주 일정은 요일을 하나 이상 골라야 합니다' };
    out.days = days;
  } else if (kind === 'monthly') {
    const md = intList(r.monthDays, 1, 31);
    if (!md.length) return { ok: false, field: 'monthDays', reason: '매월 일정은 날짜를 하나 이상 골라야 합니다' };
    out.monthDays = md;
  }
  const since = Number(r.since);
  if (Number.isFinite(since) && since > 0) out.since = since;
  return { ok: true, sched: out };
}

/** 정의가 같은가(실행 시각을 정하는 필드만 — id·since 제외). */
export function sameDefinition(a, b) {
  if (!a || !b) return false;
  const k = (s) => JSON.stringify([s.kind, s.time, s.date || '', s.days || [], s.monthDays || []]);
  return k(a) === k(b);
}

/** 그 날(포탈 날짜)이 일정에 맞는가. */
function matchDay(s, y, mo, d, wd) {
  if (s.kind === 'daily') return true;
  if (s.kind === 'weekly') return (s.days || []).includes(wd);
  if (s.kind === 'monthly') {
    const last = lastDayOf(y, mo);
    if ((s.monthDays || []).includes(d)) return true;
    return d === last && (s.monthDays || []).some((x) => x > last);   // 그 달에 없는 날은 마지막 날에(겹치면 한 번)
  }
  return false;
}

function occOnDay(s, y, mo, d, offsetMin) {
  const t = parseTime(s.time);
  return t ? localMs(y, mo, d, t.h, t.mi, offsetMin) : null;
}

/** after 보다 **뒤**(>)의 첫 실행 시각. 없으면 null(1회 일정이 이미 지났음 등). */
export function nextOccurrence(s, after, offsetMin = DAY_OFFSET_MIN) {
  if (!s || !SCHEDULE_KINDS.includes(s.kind)) return null;
  if (s.kind === 'once') {
    const p = parseDate(s.date); const t = parseTime(s.time);
    if (!p || !t) return null;
    const occ = localMs(p.y, p.mo, p.d, t.h, t.mi, offsetMin);
    return occ > after ? occ : null;
  }
  const base = localParts(after, offsetMin);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = new Date(Date.UTC(base.y, base.mo - 1, base.d + i));
    const y = day.getUTCFullYear(); const mo = day.getUTCMonth() + 1; const d = day.getUTCDate(); const wd = day.getUTCDay();
    if (!matchDay(s, y, mo, d, wd)) continue;
    const occ = occOnDay(s, y, mo, d, offsetMin);
    if (occ != null && occ > after) return occ;
  }
  return null;
}

/** at **이하**(≤)의 가장 최근 실행 시각. 없으면 null. */
export function prevOccurrence(s, at, offsetMin = DAY_OFFSET_MIN) {
  if (!s || !SCHEDULE_KINDS.includes(s.kind)) return null;
  if (s.kind === 'once') {
    const p = parseDate(s.date); const t = parseTime(s.time);
    if (!p || !t) return null;
    const occ = localMs(p.y, p.mo, p.d, t.h, t.mi, offsetMin);
    return occ <= at ? occ : null;
  }
  const base = localParts(at, offsetMin);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = new Date(Date.UTC(base.y, base.mo - 1, base.d - i));
    const y = day.getUTCFullYear(); const mo = day.getUTCMonth() + 1; const d = day.getUTCDate(); const wd = day.getUTCDay();
    if (!matchDay(s, y, mo, d, wd)) continue;
    const occ = occOnDay(s, y, mo, d, offsetMin);
    if (occ != null && occ <= at) return occ;
  }
  return null;
}

/**
 * 일정 목록 검사 — 새 일정에 id·since 를 붙이고, 정의가 바뀐 일정은 since 를 지금으로 다시 잡는다
 * (바꾸자마자 지난 시각을 소급 실행하지 않게). 꺼 두었다가 켠 일정도 since 를 다시 잡는다.
 * @returns {{ok:true, schedules:object[]}|{ok:false, errors:{index:number, field:string, reason:string}[]}}
 */
export function checkSchedules(list, { prev = [], now = Date.now(), newId } = {}) {
  if (!Array.isArray(list)) return { ok: false, errors: [{ index: -1, field: 'schedules', reason: '일정 목록은 배열이어야 합니다' }] };
  if (list.length > SCHEDULE_MAX) return { ok: false, errors: [{ index: -1, field: 'schedules', reason: `일정은 ${SCHEDULE_MAX}개까지입니다` }] };
  const prevBy = new Map((Array.isArray(prev) ? prev : []).filter((p) => p?.id).map((p) => [p.id, p]));
  const errors = []; const out = []; const used = new Set();
  const mkId = typeof newId === 'function' ? newId : () => `s-${Math.random().toString(16).slice(2, 8)}`;
  list.forEach((raw, index) => {
    const c = checkSchedule(raw);
    if (!c.ok) { errors.push({ index, field: c.field, reason: c.reason }); return; }
    const s = c.sched;
    if (!s.id || used.has(s.id)) { let id = mkId(); while (used.has(id) || prevBy.has(id)) id = mkId(); s.id = id; }
    used.add(s.id);
    const p = prevBy.get(s.id);
    const keep = p && sameDefinition(p, s) && (p.enabled || !s.enabled) && Number(p.since) > 0;
    s.since = keep ? Number(p.since) : now;
    out.push(s);
  });
  return errors.length ? { ok: false, errors } : { ok: true, schedules: out };
}

/**
 * 그 일정의 실제 `since` — 시계가 뒤로 가서 since 가 미래였던 것을 지금으로 다시 잡았으면(`rebaseClock` 이 기록에 남긴
 * `sinceFrom`·`sinceCap`) **그 since 값일 때만** 잡은 값을 쓴다. 일정을 다시 고치면 since 가 바뀌므로 옛 보정은 저절로 빠진다.
 */
export function effectiveSince(s, rec) {
  const since = Number(s?.since) || 0;
  const cap = Number(rec?.sinceCap);
  if (since > 0 && Number.isFinite(cap) && cap > 0 && Number(rec?.sinceFrom) === since) return Math.min(since, cap);
  return since;
}

/**
 * 시계가 뒤로 간 흔적 보정(순수, v2.740 감사 B-09 — 재현). 처리 기록(`lastAt`)이나 일정의 `since` 가 지금보다 `tolMs` 넘게 뒤면,
 * 그 시각까지 예약이 한 번도 서지 않는다(NTP 보정으로 몇 시간 뒤로 가면 그 몇 시간 동안 측정이 없다). 그런 기록은 믿지 않고
 * **지금으로** 다시 잡는다 — 지금 이전 시각은 처리한 것으로 보고(소급 실행하지 않는다) 그 뒤 시각부터 예정대로 돈다.
 * since 는 설정 파일을 고치지 않고 기록에 `sinceFrom`(원래 since)·`sinceCap`(잡은 시각)으로 남긴다(설정 파일을 배경 틱이 쓰지 않게).
 * @returns {{state:object, rebased:{id:string, from:number, field:'lastAt'|'since'}[]}}
 */
export function rebaseClock({ settings = {}, state = {}, now = Date.now(), tolMs = CLOCK_TOL_MS } = {}) {
  const out = { ...(state || {}) };
  const rebased = [];
  for (const s of Array.isArray(settings.schedules) ? settings.schedules : []) {
    if (!s?.id) continue;
    const rec = out[s.id] || null;
    const last = Number(rec?.lastAt);
    const since = effectiveSince(s, rec);
    const lastFuture = Number.isFinite(last) && last > now + tolMs;
    const sinceFuture = since > now + tolMs;
    if (!lastFuture && !sinceFuture) continue;
    const next = { ...(rec || {}), lastAt: lastFuture ? now : Math.max(Number.isFinite(last) ? last : 0, now), result: 'missed', reason: 'clock', at: now };
    if (lastFuture) next.clockFrom = last;
    if (sinceFuture) { next.sinceFrom = Number(s.since); next.sinceCap = now; }
    out[s.id] = next;
    rebased.push({ id: s.id, from: lastFuture ? last : since, field: lastFuture ? 'lastAt' : 'since' });
  }
  return { state: out, rebased };
}

/**
 * 한 틱의 판정(순수).
 * @param {object} a
 * @param {object} a.settings   정리된 설정(intervalOn·intervalMs·schedules)
 * @param {object} a.state      { [id]: { lastAt } } — 일정마다 마지막으로 처리한 실행 시각
 * @param {number} a.now
 * @param {number|null} a.lastRunAt  마지막 실행 시작(간격 판정 — 없으면 바로 실행)
 * @param {number} a.bootAt     이 프로세스 기동 시각(놓침 사유 '포탈 꺼짐' 판정)
 * @param {boolean} a.enabled   자동 측정 켜짐(꺼져 있으면 지난 시각을 전부 'off' 로 넘긴다 — 켠 뒤 소급 실행하지 않게)
 * @param {(occ:number)=>boolean} [a.wasBusy]  그 시각에 측정이 돌고 있었는가
 * @returns {{run:boolean, interval:boolean, fire:{id:string,occ:number}[], missed:{id:string,occ:number,reason:string}[]}}
 */
export function planTick({ settings = {}, state = {}, now = Date.now(), lastRunAt = null, bootAt = 0, enabled = true, wasBusy = () => false, offsetMin = DAY_OFFSET_MIN } = {}) {
  const fire = []; const missed = [];
  for (const s of Array.isArray(settings.schedules) ? settings.schedules : []) {
    if (!s?.enabled || !s.id) continue;
    const occ = prevOccurrence(s, now, offsetMin);
    if (occ == null) continue;
    const base = Math.max(effectiveSince(s, state?.[s.id]), Number(state?.[s.id]?.lastAt) || 0);
    if (occ <= base) continue;
    if (!enabled) { missed.push({ id: s.id, occ, reason: 'off' }); continue; }
    if (now - occ <= GRACE_MS) { fire.push({ id: s.id, occ }); continue; }
    missed.push({ id: s.id, occ, reason: occ < bootAt ? 'down' : wasBusy(occ) ? 'busy' : 'late' });
  }
  const iv = Number(settings.intervalMs);
  const interval = !!enabled && settings.intervalOn !== false && Number.isFinite(iv) && iv > 0
    && (lastRunAt == null || now >= Number(lastRunAt) + iv);
  return { run: interval || fire.length > 0, interval, fire, missed };
}

/** 다음 실행 예정(상태 표시용) — 간격과 예약 중 가장 이른 것. 꺼져 있으면 null. */
export function nextRunOf({ settings = {}, state = {}, now = Date.now(), lastRunAt = null, enabled = true, offsetMin = DAY_OFFSET_MIN } = {}) {
  if (!enabled) return null;
  const cands = [];
  const iv = Number(settings.intervalMs);
  if (settings.intervalOn !== false && Number.isFinite(iv) && iv > 0) cands.push({ at: lastRunAt == null ? now : Number(lastRunAt) + iv, kind: 'interval', id: null });
  for (const s of Array.isArray(settings.schedules) ? settings.schedules : []) {
    if (!s?.enabled) continue;
    const after = Math.max(now - 1, effectiveSince(s, state?.[s.id]), Number(state?.[s.id]?.lastAt) || 0);
    const at = nextOccurrence(s, after, offsetMin);
    if (at != null) cands.push({ at, kind: 'schedule', id: s.id });
  }
  cands.sort((a, b) => a.at - b.at);
  return cands[0] || null;
}

/**
 * 측정 간격(최악) — 화면의 '오래된 측정' 판정과 회선 사용 산수가 쓴다. 간격 실행이 켜져 있으면 그 간격,
 * 아니면 반복 일정들의 실행 시각 사이 가장 긴 간격. 반복 일정이 없으면 null(정해진 주기가 없다).
 */
export function cadenceMs(settings = {}, { now = Date.now(), offsetMin = DAY_OFFSET_MIN } = {}) {
  const iv = Number(settings.intervalMs);
  if (settings.intervalOn !== false && Number.isFinite(iv) && iv > 0) return iv;
  const rec = (Array.isArray(settings.schedules) ? settings.schedules : []).filter((s) => s?.enabled && s.kind !== 'once');
  if (!rec.length) return null;
  const occ = new Set();
  const from = now - 31 * DAY; const to = now + 62 * DAY;
  for (const s of rec) {
    let at = from;
    for (let i = 0; i < 200; i++) {
      const n = nextOccurrence(s, at, offsetMin);
      if (n == null || n > to) break;
      occ.add(n); at = n;
    }
  }
  const list = [...occ].sort((a, b) => a - b);
  if (list.length < 2) return null;
  let gap = 0;
  for (let i = 1; i < list.length; i++) gap = Math.max(gap, list[i] - list[i - 1]);
  return gap;
}

/** 하루 평균 실행 횟수(회선 사용 산수 — 간격 + 반복 일정. 예약 실행이 간격을 다시 세게 하므로 **최대치**다). */
export function runsPerDay(settings = {}) {
  let n = 0;
  const iv = Number(settings.intervalMs);
  if (settings.intervalOn !== false && Number.isFinite(iv) && iv > 0) n += Math.floor(DAY / Math.max(60_000, iv));
  for (const s of Array.isArray(settings.schedules) ? settings.schedules : []) {
    if (!s?.enabled) continue;
    if (s.kind === 'daily') n += 1;
    else if (s.kind === 'weekly') n += (s.days || []).length / 7;
    else if (s.kind === 'monthly') n += Math.min(31, (s.monthDays || []).length) * 12 / 365;
  }
  return Math.round(n * 100) / 100;
}
