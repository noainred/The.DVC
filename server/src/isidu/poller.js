/**
 * isidu/poller.js — 아이실론 디렉터리 사용량 주기 실행(v2.736). 중앙·엣지 공용: 각 노드는 **자기 몫 대상**만 돈다.
 *   중앙: 설정의 대상 중 실행 노드가 '' 인 것(등록부 아이실론이면 그 장비의 담당 노드가 중앙인 것).
 *   엣지: 중앙이 내려준 사본(settings.edgeTargets) — 엣지가 속한 법인의 아이실론을 엣지가 직접 조사한다.
 *
 * ── 폴러 규약 ────────────────────────────────────────────────────────────────
 *  · 1분 틱(적응 타이머)이 도래한 대상을 **시작만** 한다 — du 는 수십 분이 걸릴 수 있어 한 틱이 다른 대상을 붙잡지 않게,
 *    대상마다 진행 중 표지(_inflight)를 두고 전체 동시 실행은 `ISIDU_CONCURRENCY`(기본 2)로 묶는다.
 *  · 도래: 마지막 시도가 성공이었으면 주기(intervalHours)마다, 실패였으면 min(주기, 1시간)마다(회선 장애가 하루를 통째로
 *    잃지 않게). 인증 거부는 authGuard 가 주기 수집을 멈춘다(계정 잠금 방지).
 *    v2.741 DEV-05: 단 **오래 돈 실패**(`LONG_FAIL_MS` 이상 — du 가 장비를 오래 훑다 시한·출력 상한에 걸린 것)는 주기만큼 쉰다.
 *    1시간 뒤 다시 돌리면 시한(기본 2시간)에 계속 걸리는 대상이 하루 약 16시간 du 를 장비에서 돌렸다(재현). 빨리 끝난 실패(연결 거부·
 *    DNS)는 예전처럼 1시간 뒤다. 웹 isiduOverviewText.nextRunOf 가 같은 규칙으로 '다음 시도' 를 말한다.
 *  · 수동 실행('지금 수집')은 같은 진행 중 표지를 공유한다(같은 대상에 du 두 개를 겹쳐 돌리지 않는다).
 *    v2.741 TIMING-02: 수동 실행도 `ISIDU_CONCURRENCY` 를 지킨다 — 상한을 넘는 대상은 대기열에 두고 앞 조사가 끝나면 차례로 시작한다
 *    (예전에는 고른 대상 전부(최대 100개)의 du 를 한꺼번에 시작했다). 대기는 `QUEUE_HOLD_MS` 가 지나면 버리고 그 사실을 기록에 남긴다.
 *  · 보존 정리는 6시간마다(첫 틱 제외 — v2.453).
 *  · 데모(mock-) 대상은 mock 모드에서만 돈다 — live 에서는 건너뛰고 그 개수를 상태에 남긴다(v2.719).
 *  · v2.737: 조사를 시작하면 실행 중 스캔 기록(util/scanJournal)에 남긴다 — 업그레이드·재시작으로 끝나지 못하면 다음 기동 2분 뒤 자동으로
 *    다시 시작한다(재개 상한 2회). 장비에서 분리 실행 중이던 du 가 있으면(collect.js) 새로 돌리지 않고 **그 작업에 붙어 결과를 받는다**.
 *    재개 대기 중인 대상은 주기 틱이 먼저 새로 시작하지 않는다(같은 장비에 du 두 개를 겹치지 않게 — 최대 2시간).
 *  · v2.742(감사 RECENT-02·EDGE-02): '지금 수집' 대기열도 실행 중 스캔 기록에 남긴다(`scanQueued` — 동기). 예전에는 메모리에만 있어
 *    재시작·자동 업그레이드가 오면 대기 요청이 **기록도 없이** 사라졌고(v2.740 까지는 전부 곧바로 시작해 기록에 남았다 — v2.741 회귀),
 *    엣지 위임 요청은 중앙이 그 요청을 결과 시한(수 시간)까지 '진행 중' 으로 잡아 두었다(엣지가 다시 시작하지 않는다).
 *    기동 때(모듈 로드) 그 기록을 대기열로 되돌리고(원래 넣은 시각 그대로 — 대기 시한이 재시작으로 늘지 않는다) 자리가 나면 차례로 시작한다.
 *    재시작 전에 **돌던** 조사(재개 대기)가 자리를 먼저 받는다(`freeSlots` — 되돌린 대기 요청·주기 실행이 그 자리를 먼저 차지하면 재개가
 *    '다른 스캔 중' 으로 밀리다 그만둘 수 있다).
 *  · v2.743(감사 TIMING-03): runNow 는 대기열에 넣는 대상의 기록을 모아 **한 번에** 남긴다(`scanQueuedMany`) — 대상마다 쓰면 기록 파일 전체를
 *    대상 수만큼 다시 써 요청 하나가 이벤트 루프를 막았다(O(N²)).
 *  · v2.743(감사 LEFT-08): 엣지가 중앙이 보낸 '지금 수집' 요청을 **시작하지 않고 버리면**(대기 6시간 초과 'queue-hold' · 대상이 사본에 없음
 *    'not-here'·'target-gone' · 재시작 뒤 다시 넣지 않음 'not-restored') 그 사실을 기록해 push 상태에 싣는다(`runDropsForPush`).
 *    예전에는 엣지 기록(note)에만 남아 중앙이 결과 시한(최대 약 10시간)까지 '진행 중' 으로 잡아 두었다가 일반 '결과 없음' 으로 버렸다.
 *    중앙이 보낸 요청을 실은 대기(trigger 'central' 이거나 중앙 요청이 합쳐진 것)만 싣는다 — 엣지에서 사람이 누른 것은 중앙 요청이 아니다.
 */
