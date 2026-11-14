/**
 * sshaccess/state.js — SSH 공용 접속의 **상태 파일**(v3.9.0 · 설계 docs/design/ssh-access §8 · §9) — 접속 판정에 쓰는 것만 둔다.
 *
 * 파일 `CONFIG_DIR/ssh-access-state.json`(0600 · 원자적 쓰기 · 로드 손상 preserveCorrupt — 비밀 없음):
 *   { stops:  { [법인(vCenter id)]: { at, by, reason, serverIds:[…], addrs:[…] } }   — 긴급 조치 ‘이 법인 키 사용 중지’
 *     events: [ { at, kind, corp, target, by, detail } ] }                          — 키 보안 사건(최근 MAX_EVENTS — 중요한 사건은 나중에 버린다)
 * 서버에서 읽은 authorized_keys 지문은 판정에 쓰지 않으므로 따로 둔다(`installed.js` — 그 파일이 깨져도 키 접속을 멈추지 않는다).
 *
 * 불변조건(sshaccess/CLAUDE.md):
 *  · **못 읽으면 키 접속을 멈춘다**(fail-closed) — 정지 기록을 모르는 채 키를 쓰면 ‘사용 중지’ 가 손상 한 번으로 풀린다. 쓰기도 거절한다.
 *    **모양이 틀린 파일도 손상이다**(점검 A-6 · C-11 — JSON 으로는 읽히는데 stops 가 객체가 아니면 예전에는 조용히 비웠다).
 *    파일 읽기 자체가 실패한 경우(EMFILE · 권한 — 손상이 아님)는 원본을 옮기지 않고 30초 뒤 다시 읽는다(점검 C-3).
 *    사람이 파일을 고쳤으면 재시작 없이 `reloadSshAccessState()`(설정 소유자 + OTP 라우트)로 다시 읽는다.
 *  · 사용 중지는 법인 칸(vCenter id)만 보지 않는다 — 중지할 때 그 법인 서버의 id · 접속처(host:port|계정)를 함께 적어 둔다.
 *    법인 칸은 OTP 없이 고칠 수 있는 칸이라, 칸을 비우면 빠져나가는 길이었다(점검 A-4).
 *  · 백업 복원에서 뺀다(`backup/stagedRestore.js RESTORE_EXCLUDE`).
 *  · 쓰기는 동기(load → 사본 → 원자적 쓰기 → 성공한 뒤 캐시 교체).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js';

export const STATE_FILE_NAME = 'ssh-access-state.json';
const FILE = () => path.join(config.configDir, 'ssh-access-state.json');   // = STATE_FILE_NAME(문서 생성기가 글자 그대로 찾는다)
export const MAX_EVENTS = 300;
const MAX_STOPS = 500;
const MAX_STOP_SERVERS = 2000;
const READ_RETRY_MS = 30_000;
/** 밀려나지 않게 지키는 사건 — 사용 중지 · 재개 · 바꿔치기(감사 로그에 없는 것도 있다). */
export const CRITICAL_EVENTS = Object.freeze(['corp-stop', 'corp-resume', 'key-tampered', 'key-changed-outside', 'key-added-outside', 'state-reloaded', 'keystore-reloaded']);

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v, max) => (Array.isArray(v) ? [...new Set(v.map((x) => t(x, 300)).filter(Boolean))].slice(0, max) : []);

let cache = null;
let readFailAt = 0;
const loadErr = makeLoadError();

class ShapeError extends Error {}
/** 모양 검사 — 틀리면 던진다(손상으로 보고 잠근다). */
function norm(j) {
  if (!isObj(j)) throw new ShapeError('상태 파일이 객체가 아닙니다');
  if (j.stops !== undefined && !isObj(j.stops)) throw new ShapeError('stops 가 객체가 아닙니다');
  if (j.events !== undefined && !Array.isArray(j.events)) throw new ShapeError('events 가 배열이 아닙니다');
  const stops = Object.create(null);
  for (const [corp, v] of Object.entries(j.stops || {}).slice(0, MAX_STOPS)) {
    const c = t(corp, 128);
    if (!c) continue;
    if (!isObj(v)) throw new ShapeError(`stops.${c.slice(0, 40)} 가 객체가 아닙니다`);
    stops[c] = { at: num(v.at), by: t(v.by, 64), reason: t(v.reason, 300), serverIds: strList(v.serverIds, MAX_STOP_SERVERS), addrs: strList(v.addrs, MAX_STOP_SERVERS) };
  }
  const events = (j.events || []).filter(isObj).slice(-MAX_EVENTS).map((e) => ({
    at: num(e.at), kind: t(e.kind, 40), corp: t(e.corp, 128), target: t(e.target, 128), by: t(e.by, 64), detail: t(e.detail, 300),
  }));
  return { stops, events };
}

