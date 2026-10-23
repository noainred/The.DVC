/**
 * veeam/snapCollector.js — Veeam 계정 이벤트 **전용 경량 수집기**(v2.764 — 실서버 OC2 의 일반 로그 수집이 13일 뒤처져 VM 화면의
 *   'Veeam 백업 시도' 가 10-10 에 멈춘 것처럼 보였다).
 *
 * 왜: 카드 백업 수량·VM 화면의 백업 시도는 로그 폴러(logs/poller.js)가 적재한 **전체 이벤트** 중 스냅샷 행에 기댄다. 그 폴러가
 *   밀리면(상한·데드라인·재시작) Veeam 흔적도 함께 멈춘다. Veeam 계정의 이벤트는 전체의 극히 일부라, EventFilterSpecByUsername 으로
 *   **그 계정만** 따로 읽으면 쪽 몇 장으로 끝난다 — 전용 DB(snapDb)에 넣고(해시 멱등 — 일반 폴러와 겹쳐도 한 번) 완결 시각을 따로 기록한다.
 *   화면의 collectedAt 은 `snapEventsOkAt` 하나 = max(로그 폴러 ok 시각, 이 수집기 ok 시각). 이 수집기가 한 번도 완결하지 못한 vCenter 는 로그 폴러 값 그대로.
 *
 * 규약(루트·server CLAUDE.md · docs/rules/perf-db.md):
 *  · 대상은 직접 수집 vCenter 만(splitDirectCollectTargets) · 인증 실패 정지(vcAuthGuard.authStopFor)는 건너뛴다(수동 실행 없음 — 자동 재시도 금지).
 *  · 로그 수집 설정이 꺼져 있거나(enabled false) 최소 심각도가 info 가 아니면 돌지 않는다(화면이 log-off·severity-filter 를 말한다) · 데모(mock)도 돌지 않는다.
 *  · 계정은 snapEvents.veeamAccounts()(사람이 적은 것 + 중앙에서 받은 것 + 학습). 0개면 그 vCenter 는 'no-account' 로 건너뛴다(일반 폴러·인벤토리 학습이 채운다).
 *    학습 계정은 이벤트 userName 원문이라 그대로 맞고, 사람이 적은 계정은 'DOMAIN\\user'·'user@domain' 변형을 함께 싣는다(userListFor —
 *    도메인 없이 적은 계정은 다른 계정에서 본 도메인으로 변형을 만든다. 어느 변형도 맞지 않으면 이 수집기는 그 계정을 읽지 못한다 —
 *    일반 폴러가 읽은 행은 그대로 쓰인다). 종류(eventTypeId)는 좁히지 않는다 — TaskEvent·VmSnapshot* 모두 받아 snapDb.isSnapRow 로 거른다.
 *  · 커서 snap_meta 'cur:<vc>' = 마지막으로 읽은 이벤트 시각(저장 여부와 무관 — 중복·필터로 저장 0 이어도 나아간다). 없으면 now − LOOKBACK(8일).
 *  · 호출 상한(PER_CALL_MAX)에 걸리면 같은 주기 안에서 커서 다음부터 이어 읽는다(예산 안) · per-vCenter 시한은 로그 폴러와 같은 vcLogWithDeadline(신호로 실제로 끊는다) ·
 *    동시성 6(poolRun) · 재진입 가드 + 주기 상한(끝나지 않는 주기가 가드를 영원히 붙잡지 않게).
 *  · 완결 시각: 끝까지 읽었으면(ended 'empty') okAt = 수집 시작 시각(eventsCompleteUntil 과 같은 규칙), 상한·쪽 수·데드라인에 걸렸으면 마지막으로 읽은 시각.
 *    메모리 + snap_meta 'ok:<vc>' 영속(재시작 뒤 복원).
 *  · 상태 veeamSnapCollectorStatus() 는 요약만(주소·오류 원문 없음) · 콘솔은 실패 vCenter 당 1시간 1줄 · 성공 요약 1줄.
 *  · 주기는 로그 설정 pollIntervalMin 과 같다 — startAdaptiveTimer 가 매 틱 다시 읽는다(모듈 로드 시 굳히지 않음. 설정 변경 즉시 재무장 알림은
 *    logs/settings.js 에 변경 리스너가 없어 다음 틱부터다 — 로그 폴러 자신은 저장 라우트가 rescheduleLogPoller 를 부른다).
 */