import { config } from '../config.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { isMockMode } from '../mock/demo/flags.js';
import { loadSettings, resolveTarget, edgeTargets } from './settings.js';
import { collectTarget } from './collect.js';
import * as db from './db.js';
import { scanStarted, scanFinished, scanProgress, pendingResumeOf, registerScanResumer, journalFor, scanQueued, scanQueuedMany, scanDequeued, queuedOf, takeQueuedBootDrops } from '../util/scanJournal.js';
import { notifyScanStored } from './notify.js';

export const TICK_MS = 60_000;
export const FAIL_RETRY_MS = 3_600_000;
/** v2.741 DEV-05: 이만큼 넘게 돈 실패는 1시간 뒤가 아니라 주기만큼 쉰다(장비 부하 — 웹 nextRunOf 와 같은 값). */
export const LONG_FAIL_MS = 30 * 60_000;
/** v2.741 TIMING-02: '지금 수집' 대기열에서 기다리는 최대 시간(보류에는 시한 — 넘으면 버리고 기록에 남긴다). */
export const QUEUE_HOLD_MS = 6 * 3_600_000;
const PRUNE_EVERY_MS = 6 * 3_600_000;
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.ISIDU_CONCURRENCY) || 2));
const RECENT_MAX = 60;
const KIND = 'isidu';
const PENDING_HOLD_MS = 2 * 3_600_000; // 재개 대기 대상을 틱이 건너뛰는 최대 시간(재개가 어떤 이유로 끝나지 않아도 주기가 영원히 막히지 않게)

const _inflight = new Map();   // targetId → { since, trigger, promise }
const _lastTry = new Map();    // targetId → { ts, ok, durationMs }
const _queue = new Map();      // targetId → { since, trigger, central? } — 동시 실행 상한에 걸려 기다리는 '지금 수집'(TIMING-02)
let _draining = null;          // 진행 중인 대기열 꺼내기(같이 기다린다)
let _drainAgain = false;
let _seeded = false;
let _timer = null;
let _ticking = false;
let _lastTick = null;
let _lastPrune = Date.now();
let _lastError = null;
let _demoSkipped = 0;
const _recent = [];
let _afterScan = null;         // 엣지: 적재 뒤 push 예약(push.js 가 등록 — 순환 import 방지)

