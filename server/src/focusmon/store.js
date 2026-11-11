/**
 * focusmon/store.js — 중앙의 집중 모니터링 상태(v2.976): **최근 31분 메모리 묶음 · 수집(세션) · 대상 상태 · 엣지 상태 · DB 쓰기 대기열**.
 *
 * ── 메모리 ───────────────────────────────────────────────────────────────────────────────────────────
 *  · 대상마다 지금 분의 열린 묶음(배열) + 닫힌 묶음(Float32Array · null = NaN) 최근 31분. 실시간 화면(1 · 5 · 10 · 30분 구간)은 여기만 읽는다.
 *    측정: 서버 1대 · 1분 ≈ 시리즈 340개 × 30표본 × 4바이트 ≈ 40KB → 20대 31분 ≈ 25MB(추정 — 시리즈 수는 서버마다 다르다).
 *  · 분이 끝나고 GRACE(15초)가 지나면 닫고 압축해 DB 대기열에 넣는다. 늦게 온 표본(엣지 묶음)은 닫힌 묶음을 다시 열어 붙이고 다시 쓴다(5분 안).
 *  · 수집 중이 아니고 31분 동안 새 값이 없는 대상은 메모리에서 뺀다(DB 에는 남아 있다).
 * ── 수집(세션) ──────────────────────────────────────────────────────────────────────────────────────────
 *  · 방식 두 가지(사용자 결정 2026-11-11 ‘DB 에 저장 · 30일’ — 30일 뒤로 가려면 그때도 수집 중이어야 해서 ‘계속 수집’ 을 둔다):
 *    `watch`(잠깐 보기 — 15분 · 연장 · 최대 2시간 · 보는 화면이 60초 없으면 끝) · `record`(계속 수집 — 끌 때까지 · 재시작 뒤 스스로 재개).
 *  · 상한: 수집 3건 · 한 수집 20대 · 전체 서로 다른 대상 40대 · 계속 수집 대상 20대.
 *  · 계속 수집 중이고 보는 화면이 없으면 그 대상의 주기를 10초로 낮춘다(대상 · 회선 · DB 부담 약 1/5).
 *  · 끝나는 시각이 반드시 있다(잠깐 보기) — 시한 없는 것은 사람이 일부러 켠 계속 수집뿐.
 * 계속 수집 정의는 `focusmon-sessions.json`(상태 파일 — 비밀 없음 · 원자적 쓰기).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { flattenSample, newBlock, appendToBlock, encodeBlock, encodeProcBlock } from './codec.js';
import { normInterval } from './script.js';

export const RECENT_MIN = 31;
export const GRACE_MS = 15_000;
export const LATE_MAX_MS = 5 * 60_000;
export const MAX_SESSIONS = 3;
export const MAX_PER_SESSION = 20;
export const MAX_TOTAL_TARGETS = 40;
export const MAX_RECORD_TARGETS = 20;
export const WATCH_MIN = 15;
export const WATCH_MAX_MIN = 120;
export const VIEWER_TTL_MS = 60_000;
export const IDLE_INTERVAL = 10;
const START_GRACE_MS = 90_000;

const SESS_FILE = registerStateFile('focusmon-sessions.json');
const sessFile = () => path.join(config.configDir, SESS_FILE);

/* ── 대상 메모리 ─────────────────────────────────────────────────────────────── */
const T = new Map(); // id → { cur, recent:[closed], procs: Map(minute → [snap]), latest, latestProcs, hello, lastAt }
const writeQ = [];   // { kind, target, minute, n?, data }
const counters = { lateDropped: 0, rewrites: 0, closed: 0 };

function entry(id) {
  let e = T.get(id);
  if (!e) { e = { cur: null, recent: [], reopen: new Map(), procs: new Map(), latest: null, latestProcs: null, hello: null, lastAt: 0 }; T.set(id, e); }
  return e;
}

