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
export const MAX_INBOX_SEEN = 2000;
const MAX_STOPS = 500;
const MAX_STOP_SERVERS = 2000;
const READ_RETRY_MS = 30_000;
/** 밀려나지 않게 지키는 사건 — 사용 중지 · 재개 · 바꿔치기(감사 로그에 없는 것도 있다). */
export const GUARD_KEYS = Object.freeze(['twoPerson', 'serverRestrict']);
// 서버마다 생기는 사건(key-login-set · key-lines-removed)은 넣지 않는다 — 100대 작업 몇 번이 사용 중지 · 바꿔치기 사건을 밀어냈다(점검 C-3 · D-5).
//   작업 하나에 한 번 남는 요약(key-job-done · key-revoke-done)을 넣는다.
export const CRITICAL_EVENTS = Object.freeze(['guard-changed', 'approval-requested', 'approval-decided', 'key-job-done', 'key-revoke-done', 'key-job-interrupted', 'corp-stop', 'corp-resume', 'key-tampered', 'key-changed-outside', 'key-added-outside', 'state-reloaded', 'keystore-reloaded', 'account-changed-outside']);

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
  if (j.guards !== undefined && !isObj(j.guards)) throw new ShapeError('guards 가 객체가 아닙니다');
  // v3.10.0 보호 장치 — 없으면 켬(엄한 쪽이 기본). 글자 그대로 false 일 때만 끔.
  // pairSeen: 승인할 수 있는 설정 소유자가 둘 이상인 것을 한 번이라도 본 설치(guards.notePair) — 그 뒤로는 두 사람 승인을 혼자 끄지 못한다(반증 R3).
  // seenAd: 이 화면에 들어온 AD 소유자의 신원(identityKey) — 승인자 쌍의 증거(2회차 A1 — 소유자가 모두 AD 인 설치는 로컬 승인자가 없어 쌍이 서지 않았다). 최대 20.
  const seenAd = (Array.isArray(j.guards?.seenAd) ? j.guards.seenAd : []).filter((x) => typeof x === 'string' && x && x.length <= 128).slice(-20);
  const guards = { twoPerson: j.guards?.twoPerson !== false, serverRestrict: j.guards?.serverRestrict !== false, pairSeen: j.guards?.pairSeen === true, seenAd };
  const stops = Object.create(null);
  const ents = Object.entries(j.stops || {});
  // 넘치는 중지 기록을 조용히 자르면 잘린 법인의 중지가 풀린다(반증 D6) — 손상으로 본다.
  if (ents.length > MAX_STOPS) throw new ShapeError(`stops 가 ${MAX_STOPS}개를 넘습니다`);
  for (const [corp, v] of ents) {
    const c = t(corp, 128);
    if (!c) continue;
    if (!isObj(v)) throw new ShapeError(`stops.${c.slice(0, 40)} 가 객체가 아닙니다`);
    for (const f of ['serverIds', 'addrs']) if (v[f] !== undefined && !Array.isArray(v[f])) throw new ShapeError(`stops.${c.slice(0, 40)}.${f} 가 배열이 아닙니다`);
    stops[c] = { at: num(v.at), by: t(v.by, 64), reason: t(v.reason, 300), serverIds: strList(v.serverIds, MAX_STOP_SERVERS), addrs: strList(v.addrs, MAX_STOP_SERVERS) };
  }
  const events = (j.events || []).filter(isObj).slice(-MAX_EVENTS).map((e) => ({
    at: num(e.at), kind: t(e.kind, 40), corp: t(e.corp, 128), target: t(e.target, 128), by: t(e.by, 64), detail: t(e.detail, 300),
  }));
  // 받는 곳 ‘본 표지’(12자 해시) — 사건 기록과 따로 둔다(1회차 C1-4 · D5 — 사건 300개에서 밀려나면 재시작 뒤 같은 파일을 다시 알렸다).
  //   이 칸은 알림 중복을 막는 기록일 뿐이라 모양이 틀려도 손상으로 보지 않는다(1회차 반증 참고 — 손상으로 보면 모든 키 접속이 멈췄다).
  const inboxSeen = [...new Set((Array.isArray(j.inboxSeen) ? j.inboxSeen : []).filter((x) => typeof x === 'string' && /^[0-9a-f]{12}$/.test(x)))].slice(-MAX_INBOX_SEEN);
  return { stops, events, guards, inboxSeen };
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
// 프로토타입 없는 객체로 — 'toString' 같은 이름을 중지 기록으로 읽지 않게(반증 D7).
function draft() { const d = load(); return { stops: Object.assign(Object.create(null), d.stops), events: d.events.slice(), guards: { ...d.guards }, inboxSeen: (d.inboxSeen || []).slice() }; }
function commit(next) {
  // 이번 쓰기에 실린 사건만 알린다 — 쓰기에 실패하면 버린다(쓰이지 않은 사건을 다음 쓰기 때 알리지 않게).
  const sent = pendingNotify; pendingNotify = [];
  const lost = pendingLost; pendingLost = [];
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
  if (lost.length) console.warn(`[ssh-access] 사건 ${lost.length}건이 기록 상한(${MAX_EVENTS})에 밀려 남지 않았습니다 — 메일에는 수로 밝힙니다.`);
  if (!listeners.size) {
    if (sent.length || lost.length) { early = early.concat(sent); earlyLost = earlyLost.concat(lost); if (early.length > EARLY_MAX) { earlyLost = earlyLost.concat(early.slice(0, early.length - EARLY_MAX)); early = early.slice(-EARLY_MAX); } earlyLost = earlyLost.slice(-1000); }
  } else if (sent.length || lost.length) for (const fn of listeners) { try { fn(sent, { lost }); } catch { /* 알림 실패는 쓰기 결과를 바꾸지 않는다 */ } }
  return { ok: true };
}

