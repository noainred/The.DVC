/**
 * wiki/userState.js — 위키 사용자별 작은 상태(v2.887 · 시안 §4.4 개인화 · C-2): 즐겨찾기 · 최근 본 문서 · 조회 수(대문 '많이 본 문서 30일').
 *
 * 파일 `wiki-user.json` `{ v:1, users:{ [사용자]: { fav:[id], recent:[{id,at}], today:{day, ids:[id]} } }, views:{ [id]: { [day]: n } } }`.
 *  · 조회 수는 **사람 · 날(포탈 날짜) · 문서마다 한 번** — 같은 사람이 하루에 여러 번 열거나 새로 고쳐도 1(순위를 새로 고침으로 만들지 않게).
 *    중복 판정용 `today` 는 그날 것만 들고 날이 바뀌면 비운다(사람 × 문서 표가 자라지 않게).
 *  · 상한: 즐겨찾기 50 · 최근 20 · 하루 중복 기록 500 · 사용자 5000 · 날 31(지난 날은 그 문서를 쓸 때와 읽을 때 지운다).
 *    사용자 상한을 넘은 새 사용자는 기록하지 않고 `recorded:false` 로 밝힌다(조용히 다른 사람 것을 지우지 않는다).
 *  · 저장된 id 를 믿지 않는다 — 목록을 돌려줄 때 위키 저장소가 **지금 범위로 다시 거른다**(범위가 줄었거나 지워진 문서는 빠진다).
 *  · 쓰기는 util/userDocWriter.js(디바운스 · 비동기 원자 쓰기) — 문서 열기마다 파일을 쓰지 않는다. 손상은 보존하고 빈 상태로 시작.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { createUserDocWriter } from '../util/userDocWriter.js';
import { dayIndex } from '../util/dayKey.js';

export const USER_LIMITS = Object.freeze({ fav: 50, recent: 20, todayIds: 500, users: 5000, days: 31, popular: 8 });
export const POPULAR_DAYS = 30;
export const wikiUserFile = () => path.join(config.configDir, 'wiki-user.json');
const PAGE_ID_RE = /^W\d{1,9}$/;
const USER_RE = /^[^\u0000-\u001f\u007f]{1,128}$/; // eslint-disable-line no-control-regex

let cache = null; // { users:Object, views:Object }
const writer = createUserDocWriter({
  tag: 'wiki-user', file: wikiUserFile,
  serialize: () => (cache ? JSON.stringify({ v: 1, users: cache.users, views: cache.views }) : null),
});

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function cleanUser(u) {
  if (!isObj(u)) return null;
  const fav = (Array.isArray(u.fav) ? u.fav : []).filter((id) => typeof id === 'string' && PAGE_ID_RE.test(id));
  const recent = (Array.isArray(u.recent) ? u.recent : []).filter((r) => isObj(r) && typeof r.id === 'string' && PAGE_ID_RE.test(r.id) && Number.isFinite(r.at));
  const today = isObj(u.today) && Number.isInteger(u.today.day) && Array.isArray(u.today.ids)
    ? { day: u.today.day, ids: u.today.ids.filter((id) => typeof id === 'string' && PAGE_ID_RE.test(id)).slice(-USER_LIMITS.todayIds) } : null;
  return { fav: [...new Set(fav)].slice(0, USER_LIMITS.fav), recent: recent.slice(0, USER_LIMITS.recent), ...(today ? { today } : {}) };
}
function cleanDays(m, minDay) {
  const out = {};
  if (!isObj(m)) return out;
  for (const [d, n] of Object.entries(m)) { const di = Number(d); if (Number.isInteger(di) && di >= minDay && Number.isInteger(n) && n > 0) out[d] = n; }
  return out;
}
function load(now = Date.now()) {
  if (cache) return cache;
  const file = wikiUserFile();
  const users = {}; const views = {};
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isObj(j) || !isObj(j.users)) throw new Error('users 객체가 없습니다');
      for (const [name, u] of Object.entries(j.users)) { if (!USER_RE.test(name)) continue; const c = cleanUser(u); if (c) users[name] = c; }
      const minDay = dayIndex(now) - USER_LIMITS.days + 1;
      for (const [id, m] of Object.entries(isObj(j.views) ? j.views : {})) { if (!PAGE_ID_RE.test(id)) continue; const c = cleanDays(m, minDay); if (Object.keys(c).length) views[id] = c; }
    }
  } catch (e) {
    preserveCorrupt(file, e.message);
    console.warn(`[wiki] wiki-user.json 을 읽지 못해 빈 상태(즐겨찾기 · 최근 · 조회 수)로 시작합니다: ${safeLoadText(e) || '사유 미상'}`);
    for (const k of Object.keys(users)) delete users[k];
    for (const k of Object.keys(views)) delete views[k];
  }
  cache = { users, views };
  return cache;
}
function userOf(c, name, { create = false } = {}) {
  if (typeof name !== 'string' || !USER_RE.test(name)) return null;
  if (c.users[name]) return c.users[name];
  if (!create || Object.keys(c.users).length >= USER_LIMITS.users) return null;
  c.users[name] = { fav: [], recent: [] };
  return c.users[name];
}

/** 문서를 연 기록 — 최근 본 문서 맨 앞 + (그날 처음이면) 조회 수 +1. 호출부가 그 문서를 볼 수 있음을 이미 확인했다(getPage 뒤). */
export function recordView(user, id, now = Date.now()) {
  if (!PAGE_ID_RE.test(String(id))) return { recorded: false };
  const c = load(now);
  const u = userOf(c, user, { create: true });
  if (!u) return { recorded: false };
  u.recent = [{ id, at: now }, ...u.recent.filter((r) => r.id !== id)].slice(0, USER_LIMITS.recent);
  const day = dayIndex(now);
  if (!u.today || u.today.day !== day) u.today = { day, ids: [] };
  let counted = false;
  if (!u.today.ids.includes(id) && u.today.ids.length < USER_LIMITS.todayIds) {
    u.today.ids.push(id);
    const minDay = day - USER_LIMITS.days + 1;
    const m = cleanDays(c.views[id], minDay);
    m[day] = (m[day] || 0) + 1;
    c.views[id] = m;
    counted = true;
  }
  writer.changed();
  return { recorded: true, counted };
}

