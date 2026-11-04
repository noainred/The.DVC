/**
 * issues/filters.js — 저장 필터(v2.882 · 시안 ⑧). 필터는 검색식 한 줄에 이름을 붙인 것이다(보드 · 목록 · 스프린트가 같은 식을 쓴다).
 *
 * 파일 `issue-filters.json` { v:1, filters:[{ id, owner, name, query, shared, createdAt, updatedAt }] } — 비밀 없음 · 동기 원자 쓰기 · 손상 보존.
 *  · 사람마다 50개. 공유(shared)는 **전체 범위 운영자 · 관리자**만 켤 수 있다(라우트가 canShare 로 판정해 넘긴다).
 *  · 보는 것: 내 필터 + 남이 공유한 필터. 범위 계정이 공유 필터를 열어도 결과는 자기 범위로 다시 걸러진다(listIssues 가 범위를 먼저 건다).
 *  · 고치기는 만든 사람만. 지우기는 만든 사람 또는 전체 범위 관리자(isMod — 공유 필터 정리).
 *  · 저장 전에 검색식을 해석해 본다 — 틀린 식은 저장하지 않는다(오류 위치를 그대로 돌려준다).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { parseQuery, QUERY_LIMITS } from './query.js';

export const FILTER_LIMITS = Object.freeze({ perOwner: 50, total: 3000, name: 60, subscribers: 100 });
export const filtersFile = () => path.join(config.configDir, 'issue-filters.json');

let cache = null;
let loadError = null;
export function filtersLoadError() { return loadError; }
export function _resetFiltersCache() { cache = null; loadError = null; }

function load() {
  if (cache) return cache;
  const file = filtersFile();
  let filters = [];
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j || typeof j !== 'object' || !Array.isArray(j.filters)) throw new Error('filters 배열이 없습니다');
      filters = j.filters.filter((f) => f && typeof f === 'object' && typeof f.id === 'string' && typeof f.owner === 'string' && typeof f.query === 'string');
    }
    loadError = null;
  } catch (e) {
    preserveCorrupt(file, e.message);
    loadError = { message: safeLoadText(e) || '사유 미상', at: Date.now() };
    console.warn(`[issues] issue-filters.json 을 읽지 못해 빈 목록으로 시작합니다: ${loadError.message}`);
    filters = [];
  }
  cache = { filters };
  return cache;
}
function save(filters) {
  atomicWriteFileSync(filtersFile(), JSON.stringify({ v: 1, filters }, null, 1), { mode: 0o600 });
  cache = { filters };
}
function fieldError(field, msg, extra) { const e = new Error(`${field}: ${msg}`); e.status = 400; e.field = field; if (extra) e.extra = extra; return e; }
function notFound() { const e = new Error('없는 필터입니다'); e.status = 404; return e; }
function forbidden(msg) { const e = new Error(msg); e.status = 403; return e; }
function conflict(msg) { const e = new Error(msg); e.status = 409; return e; }
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f]/g;
function nameOf(v) {
  if (typeof v !== 'string') throw fieldError('name', '문자열이어야 합니다');
  const s = v.replace(CTRL, ' ').trim();
  if (!s) throw fieldError('name', '비어 있습니다');
  if (s.length > FILTER_LIMITS.name) throw fieldError('name', `${FILTER_LIMITS.name}자까지입니다`);
  return s;
}
function queryOf(v) {
  if (typeof v !== 'string') throw fieldError('query', '문자열이어야 합니다');
  const q = v.replace(CTRL, ' ').trim();
  if (!q) throw fieldError('query', '검색식이 비어 있습니다');
  if (q.length > QUERY_LIMITS.length) throw fieldError('query', `검색식은 ${QUERY_LIMITS.length}자까지입니다`);
  const parsed = parseQuery(q);
  if (parsed.errors.length) throw fieldError('query', `검색식을 읽지 못했습니다 — ${parsed.errors[0].msg}`, { code: 'query', errors: parsed.errors });
  return q;
}

const subsOf = (f) => (Array.isArray(f.subscribers) ? f.subscribers.filter((u) => typeof u === 'string' && u) : []);
const view = (f, me, isMod) => ({
  id: f.id, name: f.name, query: f.query, shared: !!f.shared, owner: f.owner, mine: f.owner === me,
  editable: f.owner === me, deletable: f.owner === me || (!!f.shared && isMod), createdAt: f.createdAt, updatedAt: f.updatedAt || f.createdAt,
  // v2.883 주간 메일 구독 — 내가 구독했는지와 수만(다른 사람 이름은 싣지 않는다)
  subscribed: subsOf(f).includes(me), subscriberCount: subsOf(f).length,
});
/** 내 필터 + 공유 필터 — 내 것 먼저, 이름 순. */
export function listFilters(me, { isMod = false } = {}) {
  const out = load().filters.filter((f) => f.owner === me || f.shared).map((f) => view(f, me, isMod));
  return out.sort((a, b) => (Number(b.mine) - Number(a.mine)) || a.name.localeCompare(b.name));
}
export function createFilter(body, me, { canShare = false } = {}) {
  if (!me) throw forbidden('로그인한 사용자만 필터를 저장할 수 있습니다');
  const b = body || {};
  const { filters } = load();
  if (filters.length >= FILTER_LIMITS.total) throw conflict(`필터는 전체 ${FILTER_LIMITS.total}개까지 보관합니다`);
  if (filters.filter((f) => f.owner === me).length >= FILTER_LIMITS.perOwner) throw conflict(`필터는 한 사람당 ${FILTER_LIMITS.perOwner}개까지입니다`);
  const shared = b.shared === true;
  if (shared && !canShare) throw forbidden('필터 공유는 전체 범위(vCenter 제한 없는) 운영자 · 관리자만 할 수 있습니다');
  const now = Date.now();
  const f = { id: `F${crypto.randomBytes(6).toString('hex')}`, owner: me, name: nameOf(b.name), query: queryOf(b.query), shared, createdAt: now, updatedAt: now };
  save([...filters, f]);
  return view(f, me, false);
}
export function updateFilter(id, body, me, { canShare = false } = {}) {
  const { filters } = load();
  const cur = filters.find((f) => f.id === id);
  if (!cur || (cur.owner !== me && !cur.shared)) throw notFound();
  if (cur.owner !== me) throw forbidden('필터는 만든 사람만 고칠 수 있습니다 — 다른 이름으로 저장하세요');
  const b = body || {};
  const next = { ...cur };
  if (Object.hasOwn(b, 'name')) next.name = nameOf(b.name);
  if (Object.hasOwn(b, 'query')) next.query = queryOf(b.query);
  if (Object.hasOwn(b, 'shared')) {
    const sh = b.shared === true;
    if (sh && !canShare) throw forbidden('필터 공유는 전체 범위(vCenter 제한 없는) 운영자 · 관리자만 할 수 있습니다');
    next.shared = sh;
    // 공유를 끄면 만든 사람 말고는 볼 수 없게 되므로 남의 구독도 내린다(볼 수 없는 필터로 메일이 가지 않게)
    if (!sh) next.subscribers = subsOf(cur).filter((u) => u === cur.owner);
  }
  next.updatedAt = Date.now();
  save(filters.map((f) => (f.id === id ? next : f)));
  return view(next, me, false);
}
export function deleteFilter(id, me, { isMod = false } = {}) {
  const { filters } = load();
  const cur = filters.find((f) => f.id === id);
  if (!cur || (cur.owner !== me && !cur.shared)) throw notFound();
  if (cur.owner !== me && !isMod) throw forbidden('필터는 만든 사람이나 전체 범위 관리자만 지울 수 있습니다');
  save(filters.filter((f) => f.id !== id));
  return { id };
}