/**
 * 이 서버(또는 이 법인들)에 키를 써도 되는가 — 사용 중지 판정(refs.resolveOsAuth 가 키를 쓰기 전에 본다).
 * @param {{corps?:string[], serverId?:string, addr?:string}} q
 * @returns {null | {unreadable:true} | {corp:string, at:number, by:string, reason:string}}
 */
export function stopMatch({ corps = [], serverId = '', addr = '', serverCorp = '' } = {}) {
  const d = load();
  if (!d || loadErr.get()) return { unreadable: true };
  for (const c of corps) { const k = t(c, 128); if (k && Object.hasOwn(d.stops, k)) return { corp: k, ...d.stops[k] }; }
  const sid = t(serverId, 64);
  // 접속처 대조는 **법인이 없는 서버만**(반증 D2) — 법인끼리 사설 IP 가 겹치므로 다른 법인의 같은 주소 서버를 막으면 안 된다.
  //   법인 칸을 비워 빠져나가는 길(같은 항목)은 서버 id 가, 새 항목으로 다시 만드는 길은 법인이 없을 때 접속처가 잡는다.
  const ad = t(serverCorp, 128) ? '' : t(addr, 300);
  if (sid || ad) for (const [corp, s] of Object.entries(d.stops)) if ((sid && s.serverIds.includes(sid)) || (ad && s.addrs.includes(ad))) return { corp, ...s };
  return null;
}
/** 법인 하나의 사용 중지 기록(화면용). 못 읽으면 { unreadable }. */
export function stopFor(corp) {
  const d = load();
  if (!d || loadErr.get()) return { unreadable: true };
  const c = t(corp, 128);
  return c && Object.hasOwn(d.stops, c) ? { ...d.stops[c] } : null;
}
export function listStops() { const d = load(); return d ? Object.entries(d.stops).map(([corp, v]) => ({ corp, ...v })) : []; }

