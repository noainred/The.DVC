/**
 * vCenter 이벤트 로그 수집 폴러 — 주기적으로 각 vCenter의 신규 이벤트를 가져와 장기 보관 DB에
 * 누적하고, 보관기간 초과분을 정리한다. mock 모드에서는 합성 이벤트로 UI를 채운다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config, loadVcenterConfig, clampIntervalMs } from '../config.js';
import { poolRun } from '../util/pool.js';   // v2.447: vCenter 병렬 수집(감사 T2) · v2.579: routes 의존 제거
import { store } from '../store.js';
import { collectVCenterEvents, CLEANUP_TIMEOUT_MS, EVENT_BATCH_ROWS as COLLECTOR_BATCH_ROWS } from '../vcenter/soapClient.js';
import { vcAuthGuard, isVcAuthError } from '../vcenter/restClient.js';
import { splitDirectCollectTargets } from '../vcenter/collectTarget.js'; // v2.732(B4-01): 직접 수집 대상 판정(store.js 주 폴러와 같은 조건)
import { capStr } from '../util/capStr.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';   // v2.765: 수집 커서 영속(상태 파일)
import { numOrNull } from '../util/numOrNull.js';
import { registerStateFile } from '../util/stateFiles.js';
import { getLogsDb } from './db.js';
import { ingestSnapRows } from '../veeam/snapDb.js';   // v2.759: 스냅샷 행은 Veeam 전용 DB 에도(카드 백업 수량을 바로 계산)
import { loadLogSettings } from './settings.js';
import { demoLoginFailEvents } from '../mock/demo/users.js'; // v2.708 로그인 실패 분석 데모(mock 에서만)
import { demoBackupEvents } from '../mock/demo/backup.js'; // v2.711 미보호 VM 데모(mock 에서만)

const SEV_RANK = { info: 0, warning: 1, error: 2 };
// 동시 수집 상한 — 28개를 한꺼번에 열면 매 주기 SOAP 파싱이 몰린다(store.collectPool 과 같은 취지).
const LOG_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.VCLOGS_CONCURRENCY) || 6));
const DAY = 86_400_000;

let timer = null;
let lastRun = null;
let running = false;
let runningSince = null; // v2.743(감사 WEB-04): 진행 중인 수집이 언제 시작됐는지 — '지금 수집' 이 겹쳤을 때 화면이 말한다
let tick = 0; // prune/용량점검 스로틀용(매 폴 DELETE 스캔 방지)
let lastCap = null; // v2.741(DB-03): 마지막 용량 상한 처리 결과 — 상태 화면이 '사용 중 크기 기준' 을 말한다
const PRUNE_EVERY = 10; // N폴마다 1회만 보관기간/용량 정리

/*
 * v2.731(점검 r1 A2-01): vCenter 별 '이벤트가 온전한 마지막 시각' — VM 가용성(availability/analyze.js)의 측정 끝 근거.
 * 이 기록이 없으면 가용성은 측정 끝을 언제나 '지금' 으로 둬서, 수집이 멈춘 vCenter 의 꼬리(수집하지 못한 구간)를 '정지 없음 = 가동' 으로 셌다.
 * 마지막 이벤트 시각(db.lastTs)으로는 대신할 수 없다 — 최소 심각도가 info 가 아니면 조용한 vCenter 는 수집이 정상이어도 이벤트가 오래 없다.
 *  · 적재까지 성공한 수집만 기록한다(데드라인·접속 실패·적재 실패는 기록을 바꾸지 않는다 — 멈춘 수집이 '방금 성공' 으로 보이면 안 된다).
 *  · 상한(maxPerPoll)에 걸렸으면 그 뒤 이벤트는 아직 안 읽었다 — 수집 시작 시각이 아니라 마지막으로 읽은 이벤트 시각까지만 온전하다
 *    (이벤트는 오래된 것부터 읽는다 — collectVCenterEvents).
 *  · 인메모리다 — 재시작 직후에는 기록이 없고 가용성은 마지막 이벤트 시각으로 대신한다(그 사실을 화면이 말한다).
 *    재시작 사이에 쌓인 이벤트는 다음 수집이 lastTs 부터 다시 읽으므로 그 틈은 실제로 아직 수집 전이다.
 */
const _collectOk = new Map();   // vcenterId → { at, capped, events }

/*
 * v2.756(실서버 — OC2 vCenter 의 이벤트 수집이 2026-10-10 04:32 에서 12일째 멈춤): 수집 시작점이 '로그 DB 에 마지막으로 **저장된** 시각'
 *   (db.lastTs + 1)뿐이었다. 읽은 이벤트가 전부 저장되지 않으면(① 중복 키로 INSERT OR IGNORE 가 버림 ② 최소 심각도로 걸러짐) 시작점이
 *   그대로라 다음 주기가 같은 구간을 다시 읽고 다시 버렸다 — 영원히. ①의 실제 경로: 중복 키가 vCenter **이벤트 번호(key) 하나**였다 —
 *   vCenter 를 다시 배포·마이그레이션 업그레이드하면 번호가 처음부터 다시 매겨져 새 이벤트가 보관 중인 옛 번호(기본 365일)와 겹친다(추정 —
 *   그 vCenter 의 업그레이드 이력은 확인하지 못했다). 이제 ⓐ 중복 키 = 번호@시각(eventRowKey) ⓑ 시작점 = max(마지막 저장, 마지막으로 **읽은** 시각)
 *   (nextSinceTs — 읽은 커서는 인메모리, 재시작하면 한 번 더 읽고 다시 나아간다) ⓒ 읽었는데 하나도 저장되지 않은 상한 주기는 경고·결과에 남긴다.
 */
const _readCursor = new Map();  // vcenterId → 마지막으로 읽은 이벤트 시각(저장 여부와 무관)
/*
 * v2.765(실서버 OC2 13일 정체 — 재시작 8회): 위 두 기록(_collectOk·_readCursor)이 인메모리라 재시작마다 db.lastTs(마지막 **저장** 시각)로
 *   되돌아갔다 — 상한에 걸린 주기가 읽어 둔 커서·'읽었는데 저장 0' 구간이 매번 사라져 같은 구간을 다시 읽었다. 이제 주기마다 1회(적재 뒤)
 *   CONFIG_DIR/vcenter-logs-cursor.json 에 원자적으로 저장하고 첫 수집 전에 읽는다. 상태 파일이다(백업 감시 제외 — util/stateFiles.js 등록).
 *   로드 규칙: 객체가 아니면 손상(preserveCorrupt) · 값은 numOrNull 로 판정(문자열 수치·null 은 버린다) · 미래 시각은 지금으로 자른다
 *   (시계가 틀린 채 저장된 커서가 앞으로 올 이벤트를 영영 건너뛰지 않게) · 저장 시각보다 **오래된** 커서는 그대로 둔다(nextSinceTs 가 늦은 쪽을 쓴다).
 */
export const CURSOR_FILE_NAME = 'vcenter-logs-cursor.json';
const CURSOR_FILE = path.join(config.configDir, 'vcenter-logs-cursor.json');
registerStateFile(CURSOR_FILE_NAME);
const _capStreak = new Map();   // vcenterId → 연속으로 상한에 걸린 주기 수(따라잡기 뒤에도 남아 있으면 센다)
const _lastPoll = new Map();    // vcenterId → 이번 주기 수집 진단 { at, read, stored, ms, rounds, deadlineMs, error }
const _lagLog = new Map();      // vcenterId → 지연 경고를 마지막으로 찍은 시각(시간당 1줄)
let _cursorLoaded = false;
let _cursorDirty = false;
let _cursorWarnAt = 0;          // v2.765(3-c): 커서 파일 쓰기 실패 경고는 시간당 1줄(_cursorDirty 가 남아 매 주기 다시 시도한다)
let _busySkips = 0;             // v2.765(1-b): 진행 중이라 건너뛴 틱 수 — 주기가 길어져 다음 틱이 통째로 밀린 사실을 상태가 말한다
let _busySkipAt = null;
/**
 * v2.765(3-b): 커서가 어느 로그 DB 의 것인지 — 종류·경로·파일(inode). 로그 DB 를 새로 만들거나 저장 경로를 바꾸면 커서 파일이 남아 새 DB 가
 *   첫 7일을 채우지 않았다(커서가 '이미 읽음' 이라 말하므로). 파일에 이 키를 함께 적고, 로드 때 다르면 커서를 무시한다(경고 1줄 · 다음 저장이 덮는다).
 *   inode 는 둘 다 있을 때만 비교한다(JSON 폴백 DB 는 첫 쓰기 전에 파일이 없다). 못 만들면 null(비교하지 않음 — 옛 파일과 같다).
 */