/** 열린 묶음(배열) → 닫힌 묶음(Float32Array). */
function freeze(block) {
  const cols = new Map();
  for (const [k, arr] of block.cols) { const f = new Float32Array(arr.length); for (let i = 0; i < arr.length; i++) f[i] = arr[i] == null ? NaN : arr[i]; cols.set(k, f); }
  return { minute: block.minute, ts: Float64Array.from(block.ts), cols, meta: block.meta, frozen: true };
}
function thaw(block) {
  const cols = new Map();
  for (const [k, f] of block.cols) cols.set(k, Array.from(f, (x) => (Number.isNaN(x) ? null : x)));
  return { minute: block.minute, ts: Array.from(block.ts), cols, meta: block.meta };
}

function enqueueBlock(id, block, procList) {
  try { writeQ.push({ kind: 'm', target: id, minute: block.minute, n: block.ts.length, data: encodeBlock(block) }); } catch { /* 묶음 하나가 대기열 전체를 깨지 않게 */ }
  if (procList && procList.length) { try { writeQ.push({ kind: 'p', target: id, minute: block.minute, data: encodeProcBlock(procList) }); } catch { /* */ } }
  if (writeQ.length > 20_000) writeQ.splice(0, writeQ.length - 20_000); // DB 가 오래 막혀도 메모리가 끝없이 자라지 않게(오래된 것부터 버림)
}

function closeCur(id, e) {
  if (!e.cur || !e.cur.ts.length) { e.cur = null; return; }
  const b = e.cur; e.cur = null;
  enqueueBlock(id, b, e.procs.get(b.minute));
  e.recent.push(freeze(b));
  counters.closed += 1;
  const cut = b.minute - RECENT_MIN;
  while (e.recent.length && e.recent[0].minute < cut) e.recent.shift();
  for (const m of e.procs.keys()) if (m < cut) e.procs.delete(m);
}

/** 표본 받기. ts = 수신 시각(중앙) 또는 엣지 표본을 수신 시각으로 옮긴 값. */
export function ingestSample(id, ts, sample, hello, now = Date.now()) {
  if (!sample || !(ts > 0)) return false;
  const e = entry(id);
  if (hello) e.hello = hello;
  const minute = Math.floor(ts / 60_000);
  const { row, meta } = flattenSample(sample);
  if (e.cur && minute > e.cur.minute) closeCur(id, e);
  if (!e.cur && (!e.recent.length || minute > e.recent[e.recent.length - 1].minute)) e.cur = newBlock(minute);
  if (e.cur && minute === e.cur.minute) {
    appendToBlock(e.cur, ts, row, meta);
  } else {
    // 늦게 온 표본 — 닫힌 묶음을 **한 번만** 다시 열어(분마다) 모아 두고, flushReopened 가 분마다 한 번 얼려 다시 쓴다(5분 안).
    // 예전에는 표본마다 묶음 전체를 풀고 다시 압축해 대기열에 넣었다 — 표본 N 개면 O(N²) 이라, 엣지 한 곳이 늦은 표본 300개로
    // 중앙 요청 경로를 30초 막고 메모리를 수백 MB 붙잡았다(2026-11-11 반증 1번 — 재현).
    if (now - ts > LATE_MAX_MS) { counters.lateDropped += 1; return false; }
    let b = e.reopen.get(minute);
    if (!b) {
      const i = e.recent.findIndex((x) => x.minute === minute);
      b = i >= 0 ? thaw(e.recent[i]) : newBlock(minute);
      e.reopen.set(minute, b);
    }
    if (!appendToBlock(b, ts, row, meta)) { counters.lateDropped += 1; return false; }
  }
  if (!e.latest || ts >= e.latest.ts) e.latest = { ts, sample };
  e.lastAt = Math.max(e.lastAt, ts);
  return true;
}

export function ingestProcs(id, ts, p) {
  if (!p || !(ts > 0)) return false;
  const e = entry(id);
  const minute = Math.floor(ts / 60_000);
  const list = e.procs.get(minute) || [];
  if (list.length < 60) list.push({ t: ts, n: p.n ?? null, top: p.top || [] });
  e.procs.set(minute, list);
  if (!e.latestProcs || ts >= e.latestProcs.ts) e.latestProcs = { ts, ...p };
  return true;
}

