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
 * ⚠⚠ 서버 대상은 **(법인, 키) 쌍**이다(반증 F1 — IP 로 등록한 iDRAC 은 키 = IP 라 사설 대역을 겹쳐 쓰는 법인끼리 키가 같다): 서버 창은 창의 법인과
 *   대상의 법인이 같을 때만 맞는다(태그 · 법인 창과 같은 규칙). 대상 식별은 targetIdOf 하나(함대 요약 · 음영이 같은 함수).
 * ⚠ 중앙이 펼쳐 보낸 태그 창(origin 'central')은 **펼친 keys 만**으로 맞춘다(반증 F10 — 엣지 로컬 용도 태그로 넓히면 엣지 판정 ≠ 중앙 판정).
 * ⚠ 지운 창은 **묘비**(deleted.at)다: 지금 판정(maintStateFor)에서는 빠지고, 지난 구간(coverIntervals — ⑤ 분모 제외 · 추이 음영 · 변경 묶음)에는
 *   **지운 시각까지** 남는다(소급 소거 금지 — 그때 정비였던 사실은 지운 뒤에도 그때의 일이다). 묘비는 보관 90일(store.KEEP_ENDED_DAYS)까지.
 * ⚠ 요청 경로 비용(반증 F6): windowStatus 는 다음 · 지난 발생을 **지금에서 바깥으로 조각 탐색**한다(400일 전부를 세지 않는다).
 */
import { occurrencesBetween, occurrenceAt, maxMinOf, MIN, DAY } from './schedule.js';

export const SCOPES = Object.freeze(['alerts', 'hold', 'focus', 'collect', 'exclude']);
export const TARGET_KINDS = Object.freeze(['server', 'tag', 'corp']);
/** 반복 창 재확인 주기(일) — 지나면 억제하지 않는다(설계 ‘90일 이상 반복 창은 분기마다 재확인’ 을 시한으로 — 알림만이 아니라 멈춘다). */
export const RECUR_CONFIRM_DAYS = 92;
export const TAG_RE = /^(role|app):[a-z0-9][a-z0-9._-]{0,47}$/;
const t = (v) => String(v ?? '').trim();

/** 대상이 창의 대상인가(순수). tagsOf(target) → ['role:web','app:gpdb', …] — 중앙은 수동 태그로, 엣지는 [](배포본 keys 로 맞춘다). */
/** 대상 식별(순수) — 서버는 (법인, 키) 쌍. 같은 키 · 다른 법인은 다른 서버다(반증 F1). */
export const targetIdOf = (x) => `${t(x?.vcenterId)}|${t(x?.key)}`;

