/**
 * 서버 하드웨어 정보 엑셀 워커(v2.966) — 워크북 조립 · 직렬화를 메인 이벤트 루프 밖에서 한다(util/xlsxWorkerRun.js 머리말).
 * 표 · 글자는 메인과 같은 buildHwWorkbookPayload 다(결과 파일이 같다).
 */
import { parentPort } from 'node:worker_threads';
import { serveXlsxWorker } from '../../util/xlsxWorkerRun.js';
import { buildHwWorkbookPayload } from './render.js';

serveXlsxWorker(parentPort, buildHwWorkbookPayload);
