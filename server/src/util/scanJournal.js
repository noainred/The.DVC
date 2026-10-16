/**
 * util/scanJournal.js — 실행 중 스캔 기록 + 재시작 뒤 자동 재개(v2.737).
 *
 * 사용자 신고(2026-10-15): "프로그램이 업그레이드 되면 scan 하던게 중단되는 버그 … 업그레이드나 서비스 재시작으로 멈추면 자동으로 재시작".
 *   스캔(아이실론 du · iDRAC 대역 · IP 대역)은 진행 상태를 **메모리에만** 들고 있어, 업그레이드 재시작이 오면 그 스캔은 흔적 없이 사라졌다
 *   — 주기 스캔은 다음 주기(최대 수십 시간)까지, 수동·원격 실행은 영영 다시 돌지 않았고 화면은 '중단됐다' 고 말하지 않았다.
 *
 * ── 규칙 ────────────────────────────────────────────────────────────────────
 *  · 스캔을 시작하면 `scanStarted` 가 이 파일(`scan-journal.json`, 상태 파일)에 **동기로** 적고, 끝나면 `scanFinished` 가 지운다.
 *    재시작으로 끝나지 못한 항목은 다음 기동 때 파일에 남아 있다 = '재시작으로 중단됨'. 기동 시 한 번만 읽는다(모듈 로드).
 *  · 재개는 기동 뒤 `SCAN_RESUME_DELAY_MS`(기본 2분 — 수집기들이 자리 잡은 뒤) 에 각 기능이 등록한 재개 함수(`registerScanResumer`)가 한다.
 *    기능이 판정한다 — 'started'(다시 시작) · 'covered'(이미 돌고 있거나 그 사이 끝났다) · 'gone'(대상이 없어졌다) · 'skipped'(꺼짐·긴급중단)
 *    · 'busy'(지금은 다른 스캔 중 — 5분 뒤 다시 본다, 최대 12번).
 *  · 재개는 **사슬마다 최대 2번**(`RESUME_LIMIT`)이다 — 재개한 스캔이 또 재시작에 걸리면 횟수가 이어진다. 넘으면 'limit' 으로 남기고 멈춘다
 *    (재시작이 반복되는 원인이 따로 있을 때 같은 스캔을 끝없이 다시 돌리지 않게).
 *  · **비밀을 적지 않는다** — 대상 id·트리거·대역 id·원격 작업 id 같은 식별자만. 비밀번호가 필요한 재개(엣지 위임 iDRAC 잡)는 이 기록으로 하지 않는다.
 *  · 오래된 기록(시작 48시간 넘음)은 재개하지 않는다('expired') — 그동안 정상 주기가 이미 돌았다.
 *  · 결과는 최근 50건 이력으로 남기고 각 기능 상태(`journalFor(kind)`)가 화면에 싣는다 — 조용히 다시 돌리지 않는다.
 *  · 쓰기 실패는 스캔을 막지 않는다(콘솔 경고 + 상태의 lastWriteError). 손상 파일은 보존하고 새로 시작한다(재생성 가능한 상태).
 *  · `runningScans()` 는 자동 업그레이드가 '지금 스캔 중인가' 를 볼 때 쓴다(upgrade/manager.js — 끝날 때까지 적용을 미룬다).
 *    v2.741(TIMING-03): 항목마다 `resumable` 을 싣는다 — meta.jobId(장비에서 분리 실행 중인 작업 id — 지금은 아이실론 du 만)가 있고
 *    자동 재개가 켜져 있으며 재개 상한 전이면, 재시작이 와도 다음 기동이 **같은 작업에 다시 붙어** 결과만 받는다. 업그레이드는 그 스캔을 기다리지 않는다.
 *  · v2.741(TIMING-04): 같은 키에 대기 항목이 여럿일 수 있다(iDRAC 'cycle' 처럼 coversPending:false 인 기능 — 범위가 다른 실행이 같은 키로 온다).
 *    기동 때 같은 키라고 하나를 버리지 않는다(예전에는 다음 실행의 기록이 앞 대기 항목을 이력도 없이 지웠다). 키마다 최근 `PER_KEY_MAX` 개만 남기고
 *    넘친 것은 이력에 'superseded' 로 남긴다. 재개 실행(resumeOf)은 **자기 항목만** 지운다 — 다른 대기 항목은 그 뒤 자기 차례에 판정한다.
 *  · v2.742(감사 RECENT-02·EDGE-02): **아직 시작하지 않은 대기 요청**(동시 실행 상한에 걸린 '지금 수집' — 지금은 아이실론만)도 남긴다
 *    (`scanQueued`/`scanDequeued`, 파일의 `queued`). v2.741 TIMING-02 가 만든 대기열은 메모리에만 있어 재시작·자동 업그레이드가 오면
 *    대기 요청이 **기록도 없이** 사라졌다(실행 중인 것만 '중단됨' 으로 남았다). 대기 요청은 '중단됨' 이 아니다 — 시작한 적이 없으므로
 *    재개 횟수·재개 함수와 무관하고, 기동 때 그대로 남아 있다가 기능이 자기 대기열에 다시 넣는다(`queuedOf`). 대기 시한(`until`)이 지난 것과
 *    재개가 꺼진(SCAN_RESUME=0) 기동에서는 다시 넣지 않고 이력에 사유를 남긴다(조용히 버리지 않는다). 같은 키로 스캔이 시작되면 대기 기록은
 *    그 시작이 대신한다. `queuedScans()` 의 `resumable` = 기록이 실제로 파일에 남았고(마지막 쓰기 성공) 재개가 켜져 있음 — 자동 업그레이드는
 *    그런 대기 요청을 기다리지 않는다(재시작 뒤 대기열로 돌아온다). 그렇지 않으면 기다린다(재시작이 그 요청을 지운다).
 *  · v2.743(감사 TIMING-03): 대기 요청을 여러 건 한꺼번에 남길 때는 `scanQueuedMany`(쓰기 한 번)를 쓴다 — 대상마다 scanQueued 를 부르면
 *    기록 파일 전체를 대상 수만큼 다시 써 O(N²) 이었다. 기동 때 다시 넣지 않은 대기 요청(대기 시한 초과·SCAN_RESUME=0)은
 *    `takeQueuedBootDrops(kind)` 로 기능에 넘긴다(아이실론 엣지는 그것을 중앙에 알린다 — LEFT-08).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from './atomicWrite.js';
import { registerStateFile } from './stateFiles.js';
import { numOrNull } from './numOrNull.js';

registerStateFile('scan-journal.json');
const FILE = () => path.join(config.configDir, 'scan-journal.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 찾는다

export const RESUME_LIMIT = 2;
export const BUSY_RETRY_MS = 5 * 60_000;
export const BUSY_RETRY_MAX = 12;
export const EXPIRE_MS = 48 * 3_600_000;
const HISTORY_MAX = 50;
export const PER_KEY_MAX = 4;   // v2.741(TIMING-04): 같은 키의 대기 항목 상한(재시작이 반복돼도 끝없이 쌓이지 않게)
const META_MAX_BYTES = 8 * 1024;
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** 기동 뒤 재개까지 기다리는 시간 — 빈 값·숫자 아님은 기본 2분, [10초, 30분]. `SCAN_RESUME=0` 이면 재개하지 않는다(기록·표시는 그대로). */
export function resumeDelayMs(v = process.env.SCAN_RESUME_DELAY_MS) {
  const n = numOrNull(v);
  if (n == null || n <= 0) return 120_000;
  return Math.max(10_000, Math.min(30 * 60_000, Math.round(n)));
}
export const resumeEnabled = () => String(process.env.SCAN_RESUME ?? '').trim() !== '0';