export function onScanStored(fn) { _afterScan = typeof fn === 'function' ? fn : null; }

const isEdge = () => !!(config.agent.centralUrl && config.agent.centralToken);

/**
 * v2.743(감사 LEFT-08): 엣지가 시작하지 않고 버린 '중앙 요청' — push 상태(runDropped)로 중앙에 알린다. 중앙은 그 요청을 결과 시한까지
 * 기다리지 않고 이 사유로 정리한다. 보낸 뒤(중앙 2xx) 지운다(ackRunDrops) · 상한을 넘으면 오래된 것부터 버리고 개수를 센다.
 * 사유 코드는 isidu/collectRequests.js EDGE_DROP_REASONS 와 같다(웹 collectDropText.EDGE_DROP_TEXT 와 1:1).
 */
export const RUN_DROPS_MAX = 50;
const _runDrops = [];          // { seq, id, reason, at, trigger } (최신이 앞)
let _runDropSeq = 0;
let _runDropsOmitted = 0;
function noteRunDrop(id, reason, trigger = '') {
  _runDrops.unshift({ seq: ++_runDropSeq, id: String(id).slice(0, 64), reason, at: Date.now(), trigger: String(trigger || '').slice(0, 16) });
  if (_runDrops.length > RUN_DROPS_MAX) { _runDropsOmitted += _runDrops.length - RUN_DROPS_MAX; _runDrops.length = RUN_DROPS_MAX; }
  // 엣지면 곧 push(5초 묶음 — push.js 가 등록한 예약) — 다음 주기(10분)를 기다리지 않는다.
  if (_afterScan) { try { _afterScan(); } catch { /* push 예약 실패는 다음 주기 */ } }
}
/** 대기 항목이 중앙 요청을 싣고 있는가(중앙이 보낸 것이거나 중앙 요청이 합쳐진 것). */
const carriesCentral = (q) => !!q && (q.central === true || q.trigger === 'central');

/**
 * push 가 실을 버린 요청 목록 — `ageMs`(버린 뒤 지난 시간, 엣지 시계의 **길이**)를 싣는다: 중앙은 받은 시각에서 빼어 '언제 버렸는지' 를
 * 어림한다(두 시계의 시각을 비교하지 않는다 — v2.591 R-Q1). `held` = 지금 이 엣지가 돌리거나 기다리는 대상 — 버린 뒤 다시 받은 요청을
 * 중앙이 지우지 않게. `seq` 는 ackRunDrops 에 넘긴다.
 */
export function runDropsForPush(now = Date.now()) {
  return {
    list: _runDrops.map((d) => ({ id: d.id, reason: d.reason, ageMs: Math.max(0, now - d.at), trigger: d.trigger })),
    held: [...new Set([..._inflight.keys(), ..._queue.keys()])].slice(0, 200),
    omitted: _runDropsOmitted,
    seq: _runDropSeq,
  };
}
/** 중앙이 받았다(2xx) — 그때 실은 것까지 지운다(그 뒤에 생긴 것은 다음 push). */
export function ackRunDrops(seq) {
  const n = Number(seq);
  if (!Number.isFinite(n)) return;
  for (let i = _runDrops.length - 1; i >= 0; i--) if (_runDrops[i].seq <= n) _runDrops.splice(i, 1);
  _runDropsOmitted = 0;
}

/** v2.742(RECENT-02): 대기열에 넣는다 — 실행 중 스캔 기록에도 남긴다(재시작·업그레이드에도 대기 요청이 남게).
 *  v2.743(TIMING-03): batch 배열을 주면 기록을 거기에 모으고 호출부가 scanQueuedMany 로 한 번에 쓴다. */
