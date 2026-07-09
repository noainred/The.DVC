/**
 * worker_threads 워커 — RetrieveProperties 응답 XML의 정규식 파싱(CPU 바운드)을
 * 메인 이벤트 루프 밖에서 수행한다. 28개 vCenter를 매 주기 수집할 때 수 MB XML을
 * 메인 스레드에서 파싱하면 그동안 HTTP 응답/다른 vCenter I/O가 지연되므로, 파싱만
 * 워커로 넘겨 메인 루프를 비운다.
 *
 * 프로토콜: 메인 → 워커 {id, buf(ArrayBuffer, transfer)} · 워커 → 메인 {id, objs} 또는 {id, error}.
 * buf는 UTF-8로 인코딩된 XML(전송으로 복사 없이 소유권 이전). 워커는 디코딩 후 파싱.
 */

import { parentPort } from 'node:worker_threads';
import { parseObjectContent } from '../vcenter/soapParse.js';

const decoder = new TextDecoder();

parentPort.on('message', (msg) => {
  const { id, buf } = msg;
  try {
    const xml = decoder.decode(new Uint8Array(buf));
    const objs = parseObjectContent(xml);
    parentPort.postMessage({ id, objs });
  } catch (e) {
    parentPort.postMessage({ id, error: e?.message || String(e) });
  }
});