/** 다시 연 늦은 묶음을 분마다 한 번 얼려 메모리 묶음을 바꾸고 다시 쓴다. id 를 주면 그 대상만. 바꾼 묶음 수. */
export function flushReopened(id = null) {
  let n = 0;
  const one = (tid, e) => {
    if (!e.reopen?.size) return;
    for (const [minute, b] of e.reopen) {
      if (!b.ts.length) continue;
      const fz = freeze(b);
      const i = e.recent.findIndex((x) => x.minute === minute);
      if (i >= 0) e.recent[i] = fz; else { e.recent.push(fz); e.recent.sort((a, c) => a.minute - c.minute); }
      enqueueBlock(tid, b, e.procs.get(minute));
      counters.rewrites += 1; n += 1;
    }
    e.reopen.clear();
  };
  if (id != null) { const e = T.get(id); if (e) one(id, e); } else for (const [tid, e] of T) one(tid, e);
  return n;
}

/** 분 닫기 · 메모리 정리(1초 틱). 수집 중인 대상 집합을 받아 그 밖의 오래된 대상은 뺀다. */
export function closeMinutes(now = Date.now(), activeIds = new Set()) {
  flushReopened();
  for (const [id, e] of T) {
    if (e.cur && now > (e.cur.minute + 1) * 60_000 + GRACE_MS) closeCur(id, e);
    if (!activeIds.has(id) && now - e.lastAt > RECENT_MIN * 60_000 && !e.cur) T.delete(id);
  }
}

/** 메모리의 묶음들(닫힌 것 + 열린 것) — 조회용. 열린 묶음은 그대로(배열), 닫힌 것은 Float32. */
export function memBlocks(id) {
  const e = T.get(id);
  if (!e) return [];
  return e.cur ? [...e.recent, e.cur] : [...e.recent];
}
export function memProcs(id) { return T.get(id)?.procs || new Map(); }
export function latestOf(id) { return T.get(id)?.latest || null; }
export function latestProcsOf(id) { return T.get(id)?.latestProcs || null; }
export function helloOf(id) { return T.get(id)?.hello || null; }
export function memOldestMinute(id) { const b = memBlocks(id); return b.length ? b[0].minute : null; }

export function drainWrites(max = 400) { return writeQ.splice(0, max); }
export function pendingWrites() { return writeQ.length; }
/** 종료 직전 — 열린 묶음을 모두 닫아 대기열에 넣는다(recorder.flushSync 가 쓴다). */
export function closeAll() { flushReopened(); for (const [id, e] of T) closeCur(id, e); }
export function memStats() {
  let blocks = 0; let values = 0;
  for (const e of T.values()) for (const b of [...e.recent, ...(e.cur ? [e.cur] : [])]) { blocks += 1; for (const a of b.cols.values()) values += a.length; }
  return { targets: T.size, blocks, values, approxBytes: values * 4, ...counters, queue: writeQ.length };
}

/* ── 수집(세션) ─────────────────────────────────────────────────────────────── */
const S = new Map(); // id → session
const lastView = new Map(); // targetId → ts
let sessLoaded = false;
const ended = []; // 끝난 수집(최근 20 — 화면 안내 · DB fm_run 이 진실)

