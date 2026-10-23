/**
 * veeam/snapCollector.js — Veeam 계정 이벤트 **전용 경량 수집기**(v2.765 — 실서버 OC2 의 일반 로그 수집이 13일 뒤처져 VM 화면의
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
 *    v2.765(2-b): 이어 읽기·다음 주기의 since 는 **커서 그 시각(포함)** — `cursor + 1` 은 같은 ms 에 상한 경계가 걸리면 그 ms 의 나머지를
 *    영영 건너뛰었다(재검토 재현). 같은 ms 를 다시 읽는 몇 건은 전용 DB 해시 UNIQUE 가 거른다. 같은 ms 에 상한만큼 몰려 진행이 0 이면
 *    (상한에 걸렸는데 maxRead == cursor) 그 회차에서 멈추고 상태 stalled 로 밝힌다(무한 반복 금지).
 *  · 호출 상한(PER_CALL_MAX)에 걸리면 같은 주기 안에서 커서부터 이어 읽는다(예산 안) · per-vCenter 시한은 로그 폴러와 같은 vcLogWithDeadline(신호로 실제로 끊는다) ·
 *    동시성 6(poolRun) · 재진입 가드 + 주기 상한(끝나지 않는 주기가 가드를 영원히 붙잡지 않게).
 *  · 완결 시각: 끝까지 읽었으면(ended 'empty') okAt = 수집 시작 시각(eventsCompleteUntil 과 같은 규칙), 상한·쪽 수·데드라인에 걸렸으면 마지막으로 읽은 시각.
 *    메모리 + snap_meta 'ok:<vc>' 영속(재시작 뒤 복원).
 *    v2.765(4-a): okAt 은 이 수집기가 그 vCenter 에서 **계정 필터로 이벤트를 1건 이상 읽은 뒤**(snap_meta 'seen:<vc>')부터만 기록·영속한다 —
 *    사람이 적은 계정 표기(예: 'svc-veeam')가 vCenter 의 userName('CORP\\svc-veeam')과 어느 변형도 맞지 않으면 0건으로 '완결' 되는데, 그것을
 *    '지금까지 온전' 으로 믿으면 로그 폴러가 13일 뒤처진 vCenter 의 판정이 stale-events 에서 ok 로 뒤집혔다(재검토 재현). 0건 완결은 '모름' —
 *    snapEventsOkAt 결합이 로그 폴러 값으로 폴백한다. 상태 perVc.<id>.seen=false + reason 'unseen'(계정 표기가 vCenter 와 다를 수 있음).
 *    v2.766(점검 R1-A1-1·A5-1): 위 seen 은 vCenter 단위 하나라 ⓐ userList 의 **공용 계정**(administrator 등 — 사람이 '생성 후 제거 짝' 으로 적는다)
 *    이벤트만 읽혀도 서고 ⓑ 계정 목록이 바뀌어도 커서가 되돌아가지 않아 새 계정의 지난 7일을 영영 읽지 않는데 okAt 은 최신이었다(둘 다 재현 —
 *    로그 폴러가 13일 뒤처진 vCenter 의 판정이 ok 로 뒤집혔다). 이제
 *     ① userList(상한 50·정규형·정렬)의 지문을 snap_meta 'fp:<vc>' 에 둔다. 지문이 바뀌면 커서·okAt·seen 을 한 트랜잭션으로 지우고(커서 → now − LOOKBACK)
 *        새 지문으로 **끝까지 읽은(ended 'empty') 회차가 한 번 있은 뒤에만** okAt 을 기록한다. snapCollectorOkAt 은 지금 계정 목록의 지문이 그 okAt 의
 *        지문과 같을 때만 값을 낸다(목록이 바뀐 직후 수집기가 돌기 전에도 폴백). 원문 계정이 상한 50 을 넘어 userList 에서 빠지면 okAt 을 기록·사용하지 않는다.
 *        (업그레이드 직후 옛 기록에는 지문이 없어 vCenter 마다 한 번 8일을 다시 읽는다 — 계정 이벤트만이라 쪽 몇 장.)
 *     ② seen 은 공용 계정(isSharedAccount)이 아닌 계정의 이벤트를 읽었을 때만 선다.
 *     ③ snapEventsOkAt(…, { summary }) — 요약에서 판정이 Veeam 으로 본 계정(이름 규칙 'veeam' 포함)이 이 수집기의 userList 로 다 덮이지 않으면 섞지 않는다.
 *  · 상태 veeamSnapCollectorStatus() 는 요약만(주소·오류 원문 없음) · 콘솔은 실패 vCenter 당 1시간 1줄 · 성공 요약 1줄.
 *  · 주기는 로그 설정 pollIntervalMin 과 같다 — startAdaptiveTimer 가 매 틱 다시 읽는다(모듈 로드 시 굳히지 않음). v2.765(4-f): 로그 설정 저장 라우트가
 *    rescheduleLogPoller 와 함께 rescheduleVeeamSnapCollector() 를 불러 이미 무장된 타이머를 즉시 재무장한다(logs/settings.js 에는 변경 리스너가 없다).
 */
