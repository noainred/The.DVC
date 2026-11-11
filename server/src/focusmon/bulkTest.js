/**
 * focusmon/bulkTest.js — 서버 집중 모니터링 **일괄 연결 시험**(v2.978 — 사용자 'Csv 대량 서버 등록' · '넣은 서버 일괄 시험').
 *
 *  · 작업은 노드 전체에 하나(동시 1건) — 두 사람이 500대를 동시에 시험해 로그인이 두 배가 되지 않게.
 *  · 중앙 몫은 BULK_CONCURRENCY(4)대씩 차례로(SSH 핸드셰이크가 장비당 수 초 — 500대 × 4병렬 ≈ 수 분). 엣지 몫은 그 엣지 대기열에 넣고
 *    엣지마다 한 번 깨운다(엣지는 동기화마다 최대 20건 · 같은 시험은 60초에 한 번 배달 — store.pendingTestsFor).
 *  · 대상마다 시험 문턱(라우트의 TEST_MIN_MS · 진행 중 1건)을 그대로 지킨다 — 접수 때는 `peek(id)` 로 보기만 하고, 문턱은 **그 대상을 실제로 시작할 때**
 *    `gate(id)` 로 잡는다(반증 6 — 접수 때 다 잡으면 아직 차례가 오지 않은 서버의 단독 시험까지 수십 분 429 였다). 못 잡으면 건너뛰고 센다.
 *  · 인증 정지인 대상은 시험이 'auth-stopped' 로 끝난다(runner.test → testTarget 이 정지를 먼저 본다) — 일괄 시험이 정지를 풀지 않는다.
 *  · 진행률은 저장하지 않고 **계산한다**(store.testOf 의 결과 시각 ≥ 작업 시작) — 결과의 사실 원천은 시험 기록 하나다.
 */
import { poolSettled } from '../util/pool.js';

export const BULK_CONCURRENCY = 4;
/** 이보다 오래된 작업은 끝난 것으로 본다 — 엣지 시험 대기열 수명(store.EDGE_TEST_TTL_MS 15분) + 여유. 그때까지 답이 없으면 '답 없음' 으로 센다. */
export const BULK_TTL_MS = 16 * 60_000;
/** 중앙 몫의 시한 — 이 뒤로는 새 대상을 시작하지 않고 '건너뜀' 으로 센다(반증 6 — 500대 × 시험 시한이면 30분 넘게 전역 잠금을 쥐었다). */
export const BULK_CENTRAL_MAX_MS = 10 * 60_000;

let job = null; // { id, startedAt, by, ids:string[], centralIds:Set, skipped:string[], centralRunning:boolean, finishedAt }

export function bulkJob() { return job; }

/** 진행 중인 작업이 있는가(중앙 몫이 아직 돌거나, 시한 안에 답을 기다리는 시험이 있음). */
export function bulkBusy(testOf, now = Date.now()) {
  if (!job) return false;
  const p = bulkProgress(job, testOf, now);
  return !p.finished;
}

/**
 * 진행률(순수 — testOf 주입). done = 이번 작업 뒤에 결과가 온 수 · ok/fail 은 그 가운데.
 * @returns {{startedAt:number, by:string, total:number, done:number, ok:number, fail:number, skipped:number, waiting:number, noAnswer:number, finished:boolean, kinds:Object<string,number>}}
 */
export function bulkProgress(j, testOf, now = Date.now()) {
  if (!j) return null;
  let done = 0; let ok = 0; let fail = 0; const kinds = {};
  const skipped = new Set(j.skipped || []);
  for (const id of j.ids) {
    if (skipped.has(id)) continue;
    const t = testOf(id);
    if (t && t.result && Number(t.at) >= j.startedAt) {
      done += 1;
      if (t.result.ok) ok += 1; else fail += 1;
      const k = String(t.result.kind || 'error'); kinds[k] = (kinds[k] || 0) + 1;
    }
  }
  const asked = j.ids.length - skipped.size;
  const expired = now - j.startedAt > BULK_TTL_MS;
  const finished = !j.centralRunning && (done >= asked || expired);
  return {
    startedAt: j.startedAt, by: j.by, total: j.ids.length, done, ok, fail, skipped: skipped.size,
    waiting: finished ? 0 : asked - done, noAnswer: finished ? asked - done : 0, finished, kinds,
  };
}

/**
 * 작업 시작 — 동기적으로 접수만 하고 중앙 몫은 뒤에서 돈다.
 * @param {{targets:object[], by:string, gate:(id:string)=>boolean, release:(id:string)=>void, testLocal:(t)=>Promise<object>, putResult:(id,r)=>void,
 *          queueEdge:(t)=>void, wake:(agent:string)=>void, testOf:(id)=>object, now?:number}} o
 * @returns {{ok:true, job:object} | {ok:false, code:'busy', reason:string}}
 */
export function startBulk(o) {
  const now = o.now ?? Date.now();
  if (bulkBusy(o.testOf, now)) return { ok: false, code: 'busy', reason: '다른 일괄 시험이 진행 중입니다 — 끝난 뒤 다시 누르세요.' };
  const ids = []; const skipped = []; const central = []; const edges = new Map();
  const peek = o.peek || (() => true);
  for (const t of o.targets) {
    ids.push(t.id);
    if (t.agent && !t.demo) {
      if (!o.gate(t.id)) { skipped.push(t.id); continue; }
      o.queueEdge(t); edges.set(String(t.agent).toLowerCase(), t.agent); o.release(t.id);
    } else if (!peek(t.id)) skipped.push(t.id);
    else central.push(t);
  }
  job = { id: `bt-${now.toString(36)}`, startedAt: now, by: String(o.by || '').slice(0, 64), ids, skipped, centralRunning: central.length > 0, finishedAt: 0 };
  const mine = job;
  for (const a of edges.values()) { try { o.wake(a); } catch { /* 깨우기 실패 — 엣지의 쉬는 주기 조회가 받는다 */ } }
  if (central.length) {
    // 동시성 풀은 util/pool.js 하나(손으로 쓴 사본 금지 — 스윕이 고정) · 항목마다 성패를 따로(poolSettled).
    const deadline = now + BULK_CENTRAL_MAX_MS;
    poolSettled(central, BULK_CONCURRENCY, async (t) => {
      if (Date.now() > deadline || !o.gate(t.id)) { mine.skipped.push(t.id); return; } // 시한이 지났거나 그사이 단독 시험이 문턱을 잡았다
      try { o.putResult(t.id, await o.testLocal(t)); }
      catch (e) { o.putResult(t.id, { ok: false, kind: 'unreachable', error: String(e?.message || e).slice(0, 200) }); }
      finally { o.release(t.id); }
    }).catch(() => {}).finally(() => { mine.centralRunning = false; mine.finishedAt = Date.now(); });
  }
  return { ok: true, job: { id: job.id, startedAt: job.startedAt, total: ids.length, skipped: skipped.length, central: central.length, edges: edges.size } };
}

export function _resetBulkForTest() { job = null; }