function loadSessions() {
  if (sessLoaded) return;
  sessLoaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(sessFile(), 'utf8'));
    for (const x of Array.isArray(j?.sessions) ? j.sessions : []) {
      if (!x || typeof x !== 'object' || x.mode !== 'record' || !/^fs-[a-f0-9]{8,16}$/.test(String(x.id))) continue;
      const targets = (Array.isArray(x.targets) ? x.targets : []).map(String).filter((t) => /^fm-[a-z0-9]{6,20}$/.test(t)).slice(0, MAX_PER_SESSION);
      if (!targets.length) continue;
      S.set(x.id, { id: x.id, mode: 'record', by: String(x.by || '').slice(0, 64), targets, interval: normInterval(x.interval), startedAt: Number(x.startedAt) || Date.now(), until: null, lastViewAt: 0, resumed: true });
    }
  } catch (e) {
    // 없음은 조용히 · 손상은 옆으로 보존한 뒤 새로 시작한다(다음 저장이 온전했던 원본을 빈 목록으로 덮어쓰지 않게 — ARCH-1).
    if (e?.code !== 'ENOENT') preserveCorrupt(sessFile(), String(e?.message || e));
  }
}
function persistSessions() {
  try {
    const list = [...S.values()].filter((x) => x.mode === 'record').map(({ id, mode, by, targets, interval, startedAt }) => ({ id, mode, by, targets, interval, startedAt }));
    fs.mkdirSync(config.configDir, { recursive: true });
    atomicWriteFileSync(sessFile(), JSON.stringify({ v: 1, sessions: list }, null, 2), { mode: 0o600 });
  } catch (e) { console.warn(`[focusmon] 계속 수집 정의를 쓰지 못했습니다(재시작하면 다시 켜야 합니다): ${String(e?.message || e).slice(0, 160)}`); }
}

export function listSessions(now = Date.now()) {
  loadSessions();
  return [...S.values()].map((x) => ({ ...x, targets: [...x.targets], remainMs: x.until ? Math.max(0, x.until - now) : null }));
}
export function endedSessions() { return ended.slice(); }
export function getSession(id) { loadSessions(); const x = S.get(String(id)); return x ? { ...x, targets: [...x.targets] } : null; }

/**
 * 수집 시작 — 검사는 여기 한 곳(라우트는 대상 존재 · 권한만 본다).
 * @returns {{ok:true, session}|{ok:false, code, reason}}
 */
export function startSession({ targets = [], interval, mode = 'watch', by = '' } = {}, now = Date.now()) {
  loadSessions();
  const ids = [...new Set((Array.isArray(targets) ? targets : []).map(String))];
  if (!ids.length) return { ok: false, code: 'no-targets', reason: '수집할 서버를 하나 이상 고르세요.' };
  if (ids.length > MAX_PER_SESSION) return { ok: false, code: 'too-many', reason: `한 번에 ${MAX_PER_SESSION}대까지 고를 수 있습니다.` };
  if (mode !== 'watch' && mode !== 'record') return { ok: false, code: 'bad-mode', reason: '방식은 잠깐 보기 또는 계속 수집입니다.' };
  if (S.size >= MAX_SESSIONS) return { ok: false, code: 'too-many-sessions', reason: `동시에 ${MAX_SESSIONS}건까지 수집합니다 — 진행 중인 수집을 끝내거나 그 수집에 붙어 보세요.` };
  const all = new Set(); const rec = new Set();
  for (const x of S.values()) for (const t of x.targets) { all.add(t); if (x.mode === 'record') rec.add(t); }
  for (const t of ids) { all.add(t); if (mode === 'record') rec.add(t); }
  if (all.size > MAX_TOTAL_TARGETS) return { ok: false, code: 'too-many-total', reason: `포탈 전체에서 동시에 ${MAX_TOTAL_TARGETS}대까지 수집합니다.` };
  if (rec.size > MAX_RECORD_TARGETS) return { ok: false, code: 'too-many-record', reason: `계속 수집은 포탈 전체 ${MAX_RECORD_TARGETS}대까지입니다.` };
  const s = { id: `fs-${crypto.randomBytes(5).toString('hex')}`, mode, by: String(by || '').slice(0, 64), targets: ids, interval: normInterval(interval), startedAt: now,
    until: mode === 'watch' ? now + WATCH_MIN * 60_000 : null, lastViewAt: now };
  S.set(s.id, s);
  for (const t of ids) lastView.set(t, now);
  if (mode === 'record') persistSessions();
  return { ok: true, session: { ...s, targets: [...ids] } };
}