export function logsDbKey(db) {
  if (!db || typeof db.path !== 'string' || !db.path) return null;
  let ino = '';
  try { ino = String(fs.statSync(db.path).ino); } catch { /* 아직 파일이 없을 수 있다 */ }
  return { kind: String(db.kind || ''), path: db.path, ino };
}
/** 두 DB 키가 같은 DB 를 가리키는가(순수). 한쪽이 없으면 비교하지 않는다(true). */
export function sameLogsDb(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return true;
  if (String(a.kind || '') !== String(b.kind || '') || String(a.path || '') !== String(b.path || '')) return false;
  return !(a.ino && b.ino) || String(a.ino) === String(b.ino);
}
/** 커서 파일의 vCenter 항목 하나를 믿을 수 있는 모양으로(순수). 쓸 값이 없으면 null. */
export function normalizeCursorEntry(v, now = Date.now()) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const ts = (x) => { const n = numOrNull(x); return n != null && n > 0 ? Math.min(Math.floor(n), now) : null; };
  const cnt = (x) => { const n = numOrNull(x); return n != null && n >= 0 ? Math.floor(n) : 0; };
  const readTs = ts(v.readTs);
  const okAt = ts(v.okAt);
  if (readTs == null && okAt == null) return null;
  return { readTs, okAt, capped: v.capped === true, events: cnt(v.events), consecutiveCapped: cnt(v.consecutiveCapped), ended: typeof v.ended === 'string' ? v.ended.slice(0, 16) : null };
}
/** 기동 뒤 첫 수집 전에 한 번 — 파일이 없으면 빈 기록, 손상이면 보존하고 빈 기록. dbKey(logsDbKey)가 파일의 것과 다르면 무시(3-b). */
export function loadCursorFile({ now = Date.now(), force = false, dbKey = null } = {}) {
  if (_cursorLoaded && !force) return;
  _cursorLoaded = true;
  try {
    if (!fs.existsSync(CURSOR_FILE)) return;
    const p = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8'));
    if (!p || typeof p !== 'object' || Array.isArray(p) || !p.vcenters || typeof p.vcenters !== 'object' || Array.isArray(p.vcenters)) throw new Error('객체가 아님');
    if (dbKey && p.db && typeof p.db === 'object' && !sameLogsDb(p.db, dbKey)) {
      console.warn(`[vclogs] 수집 커서 파일(${CURSOR_FILE_NAME})이 다른 로그 DB 의 것입니다 — 무시하고 로그 DB 의 마지막 저장 시각부터 읽습니다(새 DB 가 첫 7일을 채우도록)`);
      _cursorDirty = true;   // 다음 저장이 새 DB 키로 덮는다
      return;
    }
    for (const [id, raw] of Object.entries(p.vcenters)) {
      const e = normalizeCursorEntry(raw, now);
      if (!e || !id) continue;
      if (e.readTs != null && e.readTs > (_readCursor.get(id) || 0)) _readCursor.set(id, e.readTs);
      if (e.okAt != null && !_collectOk.has(id)) _collectOk.set(id, { at: e.okAt, capped: e.capped, events: e.events, ended: e.ended, restored: true });
      if (e.consecutiveCapped > 0) _capStreak.set(id, e.consecutiveCapped);
    }
  } catch (e) { preserveCorrupt(CURSOR_FILE, e?.message); }
}
/**
 * 주기마다 1회(적재 뒤) — 바뀐 것이 없으면 쓰지 않는다. 실패는 경고(시간당 1줄 — 수집은 그대로).
 * v2.765(3-c): knownIds(등록부의 vCenter id)가 있으면 거기 없는 항목은 지운다 — 지운 vCenter 의 커서가 영영 남아 지연이 자라던 것.
 *   등록부를 못 읽어 비었을 때(빈 Set)는 지우지 않는다(온전한 기록을 빈 등록부 때문에 잃지 않게).
 */
export function saveCursorFile({ force = false, knownIds = null, dbKey = null } = {}) {
  if (knownIds instanceof Set && knownIds.size > 0) {
    for (const m of [_readCursor, _collectOk, _capStreak, _lastPoll]) for (const id of [...m.keys()]) if (!knownIds.has(id)) { m.delete(id); _cursorDirty = true; }
  }
  if (!_cursorDirty && !force) return false;
  const vcenters = {};
  const ids = new Set([..._readCursor.keys(), ..._collectOk.keys()]);
  for (const id of [...ids].sort()) {
    const ok = _collectOk.get(id);
    vcenters[id] = { readTs: _readCursor.get(id) ?? null, okAt: ok?.at ?? null, capped: ok?.capped === true, events: ok?.events ?? 0, ended: ok?.ended ?? null, consecutiveCapped: _capStreak.get(id) || 0 };
  }
  try {
    atomicWriteFileSync(CURSOR_FILE, JSON.stringify({ savedAt: Date.now(), ...(dbKey ? { db: dbKey } : {}), vcenters }, null, 1), { mode: 0o600 });
    _cursorDirty = false;
    return true;
  } catch (e) {
    const t = Date.now();
    if (t - _cursorWarnAt > 3_600_000) { _cursorWarnAt = t; console.warn(`[vclogs] 수집 커서 저장 실패(시간당 1줄 — 매 주기 다시 시도): ${e?.message || e}`); }
    return false;
  }
}
/*
 * v2.766(점검 R1-A2-01 — 재현): 3-b 의 DB 키 비교는 **커서 파일을 읽을 때(기동 뒤 1회)** 만 돌았다. 실행 중에 저장 경로를 바꾸면
 *   (관리자 설정 › Log — saveLogSettings → resetLogsDb) 새 DB 는 비었는데 인메모리 커서·완결 시각이 남아 첫 7일을 채우지 않았고,
 *   그 주기 끝의 저장이 커서 파일을 **새 DB 키로** 덮어 재시작해도 못 채웠다(데이터 손실 경로). 이제 주기마다 이번 DB 키를 직전 주기의 것과
 *   비교해 다르면 인메모리 기록을 비우고 커서 파일을 새 키로 다시 쓴다(라우트가 resetLogsDb 를 부르지 않는 경로 — 파일 교체 등 — 도 덮는다).
 */
let _activeDbKey = null;
/** 이번 주기 DB 키가 직전 주기와 다른 DB 를 가리키면 인메모리 커서·완결 시각·연속 상한·진단을 비운다. 비웠으면 true. */
export function syncCursorDbKey(dbKey) {
  const prev = _activeDbKey;
  _activeDbKey = dbKey || prev;
  if (!prev || !dbKey || sameLogsDb(prev, dbKey)) return false;
  _readCursor.clear(); _collectOk.clear(); _capStreak.clear(); _lastPoll.clear(); _lagLog.clear();
  _cursorDirty = true;   // 이번 주기 끝의 저장이 새 DB 키로 덮는다
  console.warn(`[vclogs] 로그 DB 가 바뀌었습니다(${prev.path} → ${dbKey.path}) — 수집 커서를 비우고 새 DB 의 마지막 저장 시각(없으면 최근 7일)부터 읽습니다`);
  return true;
}
/** 테스트 전용 — 인메모리 기록을 비우고 다음 수집이 파일을 다시 읽게 한다. */
export function _resetCursorsForTest() { _readCursor.clear(); _collectOk.clear(); _capStreak.clear(); _lastPoll.clear(); _lagLog.clear(); _cursorLoaded = false; _cursorDirty = false; _cursorWarnAt = 0; _activeDbKey = null; }
/*
 * v2.765(따라잡기 — 재검토 1-a·1-b·1-c): 밀린 vCenter 는 다음 주기를 기다리지 않고 **같은 주기 안에서, 한 세션·한 컬렉터로** 이어 읽는다
 *   (collectVCenterEvents onBatch) — EVENT_BATCH_ROWS 건마다 묶음을 받아 적재(전용 DB → 로그 DB 조각 트랜잭션)하고 커서·온전한 시각을 갱신한 뒤
 *   이벤트 루프에 양보한다. 예전(이 판의 첫 구현)은 회차마다 로그인·CreateCollector 를 다시 해 10분에 로그인 40회였고, 회차 하나(40,000건)를
 *   메모리에 다 들고 적재했다(동기 정지 최대 410ms · 힙 1.2GB). 로그인은 vCenter 당 주기에 1회. 묶음 수가 상태의 rounds 다.
 *   예산(1-b): vCenter **자기 시작 시각 기준** 주기의 CATCHUP_BUDGET_RATIO, 단 주기 끝(꼬리 여유 제외)을 넘지 않게 — 뒤 순번(7번째 이후)이 앞 6곳의
 *   예산 뒤에 시작해도 최소 예산(CATCHUP_MIN_BUDGET_MS)은 받는다. 생성 속도가 10분당 상한(기본 5,000)보다 빠른 vCenter(실서버 OC2)가 영영
 *   따라잡지 못하던 것. '읽었는데 저장 0'(stalled — 중복 키·심각도 필터)은 한 세션 안에서는 앞으로 나아가므로 멈추지 않고, 주기 끝에 밝힌다.
 *   ⚠ 이 모드에서 설정 maxPerPoll(한 주기 상한)은 수집 상한이 아니다 — 시간 예산이 대신한다(화면 안내 vcLogMaxPerPollText).
 */
