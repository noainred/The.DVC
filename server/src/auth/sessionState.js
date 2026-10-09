/**
 * 서버측 세션 상태 — 폐기 목록 + 마지막 사용자 활동(2026-10-09 검토 S-05).
 *
 * 왜 필요한가: 이 포탈의 토큰은 무상태 서명 토큰이라 v2.729 까지 '로그아웃' 은 브라우저가 토큰을 지우는 것뿐이었다
 *   — 복사해 둔 토큰은 만료(기본 8시간)까지 계속 통과했고(`/auth/logout` 라우트 자체가 없었다), 유휴 자동 로그아웃도
 *   브라우저 타이머일 뿐이라 방치된 탭의 토큰을 다른 곳에서 쓰면 서버는 막지 않았다. 이 모듈이 서버에 그 사실을 남긴다.
 *
 * 저장(CONFIG_DIR/session-state.json, 0600, 원자 쓰기):
 *   { v:1, notBefore, revoked:{ sid:{u,until,at,why} }, revokedTokens:{ sha256:{u,until,at,why} }, activity:{ sid:{u,at,exp} } }
 *   - revoked       : 로그아웃한 세션 ID. 그 sid 로 이미 발급됐을 수 있는 가장 늦은 만료(until)까지만 들고 있는다.
 *   - revokedTokens : sid 가 없는 구버전 토큰의 로그아웃(토큰 원문의 sha256 — 원문은 저장하지 않는다).
 *   - activity      : sid 별 마지막 사용자 활동(초). 로그인·연장·`POST /auth/activity` 만 갱신한다(자동 폴링은 활동이 아니다).
 *   - notBefore     : 이 시각(초) 전에 로그인한 세션은 전부 무효. 상태 파일이 손상돼 폐기 목록을 잃었을 때 쓴다
 *                     (폐기 목록을 잃은 채 빈 목록으로 시작하면 로그아웃한 토큰이 되살아난다 — 그래서 '전원 재로그인' 쪽으로 실패한다).
 *
 * 설계 메모
 * - **조회는 인메모리 O(1)** — `resolveTokenUser` 는 매 요청(및 WS 재검증)마다 불린다. 파일은 기동 후 첫 사용 때 한 번 읽는다.
 * - 폐기는 드문 사건이라 **즉시** 원자 저장한다(재시작 직후에도 폐기가 유지돼야 한다). 활동은 잦으므로 디바운스(15초) 저장 +
 *   종료 flush(`registerExitFlush`) — 재시작으로 잃는 것은 최대 15초의 활동 시각뿐이다(유휴 판정을 그만큼 앞당길 뿐 열지는 않는다).
 * - 손상: `preserveCorrupt` 로 원본을 옆으로 치우고 **notBefore = 지금** 을 담은 새 파일을 바로 쓴다(재시작해도 그 판정이 남게).
 * - 단일 프로세스 가정(sessions.js 와 같다). 같은 AUTH_SECRET 을 공유하는 여러 노드는 노드마다 따로 판정한다 — 한 노드의
 *   로그아웃은 다른 노드에 전해지지 않는다(정직 기록).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerExitFlush } from '../util/exitFlush.js';
import { registerStateFile } from '../util/stateFiles.js';

// 파일 이름은 리터럴로 둔다 — scripts/config-doc.mjs 가 path.join(config.configDir, '<이름>') 모양으로 찾아 CONFIG-FILES.md 에 싣는다.
registerStateFile('session-state.json');
const FILE_NAME = 'session-state.json';
const FILE = () => path.join(config.configDir, 'session-state.json');

const ACTIVITY_MAX = 50_000;
const REVOKED_MAX = 100_000;
const SAVE_DEBOUNCE_MS = 15_000;

let _st = null;        // { notBefore, revoked:Map, revokedTokens:Map, activity:Map }
let _timer = null;
let _dirty = false;
let _flushReg = false;

const nowSec = () => Math.floor(Date.now() / 1000);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v, max = 128) => String(v ?? '').slice(0, max);

function emptyState() {
  return { notBefore: 0, revoked: new Map(), revokedTokens: new Map(), activity: new Map() };
}

function readMap(obj, map, shape) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const [k, rec] of Object.entries(obj)) {
    if (!k || typeof k !== 'string' || k.length > 128 || !rec || typeof rec !== 'object') continue;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const r = shape(rec);
    if (r) map.set(k, r);
  }
}

function load() {
  if (_st) return _st;
  const st = emptyState();
  const file = FILE();
  let raw = null;
  try { if (fs.existsSync(file)) raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { console.warn(`[sessionState] ${FILE_NAME} 읽기 실패(${e?.code || e?.message}) — 이 프로세스는 기존 세션을 전부 무효로 본다.`); st.notBefore = nowSec(); }
  if (raw != null) {
    let obj = null; let parsed = false;
    try { obj = JSON.parse(raw); parsed = true; } catch (e) { obj = null; preserveCorrupt(file, e?.message || 'JSON'); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      if (parsed) preserveCorrupt(file, '객체가 아님');
      // 폐기 목록을 잃었다 — 로그아웃한 토큰이 되살아나지 않게 지금 이전 로그인 세션을 전부 무효로 한다.
      st.notBefore = nowSec();
      console.warn(`[sessionState] ${FILE_NAME} 손상 — 폐기 목록을 잃어 지금 이전에 로그인한 세션을 전부 무효로 합니다(전원 재로그인).`);
      _st = st;
      persistNow();
      return _st;
    }
    st.notBefore = Math.max(0, Math.floor(num(obj.notBefore)));
    const revShape = (r) => { const until = Math.floor(num(r.until)); return until > 0 ? { u: str(r.u), until, at: Math.floor(num(r.at)), why: str(r.why, 40) } : null; };
    readMap(obj.revoked, st.revoked, revShape);
    readMap(obj.revokedTokens, st.revokedTokens, revShape);
    readMap(obj.activity, st.activity, (r) => { const at = Math.floor(num(r.at)); return at > 0 ? { u: str(r.u), at, exp: Math.floor(num(r.exp)) } : null; });
  }
  _st = st;
  return _st;
}

function prune(st, now = nowSec()) {
  for (const [k, r] of st.revoked) if (r.until <= now) st.revoked.delete(k);
  for (const [k, r] of st.revokedTokens) if (r.until <= now) st.revokedTokens.delete(k);
  for (const [k, r] of st.activity) if (r.exp && r.exp <= now) st.activity.delete(k);
  const cap = (map, max, key) => {
    if (map.size <= max) return;
    const sorted = [...map.entries()].sort((a, b) => a[1][key] - b[1][key]);
    for (let i = 0; i < sorted.length - max; i++) map.delete(sorted[i][0]);
  };
  cap(st.activity, ACTIVITY_MAX, 'at');
  if (st.revoked.size > REVOKED_MAX) {
    console.warn(`[sessionState] 폐기 목록이 상한(${REVOKED_MAX})을 넘어 가장 오래 남은 기록부터 지웁니다.`);
    cap(st.revoked, REVOKED_MAX, 'until');
  }
  cap(st.revokedTokens, REVOKED_MAX, 'until');
}

function serialize(st) {
  const o = (map) => { const r = Object.create(null); for (const [k, v] of map) r[k] = v; return r; };
  return JSON.stringify({ v: 1, notBefore: st.notBefore, revoked: o(st.revoked), revokedTokens: o(st.revokedTokens), activity: o(st.activity) });
}

function ensureFlush() {
  if (_flushReg) return;
  _flushReg = true;
  registerExitFlush('session-state', () => { if (_dirty || _timer) persistNow(); });
}

/** 즉시 원자 저장(동기). 실패는 경고만 — 인메모리 판정은 그대로 동작한다. */
export function persistNow() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  const st = load();
  prune(st);
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    atomicWriteFileSync(FILE(), serialize(st), { mode: 0o600 });
    _dirty = false;
  } catch (e) { console.warn(`[sessionState] ${FILE_NAME} 저장 실패: ${e?.message || e}`); }
}

