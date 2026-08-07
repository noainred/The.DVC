/**
 * 성능점검 폴러 — 만기 항목만 골라 워커 풀에 넘긴다.
 *
 * 고부하 설계(1만 대 × 항목 10개 = 10만 항목 가정)
 * - 실행 단위 배열(`index`)은 대상/점검이 바뀔 때만 재구성한다(store 리비전 비교) — 매 틱
 *   대상 트리를 다시 평탄화하지 않는다.
 * - 만기 판정은 `nextDue` Map 조회로 틱마다 전 항목을 훑는다. **정렬 구조가 아니다**
 *   (이전 주석은 '만기 오름차순 인덱스'라고 적어 두었지만 사실이 아니었다). 15만 항목
 *   Map.get 순회는 요약 집계 루프와 같은 자수(10ms 대)이고 5초 틱에서 허용 범위다.
 *   실제 병목은 실행이므로 `MAX_PER_TICK` 으로 틱당 실행량만 묶는다.
 * - 선정은 **원형 커서**다 — 0번부터 훑으면 상한을 넘는 순간 뒤쪽이 영구히 굶는다(아래 cursor).
 * - 결과는 인메모리 Map 1개(항목당 1건 — 시계열 아님). 10만 항목 × ~200B ≈ 20MB 로 유계.
 * - 한 틱에 실행할 상한(MAX_PER_TICK)을 둬 만기가 몰려도 폭주하지 않게 한다(초과분은 다음 틱).
 * - 재진입 가드: 이전 틱이 안 끝나면 이번 틱을 건너뛴다(주기·수동 실행이 가드를 공유).
 * - CSV 적재는 배치 라이터에 push 만 한다(동기 I/O 없음).
 */

import { config } from '../config.js';
import { listTargets, storeRevision } from './store.js';
import { runBatch, poolStats } from './pool.js';
import { appendResult, logStats } from './csvlog.js';

const envNum = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) ? n : d; };
const TICK_MS = Math.max(1000, envNum('SVCMON_TICK_MS', 5000));
const MAX_PER_TICK = Math.max(100, envNum('SVCMON_MAX_PER_TICK', 4000));
const ENABLED = process.env.SVCMON_ENABLED !== 'false';   // 킬스위치(독립 운영 요구사항)
/**
 * 이 인스턴스가 점검을 **직접 실행**하는가. `SVCMON_ROLE=central` 이면 실행하지 않는다 —
 * 정의를 관리해 엣지에 배포하고 결과만 받는다. 중앙에서 원격 대상을 직접 찌르면 RTT 가
 * 응답시간 판정을 오염시키고(폴란드·미국동부 800ms+), 타임아웃이 코드 하드코딩이라
 * 사이트별로 예산을 늘릴 수단이 없다.
 */
const EXECUTES = config.svcmonRole !== 'central';
export function pollerRole() { return { role: config.svcmonRole, executes: EXECUTES && ENABLED }; }

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
/** 이번 틱에 만기였지만 틱 상한에 걸려 못 돈 개수 — '왜 미점검인가'에 답하는 값. */
let overdueSkipped = 0;
/** 가장 오래 밀린 항목의 지연(ms). 지정 주기를 실제로 지키고 있는지 보는 유일한 지표. */
let maxLagMs = 0;
let running = false;
let lastSweepTs = 0;
let lastSweepMs = 0;
let lastCount = 0;
let timer = null;

export function getResults() { return results; }

/**
 * 엣지 push 용 스냅샷 — 실행 인덱스 전량을 **구간값**으로 직렬화한다.
 *
 * 절대 시각을 싣지 않는 이유: 엣지 시계가 틀리면 중앙 판정이 통째로 흔들린다. 중앙은
 * `수신시각 − ageMs` 로 환산하므로 시계 오차에 둔감하다.
 *
 * 델타(변경분)가 아니라 **전량**을 보내는 이유: 엣지 내부에서 항목이 굶으면 '여전히 ok' 와
 * '안 돌았다'를 구별해야 하는데, 델타로는 둘 다 '보고 없음'으로 같아진다.
 *
 * @returns {{rows:object[], items:number, reported:number, metaSig:string, meta:object[]}}
 */
export function snapshotResults({ withMeta = false, replyMax = 120 } = {}) {
  const at = Date.now();
  const rows = [];
  const meta = withMeta ? [] : null;
  for (const { test, target } of index) {
    const r = results.get(test.id);
    if (r) {
      rows.push({
        i: test.id,
        s: r.status,
        r: typeof r.reply === 'string' ? r.reply.slice(0, replyMax) : '',
        m: r.ms,
        k: r.streak,
        a: Math.max(0, at - (r.ts || at)),      // 구간값(ms)
      });
    }
    if (meta) {
      // 내부 구성 정보(url·keyword·send·body·payload·soapAction)는 **절대 싣지 않는다.**
      meta.push({ i: test.id, p: target.path, n: target.name, h: target.host, t: test.name, y: test.type, iv: test.intervalSec });
    }
  }
  return { rows, items: index.length, reported: rows.length, metaSig: `r${indexRev}-${index.length}`, meta };
}
export function getLastSweep() { return lastSweepTs; }
export function pollerStats() {
  return {
    enabled: ENABLED,
    role: config.svcmonRole,
    executes: EXECUTES && ENABLED,
    items: index.length,
    lastSweepMs,
    lastCount,
    tickMs: TICK_MS,
    maxPerTick: MAX_PER_TICK,
    // 이 둘이 0 이 아니면 '등록한 주기로 돌지 않는다'는 뜻이다(화면·엣지 보고에 노출).
    overdueSkipped,
    maxLagMs,
    scanCursor: cursor,
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
      let over = 0;
      let lag = 0;
      for (let scanned = 0; scanned < n; scanned += 1) {
        const item = index[i];
        const nd = nextDue.get(item.test.id) ?? 0;
        if (force || nd <= now) {
          if (due.length < MAX_PER_TICK) {
            due.push(item);
            if (!force) lag = Math.max(lag, now - nd);
          } else {
            over += 1;              // 만기인데 이번 틱에 못 돈 것 — 조용히 넘기지 않고 센다
          }
        }
        i = i + 1 === n ? 0 : i + 1;
        // 상한을 채웠고 남은 만기 수를 다 세었으면 멈춘다(전수 순회 1회는 유지).
      }
      overdueSkipped = over;
      maxLagMs = lag;
      // 다음 틱은 이번에 실행한 개수만큼 앞으로 — 상한에 걸렸을 때 뒤쪽이 다음 차례가 된다.
      cursor = due.length >= MAX_PER_TICK ? (cursor + due.length) % n : i;
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
  if (!EXECUTES) {
    console.log('[svcmon] SVCMON_ROLE=central — 이 인스턴스는 점검을 직접 실행하지 않습니다'
      + '(정의를 엣지에 배포하고 결과만 수신합니다).');
    return;
  }
  sweep().catch(() => {});
  timer = setInterval(() => { sweep().catch(() => {}); }, TICK_MS);
  timer.unref?.();
  const p = poolStats();
  console.log(`[svcmon] 성능점검 폴러 시작 (tick ${TICK_MS}ms · 워커 ${p.workers} × 동시 ${p.perWorkerConcurrency} · 틱당 최대 ${MAX_PER_TICK})`);
}
