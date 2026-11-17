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
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 107회차: 읽기 오류 ≠ 손상(공용 읽기 — 30초 간격 재읽기)
import { registerStateFile } from '../util/stateFiles.js';
import { flattenSample, newBlock, appendToBlock, encodeBlock, encodeProcBlock } from './codec.js';
import { normInterval } from './script.js';
import { summarizeBlock, encodeSum } from './summary.js'; // v3.13.0 ⑭ 1분 요약
import { BOOT_ID_RE } from './parse.js'; // v3.16.0 ⑯ 반증 M5 — 부팅 식별(boot_id)

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
const counters = { lateDropped: 0, rewrites: 0, closed: 0, eventsDropped: 0, kmCut: 0 };
/** 반증 M4: 사건은 데이터와 같은 대기열이지만 **따로 상한**(사건이 다른 서버의 분 묶음을 밀어내지 않게 — 넘치면 새 사건을 버리고 센다). */
export const MAX_Q_EVENTS = 5000;
let qEv = 0;
const recountEv = () => { qEv = 0; for (const r of writeQ) if (r.kind === 'e') qEv += 1; };

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
  // v3.13.0(⑭ 컨펌 ② '기록할 때 같이 만든다'): 1분 요약 — 늦은 표본으로 다시 쓸 때(flushReopened)도 같은 길이라 요약도 다시 쓴다
  try { const sm = summarizeBlock(block); if (sm) writeQ.push({ kind: 's1', target: id, minute: block.minute, data: encodeSum(sm) }); } catch { /* 요약 하나가 대기열을 깨지 않게 */ }
  // v3.14.0(⑮ 컨펌 ③ '분마다 상위 20 · 30일'): 앱 묶음은 그 분의 **마지막 표본에만** 남긴다(표본마다 남기면 프로세스 기록이 두 배가 된다 · 메모리의 최근 표본은 그대로)
  if (procList && procList.length) { try { const last = procList.length - 1; writeQ.push({ kind: 'p', target: id, minute: block.minute, data: encodeProcBlock(procList.map((s, i) => (!s.apps ? s : i === last ? (s.apps.all ? { ...s, apps: { sv: s.apps.sv, cm: s.apps.cm } } : s) : { ...s, apps: undefined }))) }); } catch { /* */ } }
  if (writeQ.length > 20_000) { writeQ.splice(0, writeQ.length - 20_000); recountEv(); } // DB 가 오래 막혀도 메모리가 끝없이 자라지 않게(오래된 것부터 버림)
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
  if (sample.km) ingestKmsg(id, sample.km, ts); // v3.16.0 ⑯ C2 — 커널 메시지 증분(표본마다 한 번 실린다)
  e.lastAt = Math.max(e.lastAt, ts);
  // v3.13.0(⑭ 자동 사건): 가동 시간이 줄면 재부팅(30초 넘게 — 표본 순서가 바뀐 것과 가른다)
  if (Number.isFinite(sample.up)) {
    // 사건 시각 = 켜진 시각(지금 − 가동 시간) — 쉬던 동안의 재부팅을 다시 받은 시각에 찍지 않는다(반증 F9) · 앞 표본보다 앞으로는 가지 않는다
    //   가동 시간이 **줄었을 때만** 재부팅이다. 공백 뒤 '흘렀어야 할 가동 시간' 과 견주는 판정은 넣었다가 뺐다(반증 재검토 N1 — WAN 이 끊겼다 붙으면
    //   중앙이 엣지 표본 시각을 수신 시각 − 10분으로 당겨 벽시계 공백만 커지고 가동 시간은 그대로라 재부팅이 없는데도 사건이 생겼다).
    //   한계: 쉬던 동안 재부팅했고 새 가동 시간이 예전 값보다 커졌으면 놓친다(거짓 사건보다 놓침을 고른다).
    const rebooted = Number.isFinite(e.lastUp) && sample.up + 30 < e.lastUp;
    if (rebooted && ts >= (e.lastUpAt || 0)) queueEvent(id, 'reboot', '재부팅 — 가동 시간이 줄었습니다', Math.max(e.lastUpAt || 0, Math.round(ts - sample.up * 1000)));
    if (ts >= (e.lastUpAt || 0)) { e.lastUp = sample.up; e.lastUpAt = ts; }
  }
  return true;
}

