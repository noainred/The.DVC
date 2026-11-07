/**
 * bmusage/maint/judge.js — 리눅스 성능 8a단계 **‘지금 이 서버가 어떤 억제 아래인가’ 판정 코어 하나**(순수 — 설계 PROFILES §20 ⑲).
 *
 * 서버(중앙) · 엣지 · 화면이 같은 함수를 쓴다(웹은 이 결과를 API 로 받는다 — 판정을 복제하지 않는다). 엣지는 중앙 배포본을 같은 정규화(store.normalizeWindow)로
 *   다시 자른 뒤 이 함수에 넣는다 — 테스트가 같은 입력으로 중앙 판정 = 엣지 판정을 대조한다(maint8a 판정 대조).
 *
 * 억제 범위 5종(켠 것만 저장):
 *   alerts  ① 알림 발송 억제 — 판정 · 초과 기록은 그대로, 발송만 막는다(창 뒤에도 초과면 그때 1회 · ‘창 안부터 초과’)
 *   hold    ② 파트 장애 전이 보류(HOLD_REASON maintenance) — 열린 장애를 닫지 않고, 새 장애를 열지 않는다(창 끝 뒤 주기에 재판정)
 *   focus   ③ 자동 집중 억제(수동 집중은 허용)
 *   collect ④ 수집 중단(기본 꺼짐 — ‘정비 중’ 상태 · 실패로 세지 않는다)
 *   exclude ⑤ 목표선 분모 · 베이스라인 롤업 · 용량 예측 추세 창에서 제외
 * ⚠⚠ 억제에는 반드시 시한(루트 CLAUDE.md ‘보류에는 반드시 시한’): 판정은 **발생(occurrence)의 끝**까지만이고 그 끝은 길이 상한(일회 24h · 반복 12h)으로
 *   다시 자른다 · 반복 창은 확인(confirmedAt) 뒤 RECUR_CONFIRM_DAYS 가 지나면 **만료**(억제하지 않는다 — 재확인 필요) · ‘지금 끝내기’ 는 그 발생을 끊는다.
 * ⚠ 인증 거부는 이 판정과 무관하다(util/authGuard — 창 안에서도 즉시 정지) — 이 모듈은 인증 경로를 모른다.
 * ⚠ 모르는 값(형식 밖 일정 · 시간대)은 억제가 아니다 — 빈 발생 = 억제 없음(알림이 나가는 쪽으로).
 */
import { occurrencesBetween, occurrenceAt, maxMinOf, MIN, DAY } from './schedule.js';

export const SCOPES = Object.freeze(['alerts', 'hold', 'focus', 'collect', 'exclude']);
export const TARGET_KINDS = Object.freeze(['server', 'tag', 'corp']);
/** 반복 창 재확인 주기(일) — 지나면 억제하지 않는다(설계 ‘90일 이상 반복 창은 분기마다 재확인’ 을 시한으로 — 알림만이 아니라 멈춘다). */
export const RECUR_CONFIRM_DAYS = 92;
export const TAG_RE = /^(role|app):[a-z0-9][a-z0-9._-]{0,47}$/;
const t = (v) => String(v ?? '').trim();

/** 대상이 창의 대상인가(순수). tagsOf(target) → ['role:web','app:gpdb', …] — 중앙은 수동 태그로, 엣지는 [](배포본 keys 로 맞춘다). */
export function matchTarget(w, target, { tagsOf = null } = {}) {
  const tg = w?.target;
  if (!tg || !target) return false;
  const key = t(target.key);
  if (tg.kind === 'server') return !!key && Array.isArray(tg.keys) && tg.keys.includes(key);
  if (tg.kind === 'corp') return !!t(w.vcenterId) && t(target.vcenterId) === t(w.vcenterId);
  if (tg.kind === 'tag') {
    // 태그 창은 그 법인 안에서만(법인 간 대상 금지) — 배포본은 중앙이 펼친 keys, 중앙은 수동 태그.
    if (!t(w.vcenterId) || t(target.vcenterId) !== t(w.vcenterId)) return false;
    if (Array.isArray(tg.keys) && key && tg.keys.includes(key)) return true;
    if (typeof tagsOf === 'function') { try { return (tagsOf(target) || []).includes(tg.tag); } catch { return false; } }
    return false;
  }
  return false;
}

/** 반복 창 만료 시각(재확인 기준) — 일회 창은 null. */
export function expiresAt(w) {
  if (!w || w.schedule?.kind === 'once') return null;
  const c = Number(w.confirmedAt ?? w.at);
  return Number.isFinite(c) ? c + RECUR_CONFIRM_DAYS * DAY : 0;
}

/**
 * [from, to) 와 겹치는 **유효 발생**(순수) — 지운 창 없음 · ‘지금 끝내기’ 로 자른 끝 · 만료 뒤 발생 없음 · 길이 상한(일정 계산이 이미 자름).
 * @returns {Array<{start:number, end:number, cut?:boolean}>}
 */
