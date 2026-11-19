/**
 * sshaccess/state.js — SSH 공용 접속의 **상태 파일**(v3.9.0 · 설계 docs/design/ssh-access §8 · §9) — 접속 판정에 쓰는 것만 둔다.
 *
 * 파일 `CONFIG_DIR/ssh-access-state.json`(0600 · 원자적 쓰기 · 로드 손상 preserveCorrupt — 비밀 없음):
 *   { stops:  { [법인(vCenter id)]: { at, by, reason, serverIds:[…], addrs:[…] } }   — 긴급 조치 ‘이 법인 키 사용 중지’
 *     events: [ { at, kind, corp, target, by, detail } ],                         — 키 보안 사건(최근 MAX_EVENTS — 중요한 사건은 나중에 버린다)
 *     (v3.24 서버 접속 — 설계 docs/design/server-access §4.6)
 *     assign: { [법인]: { all?: A, linux?: A, windows?: A } }  A = { account(공통 계정 id), auth(''=키 우선 | 'password'), at, by }
 *                                                                                 — 계층 지정(법인 › OS 종류). 비밀은 없다(계정 id 만)
 *     accountStops: { [공통 계정 id]: { at, server, feature, version } } }          — 계정 단위 정지(로그인 거부 한 번 — 그 비밀번호 판 동안)
 * 서버에서 읽은 authorized_keys 지문은 판정에 쓰지 않으므로 따로 둔다(`installed.js` — 그 파일이 깨져도 키 접속을 멈추지 않는다).
 *
 * 불변조건(sshaccess/CLAUDE.md):
 *  · **못 읽으면 키 접속을 멈춘다**(fail-closed) — 정지 기록을 모르는 채 키를 쓰면 ‘사용 중지’ 가 손상 한 번으로 풀린다. 쓰기도 거절한다.
 *    **모양이 틀린 파일도 손상이다**(점검 A-6 · C-11 — JSON 으로는 읽히는데 stops 가 객체가 아니면 예전에는 조용히 비웠다).
 *    파일 읽기 자체가 실패한 경우(EMFILE · 권한 — 손상이 아님)는 원본을 옮기지 않고 30초 뒤 다시 읽는다(점검 C-3).
 *    사람이 파일을 고쳤으면 재시작 없이 `reloadSshAccessState()`(설정 소유자 + OTP 라우트)로 다시 읽는다.
 *  · 사용 중지는 법인 칸(vCenter id)만 보지 않는다 — 중지할 때 그 법인 서버의 id · 접속처(host:port|계정)를 함께 적어 둔다.
 *    법인 칸은 OTP 없이 고칠 수 있는 칸이라, 칸을 비우면 빠져나가는 길이었다(점검 A-4).
 *  · 백업 복원에서 뺀다(`backup/stagedRestore.js RESTORE_EXCLUDE`) — 계층 지정은 ‘저장 비밀을 서버에 묶는’ 값이라 OTP 없는 복원으로 되살리지 않는다.
 *  · v3.24: 계층 지정 · 계정 단위 정지도 이 파일이다 — 못 읽으면 물려받는 서버는 접속하지 않고(state-unreadable) 공통 계정 비밀번호 접속도 멈춘다(정지 기록을 모른다).
 *  · 쓰기는 동기(load → 사본 → 원자적 쓰기 → 성공한 뒤 캐시 교체).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js';
import { inRetryWindow } from '../util/jsonFileRead.js';   // 128회차: 재읽기 간격 판정은 공용(시계가 뒤로 가도 그 차만큼 잠기지 않게)

export const STATE_FILE_NAME = 'ssh-access-state.json';
const FILE = () => path.join(config.configDir, 'ssh-access-state.json');   // = STATE_FILE_NAME(문서 생성기가 글자 그대로 찾는다)
export const MAX_EVENTS = 300;
const MAX_STOPS = 500;
const MAX_STOP_SERVERS = 2000;
const READ_RETRY_MS = 30_000;
/** 밀려나지 않게 지키는 사건 — 사용 중지 · 재개 · 바꿔치기(감사 로그에 없는 것도 있다). */
export const CRITICAL_EVENTS = Object.freeze(['corp-stop', 'corp-resume', 'key-tampered', 'key-changed-outside', 'key-added-outside', 'state-reloaded', 'keystore-reloaded', 'account-changed-outside',
  'assign-set', 'assign-clear', 'account-stopped', 'account-resumed']);