const keyOf = (kind, key) => `${kind}:${key}`;
/** 같은 실행 기록인가 — 같은 키 + 같은 시작 시각(재개 함수가 받는 항목은 사본이라 객체로 비교할 수 없다). */
const sameRun = (x, y) => !!x && !!y && x.kind === y.kind && x.key === y.key && (numOrNull(x.since) ?? 0) === (numOrNull(y.since) ?? 0);
const now = () => Date.now();
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : v == null ? '' : String(v).slice(0, n));

/** meta 는 식별자만 담는다 — JSON 으로 8KB 를 넘으면 버리고 그 사실을 남긴다(상태 파일이 커지지 않게). */
function cleanMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  try {
    const j = JSON.stringify(meta);
    if (j.length > META_MAX_BYTES) return { metaDropped: j.length };
    return JSON.parse(j);
  } catch { return {}; }
}

const _active = new Map();     // key -> entry (이 프로세스가 지금 돌리는 것)
const _queued = new Map();     // key -> { kind, key, label, trigger, since, until, meta } — 아직 시작하지 않은 대기 요청(v2.742 RECENT-02)
let _interrupted = [];         // 이전 프로세스가 끝내지 못한 것 — { ...entry, detectedAt, state:'pending', tries, nextAt }
let _history = [];             // 재개 결과
const _resumers = new Map();   // kind -> async (entry) => { outcome, note }
let _loadInfo = { at: null, found: 0, error: null, corruptKept: null };
const _queuedBootDrops = [];   // v2.743(LEFT-08): 기동 때 다시 넣지 않은 대기 요청 { kind, key, trigger, reason } — 기능이 takeQueuedBootDrops 로 한 번 가져간다
let _lastWriteError = null;
let _timer = null;
let _processing = false;
let _bootAt = now();