import { config, loadVcenterConfig, clampIntervalMs } from '../config.js';
import { poolRun } from '../util/pool.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { capStr } from '../util/capStr.js';
import { collectVCenterEvents } from '../vcenter/soapClient.js';
import { vcAuthGuard, isVcAuthError } from '../vcenter/restClient.js';
import { splitDirectCollectTargets } from '../vcenter/collectTarget.js';
import { loadLogSettings } from '../logs/settings.js';
import { vcLogWithDeadline, vcLogDeadlineMs, DEADLINE_GRACE_MS, logCollectOkAt } from '../logs/poller.js';
import { veeamAccounts } from './snapEvents.js';
import { getSnapDb, ingestSnapRows, isSnapRow } from './snapDb.js';

const DAY = 86_400_000;
export const LOOKBACK_MS = 8 * DAY;       // 첫 수집 창 — 화면 7일 + 공용 계정 짝짓기 12시간(snapDb BACKFILL_FIRST_MS 와 같다)
export const PER_CALL_MAX = 5_000;        // 한 호출(CreateCollector 1회)에 읽는 상한 — 25쪽
const PAGE_SIZE = 200;
const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.VEEAM_SNAP_CONCURRENCY) || 6));
const FIRST_DELAY_MS = 60_000;
const MAX_USER_LIST = 50;                 // soapClient.eventFilterXml 의 상한과 같다
const BUDGET_MAX_MS = 5 * 60_000;

let _timer = null;
let _running = null;      // { since, promise }
let _last = null;         // 마지막 주기 요약(스킵 사유 포함)
const _okAt = new Map();  // vcenterId → 이 수집기의 완결 시각(메모리 — snap_meta 'ok:<vc>' 와 같다)
const _perVc = new Map(); // vcenterId → { state, okAt, cursor, read, stored, calls, capped, kind, at }
const failLog = createChangeLogger({ windowMs: 3_600_000 });

/** 주기(ms) — 로그 설정 pollIntervalMin 과 같다(logs/poller.js schedule 과 같은 [1분, 1일] 클램프). 매 틱 다시 읽는다. */
export function intervalMs() {
  const s = loadLogSettings();
  return Math.min(86_400_000, clampIntervalMs(Number(s.pollIntervalMin) * 60_000, 600_000, 60_000));
}

/**
 * 계정 목록 → EventFilterSpecByUsername userList(순수). 원문을 먼저 전부 싣고, 남은 자리에 표기 변형을 더한다(상한 50 — 원문이 우선).
 *  · 'DOMAIN\\user' → 'user@domain'(소문자)·'user@DOMAIN' · 'user@domain' → 'DOMAIN\\user'(대문자)·'domain\\user' ·
 *  · 도메인 없는 계정 → 다른 계정에서 본 도메인마다 'DOMAIN\\user'·'user@domain'. 대소문자만 다른 중복은 한 번.
 */
