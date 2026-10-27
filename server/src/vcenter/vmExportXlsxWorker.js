/**
 * 'VM 전체 정보 내보내기' 엑셀 워커(v2.799) — 워크북 조립·직렬화를 메인 이벤트 루프 밖에서 한다(util/xlsxWorkerRun.js 머리말).
 * 표·글자는 메인과 같은 buildVmExportWorkbook 이다(결과 파일이 같다).
 */
import { parentPort } from 'node:worker_threads';
import { serveXlsxWorker } from '../util/xlsxWorkerRun.js';
import { buildVmExportWorkbook } from './vmExportXlsx.js';

serveXlsxWorker(parentPort, buildVmExportWorkbook);