function enqueue(id, { since = Date.now(), trigger = 'manual', label = '', restored = false, batch = null } = {}) {
  _queue.set(id, { since, trigger, ...(trigger === 'central' ? { central: true } : {}), ...(restored ? { restored: true } : {}) });
  if (restored) return;
  const rec = { key: id, label: label || id, trigger, since, holdMs: QUEUE_HOLD_MS, meta: { manual: true } };
  if (Array.isArray(batch)) batch.push(rec);
  else scanQueued(KIND, id, rec);
}
/** v2.742: 대기열에서 뺀다(시작·시한 초과·대상 없음) — 기록도 함께 지운다. */
function dequeue(id) {
  _queue.delete(id);
  scanDequeued(KIND, id);
}

/**
 * v2.742: 지금 새로 시작할 수 있는 자리 수 — 재시작 전에 돌던 조사(재개 대기, 기동 뒤 PENDING_HOLD_MS 안)의 자리는 비워 둔다.
 * 재개 함수(resumeIsidu)는 이 값이 아니라 실제 진행 수만 본다(재개가 그 자리의 주인이다).
 */
function freeSlots(now = Date.now()) {
  let reserved = 0;
  for (const x of journalFor(KIND).interrupted) {
    if (_inflight.has(x.key)) continue;
    if (now - (x.detectedAt || 0) >= PENDING_HOLD_MS) continue;
    reserved++;
  }
  return CONCURRENCY - _inflight.size - reserved;
}

/**
 * v2.742(RECENT-02): 기동 때 재시작 전 대기 요청을 대기열로 되돌린다(원래 넣은 시각 그대로 — 대기 시한이 재시작으로 늘지 않는다).
 * 시한이 지난 것은 drainQueue 가 버리고 기록에 남긴다. 같은 대상이 재개 대기 중이면 drainQueue 가 재개가 끝날 때까지 기다린다.
 */
function restoreQueue() {
  // v2.743(LEFT-08): 기동 때 다시 넣지 못한 대기 요청 중 중앙이 보낸 것은 중앙에 알린다(이력에는 scanJournal 이 이미 남겼다).
  for (const d of takeQueuedBootDrops(KIND)) if (d.trigger === 'central') noteRunDrop(d.key, d.reason, d.trigger);
  let n = 0;
  for (const q of queuedOf(KIND)) {
    if (_queue.has(q.key) || _inflight.has(q.key)) continue;
    enqueue(q.key, { since: q.since || Date.now(), trigger: q.trigger || 'manual', restored: true });
    n++;
  }
  if (n) note('info', `재시작 전 '지금 수집' 대기 ${n}개를 대기열에 다시 넣었습니다 — 자리가 나면 차례로 시작합니다`);
  return n;
}

function note(level, msg) {
  _recent.unshift({ at: Date.now(), level, msg: String(msg).slice(0, 300) });
  if (_recent.length > RECENT_MAX) _recent.length = RECENT_MAX;
  if (level === 'error') console.warn(`[isidu] ${msg}`);
}

/** 이 노드가 돌 대상(실행 정보). */
export async function targetsForThisNode() {
  if (isEdge()) return edgeTargets().targets.map((t) => ({ ...t }));
  const { listDevices } = await import('../storage/registry.js');
  const devices = listDevices();
  return loadSettings().targets.map((t) => resolveTarget(t, { devices })).filter((r) => r && !String(r.agent || '').trim());
}

/** 오래 돈 실패인가(DEV-05) — 소요 시간을 모르면 아니다(예전 규칙 그대로). */
export function isLongFailure(last) {
  if (!last || last.ok) return false;
  const d = Number(last.durationMs);
  return last.durationMs != null && Number.isFinite(d) && d >= LONG_FAIL_MS;
}

/** 도래 판정(순수). */
export function isDue(t, last, now = Date.now()) {
  if (!t || t.enabled === false || t.deviceDisabled) return false;
  const iv = Math.max(1, Number(t.intervalHours) || 24) * 3_600_000;
  if (!last || !Number.isFinite(last.ts)) return true;
  if (isLongFailure(last)) return now - last.ts >= iv; // 오래 돈 실패 — 주기만큼 쉰다(바로 다시 돌려도 같은 시한에 걸린다)
  const wait = last.ok ? iv : Math.min(iv, FAIL_RETRY_MS);
  return now - last.ts >= wait;
}

