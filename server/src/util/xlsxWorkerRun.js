/**
 * util/xlsxWorkerRun.js — 엑셀 조립·직렬화를 워커 스레드에서 돌리는 실행기(v2.799, 공용).
 *
 * 왜: exceljs 의 `writeBuffer`(시트 XML 직렬화·압축)는 쪼갤 수 없는 동기 코드다 — 큰 표는 메인 이벤트 루프를 초 단위로 멈춘다
 *   (storage/usageXlsx.js v2.791 실측 1.5초 · ipam/excelWorker.js 와 같은 이유). 그 두 곳과 veeam/vmListXlsx.js 는 각자 같은 실행기를 갖고 있다
 *   — 새 엑셀은 이 공용판을 쓴다(그 셋을 옮기는 것은 별건).
 *
 * 워커 파일 규약(메시지): 메인 → 워커 { type:'build', payload } · 워커 → 메인 { type:'ready' } · { type:'done', buf: ArrayBuffer, meta } · { type:'error', message }.
 * 'ready' 전에 실패하면 inline(payload) 로 메인에서 만든다(포탈이 멈출 수 있다고 경고) · 'ready' 뒤의 실패는 다시 하지 않는다
 * (같은 입력이면 같은 오류, 메모리 부족이면 메인을 죽인다) · 시한이 지나면 끝낸다 · 끝나면 terminate · 요청이 끊기면(signal) 멈춘다.
 */
import { Worker } from 'node:worker_threads';
import { deadlineMs } from './deadline.js';

const READY_TIMEOUT_MS = 60_000;
const codedError = (code, message) => Object.assign(new Error(message), { code });

/**
 * @param {{ workerUrl:URL, payload:any, inline:(payload:any)=>Promise<{buffer:Buffer, meta?:object}>, timeoutMs?:number|string, signal?:AbortSignal|null,
 *           tag?:string, disabled?:boolean }} job
 * @returns {Promise<{buffer:Buffer, meta:object, mode:'worker'|'inline', reason?:string}>}
 */
export async function runXlsxWorker({ workerUrl, payload, inline, timeoutMs = 300_000, signal = null, tag = 'xlsx', disabled = false }) {
  const aborted = () => codedError('aborted', '요청이 끊겨 엑셀 생성을 멈췄습니다.');
  if (signal?.aborted) throw aborted();
  const runInline = async (reason) => { const r = await inline(payload); return { buffer: r.buffer, meta: r.meta || {}, mode: 'inline', reason }; };
  if (disabled) return runInline('disabled');
  const limit = deadlineMs(timeoutMs, 300_000);
  let worker;
  try { worker = new Worker(workerUrl); } catch (err) {
    console.warn(`[${tag}] 엑셀 워커를 띄우지 못했습니다(${err.message}) — 메인 스레드에서 만듭니다(그동안 포탈 응답이 멈출 수 있습니다).`);
    return runInline('spawn-failed');
  }
  let ready = false; let settled = false; let timer = null; let readyTimer = null;
  const outcome = await new Promise((resolve) => {
    const onAbort = () => finish({ err: aborted() });
    function finish(v) {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(readyTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      worker.removeAllListeners('message'); worker.removeAllListeners('error'); worker.removeAllListeners('exit');
      worker.on('error', () => {});
      worker.terminate().catch(() => {});
      resolve(v);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    readyTimer = setTimeout(() => finish({ startFailed: `기동 ${Math.round(READY_TIMEOUT_MS / 1000)}초 안에 준비되지 않음` }), READY_TIMEOUT_MS);
    timer = setTimeout(() => finish({ err: codedError('timeout', `엑셀 생성이 ${Math.round(limit / 1000)}초 안에 끝나지 않아 멈췄습니다.`) }), limit);
    worker.on('message', (msg) => {
      if (msg?.type === 'ready') {
        ready = true; clearTimeout(readyTimer);
        try { worker.postMessage({ type: 'build', payload }); } catch (err) { finish({ err: codedError('worker-error', `엑셀 워커로 보내지 못했습니다: ${String(err?.message || err).slice(0, 300)}`) }); }
        return;
      }
      if (msg?.type === 'done' && msg.buf instanceof ArrayBuffer) return finish({ buffer: Buffer.from(msg.buf), meta: msg.meta || {} });
      if (msg?.type === 'error') return finish({ err: codedError('worker-error', `엑셀 생성 실패: ${String(msg.message || '알 수 없는 오류').slice(0, 300)}`) });
    });
    worker.on('error', (err) => {
      if (!ready) return finish({ startFailed: err?.message || String(err) });
      const oom = err?.code === 'ERR_WORKER_OUT_OF_MEMORY';
      finish({ err: codedError(oom ? 'worker-oom' : 'worker-error', oom ? '엑셀 워커가 메모리 한도를 넘어 끝났습니다(포탈은 영향 없음).' : `엑셀 워커 오류: ${String(err?.message || err).slice(0, 300)}`) });
    });
    worker.on('exit', (code) => {
      if (!ready) return finish({ startFailed: `기동 중 종료(코드 ${code})` });
      finish({ err: codedError('worker-exit', `엑셀 워커가 결과 없이 끝났습니다(코드 ${code}).`) });
    });
  });
  if (outcome.startFailed != null) {
    if (signal?.aborted) throw aborted();
    console.warn(`[${tag}] 엑셀 워커를 띄우지 못했습니다(${outcome.startFailed}) — 메인 스레드에서 만듭니다(그동안 포탈 응답이 멈출 수 있습니다).`);
    return runInline('spawn-failed');
  }
  if (outcome.err) throw outcome.err;
  return { buffer: outcome.buffer, meta: outcome.meta, mode: 'worker' };
}

/** 워커 쪽 — build(payload) → { buffer, meta } 를 메시지 규약으로 감싼다(워커 파일은 이 한 줄이면 된다). */
export function serveXlsxWorker(parentPort, build) {
  parentPort.on('message', async (msg) => {
    if (msg?.type !== 'build') return;
    try {
      const out = await build(msg.payload);
      const b = out.buffer;
      // 작은 Buffer 는 공용 풀의 조각일 수 있다 — 그 바이트만 담은 ArrayBuffer 로 넘긴다(ipam/excelWorker.js 와 같다).
      const ab = (b.byteOffset === 0 && b.buffer.byteLength === b.byteLength) ? b.buffer : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      parentPort.postMessage({ type: 'done', buf: ab, meta: out.meta || {} }, [ab]);
    } catch (err) {
      parentPort.postMessage({ type: 'error', message: String(err?.message || err) });
    }
  });
  parentPort.postMessage({ type: 'ready' });
}
