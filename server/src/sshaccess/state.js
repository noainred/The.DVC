/**
 * sshaccess/state.js — SSH 공용 접속의 **상태 파일**(v3.9.0 · 설계 docs/design/ssh-access §8 · §9).
 *
 * 파일 `CONFIG_DIR/ssh-access-state.json`(0600 · 원자적 쓰기 · 로드 손상 preserveCorrupt — 비밀 없음):
 *   { stops:     { [법인(vCenter id)]: { at, by, reason } }            — 긴급 조치 ‘이 법인 키 사용 중지’
 *     installed: { [OS 등록 항목 id]: { at, by, host, port, username, file, keys:[{fingerprint,type,comment}], error } }
 *                                                                    — 서버의 authorized_keys 를 읽은 결과(공개키 지문만)
 *     events:    [ { at, kind, corp, target, by, detail } ] }         — 키 보안 사건(최근 MAX_EVENTS)
 *
 * 불변조건(sshaccess/CLAUDE.md):
 *  · **못 읽으면 키 접속을 멈춘다**(fail-closed) — 정지 기록을 모르는 채 키를 쓰면 ‘사용 중지’ 가 손상 한 번으로 풀린다. 쓰기도 거절한다
 *    (손상본을 빈 상태로 덮어쓰면 정지가 사라진다). `refs.resolveOsAuth` 가 `stopFor()` 의 unreadable 을 그대로 본다.
 *  · 백업 복원에서 빼다(`backup/stagedRestore.js RESTORE_EXCLUDE`) — 백업 시점 판본으로 되돌리면 그 뒤에 건 사용 중지가 풀린다.
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
export const MAX_INSTALLED_KEYS = 200;
const MAX_INSTALLED = 5000;
const MAX_STOPS = 500;

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

let cache = null;
const loadErr = makeLoadError();

function normInstalledKey(k) {
  if (!isObj(k)) return null;
  const fingerprint = t(k.fingerprint, 80);
  if (!FP_RE.test(fingerprint)) return null;
  return { fingerprint, type: t(k.type, 40), comment: t(k.comment, 120) };
}
function norm(j) {
  const stops = Object.create(null);
  for (const [corp, v] of Object.entries(isObj(j?.stops) ? j.stops : {}).slice(0, MAX_STOPS)) {
    const c = t(corp, 128);
    if (!c || !isObj(v)) continue;
    stops[c] = { at: num(v.at), by: t(v.by, 64), reason: t(v.reason, 300) };
  }
  const installed = Object.create(null);
  for (const [id, v] of Object.entries(isObj(j?.installed) ? j.installed : {}).slice(0, MAX_INSTALLED)) {
    const sid = t(id, 64);
    if (!sid || !isObj(v)) continue;
    installed[sid] = {
      at: num(v.at), by: t(v.by, 64), host: t(v.host, 256), port: Number(v.port) > 0 ? Math.round(Number(v.port)) : 22, username: t(v.username, 128),
      file: t(v.file, 200), error: t(v.error, 300),
      keys: (Array.isArray(v.keys) ? v.keys : []).map(normInstalledKey).filter(Boolean).slice(0, MAX_INSTALLED_KEYS),
      truncated: num(v.truncated),
    };
  }
  const events = (Array.isArray(j?.events) ? j.events : []).filter(isObj).slice(-MAX_EVENTS).map((e) => ({
    at: num(e.at), kind: t(e.kind, 40), corp: t(e.corp, 128), target: t(e.target, 128), by: t(e.by, 64), detail: t(e.detail, 300),
  }));
  return { stops, installed, events };
}

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(FILE())) cache = norm(JSON.parse(fs.readFileSync(FILE(), 'utf8')));
  } catch (e) { preserveCorrupt(FILE(), e?.message); loadErr.set(e); cache = null; }
  if (!cache) { loadErr.checkCorruptOnly(FILE()); cache = norm({}); }
  return cache;
}
export function _resetSshAccessStateForTest() { cache = null; loadErr.clear(); }
/** 로드 오류(손상 · 손상 보존본만) — 있으면 키 접속을 멈추고 쓰기를 거절한다. */
export function stateLoadError() { load(); return loadErr.get(); }

