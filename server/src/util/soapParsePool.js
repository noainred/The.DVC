/**
 * SOAP 파싱 워커 풀 — RetrieveProperties 응답의 CPU 바운드 정규식 파싱을 worker_threads로
 * 오프로딩해 메인 이벤트 루프 블로킹을 없앤다(28+ vCenter·고RTT 환경에서 매 주기 파싱이
 * 메인 스레드를 점유하면 HTTP 응답/다른 vCenter 수집이 밀린다).
 *
 * 설계 원칙(회귀 방지):
 *  - best-effort: 워커 생성 실패·비활성·소형 페이로드는 메인 스레드 인라인 파싱으로 폴백
 *    (기존 동작과 100% 동일 결과). 워커는 순수 파서(soapParse.js)만 로드 — DB/네트워크 무접촉.
 *  - 소형 XML은 오프로딩하지 않는다: 전송+왕복 오버헤드가 인라인 파싱보다 커서 역효과.
 *    임계값 이상(대형 vCenter 응답)만 워커로 넘긴다.
 *  - 지연 초기화: 첫 대형 파싱 때 워커 생성. 동시성은 수집 동시성(COLLECT_CONCURRENCY)에
 *    맞춰 소수(기본 min(4, cpus-1))만 둔다 — 파싱은 짧고 버스티하므로 과다 스레드는 낭비.
 *  - 워커 죽으면 해당 in-flight는 인라인으로 재처리하고 워커를 재생성(자기치유).
 */

import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { parseObjectContent } from '../vcenter/soapParse.js';

// 이 크기(문자) 미만 XML은 워커로 넘기지 않고 인라인 파싱(오프로딩 오버헤드 회피).
const MIN_OFFLOAD_CHARS = Number(process.env.SOAP_PARSE_MIN_CHARS || 262_144); // 256KB
// 워커 수(0이면 오프로딩 완전 비활성 → 항상 인라인).
const WORKER_COUNT = (() => {
  const env = process.env.SOAP_PARSE_WORKERS;
  if (env != null && env !== '') return Math.max(0, Number(env) || 0);
  return Math.max(1, Math.min(4, (os.cpus()?.length || 2) - 1));
})();

const encoder = new TextEncoder();
let pool = null; // { workers:[{w, busy}], queue:[], pending:Map, seq } | null(비활성/실패)
let poolBroken = false; // 초기화가 한 번 실패하면 이후 계속 인라인(재시도 폭주 방지)

const RESPAWN_WINDOW_MS = 60_000;
export const RESPAWN_MAX = 5;
let _respawns = [];
let _respawnWarned = false;

let _workerUrlOverride = null;
function workerUrl() {
  return _workerUrlOverride || new URL('./parseWorker.js', import.meta.url);
}
/** 테스트 전용 — 워커 진입점을 바꾼다(뜨자마자 죽는 워커로 재생성 한도를 확인한다). */
export function _setWorkerUrlForTest(u) { _workerUrlOverride = u || null; }