/** 즐겨찾기 켜기/끄기 — 상태를 명시한다(재전송이 두 번 바꾸지 않게). 상한을 넘으면 409. */
export function setFavorite(user, id, on) {
  if (!PAGE_ID_RE.test(String(id))) { const e = new Error('없는 문서입니다'); e.status = 404; throw e; }
  const c = load();
  const u = userOf(c, user, { create: !!on });
  if (!u) {
    if (!on) return { fav: false };
    const e = new Error('즐겨찾기를 기록할 수 있는 사용자 수를 넘었습니다 — 관리자에게 알려 주세요'); e.status = 409; throw e;
  }
  const has = u.fav.includes(id);
  if (on && !has) {
    if (u.fav.length >= USER_LIMITS.fav) { const e = new Error(`즐겨찾기는 ${USER_LIMITS.fav}개까지입니다 — 하나를 빼고 다시 하세요`); e.status = 409; throw e; }
    u.fav = [id, ...u.fav];
    writer.changed();
  } else if (!on && has) {
    u.fav = u.fav.filter((x) => x !== id);
    writer.changed();
  }
  return { fav: !!on };
}

/** 이 사용자의 즐겨찾기 · 최근 본 문서 id(저장 순). 범위 거르기는 호출부(위키 저장소 metasFor)가 한다. */
export function userLists(user) {
  const u = userOf(load(), user);
  return { fav: u ? [...u.fav] : [], recent: u ? u.recent.map((r) => ({ id: r.id, at: r.at })) : [] };
}
export const isFavorite = (user, id) => !!userOf(load(), user)?.fav.includes(id);

/** 최근 days 일 조회 수 — Map(id → n). 오늘을 포함한다. */
export function viewCounts({ days = POPULAR_DAYS, now = Date.now() } = {}) {
  const c = load(now);
  const minDay = dayIndex(now) - days + 1;
  const out = new Map();
  for (const [id, m] of Object.entries(c.views)) {
    let n = 0;
    for (const [d, k] of Object.entries(m)) if (Number(d) >= minDay) n += k;
    if (n > 0) out.set(id, n);
  }
  return out;
}

/** 문서가 지워지면 그 문서의 조회 수 · 즐겨찾기 · 최근 기록을 지운다(위키 저장소 이벤트에서). */
export function forgetPage(id) {
  const c = load();
  let changed = false;
  if (c.views[id]) { delete c.views[id]; changed = true; }
  for (const u of Object.values(c.users)) {
    if (u.fav.includes(id)) { u.fav = u.fav.filter((x) => x !== id); changed = true; }
    if (u.recent.some((r) => r.id === id)) { u.recent = u.recent.filter((r) => r.id !== id); changed = true; }
  }
  if (changed) writer.changed();
  return changed;
}

export const flushWikiUserNow = () => writer.flushNow();
export const wikiUserIdle = (o) => writer.idle(o);
export function _resetWikiUserCache() { writer.reset(); cache = null; }