export const CATCHUP_BUDGET_RATIO = 0.8;
export const CATCHUP_MIN_BUDGET_MS = 30_000;
export const EVENT_BATCH_ROWS = Math.max(100, Math.min(20_000, Math.floor(Number(process.env.VCLOGS_BATCH_ROWS)) || COLLECTOR_BATCH_ROWS));
/** 수집 주기(ms) — 설정값을 1분~1일로 묶는다(schedule 과 같은 식). */
export function pollEveryMs(pollIntervalMin) {
  return Math.min(86_400_000, clampIntervalMs(Number(pollIntervalMin) * 60_000, 600_000, 60_000));
}
/** 이번 주기의 따라잡기 예산(ms) — 주기 간격의 80%(vCenter 하나가 자기 시작 시각부터 쓸 수 있는 최대). */
export function catchupBudgetMs(pollIntervalMin) { return Math.floor(pollEveryMs(pollIntervalMin) * CATCHUP_BUDGET_RATIO); }
/**
 * vCenter 1곳의 예산(순수) — min(자기 80%, 주기 끝 − 꼬리 여유 − 지금), 바닥은 min(자기 80%, CATCHUP_MIN_BUDGET_MS).
 * 꼬리 여유 = 데드라인 유예 + 정리 2건 시한 + 5초(주기가 다음 틱을 넘기지 않게 — 넘기면 재진입 가드가 한 주기를 통째로 건너뛴다).
 */
export function vcCatchupBudgetMs({ everyMs, cycleStart, now = Date.now() } = {}) {
  const every = Number(everyMs) > 0 ? Number(everyMs) : 600_000;
  const own = Math.floor(every * CATCHUP_BUDGET_RATIO);
  const tail = DEADLINE_GRACE_MS + 2 * CLEANUP_TIMEOUT_MS + 5_000;
  const left = (Number(cycleStart) || now) + every - tail - now;
  return Math.max(Math.min(own, CATCHUP_MIN_BUDGET_MS), Math.min(own, Math.floor(left)));
}
/**
 * v2.765: 이번 수집이 '끝까지 읽지 못했다' 인가 — 수집기(collectVCenterEvents)가 배열에 실은 ended 를 본다. 없으면(옛 수집기·mock) 건수로 판정.
 *   'batch'(중간 묶음 — 뒤가 남았다) · 'budget'(시간 예산) 도 상한처럼.
 */
export const CAPPED_ENDED = Object.freeze(['max', 'pages', 'aborted', 'budget', 'batch']);
/** 이벤트 행의 중복 키 — vCenter 이벤트 번호 + 시각. 번호가 없으면 null(db 가 시각·문구로 만든다). */
export function eventRowKey(e) {
  const k = e?.key;
  return k == null || k === '' ? null : `${k}@${Number(e.ts) || 0}`;
}
/**
 * 다음 수집 시작 시각 — 저장된 마지막과 읽은 마지막 중 늦은 것(**포함**). 둘 다 없으면 첫 수집 창.
 * v2.765(재검토 2-b): 예전 +1ms 는 같은 ms 에 여러 이벤트가 있고 그 사이에서 묶음·주기가 끊기면 나머지를 영영 건너뛰었다(재현: 150건 중 같은 ms 4건,
 *   상한 100 → 2건 유실). 그 시각을 다시 읽어도 중복은 번호@시각 키(INSERT OR IGNORE)·전용 DB 해시가 거른다 — 비용은 같은 ms 몇 건의 재읽기.
 */
export function nextSinceTs(lastStored, lastRead, { now = Date.now(), firstDays = 7 } = {}) {
  const base = Math.max(Number(lastStored) || 0, Number(lastRead) || 0);
  return base > 0 ? base : now - firstDays * DAY;
}
const _stallLog = new Map();    // vcenterId → 마지막 경고 시각(같은 vCenter 는 1시간에 1줄)
/** 수집 결과로 '이벤트가 온전한 시각' 을 계산한다(순수). events = 원시 이벤트(심각도 거르기 전), max = 한 번에 읽는 상한. */
export function eventsCompleteUntil(events, { startedAt, max = Infinity } = {}) {
  const list = Array.isArray(events) ? events : [];
  let maxTs = null;
  for (const e of list) { const t = Number(e?.ts); if (Number.isFinite(t) && (maxTs == null || t > maxTs)) maxTs = t; }
  // v2.765: 'pages'(쪽 수 한도 — 상한보다 적게 읽었어도 뒤가 남았다) · 'aborted'(데드라인 — 읽은 만큼만) 도 상한처럼 다룬다.
  const capped = CAPPED_ENDED.includes(list.ended) || (Number.isFinite(max) && max > 0 && list.length >= max);
  if (capped) return { at: maxTs, capped: true };
  // 상한 밖 — 수집을 시작한 시각까지 온전하다. vCenter 시계가 앞서 그보다 늦은 이벤트가 있으면 그 시각까지.
  return { at: Math.max(Number(startedAt) || 0, maxTs ?? 0) || null, capped: false };
}
/*
 * v2.763(V4-4): 수집기(soapClient collectVCenterEvents)가 한 번에 실제로 읽을 수 있는 최대 — ReadNextEvents 200쪽 × 쪽당 200건.
 *   설정은 50,000 까지 허용해 40,000 을 넘게 두면 수집기는 40,000 에서 멈추는데, 폴러는 설정값으로 상한을 판정해 '상한에 안 걸림 →
 *   수집 시작 시각까지 온전' 으로 기록했다(그 뒤 몇 시간치 이벤트가 빠진 채 스냅샷 판정·가용성이 '신선'). 수집 호출과 완결 판정에 같은 값을 쓴다.
 *   ⚠ 수집기의 쪽 수·쪽 크기를 바꾸면 이 값도 바꿀 것(test/veeam2763c 가 소스를 대조한다).
 */
export const COLLECTOR_MAX_EVENTS = 200 * 200;
/** 이번 주기에 읽을 상한 — 설정값과 수집기 한도 중 작은 것. */
export function effectiveMaxPerPoll(settings) {
  const m = Number(settings?.maxPerPoll);
  return Number.isFinite(m) && m > 0 ? Math.min(m, COLLECTOR_MAX_EVENTS) : COLLECTOR_MAX_EVENTS;
}
/** 그 vCenter 의 마지막 수집 성공 기록 — { at, capped, events } 또는 null. */
export function logCollectOk(vcenterId) { const r = _collectOk.get(String(vcenterId ?? '')); return r ? { ...r } : null; }
/** 그 vCenter 의 이벤트가 온전한 마지막 시각(ms) 또는 null(기록 없음). */
export function logCollectOkAt(vcenterId) { return _collectOk.get(String(vcenterId ?? ''))?.at ?? null; }
/** v2.761(Veeam C1): 이 프로세스에서 수집 주기를 한 번 이상 끝까지 돌았는가 — 그 뒤에도 기록이 없는 vCenter 는 '아직 못 모음'(기동 직후와 구분). */
export function logPollerRanOnce() { return lastRun != null && lastRun.skipped !== true; }
/**
 * v2.765(진단): 그 vCenter 의 수집 지연(ms) — 지금 − (온전한 시각 ?? 마지막 저장 시각). 둘 다 없으면 null('아직 모름' — 0 이 아니다).
 * 온전한 시각이 있으면 그것이 기준이다(조용한 vCenter 는 저장 시각이 오래돼도 수집은 정상 — A2-01 주석).
 */