async function seedLastTry() {
  if (_seeded) return;
  const rows = await db.latestAll();
  if (rows == null) return; // DB 불가 — 다음 틱에 다시
  for (const r of rows) {
    if (r.agent !== '' || !r.lastTry) continue;
    if (!_lastTry.has(r.targetId)) _lastTry.set(r.targetId, { ts: r.lastTry.ts, ok: r.lastTry.ok, durationMs: r.lastTry.durationMs ?? null });
  }
  _seeded = true;
}

function runOne(t, trigger, manual, { resumeOf = null } = {}) {
  const cur = _inflight.get(t.id);
  if (cur) return cur.promise;
  // 재개 대기 항목이 있으면(재시작 전에 돌던 조사) 그 작업을 잇는다 — 사람이 먼저 '지금 수집' 을 눌러도 같다.
  const prior = resumeOf || pendingResumeOf(KIND, t.id);
  const attach = prior?.meta?.jobId && (!prior.meta.jobHost || prior.meta.jobHost === t.host) ? String(prior.meta.jobId) : null;
  _queue.delete(t.id); // v2.742: 같은 대상의 대기 요청은 이 시작이 대신한다(기록은 scanStarted 가 같은 쓰기에서 지운다)
  scanStarted(KIND, t.id, {
    label: t.label || t.id, trigger, resumeOf: prior,
    ...(prior && !resumeOf ? { resumeNote: `${manual ? '수동 실행' : '주기 실행'}이 재시작 전 조사를 이어 받았습니다` } : {}),
    meta: { manual: !!manual, ...(attach ? { jobId: attach, jobHost: t.host || '' } : {}) },
  });
  const promise = (async () => {
    try {
      const rec = await collectTarget(t, {
        trigger, manual, attachJob: attach,
        onJob: (job) => { try { scanProgress(KIND, t.id, { jobId: job.id, jobHost: t.host || '' }); } catch { /* 기록 실패는 조사를 막지 않는다 */ } },
      });
      const saved = await db.insertScan(rec);
      if (!saved.ok) note('error', `${t.label || t.id}: 결과를 저장하지 못했습니다 — ${saved.error}`);
      _lastTry.set(t.id, { ts: rec.ts, ok: rec.ok, durationMs: rec.durationMs ?? null });
      const how = rec.attached ? ' · 재시작 전 장비에서 돌던 du 결과를 이어 받음' : rec.runMode === 'attached-fallback' ? ` · 분리 실행 불가로 직접 실행(${rec.detachFallback || '사유 없음'})` : '';
      if (rec.ok) note('info', `${t.label || t.id}: 폴더 ${rec.count.toLocaleString()}개 조사 (${Math.round(rec.durationMs / 1000)}초)${rec.errLines ? ` · 권한 오류 ${rec.errLines}줄` : ''}${how}${prior ? ' · 자동 재개' : ''}`);
      else note('error', `${t.label || t.id}: ${rec.error}${prior ? ' (자동 재개)' : ''}`);
      if (saved.ok && _afterScan) { try { _afterScan(); } catch { /* push 예약 실패는 다음 주기 */ } }
      // v2.738 결과 메일 — 중앙이 직접 조사한 결과만 여기서(엣지 결과는 중앙이 받을 때). 기다리지 않는다(발송이 조사를 막지 않게 — 실패는 notify 가 기록한다).
      if (saved.ok && !saved.duplicate && !isEdge()) notifyScanStored({ targetId: t.id, scanId: saved.id, ok: rec.ok, ts: rec.ts });
      return { ok: rec.ok, saved: saved.ok, kind: rec.kind || null, error: rec.error || null };
    } catch (e) {
      note('error', `${t.label || t.id}: 실행 오류 — ${e.message}`);
      _lastTry.set(t.id, { ts: Date.now(), ok: false, durationMs: null });
      return { ok: false, error: e.message };
    } finally {
      _inflight.delete(t.id);
      scanFinished(KIND, t.id);
      // 자리가 났다 — 기다리던 '지금 수집' 을 꺼낸다(기다리지 않는다 — 결과를 막지 않게).
      if (_queue.size) drainQueue().catch((e) => note('error', `대기열 꺼내기 실패: ${e.message}`));
    }
  })();
  _inflight.set(t.id, { since: Date.now(), trigger, promise });
  return promise;
}