export function extendSession(id, now = Date.now()) {
  loadSessions();
  const s = S.get(String(id));
  if (!s) return { ok: false, code: 'not-found', reason: '없는 수집입니다(이미 끝났을 수 있습니다).' };
  if (s.mode !== 'watch') return { ok: false, code: 'not-watch', reason: '계속 수집에는 시한이 없습니다.' };
  const cap = s.startedAt + WATCH_MAX_MIN * 60_000;
  if (s.until >= cap) return { ok: false, code: 'max', reason: `잠깐 보기는 시작부터 최대 ${WATCH_MAX_MIN / 60}시간입니다 — 계속 보려면 계속 수집으로 시작하세요.` };
  s.until = Math.min(cap, Math.max(s.until, now) + WATCH_MIN * 60_000);
  return { ok: true, session: { ...s, targets: [...s.targets] } };
}

export function stopSession(id, why = 'stopped', now = Date.now()) {
  loadSessions();
  const s = S.get(String(id));
  if (!s) return { ok: false, code: 'not-found', reason: '없는 수집입니다(이미 끝났을 수 있습니다).' };
  S.delete(s.id);
  ended.unshift({ ...s, targets: [...s.targets], endedAt: now, why });
  if (ended.length > 20) ended.length = 20;
  if (s.mode === 'record') persistSessions();
  return { ok: true, session: { ...s, endedAt: now, why } };
}

/** 대상을 보고 있다(화면 조회가 부른다). */
export function touchView(ids = [], now = Date.now()) {
  loadSessions();
  const set = new Set(ids.map(String));
  for (const t of set) lastView.set(t, now);
  for (const s of S.values()) if (s.targets.some((t) => set.has(t))) s.lastViewAt = now;
}

/** 잠깐 보기의 시한 · 보는 화면 없음을 처리한다(1초 틱). 끝낸 수집 목록. */
export function expireSessions(now = Date.now()) {
  loadSessions();
  const out = [];
  for (const s of [...S.values()]) {
    if (s.mode !== 'watch') continue;
    if (now >= s.until) out.push(stopSession(s.id, 'timeout', now).session);
    else if (now - s.startedAt > START_GRACE_MS && now - s.lastViewAt > VIEWER_TTL_MS) out.push(stopSession(s.id, 'no-viewer', now).session);
  }
  return out;
}

/** 엣지 표본을 받을 대상 — 지금 수집 중이거나, 끝난 지 LATE_MAX_MS 안인 수집의 대상(엣지가 끊긴 동안 모은 표본). */
export function acceptingTargetIds(now = Date.now()) {
  const out = activeTargetIds();
  for (const x of ended) if (now - x.endedAt <= LATE_MAX_MS) for (const t of x.targets) out.add(t);
  return out;
}

/** 지금 수집 중인 대상 id 전부. */
export function activeTargetIds() {
  loadSessions();
  const out = new Set();
  for (const s of S.values()) for (const t of s.targets) out.add(t);
  return out;
}

/**
 * 노드가 지금 수집할 목록. resolve(id) → 등록부 대상(없으면 건너뜀). agentKey ''=중앙.
 * 주기 = 그 대상을 담은 수집들의 최소 주기 · 계속 수집뿐이고 60초 안에 본 화면이 없으면 10초.
 */
export function desiredFor(agentKey, resolve, now = Date.now()) {
  loadSessions();
  const want = new Map();
  const key = String(agentKey || '').toLowerCase();
  for (const s of S.values()) {
    for (const id of s.targets) {
      const t = resolve(id);
      if (!t || t.enabled === false || String(t.agent || '').toLowerCase() !== key) continue;
      const prev = want.get(id);
      const watch = (prev?.watch || false) || s.mode === 'watch';
      const iv = prev ? Math.min(prev.interval, s.interval) : s.interval;
      want.set(id, { id, host: t.host, port: t.port, username: t.username, demo: !!t.demo, interval: iv, watch });
    }
  }
  return [...want.values()].map((d) => {
    const viewed = now - (lastView.get(d.id) || 0) <= VIEWER_TTL_MS;
    return { id: d.id, host: d.host, port: d.port, username: d.username, demo: d.demo, interval: !d.watch && !viewed ? Math.max(d.interval, IDLE_INTERVAL) : d.interval };
  });
}