/** v3.24 계층 지정 단계 — all = 법인(모든 OS) · linux / windows = 법인 › OS 종류. */
export const ASSIGN_LEVELS = Object.freeze(['all', 'linux', 'windows']);
/** v3.26(3단계 · 설계 D11): 접속 방식 · 포트는 Windows 단계에만(WinRM 일 때만 남긴다 — SSH 는 기본이라 칸을 두지 않는다). */
const viaOf = (level, a) => (level === 'windows' && a?.via === 'winrm' ? { via: 'winrm', ...(Number.isInteger(a.port) ? { port: a.port } : {}) } : {});
const ACC_ID_RE = /^a_[0-9a-f]{12}$/;
const MAX_ACCOUNT_STOPS = 500;

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v, max) => (Array.isArray(v) ? [...new Set(v.map((x) => t(x, 300)).filter(Boolean))].slice(0, max) : []);

let cache = null;
let readFailAt = 0;
let readFailed = false;   // 100회차: 지금 세워 둔 오류가 '읽기 실패'(손상 아님)에서 온 것인가 — 다음 읽기가 되면(파일 없음 포함) 그 오류를 거둔다
const loadErr = makeLoadError();

class ShapeError extends Error {}
/** 모양 검사 — 틀리면 던진다(손상으로 보고 잠근다). */
function norm(j) {
  if (!isObj(j)) throw new ShapeError('상태 파일이 객체가 아닙니다');
  if (j.stops !== undefined && !isObj(j.stops)) throw new ShapeError('stops 가 객체가 아닙니다');
  if (j.events !== undefined && !Array.isArray(j.events)) throw new ShapeError('events 가 배열이 아닙니다');
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
  // v3.24 계층 지정 — 모양이 틀리면 손상(조용히 비우면 지정이 사라진 게 아니라 ‘모름’ 인데 다른 단계로 넘어가 엉뚱한 계정을 쓰게 된다).
  if (j.assign !== undefined && !isObj(j.assign)) throw new ShapeError('assign 이 객체가 아닙니다');
  const assign = Object.create(null);
  const aents = Object.entries(j.assign || {});
  if (aents.length > MAX_STOPS) throw new ShapeError(`assign 이 ${MAX_STOPS}개를 넘습니다`);
  for (const [corp, v] of aents) {
    const c = t(corp, 128);
    if (!c) continue;
    if (!isObj(v)) throw new ShapeError(`assign.${c.slice(0, 40)} 가 객체가 아닙니다`);
    const row = Object.create(null);
    for (const [lv, a] of Object.entries(v)) {
      if (!ASSIGN_LEVELS.includes(lv)) throw new ShapeError(`assign.${c.slice(0, 40)}.${String(lv).slice(0, 20)} 는 모르는 단계입니다`);
      if (!isObj(a) || !ACC_ID_RE.test(String(a.account || ''))) throw new ShapeError(`assign.${c.slice(0, 40)}.${lv} 의 계정이 올바르지 않습니다`);
      if (a.via !== undefined && !['ssh', 'winrm'].includes(a.via)) throw new ShapeError(`assign.${c.slice(0, 40)}.${lv} 의 접속 방식이 올바르지 않습니다`);
      if (a.port !== undefined && a.port !== null && !(Number.isInteger(a.port) && a.port >= 1 && a.port <= 65535)) throw new ShapeError(`assign.${c.slice(0, 40)}.${lv} 의 포트가 올바르지 않습니다`);
      row[lv] = { account: String(a.account), auth: a.auth === 'password' ? 'password' : '', at: num(a.at), by: t(a.by, 64), ...viaOf(lv, a) };
    }
    if (Object.keys(row).length) assign[c] = row;
  }
  if (j.accountStops !== undefined && !isObj(j.accountStops)) throw new ShapeError('accountStops 가 객체가 아닙니다');
  const accountStops = Object.create(null);
  const sents = Object.entries(j.accountStops || {});
  if (sents.length > MAX_ACCOUNT_STOPS) throw new ShapeError(`accountStops 가 ${MAX_ACCOUNT_STOPS}개를 넘습니다`);
  for (const [id, v] of sents) {
    if (!ACC_ID_RE.test(id)) throw new ShapeError('accountStops 의 계정 id 가 올바르지 않습니다');
    if (!isObj(v)) throw new ShapeError(`accountStops.${id} 가 객체가 아닙니다`);
    accountStops[id] = { at: num(v.at), server: t(v.server, 128), feature: t(v.feature, 32), version: t(v.version, 20) };
  }
  return { stops, events, assign, accountStops };
}