/**
 * 재시작으로 중단된 조사의 재개(util/scanJournal 이 기동 2분 뒤 부른다).
 * 결과: started · covered(이미 다시 조사 중) · gone(대상이 이 노드 목록에 없다) · skipped(꺼짐·데모) · busy(동시 실행 상한 — 5분 뒤 다시).
 */
export async function resumeIsidu(entry) {
  const all = await targetsForThisNode();
  const t = all.find((x) => x.id === entry.key);
  if (!t) return { outcome: 'gone', note: '대상이 이 노드의 목록에서 사라졌습니다(삭제·실행 노드 변경)' };
  if (String(t.id).startsWith('mock-') && !isMockMode()) return { outcome: 'skipped', note: '데모 대상(live 모드)' };
  if (t.deviceDisabled) return { outcome: 'skipped', note: '스토리지 등록부에서 장비가 비활성입니다' };
  if (t.enabled === false && !entry.meta?.manual) return { outcome: 'skipped', note: '대상의 주기 수집이 꺼져 있습니다' };
  if (_inflight.has(t.id)) return { outcome: 'covered', note: '이미 다시 조사 중입니다' };
  if (!entry.meta?.jobId && _inflight.size >= CONCURRENCY) return { outcome: 'busy', note: `동시 실행 상한(${CONCURRENCY}) — 다른 조사가 끝나면 시작합니다` };
  runOne(t, 'resume', false, { resumeOf: entry });
  return { outcome: 'started', note: entry.meta?.jobId ? '장비에서 돌던 du 작업에 다시 붙었습니다' : '조사를 처음부터 다시 시작했습니다' };
}
registerScanResumer(KIND, resumeIsidu);

/**
 * v2.741 TIMING-02: 대기열의 '지금 수집' 을 자리가 나는 만큼 시작한다(먼저 넣은 것부터). 대상은 지금 목록에서 다시 찾는다 —
 * 기다리는 사이 설정이 바뀌거나 대상이 사라졌을 수 있다(사라졌으면 시작하지 않고 기록에 남긴다).
 */
async function drainQueue() {
  if (_draining) { _drainAgain = true; return _draining; }
  _draining = (async () => {
    do {
      _drainAgain = false;
      if (!_queue.size || freeSlots() <= 0) continue;
      const all = await targetsForThisNode();
      const now = Date.now();
      for (const [id, q] of [..._queue]) {
        if (now - q.since > QUEUE_HOLD_MS) {
          dequeue(id); note('error', `${id}: '지금 수집' 대기가 ${Math.round(QUEUE_HOLD_MS / 3_600_000)}시간을 넘어 시작하지 않았습니다 — 다시 누르세요`);
          if (carriesCentral(q)) noteRunDrop(id, 'queue-hold', q.trigger);   // v2.743(LEFT-08): 중앙이 결과 시한까지 기다리지 않게 알린다
          continue;
        }
        if (_inflight.has(id)) { dequeue(id); continue; }
        if (freeSlots(now) <= 0) break;
        // 같은 대상이 재개를 기다리면 그 판정(시작·건너뜀)을 먼저 본다 — 재개가 시작하면 다음 꺼내기에서 위 줄이 대기를 지우고,
        // 건너뛰면(꺼짐 등) 사람이 누른 이 요청이 그 뒤 시작한다(재개 결과에 묻혀 사라지지 않게).
        if (pendingResumeOf(KIND, id)) continue;
        const t = all.find((x) => x.id === id);
        if (!t) { dequeue(id); note('info', `${id}: 기다리는 동안 대상이 이 노드의 목록에서 사라져 시작하지 않았습니다`); if (carriesCentral(q)) noteRunDrop(id, 'target-gone', q.trigger); continue; }
        if (String(t.id).startsWith('mock-') && !isMockMode()) { dequeue(id); if (carriesCentral(q)) noteRunDrop(id, 'not-here', q.trigger); continue; }
        runOne(t, q.trigger, true);   // 대기열·대기 기록은 runOne(scanStarted)이 같은 쓰기에서 지운다
      }
    } while (_drainAgain);
  })().finally(() => { _draining = null; });
  return _draining;
}