export function userListFor(accounts) {
  const out = []; const seen = new Set();
  const add = (u) => {
    const s = String(u ?? '').trim().slice(0, 200);
    if (!s) return;
    const k = s.toLowerCase();
    if (seen.has(k) || out.length >= MAX_USER_LIST) return;
    seen.add(k); out.push(s);
  };
  const list = (Array.isArray(accounts) ? accounts : []).map((a) => String(a ?? '').trim()).filter(Boolean);
  const domains = new Set();
  for (const a of list) {
    const i = a.lastIndexOf('\\');
    if (i > 0) domains.add(a.slice(0, i).toLowerCase());
    else if (a.includes('@')) domains.add(a.slice(a.indexOf('@') + 1).toLowerCase());
  }
  for (const a of list) add(a);
  for (const a of list) {
    const i = a.lastIndexOf('\\');
    if (i > 0) { const d = a.slice(0, i); const n = a.slice(i + 1); if (n) { add(`${n}@${d.toLowerCase()}`); add(`${n}@${d}`); } continue; }
    const j = a.indexOf('@');
    if (j > 0) { const n = a.slice(0, j); const d = a.slice(j + 1); if (n && d) { add(`${d.toUpperCase()}\\${n}`); add(`${d}\\${n}`); } continue; }
    for (const d of domains) { add(`${d.toUpperCase()}\\${a}`); add(`${a}@${d}`); }
  }
  return out;
}

/** 두 완결 시각의 결합(순수) — 둘 중 늦은 것, 하나만 있으면 그것, 둘 다 없으면 null(0 이 아니다). */
export function combineOkAt(logOkAt, snapOkAt) {
  const a = Number.isFinite(logOkAt) && logOkAt > 0 ? logOkAt : null;
  const b = Number.isFinite(snapOkAt) && snapOkAt > 0 ? snapOkAt : null;
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}
/** 이 수집기의 완결 시각(ms) 또는 null(기록 없음). */
export function snapCollectorOkAt(vcenterId) { return _okAt.get(String(vcenterId ?? '')) ?? null; }
/**
 * 화면·push 가 쓰는 '이벤트가 온전한 마지막 시각' — 로그 폴러(logCollectOkAt)와 이 수집기 중 늦은 것. 두 소비처(routes/api/veeam.js ·
 *   veeam/push.js)는 이 함수만 쓴다. dedicated:false = 그 요약이 전용 DB 를 읽지 않았다(백필 전 로그 DB 경로) — 이 수집기가 넣은 행이 그 요약에
 *   없으므로 이 수집기의 시각을 섞지 않는다.
 */
export function snapEventsOkAt(vcenterId, { dedicated = true } = {}) {
  return combineOkAt(logCollectOkAt(vcenterId), dedicated ? snapCollectorOkAt(vcenterId) : null);
}

/** 완결 시각(순수) — 끝까지 읽었으면 수집 시작 시각(vCenter 시계가 앞서 그보다 늦은 이벤트가 있으면 그 시각), 아니면 마지막으로 읽은 시각. */
export function completeUntil({ complete, startedAt, maxRead }) {
  if (complete) return Math.max(Number(startedAt) || 0, Number(maxRead) || 0) || null;
  return Number(maxRead) > 0 ? Number(maxRead) : null;
}

const skipReason = (s) => {
  if (String(config.dataSource || '').toLowerCase() === 'mock') return 'mock';
  if (s?.enabled === false) return 'log-off';
  if (s?.minSeverity && s.minSeverity !== 'info') return 'severity-filter';
  return null;
};
const setPer = (id, v) => _perVc.set(id, { ...(_perVc.get(id) || {}), ...v, at: Date.now() });