export function effectiveOccurrences(w, from, to) {
  if (!w || w.deleted || !w.schedule) return [];
  const exp = expiresAt(w);
  const list = occurrencesBetween(w.schedule, w.tz, from, to);
  const out = [];
  for (const o of list) {
    if (exp != null && o.start >= exp) continue;
    let end = Math.min(o.end, o.start + maxMinOf(w.schedule) * MIN);
    let cut = false;
    const ea = Number(w.endedAt);
    if (Number.isFinite(ea) && ea < end && (w.schedule.kind === 'once' || Number(w.endedOccStart) === o.start)) { end = Math.max(o.start, ea); cut = true; }
    if (end > o.start && end > from && o.start < to) out.push({ start: o.start, end, ...(cut ? { cut: true } : {}) });
  }
  return out;
}
/** now 를 덮는 유효 발생(없으면 null). */
export function activeOccurrence(w, now) {
  if (!w || w.deleted || !w.schedule) return null;
  const o = occurrenceAt(w.schedule, w.tz, now);
  if (!o) return null;
  return effectiveOccurrences(w, o.start, o.end).find((x) => x.start === o.start && now < x.end) || null;
}

/**
 * **판정 코어** — 지금 이 서버가 어떤 억제 아래인가(순수).
 * @returns {{ active:boolean, scopes:Record<string,boolean>, until:Record<string,number|null>, windows:Array<{id,name,start,end,scopes}> }}
 *   겹치는 창은 합집합(설계) — 범위마다 그 범위를 켠 창 중 가장 늦은 끝까지.
 */
export function maintStateFor(windows = [], target = null, now = Date.now(), { tagsOf = null } = {}) {
  const scopes = Object.fromEntries(SCOPES.map((s) => [s, false]));
  const until = Object.fromEntries(SCOPES.map((s) => [s, null]));
  const hit = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!matchTarget(w, target, { tagsOf })) continue;
    const o = activeOccurrence(w, now);
    if (!o) continue;
    const on = SCOPES.filter((s) => w.scopes?.[s] === true);
    hit.push({ id: t(w.id), name: t(w.name), start: o.start, end: o.end, scopes: on, origin: w.origin || 'local' });
    for (const s of on) { scopes[s] = true; until[s] = Math.max(until[s] ?? 0, o.end); }
  }
  return { active: hit.length > 0, scopes, until, windows: hit };
}

/** [from, to) 안에서 그 범위(scope)를 켠 창이 이 서버를 덮는 구간(합쳐서 · 오름차순 — 순수). ⑤ 제외 · 추이 음영 · 변경 이벤트 묶음이 쓴다. */
export function coverIntervals(windows = [], target = null, from, to, { scope = null, tagsOf = null } = {}) {
  const iv = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    if (scope && w?.scopes?.[scope] !== true) continue;
    if (!matchTarget(w, target, { tagsOf })) continue;
    for (const o of effectiveOccurrences(w, from, to)) iv.push({ from: Math.max(from, o.start), to: Math.min(to, o.end), id: t(w.id), name: t(w.name) });
  }
  iv.sort((a, b) => a.from - b.from);
  const merged = [];
  for (const x of iv) {
    const last = merged[merged.length - 1];
    if (last && x.from <= last.to) { last.to = Math.max(last.to, x.to); if (!last.ids.includes(x.id)) last.ids.push(x.id); }
    else merged.push({ from: x.from, to: x.to, ids: [x.id] });
  }
  return merged;
}
/** 시각이 구간 안인가(이분 탐색 — 순수). */
export function inIntervals(ts, intervals = []) {
  let lo = 0; let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1; const x = intervals[mid];
    if (ts < x.from) hi = mid - 1; else if (ts >= x.to) lo = mid + 1; else return true;
  }
  return false;
}

/**
 * 창 상태(목록 화면 — 순수). status: active(진행 중) · scheduled(예정) · ended(끝남) · expired(반복 재확인 만료) · deleted.
 *   current = 진행 중인 발생 · next = 다음 발생 · last = 가장 최근에 끝난 발생(90일 안).
 */
export function windowStatus(w, now = Date.now()) {
  if (!w) return { status: 'ended' };
  if (w.deleted) return { status: 'deleted' };
  const cur = activeOccurrence(w, now);
  const exp = expiresAt(w);
  const next = effectiveOccurrences(w, now, now + 400 * DAY).find((o) => o.start > now) || null;
  const past = effectiveOccurrences(w, now - 90 * DAY, now).filter((o) => o.end <= now);
  const last = past.length ? past[past.length - 1] : null;
  if (cur) return { status: 'active', current: cur, next, last, remainingMs: cur.end - now, expiresAt: exp };
  if (exp != null && exp <= now) return { status: 'expired', next: null, last, expiresAt: exp };
  if (next) return { status: 'scheduled', next, last, expiresAt: exp };
  return { status: 'ended', last, expiresAt: exp };
}
