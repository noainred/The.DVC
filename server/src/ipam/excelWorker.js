/**
 * IP 대장 엑셀 워커(v2.741 감사 LEFT-01) — 워크북 조립·직렬화를 메인 이벤트 루프 밖에서 한다.
 *
 * 왜: exceljs 의 `wb.xlsx.write`(시트 XML 직렬화)는 쪼갤 수 없는 동기 코드라, 메인 스레드에서 돌면 시트 수에 비례해 포탈 전체가
 *   멈췄다(합성 /24 100개 1.6초 · 400개 6초대). 계산은 메인과 **같은 buildWorkbook** 이다 — 결과 파일이 같다(excel.js 설명).
 *
 * 메시지(메인 → 워커): { type:'sheet', sheet }  시트 하나(slimSheet — 워커가 쓰는 필드만)
 *                      { type:'end', created, total }  모은 시트로 워크북을 만들고 파일 바이트를 답한다
 * 메시지(워커 → 메인): { type:'ready' }  적재가 끝났다(이것 전에 죽으면 메인이 인라인으로 만든다)
 *                      { type:'done', buf: ArrayBuffer }  파일 바이트(복사 없이 넘긴다)
 *                      { type:'error', message }
 * 한 번 쓰고 끝낸다 — 메인이 done 을 받으면 terminate 한다(상태를 남기지 않는다).
 */

import { parentPort } from 'node:worker_threads';
import { buildWorkbook } from './excel.js';

const sheets = [];

parentPort.on('message', async (msg) => {
  if (msg?.type === 'sheet') { sheets.push(msg.sheet); return; }
  if (msg?.type !== 'end') return;
  try {
    // 받은 개수가 보낸 개수와 다르면 만들지 않는다 — 일부만 담긴 파일을 '전체' 로 내보내지 않는다.
    if (Number.isFinite(msg.total) && msg.total !== sheets.length) throw new Error(`받은 시트 ${sheets.length}개 · 보낸 시트 ${msg.total}개`);
    const wb = await buildWorkbook(sheets, { created: msg.created });
    const buf = await wb.xlsx.writeBuffer();
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    // 작은 Buffer 는 공용 풀의 조각일 수 있다 — 넘길 때는 그 바이트만 담은 ArrayBuffer 로(풀 전체를 넘기지 않게).
    const ab = (b.byteOffset === 0 && b.buffer.byteLength === b.byteLength) ? b.buffer : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    parentPort.postMessage({ type: 'done', buf: ab }, [ab]);
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: String(err?.message || err) });
  }
});

parentPort.postMessage({ type: 'ready' });