/**
 * 주간 메일 구독(v2.883 · 시안 ⑧) — 볼 수 있는 필터(내 것 · 공유)만. 메일은 월요일 09:00(포탈 날짜)에 issues/notify.js 가 보내고,
 * 결과는 **받는 사람의 범위**로 다시 거른다(구독이 범위를 넓히지 않는다).
 */
export function setSubscription(id, me, on, { isMod = false } = {}) {
  if (!me) throw forbidden('로그인한 사용자만 구독할 수 있습니다');
  if (typeof on !== 'boolean') throw fieldError('on', 'true 또는 false 여야 합니다');
  const { filters } = load();
  const cur = filters.find((f) => f.id === id);
  if (!cur || (cur.owner !== me && !cur.shared)) throw notFound();
  const subs = subsOf(cur);
  if (subs.includes(me) === on) return view(cur, me, isMod);
  if (on && subs.length >= FILTER_LIMITS.subscribers) throw conflict(`한 필터의 구독자는 ${FILTER_LIMITS.subscribers}명까지입니다`);
  const next = { ...cur, subscribers: on ? [...subs, me] : subs.filter((u) => u !== me) };
  save(filters.map((f) => (f.id === id ? next : f)));
  return view(next, me, isMod);
}
/** 구독자가 있는 필터(메일 발송용 사본) — 공유가 꺼진 필터는 만든 사람의 구독만 남긴다. */
export function subscribedFilters() {
  return load().filters
    .map((f) => ({ id: f.id, name: f.name, query: f.query, owner: f.owner, shared: !!f.shared, subscribers: subsOf(f).filter((u) => f.shared || u === f.owner) }))
    .filter((f) => f.subscribers.length);
}