/* ── 커널 메시지(v3.16.0 ⑯ C2 — OOM · 커널 오류) ─────────────────────────────── */
const KM = new Map(); // targetId → { rc, at } — 화면 '읽기' 칸(rc 0 = 읽음 · 그 밖 = 권한 없음 · 응답 없음)
const KMT = new Map(); // targetId → { bid, tot } — 이번 부팅의 커널 오류 누계(첫 확인의 버퍼 전체 수 + 증분 · 모르면 tot null)
const KMR = new Map(); // targetId → { m, n } — 분당 OOM 사건 수(반증 M4 상한)
export const KM_OOM_PER_MIN = 40;
/**
 * 증분 하나 → 사건(OOM 은 프로그램마다 · 그 밖 오류는 줄 수 한 줄). 원문은 없다.
 *  · 열쇠는 (부팅 식별, 부팅 뒤 초) — 부팅 식별은 boot_id(반증 M5: 켜진 시각 10초 반올림은 받은 시각에 따라 흔들려 같은 OOM 이 두 사건이 됐다) ·
 *    옛 엣지(boot_id 없음)는 예전 열쇠(켜진 시각 10초 — 't' 를 붙여 구분).
 *  · 커널 오류 수: 첫 확인(f — 새 세션)은 **버퍼 전체 수**라 증분과 섞지 않는다(반증 M5-D: 같은 열쇠로 덮어써 합이 두 배가 됐다).
 *    같은 부팅을 이미 세고 있었으면 늘어난 만큼만(다시 연결한 사이) · 재부팅을 지켜본 경우(앞 부팅을 알았다)는 새 부팅의 버퍼 전체 ·
 *    처음 보면 기준만 잡는다(수집 전 오류는 '새로 생긴 오류' 로 세지 않는다). 한계: 중앙 재시작과 다시 연결이 겹치면 그 사이 오류를 놓친다 · 버퍼가 돌아 오래된 줄이 빠지면 덜 센다.
 *  · OOM 사건은 대상마다 분당 KM_OOM_PER_MIN · 한 번에 20개를 넘었으면(증분) '그 밖 N건' 한 줄.
 */
export function ingestKmsg(id, km, at = Date.now()) {
  if (!km || typeof km !== 'object') return;
  const sid = String(id);
  KM.set(sid, { rc: Number.isInteger(km.rc) ? km.rc : null, at });
  const boot = Number(km.boot);
  if (!(boot > 0)) return;
  const bk = typeof km.bid === 'string' && BOOT_ID_RE.test(km.bid) ? km.bid : `t${Math.round(boot / 10)}`;
  const wall = (s) => { const t = Math.round((boot + Number(s)) * 1000); return t > 0 && t <= at + 60_000 ? t : null; };
  const m = Math.floor(at / 60_000);
  let r = KMR.get(sid); if (!r || r.m !== m) { r = { m, n: 0 }; KMR.set(sid, r); }
  const ooms = Array.isArray(km.oom) ? km.oom.slice(-20) : [];
  for (const o of ooms) {
    if (r.n >= KM_OOM_PER_MIN) { counters.kmCut += 1; break; }
    const t = wall(o.s); if (t == null) continue;
    if (queueEvent(sid, 'oom', `OOM — ${o.c} 종료`, t, { id: `oom:${bk}:${o.s}` })) r.n += 1;
  }
  if (!km.f && Number.isInteger(km.on) && km.on > ooms.length && ooms.length) {
    const t = wall(ooms[0].s);
    if (t != null) queueEvent(sid, 'oom', `OOM — 그 밖 ${km.on - ooms.length}건(한 번에 최근 20건만 받음)`, t - 1, { id: `oom:${bk}:more:${ooms[0].s}` });
  }
  const en = Number.isInteger(km.en) && km.en >= 0 ? km.en : null;
  if (en == null) return;
  const cur = KMT.get(sid);
  const known = cur && cur.bid === bk && cur.tot != null ? cur.tot : null;
  const kerr = (cnt, why) => { const t = km.es ? wall(km.es) : null; if (cnt > 0 && t != null) queueEvent(sid, 'kerr', `커널 오류 ${cnt}줄${why}`, t, { id: `kerr:${bk}:${km.es}` }); };
  if (km.f) {
    if (known != null) kerr(en - known, '(다시 연결한 사이)');
    else if (cur && cur.bid !== bk) kerr(en, '(재부팅 뒤 버퍼)');
    KMT.set(sid, { bid: bk, tot: en });
  } else {
    kerr(en, '');
    KMT.set(sid, { bid: bk, tot: known != null ? known + en : null });
  }
  if (KMT.size > 5000) KMT.delete(KMT.keys().next().value);
  if (KMR.size > 5000) KMR.delete(KMR.keys().next().value);
}
export function kmsgOf(id) { const v = KM.get(String(id)); return v ? { ...v } : null; }