export function logLagMs(vcenterId, lastStoredTs = null, now = Date.now()) {
  const okAt = _collectOk.get(String(vcenterId ?? ''))?.at ?? null;
  const base = okAt ?? (Number(lastStoredTs) > 0 ? Number(lastStoredTs) : null);
  return base == null ? null : Math.max(0, now - base);
}
/** 콘솔 지연 줄의 상태 — 이번 주기 결과로 '따라잡기 중'(상한에 걸렸지만 저장됨) · '정체'(저장 0 또는 실패) · '정상'(끝까지 읽음). */
export function lagStateText(vcenterId) {
  const st = collectStateOf(String(vcenterId ?? ''));
  return st === 'catching-up' ? '따라잡기 중' : st === 'stalled' || st === 'failed' ? '정체' : st === 'ok' ? '정상' : '—';
}
/** 이번 주기의 vCenter 상태 코드(순수 — 인메모리 기록만 읽는다). 기록이 없으면 null. */
export function collectStateOf(vcenterId) {
  const p = _lastPoll.get(vcenterId);
  if (!p) return null;
  if (p.error) return 'failed';
  const ok = _collectOk.get(vcenterId);
  if (ok?.capped) return p.stored > 0 ? 'catching-up' : 'stalled';
  return 'ok';
}
/**
 * v2.765(진단): vCenter 별 수집 진단 — /admin/vclogs/status 의 `collect` 배열. 보관 건수 목록(db.meta().vcenters)과 인메모리 기록을 합친다.
 *   lagMs 는 logLagMs · ratePerMin 은 이번 주기에 읽은 수/소요(소요를 모르면 null — 0 이 아니다) · error 는 원문 300자(범위 계정에는
 *   scopeVcLogStatus 가 지운다 — vCenter 주소가 들어간다). vcenterId 순.
 */
export function logCollectDiag(storeVcenters = [], { now = Date.now() } = {}) {
  const stored = new Map();
  for (const v of Array.isArray(storeVcenters) ? storeVcenters : []) if (v && v.vcenterId != null) stored.set(String(v.vcenterId), v);
  const ids = new Set([...stored.keys(), ..._lastPoll.keys(), ..._collectOk.keys(), ..._readCursor.keys()]);
  const out = [];
  for (const id of [...ids].sort()) {
    const sv = stored.get(id);
    const ok = _collectOk.get(id);
    const p = _lastPoll.get(id);
    const lastStoredTs = sv && Number(sv.lastTs) > 0 ? Number(sv.lastTs) : null;
    const ratePerMin = p && Number.isFinite(p.ms) && p.ms > 0 ? Math.round((p.read / p.ms) * 60_000) : null;
    out.push({
      vcenterId: id,
      count: sv && Number.isFinite(sv.count) ? sv.count : null,
      lastStoredTs,
      cursorTs: _readCursor.get(id) ?? null,
      okAt: ok?.at ?? null,
      capped: ok ? ok.capped === true : null,
      ended: ok?.ended ?? null,
      restored: ok?.restored === true,
      lagMs: logLagMs(id, lastStoredTs, now),
      lastPoll: p ? { at: p.at, read: p.read, stored: p.stored, ms: p.ms, rounds: p.rounds, deadlineMs: p.deadlineMs, budgetMs: p.budgetMs ?? null, error: p.error, hint: p.hint ?? null } : null,
      consecutiveCapped: _capStreak.get(id) || 0,
      ratePerMin,
      state: collectStateOf(id),
    });
  }
  return out;
}

const MOCK_TYPES = [
  ['UserLoginSessionEvent', 'info', (u, e) => `User ${u} logged in`],
  ['VmPoweredOnEvent', 'info', (u, e) => `${e} is powered on`],
  ['VmPoweredOffEvent', 'info', (u, e) => `${e} is powered off`],
  ['VmMigratedEvent', 'info', (u, e) => `Migrated ${e} (vMotion)`],
  ['AlarmStatusChangedEvent', 'warning', (u, e) => `Alarm changed to Yellow on ${e}`],
  ['HostConnectionLostEvent', 'error', (u, e) => `Lost connection to host ${e}`],
  ['DatastoreCapacityIncreasedEvent', 'info', (u, e) => `Datastore ${e} capacity changed`],
  ['VmReconfiguredEvent', 'info', (u, e) => `Reconfigured ${e}`],
  ['DrsVmMigratedEvent', 'info', (u, e) => `DRS migrated ${e}`],          // v2.702(A7)
  ['PermissionAddedEvent', 'info', (u, e) => `Permission created for ${e}`], // v2.702(A8)
  ['VmCreatedEvent', 'info', (u, e) => `Created virtual machine ${e}`],      // v2.706(C5)
  ['VmClonedEvent', 'info', (u, e) => `Clone of VM completed: ${e}`],
  ['VmRemovedEvent', 'info', (u, e) => `Removed ${e} on host`],
  ['VmDeployedEvent', 'info', (u, e) => `Template deployed to ${e}`],
  ['EnteredMaintenanceModeEvent', 'info', (u, e) => `Host ${e} in maintenance mode`], // v2.706(C4)
  ['VmGuestRebootEvent', 'info', (u, e) => `Guest OS reboot for ${e}`],          // v2.707(C6) 대비
  ['VmRestartedOnAlternateHostEvent', 'warning', (u, e) => `${e} was restarted on another host by vSphere HA`],
];
// v2.702(A7·A8): 합성 이벤트의 상세 — 실수집(vmchanges/eventDetail.js)과 같은 모양.
const VM_EVENT = new Set(['VmPoweredOnEvent', 'VmPoweredOffEvent', 'VmMigratedEvent', 'VmReconfiguredEvent', 'DrsVmMigratedEvent',
  'VmCreatedEvent', 'VmClonedEvent', 'VmDeployedEvent', 'VmGuestRebootEvent', 'VmRestartedOnAlternateHostEvent']);
