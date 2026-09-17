import { Router } from 'express';
import { config } from '../config.js';
import { authDisabledRole } from '../auth/auth.js';
import { toolGate, exactToolAccessIssue } from '../auth/toolAccess.js';
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
import { registerToolsGuestDisk } from './api/toolsGuestDisk.js';
import { registerVmSeries } from './api/vmSeries.js'; // v2.510: 실시간(20초) 스파이크 수집 — vCenter별 독립 DB
import { registerCurUser } from './api/curUser.js';
import { registerHorizonSessions } from './api/horizonSessions.js';  // v2.525: Horizon 실시간 사용자(세션)  // v2.520: '현재 사용자' — 게스트 계정 없이 guestinfo 읽기
import { registerInventory } from './api/inventory.js';
import { registerVmClone } from './api/vmClone.js'; // VM 복제(백업식, v2.299)
import { registerStorageMon } from './api/storageMon.js'; // 스토리지 모니터링(Isilon 등, v2.302)
import { registerSanSwitch } from './api/sanSwitch.js';   // SAN 스위치 모니터링(Brocade FOS, v2.410)
import { registerPartFaults } from './api/partFaults.js'; // 파트 장애(물리 부품 장애 기록·알림, v2.547)
import { registerEdgeLog } from './api/edgeLog.js'; // 엣지 로그·진행상태(중앙이 당긴다 + 폴백, v2.549)
import { registerBmUsage } from './api/bmUsage.js'; // 베어메탈 사용률(CPU·MEM·디스크·NET·HBA, v2.550)
import { registerLinkCheck } from './api/linkCheck.js'; // 통신 점검(중앙↔엣지·vCenter·엣지↔엣지, v2.552)
import { registerPdu } from './api/pdu.js';               // PDU 정보(APC Rack PDU 2G, v2.424)
import { registerSerialLookup } from './api/serialLookup.js'; // 시리얼 통합 조회(v2.412)
import { registerRma } from './api/rma.js';                   // 원격 명령 실행(RMA, v2.416)
import { registerCredentials } from './api/credentials.js';   // 통합 계정 관리(v2.419)
import { registerRelayCheck } from './api/relaycheck.js';     // HAProxy 경로 점검(v2.429)
import { registerRelayTopo } from './api/relaytopo.js';       // 중계 토폴로지·HAProxy 구성(v2.431)
import { registerBmStorage } from './api/bmstor.js'; // 베어메탈 스토리지(SSH df 마운트 합산, v2.340)
import { registerCompareMatrix } from './api/compareMatrix.js';   // v2.499: 비교 매트릭스(가로 vCenter × 세로 클러스터/스토리지)
import { registerPerfClient } from './api/perfClient.js'; // v2.498: 브라우저 장기 로딩(hang) 보고 수신
import { registerVmTrack } from './api/vmtrack.js'; // VM 수량 추이(00/12시 스냅샷 + 증감 상세, v2.345)

// 특수기능/인벤토리 API 집계 라우터 — v2.283.0 대형 파일 분할.
// 도메인 구현은 ./api/*.js 로 이동. ⚠️ register 호출 순서 = 라우트 등록 순서(Express 매칭 순서)이므로
// 원본(단일 파일 시절) 정의 순서를 그대로 유지한다. 새 라우트 추가 시 해당 도메인 모듈에 넣을 것.
// RBAC(requirePerm)·scope 강제는 각 모듈 라우트에 그대로 있다(CLAUDE.md 보안 불변조건).
export const api = Router();

// 특수 기능 '도구별 접근'(toolsDenied) 서버 집행(v2.447, 감사 S2) — 프론트 toolAllowed() 만으로는
// curl 직접 호출을 막지 못했다. register* 보다 **먼저** 걸어야 모든 /tools 라우트에 적용된다.
// 매핑에 없는 경로는 통과시킨다(auth/toolAccess.js 주석 참조 — 오차단 방지).
// 역할 결정만 여기서 한다(인증 비활성 환경의 대체 역할). 게이트 본체는 auth/toolAccess.js
// toolGate() — 그래야 회귀 테스트가 실제 미들웨어를 express 앱에 마운트해 403 을 확인할 수 있다.
const toolGateRole = (req) => (!config.auth.enabled ? authDisabledRole() : (req.user && req.user.role));
api.use('/tools', toolGate({ roleOf: toolGateRole }));
// 같은 집행을 `/api/tools` **밖**의 전용 엔드포인트에도 적용한다(v2.506 검증 반영):
// `/search/nl`(AI 검색)·`/top`(탐색·랭킹)은 각각 한 화면만 쓰는데 기능 권한 게이트가 없어
// 도구를 거부해도 curl 로 그대로 200 이 나왔다. 정확 일치 표(TOOL_EXACT_PATHS)만 보므로
// 다른 경로에는 영향이 없다.
api.use(toolGate({ roleOf: toolGateRole, issueOf: exactToolAccessIssue }));

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
registerToolsGuestDisk(api);
registerVmSeries(api);
registerCurUser(api);
registerHorizonSessions(api);
registerInventory(api);
registerVmClone(api);
registerStorageMon(api);
registerSanSwitch(api);
registerPartFaults(api);
registerEdgeLog(api);
registerBmUsage(api);
registerLinkCheck(api);
registerPdu(api);
registerSerialLookup(api);
registerRma(api);
registerPerfClient(api);
registerCompareMatrix(api);
registerCredentials(api);
registerRelayCheck(api);
registerRelayTopo(api);
registerBmStorage(api);
registerVmTrack(api);
