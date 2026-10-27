/**
 * '호스트 · 클러스터 엑셀' 워커(v2.802) — 워크북 조립·직렬화를 메인 이벤트 루프 밖에서 한다(util/xlsxWorkerRun.js 머리말).
 * 시트·글자는 메인과 같은 buildHostExportWorkbook 이다(결과 파일이 같다).
 */
import { parentPort } from 'node:worker_threads';
import { serveXlsxWorker } from '../util/xlsxWorkerRun.js';
import { buildHostExportWorkbook } from './hostExportXlsx.js';

serveXlsxWorker(parentPort, buildHostExportWorkbook);