function spawnWorker() {
  const w = new Worker(workerUrl());
  const slot = { w, busy: false };
  w.on('message', (msg) => {
    const task = pool?.pending.get(msg.id);
    if (task) {
      pool.pending.delete(msg.id);
      slot.busy = false;
      slot.taskId = null;
      slot.w.unref?.();          // 유휴 워커는 unref — 프로세스 종료를 막지 않음.
      if (msg.error) task.reject(new Error(msg.error));
      else task.resolve(msg.objs);
    }
    drain();
  });
  const onDown = () => {
    // 워커 크래시는 'error' 와 'exit(code!=0)' 를 **둘 다** 발생시킨다 → onDown 이 두 번 불린다.
    // 멱등 가드가 없으면 두 번째 호출의 filter 는 no-op 이고 재생성만 한 번 더 일어나, 크래시마다
    // 워커가 +1 누수된다(유휴 스레드·메모리 증가). 한 번만 처리한다.
    if (slot.down) return;
    slot.down = true;
    // 워커가 죽으면 이 워커가 물고 있던 작업을 인라인으로 재처리하고 워커를 재생성.
    const wasId = slot.taskId;
    slot.taskId = null;
    slot.busy = false;
    if (wasId != null) {
      const task = pool?.pending.get(wasId);
      if (task) {
        pool.pending.delete(wasId);
        try { task.resolve(parseObjectContent(task.xml)); } catch (e) { task.reject(e); }
      }
    }
    if (pool) {
      pool.workers = pool.workers.filter((s) => s !== slot);
      // v3.10.5(공용 유틸 점검 3회차): 재생성에 한도를 둔다 — 워커가 뜨자마자 죽으면(설치본에 parseWorker.js 가 없거나 깨짐) 'error' →
      //   재생성 → 'error' 가 쉬지 않고 이어져 스레드를 끝없이 만들고 버렸다. 1분에 RESPAWN_MAX 번을 넘으면 더 만들지 않고,
      //   남은 워커가 없으면 풀을 접고 메인 스레드에서 파싱한다(수집은 멈추지 않는다 — 큐의 작업도 그 자리에서 처리).
      const now = Date.now();
      _respawns = _respawns.filter((t) => now - t < RESPAWN_WINDOW_MS);
      if (_respawns.length < RESPAWN_MAX) {
        _respawns.push(now);
        try { pool.workers.push(spawnWorker()); } catch { /* 재생성 실패 시 남은 워커로 지속 */ }
      } else if (!_respawnWarned) {
        _respawnWarned = true;
        try { console.warn(`[soap-parse] 파싱 워커가 1분에 ${RESPAWN_MAX}번 넘게 죽어 더 띄우지 않습니다 — 남은 워커${pool.workers.length ? ` ${pool.workers.length}개` : '가 없어 메인 스레드'}로 파싱합니다.`); } catch { /* */ }
      }
      if (!pool.workers.length) {
        const p = pool;
        pool = null;
        poolBroken = true;
        for (const t of p.queue.splice(0)) { try { t.resolve(parseObjectContent(t.xml)); } catch (e) { t.reject(e); } }
        return;
      }
      // ⚠ 회귀 방지(v2.287, 확정 버그 #8): 죽은 워커가 물고 있던 1건만 재처리하고 drain 을
      // 부르지 않으면, 큐에 대기 중이던 나머지 파싱 작업의 Promise 가 영원히 pending 으로 남는다
      // (drain 은 push·다른 워커 message 에서만 돌고, parseObjectContentAsync 엔 타임아웃이 없다).
      // 2vCPU 서버는 워커가 1개뿐이라 그 워커가 크래시하면 수집 파이프라인이 통째로 멈췄다.
      // 재생성한 유휴 워커에 큐 잔여 작업을 즉시 배정한다.
      drain();
    }
  };
  w.on('error', onDown);
  w.on('exit', (code) => { if (code !== 0) onDown(); });
  w.unref?.();
  return slot;
}

function ensurePool() {
  if (pool || poolBroken || WORKER_COUNT === 0) return pool;
  try {
    const workers = [];
    for (let i = 0; i < WORKER_COUNT; i++) workers.push(spawnWorker());
    pool = { workers, queue: [], pending: new Map(), seq: 0 };
  } catch {
    poolBroken = true; // 워커 미지원 환경 → 이후 항상 인라인
    pool = null;
  }
  return pool;
}

function drain() {
  if (!pool) return;
  while (pool.queue.length) {
    const slot = pool.workers.find((s) => !s.busy);
    if (!slot) break;
    const task = pool.queue.shift();
    slot.busy = true;
    slot.taskId = task.id;
    slot.w.ref?.();              // 처리 중에는 ref — 파싱 완료 전 이벤트 루프가 종료되지 않게.
    pool.pending.set(task.id, task);
    const bytes = encoder.encode(task.xml);
    // ArrayBuffer 소유권 이전(zero-copy). bytes는 이 스코프에서 더 안 씀.
    task.slot = slot;
    slot.w.postMessage({ id: task.id, buf: bytes.buffer }, [bytes.buffer]);
  }
}

/**
 * RetrieveProperties 응답 XML을 파싱해 [{type, ref, props}] 반환.
 * 대형 페이로드는 워커로 오프로딩, 그 외/실패 시 메인 스레드 인라인 파싱(동일 결과).
 */
export async function parseObjectContentAsync(xml) {
  if (!xml || xml.length < MIN_OFFLOAD_CHARS) return parseObjectContent(xml);
  const p = ensurePool();
  if (!p) return parseObjectContent(xml);
  return new Promise((resolve, reject) => {
    const id = ++p.seq;
    p.queue.push({
      id, xml,
      resolve, reject: (e) => {
        // 워커 경로가 실패하면 메인 스레드 인라인으로 안전 폴백(수집을 죽이지 않는다).
        try { resolve(parseObjectContent(xml)); } catch { reject(e); }
      },
    });
    drain();
  });
}

/** 테스트/종료용: 워커를 정리하고 풀을 리셋. */
export async function shutdownParsePool() {
  const p = pool;
  pool = null;
  if (!p) return;
  await Promise.all(p.workers.map((s) => s.w.terminate().catch(() => {})));
}

/** 테스트용 내부 상태 확인. */
export function _poolInfo() {
  return { workerCount: WORKER_COUNT, minOffloadChars: MIN_OFFLOAD_CHARS, active: !!pool, broken: poolBroken, respawnsInWindow: _respawns.length };
}
