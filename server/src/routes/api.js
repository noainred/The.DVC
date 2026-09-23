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
import { wrapAsyncRouter } from '../util/asyncRoute.js';
import { registerVmClone } from './api/vmClone.js'; // VM 복제(백업식, v2.299)
import { registerStorageMon } from './api/storageMon.js'; // 스토리지 모니터링(Isilon 등, v2.302)
import { registerSanSwitch } from './api/sanSwitch.js';   // SAN 스위치 모니터링(Brocade FOS, v2.410)
import { registerPartFaults } from './api/partFaults.js'; // 파트 장애(물리 부품 장애 기록·알림, v2.547)
import { registerEdgeLog } from './api/edgeLog.js'; // 엣지 로그·진행상태(중앙이 당긴다 + 폴백, v2.549)
import { registerBmUsage } from './api/bmUsage.js'; // 베어메탈 사용률(CPU·MEM·디스크·NET·HBA, v2.550)
import { registerLinkCheck } from './api/linkCheck.js'; // 통신 점검(중앙↔엣지·vCenter·엣지↔엣지, v2.552)
import { registerPortalCheck } from './api/portalCheck.js'; // 포탈 점검 › 토큰 점검(v2.560)
import { registerCommMap } from './api/commMap.js'; // 통신 지도(중앙↔엣지 통신 시각화, v2.584)
import { registerDataFlow } from './api/dataFlow.js'; // 데이터 흐름 지도(포탈 사이 전 경로, v2.587)
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
// v2.574 BUG-03: express 4 는 async 핸들러의 throw 를 잡지 않아 그 요청이 **응답 없이
// 매달린다**(소켓 fd 가 잡힌다). 라우트를 등록하기 **전에** 감싸 전역 에러 핸들러로 보낸다.
// ⚠ 라우트 등록보다 아래로 옮기지 말 것 — 그 뒤에 등록된 것만 보호된다.
wrapAsyncRouter(api);

// 특수 기능 '도구별 접근'(toolsDenied) 서버 집행(v2.447, 감사 S2) — 프론트 toolAllowed() 만으로는
// curl 직접 호출을 막지 못했다. register* 보다 **먼저** 걸어야 모든 /tools 라우트에 적용된다.
// 매핑에 없는 경로는 통과시킨다(auth/toolAccess.js 주석 참조 — 오차단 방지).
// 역할 결정만 여기서 한다(인증 비활성 환경의 대체 역할). 게이트 본체는 auth/toolAccess.js
// toolGate() — 그래야 회귀 테스트가 실제 미들웨어를 express 앱에 마운트해 403 을 확인할 수 있다.
const toolGateRole = (req) => (!config.auth.enabled ? authDisabledRole() : (req.user && req.user.role));
/*
 * ⚠⚠ **사용자 축을 함께 넘긴다**(v2.555 — 사용자별 '허용 목록' 집행). 역할만 넘기면
 *   '스토리지 엔지니어에게 스토리지만' 설정이 **서버에서 집행되지 않아** 메뉴만 숨고 curl 로는
 *   그대로 열린다(v2.536 이 겪은 '프론트 탭 조건만 있던' 사고와 같은 유형).
 *   인증 비활성 환경에서는 사용자가 없으므로 역할만 남는다(대체 역할은 위 함수가 정한다).
 */
const toolGateUser = (req) => ({
  username: (config.auth.enabled && req.user && req.user.username) || '',
  role: toolGateRole(req),
});
api.use('/tools', toolGate({ roleOf: toolGateRole, userOf: toolGateUser }));
// 같은 집행을 `/api/tools` **밖**의 전용 엔드포인트에도 적용한다(v2.506 검증 반영):
// `/search/nl`(AI 검색)·`/top`(탐색·랭킹)은 각각 한 화면만 쓰는데 기능 권한 게이트가 없어
// 도구를 거부해도 curl 로 그대로 200 이 나왔다. 정확 일치 표(TOOL_EXACT_PATHS)만 보므로
// 다른 경로에는 영향이 없다.
api.use(toolGate({ roleOf: toolGateRole, userOf: toolGateUser, issueOf: exactToolAccessIssue }));

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
registerPortalCheck(api);
registerCommMap(api);
registerDataFlow(api);
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