/** vCenter 1곳 — 커서부터 이어 읽어 전용 DB 에 넣고 커서·완결 시각을 기록한다. 던지면 호출부가 실패로 센다(커서·okAt 은 읽은 만큼만 바뀐다). */
async function collectOne(vc, db, { now, userNames, perCallMax, budgetMs }) {
  const id = String(vc.id);
  const startedAt = now;
  const t0 = Date.now();
  let cursor = db.snapCursor(id);
  let since = Math.max((cursor || 0) + 1, now - LOOKBACK_MS);
  let read = 0; let stored = 0; let calls = 0; let maxRead = 0; let ended = 'empty';
  for (;;) {
    calls++;
    const events = await vcLogWithDeadline(vc, (signal) => collectVCenterEvents(vc, { sinceTs: since, max: perCallMax, pageSize: PAGE_SIZE, signal, userNames }));
    ended = events.ended || (events.length >= perCallMax ? 'max' : 'empty');
    read += events.length;
    let mx = 0;
    for (const e of events) { const t = Number(e?.ts); if (Number.isFinite(t) && t > mx) mx = t; }
    if (events.length) {
      const rows = events.map((e) => ({ vcenterId: id, ts: e.ts, severity: e.severity, type: e.type, user: e.user, entity: e.entity, message: e.message })).filter(isSnapRow);
      if (rows.length) {
        // ingestSnapRows 는 실패를 0 으로 돌려준다(덮음 무효까지 하므로 그대로 쓴다) — 넣으려 한 수와 다르면 실패다. 커서는 넣은 뒤에만 나아간다.
        const n = await ingestSnapRows(rows);
        if (n !== rows.length) throw new Error('전용 DB 적재 실패');
        stored += n;
      }
    }
    if (mx > (cursor || 0)) { cursor = mx; db.setSnapCursor(id, cursor); }
    if (mx > maxRead) maxRead = mx;
    if (ended === 'empty' || ended === 'aborted') break;       // 끝 · 데드라인(느린 vCenter — 이번 주기는 여기까지)
    if (!(mx > 0) || Date.now() - t0 >= budgetMs) break;        // 예산 — 다음 주기가 커서부터 잇는다
    since = cursor + 1;
  }
  const complete = ended === 'empty';
  const okAt = completeUntil({ complete, startedAt, maxRead });
  if (okAt != null && okAt > (_okAt.get(id) || 0)) { _okAt.set(id, okAt); db.setSnapOkAt(id, okAt); }
  return { okAt: _okAt.get(id) ?? null, cursor, read, stored, calls, capped: !complete, ended };
}

/**
 * 한 주기. 진행 중이면 busy. 테스트용 주입: now(수집 시작 시각으로 기록) · perCallMax · budgetMs.
 * @returns {Promise<object>} { at, ok, fail, noAccount, targets, read, stored, authStopped? } 또는 { skipped } / { busy }
 */