/* ── 사건(v3.13.0 ⑭ 컨펌 ⑥ — 자동 · 직접) ───────────────────────────────── */
const MODE_NAME = Object.freeze({ watch: '잠깐 보기', record: '계속 수집' });
/** 수집 시작 · 끝 · 더함 · 뺌 — 서버마다 따로 적는다(반증 F11: fm_run 의 지금 서버 목록으로 만들면 뺀 서버의 시작 · 끝이 사라지고 더한 서버의 시작이 수집 시작 시각에 찍혔다).
 *  id 는 `run:<수집>:<s|e>:<시각>` — events.eventsFor 가 이 수집의 fm_run 합성을 건너뛴다(업그레이드 전 수집만 합성). */
function runEvent(s, target, kind, text, now) {
  queueEvent(target, kind, text, now, { id: `run:${s.id}:${kind === 'start' ? 's' : 'e'}:${now}`, by: kind === 'start' ? s.by : '', scope: 'session' });
}
/** 자동 사건 종류 → 판정 글(화면은 같은 열쇠로 색을 고른다). */
export const EVENT_KINDS = Object.freeze(['reboot', 'auth', 'hostkey', 'start', 'stop', 'user', 'oom', 'kerr', 'alert', 'tune']); // v3.16.0 ⑯: OOM · 커널 오류 · 알림 · 수집 조절
/** 사건을 기록 대기열에 — 대상마다 한 줄(id 를 같이 쓰면 여러 대상을 한 사건으로 묶는다). 글은 300자. */
export function queueEvent(target, kind, text, at = Date.now(), { id = null, by = '', scope = 'server' } = {}) {
  if (!EVENT_KINDS.includes(kind)) return null;
  const eid = id || `ev-${crypto.randomBytes(6).toString('hex')}`;
  if (qEv >= MAX_Q_EVENTS) { counters.eventsDropped += 1; return null; }
  writeQ.push({ kind: 'e', id: eid, target: String(target), at, ekind: kind, text: String(text).slice(0, 300), by: String(by || '').slice(0, 64), scope });
  qEv += 1;
  return eid;
}

