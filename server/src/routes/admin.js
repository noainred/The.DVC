import { Router } from 'express';
import { registerStatusTools } from './admin/statusTools.js';
import { registerApiKeys } from './admin/apiKeys.js';
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
import { wrapAsyncRouter } from '../util/asyncRoute.js';
import { registerNfsMounts } from './admin/nfsMounts.js'; // Edge NFS 마운트(v2.299)
import { registerMail } from './admin/mail.js';         // 공용 메일 발송 설정(v2.454)
import { registerToolCategories } from './admin/toolCategories.js'; // 특수 기능 카테고리(v2.455)
import { registerDirUsage } from './admin/dirUsage.js'; // 폴더 사용량 Top-N 리포트(v2.454)
import { registerHostAccess } from './admin/hostAccess.js'; // 호스트 접근 제어(SSH/웹/OS 방화벽, v2.485)
import { registerPerfMonitor } from './admin/perfMonitor.js'; // v2.498: 설정 › 서버 성능 측정
import { registerSecurityCheck } from './admin/securityCheck.js'; // v2.500: 설정 › 보안 자가진단
import { registerLogAnalysis } from './admin/logAnalysis.js'; // v2.583: 설정 › Log › 로그 분석(개선점 도출)

// 관리자 API 집계 라우터 — v2.285.0 대형 파일 분할.
// 도메인 구현은 ./admin/*.js 로 이동. ⚠️ register 호출 순서 = 라우트 등록 순서(Express 매칭 순서).
// 특히 iDRAC 정적 라우트(scan-result 등)가 /idrac/:id 보다 먼저 등록돼야 한다
// (idracRouteOrder.test.js 가 런타임으로 검증). adminOnly·requireSettingsOwner 는 admin/shared.js.
export const adminRouter = Router();
// v2.574 BUG-03: express 4 는 async 핸들러의 throw 를 잡지 않아 그 요청이 **응답 없이
// 매달린다**(소켓 fd 가 잡힌다). 라우트를 등록하기 **전에** 감싸 전역 에러 핸들러로 보낸다.
// ⚠ 라우트 등록보다 아래로 옮기지 말 것 — 그 뒤에 등록된 것만 보호된다.
wrapAsyncRouter(adminRouter);
registerStatusTools(adminRouter);
registerApiKeys(adminRouter);            // 설정 › 연동 키(외부 포탈용 API 키, v2.562)
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
registerSecurityCheck(adminRouter); // v2.500: 지금 이 서버의 보안 상태(과거 스냅샷이 아닌 실측)
registerLogAnalysis(adminRouter);   // v2.583: 로그 → 개선점(누적·버퍼·저널·붙여넣기·엣지)
