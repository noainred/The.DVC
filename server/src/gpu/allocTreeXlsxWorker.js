/**
 * GPU 할당 계층 엑셀 워커(v2.938) — 워크북 조립·직렬화를 메인 이벤트 루프 밖에서 한다(util/xlsxWorkerRun.js 머리말).
 * 표·글자는 메인과 같은 buildGpuAllocWorkbookInline 이다(결과 파일이 같다).
 */
import { parentPort } from 'node:worker_threads';
import { serveXlsxWorker } from '../util/xlsxWorkerRun.js';
import { buildGpuAllocWorkbookPayload } from './allocTreeXlsx.js';

serveXlsxWorker(parentPort, buildGpuAllocWorkbookPayload);
