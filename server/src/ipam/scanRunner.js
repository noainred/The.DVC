/**
 * scanRunner.js — 스캔을 **별도 프로세스**에서 실행하는 공용 실행기(v2.363).
 * 중앙(scanPoller)·엣지(agent/ipScanWorker) 둘 다 이걸 통해 스캔한다 — 어느 쪽이든 스캔 부하를
 * 메인 프로세스에서 떼어내 격리한다.
 *
 * 동작: scanWorker.js 를 fork → job 전송 → progress/done/error 수신 → 결과 반환.
 *  - **데드라인**: 자식이 기한 내 안 끝나면 SIGKILL(부모 이벤트 루프는 절대 안 막힘).
 *  - **인라인 폴백**: fork 실패/워커 비활성(IPAM_SCAN_WORKER=0)/자식 오류 시 같은 프로세스에서
 *    scanRanges 로 폴백(기능은 유지 — writeWorker 패턴과 동일). 폴백도 ping 동시성 상한이 있어 안전.
 *  - v2.732(점검 2회차 B4-02): **데드라인 초과는 폴백 대상이 아니다**. 예전에는 데드라인 오류도 같은 catch 로 들어가
 *    같은 스캔을 메인 프로세스에서 시한 없이 처음부터 다시 돌렸다(재현: 데드라인 60초 + 인라인 75초 = 135초, 그동안
 *    TCP 소켓·ping 자식·역DNS 부하가 v2.363 이 떼어낸 메인 포탈로 돌아온다). 데드라인 오류에 code SCAN_DEADLINE 을 붙이고
 *    그 오류는 그대로 던진다 — 호출부(scanPoller·agent/ipScanWorker)가 이미 실패를 lastRun·스캔 로그·엣지 상태에 남긴다.
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanRanges } from './scan.js';
import { deadlineMs as clampDeadlineMs } from '../util/deadline.js';

const WORKER = fileURLToPath(new URL('./scanWorker.js', import.meta.url));
const workerEnabled = () => process.env.IPAM_SCAN_WORKER !== '0';
// 기본 데드라인: 스캔이 아무리 커도 이 안엔 끝나야 한다(초과 시 자식 강제 종료). 환경변수로 조정.
// v2.611 TIM2611-03: 상한 없는 `Math.max(60_000, env)` 는 2^31ms 초과·Infinity 를 그대로 setTimeout 에 넘겨 **1ms** 가 됐다
// (워커를 띄우자마자 '데드라인 초과' 로 죽여 스캔 전량 실패). 시한 관문 deadlineMs(상한 2시간)를 거치고 하한 60초는 유지한다.
export const scanDeadlineMs = (v) => Math.max(60_000, clampDeadlineMs(v, 20 * 60_000));
const DEADLINE_MS = scanDeadlineMs(process.env.IPAM_SCAN_DEADLINE_MS);

/** 데드라인 초과 오류의 표지(v2.732 B4-02) — 이 오류는 인라인으로 다시 돌리지 않는다. */
export const SCAN_DEADLINE_CODE = 'SCAN_DEADLINE';

/**
 * 워커 경로 실패를 같은 프로세스에서 다시 돌려도 되는가(순수).
 * fork 실패·워커 오류·결과 없는 종료 → true(기능 유지) · 데드라인 초과 → false(같은 스캔을 시한 없이 메인에서 다시 돌리지 않는다).
 */
export function fallbackAllowed(err) {
  return err?.code !== SCAN_DEADLINE_CODE;
}

// 테스트 전용: 하한 60초 없이 워커 데드라인을 짧게(그대로 두면 데드라인 경로 테스트 하나가 60초를 쓴다). 운영 경로는 쓰지 않는다.
let _testDeadlineMs = null;
export function _setScanDeadlineOverrideForTest(ms) {
  _testDeadlineMs = Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * @param {object} job { ranges, ports, concurrency, timeoutMs, reverseDns, ping }
 * @param {object} opts { onProgress?, deadlineMs? }
 * @returns {Promise<{scanned:number, alive:Array, viaWorker:boolean}>}
 */
export async function runScan(job, { onProgress, deadlineMs = DEADLINE_MS } = {}) {
  if (workerEnabled()) {
    try {
      return await runInWorker(job, onProgress, scanDeadlineMs(deadlineMs));
    } catch (e) {
      // v2.732 B4-02: 데드라인 초과는 폴백하지 않고 던진다(같은 스캔을 메인에서 시한 없이 다시 돌리지 않게).
      if (!fallbackAllowed(e)) {
        console.warn(`[ipscan] 워커 스캔 데드라인 초과 — 메인 프로세스에서 다시 돌리지 않는다: ${e?.message || e}`);
        throw e;
      }
      // 워커 경로 실패(fork·자식 오류)는 인라인 폴백(기능 유지). 사유는 남긴다.
      console.warn(`[ipscan] 워커 프로세스 실패 — 인라인 폴백: ${e?.message || e}`);
    }
  }
  const r = await scanRanges(job.ranges || [], {
    ports: job.ports, concurrency: job.concurrency, timeoutMs: job.timeoutMs, reverseDns: job.reverseDns, ping: job.ping,
    onProgress,
  });
  return { ...r, viaWorker: false };
}

function runInWorker(job, onProgress, deadlineMs) {
  if (_testDeadlineMs != null) deadlineMs = _testDeadlineMs;
  return new Promise((resolve, reject) => {
    let child;
    try { child = fork(WORKER, [], { windowsHide: true }); }
    catch (e) { return reject(e); }
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { child.removeAllListeners(); } catch { /* */ }
      try { child.kill('SIGTERM'); } catch { /* */ }
      // TERM 무시 시 강제 종료(자식이 wedge 돼도 좀비로 안 남게).
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 2_000).unref?.();
      fn(arg);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* */ }
      const err = new Error(`스캔 데드라인(${Math.round(deadlineMs / 1000)}s) 초과 — 자식 종료`);
      err.code = SCAN_DEADLINE_CODE;
      finish(reject, err);
    }, deadlineMs);
    timer.unref?.();

    child.on('message', (m) => {
      if (!m) return;
      if (m.type === 'progress') { try { onProgress?.(m.done, m.total, m.alive); } catch { /* */ } return; }
      if (m.type === 'done') return finish(resolve, { scanned: m.scanned, alive: m.alive || [], viaWorker: true });
      if (m.type === 'error') return finish(reject, new Error(m.message || '워커 오류'));
    });
    child.on('error', (e) => finish(reject, e));      // spawn 실패 등
    child.on('exit', (code) => { if (!settled) finish(reject, new Error(`워커가 결과 없이 종료(code=${code})`)); });

    try { child.send({ job }); }
    catch (e) { finish(reject, e); }
  });
}
