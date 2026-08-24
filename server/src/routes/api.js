import { Router } from 'express';
import { registerVmMetrics } from './api/vmMetrics.js';
import { registerOverviewNsx } from './api/overviewNsx.js';
import { registerProvision } from './api/provision.js';
import { registerVcTools } from './api/vcTools.js';
import { registerReports } from './api/reports.js';
import { registerSearchNotes } from './api/searchNotes.js';
import { registerIpamExport } from './api/ipamExport.js';
import { registerHardwareGpu } from './api/hardwareGpu.js';
import { registerChecksLogs } from './api/checksLogs.js';
import { registerToolsAnalytics } from './api/toolsAnalytics.js';
import { registerToolsCapacity } from './api/toolsCapacity.js';
import { registerToolsInfo } from './api/toolsInfo.js';
import { registerInventory } from './api/inventory.js';
import { registerVmClone } from './api/vmClone.js'; // VM 복제(백업식, v2.299)
import { registerStorageMon } from './api/storageMon.js'; // 스토리지 모니터링(Isilon 등, v2.302)
import { registerBmStorage } from './api/bmstor.js'; // 베어메탈 스토리지(SSH df 마운트 합산, v2.340)
import { registerVmTrack } from './api/vmtrack.js'; // VM 수량 추이(00/12시 스냅샷 + 증감 상세, v2.345)

// 특수기능/인벤토리 API 집계 라우터 — v2.283.0 대형 파일 분할.
// 도메인 구현은 ./api/*.js 로 이동. ⚠️ register 호출 순서 = 라우트 등록 순서(Express 매칭 순서)이므로
// 원본(단일 파일 시절) 정의 순서를 그대로 유지한다. 새 라우트 추가 시 해당 도메인 모듈에 넣을 것.
// RBAC(requirePerm)·scope 강제는 각 모듈 라우트에 그대로 있다(CLAUDE.md 보안 불변조건).
export const api = Router();
registerVmMetrics(api);
registerOverviewNsx(api);
registerProvision(api);
registerVcTools(api);
registerReports(api);
registerSearchNotes(api);
registerIpamExport(api);
registerHardwareGpu(api);
registerChecksLogs(api);
registerToolsAnalytics(api);
registerToolsCapacity(api);
registerToolsInfo(api);
registerInventory(api);
registerVmClone(api);
registerStorageMon(api);
registerBmStorage(api);
registerVmTrack(api);