function schedulePersist() {
  _dirty = true;
  ensureFlush();
  if (_timer) return;
  _timer = setTimeout(() => { _timer = null; persistNow(); }, SAVE_DEBOUNCE_MS);
  _timer.unref?.();
}

/** 토큰 원문의 지문(폐기 목록 키) — 원문은 저장하지 않는다. */
export function tokenDigest(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

/** 이 시각(초) 전에 로그인한 세션은 무효. 0 이면 없음. */
export function sessionNotBefore() { return load().notBefore || 0; }

/** 세션(sid)을 폐기한다 — untilSec 까지 기록을 들고 있는다. 즉시 저장. */
export function revokeSession(sid, { username = '', untilSec, reason = 'logout' } = {}) {
  const s = str(sid);
  if (!s) return false;
  const st = load();
  const until = Math.max(Math.floor(num(untilSec)), nowSec() + 60);
  const prev = st.revoked.get(s);
  st.revoked.set(s, { u: str(username), until: Math.max(until, prev?.until || 0), at: nowSec(), why: str(reason, 40) });
  st.activity.delete(s);
  ensureFlush();
  persistNow();
  return true;
}

/** sid 가 없는 토큰의 폐기(토큰 원문 지문). */
export function revokeTokenDigest(digest, { username = '', untilSec, reason = 'logout' } = {}) {
  const d = str(digest, 64);
  if (!/^[0-9a-f]{64}$/.test(d)) return false;
  const st = load();
  const until = Math.max(Math.floor(num(untilSec)), nowSec() + 60);
  st.revokedTokens.set(d, { u: str(username), until, at: nowSec(), why: str(reason, 40) });
  ensureFlush();
  persistNow();
  return true;
}

export function isSessionRevoked(sid) {
  if (!sid) return false;
  const r = load().revoked.get(String(sid));
  return !!r && r.until > nowSec();
}

export function isTokenDigestRevoked(digest) {
  if (!digest) return false;
  const r = load().revokedTokens.get(String(digest));
  return !!r && r.until > nowSec();
}

/** 사용자 활동을 기록한다(로그인·연장·활동 신호). expSec 은 그 토큰의 만료(기록 정리 기준). */
export function noteActivity(sid, { username = '', atSec = nowSec(), expSec = 0 } = {}) {
  const s = str(sid);
  if (!s) return false;
  const st = load();
  if (st.revoked.has(s)) return false;           // 폐기된 세션은 되살리지 않는다
  const prev = st.activity.get(s);
  const at = Math.max(Math.floor(num(atSec)), prev?.at || 0);
  const exp = Math.max(Math.floor(num(expSec)), prev?.exp || 0);
  st.activity.set(s, { u: str(username), at, exp });
  schedulePersist();
  return true;
}

/**
 * 마지막 활동(초). 기록이 없으면(상태 파일 유실·다른 노드가 발급·기능 도입 전 sid) **지금을 처음 본 시각으로 기록**하고
 * 그 값을 돌려준다 — 기록이 없다는 이유로 멀쩡한 세션을 끊지 않는다(대신 그때부터 유휴를 잰다).
 */
export function lastActivity(sid, { username = '', expSec = 0, now = nowSec() } = {}) {
  const s = str(sid);
  if (!s) return null;
  const st = load();
  const rec = st.activity.get(s);
  if (rec) return rec.at;
  st.activity.set(s, { u: str(username), at: now, exp: Math.floor(num(expSec)) });
  schedulePersist();
  return now;
}

/** 이 사용자의 활동 기록을 지운다(계정 삭제 등 — 정리용). */
export function forgetUserActivity(username) {
  const u = String(username || '').toLowerCase();
  if (!u) return 0;
  const st = load();
  let n = 0;
  for (const [k, r] of st.activity) if (String(r.u).toLowerCase() === u) { st.activity.delete(k); n++; }
  if (n) schedulePersist();
  return n;
}

/** 진단 — 개수만(sid 자체는 노출하지 않는다). */
export function sessionStateStats() {
  const st = load();
  return { revoked: st.revoked.size, revokedTokens: st.revokedTokens.size, activity: st.activity.size, notBefore: st.notBefore || 0 };
}

/** 테스트용 — 인메모리 상태를 버려 다음 조회 때 파일에서 다시 읽게 한다(타이머도 정리). */
export function _resetSessionStateForTest({ flush = false } = {}) {
  if (flush && (_dirty || _timer)) persistNow();
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _st = null; _dirty = false;
}
