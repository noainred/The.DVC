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
import { registerNfsMounts } from './admin/nfsMounts.js'; // Edge NFS 마운트(v2.299)
import { registerMail } from './admin/mail.js';         // 공용 메일 발송 설정(v2.454)
import { registerToolCategories } from './admin/toolCategories.js'; // 특수 기능 카테고리(v2.455)
import { registerDirUsage } from './admin/dirUsage.js'; // 폴더 사용량 Top-N 리포트(v2.454)
import { registerHostAccess } from './admin/hostAccess.js'; // 호스트 접근 제어(SSH/웹/OS 방화벽, v2.485)
import { registerPerfMonitor } from './admin/perfMonitor.js'; // v2.498: 설정 › 서버 성능 측정

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
registerNfsMounts(adminRouter);
registerMail(adminRouter);
registerToolCategories(adminRouter);
registerDirUsage(adminRouter);
registerHostAccess(adminRouter);
registerPerfMonitor(adminRouter);   // v2.498: 요청 지연·이벤트 루프 정체·hang 로그