/** 사건이 **파일에 쓰인 뒤** 불리는 알림(메일 등 — sshaccess/notify.js). 듣는 쪽 오류는 삼킨다(사건 기록을 막지 않는다). */
const listeners = new Set();
// 듣는 쪽이 붙기 전(기동 뒤 알림이 붙기까지 — 3회차 C3-2: 그 사이 긴급 중지 사건이 메일이 되지 않았다)의 사건은 상한 있게 모아 두었다가 처음 붙는 쪽에 넘긴다.
const EARLY_MAX = 200;
let early = []; let earlyLost = [];
export function onEvents(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  if (early.length || earlyLost.length) {
    const sent = early; const lost = earlyLost; early = []; earlyLost = [];
    queueMicrotask(() => { try { fn(sent, { lost }); } catch { /* 알림 실패는 기록을 바꾸지 않는다 */ } });
  }
  return () => listeners.delete(fn);
}
/** 쓰지 못하고 버린 사건을 알림 쪽에 수로만 넘긴다(메일 ‘외 N건’ — 3회차 C3-3). */
export function reportLostEvents(list) {
  const lost = (Array.isArray(list) ? list : []).filter((e) => e && typeof e === 'object');
  if (!lost.length) return;
  if (!listeners.size) { earlyLost = earlyLost.concat(lost).slice(-1000); return; }
  for (const fn of listeners) { try { fn([], { lost }); } catch { /* */ } }
}
let pendingNotify = [];
let pendingLost = [];   // 이번 쓰기에서 기록 상한에 밀려 남지 못한 새 사건(2회차 반증 R2R-10 — 기록 · 메일 수에서 말없이 빠졌다)
function pushEvents(d, list, now) {
  const fresh = [];
  for (const ev of list) {
    // 다시 쓰는 작업 끝 사건은 처음 시각을 지킨다(2회차 반증 — 다음 점검 때 다시 쓰면 최대 10분 늦게 찍혔다). 미래 시각은 받지 않는다.
    const at = Number.isFinite(ev.at) && ev.at > 0 && ev.at <= now ? ev.at : now;
    const e = { at, kind: t(ev.kind, 40), corp: t(ev.corp, 128), target: t(ev.target, 128), by: t(ev.by, 64), detail: t(ev.detail, 300) };
    d.events.push(e); fresh.push(e);
  }
  // 넘치면 **이번에 넣지 않은** 사건 가운데 덜 중요한 오래된 것부터 버린다(받는 곳 새 파일이 몰려도 사용 중지 · 바꿔치기 사건이 밀려나지 않게 — 점검 C-7).
  //   이번에 넣은 사건은 자르지 않는다 — 오래 운영해 기록이 중요 사건으로 차면 새 덜 중요한 사건(inbox-new)이 넣자마자 잘려 알림도 영영 나가지 않았다(반증 R5).
  //   지키는 것은 이번 사건 가운데 **중요 사건과 앞의 덜 중요한 사건 5개**까지 — 작업 끝 몰아 쓰기(서버마다 50개)가 그만큼 오래된 중요 사건을 밀어냈다(1회차 반증 4).
  const keep = new Set(); let nc = 0;
  for (const e of fresh) { if (CRITICAL_EVENTS.includes(e.kind)) keep.add(e); else if (nc < 5) { keep.add(e); nc += 1; } }
  while (d.events.length > MAX_EVENTS) {
    let i = d.events.findIndex((e) => !keep.has(e) && !CRITICAL_EVENTS.includes(e.kind));
    if (i < 0) i = d.events.findIndex((e) => !keep.has(e));
    if (i < 0) break;
    d.events.splice(i, 1);
  }
  if (d.events.length > MAX_EVENTS) d.events.splice(0, d.events.length - MAX_EVENTS);   // 한 번에 상한보다 많이 넣은 경우만
  // 알림은 **기록에 남은** 사건만(점검 C-3 부수).
  const kept = new Set(d.events);
  for (const e of fresh) { if (kept.has(e)) pendingNotify.push(e); else pendingLost.push(e); }
}

/**
 * @param {{by?:string, reason?:string, servers?:{id:string, addr:string}[]}} o  servers = 지금 그 법인 서버(중지할 때 함께 적는다 — 법인 칸을 비워 빠져나가지 못하게)
 */