function write() {
  const doc = { v: 1, savedAt: now(), active: Object.fromEntries(_active), interrupted: _interrupted, history: _history, queued: [..._queued.values()] };
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    atomicWriteFileSync(FILE(), JSON.stringify(doc), { mode: 0o600 });
    if (_lastWriteError) _lastWriteError = null;
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 200);
    if (msg !== _lastWriteError?.message) console.warn(`[scan-journal] 기록을 쓰지 못했습니다(스캔은 계속합니다): ${msg}`);
    _lastWriteError = { at: now(), message: msg };
  }
}

function normEntry(e) {
  if (!e || typeof e !== 'object' || !KIND_RE.test(String(e.kind || '')) || !e.key) return null;
  return {
    kind: String(e.kind), key: str(e.key, 200), label: str(e.label, 200), trigger: str(e.trigger, 40),
    since: numOrNull(e.since) ?? 0, resumes: Math.max(0, Math.min(99, numOrNull(e.resumes) ?? 0)),
    meta: cleanMeta(e.meta), pid: numOrNull(e.pid),
  };
}

/** 대기 요청 정규화(v2.742) — 대기 시한(until)을 모르면 null(시한 판정은 기능이 since 로 다시 한다). */
function normQueued(e) {
  const b = normEntry(e);
  if (!b) return null;
  return { kind: b.kind, key: b.key, label: b.label, trigger: b.trigger, since: b.since, until: numOrNull(e.until), meta: b.meta };
}