export async function pollVeeamSnapOnce({ now = Date.now(), perCallMax = PER_CALL_MAX, budgetMs = null } = {}) {
  if (_running) return { busy: true, since: _running.since };
  const s = loadLogSettings();
  const skip = skipReason(s);
  if (skip) { _last = { at: now, skipped: skip }; return _last; }
  const budget = budgetMs ?? Math.min(Math.floor(intervalMs() / 2), BUDGET_MAX_MS);
  const split = splitDirectCollectTargets(loadVcenterConfig().vcenters || []);
  const targets = split.targets;
  const run = async () => {
    const db = await getSnapDb();
    if (!db) { _last = { at: now, skipped: 'no-db', targets: targets.length }; return _last; }   // 전용 DB 가 없으면 넣을 곳이 없다(화면은 로그 DB 경로)
    const accounts = veeamAccounts(now);
    const userNames = userListFor(accounts);
    let ok = 0; let fail = 0; let noAccount = 0; let read = 0; let stored = 0;
    const authStopped = [];
    await poolRun(targets, CONCURRENCY, async (vc) => {
      const id = String(vc.id);
      if (!_okAt.has(id)) { const p = db.snapOkAt(id); if (p) _okAt.set(id, p); }   // 재시작 뒤 영속값 복원
      if (vcAuthGuard.authStopFor(vc)) { authStopped.push(id); setPer(id, { state: 'auth-stopped' }); return; }
      if (!userNames.length) { noAccount++; setPer(id, { state: 'no-account', okAt: _okAt.get(id) ?? null }); return; }
      try {
        const r = await collectOne(vc, db, { now, userNames, perCallMax, budgetMs: budget });
        ok++; read += r.read; stored += r.stored;
        setPer(id, { state: 'ok', ...r, kind: null });
      } catch (e) {
        fail++;
        const msg = String(e?.message || e || '알 수 없는 오류');
        const kind = isVcAuthError(e) ? 'auth' : /데드라인/.test(msg) ? 'deadline' : 'error';
        // 로그인 거부는 주 폴러와 같은 정지 기록에 올린다(v2.732 보조 수집기 규약) — 다음 주기는 authStopFor 가 건너뛴다.
        if (kind === 'auth') vcAuthGuard.markAuthStopped(id, vc, msg);
        setPer(id, { state: 'fail', kind, okAt: _okAt.get(id) ?? null });
        if (failLog(id, kind)) console.warn(`[veeam-snap-collector] ${id} Veeam 계정 이벤트 수집 실패(${kind}): ${capStr(msg, 200)}`);
      }
    });
    _last = { at: now, ok, fail, noAccount, targets: targets.length, read, stored, accounts: accounts.length, ...(authStopped.length ? { authStopped } : {}),
      ...(split.skipped.length ? { notCollected: split.skipped.length } : {}) };
    if (read || fail) console.log(`[veeam-snap-collector] vCenter ${ok}곳 Veeam 계정 이벤트 ${read}건 읽음 · 스냅샷 행 ${stored}건${fail ? ` · 실패 ${fail}곳` : ''}${noAccount ? ` · 계정 모름 ${noAccount}곳` : ''}`);
    return _last;
  };
  // 주기 상한 — vCenter 1곳의 최악(예산 + 호출 시한 + 유예) × 묶음 수 + 여유. 넘기면 가드를 풀어 다음 주기가 돈다.
  const perVcMax = budget + Math.max(60_000, ...targets.map((vc) => vcLogDeadlineMs(vc))) + DEADLINE_GRACE_MS;
  const capMs = perVcMax * Math.ceil(Math.max(1, targets.length) / CONCURRENCY) + 60_000;
  const since = Date.now();
  let capTimer = null;
  const p = Promise.race([run(), new Promise((resolve) => { capTimer = setTimeout(() => resolve({ timedOut: true, since }), capMs); capTimer.unref?.(); })])
    .finally(() => { clearTimeout(capTimer); if (_running?.since === since) _running = null; });
  _running = { since, promise: p };
  return p;
}

/** 재시작 뒤 — 영속된 완결 시각을 메모리로(직접 수집 대상만). 실패해도 다음 주기가 vCenter 마다 복원한다. */
async function restoreOkAt() {
  const db = await getSnapDb();
  if (!db) return 0;
  let n = 0;
  for (const vc of splitDirectCollectTargets(loadVcenterConfig().vcenters || []).targets) {
    const id = String(vc.id);
    if (_okAt.has(id)) continue;
    const p = db.snapOkAt(id);
    if (p) { _okAt.set(id, p); n++; }
  }
  return n;
}

export function startVeeamSnapCollector() {
  if (_timer) return;
  restoreOkAt().catch(() => {});
  _timer = startAdaptiveTimer(intervalMs, () => pollVeeamSnapOnce(), { firstDelayMs: FIRST_DELAY_MS, name: 'Veeam 계정 이벤트 전용 수집' });
  console.log('[veeam-snap-collector] Veeam 계정 이벤트 전용 수집기 시작(주기 = vCenter 로그 수집 주기)');
}

/** 상태(요약만 — vCenter 주소·오류 원문 없음). edgelog/spec.js collect.veeamSnap · health/services.js 가 읽는다. */
export function veeamSnapCollectorStatus() {
  const s = loadLogSettings();
  const perVc = {};
  for (const [k, v] of _perVc) perVc[k] = { ...v };
  return { ...(_last || {}), enabled: skipReason(s) == null, intervalMs: intervalMs(), running: !!_running, ...(_running ? { runningSince: _running.since } : {}), perVc };
}

export function _resetForTest() { _running = null; _last = null; _okAt.clear(); _perVc.clear(); }
export function _setOkAtForTest(vcenterId, ts) { _okAt.set(String(vcenterId), ts); }
