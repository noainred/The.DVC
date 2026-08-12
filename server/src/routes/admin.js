import { Router } from 'express';
import { registerStatusTools } from './admin/statusTools.js';
import { registerUsers } from './admin/users.js';
import { registerDeployLlm } from './admin/deployLlm.js';
import { registerCentralIpam } from './admin/centralIpam.js';
import { registerGpuGuest } from './admin/gpuGuest.js';
import { registerVcenters } from './admin/vcenters.js';
import { registerOpsSettings } from './admin/opsSettings.js';
import { registerNsxImport } from './admin/nsxImport.js';
import { registerIdracCore } from './admin/idracCore.js';
import { registerIdracScan } from './admin/idracScan.js';
import { registerCollectorsDc } from './admin/collectorsDc.js';
import { registerHorizonAssign } from './admin/horizonAssign.js';
import { registerBackupNetSec } from './admin/backupNetSec.js';

// 관리자 API 집계 라우터 — v2.285.0 대형 파일 분할.
// 도메인 구현은 ./admin/*.js 로 이동. ⚠️ register 호출 순서 = 라우트 등록 순서(Express 매칭 순서).
// 특히 iDRAC 정적 라우트(scan-result 등)가 /idrac/:id 보다 먼저 등록돼야 한다
// (idracRouteOrder.test.js 가 런타임으로 검증). adminOnly·requireSettingsOwner 는 admin/shared.js.
export const adminRouter = Router();
registerStatusTools(adminRouter);
registerUsers(adminRouter);
registerDeployLlm(adminRouter);
registerCentralIpam(adminRouter);
registerGpuGuest(adminRouter);
registerVcenters(adminRouter);
registerOpsSettings(adminRouter);
registerNsxImport(adminRouter);
registerIdracCore(adminRouter);
registerIdracScan(adminRouter);
registerCollectorsDc(adminRouter);
registerHorizonAssign(adminRouter);
registerBackupNetSec(adminRouter);