export function ingestProcs(id, ts, p) {
  if (!p || !(ts > 0)) return false;
  const e = entry(id);
  const minute = Math.floor(ts / 60_000);
  const list = e.procs.get(minute) || [];
  if (list.length < 60) list.push({ t: ts, n: p.n ?? null, top: p.top || [], ...(p.da === true || p.da === false ? { da: p.da } : {}), ...(p.apps ? { apps: p.apps } : {}) }); // da: 지연 집계(v2.981 — 디스크 대기를 아는지) · apps: 앱 단위 묶음(v3.14.0 ⑮)
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

export function drainWrites(max = 400) { const rows = writeQ.splice(0, max); for (const r of rows) { r.written = true; if (r.kind === 'e') qEv -= 1; } if (qEv < 0) qEv = 0; return rows; }
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

/*
 * 107회차(재현 — EISDIR): 읽기 오류(EACCES · EIO · EISDIR)는 손상이 아니다 — 예전 catch 하나는 온전한 원본을 .corrupt 로 옮기고 빈 값을 캐시해 다음 쓰기가 원본 자리를 덮었다.
 *   읽기 단계는 공용 읽기(30초 간격 재읽기): 원본을 두고 · 캐시하지 않고 · 그동안 쓰지 않는다. parse 실패(손상)는 예전과 같다.
 *   계속 수집 정의: 못 읽은 동안 메모리에서 시작한 수집은 그대로 돌고, 다시 읽히면 파일의 계속 수집을 더한다(이미 수집 중인 서버는 뺀다 — 서버는 수집 하나에만).
 */
const _sessReader = makeJsonFileReader(() => sessFile(), { parse: (t) => t, preserve: false, tag: 'focusmon-sessions' });
let _sessReadErr = '';
/** 107회차: 계속 수집 정의를 못 읽은 상태(읽기 오류 코드) 또는 ''. */
export function sessionsReadError() { loadSessions(); return _sessReadErr; }
function loadSessions() {
  if (sessLoaded) return;
  const rr = _sessReader.read();
  if (rr.kind === 'read-error') { _sessReadErr = String(rr.error?.code || 'read-error').slice(0, 32); return; }   // 읽었다고 치지 않는다 — 그동안 정의 파일은 쓰지 않는다(persistSessions)
  const late = !!_sessReadErr;
  _sessReadErr = '';
  sessLoaded = true;
  const busy = new Set(); for (const s of S.values()) for (const t of s.targets) busy.add(t);   // late: 못 읽은 동안 시작한 수집의 서버
  try {
    const j = rr.kind === 'ok' ? JSON.parse(rr.value) : null;
    for (const x of Array.isArray(j?.sessions) ? j.sessions : []) {
      if (!x || typeof x !== 'object' || x.mode !== 'record' || !/^fs-[a-f0-9]{8,16}$/.test(String(x.id))) continue;
      const targets = (Array.isArray(x.targets) ? x.targets : []).map(String).filter((t) => /^fm-[a-z0-9]{6,20}$/.test(t) && !busy.has(t)).slice(0, MAX_PER_SESSION);
      if (!targets.length || S.has(x.id)) continue;
      S.set(x.id, { id: x.id, mode: 'record', by: String(x.by || '').slice(0, 64), targets, interval: normInterval(x.interval), startedAt: Number(x.startedAt) || Date.now(), until: null, lastViewAt: 0, resumed: true });
    }
  } catch (e) {
    // 없음은 조용히 · 손상은 옆으로 보존한 뒤 새로 시작한다(다음 저장이 온전했던 원본을 빈 목록으로 덮어쓰지 않게 — ARCH-1).
    if (e?.code !== 'ENOENT') preserveCorrupt(sessFile(), String(e?.message || e));
  }
  dedupeLoadedSessions(Date.now());
  if (late) persistSessions();   // 107회차: 못 읽은 동안 시작한 수집 + 파일의 계속 수집을 함께 쓴다
}

/**
 * 읽은 계속 수집의 겹침 정리(v2.980 — 사용자 질문 '이렇게 보이면 동시에 2번 수집하는 거야? 버그야?').
 * v2.979 전에는 이미 수집 중인 서버로 새 계속 수집을 만들 수 있어 같은 서버가 두 수집에 저장돼 있을 수 있다(업그레이드해도 그대로 남았다).
 * 수집기는 서버마다 하나(desiredFor 가 id 로 합친다)라 두 번 접속하지는 않지만, 한 수집 · 서버별 '수집 종료' 를 눌러도 다른 수집에 남은 그 서버는 계속 수집됐다.
 * 먼저 시작한 수집에만 남기고(planJoin '서버는 수집 하나에만' 과 같은 결과) 비게 된 수집은 정의에서 뺀다. 고친 수집은 service 가 fm_run 에 다시 쓴다(drainLoadFixes).
 * '지난번 다시 고르기'(ended) 에는 넣지 않는다 — 사람이 끝낸 수집이 아니다.
 */
const loadFixes = [];
function dedupeLoadedSessions(now) {
  const seen = new Set(); let removed = 0; let dropped = 0;
  const list = [...S.values()].sort((a, b) => (a.startedAt - b.startedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const s of list) {
    const keep = s.targets.filter((t) => !seen.has(t));
    for (const t of keep) seen.add(t);
    if (keep.length === s.targets.length) continue;
    removed += s.targets.length - keep.length;
    if (!keep.length) { S.delete(s.id); dropped += 1; loadFixes.push({ ...s, targets: [...s.targets], ended: now }); continue; }
    s.targets = keep;
    loadFixes.push({ ...s, targets: [...keep], ended: null });
  }
  if (!removed) return;
  persistSessions();
  console.warn(`[focusmon] 겹친 계속 수집을 정리했습니다 — 두 수집에 함께 있던 서버 ${removed}건을 먼저 시작한 수집에만 남겼습니다${dropped ? `(비게 된 수집 ${dropped}건은 뺌)` : ''}. v2.979 전에 만든 수집입니다 — 수집기는 서버마다 하나라 두 번 접속하지는 않았습니다.`);
}
/** 읽을 때 겹침을 정리한 수집(한 번만 돌려준다) — service.tick1 이 fm_run 을 고쳐 쓴다. */
export function drainLoadFixes() { loadSessions(); return loadFixes.splice(0); }
function persistSessions() {
  if (!sessLoaded) { loadSessions(); if (!sessLoaded) { console.warn('[focusmon] 계속 수집 정의 파일을 읽지 못한 상태라 쓰지 않았습니다(원본 유지 — 읽히면 함께 씁니다).'); return; } }   // 107회차
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
 * 중복 방지(v2.979 — 사용자 '중복 모니터링 방지' · '기존 모니터링 돌고 있는데 추가하면 잘 안 돼'): **서버 하나는 수집 하나에만** 있다.
 *  · 이미 수집 중인 서버는 빼고(skipped) 나머지만 넣는다.
 *  · 예외 — 계속 수집(record)으로 넣으면 잠깐 보기(watch)에 있던 서버를 넘겨받는다(moved · 잠깐 보기가 끝나면 그 서버도 같이 멈추던 것을 막는다).
 *    넘겨줘 비게 된 잠깐 보기는 끝낸다(why 'moved').
 * @returns {{add:string[], skipped:{id,session,mode}[], moved:string[]}}
 */
function planJoin(ids, mode, intoId = null) {
  const add = []; const skipped = []; const moved = [];
  for (const t of ids) {
    let owner = null; for (const s of S.values()) if (s.targets.includes(t)) { owner = s; break; }
    if (!owner) { add.push(t); continue; }
    if (owner.id === intoId) { skipped.push({ id: t, session: owner.id, mode: owner.mode, same: true }); continue; }
    if (mode === 'record' && owner.mode === 'watch') { add.push(t); moved.push(t); continue; }
    skipped.push({ id: t, session: owner.id, mode: owner.mode });
  }
  return { add, skipped, moved };
}
/** 넘겨받은 서버를 원래 잠깐 보기에서 뺀다 — 비면 끝낸다. */
function applyMoves(moved, now) {
  if (!moved.length) return;
  const set = new Set(moved);
  for (const s of [...S.values()]) {
    if (s.mode !== 'watch' || !s.targets.some((t) => set.has(t))) continue;
    for (const t of s.targets) if (set.has(t)) runEvent(s, t, 'stop', `${MODE_NAME[s.mode]} 끝 — 계속 수집이 넘겨받음`, now); // 반증 재검토 N4
    s.targets = s.targets.filter((t) => !set.has(t));
    if (!s.targets.length) stopSession(s.id, 'moved', now);
  }
}
/** 포탈 전체 한도(전체 · 계속 수집) — 이 대상들을 mode 로 더했을 때. */
function totalsIssue(add, mode) {
  const all = new Set(); const rec = new Set();
  for (const x of S.values()) for (const t of x.targets) { all.add(t); if (x.mode === 'record') rec.add(t); }
  for (const t of add) { all.add(t); if (mode === 'record') rec.add(t); }
  if (all.size > MAX_TOTAL_TARGETS) return { ok: false, code: 'too-many-total', reason: `포탈 전체에서 동시에 ${MAX_TOTAL_TARGETS}대까지 수집합니다.` };
  if (rec.size > MAX_RECORD_TARGETS) return { ok: false, code: 'too-many-record', reason: `계속 수집은 포탈 전체 ${MAX_RECORD_TARGETS}대까지입니다.` };
  return null;
}
const alreadyReason = (n) => `고른 서버 ${n}대는 모두 이미 수집 중입니다 — 위 ‘진행 중인 수집’ 에서 보거나 끝낼 수 있습니다.`;

/**
 * 수집 시작 — 검사는 여기 한 곳(라우트는 대상 존재 · 권한만 본다).
 * @returns {{ok:true, session, skipped, moved}|{ok:false, code, reason, skipped?}}
 */
export function startSession({ targets = [], interval, mode = 'watch', by = '' } = {}, now = Date.now()) {
  loadSessions();
  const ids0 = [...new Set((Array.isArray(targets) ? targets : []).map(String))];
  if (!ids0.length) return { ok: false, code: 'no-targets', reason: '수집할 서버를 하나 이상 고르세요.' };
  if (mode !== 'watch' && mode !== 'record') return { ok: false, code: 'bad-mode', reason: '방식은 잠깐 보기 또는 계속 수집입니다.' };
  const { add: ids, skipped, moved } = planJoin(ids0, mode);
  if (!ids.length) return { ok: false, code: 'already', reason: alreadyReason(skipped.length), skipped };
  if (ids.length > MAX_PER_SESSION) return { ok: false, code: 'too-many', reason: `한 번에 ${MAX_PER_SESSION}대까지 고를 수 있습니다.` };
  // 넘겨받아 비게 되는 잠깐 보기는 자리를 비운다
  const movedSet = new Set(moved);
  const freed = [...S.values()].filter((s) => s.mode === 'watch' && s.targets.length && s.targets.every((t) => movedSet.has(t))).length;
  if (S.size - freed >= MAX_SESSIONS) return { ok: false, code: 'too-many-sessions', reason: `동시에 ${MAX_SESSIONS}건까지 수집합니다 — 진행 중인 수집에 추가하거나, 끝낸 뒤 시작하세요.` };
  const lim = totalsIssue(ids, mode); if (lim) return lim;
  const s = { id: `fs-${crypto.randomBytes(5).toString('hex')}`, mode, by: String(by || '').slice(0, 64), targets: ids, interval: normInterval(interval), startedAt: now,
    until: mode === 'watch' ? now + WATCH_MIN * 60_000 : null, lastViewAt: now };
  applyMoves(moved, now);
  S.set(s.id, s);
  for (const t of ids) lastView.set(t, now);
  for (const t of ids) runEvent(s, t, 'start', `${MODE_NAME[mode]} 시작(${s.interval}초)`, now);
  if (mode === 'record' || moved.length) persistSessions();
  return { ok: true, session: { ...s, targets: [...ids] }, skipped, moved };
}

/**
 * 진행 중인 수집에 서버를 더한다(v2.979 — 4번째 수집을 만들지 않고 붙는다). 중복 규칙은 시작과 같다(planJoin).
 * @returns {{ok:true, session, added, skipped, moved}|{ok:false, code, reason, skipped?}}
 */
export function addToSession(id, targets = [], now = Date.now()) {
  loadSessions();
  const s = S.get(String(id));
  if (!s) return { ok: false, code: 'not-found', reason: '없는 수집입니다(이미 끝났을 수 있습니다).' };
  const ids0 = [...new Set((Array.isArray(targets) ? targets : []).map(String))];
  if (!ids0.length) return { ok: false, code: 'no-targets', reason: '더할 서버를 하나 이상 고르세요.' };
  const { add, skipped, moved } = planJoin(ids0, s.mode, s.id);
  if (!add.length) return { ok: false, code: 'already', reason: alreadyReason(skipped.length), skipped };
  if (s.targets.length + add.length > MAX_PER_SESSION) return { ok: false, code: 'too-many', reason: `수집 하나는 ${MAX_PER_SESSION}대까지입니다 — 이 수집에는 ${Math.max(0, MAX_PER_SESSION - s.targets.length)}대를 더 넣을 수 있습니다.` };
  const lim = totalsIssue(add, s.mode); if (lim) return lim;
  applyMoves(moved, now);
  s.targets = [...s.targets, ...add];
  for (const t of add) lastView.set(t, now);
  for (const t of add) runEvent(s, t, 'start', `${MODE_NAME[s.mode]}에 더함(${s.interval}초)`, now);
  s.lastViewAt = now;
  if (s.mode === 'record' || moved.length) persistSessions();
  return { ok: true, session: { ...s, targets: [...s.targets] }, added: add, skipped, moved };
}

/** 수집에서 서버 하나를 뺀다(서버별 ‘수집 종료’) — 마지막 서버면 그 수집을 끝낸다. */
export function removeFromSession(id, targetId, now = Date.now()) {
  loadSessions();
  const s = S.get(String(id));
  if (!s) return { ok: false, code: 'not-found', reason: '없는 수집입니다(이미 끝났을 수 있습니다).' };
  const t = String(targetId);
  if (!s.targets.includes(t)) return { ok: false, code: 'not-in-session', reason: '그 수집에 없는 서버입니다.' };
  if (s.targets.length === 1) { const r = stopSession(s.id, 'removed', now); return { ...r, ended: true }; }
  s.targets = s.targets.filter((x) => x !== t);
  runEvent(s, t, 'stop', `${MODE_NAME[s.mode]}에서 뺌`, now);
  if (s.mode === 'record') persistSessions();
  return { ok: true, ended: false, session: { ...s, targets: [...s.targets] } };
}

/** 지금 이 서버를 수집하는 수집(없으면 null) — 서버는 한 수집에만 있다. */
export function sessionOfTarget(targetId) { loadSessions(); for (const s of S.values()) if (s.targets.includes(String(targetId))) return { ...s, targets: [...s.targets] }; return null; }

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
  for (const t of s.targets) runEvent(s, t, 'stop', `${MODE_NAME[s.mode]} 끝`, now);
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

/* ── 수집 부하(v2.983) — 대상별 최신 창 · 노드별 최신 표본. DB 에는 분마다 한 줄(같은 분은 뒤 창이 덮는다 · 보관은 수집 기록과 같은 기간) ── */
const LOAD = new Map(); // targetId → { ...load, at }
const NODE_LOAD = new Map(); // 노드 열쇠('' = 이 중앙 · 엣지 이름 소문자) → { ...sample, at }
const LOAD_MAX_JSON = 4096;
/**
 * 분당 한 줄(반증 F1): 같은 (종류, 열쇠, 분)은 **처음 한 번만** 대기열에 넣고, 아직 쓰기 전이면 그 줄을 새 값으로 바꾼다(이미 썼으면 그 분은 건너뛴다).
 * 예전에는 30초 창마다(그리고 엣지 노드 표본은 동기화마다 — 2초) 줄을 넣어, 같은 분을 덮어쓰는 줄이 쓰기 양 · 대기열 상한을 차지했다.
 */
const lastQueued = new Map(); // `${kind}|${key}` → { minute, row }
function queueJson(kind, key, now, obj) {
  const minute = Math.floor(now / 60_000);
  const k = `${kind}|${key}`;
  let data;
  try { data = JSON.stringify(obj); } catch { return; }
  if (data.length > LOAD_MAX_JSON) return;
  const prev = lastQueued.get(k);
  if (prev && prev.minute === minute) {
    if (!prev.row.written) prev.row.data = data; // 아직 대기열에 있으면 새 값으로
    return;
  }
  const row = { kind, target: key, minute, data };
  lastQueued.set(k, { minute, row });
  writeQ.push(row);
  if (writeQ.length > 20_000) writeQ.splice(0, writeQ.length - 20_000);
}
export function setLoad(id, load, now = Date.now()) {
  if (!load || typeof load !== 'object') return;
  const v = { ...load, at: now };
  LOAD.set(String(id), v);
  queueJson('l', String(id), now, v);
}
export function loadOf(id) { const v = LOAD.get(String(id)); return v ? { ...v } : null; }
export function setNodeLoad(node, sample, now = Date.now()) {
  if (!sample || typeof sample !== 'object') return;
  const key = String(node || '').toLowerCase();
  const old = NODE_LOAD.get(key);
  // 같은 표본을 다시 받았으면(엣지는 30초 표본을 동기화마다 — 2초 — 다시 싣는다) 시각만 새로 · 기록하지 않는다(반증 F1)
  if (old) { const { at: _a, ...rest } = old; if (JSON.stringify(rest) === JSON.stringify(sample)) { old.at = now; return; } }
  const v = { ...sample, at: now };
  NODE_LOAD.set(key, v);
  queueJson('n', key, now, v);
}
export function nodeLoads() { return [...NODE_LOAD.entries()].map(([node, v]) => ({ node, ...v })); }
export function _resetLoadForTest() { LOAD.clear(); NODE_LOAD.clear(); lastQueued.clear(); }

/* ── 대상 상태 · 엣지 상태 ─────────────────────────────────────────────────── */
const ST = new Map(); // targetId → { ...status, at }
const EDGE = new Map(); // agentLower → { agent, at, version, key, ok, error, statusCount }
const KEYS_FILE = registerStateFile('focusmon-keys.json');
let keysLoaded = false;

export function setStatus(id, st, now = Date.now()) {
  // v3.13.0(⑭ 자동 사건): 키 로그인 거부 · 호스트키 승인 필요로 **바뀐 순간**만(같은 상태가 이어지면 다시 적지 않는다)
  const prev = ST.get(String(id));
  //   앞 상태를 모르면(기동 직후 · 엣지 첫 동기화) 적지 않는다 — 재시작마다 같은 사건이 되풀이되지 않게
  //   반증 F2: 다시 시도할 때마다 'connecting' 을 거쳐 같은 상태로 돌아온다 — 견주는 것은 'connecting' 을 뺀 **안정 상태**(호스트키 대기 중 60초마다 사건이 쌓였다)
  const stable = prev ? (prev.state === 'connecting' ? (prev.stable ?? null) : prev.state) : null;
  if ((st?.state === 'auth' || st?.state === 'hostkey') && stable && stable !== st.state) {
    queueEvent(id, st.state, st.state === 'auth' ? '키 로그인 거부 — 수집을 멈췄습니다' : '호스트키 승인 필요 — 장비 신뢰 확인', now);
  }
  ST.set(String(id), { ...st, at: now, stable: st?.state === 'connecting' ? stable : (st?.state ?? null) });
}
export function statusOf(id) { return ST.get(String(id)) || null; }

const _keysReader = makeJsonFileReader(() => path.join(config.configDir, KEYS_FILE), { parse: (t) => t, preserve: false, tag: 'focusmon-keys' });   // 107회차
function loadKeys() {
  if (keysLoaded) return;
  const rr = _keysReader.read();
  if (rr.kind === 'read-error') return;   // 107회차: 읽었다고 치지 않는다 — 그동안 받은 키는 메모리에만 두고 쓰지 않는다(persistKeys)
  keysLoaded = true;
  try {
    const j = rr.kind === 'ok' ? JSON.parse(rr.value) : null;
    for (const [k, v] of Object.entries(j?.edges || {})) if (v && typeof v === 'object' && !EDGE.has(k)) EDGE.set(k, { agent: String(v.agent || k).slice(0, 128), at: Number(v.at) || 0, version: String(v.version || '').slice(0, 32), key: v.key || null, keySeenAt: Number(v.keySeenAt) || 0 });
  } catch (e) { if (e?.code !== 'ENOENT') preserveCorrupt(path.join(config.configDir, KEYS_FILE), String(e?.message || e)); }
}
function persistKeys() {
  if (!keysLoaded) { loadKeys(); if (!keysLoaded) return; }   // 107회차: 못 읽은 키 파일 위에 쓰지 않는다
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

/**
 * 접속처가 바뀐 대상(v2.980 — 등록된 서버 수정): 예전 접속처의 수집 상태 · 연결 시험 결과 · 다시 연결 요청을 지운다.
 * 남겨 두면 IP 를 고친 뒤에도 예전 주소의 '연결됨' · 'RHEL 7.x' 가 새 주소의 결과처럼 보인다. 수집한 값(T)은 그대로 — 기록은 같은 id 로 이어진다.
 * 인증 정지는 여기서 다루지 않는다(접속처 + 키 지문 해시라 저절로 맞지 않는다 — 지우면 자동 재시도가 된다).
 */
export function forgetTargetState(id) {
  const k = String(id);
  ST.delete(k); TESTS.delete(k); RETRIES.delete(k);
  const e = T.get(k); if (e) { e.lastUp = undefined; e.lastUpAt = undefined; } // 반증 F9 — 접속처가 바뀌면 옛 서버의 가동 시간으로 '재부팅' 을 만들지 않게
  LOAD.delete(k); // v2.983 반증 F13 — 예전 주소의 수집 부하 창을 새 주소의 것처럼 보이지 않게
  // 전체 점검 29회차 F1(재현): v3.16.0 의 커널 메시지 기준(KMT 부팅 id · 누계) · 읽기 상태(KM) · OOM 상한(KMR)과 hello(OS · 코어)가 남아,
  //   새 서버의 첫 확인이 그 서버 버퍼의 오류 전부를 '커널 오류 N줄(재부팅 뒤 버퍼)' 사건으로 적고 상세 머리글에 예전 서버의 OS 가 보였다.
  KM.delete(k); KMT.delete(k); KMR.delete(k);
  if (e) e.hello = null;
}

export function _resetForTest() {
  T.clear(); writeQ.length = 0; qEv = 0; KM.clear(); KMT.clear(); KMR.clear(); S.clear(); lastView.clear(); ST.clear(); EDGE.clear(); WAKES.clear(); TESTS.clear(); RETRIES.clear(); ended.length = 0;
  sessLoaded = false; keysLoaded = false; _sessReader.reset(); _sessReadErr = ''; _keysReader.reset(); counters.lateDropped = 0; counters.rewrites = 0; counters.closed = 0; loadFixes.length = 0;
}