function load() {
  if (cache) return cache;
  if (readFailAt && Date.now() - readFailAt < READ_RETRY_MS) return null;   // 읽기 실패 뒤 잠시 — 매 호출마다 디스크를 두드리지 않는다
  let text = null;
  try {
    if (fs.existsSync(FILE())) text = fs.readFileSync(FILE(), 'utf8');
  } catch (e) {
    // 읽기 자체가 실패(EMFILE · 권한 등 — 내용 손상이 아니다): 원본을 옮기지 않고 잠근 채 다시 읽는다.
    loadErr.set(`읽기 실패(${String(e?.code || e?.message || e).slice(0, 40)})`); readFailAt = Date.now(); return null;
  }
  readFailAt = 0;
  if (text == null) {
    loadErr.checkCorruptOnly(FILE());
    if (loadErr.get()) return null;
    cache = norm({});
    return cache;
  }
  try { cache = norm(JSON.parse(text)); loadErr.clear(); }
  catch (e) { preserveCorrupt(FILE(), e?.message); loadErr.set(e); cache = null; return null; }
  return cache;
}
export function _resetSshAccessStateForTest() { cache = null; readFailAt = 0; loadErr.clear(); }
/** 로드 오류(손상 · 모양 틀림 · 손상 보존본만 · 읽기 실패) — 있으면 키 접속을 멈추고 쓰기를 거절한다. */
export function stateLoadError() { load(); return loadErr.get(); }
/** 사람이 파일을 고친 뒤 재시작 없이 다시 읽는다(설정 소유자 + OTP 라우트). 그래도 못 읽으면 오류를 그대로 돌려준다. */
export function reloadSshAccessState({ by = '' } = {}) {
  cache = null; readFailAt = 0; loadErr.clear();
  load();
  const e = loadErr.get();
  if (e) return { ok: false, code: 'state-unreadable', status: 503, reason: `상태 파일을 아직 읽지 못합니다 — ${t(e.reason, 160)}` };
  addEvent({ kind: 'state-reloaded', by });
  return { ok: true };
}

function unreadable() {
  load();
  const e = loadErr.get();
  return e ? { ok: false, code: 'state-unreadable', status: 503, reason: `SSH 공용 접속 상태 파일(${STATE_FILE_NAME})을 읽지 못해 바꾸지 않았습니다 — 손상 보존본(${STATE_FILE_NAME}.corrupt.*)을 확인해 고친 뒤 ‘상태 파일 다시 읽기’ 를 누르세요.` } : null;
}
function draft() { const d = load(); return { stops: { ...d.stops }, events: d.events.slice() }; }
function commit(next) {
  let normed;
  try { normed = norm(next); } catch (e) { return { ok: false, code: 'bad-state', status: 500, reason: String(e?.message || e).slice(0, 120) }; }
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    atomicWriteFileSync(FILE(), JSON.stringify(normed), { mode: 0o600 });
  } catch (e) {
    return { ok: false, code: 'write-failed', status: 500, reason: `SSH 공용 접속 상태 파일을 쓰지 못했습니다(${String(e?.code || e?.message || e).slice(0, 80)}).` };
  }
  cache = normed;
  loadErr.clear();
  return { ok: true };
}

/**
 * 이 서버(또는 이 법인들)에 키를 써도 되는가 — 사용 중지 판정(refs.resolveOsAuth 가 키를 쓰기 전에 본다).
 * @param {{corps?:string[], serverId?:string, addr?:string}} q
 * @returns {null | {unreadable:true} | {corp:string, at:number, by:string, reason:string}}
 */
