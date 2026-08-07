/**
 * 성능점검 실행 워커 — 점검 배치를 메인 스레드 밖에서 수행한다.
 *
 * 왜 워커인가(1만 대 규모 실측 근거)
 * - 점검은 네트워크 I/O 라 논블로킹이지만, 초당 수백~수천 건이면 소켓 이벤트·타이머·DNS
 *   콜백이 메인 루프의 큐를 채워 포탈의 vCenter 수집(SOAP 파싱)과 HTTP 응답을 밀어낸다.
 *   실측(1만 대상 × 3항목): 워커 분리 시 메인 루프 최대지연 19ms 유지.
 * - 워커는 상태를 갖지 않는다(streak·이전 상태는 메인이 관리) — 죽어도 재생성만 하면 된다.
 *
 * **동시성을 두 갈래로 나누는 이유(중요)**
 * - ping/trace 는 OS CLI 를 spawn 한다 → 프로세스 생성 비용·PID 한계가 병목. 높게 열면
 *   시스템이 먼저 무너진다. 그래서 별도 세마포어(procLimit, 기본 64).
 * - tcp/http/dns/배너류는 순수 소켓 대기 → CPU 를 거의 안 쓰므로 크게 열어야 한다
 *   (sockLimit 기본 256). 죽은 호스트가 많은 환경에서는 이 값이 처리량을 그대로 결정한다:
 *   초당 처리량 ≈ sockLimit ÷ 타임아웃(초).
 *
 * 프로토콜: { id, tests:[{ test, host }] } → { id, results:[{ testId, ...result }] }
 */

import { parentPort, workerData } from 'node:worker_threads';
import { runCheck } from './checker.js';

const SOCK_LIMIT = Math.max(1, Number(workerData?.sockLimit) || 256);
const PROC_LIMIT = Math.max(1, Number(workerData?.procLimit) || 64);
const PROC_TYPES = new Set(['ping', 'trace']);   // CLI 프로세스를 띄우는 유형

/** 세마포어 — 같은 배치 안에서 두 갈래를 동시에 진행시킨다. */
function makeRunner(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active += 1;
    const { fn, resolve } = queue.shift();
    fn().then(resolve, resolve).finally(() => { active -= 1; next(); });
  };
  return (fn) => new Promise((resolve) => { queue.push({ fn, resolve }); next(); });
}

const runSock = makeRunner(SOCK_LIMIT);
const runProc = makeRunner(PROC_LIMIT);

parentPort.on('message', async ({ id, tests }) => {
  const results = [];
  await Promise.all((tests || []).map(({ test, host }) => {
    const gate = PROC_TYPES.has(test.type) ? runProc : runSock;
    return gate(async () => {
      try {
        const r = await runCheck(test, host);
        results.push({ testId: test.id, ...r });
      } catch (e) {
        results.push({ testId: test.id, status: 'bad', reply: String(e?.message || e).slice(0, 120), ms: 0 });
      }
    });
  }));
  parentPort.postMessage({ id, results });
});

process.on('uncaughtException', (e) => console.error('[svcmon:worker] uncaught:', e?.message));
process.on('unhandledRejection', (e) => console.error('[svcmon:worker] rejection:', e?.message || e));