export function matchTarget(w, target, { tagsOf = null } = {}) {
  const tg = w?.target;
  if (!tg || !target) return false;
  const key = t(target.key);
  // 모든 대상 종류가 법인을 먼저 본다(법인 간 대상 금지 — 서버 창도 키만으로 다른 법인 서버를 덮지 않는다).
  if (!t(w.vcenterId) || t(target.vcenterId) !== t(w.vcenterId)) return false;
  if (tg.kind === 'server') return !!key && Array.isArray(tg.keys) && tg.keys.includes(key);
  if (tg.kind === 'corp') return true;
  if (tg.kind === 'tag') {
    // 태그 창 — 배포본은 중앙이 펼친 keys **만**(엣지 로컬 태그로 넓히지 않는다), 중앙은 수동 태그.
    if (Array.isArray(tg.keys) && key && tg.keys.includes(key)) return true;
    if (w.origin === 'central') return false;
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
 * [from, to) 와 겹치는 **유효 발생**(순수) — ‘지금 끝내기’ 로 자른 끝 · 만료 뒤 발생 없음 · 길이 상한(일정 계산이 이미 자름).
 *   지운 창: 기본은 없음(지금 판정 · 상태). history=true(지난 구간 — coverIntervals)면 **지운 시각까지**의 발생(묘비 — 소급 소거 금지).
 * @returns {Array<{start:number, end:number, cut?:boolean, deleted?:boolean}>}
 */
export function effectiveOccurrences(w, from, to, { history = false } = {}) {
  if (!w || !w.schedule) return [];
  const del = w.deleted ? Number(w.deleted.at) : null;
  if (w.deleted && !(history && Number.isFinite(del))) return [];
  const exp = expiresAt(w);
  const list = occurrencesBetween(w.schedule, w.tz, from, Math.min(to, del ?? to));
  const out = [];
  for (const o of list) {
    if (exp != null && o.start >= exp) continue;
    let end = Math.min(o.end, o.start + maxMinOf(w.schedule) * MIN);
    let cut = false; let gone = false;
    const ea = Number(w.endedAt);
    if (Number.isFinite(ea) && ea < end && (w.schedule.kind === 'once' || Number(w.endedOccStart) === o.start)) { end = Math.max(o.start, ea); cut = true; }
    if (del != null && del < end) { end = Math.max(o.start, del); gone = true; }
    if (end > o.start && end > from && o.start < to) out.push({ start: o.start, end, ...(cut ? { cut: true } : {}), ...(gone ? { deleted: true } : {}) });
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
export function coverIntervals(windows = [], target = null, from, to, { scope = null, tagsOf = null, only = null } = {}) {
  const iv = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    if (scope && w?.scopes?.[scope] !== true) continue;
    if (typeof only === 'function' && !only(w)) continue;
    if (!matchTarget(w, target, { tagsOf })) continue;
    for (const o of effectiveOccurrences(w, from, to, { history: true })) iv.push({ from: Math.max(from, o.start), to: Math.min(to, o.end), id: t(w.id), name: t(w.name) });
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
/** 지금 뒤에 시작하는 첫 유효 발생(순수 — 조각 탐색: 3일부터 두 배씩 · 64일 상한 · 400일까지 · 만료 시각에서 멈춤). */
export function nextOccurrence(w, now, horizonDays = 400) {
  if (!w || w.deleted || !w.schedule) return null;
  const end = now + horizonDays * DAY;
  if (w.schedule.kind === 'once') return effectiveOccurrences(w, now, end).find((o) => o.start > now) || null;
  const exp = expiresAt(w);
  let from = now; let step = 3 * DAY;
  while (from < end) {
    const to = Math.min(end, from + step);
    const hit = effectiveOccurrences(w, from, to).find((o) => o.start > now);
    if (hit) return hit;
    if (exp != null && to >= exp) return null;
    from = to; step = Math.min(step * 2, 64 * DAY);
  }
  return null;
}
/** 지금까지 끝난 가장 최근 유효 발생(순수 — 90일 안 · 지금에서 거꾸로 조각 탐색). */
export function lastOccurrence(w, now, backDays = 90) {
  if (!w || w.deleted || !w.schedule) return null;
  const stop = now - backDays * DAY;
  if (w.schedule.kind === 'once') { const p = effectiveOccurrences(w, stop, now).filter((o) => o.end <= now); return p.length ? p[p.length - 1] : null; }
  let to = now; let step = 3 * DAY;
  while (to > stop) {
    const from = Math.max(stop, to - step);
    const p = effectiveOccurrences(w, from, to).filter((o) => o.end <= now);
    if (p.length) return p[p.length - 1];
    to = from; step = Math.min(step * 2, 64 * DAY);
  }
  return null;
}
export function windowStatus(w, now = Date.now()) {
  if (!w) return { status: 'ended' };
  if (w.deleted) return { status: 'deleted' };
  const cur = activeOccurrence(w, now);
  const exp = expiresAt(w);
  const last = lastOccurrence(w, now);
  if (cur) return { status: 'active', current: cur, next: nextOccurrence(w, now), last, remainingMs: cur.end - now, expiresAt: exp };
  if (exp != null && exp <= now) return { status: 'expired', next: null, last, expiresAt: exp };
  const next = nextOccurrence(w, now);
  if (next) return { status: 'scheduled', next, last, expiresAt: exp };
  return { status: 'ended', last, expiresAt: exp };
}