/* ── 대상 상태 · 엣지 상태 ─────────────────────────────────────────────────── */
const ST = new Map(); // targetId → { ...status, at }
const EDGE = new Map(); // agentLower → { agent, at, version, key, ok, error, statusCount }
const KEYS_FILE = registerStateFile('focusmon-keys.json');
let keysLoaded = false;

export function setStatus(id, st, now = Date.now()) { ST.set(String(id), { ...st, at: now }); }
export function statusOf(id) { return ST.get(String(id)) || null; }

function loadKeys() {
  if (keysLoaded) return;
  keysLoaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(config.configDir, KEYS_FILE), 'utf8'));
    for (const [k, v] of Object.entries(j?.edges || {})) if (v && typeof v === 'object') EDGE.set(k, { agent: String(v.agent || k).slice(0, 128), at: Number(v.at) || 0, version: String(v.version || '').slice(0, 32), key: v.key || null, keySeenAt: Number(v.keySeenAt) || 0 });
  } catch (e) { if (e?.code !== 'ENOENT') preserveCorrupt(path.join(config.configDir, KEYS_FILE), String(e?.message || e)); }
}
function persistKeys() {
  try {
    const edges = {};
    for (const [k, v] of EDGE) edges[k] = { agent: v.agent, at: v.at, version: v.version, key: v.key, keySeenAt: v.keySeenAt || 0 };
    atomicWriteFileSync(path.join(config.configDir, KEYS_FILE), JSON.stringify({ v: 1, edges }, null, 2), { mode: 0o600 });
  } catch { /* 화면 안내용 — 못 써도 다음 동기화가 다시 채운다 */ }
}
/** 엣지 동기화 기록(정제된 값만 들어온다). 공개키가 바뀌었을 때만 파일에 쓴다. */
export function noteEdgeSync(agent, { version = '', key = null, diag = null } = {}, now = Date.now()) {
  loadKeys();
  const k = String(agent || '').toLowerCase();
  const prev = EDGE.get(k) || {};
  const keyChanged = key && JSON.stringify(key) !== JSON.stringify(prev.key || null);
  // diag(v2.978 — 엣지 연결 진단)는 메모리만: 재시작하면 다음 동기화(최대 쉬는 주기)에 다시 온다. 옛 판 엣지는 보내지 않는다(null).
  EDGE.set(k, { agent: String(agent), at: now, version: String(version || '').slice(0, 32), key: key || prev.key || null, keySeenAt: key ? now : (prev.keySeenAt || 0),
    diag: diag || null, syncs: (prev.syncs || 0) + 1, firstAt: prev.firstAt || now });
  if (keyChanged) persistKeys();
}

/* ── 깨우기 결과(v2.978 — 엣지 연결 진단) ─────────────────────────────────────
 * 중앙 → 엣지 직접 호출(collector 라우트)이 닿았는지. 닿지 않아도 엣지의 쉬는 주기 조회가 받으므로 '못 닿음' 은 장애가 아니라 '시작이 느림' 이다.
 * 메모리만(재시작하면 비어 '아직 깨운 적 없음'). 사유 글자는 pullFromEdge 문구(주소 · 토큰 값 없음)를 200자로 자른다. */