import crypto from 'node:crypto';
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
import { veeamAccounts, isSharedAccount, canonAccount } from './snapEvents.js';
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
const _okAt = new Map();  // vcenterId → 이 수집기의 완결 시각(메모리 — snap_meta 'ok:<vc>' 와 같다 · seen 인 vCenter 만)
const _seen = new Map();  // v2.765(4-a): vcenterId → 계정 필터로 이벤트를 처음 읽은 시각(snap_meta 'seen:<vc>')
const _fp = new Map();    // v2.766(점검 R1-A1-1·A5-1): vcenterId → 그 vCenter 의 커서·okAt 을 만든 userList 지문(snap_meta 'fp:<vc>')
let _covMemo = { key: null, cov: null };   // 지금 계정 목록의 덮음(같은 목록이면 다시 계산하지 않는다)
const _perVc = new Map(); // vcenterId → { state, okAt, cursor, read, stored, calls, capped, kind, seen, reason, stalled, at }
const failLog = createChangeLogger({ windowMs: 3_600_000 });
const _rearm = new Set(); // v2.765(4-f): startAdaptiveTimer 재무장 알림 구독자

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

/**
 * v2.766(점검 R1-A1-1·A5-1): 계정 목록 → { userNames, covered(정규형 집합), fp(지문), full(원문 계정이 전부 userList 에 들었나), missing }(순수).
 *   지문은 userList 의 정규형(소문자·'DOMAIN\\user' → 'user@domain')을 정렬해 만든다 — 순서·표기 변형만 다른 목록은 같은 지문.
 */
export function userListCoverage(accounts) {
  const userNames = userListFor(accounts);
  const covered = new Set(userNames.map((u) => canonAccount(u)).filter(Boolean));
  const lower = new Set(userNames.map((u) => u.toLowerCase()));
  const originals = new Set((Array.isArray(accounts) ? accounts : []).map((a) => String(a ?? '').trim().slice(0, 200).toLowerCase()).filter(Boolean));
  let missing = 0;
  for (const a of originals) if (!lower.has(a)) missing++;
  const fp = crypto.createHash('sha256').update([...covered].sort().join('\n')).digest('hex').slice(0, 32);
  return { userNames, covered, fp, full: missing === 0, missing };
}
function currentCoverage(now = Date.now()) {
  let accounts;
  try { accounts = veeamAccounts(now); } catch { return null; }
  const key = accounts.join('\n');
  if (_covMemo.key !== key) _covMemo = { key, cov: userListCoverage(accounts) };
  return _covMemo.cov;
}
/**
 * v2.766(점검 R1-A1-1 ③): 요약(localSnapSummary)에서 판정이 Veeam 으로 본 계정이 이 수집기의 지금 userList 로 전부 덮이는가.
 *   summary 를 주지 않으면 검사하지 않는다(순수 결합 시험용). 상한을 넘어 다 세지 못한 요약은 '모름' — 덮지 않는 것으로 본다.
 */