const HOST_EVENT = new Set(['EnteredMaintenanceModeEvent', 'HostConnectionLostEvent']);
function synthDetail(type, i, hosts) {
  const h = (k) => hosts.length ? hosts[(i + k) % hosts.length].name : null;
  if (type === 'VmMigratedEvent') return i % 3 === 0 ? { from: h(0), to: h(0), fromDs: `ds-${i % 4}`, toDs: `ds-${(i + 1) % 4}`, kind: 'svmotion' } : { from: h(0), to: h(1), fromDs: 'ds-0', toDs: 'ds-0', kind: 'vmotion' };
  if (type === 'DrsVmMigratedEvent') return { from: h(1), to: h(2), fromDs: 'ds-0', toDs: 'ds-0', kind: 'drs' };
  if (type === 'VmReconfiguredEvent') return i % 2 ? { modified: `config.hardware.numCPU: 2 -> 4; config.hardware.memoryMB: 8192 -> 16384`, fields: ['numCPUs', 'memoryMB'], numCpu: 4, memoryMB: 16384 } : { added: 'config.hardware.device(2001): (key = 2001, deviceInfo = (label = "Hard disk 2"))', fields: ['deviceChange'], devices: ['add VirtualDisk'] };
  if (type === 'PermissionAddedEvent') return { principal: `CORP\\ops${i % 3}`, role: i % 2 ? 'Admin' : 'ReadOnly', group: null, propagate: true };
  // v2.706(C5): 생성·삭제 — 실수집(lifeDetail)과 같은 모양.
  if (type === 'VmCreatedEvent') return { kind: 'create', host: h(0), ds: `ds-${i % 4}` };
  if (type === 'VmClonedEvent') return { kind: 'clone', host: h(1), ds: `ds-${i % 4}`, source: `template-src-${i % 3}` };
  if (type === 'VmDeployedEvent') return { kind: 'deploy', host: h(2), ds: `ds-${i % 4}`, source: `tpl-rhel9-${i % 2}` };
  if (type === 'VmRemovedEvent') return { kind: 'remove', host: h(0) };
  return null;
}
// v2.710: 데모 첫 수집 기간(일) — 가용성 화면의 가장 긴 보기(90일)를 덮는다.
export const MOCK_FIRST_DAYS = 91;
// mock: sinceTs~now 사이에 분산된 합성 이벤트 N개.
function synthEvents(vcId, sinceTs, n) {
  const snap = store.get();
  const hosts = (snap.hosts || []).filter((h) => h.vcenterId === vcId);
  const vms = (snap.vms || []).filter((v) => v.vcenterId === vcId);
  const names = [...hosts.map((h) => h.name), ...vms.map((v) => v.name)];
  if (!names.length) return [];
  const now = Date.now();
  const span = Math.max(1, now - sinceTs);
  const out = [];
  for (let i = 0; i < n; i++) {
    const [type, sev, msg] = MOCK_TYPES[(i + vcId.length) % MOCK_TYPES.length];
    // VM 이벤트는 VM 이름으로(이동·구성 변경 화면이 VM 으로 묶는다) — 같은 VM 이 여러 번 옮겨 다니게 앞쪽 VM 에 몰아 준다.
    const entity = type === 'VmRemovedEvent' ? `retired-vm-${(i * 5 + vcId.length) % 40}`   // 삭제된 VM 은 인벤토리에 없다
      : HOST_EVENT.has(type) && hosts.length ? hosts[(i + vcId.length) % hosts.length].name
        : VM_EVENT.has(type) && vms.length ? vms[(i * 3 + vcId.length) % Math.min(vms.length, 12)].name : names[(i * 7 + vcId.length) % names.length];
    const ts = sinceTs + Math.floor(((i + 1) / (n + 1)) * span);
    const d = synthDetail(type, i, hosts);
    const user = /^Vm(Created|Cloned|Deployed|Removed)Event$/.test(type) ? ['administrator@vsphere.local', 'CORP\\ops1', 'svc-automation@vsphere.local'][i % 3] : 'administrator@vsphere.local';
    out.push({ key: `mock-${vcId}-${ts}-${i}`, ts, type, severity: sev, user, entity, message: msg(user, entity), detail: d ? JSON.stringify(d) : null });
  }
  // v2.706(C4): 최근 재부팅한 호스트의 절반은 부팅 직전 연결 끊김(예기치 않은 재부팅 갈래), 나머지 일부는 유지보수 모드 진입(계획) —
  //   실수집과 같은 종류·시각 관계로 합성한다. 그 시각이 이번 수집 구간 안일 때만.
  for (const [k, h] of hosts.entries()) {
    if (!Number.isFinite(h.bootTime)) continue;
    const ts = h.bootTime - (k % 2 ? 10 * 60_000 : 3 * 3_600_000);
    if (ts < sinceTs || ts > now) continue;
    const type = k % 2 ? 'HostConnectionLostEvent' : 'EnteredMaintenanceModeEvent';
    out.push({ key: `mock-${vcId}-boot-${h.name}-${ts}`, ts, type, severity: type === 'HostConnectionLostEvent' ? 'error' : 'info', user: type === 'HostConnectionLostEvent' ? '' : 'administrator@vsphere.local', entity: h.name, message: `${type === 'HostConnectionLostEvent' ? 'Lost connection to host' : 'Host in maintenance mode'} ${h.name}`, detail: null });
  }
  // v2.708: 로그인 실패(BadUsername·SSO LoginFailure) — 시간 슬롯마다 결정적, 일부 vCenter 는 같은 출처의 무차별 대입.
  //   위 MOCK_TYPES 회전과 섞지 않고 덧붙인다(다른 화면이 쓰는 합성 이벤트 분포를 바꾸지 않게).
  for (const e of demoLoginFailEvents(vcId, sinceTs, now)) out.push(e);
  // v2.711: 백업 스냅샷(미보호 VM 화면의 보호 근거) — 최근 8일 · 켜진 VM 의 약 60%.
  for (const e of demoBackupEvents(vcId, vms, sinceTs, now)) out.push(e);
  return out;
}

// ⚠ setTimeout 은 2^31−1ms 를 넘으면 1ms 가 된다(v2.591 L2·L3) — 옛 저장값의 거대한 timeoutMs 가 데드라인을 즉시 발화시키지 않게 자른다.
export const vcLogDeadlineMs = (vc) => Math.min(2_147_000_000, Math.max(60_000, (vc?.timeoutMs > 0 ? vc.timeoutMs : 30_000) * 2));
// v2.598 T2598-02: 데드라인이 **결과만 포기**하던 것(Promise.race)에 AbortController 를 더한다 — 시한이 되면
// signal 을 abort 해 수집기가 남은 SOAP 왕복(ReadNextEvents…)을 멈출 수 있게 한다(store.collectWithDeadline ·
// v2.417 '세션을 실제로 끊는다' 규약). race 는 남긴다 — 신호를 아직 읽지 않는 수집기도 결과는 기다리지 않는다.
// v2.765(로그 수집 지연): 시한이 되면 신호만 끊고 **읽은 만큼은 받는다** — 수집기(collectVCenterEvents)가 abort 를 받으면 던지지 않고 그때까지
//   읽은 이벤트를 `ended:'aborted'` 로 돌려준다. 예전에는 race 가 바로 거부해 읽은 40,000건이 통째로 버려졌고(상한 50,000 × 200쪽 > 60초),
//   저장 시각이 영영 나아가지 않았다(실서버 OC2 13일 정체의 유력 원인). 하나도 못 읽었거나 수집기가 유예(DEADLINE_GRACE_MS) 안에 돌아오지 않으면 예전처럼 거부.
export const DEADLINE_GRACE_MS = 15_000;
export function vcLogWithDeadline(vc, run, ms = vcLogDeadlineMs(vc), { graceMs = DEADLINE_GRACE_MS } = {}) {
  const ac = new AbortController();
  const err = () => new Error(`수집 데드라인 초과(${Math.round(ms / 1000)}초)`);
  let timer = null; let grace = null;
  const p = run(ac.signal);
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      grace = setTimeout(() => reject(err()), graceMs);
      grace.unref?.();
    }, ms);
    timer.unref?.();
  });
  return Promise.race([
    p.then((r) => {
      if (!ac.signal.aborted) return r;
      // 부분 결과 — 폴러가 상한처럼 다룬다. 스트림(onBatch) 모드는 배열이 비어 있고 read(읽어서 이미 넘긴 총수)가 실린다.
      if (Array.isArray(r) && r.ended === 'aborted' && (r.length > 0 || Number(r.read) > 0)) return r;
      throw err();
    }),
    guard,
  ]).finally(() => { clearTimeout(timer); clearTimeout(grace); });
}

/**
 * @param {{manual?: boolean}} [opts] manual — 관리자 '지금 수집'. v2.590: 인증 실패로 멈춘 vCenter 는
 *   **주기 수집에서만** 건너뛴다(store 와 같은 정지 기록 — 같은 계정이다. 로그 폴러가 따로 로그인하면
 *   store 가 멈춰도 계정 잠금은 그대로다). 수동 실행은 막지 않는다(authGuard 규칙 3).
 */
