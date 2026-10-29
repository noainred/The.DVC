/**
 * VM 목록 엑셀 워커(v2.792) — 워크북 조립·직렬화를 메인 이벤트 루프 밖에서 한다(storage/usageXlsxWorker.js 와 같은 이유·같은 모양).
 *
 * 메시지(메인 → 워커): { type:'build', input }  buildVmListWorkbook 입력(rows 는 slimVmRows)
 * 메시지(워커 → 메인): { type:'ready' } · { type:'done', buf: ArrayBuffer, meta } · { type:'error', message }
 * 판단·숫자는 메인과 **같은 buildVmListWorkbook** 이다(인라인 경로와 같은 파일).
 */
import { parentPort } from 'node:worker_threads';
import { buildVmListWorkbook } from './vmListXlsx.js';

parentPort.on('message', async (msg) => {
  if (msg?.type !== 'build') return;
  try {
    const out = await buildVmListWorkbook(msg.input || {});
    const b = out.buffer;
    // 작은 Buffer 는 공용 풀의 조각일 수 있다 — 그 바이트만 담은 ArrayBuffer 로 넘긴다(ipam/excelWorker.js 와 같다).
    const ab = (b.byteOffset === 0 && b.buffer.byteLength === b.byteLength) ? b.buffer : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    parentPort.postMessage({ type: 'done', buf: ab, meta: { rows: out.rows, folders: out.folders, outlineLevels: out.outlineLevels } }, [ab]);
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: String(err?.message || err) });
  }
});

parentPort.postMessage({ type: 'ready' });