function unreadable() {
  load();
  const e = loadErr.get();
  return e ? { ok: false, code: 'state-unreadable', status: 503, reason: `SSH 공용 접속 상태 파일(${STATE_FILE_NAME})을 읽지 못해 바꾸지 않았습니다 — 손상 보존본(${STATE_FILE_NAME}.corrupt.*)을 확인하세요.` } : null;
}
function draft() {
  const d = load();
  return { stops: { ...d.stops }, installed: { ...d.installed }, events: d.events.slice() };
}
function commit(next) {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch (e) {
    return { ok: false, code: 'write-failed', status: 500, reason: `SSH 공용 접속 상태 파일을 쓰지 못했습니다(${String(e?.code || e?.message || e).slice(0, 80)}).` };
  }
  cache = norm(next);
  loadErr.clear();
  return { ok: true };
}

/**
 * 법인 사용 중지 판정 — 접속 자격 해석(refs.resolveOsAuth)이 키를 쓰기 전에 본다.
 * @returns {null | {unreadable:true} | {at:number, by:string, reason:string}}
 */
export function stopFor(corp) {
  load();
  if (loadErr.get()) return { unreadable: true };
  const c = t(corp, 128);
  return c && cache.stops[c] ? { ...cache.stops[c] } : null;
}
export function listStops() { load(); return Object.entries(cache.stops).map(([corp, v]) => ({ corp, ...v })); }

function pushEvent(d, ev, now) {
  d.events.push({ at: now, kind: t(ev.kind, 40), corp: t(ev.corp, 128), target: t(ev.target, 128), by: t(ev.by, 64), detail: t(ev.detail, 300) });
  if (d.events.length > MAX_EVENTS) d.events = d.events.slice(-MAX_EVENTS);
}

export function setCorpStop(corp, { by = '', reason = '', now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const c = t(corp, 128);
  if (!c) return { ok: false, code: 'bad-corp', reason: '법인을 고르세요.' };
  const d = draft();
  if (!d.stops[c] && Object.keys(d.stops).length >= MAX_STOPS) return { ok: false, code: 'too-many', reason: '사용 중지 기록이 너무 많습니다.' };
  d.stops[c] = { at: now, by: t(by, 64), reason: t(reason, 300) };
  pushEvent(d, { kind: 'corp-stop', corp: c, by, detail: t(reason, 300) }, now);
  return commit(d);
}
export function clearCorpStop(corp, { by = '', now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const c = t(corp, 128);
  const d = draft();
  if (!d.stops[c]) return { ok: false, code: 'not-stopped', status: 404, reason: '이 법인은 사용 중지 상태가 아닙니다.' };
  delete d.stops[c];
  pushEvent(d, { kind: 'corp-resume', corp: c, by }, now);
  return commit(d);
}

/** 서버의 authorized_keys 를 읽은 결과(공개키 지문만). */
export function noteInstalled(serverId, rec = {}, { now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const id = t(serverId, 64);
  if (!id) return { ok: false, code: 'bad-id', reason: '서버가 없습니다.' };
  const d = draft();
  d.installed[id] = { ...rec, at: now };
  const ids = Object.keys(d.installed);
  if (ids.length > MAX_INSTALLED) for (const x of ids.sort((a, b) => num(d.installed[a].at) - num(d.installed[b].at)).slice(0, ids.length - MAX_INSTALLED)) delete d.installed[x];
  return commit(d);
}
export function installedOf(serverId) { load(); const v = cache.installed[t(serverId, 64)]; return v ? structuredClone(v) : null; }
/** 등록부에서 지워진 서버의 읽은 결과 정리(ids = 지금 있는 서버 id 집합). 바뀐 것이 없으면 쓰지 않는다. */
export function pruneInstalled(ids) {
  if (unreadable()) return { ok: false };
  const d = draft();
  let n = 0;
  for (const id of Object.keys(d.installed)) if (!ids.has(id)) { delete d.installed[id]; n += 1; }
  return n ? commit(d) : { ok: true, removed: 0 };
}

/** 키 보안 사건 하나(쓰기 실패는 호출부를 막지 않는다 — 감사 로그가 원본이다). */
export function addEvent(ev = {}, { now = Date.now() } = {}) {
  if (unreadable()) return { ok: false };
  const d = draft();
  pushEvent(d, ev, now);
  return commit(d);
}
export function listEvents({ limit = 100 } = {}) { load(); return cache.events.slice(-Math.max(1, Math.min(MAX_EVENTS, limit))).reverse(); }