export async function pollLogsOnce({ manual = false, budgetMs: budgetOverride = null, deadlineMs: deadlineOverride = null } = {}) {
  // v2.743(감사 WEB-04): 진행 중이면 **직전 결과(lastRun)를 돌려주지 않는다** — '지금 수집' 이 그 값을 이번 결과로 읽어
  //   '수집 완료: N건' 이라고 말했다(첫 실행 중이면 null 이라 0건). 이번 요청은 새로 수집하지 않았다는 사실을 busy 로 밝힌다.
  if (running) { _busySkips++; _busySkipAt = Date.now(); return { busy: true, runningSince }; }
  const s = loadLogSettings();
  // 꺼져 있으면 skipped:true(수집하지 않음) — '0건 수집' 과 다르다(화면이 구분한다).
  if (!s.enabled) { lastRun = { at: Date.now(), collected: 0, skipped: true }; return lastRun; }
  running = true;
  runningSince = Date.now();
  const failed = [];   // v2.743(WEB-04): 이번 주기에 인증 외 사유로 수집하지 못한 vCenter — 반환에만 싣는다(아래)
  try {
    const db = await getLogsDb();
    const mock = config.dataSource === 'mock';
    const minRank = SEV_RANK[s.minSeverity] || 0;
    // v2.732(점검 2회차 B4-01): live 대상은 **직접 수집 vCenter 만**이다 — 관리자가 끈(enabled:false)·점검중(maintenance)·엣지 위임
    //   (collectMode 'site') vCenter 는 로그인하지 않는다(store.js 주 폴러·vmseries·curuser 와 같은 판정 — vcenter/collectTarget.js 하나).
    //   예전에는 등록부 전량이라 그 셋에 10분마다 로그인했고(재현: 3주기 × 계정 3개 = 9회), 주 폴러가 그 셋을 수집하지 않으므로 인증 정지
    //   기록도 생기지 않아 비밀번호가 틀린 구간에 실패 로그인이 쌓였다. site 의 로그는 엣지가 보관하고 화면은 연합 조회로 본다
    //   (/tools/vclogs/sources 가 site 를 remote 로 분류한다). 수동 실행도 이 셋은 건너뛴다(store 의 '지금 수집' 과 같다).
    //   건너뛴 vCenter 는 lastRun.notCollected 로 밝힌다(조용한 제외 금지).
    const split = mock ? { targets: (store.get().vcenters || []).map((v) => ({ id: v.id, name: v.name })), skipped: [] } : splitDirectCollectTargets(loadVcenterConfig().vcenters || []);
    const vcs = split.targets;
    let collected = 0;
    const authStopped = [];   // v2.590: 이번 주기에 인증 실패 정지로 건너뛴 vCenter — 조용히 빼지 않고 밝힌다
    const authRejected = [];  // v2.732(B4-01): 이번 주기에 로그인이 거부된 vCenter — 주 폴러와 같은 정지 기록에 올렸다
    // v2.447(감사 T2): vCenter 를 **병렬 + per-vCenter 데드라인**으로 수집한다.
    // 예전에는 순차 await 라 vCenter 당 왕복 5회 이상(login→createCollector→readNext…→destroy→logout)이
    // 그대로 더해졌다 — 28곳 중 폴란드·미 동부처럼 RTT 800ms 를 넘는 곳이 섞이면 한 주기가 10초를
    // 훌쩍 넘고, 이벤트가 많아 readNext 가 여러 번 돌면 수십 초까지 늘어났다. '수집은 병렬 + per-vCenter
    // 타임아웃, 느린 1개가 전체를 막지 않게' 라는 CLAUDE.md 불변조건이 이 폴러에만 빠져 있었다.
    // DB 적재는 수집이 끝난 뒤 메인에서 한 번에 한다(동시 write 로 SQLITE_BUSY 를 만들지 않게).
    // v2.765(따라잡기 — 재검토 1-a·1-c): 적재는 **vCenter 워커 안에서 묶음(EVENT_BATCH_ROWS)마다**(그 vCenter 행만) 한다 — 수집기가 한 세션으로 계속 읽으며
    //   묶음을 넘기고(onBatch), 묶음을 적재한 뒤 커서를 갱신하고 양보한다. 같은 연결(단일 프로세스)의 동기 INSERT 라 SQLITE_BUSY 는 없고, 조각 사이 양보는
    //   insertManyAsync(logs/db.js tsSafeChunks)가 한다(B6-01 그대로). 메모리에 드는 것은 묶음 하나(2,000건)뿐이다(예전 회차 40,000건).
    const dbKey = logsDbKey(db);
    loadCursorFile({ dbKey });   // 기동 뒤 첫 수집 전에 한 번 — 재시작해도 읽은 커서·온전한 시각이 db.lastTs 로 되돌아가지 않는다(다른 DB 의 커서는 무시 — 3-b)
    syncCursorDbKey(dbKey);      // v2.766(R1-A2-01): 실행 중 DB 가 바뀌었으면(저장 경로 변경) 인메모리 커서를 비운다
    const everyMs = pollEveryMs(s.pollIntervalMin);
    const cycleStart = runningSince;
    const stalled = [];   // v2.756: 읽었는데 하나도 저장되지 않은 채 끝까지 못 읽은 vCenter(중복 키·심각도 필터) — 예전에는 여기서 영원히 멈췄다
    await poolRun(vcs, LOG_CONCURRENCY, async (vc) => {
      if (!mock && !manual && vcAuthGuard.authStopFor(vc)) { authStopped.push(vc.id); return; }
      const vcId = String(vc.id);
      const t0 = Date.now();
      // v2.765(1-b): 예산은 이 vCenter 의 시작 시각 기준(앞 순번이 다 쓴 뒤 시작해도 최소 예산). 데드라인 = 예산 + 기존 시한(수집기가 예산에서 스스로
      //   멈추므로 신호는 매달린 묶음·적재의 마지막 방어다). 테스트·진단용 주입(budgetMs)이 있으면 그것.
      const budget = mock ? null : (Number(budgetOverride) > 0 ? Math.floor(Number(budgetOverride)) : vcCatchupBudgetMs({ everyMs, cycleStart, now: t0 }));
      // v2.766(R1-A2-03): 데드라인도 테스트·진단용 주입(deadlineMs)이 있으면 그것(정리 지연이 데드라인을 넘는 경로를 몇 초 안에 재현).
      const deadlineMs = mock ? null : (Number(deadlineOverride) > 0 ? Math.floor(Number(deadlineOverride)) : budget + vcLogDeadlineMs(vc));
      const poll = { at: t0, read: 0, stored: 0, ms: null, rounds: 0, deadlineMs, budgetMs: budget, error: null, hint: null };
      const startedAt = t0;   // v2.731(A2-01): 이 수집이 온전하게 덮는 끝(끝까지 읽었으면)
      let cycleMaxRead = 0;   // 이번 주기에 읽은 마지막 이벤트 시각(묶음 누적)
      let finalDone = false;  // v2.766(R1-A2-03): 마지막 묶음(final)까지 적재·기록을 마쳤는가 — 그 뒤는 정리(Destroy·Logout)뿐이다
      // 묶음 하나 — 심각도 필터 → 전용 DB → 로그 DB(조각 양보) → 커서·온전한 시각 → 양보. 던지면 수집기가 멈추고 그때까지의 커서는 그대로다.
      const onBatch = async (events, { final, ended } = {}) => {
        const rows = events
          .filter((e) => (SEV_RANK[e.severity] || 0) >= minRank)
          .map((e) => ({ vcenterId: vc.id, key: eventRowKey(e), ts: e.ts, severity: e.severity, type: e.type, user: e.user, entity: e.entity, message: e.message, detail: e.detail ?? null }));
        let maxRead = 0;
        for (const e of events) { const t = Number(e?.ts); if (Number.isFinite(t) && t > maxRead) maxRead = t; }
        if (events.length || poll.rounds === 0) poll.rounds += 1;   // 묶음 수(마지막 빈 묶음은 세지 않는다 — 0건 주기만 1)
        poll.read += events.length;
        if (rows.length) {
          // v2.762(E2): 전용 DB 적재를 로그 DB 적재 **앞**에 — 로그 적재는 조각 사이에 양보하므로, 예전 순서(로그 → 전용)는 그 사이 종료
          //   (업그레이드 재시작·크래시)나 2번째 조각의 실패가 '로그 DB 에만 있는 스냅샷 행' 을 남겼고, 다음 수집은 lastTs 이후만 읽어 영영 채우지 못했다
          //   (덮음 기록은 그대로라 화면이 그 VM 을 빼고 '완전' 으로 보였다). 반대 순서는 안전하다 — 로그 적재가 실패하면 커서가 안 움직여
          //   다음 주기가 같은 행을 다시 읽고, 전용 DB 는 해시 UNIQUE(INSERT OR IGNORE)라 멱등이다.
          await ingestSnapRows(rows);   // 실패해도 로그 적재는 그대로(시간당 경고 1줄 · 실패하면 그 vCenter 덮음 무효 — C5/E1)
          // v2.766(점검 R1-A2-02): 저장 수는 **실제로 들어간 행 수**(INSERT OR IGNORE 가 버린 중복 제외)다 — 건넨 행 수로 세면 새 이벤트 0 인
          //   주기도 'N건 장기 보관' 이 되고, 중복만 읽은 상한 주기가 stalled(읽었는데 저장 0)로 잡히지 않았다. 적재 함수가 수를 주지 않으면(옛 판) 건넨 행 수.
          const res = typeof db.insertManyAsync === 'function' ? await db.insertManyAsync(rows) : db.insertMany(rows);
          const n = numOrNull(res != null && typeof res === 'object' ? res.inserted : res);
          const inserted = n != null && n >= 0 ? Math.min(Math.floor(n), rows.length) : rows.length;
          collected += inserted;
          poll.stored += inserted;
        }
        // 적재가 끝난 뒤에만 기록한다(적재가 던지면 이 묶음은 기록되지 않는다 — 온전하지 않다). v2.731(A2-01): 행이 0개여도 수집은 성공이다.
        if (maxRead > cycleMaxRead) cycleMaxRead = maxRead;
        const capped = !final || CAPPED_ENDED.includes(ended);   // 중간 묶음은 뒤가 남았다 · 마지막은 종료 사유로
        const at = capped ? (cycleMaxRead || null) : (Math.max(startedAt, cycleMaxRead) || null);
        if (at != null) { _collectOk.set(vcId, { at, capped, events: poll.read, ended: typeof ended === 'string' ? ended : null }); _cursorDirty = true; }
        if (maxRead > (_readCursor.get(vcId) || 0)) { _readCursor.set(vcId, maxRead); _cursorDirty = true; }
        if (final && capped && poll.read > 0 && poll.stored === 0) {
          stalled.push({ vcenterId: vcId, read: poll.read, stored: poll.stored });
          const t = Date.now();
          if (!_stallLog.has(vcId) || t - _stallLog.get(vcId) > 3_600_000) {
            _stallLog.set(vcId, t);
            console.warn(`[vclogs] ${vcId}: 이벤트 ${poll.read}건을 읽었는데 새로 저장된 것이 없습니다(중복 또는 심각도 필터) — 읽은 시각(${new Date(cycleMaxRead).toISOString()})부터 이어 읽습니다`);
          }
        }
        // 'aborted' 로 끝난 마지막 묶음은 아니다 — 시한이 읽기를 끊었다(하나도 못 읽었으면 예전처럼 실패 · 읽은 만큼은 vcLogWithDeadline 이 부분 결과로 돌려준다).
        if (final && ended !== 'aborted') finalDone = true;
        await new Promise((r) => setImmediate(r));   // 적재 뒤 양보 — 다른 vCenter 워커·요청이 끼어든다
      };
      try {
        const last = db.lastTs(vcId);
        // 첫 수집은 최근 7일. v2.710: 데모(mock)는 91일 — VM 가용성(7·30·90일 보기)이 합성 이벤트 7일치만으로
        //   전 VM 을 '수집 시작부터만 잼(일부 기간)' 으로 내던 공백. 이벤트 수도 기간에 비례(7일마다 25건).
        const firstDays = mock ? MOCK_FIRST_DAYS : 7;
        const sinceTs = nextSinceTs(last, _readCursor.get(vcId), { firstDays }); // v2.756: 읽은 커서까지 본다(포함 — 2-b)
        if (mock) {
          const events = synthEvents(vc.id, sinceTs, last ? 25 : 25 * Math.ceil(firstDays / 7));
          events.ended = 'empty';
          await onBatch(events, { final: true, ended: 'empty', batches: 1 });
        } else {
          try {
            await vcLogWithDeadline(vc, (signal) => collectVCenterEvents(vc, { sinceTs, signal, onBatch, batchSize: EVENT_BATCH_ROWS, budgetMs: budget }), deadlineMs);
          } catch (e) {
            // v2.766(점검 R1-A2-03): 마지막 묶음까지 적재·기록을 마친 뒤의 오류는 정리(DestroyCollector·Logout — 오류를 삼킨다)가 늦어
            //   데드라인을 넘긴 것뿐이다 — 읽고 저장한 것은 온전하다. 예전에는 이것을 수집 실패(failed·상태 '정체')로 기록했다.
            if (!finalDone) throw e;
            console.warn(`[vclogs] ${vc.id}: 이벤트는 끝까지 적재했지만 세션 정리(DestroyCollector·Logout)가 늦어 시한을 넘겼습니다 — 수집 실패로 치지 않습니다(${e?.message || e})`);
          }
        }
      } catch (e) {
        console.warn(`[vclogs] ${vc.id} 수집 실패: ${e.message}`);
        poll.error = capStr(String(e?.message || e || '알 수 없는 오류'), 300);
        // v2.765(2-c): 첫 묶음도 못 받고 시한(데드라인·건별 요청 시한)에 걸렸으면 — 13일치 beginTime 의 CreateCollector·첫 ReadNext 가 느린 vCenter 다.
        //   화면이 '요청 시한(vCenter 관리 › timeoutMs)을 올리세요' 로 안내한다(매 주기 0 진행을 조용히 반복하지 않게).
        if (poll.read === 0 && poll.rounds <= 1 && /데드라인|timeout|timed out|abort/i.test(poll.error)) poll.hint = 'timeout';
        // v2.732(B4-01): 로그인 거부(InvalidLogin 등)면 주 폴러와 **같은 정지 기록**에 올린다(v2.591 보조 수집기 규약 — 이 폴러만 빠져 있었다).
        //   다음 주기는 authStopFor 가 건너뛴다. 수동 실행의 거부도 올린다(시도 횟수가 정직해지게 — guestdisk 와 같다). mock 은 제외.
        if (!mock && isVcAuthError(e)) {
          const rec = vcAuthGuard.markAuthStopped(vc.id, vc, e.message);
          authRejected.push({ vcenterId: vcId, attempts: rec?.attempts ?? null });
        } else failed.push({ vcenterId: vcId, error: poll.error });
      }
      poll.ms = Date.now() - t0;
      _lastPoll.set(vcId, poll);
      // 연속 상한 주기 수 — 이번 주기가 끝까지 읽지 못한 채 끝났으면 +1, 끝까지 읽었으면 0(실패한 주기는 바꾸지 않는다).
      if (!poll.error) {
        if (_collectOk.get(vcId)?.capped) _capStreak.set(vcId, (_capStreak.get(vcId) || 0) + 1);
        else _capStreak.delete(vcId);
      }
    });
    // 주기마다 1회(적재 뒤). v2.765(3-c): 등록부에 없는 vCenter 의 커서는 지운다(mock 은 store 의 vCenter 가 등록부다).
    const knownIds = new Set((mock ? (store.get().vcenters || []) : (loadVcenterConfig().vcenters || [])).map((v) => String(v?.id ?? '')).filter(Boolean));
    saveCursorFile({ knownIds, dbKey });
    // v2.765(진단): 지연이 1일을 넘는 vCenter 는 lastRun 에 싣고 콘솔에 시간당 1줄(무음 실패 금지).
    const lagging = [];
    for (const vc of vcs) {
      const vcId = String(vc.id);
      const lagMs = logLagMs(vcId, db.lastTs(vcId));
      if (lagMs == null || lagMs <= DAY) continue;
      lagging.push({ vcenterId: vcId, lagMs });
      const t = Date.now();
      if (!_lagLog.has(vcId) || t - _lagLog.get(vcId) > 3_600_000) {
        _lagLog.set(vcId, t);
        const p = _lastPoll.get(vcId);
        console.warn(`[vclogs] ${vcId}: 수집이 ${(lagMs / DAY).toFixed(1)}일 뒤처짐(읽음 ${p?.read ?? '—'}/저장 ${p?.stored ?? '—'}) — ${lagStateText(vcId)}`);
      }
    }
    // prune/용량 점검은 매 폴이 아니라 N폴마다 1회(DELETE 스캔·크기 계산 비용 절감).
    // ⚠ v2.503: `tick++ % N === 0` 은 tick 초기값이 0 이라 **첫 폴에서 즉시 참**이었다 —
    // metrics/sampler.js 가 금지한 v2.453 패턴과 같다(보존기간을 365→90일로 줄이고 재시작하면
    // 기동 30초 뒤 첫 폴이 수백만 행 삭제 + VACUUM 을 동기로 돈다). 전위 증가로 바꾼다.
    if ((++tick % PRUNE_EVERY) === 0) {
      if (s.retentionDays > 0) {
        // v2.601(감사 DB2601-03): 한 방 DELETE(183만 행 4.8초 정지)가 아니라 청크 + 양보로 지우고, 보고 건수는 실제 전체다.
        //   상한(PRUNE_MAX_ROWS)에 걸리면 남은 분은 다음 prune 주기가 잇는다 — 그 사실을 로그에 적는다.
        const before = Date.now() - s.retentionDays * DAY;
        const r = typeof db.pruneAsync === 'function' ? await db.pruneAsync(before) : { deleted: db.prune(before), done: true };
        if (r.deleted) console.log(`[vclogs] 보관기간(${s.retentionDays}일) 초과 ${r.deleted}건 정리${r.done === false ? ' — 상한에 걸려 다음 주기에 계속' : ''}`);
      }
      // 용량 제한: DB 의 **사용 중 크기**가 maxSizeMB 를 넘으면 오래된 것부터 삭제.
      // ⚠⚠ v2.741(감사 DB-03 — 재현): 예전에는 파일 크기(sizeBytes, +wal)로 판정해 삭제만으로는 줄지 않았고, 그래서 상한에 닿을
      //   때마다 루프 밖에서 VACUUM(파일 전체 재작성, 동기)을 돌렸다 — 상한에 닿은 포탈은 prune 주기마다 수 초씩 멈췄다(합성 534MB 실측).
      //   이제 (page_count − freelist_count) × page_size 로 판정한다(db.usedBytes). 지운 페이지는 다음 INSERT 가 다시 쓰므로 파일은
      //   최고 수위 근처에 머물고 더 커지지 않는다 — VACUUM 이 필요 없다. 대가(정직 기록): 상한을 낮춰도 파일은 줄어들지 않는다
      //   (빈 공간은 freeBytes 로 화면이 말한다).
      if (s.maxSizeMB > 0) {
        const limit = s.maxSizeMB * 1024 * 1024;
        const usedOf = () => (typeof db.usedBytes === 'function' ? db.usedBytes() : db.sizeBytes());
        let size = usedOf(), guard = 0, dropped = 0, stuck = false;
        // ⚠ v2.503: 행 수는 **루프 밖에서 1회만** 센다. 예전에는 매 반복 `db.meta().count` 를 불렀는데
        // meta() 는 COUNT/MIN/MAX + `GROUP BY vcenterId` 로 **풀스캔 2회**다 — 상한 50회 × 2 = 최악
        // 100회 전체 스캔이 한 틱 안에서 동기로 돌았다(삭제 자체의 스캔은 별도). 삭제한 만큼 빼가며
        // 추정하면 되고, 카운트가 조금 낡아도 영향은 '이번 회차에 지우는 행 수' 뿐이다.
        // 행 수만 필요하므로 GROUP BY 가 없는 `rowCount()` 를 쓴다.
        let cnt = typeof db.rowCount === 'function' ? db.rowCount() : db.meta().count;
        while (size > limit && guard++ < 50) {
          if (cnt <= 0) break;
          // v2.601(DB2601-03): 한 단계(행 수의 10%)를 청크(pruneOldest 가 PRUNE_CHUNK_ROWS 로 묶는다)로 나눠 지우고
          //   청크마다 이벤트 루프에 양보한다 — 예전에는 10% 를 한 문장으로 최대 50회 연달아 동기로 지웠다.
          const want = Math.max(500, Math.floor(cnt * 0.1));
          let n = 0;
          while (n < want) {
            const k = db.pruneOldest(want - n);
            if (!k) break;
            n += k;
            await new Promise((res) => setImmediate(res));
          }
          if (!n) break;
          dropped += n; cnt -= n;
          // v2.741(DB-03): 사용 중 크기를 다시 잰다(헤더 필드 — 즉시). 지웠는데 줄지 않았으면 더 지워도 같다 — 조용히 전부 지우지 않고
          //   멈춘 뒤 사유를 남긴다(다음 prune 주기가 다시 본다).
          const next = usedOf();
          if (!(next < size)) { stuck = true; break; }
          size = next;
        }
        if (dropped) console.log(`[vclogs] 용량 제한(${s.maxSizeMB}MB) 초과 → 오래된 ${dropped}건 정리(사용 중 ${(size / 1048576).toFixed(0)}MB — 지운 자리는 새 로그가 다시 씁니다)`);
        if (stuck) console.warn(`[vclogs] 용량 제한(${s.maxSizeMB}MB): 오래된 로그를 지웠지만 사용 중 크기가 줄지 않았습니다 — 이번 주기는 여기서 멈춥니다(다음 정리 주기에 다시 봅니다)`);
        lastCap = { at: Date.now(), limitBytes: limit, usedBytes: size, dropped, stuck };
      }
    }
    lastRun = { at: Date.now(), collected, ...(authStopped.length ? { authStopped } : {}), ...(authRejected.length ? { authRejected } : {}), ...(stalled.length ? { stalled } : {}),
      ...(lagging.length ? { lagging } : {}), ...(split.skipped.length ? { notCollected: split.skipped } : {}) };
    if (collected) console.log(`[vclogs] ${collected}건 장기 보관`);
    // v2.743(WEB-04): 수집 실패한 vCenter 는 **반환에만** 싣는다 — '지금 수집'(관리자 + 전체 범위)이 '전부 실패해도 수집 완료 0건' 이라
    //   말하지 않게. 상태(lastRun)에는 싣지 않는다 — /vclogs/status 는 범위 계정도 읽고, 오류 원문에 vCenter 주소가 들어간다
    //   (scopeVcLogStatus 가 모르는 필드를 거르지 않는다). 상한 50곳, 넘으면 개수를 밝힌다.
    if (!failed.length) return lastRun;
    return { ...lastRun, failed: failed.slice(0, 50), ...(failed.length > 50 ? { failedOmitted: failed.length - 50 } : {}) };
  } finally { running = false; runningSince = null; }
}