function load() {
  if (cache) return cache;
  if (readFailAt && inRetryWindow(Date.now(), readFailAt + READ_RETRY_MS, READ_RETRY_MS)) return null;   // 읽기 실패 뒤 잠시 — 매 호출마다 디스크를 두드리지 않는다
  let text = null;
  // 134회차(재현): `fs.existsSync` 가드는 stat 실패(폴더 수준 EACCES · EIO · ESTALE)를 '파일 없음' 으로 읽어 빈 상태를 캐시했다 — 중지 기록(stops)이 사라져
  //   멈춰 둔 법인 · 서버의 키 접속이 다시 열리고, 다음 기록이 원본을 덮었다. 곧바로 읽어 ENOENT 만 없음이고 그 밖은 아래 읽기 실패(잠금 · 30초 재읽기)다.
  try {
    text = fs.readFileSync(FILE(), 'utf8');
  } catch (e) { if (e?.code === 'ENOENT') text = null; else {
    // 읽기 자체가 실패(EMFILE · 권한 등 — 내용 손상이 아니다): 원본을 옮기지 않고 잠근 채 다시 읽는다.
    loadErr.set(`읽기 실패(${String(e?.code || e?.message || e).slice(0, 40)})`); readFailAt = Date.now(); readFailed = true; return null;
  } }
  readFailAt = 0;
  // 100회차(97회차 추정 — 재현): 읽기 실패 뒤 파일이 **없어지면**(사람이 치움) 아래 checkCorruptOnly 가 '이미 오류가 있다' 로 그냥 돌아가 읽기 실패 표지가
  //   남았다 — 파일이 없는데도 키 접속 정지 · 쓰기 거절이 '상태 파일 다시 읽기'(OTP) · 재시작 전까지 풀리지 않았다. 읽기 자체가 된 지금은 그 오류를 거두고
  //   지금 파일 상태(없음 → 손상 보존본만이면 다시 잠금 · 아니면 빈 상태 — 재시작과 같다 · 있음 → 아래 파싱)로 다시 정한다. 손상에서 온 오류는 거두지 않는다.
  if (readFailed) { readFailed = false; loadErr.clear(); }
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
export function _resetSshAccessStateForTest() { cache = null; readFailAt = 0; readFailed = false; loadErr.clear(); }
/** 로드 오류(손상 · 모양 틀림 · 손상 보존본만 · 읽기 실패) — 있으면 키 접속을 멈추고 쓰기를 거절한다. */
export function stateLoadError() { load(); return loadErr.get(); }
/** 사람이 파일을 고친 뒤 재시작 없이 다시 읽는다(설정 소유자 + OTP 라우트). 그래도 못 읽으면 오류를 그대로 돌려준다. */
export function reloadSshAccessState({ by = '' } = {}) {
  cache = null; readFailAt = 0; readFailed = false; loadErr.clear();
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
function draft() {
  const d = load();
  const assign = Object.create(null);
  for (const [c, row] of Object.entries(d.assign)) assign[c] = Object.assign(Object.create(null), row);
  return { stops: Object.assign(Object.create(null), d.stops), events: d.events.slice(), assign, accountStops: Object.assign(Object.create(null), d.accountStops) };
}
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
  if (!Object.hasOwn(d.stops, c) && Object.keys(d.stops).length >= MAX_STOPS) return { ok: false, code: 'too-many', reason: '사용 중지 기록이 너무 많습니다.' };
  d.stops[c] = { at: now, by: t(by, 64), reason: t(reason, 300), serverIds: strList(servers.map((s) => s?.id), MAX_STOP_SERVERS), addrs: strList(servers.map((s) => s?.addr), MAX_STOP_SERVERS) };
  pushEvents(d, [{ kind: 'corp-stop', corp: c, by, detail: `${t(reason, 240)}${servers.length ? ` · 서버 ${servers.length}대` : ''}` }], now);
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

/* ── v3.24 계층 지정(법인 › OS 종류) — 설계 docs/design/server-access §4.6 ─────────────────── */

/**
 * 그 단계의 지정. 못 읽으면 { unreadable } — 호출부(refs.resolveOsAuth)는 ‘지정 없음’ 으로 넘기지 않고 접속을 멈춘다.
 * @returns {null | {unreadable:true} | {account:string, auth:''|'password', at:number, by:string}}
 */
export function assignFor(corp, level) {
  const d = load();
  if (!d || loadErr.get()) return { unreadable: true };
  const c = t(corp, 128);
  if (!c || !ASSIGN_LEVELS.includes(level) || !Object.hasOwn(d.assign, c)) return null;
  const row = d.assign[c];
  return Object.hasOwn(row, level) ? { ...row[level] } : null;
}
/** 화면용 — 전부. 못 읽으면 null(모름). */
export function listAssign() {
  const d = load();
  if (!d || loadErr.get()) return null;
  const out = [];
  for (const [corp, row] of Object.entries(d.assign)) for (const lv of ASSIGN_LEVELS) if (Object.hasOwn(row, lv)) out.push({ corp, level: lv, ...row[lv] });
  return out;
}
/** 이 공통 계정을 가리키는 지정 수(계정 삭제 · 바꾸기 판정). 못 읽으면 null(모름 — 삭제를 막는다). */
export function assignRefs(accountId) {
  const all = listAssign();
  return all ? all.filter((a) => a.account === t(accountId, 32)) : null;
}
/**
 * 지정 쓰기(설정 소유자 등급 + 본인 OTP 라우트 뒤 — 부르는 곳은 sshaccess/service.js 하나). a = null 이면 지운다.
 * 계정 · 법인 · OS 가 맞는지는 호출부(service)가 키 저장소를 보고 판정한다 — 이 파일은 키 저장소를 모른다.
 */
export function setAssign(corp, level, a, { by = '', now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const c = t(corp, 128);
  if (!c) return { ok: false, code: 'bad-corp', reason: '법인을 고르세요.' };
  if (!ASSIGN_LEVELS.includes(level)) return { ok: false, code: 'bad-level', reason: '단계는 법인 · Linux · Windows 중 하나입니다.' };
  const d = draft();
  const row = Object.hasOwn(d.assign, c) ? d.assign[c] : Object.create(null);
  if (a) {
    if (!ACC_ID_RE.test(String(a.account || ''))) return { ok: false, code: 'bad-account', reason: '공통 계정을 고르세요.' };
    if (!Object.hasOwn(d.assign, c) && Object.keys(d.assign).length >= MAX_STOPS) return { ok: false, code: 'too-many', reason: '계층 지정이 너무 많습니다.' };
    if (a.via !== undefined && a.via !== '' && !['ssh', 'winrm'].includes(a.via)) return { ok: false, code: 'bad-via', reason: '접속 방식은 SSH · WinRM 중 하나입니다.' };
    if (a.port != null && a.port !== '' && !(Number.isInteger(Number(a.port)) && Number(a.port) >= 1 && Number(a.port) <= 65535)) return { ok: false, code: 'bad-port', reason: '포트는 1~65535 입니다.' };
    row[level] = { account: String(a.account), auth: a.auth === 'password' ? 'password' : '', at: now, by: t(by, 64), ...viaOf(level, { via: a.via, port: a.port === '' || a.port == null ? null : Number(a.port) }) };
    d.assign[c] = row;
  } else {
    if (!Object.hasOwn(row, level)) return { ok: false, code: 'not-set', status: 404, reason: '그 단계에는 지정이 없습니다.' };
    delete row[level];
    if (Object.keys(row).length) d.assign[c] = row; else delete d.assign[c];
  }
  pushEvents(d, [{ kind: a ? 'assign-set' : 'assign-clear', corp: c, target: level, by, detail: a ? `${a.account}${a.auth === 'password' ? ' · 비밀번호 고정' : ''}${level === 'windows' && a.via === 'winrm' ? ` · WinRM${a.port ? `:${a.port}` : ''}` : ''}` : '' }], now);
  return commit(d);
}

/* ── v3.24 계정 단위 정지(로그인 거부 한 번) ─────────────────────────────── */

/**
 * 그 계정이 정지돼 있는가. 정지는 **그 비밀번호 판(version)** 에만 걸린다 — 비밀번호를 새로 넣으면(판이 바뀜) 풀린 것으로 본다.
 * 못 읽으면 { unreadable }(호출부는 접속하지 않는다).
 */
export function accountStopFor(accountId, version = null) {
  const d = load();
  if (!d || loadErr.get()) return { unreadable: true };
  const id = t(accountId, 32);
  if (!Object.hasOwn(d.accountStops, id)) return null;
  const s = d.accountStops[id];
  if (version != null && s.version !== String(version)) return null;
  return { ...s };
}
export function listAccountStops() { const d = load(); return d && !loadErr.get() ? Object.entries(d.accountStops).map(([account, v]) => ({ account, ...v })) : null; }
/** 로그인 거부를 본 곳(폴러 · 연결 시험)이 부른다. 같은 판으로 이미 정지돼 있으면 다시 쓰지 않는다(주기마다 파일을 쓰지 않게). */
export function setAccountStop(accountId, { server = '', feature = '', version = '', accountName = '', now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const id = t(accountId, 32);
  if (!ACC_ID_RE.test(id)) return { ok: false, code: 'bad-account' };
  const d = draft();
  if (Object.hasOwn(d.accountStops, id) && d.accountStops[id].version === String(version)) return { ok: true, already: true };
  if (!Object.hasOwn(d.accountStops, id) && Object.keys(d.accountStops).length >= MAX_ACCOUNT_STOPS) return { ok: false, code: 'too-many' };
  d.accountStops[id] = { at: now, server: t(server, 128), feature: t(feature, 32), version: t(version, 20) };
  pushEvents(d, [{ kind: 'account-stopped', target: t(accountName, 64) || id, detail: `${t(server, 80)} 에서 로그인 거부 · ${t(feature, 32)}` }], now);
  return commit(d);
}
/** 풀기(한 대로 다시 확인 성공 · 사람이 풂 · 비밀번호를 바꿈). 없으면 할 일 없음. */
export function clearAccountStop(accountId, { by = '', accountName = '', why = '', now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const id = t(accountId, 32);
  const d = draft();
  if (!Object.hasOwn(d.accountStops, id)) return { ok: true, already: true };
  delete d.accountStops[id];
  pushEvents(d, [{ kind: 'account-resumed', target: t(accountName, 64) || id, by, detail: t(why, 120) }], now);
  return commit(d);
}