async function tick() {
  if (_ticking) return;
  _ticking = true;
  try {
    _lastTick = Date.now();
    if (isMockMode()) {
      try { await (await import('../mock/demo/isidu.js')).ensureIsiduDemo(); } catch (e) { note('error', `데모 시드 실패: ${e.message}`); }
    }
    await seedLastTry();
    const all = await targetsForThisNode();
    let demoSkipped = 0;
    const due = [];
    for (const t of all) {
      if (String(t.id).startsWith('mock-') && !isMockMode()) { demoSkipped++; continue; }
      if (_inflight.has(t.id)) continue;
      const pend = pendingResumeOf(KIND, t.id);
      if (pend && Date.now() - (pend.detectedAt || 0) < PENDING_HOLD_MS) continue; // 재개가 맡는다(재시작 전 du 를 잇는다)
      if (isDue(t, _lastTry.get(t.id))) due.push(t);
    }
    _demoSkipped = demoSkipped;
    // 기다리던 '지금 수집' 이 주기 실행보다 먼저 자리를 받는다(사람이 누른 것이다).
    if (_queue.size) await drainQueue();
    for (const t of due) {
      if (_queue.has(t.id)) continue; // 대기열이 곧 시작한다(같은 대상을 두 길로 시작하지 않는다)
      if (freeSlots() <= 0) break;    // v2.742: 재개를 기다리는 조사의 자리는 비워 둔다
      runOne(t, 'schedule', false);
    }
    if (Date.now() - _lastPrune >= PRUNE_EVERY_MS) {
      _lastPrune = Date.now();
      const days = isEdge() ? edgeTargets().retentionDays : loadSettings().retentionDays;
      db.prune(Date.now() - Math.max(30, Number(days) || 400) * 86_400_000).catch((e) => note('error', `보존 정리 실패: ${e.message}`));
    }
    _lastError = null;
  } catch (e) {
    _lastError = { at: Date.now(), message: e.message };
    note('error', `틱 실패: ${e.message}`);
  } finally { _ticking = false; }
}

/**
 * 지금 수집 — 이 노드 몫 대상 중 고른 것(없으면 전부). 기다리지 않는다(du 는 오래 걸린다) — 화면은 상태로 진행을 본다.
 * v2.741 TIMING-02: 동시 실행 상한(`ISIDU_CONCURRENCY`)까지만 바로 시작하고 나머지는 대기열(`queued`)에 둔다 — 앞 조사가 끝나면
 * 차례로 시작한다. 이미 대기열에 있는 대상도 `queued` 다(두 번 넣지 않는다).
 * @returns {Promise<{started:string[], queued:string[], busy:string[], notHere:string[], concurrency:number}>}
 */