function schedule() {
  if (timer) { clearInterval(timer); timer = null; }
  const s = loadLogSettings();
  if (!s.enabled) return;
  // v2.603(감사 TIM2603-01) 2차 방어 — 설정 로드가 이미 1~1440분으로 자르지만, 캐시가 다른 경로로 바뀌어도 0·NaN·음수·2^31 초과가
  // setInterval 에 가서 1ms 루프가 되지 않게 여기서도 [1분, 1일] 로 묶는다(숫자 아님은 기본 10분).
  const everyMs = Math.min(86_400_000, clampIntervalMs(Number(s.pollIntervalMin) * 60_000, 600_000, 60_000));
  timer = setInterval(() => pollLogsOnce().catch((e) => console.warn(`[vclogs] poll 오류: ${e.message}`)), everyMs);
  timer.unref?.();
}

export function startLogPoller() {
  schedule();
  setTimeout(() => pollLogsOnce().catch(() => {}), 30_000).unref?.();
  console.log('[vclogs] vCenter 로그 보관 폴러 시작');
}

export function rescheduleLogPoller() { schedule(); }

export async function logStatus() {
  const db = await getLogsDb();
  // v2.741(DB-03): 파일 크기와 함께 사용 중 크기·빈 공간을 싣는다 — 용량 상한은 사용 중 크기로 판정하고 파일은 줄어들지 않는다.
  const used = typeof db.usedBytes === 'function' ? db.usedBytes() : null;
  const free = typeof db.freeBytes === 'function' ? db.freeBytes() : null;
  // v2.744(감사 DB-03): 건수 집계는 vCenter 사이에 양보하는 metaAsync(설정 화면이 30초마다 부른다 — 캐시가 지날 때의 동기 정지 제거).
  const meta = typeof db.metaAsync === 'function' ? await db.metaAsync() : db.meta();
  const settings = loadLogSettings();
  // v2.765: vCenter 별 수집 진단(collect) · 실효 상한(설정값과 수집기 한도 중 작은 것) · 따라잡기 예산 — 화면이 숫자를 박지 않고 이 값을 쓴다.
  return { settings, lastRun, store: meta, dbKind: db.kind, dbPath: db.path, dbSizeBytes: db.sizeBytes(),
    dbUsedBytes: Number.isFinite(used) ? used : null, dbFreeBytes: Number.isFinite(free) ? free : null, ...(lastCap ? { lastCap } : {}),
    collect: logCollectDiag(meta?.vcenters), maxPerPollEffective: effectiveMaxPerPoll(settings), collectorMaxEvents: COLLECTOR_MAX_EVENTS,
    // v2.765(재검토): 따라잡기는 회차가 아니라 한 세션의 묶음(batchRows)·시간 예산 — 화면 안내가 이 값을 쓴다. busySkips 는 진행 중이라 건너뛴 틱.
    catchup: { budgetMs: catchupBudgetMs(settings.pollIntervalMin), ratio: CATCHUP_BUDGET_RATIO, batchRows: EVENT_BATCH_ROWS, minBudgetMs: CATCHUP_MIN_BUDGET_MS, streaming: true },
    busySkips: _busySkips, busySkipAt: _busySkipAt };
}
