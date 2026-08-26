/**
 * scanRunner.js — 스캔을 **별도 프로세스**에서 실행하는 공용 실행기(v2.363).
 * 중앙(scanPoller)·엣지(agent/ipScanWorker) 둘 다 이걸 통해 스캔한다 — 어느 쪽이든 스캔 부하를
 * 메인 프로세스에서 떼어내 격리한다.
 *
 * 동작: scanWorker.js 를 fork → job 전송 → progress/done/error 수신 → 결과 반환.
 *  - **데드라인**: 자식이 기한 내 안 끝나면 SIGKILL(부모 이벤트 루프는 절대 안 막힘).
 *  - **인라인 폴백**: fork 실패/워커 비활성(IPAM_SCAN_WORKER=0)/자식 오류 시 같은 프로세스에서
 *    scanRanges 로 폴백(기능은 유지 — writeWorker 패턴과 동일). 폴백도 ping 동시성 상한이 있어 안전.
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanRanges } from './scan.js';

const WORKER = fileURLToPath(new URL('./scanWorker.js', import.meta.url));
const workerEnabled = () => process.env.IPAM_SCAN_WORKER !== '0';
// 기본 데드라인: 스캔이 아무리 커도 이 안엔 끝나야 한다(초과 시 자식 강제 종료). 환경변수로 조정.
const DEADLINE_MS = Math.max(60_000, Number(process.env.IPAM_SCAN_DEADLINE_MS) || 20 * 60_000);

/**
 * @param {object} job { ranges, ports, concurrency, timeoutMs, reverseDns, ping }
 * @param {object} opts { onProgress?, deadlineMs? }
 * @returns {Promise<{scanned:number, alive:Array, viaWorker:boolean}>}
 */
export async function runScan(job, { onProgress, deadlineMs = DEADLINE_MS } = {}) {
  if (workerEnabled()) {
    try {
      return await runInWorker(job, onProgress, deadlineMs);
    } catch (e) {
      // 워커 경로 실패는 조용히 인라인 폴백(기능 유지). 사유는 남긴다.
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
      finish(reject, new Error(`스캔 데드라인(${Math.round(deadlineMs / 1000)}s) 초과 — 자식 종료`));
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