/** 기동 시 1회 — 파일의 active 를 '재시작으로 중단됨' 으로 옮긴다. 이전 기동이 재개하지 못한 pending 도 이어 받는다. */
function loadOnce() {
  _bootAt = now();
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(FILE(), 'utf8')); }
  catch (e) {
    if (e?.code !== 'ENOENT') {
      const kept = preserveCorrupt(FILE(), e.message);
      _loadInfo = { at: _bootAt, found: 0, error: String(e.message).slice(0, 200), corruptKept: kept || null };
      console.warn(`[scan-journal] 기록 파일을 읽지 못해 새로 시작합니다(${e.message})`);
    }
    return;
  }
  if (!doc || typeof doc !== 'object') return;
  const carried = Array.isArray(doc.interrupted) ? doc.interrupted.filter((x) => x && x.state === 'pending') : [];
  const fresh = Object.values(doc.active && typeof doc.active === 'object' ? doc.active : {});
  _history = Array.isArray(doc.history) ? doc.history.filter((x) => x && typeof x === 'object').slice(0, HISTORY_MAX) : [];
  // v2.741(TIMING-04): 같은 **실행**(같은 키·같은 시작 시각)만 하나로 친다 — 같은 키라도 시작 시각이 다르면 다른 실행이다.
  //   예전에는 키만 보고 버려, iDRAC 'cycle' 의 대기 항목(예: 수동 실행이 남긴 대역)이 다음 주기 스캔이 또 재시작에 걸리면 이력 없이 사라졌다.
  const seen = new Set();
  const out = [];
  for (const raw of [...fresh, ...carried]) {
    const e = normEntry(raw);
    if (!e) continue;
    const id = `${keyOf(e.kind, e.key)}@${e.since}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...e, detectedAt: numOrNull(raw.detectedAt) ?? _bootAt, state: 'pending', tries: numOrNull(raw.tries) ?? 0, nextAt: null });
  }
  // 키마다 최근 PER_KEY_MAX 개만 — 넘친 것은 조용히 버리지 않고 이력에 남긴다.
  const perKey = new Map();
  for (const x of out) { const k = keyOf(x.kind, x.key); if (!perKey.has(k)) perKey.set(k, []); perKey.get(k).push(x); }
  const drop = new Set();
  for (const list of perKey.values()) {
    if (list.length <= PER_KEY_MAX) continue;
    for (const x of [...list].sort((a, b) => b.since - a.since).slice(PER_KEY_MAX)) drop.add(x);
  }
  for (const x of drop) pushHistory(x, 'superseded', `같은 대상의 재개 대기 항목이 ${PER_KEY_MAX}개를 넘어 가장 오래된 것을 다시 시작하지 않습니다(다음 주기·수동 실행은 그대로 동작합니다)`);
  _interrupted = out.filter((x) => !drop.has(x));
  // v2.742(RECENT-02): 시작하지 못한 대기 요청 — 그대로 남겨 두고 기능이 자기 대기열에 다시 넣는다(queuedOf).
  //   대기 시한이 지난 것·재개가 꺼진 기동은 다시 넣지 않고 이력에 사유를 남긴다(조용한 소실 금지).
  const qdrop = [];
  for (const raw of Array.isArray(doc.queued) ? doc.queued : []) {
    const q = normQueued(raw);
    if (!q) continue;
    const k = keyOf(q.kind, q.key);
    if (_queued.has(k)) continue;
    if (q.until != null && _bootAt > q.until) { pushHistory({ ...q, detectedAt: _bootAt, resumes: 0 }, 'expired', "재시작 전 '지금 수집' 대기 요청이 대기 시한을 넘겨 다시 넣지 않았습니다 — 다시 누르세요"); qdrop.push(q); _queuedBootDrops.push({ kind: q.kind, key: q.key, trigger: q.trigger, reason: 'queue-hold' }); continue; }
    if (!resumeEnabled()) { pushHistory({ ...q, detectedAt: _bootAt, resumes: 0 }, 'skipped', "SCAN_RESUME=0 — 재시작 전 '지금 수집' 대기 요청을 다시 넣지 않았습니다(다시 누르세요)"); qdrop.push(q); _queuedBootDrops.push({ kind: q.kind, key: q.key, trigger: q.trigger, reason: 'not-restored' }); continue; }
    _queued.set(k, q);
  }
  if (_queued.size) console.warn(`[scan-journal] 재시작 전 시작하지 못한 '지금 수집' 대기 요청 ${_queued.size}개를 찾았습니다 — 그 기능의 대기열에 다시 넣습니다`);
  if (qdrop.length) console.warn(`[scan-journal] 재시작 전 대기 요청 ${qdrop.length}개는 다시 넣지 않았습니다(대기 시한 초과·SCAN_RESUME=0 — 이력 참조)`);
  _loadInfo = { at: _bootAt, found: fresh.length, error: null, corruptKept: null };
  if (fresh.length) console.warn(`[scan-journal] 재시작으로 중단된 스캔 ${fresh.length}개를 찾았습니다 — ${_interrupted.slice(0, 5).map((x) => `${x.kind}:${x.label || x.key}`).join(', ')}${_interrupted.length > 5 ? ' …' : ''}`);
  if (drop.size) console.warn(`[scan-journal] 같은 대상의 재개 대기 항목이 상한(${PER_KEY_MAX}개)을 넘어 오래된 ${drop.size}개를 이력으로 옮겼습니다`);
  if (fresh.length || drop.size || qdrop.length) write();
}
loadOnce();

/**
 * 스캔 시작 — 동기로 기록한다(곧바로 재시작이 와도 남게).
 * @param {string} kind 기능('isidu'·'idrac-scan'·'ipscan'·'ipscan-agent')
 * @param {string} key  그 기능 안의 식별자(대상 id · 'cycle')
 * @param {{label?:string, trigger?:string, meta?:object, resumeOf?:object, coversPending?:boolean}} [o]
 *   resumeOf = 재개 함수가 받은 항목(재개 횟수를 잇는다) · coversPending = 같은 키의 '중단됨' 대기 항목을 이 시작이 대신하는가
 *   (기본 true. iDRAC 처럼 같은 키로 범위가 다른 실행이 오는 기능은 false 로 두고 재개 함수가 남은 범위를 판정한다).
 *   resumeNote = 'resumed' 이력에 남길 설명(예: 수동 실행이 재시작 전 작업을 이어 받았다).
 */
export function scanStarted(kind, key, { label = '', trigger = '', meta = {}, resumeOf = null, coversPending = true, resumeNote = '' } = {}) {
  if (!KIND_RE.test(String(kind || '')) || !key) return;
  const e = normEntry({ kind, key, label, trigger, since: now(), resumes: resumeOf ? (numOrNull(resumeOf.resumes) ?? 0) + 1 : 0, meta, pid: process.pid });
  if (!e) return;
  _active.set(keyOf(kind, key), e);
  _queued.delete(keyOf(kind, key)); // v2.742(RECENT-02): 같은 대상의 대기 요청은 이 시작이 대신한다(같은 쓰기에 함께 남는다)
  // 같은 대상의 '중단됨' 대기 항목은 이 시작이 대신한다(주기 스캔이 먼저 돌았다 — 재개가 두 번째 스캔을 열지 않게).
  // v2.741(TIMING-04): coversPending:false 인 기능(iDRAC — 같은 키로 범위가 다른 실행)의 재개는 **자기 항목만** 지운다.
  //   예전에는 같은 키의 다른 대기 항목까지 'resumed' 로 지워, 그 항목의 남은 대역을 다시 돌리지 않고도 이력은 '다시 시작했다' 고 말했다.
  const k = keyOf(kind, key);
  if (resumeOf || coversPending) {
    _interrupted = _interrupted.filter((x) => {
      if (keyOf(x.kind, x.key) !== k) return true;
      const self = !!resumeOf && sameRun(x, resumeOf);
      if (!self && !coversPending) return true;
      pushHistory(x, resumeOf ? 'resumed' : 'covered', resumeOf ? (resumeNote || '자동으로 다시 시작했습니다') : '재개를 기다리는 동안 다른 경로(주기·수동)로 다시 시작됐습니다');
      return false;
    });
  }
  write();
}

/** 진행 정보 갱신(예: 원격 작업 id). durable 이면 곧바로 파일에 쓴다. */
export function scanProgress(kind, key, patch = {}, { durable = true } = {}) {
  const e = _active.get(keyOf(kind, key));
  if (!e) return;
  e.meta = cleanMeta({ ...(e.meta || {}), ...(patch && typeof patch === 'object' ? patch : {}) });
  if (durable) write();
}

/** 스캔 끝(성공·실패 모두) — 기록을 지운다. */
export function scanFinished(kind, key) {
  if (_active.delete(keyOf(kind, key))) write();
}

/**
 * v2.742(RECENT-02): 아직 시작하지 않은 대기 요청을 남긴다(동기 — 곧바로 재시작이 와도 남게).
 * @param {{label?:string, trigger?:string, since?:number, holdMs?:number, meta?:object}} [o] holdMs = 대기 시한(since 부터) — 지나면 기동 때 다시 넣지 않는다
 */
export function scanQueued(kind, key, { label = '', trigger = '', since = null, holdMs = null, meta = {} } = {}) {
  const q = queuedEntryOf(kind, { key, label, trigger, since, holdMs, meta });
  if (!q) return;
  _queued.set(keyOf(kind, key), q);
  write();
}

/** 대기 요청 한 건의 기록 모양(scanQueued·scanQueuedMany 공용 — 규칙을 두 벌로 두지 않는다). 형식이 틀리면 null. */
function queuedEntryOf(kind, { key, label = '', trigger = '', since = null, holdMs = null, meta = {} } = {}) {
  if (!KIND_RE.test(String(kind || '')) || !key) return null;
  const at = numOrNull(since) ?? now();
  const hold = numOrNull(holdMs);
  return normQueued({ kind, key, label, trigger, since: at, until: hold != null && hold > 0 ? at + hold : null, meta });
}

/**
 * v2.743(감사 TIMING-03): 대기 요청 여러 건을 **쓰기 한 번**으로 남긴다. '지금 수집' 이 동시 실행 상한을 넘는 대상마다
 * scanQueued 를 부르면 대상마다 기록 파일 전체를 다시 썼다(파일·디렉터리 fsync 2회 × N번, 문서는 대기 항목만큼 커진다 — O(N²)).
 * 요청 하나가 대상 98개(MAX_TARGETS 100 − 동시 2)에서 이벤트 루프를 약 0.1초(이 VM — fsync 가 느린 디스크면 더) 막았다.
 * 동기 기록이라는 규칙(곧바로 재시작이 와도 남는다)은 그대로다 — 호출부가 모은 뒤 돌아가기 전에 한 번 쓴다.
 * @param {string} kind
 * @param {Array<{key:string, label?:string, trigger?:string, since?:number, holdMs?:number, meta?:object}>} entries
 * @returns {number} 기록한 항목 수(형식이 틀린 항목은 빼고 센다)
 */
export function scanQueuedMany(kind, entries) {
  if (!Array.isArray(entries) || !entries.length) return 0;
  let n = 0;
  for (const e of entries) {
    const q = queuedEntryOf(kind, e && typeof e === 'object' ? e : {});
    if (!q) continue;
    _queued.set(keyOf(kind, e.key), q);   // scanQueued 와 같은 키(원래 key — scanStarted·scanDequeued 가 같은 값으로 찾는다)
    n++;
  }
  if (n) write();
  return n;
}

/** v2.742: 대기 요청 기록을 지운다(시작·시한 초과·대상 없음 — 사유는 기능이 자기 기록에 남긴다). */
export function scanDequeued(kind, key) {
  if (_queued.delete(keyOf(kind, key))) write();
}

/**
 * v2.743(감사 LEFT-08): 기동 때 다시 넣지 않은 이 기능의 대기 요청(대기 시한 초과 'queue-hold' · SCAN_RESUME=0 'not-restored') —
 * 한 번만 돌려주고 비운다(기능이 그 사실을 다른 노드에 알린다. 이력에는 이미 남아 있다).
 * @returns {{key:string, trigger:string, reason:string}[]}
 */
export function takeQueuedBootDrops(kind) {
  const out = [];
  for (let i = _queuedBootDrops.length - 1; i >= 0; i--) {
    const d = _queuedBootDrops[i];
    if (d.kind !== kind) continue;
    out.unshift({ key: d.key, trigger: d.trigger, reason: d.reason });
    _queuedBootDrops.splice(i, 1);
  }
  return out;
}

/** v2.742: 한 기능의 대기 요청(복사본, 먼저 넣은 것부터) — 기능이 기동 때 자기 대기열에 다시 넣는다. */
export function queuedOf(kind) {
  return [..._queued.values()].filter((x) => x.kind === kind).sort((a, b) => a.since - b.since).map((x) => structuredClone(x));
}

/**
 * v2.742: 대기 요청 목록(자동 업그레이드 대기·상태 화면). 대기 시한이 지난 것은 뺀다(기능이 정리하지 못해도 업그레이드를 막지 않게).
 * `resumable` — 기록이 파일에 남아 있고(마지막 쓰기 성공) 재개가 켜져 있어 재시작 뒤 대기열로 돌아오는가.
 */
export function queuedScans(at = now()) {
  const durable = !_lastWriteError && resumeEnabled();
  return [..._queued.values()].filter((x) => x.until == null || at <= x.until)
    .map((x) => ({ kind: x.kind, key: x.key, label: x.label, trigger: x.trigger, since: x.since, until: x.until, queued: true, resumable: durable }));
}

/**
 * 재시작이 와도 다음 기동이 **같은 작업에 다시 붙어** 결과만 받는 스캔인가(v2.741 TIMING-03).
 * meta.jobId = 장비에서 분리 실행 중인 작업 id(아이실론 du — isidu/detach.js). 자동 재개가 꺼져 있거나(SCAN_RESUME=0)
 * 재개 상한에 닿았으면 다음 기동이 그 작업을 이어 받지 않으므로 거짓이다(끊기면 결과를 잃는다).
 */
function resumableEntry(e) {
  return !!(e?.meta && typeof e.meta.jobId === 'string' && e.meta.jobId) && resumeEnabled() && (numOrNull(e.resumes) ?? 0) < RESUME_LIMIT;
}

/** 이 프로세스가 지금 돌리는 스캔(자동 업그레이드 대기·상태 화면). `resumable` — 재시작 뒤 같은 작업에 다시 붙는가(위). */
export function runningScans() {
  return [..._active.values()].map((e) => ({ kind: e.kind, key: e.key, label: e.label, trigger: e.trigger, since: e.since, resumes: e.resumes, resumable: resumableEntry(e) }));
}

/**
 * v2.740 A-04: 지금 도는 스캔이 재시작으로 끊기면 자동 재개가 실제로 이어 주는가(문구용 — 단정하지 않게).
 * 재개가 꺼져 있거나(SCAN_RESUME=0) 이미 재개 상한에 닿은 스캔이 있으면 그 사실을 말한다.
 * @param {{resumes?:number}[]} scans runningScans() 결과
 */
export function resumeOutlookText(scans) {
  const list = Array.isArray(scans) ? scans : [];
  if (!resumeEnabled()) return '자동 재개가 꺼져 있어(SCAN_RESUME=0) 끊긴 스캔은 다음 주기나 수동 실행으로 다시 돕니다';
  const atLimit = list.filter((x) => (Number(x?.resumes) || 0) >= RESUME_LIMIT).length;
  if (atLimit) return `끊긴 스캔은 자동 재개가 잇습니다(단 ${atLimit}개는 재개 상한 ${RESUME_LIMIT}번에 닿아 다음 주기나 수동 실행으로 다시 돕니다)`;
  return '끊긴 스캔은 자동 재개가 잇습니다';
}

/** 재개 대기 중인 항목인가(주기 틱이 그 대상을 먼저 새로 시작하지 않게 — 원격 du 를 이어 받아야 하는 경우). */
export function isResumePending(kind, key) {
  return _interrupted.some((x) => x.kind === kind && x.key === key && x.state === 'pending');
}
/** 재개 대기 항목(복사본). */
export function pendingResumeOf(kind, key) {
  const x = _interrupted.find((y) => y.kind === kind && y.key === key && y.state === 'pending');
  return x ? structuredClone(x) : null;
}

function pushHistory(x, outcome, note = '') {
  _history.unshift({ kind: x.kind, key: x.key, label: x.label, trigger: x.trigger, since: x.since, detectedAt: x.detectedAt, at: now(), outcome, note: str(note, 300), resumes: x.resumes });
  if (_history.length > HISTORY_MAX) _history.length = HISTORY_MAX;
}

/** 기능이 재개 함수를 등록한다 — (entry) => Promise<{outcome, note?}>. */
export function registerScanResumer(kind, fn) {
  if (KIND_RE.test(String(kind || '')) && typeof fn === 'function') _resumers.set(kind, fn);
}

const OUTCOMES = new Set(['started', 'covered', 'gone', 'skipped', 'busy']);

/** 대기 항목을 한 번 처리한다(타이머·테스트). */
export async function processScanResumes({ at = now() } = {}) {
  if (_processing) return { skipped: true };
  _processing = true;
  let changed = false;
  try {
    for (const x of [..._interrupted]) {
      if (x.state !== 'pending') continue;
      if (x.nextAt && at < x.nextAt) continue;
      const done = (outcome, note) => { _interrupted = _interrupted.filter((y) => y !== x); pushHistory(x, outcome, note); changed = true; };
      if (!resumeEnabled()) { done('skipped', 'SCAN_RESUME=0 — 자동 재개가 꺼져 있습니다'); continue; }
      if (x.resumes >= RESUME_LIMIT) { done('limit', `자동 재개를 이미 ${x.resumes}번 했습니다 — 재시작이 반복되는 원인을 확인하세요(다음 주기·수동 실행은 그대로 동작합니다)`); continue; }
      if (x.since && at - x.since > EXPIRE_MS) { done('expired', '시작한 지 48시간이 넘어 다시 돌리지 않습니다(다음 주기를 기다립니다)'); continue; }
      const fn = _resumers.get(x.kind);
      if (!fn) { done('no-resumer', '이 노드에서 이 종류의 스캔을 다시 시작할 수 없습니다'); continue; }
      let r = null;
      try { r = await fn(structuredClone(x)); } catch (e) { r = { outcome: 'error', note: String(e?.message || e) }; }
      const outcome = OUTCOMES.has(r?.outcome) || r?.outcome === 'error' ? r.outcome : 'error';
      if (outcome === 'busy') {
        x.tries = (x.tries || 0) + 1;
        if (x.tries > BUSY_RETRY_MAX) { done('gave-up', `다른 스캔이 계속 진행 중이라 ${BUSY_RETRY_MAX}번 기다린 뒤 그만뒀습니다${r?.note ? ` — ${r.note}` : ''}`); continue; }
        x.nextAt = at + BUSY_RETRY_MS; x.note = str(r?.note || '', 300); changed = true;
        continue;
      }
      if (outcome === 'started') {
        // 기능이 scanStarted(resumeOf) 로 이미 'resumed' 를 남겼으면 대기 목록에서 빠져 있다 — 그 이력에 기능의 설명(남은 대역 수 등)을 붙인다.
        if (_interrupted.includes(x)) done('resumed', r?.note || '자동으로 다시 시작했습니다');
        else if (r?.note) {
          const h = _history.find((y) => y.outcome === 'resumed' && sameRun(y, x));   // v2.741: 같은 키의 다른 대기 항목 이력에 붙이지 않게
          if (h) { h.note = str(r.note, 300); changed = true; }
        }
        continue;
      }
      done(outcome, r?.note || '');
    }
  } finally {
    _processing = false;
    if (changed) write();
  }
  if (_interrupted.some((x) => x.state === 'pending')) armTimer();
  return { pending: _interrupted.length };
}

function armTimer(delay = null) {
  if (_timer) return;
  const nextAt = _interrupted.reduce((m, x) => (x.nextAt && (m == null || x.nextAt < m) ? x.nextAt : m), null);
  const ms = delay ?? Math.max(5_000, (nextAt ?? now() + BUSY_RETRY_MS) - now());
  _timer = setTimeout(() => { _timer = null; processScanResumes().catch((e) => console.warn(`[scan-journal] 재개 처리 실패: ${e?.message || e}`)); }, ms);
  _timer.unref?.();
}

/** index.js 가 수집기를 띄운 뒤 부른다 — 대기 항목이 있으면 resumeDelayMs 뒤 재개한다. */
export function scheduleScanResumes() {
  if (!_interrupted.length) return { pending: 0 };
  const ms = resumeDelayMs();
  armTimer(ms);
  console.log(`[scan-journal] 재시작으로 중단된 스캔 ${_interrupted.length}개 — ${Math.round(ms / 1000)}초 뒤 ${resumeEnabled() ? '자동으로 다시 시작합니다' : '기록만 합니다(SCAN_RESUME=0)'}`);
  return { pending: _interrupted.length, inMs: ms };
}

const view = (x) => ({ kind: x.kind, key: x.key, label: x.label, trigger: x.trigger, since: x.since, detectedAt: x.detectedAt, resumes: x.resumes, tries: x.tries || 0, nextAt: x.nextAt || null, note: x.note || '' });

/** 한 기능의 상태 — 그 기능 상태 응답에 싣는다. */
export function journalFor(kind) {
  return {
    running: runningScans().filter((x) => x.kind === kind),
    interrupted: _interrupted.filter((x) => x.kind === kind).map(view),
    recent: _history.filter((x) => x.kind === kind).slice(0, 10),
    queued: queuedScans().filter((x) => x.kind === kind),   // v2.742: 아직 시작하지 않은 대기 요청(재시작에도 남는다)
    resumeLimit: RESUME_LIMIT,
  };
}

/** 전체 상태(서비스 점검·진단). */
export function scanJournalStatus() {
  return {
    bootAt: _bootAt, load: _loadInfo, resumeEnabled: resumeEnabled(), resumeDelayMs: resumeDelayMs(), resumeLimit: RESUME_LIMIT,
    running: runningScans(), interrupted: _interrupted.map(view), queued: queuedScans(), recent: _history.slice(0, 20), lastWriteError: _lastWriteError,
  };
}

/** 테스트 전용 — 파일을 다시 읽는다(새 기동 흉내). 등록된 재개 함수는 그대로 둔다. */
export function _reloadForTest() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _active.clear(); _queued.clear(); _interrupted = []; _history = []; _lastWriteError = null; _processing = false; _queuedBootDrops.length = 0;
  loadOnce();
}
export function _resetForTest() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _active.clear(); _queued.clear(); _interrupted = []; _history = []; _resumers.clear(); _lastWriteError = null; _processing = false; _queuedBootDrops.length = 0;
  try { fs.rmSync(FILE(), { force: true }); } catch { /* */ }
}
