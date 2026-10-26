/**
 * 스토리지 사용량 엑셀 워커(v2.791) — 워크북 조립·직렬화를 메인 이벤트 루프 밖에서 한다(IP 대장 ipam/excelWorker.js 와 같은 이유·같은 모양).
 *
 * 왜: exceljs 의 `writeBuffer`(시트 XML 직렬화·압축)는 쪼갤 수 없는 동기 코드다. 전체 누적(5년 · 장비 79대 합성)에서 메인 스레드가
 *   **최대 1.5초 멈췄다**(작성 중 실측 — scratchpad x2790/lag.mjs). 예약 메일 시각에 포탈 전체가 멈추면 안 된다.
 *
 * 메시지(메인 → 워커): { type:'build', rep, opts }  보고표(slim) · {includeResources, dataWeeks, stamp}
 * 메시지(워커 → 메인): { type:'ready' } · { type:'done', buf: ArrayBuffer, meta } · { type:'error', message }
 * 판단·숫자는 메인과 **같은 buildInsights · buildUsageWorkbook** 이다(결과 파일이 같다 — 테스트가 대조).
 */
import { parentPort } from 'node:worker_threads';
import { buildInsights } from './usageInsights.js';
import { buildUsageWorkbook } from './usageXlsx.js';

parentPort.on('message', async (msg) => {
  if (msg?.type !== 'build') return;
  try {
    const o = msg.opts || {};
    const ins = buildInsights(msg.rep, { includeResources: o.includeResources !== false });
    const out = await buildUsageWorkbook(msg.rep, ins, { dataWeeks: o.dataWeeks ?? null, stamp: o.stamp || '' });
    const b = out.buffer;
    // 작은 Buffer 는 공용 풀의 조각일 수 있다 — 그 바이트만 담은 ArrayBuffer 로 넘긴다(ipam/excelWorker.js 와 같다).
    const ab = (b.byteOffset === 0 && b.buffer.byteLength === b.byteLength) ? b.buffer : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    parentPort.postMessage({ type: 'done', buf: ab, meta: { filename: out.filename, dataRows: out.dataRows, dataTrimmed: out.dataTrimmed, weeks: out.weeks, trimmedNote: out.trimmedNote } }, [ab]);
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: String(err?.message || err) });
  }
});

parentPort.postMessage({ type: 'ready' });