export function stopMatch({ corps = [], serverId = '', addr = '' } = {}) {
  const d = load();
  if (!d || loadErr.get()) return { unreadable: true };
  for (const c of corps) { const k = t(c, 128); if (k && d.stops[k]) return { corp: k, ...d.stops[k] }; }
  const sid = t(serverId, 64); const ad = t(addr, 300);
  if (sid || ad) for (const [corp, s] of Object.entries(d.stops)) if ((sid && s.serverIds.includes(sid)) || (ad && s.addrs.includes(ad))) return { corp, ...s };
  return null;
}
/** 법인 하나의 사용 중지 기록(화면용). 못 읽으면 { unreadable }. */
export function stopFor(corp) {
  const d = load();
  if (!d || loadErr.get()) return { unreadable: true };
  const c = t(corp, 128);
  return c && d.stops[c] ? { ...d.stops[c] } : null;
}
export function listStops() { const d = load(); return d ? Object.entries(d.stops).map(([corp, v]) => ({ corp, ...v })) : []; }

function pushEvents(d, list, now) {
  for (const ev of list) d.events.push({ at: now, kind: t(ev.kind, 40), corp: t(ev.corp, 128), target: t(ev.target, 128), by: t(ev.by, 64), detail: t(ev.detail, 300) });
  // 넘치면 덜 중요한 오래된 사건부터 버린다(받는 곳 새 파일이 몰려도 사용 중지 · 바꿔치기 사건이 밀려나지 않게 — 점검 C-7).
  while (d.events.length > MAX_EVENTS) {
    const i = d.events.findIndex((e) => !CRITICAL_EVENTS.includes(e.kind));
    d.events.splice(i >= 0 ? i : 0, 1);
  }
}

/**
 * @param {{by?:string, reason?:string, servers?:{id:string, addr:string}[]}} o  servers = 지금 그 법인 서버(중지할 때 함께 적는다 — 법인 칸을 비워 빠져나가지 못하게)
 */
export function setCorpStop(corp, { by = '', reason = '', servers = [], now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const c = t(corp, 128);
  if (!c) return { ok: false, code: 'bad-corp', reason: '법인을 고르세요.' };
  const d = draft();
  if (!d.stops[c] && Object.keys(d.stops).length >= MAX_STOPS) return { ok: false, code: 'too-many', reason: '사용 중지 기록이 너무 많습니다.' };
  d.stops[c] = { at: now, by: t(by, 64), reason: t(reason, 300), serverIds: strList(servers.map((s) => s?.id), MAX_STOP_SERVERS), addrs: strList(servers.map((s) => s?.addr), MAX_STOP_SERVERS) };
  pushEvents(d, [{ kind: 'corp-stop', corp: c, by, detail: `${t(reason, 240)}${servers.length ? ` · 서버 ${servers.length}대` : ''}` }], now);
  return commit(d);
}
export function clearCorpStop(corp, { by = '', now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const c = t(corp, 128);
  const d = draft();
  if (!d.stops[c]) return { ok: false, code: 'not-stopped', status: 404, reason: '이 법인은 사용 중지 상태가 아닙니다.' };
  delete d.stops[c];
  pushEvents(d, [{ kind: 'corp-resume', corp: c, by }], now);
  return commit(d);
}

/** 키 보안 사건 — 여러 개를 한 번에 쓴다(사건마다 파일 전체를 다시 쓰지 않게). 쓰기 실패는 호출부를 막지 않는다(감사 로그가 원본이다). */
export function addEvents(list = [], { now = Date.now() } = {}) {
  const items = (Array.isArray(list) ? list : []).filter(isObj);
  if (!items.length || unreadable()) return { ok: false };
  const d = draft();
  pushEvents(d, items, now);
  return commit(d);
}
export function addEvent(ev = {}, opts = {}) { return addEvents([ev], opts); }
export function listEvents({ limit = 100 } = {}) { const d = load(); return d ? d.events.slice(-Math.max(1, Math.min(MAX_EVENTS, limit))).reverse() : []; }