export function snapCollectorCovers(summary) {
  if (summary === undefined) return true;
  if (!summary || summary.veeamUsersOverflow === true) return false;
  const cov = currentCoverage();
  if (!cov) return false;
  const users = Array.isArray(summary.veeamUsers) ? summary.veeamUsers : [];
  return users.every((u) => cov.covered.has(canonAccount(u)));
}

/** 두 완결 시각의 결합(순수) — 둘 중 늦은 것, 하나만 있으면 그것, 둘 다 없으면 null(0 이 아니다). */
export function combineOkAt(logOkAt, snapOkAt) {
  const a = Number.isFinite(logOkAt) && logOkAt > 0 ? logOkAt : null;
  const b = Number.isFinite(snapOkAt) && snapOkAt > 0 ? snapOkAt : null;
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}
/**
 * 이 수집기의 완결 시각(ms) 또는 null(기록 없음 · 아직 이벤트를 읽어 본 적 없는 vCenter — 4-a).
 * v2.766(점검 R1-A1-1·A5-1): 지금 계정 목록의 지문이 그 okAt 을 만든 지문과 다르거나(목록이 바뀌었는데 아직 다시 읽지 않았다) 원문 계정이 userList 상한에서
 *   빠졌으면 null — 로그 폴러 값으로 폴백한다.
 */
export function snapCollectorOkAt(vcenterId) {
  const id = String(vcenterId ?? '');
  if (!_seen.has(id)) return null;
  const ok = _okAt.get(id);
  if (ok == null) return null;
  const cov = currentCoverage();
  if (!cov || !cov.full || !cov.userNames.length || _fp.get(id) !== cov.fp) return null;
  return ok;
}
/** v2.765(4-a): 이 수집기가 그 vCenter 에서 계정 필터로 이벤트를 읽은 적이 있는가(메모리 — snap_meta 'seen:<vc>'). */
export function snapCollectorSeen(vcenterId) { return _seen.has(String(vcenterId ?? '')); }
/**
 * 화면·push 가 쓰는 '이벤트가 온전한 마지막 시각' — 로그 폴러(logCollectOkAt)와 이 수집기 중 늦은 것. 두 소비처(routes/api/veeam.js ·
 *   veeam/push.js)는 이 함수만 쓴다. dedicated:false = 그 요약이 전용 DB 를 읽지 않았다(백필 전 로그 DB 경로) — 이 수집기가 넣은 행이 그 요약에
 *   없으므로 이 수집기의 시각을 섞지 않는다.
 */