export function setCorpStop(corp, { by = '', reason = '', servers = [], now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const c = t(corp, 128);
  if (!c) return { ok: false, code: 'bad-corp', reason: '법인을 고르세요.' };
  const d = draft();
  if (!Object.hasOwn(d.stops, c) && Object.keys(d.stops).length >= MAX_STOPS) return { ok: false, code: 'too-many', reason: '사용 중지 기록이 너무 많습니다.' };
  d.stops[c] = { at: now, by: t(by, 64), reason: t(reason, 300), serverIds: strList(servers.map((s) => s?.id), MAX_STOP_SERVERS), addrs: strList(servers.map((s) => s?.addr), MAX_STOP_SERVERS) };
  pushEvents(d, [{ kind: 'corp-stop', corp: c, by, detail: `${t(reason, 240)}${servers.length ? ` · 서버 ${servers.length}대` : ''}` }], now);
  return commit(d);
}
/** 이미 걸린 중지 기록에 그 뒤 등록된 서버를 더한다(사건은 쌓지 않는다 — 2회차 반증 R2R-6). 늘리기만(엄한 쪽). */
export function addStopServers(corp, servers = []) {
  const u = unreadable(); if (u) return u;
  const c = t(corp, 128);
  const d = draft();
  if (!c || !Object.hasOwn(d.stops, c)) return { ok: false, code: 'not-stopped', status: 404, reason: '이 법인은 사용 중지 상태가 아닙니다.' };
  const cur = d.stops[c];
  cur.serverIds = strList([...(cur.serverIds || []), ...servers.map((s) => s?.id)], MAX_STOP_SERVERS);
  cur.addrs = strList([...(cur.addrs || []), ...servers.map((s) => s?.addr)], MAX_STOP_SERVERS);
  return commit(d);
}
export function clearCorpStop(corp, { by = '', now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const c = t(corp, 128);
  const d = draft();
  if (!c || !Object.hasOwn(d.stops, c)) return { ok: false, code: 'not-stopped', status: 404, reason: '이 법인은 사용 중지 상태가 아닙니다.' };
  delete d.stops[c];
  pushEvents(d, [{ kind: 'corp-resume', corp: c, by }], now);
  return commit(d);
}

/**
 * 보호 장치(v3.10.0 — 두 사람 승인 · 서버 쪽 제한). 상태 파일을 못 읽으면 **켠 것으로** 본다(엄한 쪽 — 손상으로 보호가 꺼지지 않게).
 * @returns {{twoPerson:boolean, serverRestrict:boolean, unreadable?:true}}
 */
export function getGuards() {
  const d = load();
  if (!d || loadErr.get()) return { twoPerson: true, serverRestrict: true, pairSeen: true, seenAd: [], unreadable: true };
  return { ...d.guards, seenAd: (d.guards.seenAd || []).slice() };
}
/** ‘승인할 수 있는 소유자 둘’ 을 본 표지를 세운다(한 번 세우면 내리지 않는다 — 화면 · API 로 내릴 길이 없다). */
/** AD 소유자 세션의 신원을 적는다(처음 볼 때만 쓴다 — 화면을 열 때마다 쓰지 않는다). */
export function noteSeenAd(idKey) {
  const u = unreadable(); if (u) return u;
  const k = t(idKey, 128); if (!k) return { ok: false };
  const d = draft();
  const cur = d.guards.seenAd || [];
  if (cur.includes(k)) return { ok: true, changed: 0 };
  d.guards.seenAd = [...cur, k].slice(-20);
  return commit(d);
}
export function markPairSeen({ by = '', now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const d = draft();
  if (d.guards.pairSeen === true) return { ok: true, changed: 0 };
  d.guards.pairSeen = true;
  pushEvents(d, [{ kind: 'guard-changed', by, detail: '승인할 수 있는 설정 소유자 둘을 확인 — 이제 두 사람 승인은 혼자 끌 수 없습니다' }], now);
  return commit(d);
}
/** 바꾸기 결과에 싣는 보호 장치 — 판정용 seenAd(AD 소유자 신원 목록)는 응답 · 승인 결과에 싣지 않는다(2회차 반증 R2R-8). */
const pubGuards = (g) => { const { seenAd: _seen, ...rest } = g || {}; return rest; };
/** 보호 장치 바꾸기(호출부가 권한 · OTP · 두 사람 승인을 거친 뒤). 아는 키 · 참/거짓만. */
export function setGuards(patch = {}, { by = '', now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const d = draft();
  const changed = [];
  for (const k of GUARD_KEYS) if (typeof patch[k] === 'boolean' && patch[k] !== d.guards[k]) { d.guards[k] = patch[k]; changed.push(`${k}=${patch[k] ? '켬' : '끔'}`); }
  if (!changed.length) return { ok: true, guards: pubGuards(d.guards), changed: 0 };
  pushEvents(d, [{ kind: 'guard-changed', by, detail: changed.join(' · ') }], now);
  const c = commit(d);
  return c.ok ? { ok: true, guards: pubGuards(d.guards), changed: changed.length } : c;
}

/** 키 보안 사건 — 여러 개를 한 번에 쓴다(사건마다 파일 전체를 다시 쓰지 않게). 쓰기 실패는 호출부를 막지 않는다(감사 로그가 원본이다). */
export function addEvents(list = [], { now = Date.now(), inboxSeen = null } = {}) {
  const items = (Array.isArray(list) ? list : []).filter(isObj);
  const seen = Array.isArray(inboxSeen) ? inboxSeen : [];
  if ((!items.length && !seen.length) || unreadable()) return { ok: false };
  const d = draft();
  if (items.length) pushEvents(d, items, now);
  if (seen.length) d.inboxSeen = [...d.inboxSeen, ...seen];   // 사건과 같은 쓰기에(알림을 보냈는데 표지를 못 남기는 일이 없게)
  return commit(d);
}
/** 받는 곳 ‘본 표지’ 목록. 상태 파일을 못 읽으면 null(빈 목록이 아니다 — 호출부는 그 회차에 알리지 않는다). */
export function inboxSeenList() { const d = load(); return d && !loadErr.get() ? (d.inboxSeen || []).slice() : null; }
export function addEvent(ev = {}, opts = {}) { return addEvents([ev], opts); }
export function listEvents({ limit = 100 } = {}) { const d = load(); return d ? d.events.slice(-Math.max(1, Math.min(MAX_EVENTS, limit))).reverse() : []; }