const WAKES = new Map(); // agentLower → { at, ok, kind, ms, reason, by }
export function noteEdgeWake(agent, { ok = false, kind = null, ms = null, reason = '', by = 'auto' } = {}, now = Date.now()) {
  const k = String(agent || '').toLowerCase();
  if (!k) return;
  WAKES.set(k, { at: now, ok: ok === true, kind: kind ? String(kind).slice(0, 40) : null, ms: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null, reason: String(reason || '').slice(0, 200), by: by === 'manual' ? 'manual' : 'auto' });
  if (WAKES.size > 500) WAKES.delete(WAKES.keys().next().value);
}
export function edgeWakeOf(agent) { const v = WAKES.get(String(agent || '').toLowerCase()); return v ? { ...v } : null; }
export function edgeStates() { loadKeys(); return [...EDGE.values()].map((v) => ({ ...v })); }
export function edgeStateOf(agent) { loadKeys(); const v = EDGE.get(String(agent || '').toLowerCase()); return v ? { ...v } : null; }

/* ── 연결 시험(엣지 대행 대기열) ────────────────────────────────────────────── */
const TESTS = new Map(); // targetId → { agent, requestedAt, result, at }
export function requestEdgeTest(id, agent, now = Date.now()) { TESTS.set(String(id), { agent: String(agent).toLowerCase(), requestedAt: now, result: null, at: 0 }); }
/** 엣지 한 곳이 동시에 돌리는 연결 시험 상한(v2.978 반증 1 — 일괄 시험이 동기화마다 20건씩 쌓아 동시 160건까지 갔다). 엣지 워커도 같은 값을 지킨다. */
export const EDGE_TEST_CONCURRENCY = 8;
/** 엣지 시험 대기열 수명 — 일괄 시험(최대 등록 상한 대수)이 동시 상한으로 차례를 기다리는 시간을 덮는다(예전 5분). */
export const EDGE_TEST_TTL_MS = 15 * 60_000;
/**
 * 이 엣지에 지금 배달할 시험. busy = 엣지가 같은 동기화 본문에서 보고한 진행 중 시험 수(diag.testsBusy — 옛 판은 null → 예전처럼 최대 20).
 */
export function pendingTestsFor(agent, now = Date.now(), { busy = null } = {}) {
  const k = String(agent || '').toLowerCase();
  const out = [];
  const room = busy == null ? 20 : Math.max(0, Math.min(20, EDGE_TEST_CONCURRENCY - busy));
  if (!room) return out;
  // 한 번 내려보낸 시험은 60초 동안 다시 내려보내지 않는다 — 결과가 올 때까지 2초마다 같은 시험을 다시 줘 클릭 한 번에 로그인이 여러 번 일어났다(반증 5번).
  for (const [id, x] of TESTS) {
    if (x.agent !== k || x.result || now - x.requestedAt >= EDGE_TEST_TTL_MS) continue;
    if (x.deliveredAt && now - x.deliveredAt < 60_000) continue;
    out.push(id);
    if (out.length >= room) break;
  }
  for (const id of out) TESTS.get(id).deliveredAt = now;
  return out;
}
export function putTestResult(id, result, now = Date.now()) {
  const x = TESTS.get(String(id));
  TESTS.set(String(id), { ...(x || { agent: '', requestedAt: now }), result, at: now });
}
export function testOf(id) { const x = TESTS.get(String(id)); return x ? { ...x } : null; }

/* ── 다시 연결(엣지 대행) ──────────────────────────────────────────────────── */
const RETRIES = new Map(); // targetId → { agent, at }
export function requestEdgeRetry(id, agent, now = Date.now()) { RETRIES.set(String(id), { agent: String(agent).toLowerCase(), at: now }); }
export function takeEdgeRetries(agent, now = Date.now()) {
  const k = String(agent || '').toLowerCase();
  const out = [];
  for (const [id, x] of RETRIES) { if (x.agent === k) { if (now - x.at < 5 * 60_000) out.push(id); RETRIES.delete(id); } }
  return out;
}

export function _resetForTest() {
  T.clear(); writeQ.length = 0; S.clear(); lastView.clear(); ST.clear(); EDGE.clear(); WAKES.clear(); TESTS.clear(); RETRIES.clear(); ended.length = 0;
  sessLoaded = false; keysLoaded = false; counters.lateDropped = 0; counters.rewrites = 0; counters.closed = 0;
}