export function snapEventsOkAt(vcenterId, { dedicated = true, summary } = {}) {
  // v2.766(점검 R1-A1-1 ③): 요약이 Veeam 으로 본 계정 중 이 수집기가 읽지 않는 계정(이름 규칙 'veeam' 등)이 있으면 이 수집기의 시각을 섞지 않는다.
  return combineOkAt(logCollectOkAt(vcenterId), dedicated && snapCollectorCovers(summary) ? snapCollectorOkAt(vcenterId) : null);
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
/** 재시작 뒤 영속값 복원(vCenter 1곳) — seen 이 없으면 ok 도 믿지 않는다(4-a: seen 전의 ok 는 표기 불일치의 0건 완결일 수 있다). */
function restoreOne(db, id) {
  if (!_fp.has(id)) { const f = db.snapFp(id); if (f) _fp.set(id, f); }   // v2.766(점검 R1-A1-1·A5-1)
  if (!_seen.has(id)) { const sn = db.snapSeenAt(id); if (sn) _seen.set(id, sn); }
  if (_seen.has(id) && !_okAt.has(id)) { const p = db.snapOkAt(id); if (p) { _okAt.set(id, p); return true; } }
  return false;
}

/** vCenter 1곳 — 커서부터 이어 읽어 전용 DB 에 넣고 커서·완결 시각을 기록한다. 던지면 호출부가 실패로 센다(커서·okAt 은 읽은 만큼만 바뀐다). */
async function collectOne(vc, db, { now, userNames, full = true, perCallMax, budgetMs }) {
  const id = String(vc.id);
  const startedAt = now;
  const t0 = Date.now();
  let cursor = db.snapCursor(id);
  // v2.765(2-b): 커서 그 시각부터(포함) — 같은 ms 의 나머지를 건너뛰지 않는다(중복은 해시 UNIQUE 가 거른다)
  let since = Math.max(cursor || 0, now - LOOKBACK_MS);
  let read = 0; let stored = 0; let calls = 0; let maxRead = 0; let ended = 'empty'; let stalled = false;
  for (;;) {
    calls++;
    const before = cursor || 0;
    const events = await vcLogWithDeadline(vc, (signal) => collectVCenterEvents(vc, { sinceTs: since, max: perCallMax, pageSize: PAGE_SIZE, signal, userNames }));
    ended = events.ended || (events.length >= perCallMax ? 'max' : 'empty');
    read += events.length;
    let mx = 0;
    for (const e of events) { const t = Number(e?.ts); if (Number.isFinite(t) && t > mx) mx = t; }
    if (events.length) {
      // v2.765(4-a): 계정 필터로 이벤트를 읽었다 — 이 계정 표기는 이 vCenter 에서 맞는다. 그 뒤부터 okAt 을 믿는다(영속).
      //   v2.766(점검 R1-A1-1 ②): 공용 계정(administrator 등)의 이벤트만으로는 서지 않는다 — 그 계정은 사람·자동화도 쓰므로 Veeam 계정 표기가 맞는다는 근거가 아니다.
      if (!_seen.has(id) && events.some((e) => e?.user && !isSharedAccount(e.user))) { _seen.set(id, Date.now()); db.setSnapSeenAt(id, _seen.get(id)); }
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
    // v2.765(2-b): 상한에 걸렸는데 마지막 시각이 커서를 넘지 못했다 — 같은 ms 에 상한만큼 몰렸다. 같은 since 로 다시 읽어도 같은 결과라 멈춘다.
    if (!(mx > before)) { stalled = true; break; }
    if (Date.now() - t0 >= budgetMs) break;                     // 예산 — 다음 주기가 커서부터 잇는다
    since = cursor;
  }
  const complete = ended === 'empty';
  const okAt = completeUntil({ complete, startedAt, maxRead });
  // v2.765(4-a): 이벤트를 읽어 본 적 없는 vCenter(seen 아님)의 okAt 은 기록하지 않는다 — 0건 완결은 '온전' 이 아니라 '모름' 이다.
  // v2.766(점검 R1-A1-1·A5-1): 이 지문으로 아직 okAt 이 없으면(목록이 바뀌어 커서를 되돌린 뒤) **끝까지 읽은 회차** 에서만 처음 기록한다 · 원문 계정이 상한에서
  //   빠진 목록(full false)이면 기록하지 않는다(그 계정은 이 수집기가 읽지 않는다).
  const seen = _seen.has(id);
  if (seen && full && okAt != null && (complete || _okAt.has(id)) && okAt > (_okAt.get(id) || 0)) { _okAt.set(id, okAt); db.setSnapOkAt(id, okAt); }
  const okNow = snapCollectorOkAt(id);
  const reason = !full ? 'accounts-over-limit' : !seen ? 'unseen' : okNow == null ? 'refilling' : null;
  return { okAt: okNow, cursor, read, stored, calls, capped: !complete, ended, seen, reason, ...(stalled ? { stalled: true } : {}) };
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
    const cov = userListCoverage(accounts);   // v2.766(점검 R1-A1-1·A5-1): userList + 지문 + 원문 계정이 다 들었나
    const userNames = cov.userNames;
    let ok = 0; let fail = 0; let noAccount = 0; let read = 0; let stored = 0;
    const authStopped = [];
    await poolRun(targets, CONCURRENCY, async (vc) => {
      const id = String(vc.id);
      restoreOne(db, id);   // 재시작 뒤 영속값 복원
      if (vcAuthGuard.authStopFor(vc)) { authStopped.push(id); setPer(id, { state: 'auth-stopped' }); return; }
      if (!userNames.length) { noAccount++; setPer(id, { state: 'no-account', okAt: snapCollectorOkAt(id), seen: _seen.has(id) }); return; }
      try {
        // v2.766(점검 R1-A5-1): 계정 목록(지문)이 바뀌었으면 커서·okAt·seen 을 지우고 새 지문을 적는다 — 새 계정의 지난 LOOKBACK 을 다시 읽는다.
        let listChanged = false;
        if (_fp.get(id) !== cov.fp) {
          db.resetSnapCollector(id, cov.fp);
          _fp.set(id, cov.fp); _okAt.delete(id); _seen.delete(id); listChanged = true;
        }
        const r = await collectOne(vc, db, { now, userNames, full: cov.full, perCallMax, budgetMs: budget });
        ok++; read += r.read; stored += r.stored;
        setPer(id, { state: 'ok', ...r, kind: null, listChanged, ...(cov.full ? {} : { accountsMissing: cov.missing }) });
      } catch (e) {
        fail++;
        const msg = String(e?.message || e || '알 수 없는 오류');
        const kind = isVcAuthError(e) ? 'auth' : /데드라인/.test(msg) ? 'deadline' : 'error';
        // 로그인 거부는 주 폴러와 같은 정지 기록에 올린다(v2.732 보조 수집기 규약) — 다음 주기는 authStopFor 가 건너뛴다.
        if (kind === 'auth') vcAuthGuard.markAuthStopped(id, vc, msg);
        setPer(id, { state: 'fail', kind, okAt: snapCollectorOkAt(id), seen: _seen.has(id) });
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
    if (restoreOne(db, String(vc.id))) n++;
  }
  return n;
}

export function startVeeamSnapCollector() {
  if (_timer) return;
  restoreOkAt().catch(() => {});
  _timer = startAdaptiveTimer(intervalMs, () => pollVeeamSnapOnce(), {
    firstDelayMs: FIRST_DELAY_MS, name: 'Veeam 계정 이벤트 전용 수집',
    subscribe: (cb) => { _rearm.add(cb); return () => _rearm.delete(cb); },   // v2.765(4-f): rescheduleVeeamSnapCollector 가 깨운다
  });
  console.log('[veeam-snap-collector] Veeam 계정 이벤트 전용 수집기 시작(주기 = vCenter 로그 수집 주기)');
}

/**
 * v2.765(4-f): 로그 설정(pollIntervalMin)이 저장되면 이미 무장된 타이머를 새 주기로 즉시 재무장한다 — 로그 설정 PUT 라우트가 rescheduleLogPoller()
 *   옆에서 부른다. 예전에는 다음 틱부터였다(주기가 1일이면 최대 1일 뒤). 타이머가 없으면(미기동·테스트) 아무것도 하지 않는다. 실행 중이면
 *   startAdaptiveTimer 가 끝날 때 새 주기로 잡는다. 반환: 알린 구독자 수.
 */
export function rescheduleVeeamSnapCollector() {
  let n = 0;
  for (const cb of _rearm) { try { cb(); n++; } catch { /* 타이머 쪽 오류가 설정 저장을 막지 않게 */ } }
  return n;
}

/** 상태(요약만 — vCenter 주소·오류 원문 없음). edgelog/spec.js collect.veeamSnap · health/services.js 가 읽는다. */
export function veeamSnapCollectorStatus() {
  const s = loadLogSettings();
  const perVc = {};
  for (const [k, v] of _perVc) perVc[k] = { ...v };
  return { ...(_last || {}), enabled: skipReason(s) == null, intervalMs: intervalMs(), running: !!_running, ...(_running ? { runningSince: _running.since } : {}), perVc };
}

export function _resetForTest() { _running = null; _last = null; _okAt.clear(); _seen.clear(); _fp.clear(); _perVc.clear(); _covMemo = { key: null, cov: null }; }
export function _setOkAtForTest(vcenterId, ts) { _okAt.set(String(vcenterId), ts); _seen.set(String(vcenterId), ts); const c = currentCoverage(); if (c) _fp.set(String(vcenterId), c.fp); }
export function _stopForTest() { _timer?.stop(); _timer = null; _rearm.clear(); }
