/**
 * 성능점검 폴러 — 만기 항목만 골라 워커 풀에 넘긴다.
 *
 * 고부하 설계(1만 대 × 항목 10개 = 10만 항목 가정)
 * - **전수 스캔 금지**: 매 틱마다 전 항목을 순회하면 10만 개 × 5초틱 = 초당 2만 회 비교다.
 *   `nextDue`(만기시각 오름차순 인덱스)를 유지해 **만기된 앞부분만** 꺼낸다.
 * - 인덱스는 대상/점검이 바뀔 때만 재구성한다(store 리비전 비교).
 * - 결과는 인메모리 Map 1개(항목당 1건 — 시계열 아님). 10만 항목 × ~200B ≈ 20MB 로 유계.
 * - 한 틱에 실행할 상한(MAX_PER_TICK)을 둬 만기가 몰려도 폭주하지 않게 한다(초과분은 다음 틱).
 * - 재진입 가드: 이전 틱이 안 끝나면 이번 틱을 건너뛴다(주기·수동 실행이 가드를 공유).
 * - CSV 적재는 배치 라이터에 push 만 한다(동기 I/O 없음).
 */

import { listTargets, storeRevision } from './store.js';
import { runBatch, poolStats } from './pool.js';
import { appendResult, logStats } from './csvlog.js';

const envNum = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) ? n : d; };
const TICK_MS = Math.max(1000, envNum('SVCMON_TICK_MS', 5000));
const MAX_PER_TICK = Math.max(100, envNum('SVCMON_MAX_PER_TICK', 4000));
const ENABLED = process.env.SVCMON_ENABLED !== 'false';   // 킬스위치(독립 운영 요구사항)

const results = new Map();     // testId -> { status, reply, ms, ts, streak }
const nextDue = new Map();     // testId -> 다음 실행 시각(ms)
let index = [];                // [{ test, host, target }] — 평탄화된 실행 단위
let indexRev = -1;
/**
 * 선정 커서 — 매 틱 index 0번부터 훑으면 만기가 틱 상한을 넘는 순간 **뒤쪽이 영구히 굶는다.**
 * 시뮬레이션(720틱=1시간, 15만 항목·주기 60초·천장 800/s): 앞쪽 48,000개는 정확히 60초로 돌고
 * **나머지 102,000개(68%)는 한 번도 실행되지 않았다.** '주기가 늘어난다'가 아니라 '뒤쪽은 안
 * 돈다'였고, 실행되지 않은 항목은 결과가 없어 화면에서 '중지'로 집계됐다(= 감시 공백을
 * 의도적 중지로 표시). 원형으로 이어 훑어 지연을 전체에 고르게 분산한다.
 */
let cursor = 0;
let running = false;
let lastSweepTs = 0;
let lastSweepMs = 0;
let lastCount = 0;
let timer = null;

export function getResults() { return results; }
export function getLastSweep() { return lastSweepTs; }
export function pollerStats() {
  return {
    enabled: ENABLED,
    items: index.length,
    lastSweepMs,
    lastCount,
    tickMs: TICK_MS,
    maxPerTick: MAX_PER_TICK,
    pool: poolStats(),
    log: logStats(),
  };
}

/** 저장소가 바뀌었을 때만 실행 인덱스를 다시 만든다(10만 항목 전수 순회를 매 틱 피한다). */
function rebuildIndex() {
  const rev = storeRevision();
  if (rev === indexRev) return;
  indexRev = rev;
  const next = [];
  const liveIds = new Set();
  for (const target of listTargets()) {
    if (target.enabled === false) continue;
    for (const test of target.tests) {
      if (test.enabled === false) continue;
      next.push({ test, host: target.host, target });
      liveIds.add(test.id);
      if (!nextDue.has(test.id)) nextDue.set(test.id, 0);   // 신규는 즉시 만기
    }
  }
  index = next;
  // 사라진 항목의 상태·만기 정리(메모리 누수 방지)
  for (const id of [...nextDue.keys()]) if (!liveIds.has(id)) nextDue.delete(id);
  for (const id of [...results.keys()]) if (!liveIds.has(id)) results.delete(id);
}

async function sweep(force = false) {
  if (running) return false;
  running = true;
  const t0 = Date.now();
  try {
    rebuildIndex();
    const now = Date.now();
    // 커서에서 시작해 **원형으로** 훑는다 — 0번부터 훑으면 상한을 넘는 순간 뒤쪽이 굶는다.
    const due = [];
    const n = index.length;
    if (n) {
      if (cursor >= n) cursor = 0;
      let i = cursor;
      for (let scanned = 0; scanned < n && due.length < MAX_PER_TICK; scanned += 1) {
        const item = index[i];
        if (force || (nextDue.get(item.test.id) ?? 0) <= now) due.push(item);
        i = i + 1 === n ? 0 : i + 1;
      }
      // 다음 틱은 멈춘 위치에서 이어 간다(상한에 걸리지 않았으면 한 바퀴 돌아 제자리).
      cursor = i;
    }
    if (!due.length) { lastSweepTs = now; return true; }

    // 만기를 먼저 밀어 둔다 — 실행이 오래 걸려도 다음 틱에서 중복 선정되지 않게.
    for (const { test } of due) nextDue.set(test.id, now + test.intervalSec * 1000);

    const out = await runBatch(due.map(({ test, host }) => ({ test, host })));
    const byId = new Map(out.map((r) => [r.testId, r]));
    const ts = Date.now();
    // 결과 반영은 수천 건이 한꺼번에 몰린다 — 통째로 돌리면 이 동기 루프가 이벤트 루프를
    // 수십 ms 막는다(실측 57ms). 청크마다 setImmediate 로 양보한다(대량 export 패턴과 동일).
    const APPLY_CHUNK = 500;
    for (let i = 0; i < due.length; i += APPLY_CHUNK) {
      for (const { test, target } of due.slice(i, i + APPLY_CHUNK)) {
        const r = byId.get(test.id);
        if (!r) continue;
        const prev = results.get(test.id);
        const changed = !prev || prev.status !== r.status;
        const rec = { status: r.status, reply: r.reply, ms: r.ms, ts, streak: changed ? 1 : prev.streak + 1 };
        results.set(test.id, rec);
        appendResult({ ts, target, test, result: rec, changed });
      }
      if (i + APPLY_CHUNK < due.length) await new Promise((r) => setImmediate(r));
    }
    lastSweepTs = ts;
    lastCount = due.length;
    lastSweepMs = Date.now() - t0;
    return true;
  } finally {
    running = false;
  }
}

/** 수동 새로고침 — 진행 중이면 false(주기 폴러와 가드 공유). */
export function runNow() { return sweep(true); }

export function startSvcmonPoller() {
  if (timer) return;
  if (!ENABLED) { console.log('[svcmon] SVCMON_ENABLED=false — 성능점검 폴러 비활성'); return; }
  sweep().catch(() => {});
  timer = setInterval(() => { sweep().catch(() => {}); }, TICK_MS);
  timer.unref?.();
  const p = poolStats();
  console.log(`[svcmon] 성능점검 폴러 시작 (tick ${TICK_MS}ms · 워커 ${p.workers} × 동시 ${p.perWorkerConcurrency} · 틱당 최대 ${MAX_PER_TICK})`);
}