export async function runNow(ids = null, { trigger = 'manual' } = {}) {
  const all = await targetsForThisNode();
  const want = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  const started = []; const queued = []; const busy = []; const notHere = [];
  const batch = [];   // v2.743(TIMING-03): 대기 기록을 모아 한 번에 쓴다(scanQueuedMany)
  if (want) for (const id of want) if (!all.some((t) => t.id === id)) notHere.push(id);
  for (const t of all) {
    if (want && !want.has(t.id)) continue;
    if (String(t.id).startsWith('mock-') && !isMockMode()) { notHere.push(t.id); continue; }
    if (_inflight.has(t.id)) { busy.push(t.id); continue; }
    if (_queue.has(t.id)) {
      // v2.743(LEFT-08): 이미 기다리던 대상에 중앙 요청이 합쳐졌다 — 그 대기를 버리면 중앙 요청도 버린 것이다(중앙에 알린다).
      if (trigger === 'central') _queue.get(t.id).central = true;
      queued.push(t.id); continue;
    }
    if (_inflight.size >= CONCURRENCY) { enqueue(t.id, { trigger, label: t.label, batch }); queued.push(t.id); continue; }
    runOne(t, trigger, true);
    started.push(t.id);
  }
  if (batch.length) scanQueuedMany(KIND, batch);
  // v2.743(LEFT-08): 중앙이 보낸 요청인데 이 엣지 사본에 그 대상이 없다 — 시작할 수 없으므로 중앙에 알린다(결과 시한까지 기다리지 않게).
  if (trigger === 'central') for (const id of notHere) noteRunDrop(id, 'not-here', trigger);
  if (queued.length) note('info', `동시 실행 상한(${CONCURRENCY}) — '지금 수집' ${queued.length}개는 앞 조사가 끝나면 차례로 시작합니다`);
  return { started, queued, busy, notHere, concurrency: CONCURRENCY };
}

/** 진행 중·대기 중인 대상이 끝날 때까지(테스트·데모 백필용). 대기열을 꺼낼 수 없으면 멈춘다(무한 대기 방지). */
export async function waitIdle() {
  for (let i = 0; i < 1000; i++) {
    if (_draining) await _draining.catch(() => {});
    if (_inflight.size) { await Promise.all([..._inflight.values()].map((x) => x.promise.catch(() => {}))); continue; }
    if (!_queue.size) return;
    const before = _queue.size;
    await drainQueue().catch(() => {});
    if (!_inflight.size && _queue.size === before) return;
  }
}

export function isiduPollerStatus() {
  return {
    role: isEdge() ? 'edge' : 'central',
    tickMs: TICK_MS, concurrency: CONCURRENCY, lastTick: _lastTick, lastError: _lastError,
    running: [..._inflight.entries()].map(([id, v]) => ({ targetId: id, since: v.since, trigger: v.trigger })),
    // v2.741 TIMING-02: 동시 실행 상한에 걸려 기다리는 '지금 수집'.
    queued: [..._queue.entries()].map(([id, v]) => ({ targetId: id, since: v.since, trigger: v.trigger, ...(v.restored ? { restored: true } : {}) })),
    // v2.737: 재시작으로 중단돼 재개를 기다리는 조사 · 최근 재개 결과(util/scanJournal).
    ...(() => { const j = journalFor(KIND); return {
      interrupted: j.interrupted.map((x) => ({ targetId: x.key, since: x.since, detectedAt: x.detectedAt, nextAt: x.nextAt, resumes: x.resumes })),
      resumes: j.recent.map((x) => ({ targetId: x.key, at: x.at, outcome: x.outcome, note: x.note, resumes: x.resumes })),
    }; })(),
    ...(_demoSkipped ? { demoSkipped: _demoSkipped } : {}),
    recent: _recent.slice(0, 30),
  };
}

export function startIsiduPoller() {
  if (_timer) return;
  _timer = startAdaptiveTimer(() => TICK_MS, () => tick(), { firstDelayMs: 90_000, name: '아이실론 디렉터리 사용량' });
}

export function _resetForTest() {
  _inflight.clear(); _lastTry.clear(); _queue.clear(); _seeded = false; _recent.length = 0; _lastError = null; _demoSkipped = 0;
  _runDrops.length = 0; _runDropsOmitted = 0;
  for (const q of queuedOf(KIND)) scanDequeued(KIND, q.key);
}
export { tick as _tickForTest };

// v2.742(RECENT-02): 기동 때 재시작 전 대기 요청을 되돌린다(실행 중 스캔 기록은 이 모듈보다 먼저 읽혀 있다 — import 순서).
restoreQueue();
