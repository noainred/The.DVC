import './logbuffer.js'; // first: capture console output into the ring buffer
import { createStaticGzip } from './util/staticGzip.js';
import { pushLog } from './logbuffer.js';

// 단일 폴러/요청의 예기치 못한 예외가 프로세스 전체를 죽이지 않도록(크래시 루프 방지).
// 모니터링 서비스는 장시간 떠 있어야 하므로 기록 후 계속 실행한다.
process.on('uncaughtException', (err) => {
  try { pushLog('error', `uncaughtException: ${err?.stack || err}`); } catch { /* */ }
  console.error('[fatal] uncaughtException (계속 실행):', err);
});
process.on('unhandledRejection', (reason) => {
  try { pushLog('error', `unhandledRejection: ${reason?.stack || reason}`); } catch { /* */ }
  console.error('[fatal] unhandledRejection (계속 실행):', reason);
});
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { writeReleaseFile } from './util/releaseFile.js';
import { compression } from './util/compress.js';
import { rateLimit } from './util/rateLimit.js';
import { startLoopLagMonitor } from './util/loopLag.js';
import { startLogAnalysis } from './loganalysis/index.js'; // v2.583: 설정 › Log › 로그 분석 — 로그 누적 집계
// v2.498: 서버 성능 측정 — 요청 지연·진행 중 요청 추적(설정 › 서버 성능 측정). 계측 실패는 서비스에 영향 없음.
import { beginRequest, endRequest, pruneHangLog } from './perf/monitor.js';
import { sanitizeRid, newRid } from './perf/requestId.js';
import { routeKeyOf } from './perf/stats.js';
import { store } from './store.js';
import { api } from './routes/api.js';
import { authRouter } from './routes/auth.js';
import { authMiddleware, requireEnrolled, requirePerm, warnIfNoOtpAdmin, resolveTokenUser } from './auth/auth.js';
import { bigJsonGate } from './util/bigJsonGate.js';        // v2.538: 인증 전 대용량 본문 파싱 차단
import { resolveCentralAuth } from './routes/central.js';   // v2.538: 게이트가 토큰만 먼저 본다
import { recordReject } from './central/ingestReject.js';
import { pruneMockInventory } from './central/inventory.js';
import { auditMiddleware } from './audit.js';
import { upgradeRouter } from './routes/upgrade.js';
import { upgradeManager } from './upgrade/manager.js';
import { adminRouter } from './routes/admin.js';
import { remoteRouter } from './routes/remote.js';
import { attachSshGateway } from './proxy/sshGateway.js';
import { attachRdpGateway } from './proxy/guacdTunnel.js';
import { startMappingExpiry } from './proxy/expiry.js';
import { collectorRouter } from './routes/collector.js';
import { startSelfRegister } from './agent/selfRegister.js';
import { centralRouter } from './routes/central.js';
import publicApiRouter from './routes/publicApi.js';
import { dlSourceRouter } from './routes/dlsource.js';
import { insightsRouter } from './routes/insights.js';
import { metricsExportRouter } from './routes/metricsExport.js';
import { startIdracPoller } from './idrac/poller.js';
import { startIdracScanPoller } from './idrac/scanPoller.js';
import { startNsxPoller } from './nsx/store.js';
import { startAlertEngine } from './alerts.js';
import { startDirUsageScheduler } from './dirusage/scheduler.js'; // 폴더 사용량 Top-N 리포트(v2.454)
import { startMetricsSampler } from './metrics/sampler.js';
import { startGpuGuestPoller } from './gpu/poller.js';
import { startPhysicalGpuPoller } from './gpu/physicalPoller.js';
import { startIpScanPoller } from './ipam/scanPoller.js';
import { startIpScanAgent } from './agent/ipScanWorker.js';
import { startCollectorPuller } from './collector/puller.js';
import { startAgentScanner } from './agent/scanner.js';
import { startIdracScanWorker } from './agent/idracScanWorker.js';
import { startInventoryPush } from './agent/inventoryPush.js';
import { startGuestDiskPush } from './agent/guestDiskPush.js';
import { startFleetPush } from './agent/fleetPush.js';
import { startGpuGuestPush } from './agent/gpuGuestPush.js';
import { startGpuGuestConfigPull } from './agent/gpuGuestConfigPull.js';
import { startUsersConfigPull } from './agent/usersConfigPull.js';
import { startPingWorker } from './agent/pingWorker.js';
import { startConfigPush } from './agent/configPush.js';
import { startBackupScheduler } from './backup/settings.js';
import { startLogPoller } from './logs/poller.js';
import { startLogQueryWorker } from './agent/logQueryWorker.js';
import { startCaptureWorker } from './agent/captureWorker.js';
import { startCaptureMonitor } from './net/monitor.js';
import { pingRouter } from './routes/ping.js';
import { svcmonRouter } from './routes/svcmon.js';
import { capacityRouter } from './routes/capacity.js';
import { startCapacitySampler } from './capacity/sampler.js';
import { startCapacityPush } from './agent/capacityPush.js';
import { startSvcmonPoller } from './svcmon/poller.js';
import { startSvcmonPush } from './agent/svcmonPush.js';
import { startSvcmonConfigPull } from './agent/svcmonConfigPull.js';
import { startSvcmonSilenceWatch } from './central/svcmonSilence.js';
import { closeCsvLog, closeCsvLogAsync } from './svcmon/csvlog.js';
import { flushStore as flushSvcmonStore } from './svcmon/store.js';
import { closePool as closeSvcmonPool } from './svcmon/pool.js';
import { startPingMonitor } from './ping/monitor.js';
import { startLoginMonitor } from './security/loginMonitor.js';
import { startGuestScanScheduler } from './security/guestScanScheduler.js';
import { startOsScanner } from './inventory/osScanner.js';
import { startDbSizeSampler } from './insights/portalDb.js';
import { startCertMonitor } from './security/certMonitor.js';
import { startDailyReport } from './reports/dailyReport.js';
import { startVmCloneScheduler } from './vmclone/scheduler.js'; // VM 복제(백업식) 스케줄러(v2.299)
import { startStoragePoller } from './storage/poller.js';        // 스토리지 수집(v2.302)
import { applyGrowthSettings } from './storage/growthSettings.js'; // 사용량 보존 기간(v2.531)
import { runCapacityBasisMigration } from './storage/capacityBasisMigration.js'; // 용량 기준 변경 1회 정리(v2.534)
import { runZeroCapacityPurge } from './storage/zeroCapacityPurge.js'; // 0 바이트 용량 행 1회 정리(v2.541)
import { startSanSwitchPoller } from './sanswitch/poller.js';    // SAN 스위치 수집(Brocade FOS, v2.410)
import { startPduPoller } from './pdu/poller.js';                 // PDU 수집(APC Rack PDU 2G, v2.424)
import { startPduPush } from './pdu/push.js';                     // 엣지→중앙 PDU 스냅샷 push(v2.424)
import { startPduConfigPull } from './agent/pduConfigPull.js';    // 중앙→엣지 PDU 배포 pull(v2.424)
import { startSanSwitchPush } from './sanswitch/push.js';        // 〃 엣지→중앙 push
import { startSanSwitchConfigPull } from './agent/sanSwitchConfigPull.js'; // 〃 중앙→엣지 배포 pull
import { startSanSwitchPerfPoller } from './sanswitch/perfPoller.js';    // 〃 포트 사용량(portperfshow) 수집(v2.411)
import { startSanSwitchPerfPush } from './sanswitch/perfPush.js';        // 〃 엣지→중앙 포트 사용량 시계열 중계(v2.423)
import { startRelayCheckPoller } from './relaycheck/poller.js';          // HAProxy 경로 점검(v2.429)
import { startBmstorPoller } from './bmstor/poller.js';           // 베어메탈 스토리지(SSH df, v2.340)
import { startBmstorWorker } from './agent/bmstorWorker.js';       // 〃 폴링 위임 워커(엣지, v2.341)
import { startVmtrackPoller } from './vmtrack/poller.js';          // VM 수량 추이 00/12시 스냅샷(v2.345)
import { startGuestDiskPoller } from './guestdisk/poller.js';       // 게스트 디스크 회수 리포트(v2.459)
import { startVmSeriesPoller } from './vmseries/poller.js';         // 실시간(20초) 스파이크 수집(v2.510) — vCenter별 독립 DB
import { startVmSeriesConfigPull } from './agent/vmSeriesConfigPull.js'; // 〃 중앙→엣지 설정 pull(v2.510)
import { startCurUserPoller } from './curuser/poller.js';           // '현재 사용자'(v2.520) — guestinfo 읽기, 게스트 계정 없음
import { startHzSessionPoller } from './horizon/sessionPoller.js';  // Horizon 실시간 사용자(v2.525) — 기존 horizon.json 자격증명 재사용, opt-in
import { startCurUserConfigPull } from './agent/curUserConfigPull.js'; // 〃 중앙→엣지 설정 pull(v2.520)
import { startPartFaultPoller } from './partfault/poller.js';       // 파트 장애(v2.547) — 중앙: 스캔→전이→DB→알림
import { startPartFaultPush } from './partfault/push.js';           // 〃 엣지: 로컬 판정 후 '장애 + 전체 요약' 을 중앙 push(v2.548 프로토콜 2)
import { startPartFaultConfigPull } from './agent/partFaultConfigPull.js'; // 〃 중앙→엣지 스위치 배포(v2.548)
import { startEdgeLogWorker } from './agent/edgeLogWorker.js';  // 엣지 로그 폴백 워커(v2.549) — 중앙이 못 닿는 법인에서만 쓰인다
import { startBmUsagePoller } from './bmusage/poller.js';       // 베어메탈 사용률 수집(v2.550) — 기본 꺼짐, 법인 단위 opt-in
import { startLinkCheckPoller } from './linkcheck/poller.js';   // 통신 점검(v2.552) — 기본 꺼짐(opt-in)
import { startLinkCheckWorker } from './agent/linkCheckWorker.js'; // 엣지가 재는 링크(엣지→중앙·엣지↔엣지)
import { startPowerOffPoller } from './tools/powerOffPoller.js';     // 전원 꺼짐 점검(v2.484)
import { resumeHostAccessPending } from './hostaccess/service.js';  // 호스트 접근 제어 확정 대기 복구(v2.485)
import { startStoragePush } from './storage/push.js';            // 엣지→중앙 스냅샷 push(v2.302)
import { startStorageConfigPull } from './agent/storageConfigPull.js'; // 중앙→엣지 장비 배포 pull(v2.302)
import { queryNormalizer } from './util/queryNormalize.js'; // v2.575 BUG-22

const app = express();
app.disable('x-powered-by'); // v2.538: 'X-Powered-By: Express' 는 정보 노출(프레임워크 지문)일 뿐이다
// v2.575 BUG-22: `req.query` 의 값을 **전부 문자열로 고정**한다. express 4 기본 파서(qs)는
// `?id[a]=1` 을 객체, `?id=a&id=b` 를 배열로 만들고 라우트는 문자열을 가정하므로 500 이 난다
// (퍼징 실측 7경로 22건). ⚠ **모든 라우터보다 먼저** 있어야 한다 — 아래로 옮기지 말 것.
app.use(queryNormalizer());

// 보안 응답 헤더(helmet 무의존 최소 세트) — 클릭재킹·MIME 스니핑·레퍼러 유출·전송보안.
//
// ⚠⚠ CSP 는 v2.577 부터 **기본 켜짐**이다. v2.576 까지 주석이 "인라인 스타일/intro 페이지 호환
// 이슈로 기본 비활성" 이라고 적고 있었지만 그것은 **측정하지 않은 가정**이었다. 실제로 걸어 보니
// 이 앱에 필요한 완화는 `style-src 'unsafe-inline'` 하나뿐이고(React 의 `style={{}}` 은 인라인
// 스타일 속성이다 — 스크립트가 아니다), 스크립트는 전부 번들 파일이라 `'unsafe-inline'`·`'unsafe-eval'`
// **없이** 동작한다. `/intro` 의 vendored React·dc-runtime 도 같은 출처의 `.js` 파일이다.
// 이 값이 중요한 이유: 세션 토큰이 `localStorage` 에 있어 **XSS 한 번이면 그대로 탈취**된다.
// CSP 가 없으면 그 위험에 완화 수단이 하나도 없다(v2.538 이 그 한계를 그대로 기록해 두었다).
//
// 각 지시자의 근거(임의로 좁히거나 넓히지 말 것 — Chromium 실측으로 정한 값이다):
//  · `script-src 'self'`     — 인라인 스크립트 0개(빌드 산출물은 전부 외부 .js). `'unsafe-eval'` 불필요.
//  · `style-src` 에 `'unsafe-inline'` — React 인라인 스타일과 이 앱의 동적 색상 계산에 필수다.
//    ⚠ 이것은 스크립트 실행을 허용하지 않는다 — XSS→토큰 탈취 경로는 `script-src` 가 막는다.
//  · `img-src 'self' data: blob:` — 지도 타일 없음. data:/blob: 는 jsPDF·html2canvas·QR 생성용.
//  · `connect-src 'self' ws: wss:` — SSH/RDP 게이트웨이가 WebSocket 이다(같은 출처, 포트만 같음).
//  · `worker-src 'self' blob:`   — 일부 라이브러리가 blob 워커를 만든다.
//  · `frame-ancestors 'none'`    — X-Frame-Options 와 같은 뜻의 현대식 표기.
//  · `object-src 'none'` · `base-uri 'self'` · `form-action 'self'` — 기본 하드닝.
// 끄려면 `CSP=off`, 바꾸려면 `CSP=<정책 문자열>`(둘 다 기존 옵트인 경로를 그대로 쓴다).
const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
// ⚠⚠ `/intro` 만 완화한다 — 그리고 그 근거는 **측정**이다(v2.577 Chromium 실측):
//   메인 포탈 **21화면에서 위반 0건**, 위반은 전부 `/intro/index.html`·`/intro/light.html` 에서만
//   나왔다. 둘이다 — ① 외부 CDN 스타일시트(jsdelivr 의 Pretendard, Google Fonts 의 IBM Plex Mono)
//   ② `dc-runtime` 의 logic class **문자열 eval**(`EvalError: Refused to evaluate a string`).
//   v2.576 까지의 주석은 "인라인 스타일/intro 호환 이슈" 라고 **둘을 묶어** 적고 CSP 를 통째로
//   꺼 두었는데, 인라인 스타일 쪽은 `style-src 'unsafe-inline'` 하나로 끝나고 **메인 앱과는
//   무관한 문제**였다. 가정을 측정으로 바꾸니 앱 전체에 CSP 를 걸 수 있게 됐다.
//
// `/intro` 를 완화해도 되는 이유: **실데이터·API 와 완전히 분리된 셀프부트 정적 데모**이고
// (index.js 의 `/intro` 마운트 주석) 세션 토큰이 없다 — v2.577 확인: 사설 IP 0건·법인 문자열
// 0건·vCenter 이름 0건. 즉 여기서 스크립트가 훔칠 것이 없다.
// ⚠ **완화 정책을 앱 전체로 넓히지 말 것** — `'unsafe-eval'` 이 붙는 순간 메인 포탈의
//   XSS→`localStorage` 토큰 탈취 완화가 사라진다.
// ⚠ 정직 기록: `/intro` 는 **외부 CDN(jsdelivr·Google Fonts)에 의존**한다. 폐쇄망에서는 그
//   글꼴이 그냥 안 받아지고(기능은 동작), 공급망 관점에서는 공개 페이지의 외부 의존이다.
//   없애려면 글꼴을 번들해야 하는데 그건 별건이다.
const INTRO_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' data: https://cdn.jsdelivr.net https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');
const CSP_HEADER = process.env.CSP === 'off' ? '' : (process.env.CSP || DEFAULT_CSP);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');            // 웹에 iframe 없음 → 클릭재킹 차단
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains'); // 실제 HTTPS일 때만
  }
  if (CSP_HEADER) {
    const isIntro = req.path === '/intro' || req.path.startsWith('/intro/');
    res.setHeader('Content-Security-Policy', isIntro && !process.env.CSP ? INTRO_CSP : CSP_HEADER);
  }
  next();
});

// CORS: SPA는 API와 동일 출처라 교차출처 불필요 → 기본은 교차출처 차단(과거 와일드카드 '*' 제거).
// 별도 출처가 필요하면 CORS_ORIGINS(콤마 구분)로 명시 허용.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors(CORS_ORIGINS.length ? { origin: CORS_ORIGINS } : { origin: false }));
// 응답 gzip 압축(큰 JSON만, 비동기) + 레이트 리밋(폭주/DoS 방어). 헬스/정적/메트릭은 제외.
app.use(compression());
app.use(rateLimit({ skip: (req) => {
  const p = req.path || '';
  return p === '/api/health' || p === '/metrics' || p === '/dl' || p.startsWith('/dl/')
    || !p.startsWith('/api'); // 정적 자산/SPA는 제한 제외
} }));
// Lightweight request logging for the log viewer (skip the log endpoint itself).
// ⚠ 위치: **본문 파서(express.json) 앞**이다(v2.498). 뒤에 두면 본문 수신 시간과 최대 16MB 동기
// JSON.parse 가 계측에서 빠져, 고RTT 사이트에서 수 MB 를 올리는 위임 push 가 '빠른 라우트' 로
// 찍히고 이 프로세스의 가장 큰 단일 블로킹 사건이 표에 안 잡힌다. 레이트리밋 뒤에 두어 429 의
// 라이브 로그 동작은 예전과 같게 유지한다.
// v2.498: 같은 자리에서 성능 측정도 한다 — 요청당 비용은 Map set/delete + 카운터뿐이고,
// 임계를 넘은 요청만 링에 남는다(perf/monitor.js). 라이브 로그 한 줄의 형식·조건은 그대로 유지한다
// (진단·로그 화면 회귀 방지). 클라이언트가 끊은 요청(finish 없이 close)은 로그에는 남기지 않고
// 성능 측정에만 status 499 로 넣는다 — 웹 GET 은 20초에 스스로 끊으므로 그 사실이 튜닝의 핵심 단서다.
app.use((req, res, next) => {
  const url = req.originalUrl.split('?')[0];
  if (url === '/api/admin/logs') return next();
  const start = Date.now();
  // 성능 집계는 **API 요청만** 한다 — 정적 자산(해시 파일명)까지 넣으면 라우트 키가 빌드마다
  // 새로 생기고 표가 잡음으로 덮인다. 라이브 로그 한 줄은 예전처럼 전 경로에 남는다.
  const isApi = url.startsWith('/api');
  // v2.583: 요청 ID — 브라우저가 보낸 X-Request-Id(형식 검사) 또는 서버가 만든 값. 로딩 화면·느린 요청·
  // 라이브 로그가 같은 ID 를 싣는다(perf/requestId.js). 응답 헤더로도 돌려준다.
  const rid = isApi ? (sanitizeRid(req.get('x-request-id')) || newRid()) : '';
  if (rid) { req.reqId = rid; try { res.setHeader('X-Request-Id', rid); } catch { /* 헤더 이미 전송 */ } }
  const perfId = isApi ? beginRequest({ method: req.method, path: url, rid, userOf: () => req.user?.username || '' }) : null;
  let settled = false;
  const settle = (aborted) => {
    if (settled) return;
    settled = true;
    const ms = Date.now() - start;
    if (!aborted) {
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      // 뒤에 붙인 `#<요청 ID>` 는 v2.583 — 로딩 화면에 보인 ID 로 이 줄을 찾는다(앞부분 형식은 그대로).
      pushLog(level, `${req.method} ${url} ${res.statusCode} ${ms}ms${rid ? ` #${rid}` : ''}`);
    }
    if (!isApi) return;
    try {
      // express 가 매칭한 템플릿(`baseUrl + route.path`)이 남아 있으면 그것을, 아니면 경로의 식별자
      // 세그먼트를 마스킹한 키를 쓴다(카디널리티 유계). 두 방식이 섞여 같은 라우트가 갈라지지 않게
      // 템플릿은 '/api' 로 시작할 때만 채택한다(라우터 dispatch 후 baseUrl 이 복원되는 경우 대비).
      const tmpl = req.route?.path ? `${req.baseUrl || ''}${req.route.path === '/' ? '' : req.route.path}` : '';
      // **라우터가 매칭하지 못한 요청은 경로를 키로도, 레코드로도 남기지 않는다.**
      // 판정 기준은 상태코드가 아니라 `req.route` 부재다 — 상태코드로 나열하면 본문 파서가 내는
      // 400(request aborted)·413 같은 경로가 빠져나가 임의 경로로 라우트 표와 느린 요청 링을
      // 채울 수 있다(미인증으로 도달 가능 — 적대적 리뷰가 재현). 마스킹된 경로만 남긴다.
      const dispatched = !!(tmpl && tmpl.startsWith('/api'));
      const route = dispatched ? tmpl.slice(0, 120) : `/api/__predispatch_${aborted ? 499 : res.statusCode}__`;
      endRequest(perfId, {
        method: req.method,
        // 매칭 전에 끝난 요청은 원경로 대신 마스킹 결과만 남긴다(증거 링 오염 차단).
        path: dispatched ? url : routeKeyOf({ path: url }),
        route,
        status: aborted ? 499 : res.statusCode, ms,
        user: req.user?.username || '', bytes: Number(res.getHeader('Content-Length')) || null,
        expectSlow: !!res.locals?.perfExpectSlow, rid,
      });
    } catch { /* 계측 실패는 무시 */ }
  };
  res.on('finish', () => settle(false));
  res.on('close', () => settle(!res.writableEnded));
  next();
});

// 사이트 위임 수집의 인벤토리 push(/api/central/inventory)만 수MB가 될 수 있어 큰 한도를 적용.
// 그 외 모든 라우트는 기본 1mb로 제한해 메모리/요청 남용 면적을 줄인다.
// 한도 16mb: 실제 사이트 push는 수백 KB~수 MB 수준 — 64mb는 동기 JSON.parse가 최악 수 초
// 이벤트 루프를 막는 것을 허용하는 과대 한도였다(필요 시 JSON_BODY_LIMIT로 상향 가능).
// ⚠ v2.538(저장 데이터·외부 공격면 감사): 예전에는 아래 마운트들이 **토큰 검사보다 먼저** 16MB 를
// 통째로 읽어 JSON.parse 했다 — 토큰 없는 요청도 마찬가지였다. 실측(목 서버): 무토큰 15MB 1건에
// RSS 171→225MB, 6건 동시 409MB, 응답은 그 뒤에야 403. 인증 없이 프로세스 메모리를 밀어 올리는
// 경로다. 이제 `bigJsonGate` 가 **요청이 이미 유효한 토큰/세션을 들고 있을 때만** 큰 파서를 태우고,
// 아니면 next() 로 넘긴다 — 그러면 전역 1MB 파서가 Content-Length 만 보고 413 으로 끊거나(본문을
// 읽지 않는다) 라우터 인증이 401/403 을 낸다. 인증은 여전히 각 라우터가 한다(이 게이트는 '파싱 허가'
// 일 뿐 권한 판정이 아니다). 마운트 목록은 그대로 두었다(v2.517·v2.520 테스트가 이 줄들을 고정한다).
const BIG_JSON = bigJsonGate(express.json({ limit: process.env.JSON_BODY_LIMIT || '16mb' }), {
  central: (req) => resolveCentralAuth(req).ok,
  session: (req) => Boolean(resolveTokenUser((req.get('Authorization') || '').replace(/^Bearer\s+/i, ''))),
});
app.use('/api/central/inventory', BIG_JSON);
app.use('/api/central/guest-disk', BIG_JSON); // 게스트 디스크 push(v2.466) — inventory 와 동종(그 vCenter 전 VM+파티션). 1mb 기본이면 대형 site vCenter 가 413 으로 조용히 실패
app.use('/api/central/vmseries', BIG_JSON);   // 실시간 스파이크 push(v2.510) — 엣지가 700KB 청크로 보내지만 base64 BLOB 이라 1mb 기본을 넘을 수 있다(413 = 조용한 소실)
app.use('/api/central/agent-config', BIG_JSON); // 엣지 설정 통합 push(다수 파일)
// v2.503(성능 감사 F-2): 스토리지·PDU push 는 **청크도 gzip 도 없이** 한 번에 올라가고 있었다.
// 스키마상 스토리지 장비 1대가 약 20~30KB 이고 엣지당 상한이 500대(`MAX_DEVICES_PER_AGENT`)라
// 장비 35~50대만 넘어도 기본 1MB 를 초과한다. 413 은 `resilientFetch` 의 재시도 대상이 아니라
// **그 법인 데이터가 조용히 전량 소실**된다(guest-disk 가 v2.466 에 겪은 것과 같은 사고).
// 엣지 쪽은 gzip 을 붙였지만 express.json 의 limit 은 **해제 후 길이**라 한도도 함께 올려야 한다.
app.use('/api/central/storage-data', BIG_JSON);
app.use('/api/central/part-faults', BIG_JSON);  // 파트 장애 push(v2.547) — 열린 장애가 많은 법인이 1mb 기본을 넘으면 413 = 조용한 소실
app.use('/api/central/edge-log-result', BIG_JSON);  // 엣지 로그 폴백 회신(v2.549) — 로그 400줄 × 줄당 최대 2,000자면 1mb 기본을 넘고, 413 은 재시도 대상이 아니라 조용한 소실이 된다
// 엣지 로그 **연합 조회** 결과(v2.561) — v2.549 가 형제 경로만 등록해 이쪽이 빠져 있었다.
// 실측: 500행(`checksLogs.js` 의 limit 상한) × vCenter 이벤트 message 1,900자 = 981KB 로 기본 1mb 에 닿고
// 2,000자면 1,079KB 로 넘는다. 413 은 재시도 대상이 아니라 **그 조회 결과의 조용한 전량 소실**이고,
// 중앙은 결과가 없으면 영원히 `{state:'pending'}` 을 돌려주므로 화면이 무한 대기가 된다.
app.use('/api/central/log-query-result', BIG_JSON);
app.use('/api/central/rma-result', BIG_JSON);   // v2.591 PR-9: RMA 명령 출력(RMA_MAX_OUTPUT·제어문자 이스케이프로 1MB 초과 가능) — 413 은 조용한 소실
// v2.590 D2: svcmon 엣지 보고 — 행 2,000 + 메타(경로·호스트·점검명)가 한 청크에 실리면 1mb 기본을 넘는다(실측 5,000항목 1.09MB → 413).
// 엣지가 메타를 청크마다 나누고 413 이면 청크를 줄여 다시 나누지만, 한도를 넉넉히 두는 것이 1차 방어다.
app.use('/api/central/svcmon-report', BIG_JSON);
app.use('/api/central/pdu-data', BIG_JSON);
// v2.517: SAN 스위치 push 가 **전체 포트**로 바뀌었다(`sanswitch/push.js` 머리말 — gzip 실측 근거).
// 엣지는 700KB 청크 + gzip 으로 보내지만 express.json 의 limit 은 **해제 후 길이**라 기본 1MB 로는
// 포트 수가 많은 디렉터 1대가 단독 청크로 413 이 될 수 있다(413 = 그 법인 데이터의 조용한 전량 소실).
// 포트 사용량(sanswitch-perf)도 같은 축이라 함께 올린다(v2.517 에 상태 payload 가 더해졌다).
app.use('/api/central/sanswitch-data', BIG_JSON);
app.use('/api/central/sanswitch-perf', BIG_JSON);
// '현재 사용자' push(v2.520) — 레코드에 계정명 목록이 붙어 대상이 많은 법인은 1MB 기본을 넘을 수
// 있다. express.json 의 limit 은 **gzip 해제 후 길이**라 gzip 만으로는 413 이 해결되지 않는다.
app.use('/api/central/curuser', BIG_JSON);
// 통신 점검 엣지 보고(v2.552) — 링크 최대 500개 × 단계 6개 상세라 1MB 기본을 넘을 수 있다.
// 413 은 재시도 대상이 아니라 **그 엣지 측정분의 조용한 전량 소실**이 된다(v2.517 규약).
app.use('/api/central/link-check', BIG_JSON);
// ⚠⚠ v2.574 SEC-11 — IP 스캔 결과. 중앙의 `slice(0, 8000)`(`routes/central.js:1336`)은 **파싱 후**라
//   보호가 되지 않고, 엣지(`agent/ipScanWorker.js:36`)는 자르지 않는다. 실측(실제 레코드 형태
//   `{ip, openPorts[], services[], hostname}` — `ipam/scan.js:269`, 레코드당 133B):
//   5,000건 0.633MB 통과 / **8,000건 1.016MB → 413** / 10,000건 1.270MB → 413.
//   즉 **코드가 선언한 상한(8,000)이 이미 기본 1MB 를 넘는다**. 413 은 `resilientFetch` 재시도
//   대상이 아니라 그 주기 IP 대장이 **조용히 전량 소실**된다(v2.517 규약).
app.use('/api/central/ip-scan-result', BIG_JSON);
// 형제 — iDRAC 스캔 결과도 같은 이유(대역이 넓으면 발견 호스트가 수천 건).
app.use('/api/central/idrac-scan-result', BIG_JSON);
// 대상 가져오기는 XLSX 를 base64 로 실을 수 있어(2,000행 규모 ~1MB 초과 가능) 큰 한도를 준다.
// 로그 분석 붙여넣기(v2.583) — 폐쇄망 현장이 다른 서버의 journalctl 출력을 붙여넣는다(라우트가 8MB 상한을 다시 건다).
app.use('/api/admin/log-analysis/paste', BIG_JSON);
app.use('/api/svcmon/targets/import', BIG_JSON);
app.use('/api/svcmon/targets/hostmap/parse', BIG_JSON);
// TRUST_PROXY(v2.428, 구성도 미스매치 #8): 중앙/엣지가 HAProxy·nginx 뒤에 있으면 홉 수(예 1)를 지정 — req.ip 가 X-Forwarded-For 의
// 실제 클라이언트가 되어 레이트리밋 버킷·감사 IP·수집 인증 거부 로그가 프록시 IP 로 뭉치지 않는다. 프록시가 없으면 절대 켜지 말 것
// (아무 클라이언트나 X-Forwarded-For 로 IP 를 속인다). HAProxy 는 http 모드에서 `option forwardfor` 필요.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.use(express.json({ limit: '1mb' }));

app.use('/api/collector', collectorRouter);            // token-gated agent export (no user auth)
app.use('/api/central', centralRouter);                // token-gated agent<->central (no user auth)
/*
 * 외부 포탈용 공개 조회 API(v2.562) — **키 기반**이라 사용자 세션 미들웨어를 타지 않는다
 * (collector·central 과 같은 층). 인증·범위·허용목록은 라우터 안에서 직접 판정한다
 * (`publicapi/auth.js` + `publicapi/allowlist.js`).
 * ⚠ `authMiddleware`·`requireEnrolled` 를 붙이지 말 것 — 세션 사용자와 키 사용자가 한
 *   라우터에 섞이면 판정이 흐려진다(머리말 참조). 조회 전용이므로 BIG_JSON 도 필요 없다.
 */
app.use('/api/v1', publicApiRouter);
app.use('/dl', dlSourceRouter);                        // 중앙 업그레이드 소스(versions.json + 번들, 공개)
app.use('/metrics', metricsExportRouter);              // Prometheus/OTel 익스포터(선택 토큰)
app.use('/api/auth', authRouter);                      // public: login / config / me
// auditMiddleware 필수(감사): /api/upgrade 는 '함대 전체를 새 버전으로 교체'하는 권능이라
// 감사 추적이 가장 필요한 라우터인데 v2.399 까지 빠져 있었다(admin·remote 만 걸려 있었음).
// 미들웨어는 2xx 상태변경 요청만 기록하므로 조회 트래픽에는 영향이 없다.
app.use('/api/upgrade', authMiddleware, requireEnrolled, auditMiddleware, upgradeRouter); // admin-gated auto-upgrade control
app.use('/api/admin', authMiddleware, requireEnrolled, auditMiddleware, adminRouter);     // admin-gated vCenter management
app.use('/api/remote', authMiddleware, requireEnrolled, auditMiddleware, remoteRouter);   // remote access (HAProxy/SSH/RDP)
// requirePerm('insights'): 기능 권한을 서버에서 강제(v2.289 #7). 과거엔 authMiddleware+requireEnrolled
// 만이라 'insights' 권한 없는 계정도 API 직접 호출이 가능했다(프론트 메뉴만 숨김). CLAUDE.md
// '기능 권한은 서버가 진실의 원천' 규칙 적용. admin 은 항상 전 권한.
app.use('/api/insights', authMiddleware, requireEnrolled, requirePerm('insights'), insightsRouter); // FinOps·이상탐지·예측·보안·토폴로지·인시던트·ChatOps
// v2.506(감사 S1 N-2): `requirePerm('svcmon')` 추가. 예전에는 authMiddleware+requireEnrolled 만
// 있어 **로그인한 아무 계정이나** `GET /api/svcmon/state?limit=2000` 으로 전 법인 감시 대상의
// host(내부 IP/FQDN)·점검 포트·경로를 전량 페이징할 수 있었다(`/edges` 는 각 법인 엣지의 관측
// 소스 IP·포탈 포트까지). 바로 위 `/api/insights` 는 이미 requirePerm 을 강제하고 있었고,
// 같은 라우터의 로그 파일 라우트도 편집 권한을 요구했는데 `/state`·`/edges`·`/templates` 만
// 무가드였다(게이팅 비대칭). svcmon 에는 vCenter scope 축이 없어 범위 제한 계정도 전량을 본다.
// 엣지 수집은 `/api/central/svcmon-*`(개별 토큰) 을 쓰므로 이 게이트에 영향받지 않는다(확인함).
app.use('/api/svcmon', authMiddleware, requireEnrolled, requirePerm('svcmon'), svcmonRouter);   // 성능점검(HostMonitor식 서비스 모니터링)
app.use('/api/capacity', authMiddleware, requireEnrolled, capacityRouter); // 리소스 적정성 진단(라우터 내부 admin 강제)
// auditMiddleware: 대상 추가/삭제·vCenter 시드·엣지 동기화가 전부 admin 전용 상태변경이다.
app.use('/api/ping', authMiddleware, requireEnrolled, auditMiddleware, pingRouter);       // 네트워크 Ping 모니터링(조회=인증, 대상관리=관리자)
app.use('/api', authMiddleware, requireEnrolled, api);                   // protected resource endpoints

// 외부 공개용 소개 페이지 — 로그인 없이 접근 가능한 정적 데모(/intro, /intro/light.html).
// 실데이터·API와 완전히 분리된 셀프부트 페이지라 인증 미들웨어를 타지 않는다.
if (fs.existsSync(config.introDir)) {
  app.use('/intro', express.static(config.introDir, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, must-revalidate'),
  }));
}

// Serve the built web client when it exists (production single-port mode).
if (fs.existsSync(config.webDist)) {
  // v2.596(감사 PERFWEB-02): 해시 자산(JS·CSS)은 gzip 으로 보낸다 — 파일마다 한 번 비동기 압축 후 재사용(util/staticGzip.js).
  app.use(createStaticGzip(config.webDist));
  // Hashed assets can cache forever; index.html must never be cached so the
  // browser always picks up new asset hashes after an upgrade.
  app.use(express.static(config.webDist, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    // A missing file with an extension (e.g. a stale asset hash) must 404 — never
    // return index.html for it, or the browser executes HTML as JS and shows a blank page.
    if (path.extname(req.path)) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
}

// ── 전역 에러 핸들러(마지막 미들웨어) ────────────────────────────────────────
// ⚠ 이 핸들러가 없으면 라우트에서 throw 된 예외를 express 기본 finalhandler 가 처리하는데,
// finalhandler 는 `process.env.NODE_ENV || 'development'` 로 환경을 판정한다. 이 프로젝트는
// systemd 유닛/portal.env 어디에도 NODE_ENV 를 설정하지 않으므로 항상 'development' 이 되어
// **500 응답 본문에 스택 트레이스가 그대로 실린다**(절대경로·모듈 구조·내부 함수명 노출).
// 4-인자 시그니처(err, req, res, next)를 유지해야 express 가 에러 핸들러로 인식한다 — next 를
// 지우면 일반 미들웨어가 되어 이 방어가 통째로 사라진다.
app.use((err, req, res, _next) => {
  const status = Number(err?.status || err?.statusCode) || 500;
  // 본문 파서(express.json)가 던지는 400/413 은 클라이언트 실수라 사유를 알려주는 편이 낫다.
  const clientFault = status >= 400 && status < 500;
  try {
    pushLog(status >= 500 ? 'error' : 'warn', `unhandled ${req.method} ${(req.originalUrl || '').split('?')[0]} ${status}: ${err?.stack || err}`);
  } catch { /* 로깅 실패가 응답을 막지 않게 */ }
  // v2.591(3차 감사 PR-6): 엣지 push 가 **본문 파서 단계**에서 거부되면(413 한도 초과·400 깨진 JSON) 중앙 라우터의 수신 훅까지
  //   가지 못해 거부 기록(ingestReject)에 **아무것도 남지 않았다** — 데이터 흐름 지도·인벤토리 점검이 그 경로를 계속 '정상' 으로
  //   말했다. 여기서 토큰으로 이름을 가리고(개별 토큰이면 그 이름, 아니면 주장된 이름 — 검증 안 됨) 기록한다.
  if (clientFault && String(req.originalUrl || '').startsWith('/api/central/')) {
    try {
      const auth = resolveCentralAuth(req);
      const claimed = String(req.get('X-Agent-Name') || req.query?.agent || '').trim();
      const name = auth?.ok && auth.mode === 'agent' ? auth.agent : (auth?.ok ? claimed : '');
      recordReject(name || '(unknown)', String(req.originalUrl).split('?')[0].slice('/api/central'.length) || '/', {
        status, reason: err?.type === 'entity.too.large' ? `본문이 중앙 한도(${err?.limit ?? '?'} 바이트)를 넘었습니다` : '본문 JSON 을 읽지 못했습니다',
        wireBytes: Number(req.get('content-length')) || 0,
      });
    } catch { /* 진단은 best-effort */ }
  }
  if (res.headersSent) return res.destroy?.();
  res.status(status).json({
    ok: false,
    error: clientFault ? (err?.type === 'entity.too.large' ? 'payload too large' : 'bad request') : 'internal error',
  });
});

// 메인 수집(vCenter)만 즉시 기동하고, 보조 폴러들은 초기 기동을 스태거(분산)해
// 부팅 직후 동시 폴링으로 인한 CPU 스파이크를 평탄화한다(이후 각자 주기 반복).
// CONFIG_DIR/vmware-portal-release 에 현재 버전을 명시(redhat-release 방식). 기동 시마다 갱신.
try { const rf = writeReleaseFile(); if (rf) console.log(`[release] ${rf} 기록`); } catch { /* best effort */ }
// 스토리지 사용량 보존 기간(v2.531) — **스태거에 넣지 않는다.** 폴러가 첫 용량 점을 적재하면
// 그 안에서 prune 이 돌 수 있으므로, 사용자가 지정한 보존값이 그 전에 DB 모듈에 들어가 있어야
// 한다(스태거로 늦게 주입하면 첫 prune 이 기본값 기준으로 돌아 더 지울 수 있다).
try { applyGrowthSettings(); } catch (e) { console.warn(`[storage-growth] 보존 설정 적용 실패(${e.message}) — 기본값으로 동작`); }
// v2.534: VMAX/PowerMax 사용량 기준 변경(할당 → 실제 기록량)으로 **이전 이력은 이어 붙일 수 없다**.
// 그 장비들의 용량 이력만 1회 지우고(마커로 재실행 방지) 재시작 사실을 남긴다 — 그대로 두면
// 증가량 화면에 전환일 하루치 '거짓 감소'(수 PB)가 찍힌다. 실패해도 기동을 막지 않는다.
runCapacityBasisMigration()
  .then((r) => { if (r.ran) console.log(`[storage] 용량 기준 변경 — 장비 ${r.devices}대 이력 ${r.rows}행 재시작(v2.534)`); })
  .catch((e) => console.warn(`[storage] 용량 이력 재시작 실패(${e.message}) — 증가량 화면에 기준 변경 구간이 남을 수 있습니다`));
// v2.541: 수집 실패 스냅샷에서 들어온 **0 바이트 용량 행**을 1회 정리한다(사용자 신고 —
// SSH 인증 실패로 전 섹션이 '건너뜀' 인 장비의 추이가 `0.0 TB` 선으로 그려졌다). 지금 코드의
// 적재 경로 두 곳은 모두 `capacityPointEligible`(v2.531)에 막히므로 새로 생기지는 않는다.
// ⚠ 장비 이력을 통째로 지우지 않고 **그 행만** 지운다(위 마이그레이션과 의도적으로 다르다).
runZeroCapacityPurge()
  .then((r) => { if (r.ran && r.rows) console.log(`[storage] 0 바이트 용량 행 정리 — 장비 ${r.devices}대 ${r.rows}행 제거(v2.541)`); })
  .catch((e) => console.warn(`[storage] 0 바이트 용량 행 정리 실패(${e.message}) — 추이 차트에 0 TB 점이 남을 수 있습니다`));
store.start();
try { startLogAnalysis(); } catch { /* 로그 분석 누적(v2.583) — 실패해도 서비스에 영향 없음(화면이 상태를 말한다) */ }
startLoopLagMonitor(); // 이벤트 루프 지연 계측(additive·no-op-on-fail) — docs/ARCH-HEAVY-JOB-ISOLATION.md §10-0
try { pruneHangLog(); } catch { /* hang 로그 보존일 정리(기동 1회) — 실패 무시 */ }
upgradeManager.start();
const stagger = [
  startSelfRegister, // 엣지 자기등록(EDGE_MODE=all) — 중앙 수집 서버 목록에 자동 등록
  startIdracPoller, startIdracScanPoller, startNsxPoller, startAlertEngine, startMetricsSampler, startGpuGuestPoller, startPhysicalGpuPoller,
  startIpScanPoller, startIpScanAgent, startCollectorPuller, startAgentScanner, startIdracScanWorker, startInventoryPush,
  startGpuGuestPush, startGpuGuestConfigPull, startUsersConfigPull, startPingWorker, startConfigPush, startFleetPush, startBackupScheduler, startLogPoller, startLogQueryWorker, startCaptureWorker, startCaptureMonitor, startLoginMonitor, startGuestScanScheduler, startOsScanner,
  startDbSizeSampler, startPingMonitor, startCertMonitor, startDailyReport, startSvcmonPoller,
  startCapacitySampler, startCapacityPush,   // 리소스 적정성 진단 — 로컬 상시 샘플 + (엣지면) 중앙 push
  // 엣지 위임(RMA): 엣지는 결과를 밀어 올리고(push), 중앙은 무보고를 감시한다.
  // 둘 다 재진입 가드가 있고, 조건(CENTRAL_URL·토큰) 미충족이면 스스로 기동하지 않는다.
  startSvcmonPush, startSvcmonConfigPull, startSvcmonSilenceWatch,
  startVmCloneScheduler, // VM 복제(백업식) — 60초 틱, 재진입 가드 + 전역 직렬 실행 큐(runner)
  startStoragePoller, startStoragePush, startStorageConfigPull, // 스토리지 모니터링(v2.302) — 전부 재진입 가드, push/pull 은 CENTRAL_URL 미설정 시 자기기동 안 함
  startSanSwitchPoller, startSanSwitchPush, startSanSwitchConfigPull, // SAN 스위치(v2.410) — 동일 규약(재진입 가드 + 적응형 타이머)
  startPduPoller, startPduPush, startPduConfigPull, // PDU(v2.424) — 동일 규약(자동 센서 탐지 + 재진입 가드 + 적응형 타이머)
  startSanSwitchPerfPoller, // SAN 포트 사용량(v2.411) — 설정에서 꺼져 있으면 틱만 돌고 아무것도 안 한다
  startSanSwitchPerfPush,   // 〃 엣지→중앙 중계(v2.423) — CENTRAL_URL 미설정이면 자기기동 안 함, 커서 방식
  startRelayCheckPoller,    // HAProxy 경로 점검(v2.429) — 설정 꺼짐이면 틱만 돌고 아무것도 안 함
  startBmstorPoller, // 베어메탈 스토리지(v2.340) — 30초 틱 + 재진입 가드, 등록 0대면 대기
  startBmstorWorker, // 〃 폴링 위임 워커(v2.341) — CENTRAL_URL 미설정이면 자기기동 안 함
  startVmtrackPoller, // VM 수량 추이(v2.345) — 60초 틱, 슬롯(00/12시) 미기록 시에만 수집 + 재진입 가드
  startDirUsageScheduler, // 폴더 사용량 Top-N 리포트(v2.454) — 60초 틱 + 재진입 가드, 설정 꺼짐이면 결과 수거만
  startGuestDiskPoller, // 게스트 디스크 회수 리포트(v2.459) — 60초 틱, opt-in(기본 꺼짐)·주기 경과 시에만 수집 + 재진입 가드
  resumeHostAccessPending, // 호스트 접근 제어(v2.485) — 확정 대기(commit-confirm)가 남아 있으면 기한을 이어받아 자동 되돌림 타이머 재무장
  startPowerOffPoller,  // 전원 꺼짐 점검(v2.484) — 60초 틱, 설정 주기(기본 6h) 경과 시 스냅샷의 꺼진 VM 관측 적재 + 재진입 가드, vCenter 왕복 없음
  startGuestDiskPush,   // 〃 엣지→중앙 push(v2.466) — site 모드 vCenter 의 guest.disk 를 엣지가 수집해 중앙에 올림. CENTRAL_URL·pushGuestDisk 미충족이면 자기기동 안 함
  startVmSeriesPoller,  // 실시간 스파이크 수집(v2.510) — 적응형 타이머(기본 50분) + 재진입 가드 + 동시성 4 + 디스크 가드. opt-in(기본 꺼짐). 엣지면 저장 후 중앙 push
  startVmSeriesConfigPull, // 〃 중앙→엣지 설정 pull(v2.510) — CENTRAL_URL 미설정이면 자기기동 안 함
  startCurUserPoller,   // '현재 사용자'(v2.520) — 적응형 타이머(기본 10분) + 재진입 가드 + 동시성 제한. opt-in(기본 꺼짐). 게스트 계정 없이 config.extraConfig 만 읽는다
  startHzSessionPoller, // Horizon 실시간 사용자(v2.525) — 적응형 타이머(기본 5분) + 재진입 가드 + 서버당 시한. opt-in(기본 꺼짐). 기존 horizon.json 자격증명을 재사용한다
  startCurUserConfigPull, // 〃 중앙→엣지 설정 pull(v2.520)
  // 파트 장애(v2.547) — 엣지는 로컬 스냅샷을 판정해 **장애만** 중앙에 push 하고,
  // 중앙은 직접 수집분 + 엣지 보고를 합쳐 전이(열림/변화/해소)를 계산해 DB 에 남기고 알린다.
  // 둘 다 opt-in/조건부이며(PARTFAULT_ENABLED · CENTRAL_URL) 왜 안 도는지 로그가 말한다.
  startPartFaultPoller, startPartFaultPush, startPartFaultConfigPull,
  startEdgeLogWorker,
  startBmUsagePoller,
  startLinkCheckPoller,
  startLinkCheckWorker,
];
stagger.forEach((start, i) => setTimeout(() => { try { start(); } catch (e) { console.error('[start] 폴러 기동 실패:', e?.message); } }, i * 1500).unref?.());

const server = app.listen(config.port, () => {
  console.log(`\n  VMware Global Monitoring Portal — API`);
  console.log(`  ▸ listening on http://localhost:${config.port}`);
  console.log(`  ▸ data source: ${config.dataSource}`);
  // v2.451: DB 저장 경로를 기동 로그에 남긴다 — 옮겼는데 권한 문제로 폴백된 경우를 여기서 알 수 있다.
  console.log(`  ▸ db dir: ${config.dbDir || `${config.configDir} (기본)`}`);
  console.log(`  ▸ poll interval: ${config.pollIntervalMs / 1000}s`);
  console.log(`  ▸ auth: ${config.auth.enabled ? 'enabled' : 'disabled'}\n`);
  // OTP 전용 정책에서 로그인 가능한 관리자가 하나도 없으면 콘솔 등록 절차를 안내(조용한 잠금 방지).
  try { warnIfNoOtpAdmin(); } catch { /* 안내 실패가 기동을 막지 않게 */ }
  // v2.443: 차단이 들어오기 전에 저장된 목(가짜) 인벤토리를 1회 정리한다 — 업그레이드만 해도
  // 중앙 화면에서 데모 사이트('east us' 등)가 사라진다(사용자 신고).
  try { pruneMockInventory(); } catch { /* 정리 실패가 기동을 막지 않게 */ }
});

// 고RTT·대용량 push(분산 에이전트의 인벤토리/번들)를 고려한 명시적 서버 타임아웃.
// - keepAliveTimeout: 기본 5s는 고RTT 클라이언트의 유휴 keep-alive 소켓을 너무 빨리 끊어
//   재연결 churn/죽은 소켓 재사용을 유발 → 75s로 상향.
// - headersTimeout는 keepAliveTimeout보다 커야 함(Node 권장). requestTimeout은 느린 대용량
//   업로드가 중간에 끊기지 않도록 넉넉히(0=무제한 대신 명시적 큰 값).
server.keepAliveTimeout = Number(process.env.SERVER_KEEPALIVE_MS) || 75_000;
server.headersTimeout = Number(process.env.SERVER_HEADERS_TIMEOUT_MS) || 90_000;
server.requestTimeout = Number(process.env.SERVER_REQUEST_TIMEOUT_MS) || 600_000;

// listen 오류(포트 충돌/특권포트 등)를 명확히 안내. 특권포트(<1024) EACCES가 흔한 원인.
server.on('error', (err) => {
  if (err.code === 'EACCES') console.error(`[listen] 포트 ${config.port} 권한 거부(EACCES). 1024 미만 특권포트입니다. PORT를 1024 이상(예: 4000)으로 설정하세요. (portal.env의 PORT 확인)`);
  else if (err.code === 'EADDRINUSE') console.error(`[listen] 포트 ${config.port} 이미 사용 중(EADDRINUSE). 다른 프로세스가 점유 중이거나 PORT를 바꾸세요.`);
  else console.error('[listen] 서버 시작 실패:', err);
  process.exit(1);
});

// Browser SSH/RDP consoles (WebSocket upgrades on /api/remote/ssh and /rdp).
attachSshGateway(server);
attachRdpGateway(server);
// 미일치 경로 upgrade 는 소켓을 파기한다(v2.322 보안 감사): Node http 서버는 'upgrade' 리스너가
// 하나라도 있으면 미처리 소켓을 자동으로 닫지 않고 리스너에 위임한다. 위 두 게이트웨이는 자기
// 경로가 아니면 return 만 하므로, catch-all 이 없으면 임의 경로 + Upgrade 헤더로 소켓/FD 를 무한
// 점유하는 무인증 DoS 가 가능했다. 마지막에 등록해 앞선 핸들러가 처리하지 못한 소켓만 파기한다.
server.on('upgrade', (req, socket) => {
  let p = '';
  try { p = new URL(req.url, 'http://localhost').pathname; } catch { /* 파싱 실패 = 미일치 */ }
  if (p !== '/api/remote/ssh' && p !== '/api/remote/rdp') { try { socket.destroy(); } catch { /* already gone */ } }
});
startMappingExpiry(); // remove ephemeral quick-connect mappings 1 day after last use

// 성능점검 종료 정리 — CSV 배치 버퍼와 저장소 디바운스를 flush 한 뒤 워커를 정리한다.
// 이걸 빼면 마지막 배치(최대 200ms 분량 로그·설정 변경)가 재시작에서 유실된다.
const svcmonShutdown = () => {
  try { closeCsvLog(); } catch { /* noop */ }
  try { flushSvcmonStore(); } catch { /* noop */ }
  try { closeSvcmonPool(); } catch { /* noop */ }
};
/**
 * 정상 종료(v2.447, 감사 I3) — 예전에는 곧바로 process.exit(0) 이라 **진행 중인 HTTP 응답이 잘렸다**.
 * 업그레이드 재시작이 잦은 배포라 그 순간의 요청이 실패로 보였다. 이제
 *  ① 새 연결 수락을 멈추고(server.close) ② 진행 중 응답이 끝나기를 기다린 뒤 ③ 종료한다.
 * 걸린 연결(keep-alive·SSE·WS) 때문에 무한 대기하지 않도록 상한(기본 8초)을 둔다 —
 * systemd 의 TimeoutStopSec 보다 짧아야 SIGKILL 로 잘리지 않는다.
 *
 * ⚠ v2.456 — 위 상한을 **매번 통째로 쓰고 있었다**(운영 실측: stop 8.2초 + start 1.0초).
 * 원인은 RMA 롱폴이다: 엣지가 최대 55초짜리 폴로 HTTP 연결을 열어 두는데(`routes/central.js`),
 * 법인 수만큼 그 연결이 살아 있고 `server.close()` 는 **전부 닫혀야** 콜백을 부른다.
 * 그래서 종료 순서를 이렇게 고쳤다:
 *   ⓐ 롱폴 대기자를 즉시 깨우고(releaseAllWaiters) — 각 폴이 '잡 없음'으로 바로 응답하고 닫힌다
 *   ⓑ server.close() + 유휴 keep-alive 정리
 *   ⓒ 그래도 남은 연결(WS 터널·전송 중 응답)은 짧은 지연 뒤 강제로 끊는다(closeAllConnections)
 * 잡을 잃지 않는다 — 깨어난 폴은 claim 하지 않고, 큐에 남은 잡은 다음 폴이 가져간다.
 */
import { releaseAllWaiters as releaseRmaWaiters } from './rma/jobs.js'; // 종료 시 롱폴 해제(v2.456)

const SHUTDOWN_GRACE_MS = Math.max(1000, Math.min(60_000, Number(process.env.SHUTDOWN_GRACE_MS) || 8000));
let shuttingDown = false;
const gracefulExit = (signal) => {
  if (shuttingDown) return;            // 두 번째 시그널은 무시(중복 종료 경로 방지)
  shuttingDown = true;
  console.log(`[shutdown] ${signal} 수신 — 새 연결을 멈추고 진행 중 요청을 마무리합니다(최대 ${Math.round(SHUTDOWN_GRACE_MS / 1000)}초).`);
  // v2.591 L7: CSV 결과 로그 스트림이 디스크까지 비워질 때를 기다린 뒤 종료한다(상한 2초 — 유예 안쪽).
  let exiting = false;
  const done = (code) => {
    if (exiting) return;
    exiting = true;
    closeCsvLogAsync(2000).catch(() => {}).finally(() => { svcmonShutdown(); process.exit(code); });
  };
  const timer = setTimeout(() => {
    console.warn('[shutdown] 유예 시간 초과 — 남은 연결을 끊고 종료합니다.');
    done(0);
  }, SHUTDOWN_GRACE_MS);
  timer.unref?.();
  // ⓒ 진행 중 요청에 마무리할 시간을 주되, 오래 걸리는 연결(WS 터널·대용량 내려받기) 때문에
  // 유예 전체를 기다리지 않는다. 기본 1.5초 — 일반 API 응답은 그 안에 끝난다.
  const HARD_MS = Math.max(200, Math.min(SHUTDOWN_GRACE_MS - 200, Number(process.env.SHUTDOWN_HARD_MS) || 1500));
  const hard = setTimeout(() => {
    try { server.closeAllConnections?.(); } catch { /* Node 18.2 미만이면 없다 */ }
  }, HARD_MS);
  hard.unref?.();
  // ⓐ 롱폴 먼저 해제 — 이게 없으면 아래 server.close() 가 최대 55초짜리 폴을 기다린다.
  let woken = 0;
  try { woken = releaseRmaWaiters(); } catch { /* 종료 경로에서 실패해도 계속 진행 */ }
  if (woken) console.log(`[shutdown] RMA 롱폴 ${woken}건 해제`);
  try {
    server.close(() => { clearTimeout(timer); clearTimeout(hard); console.log('[shutdown] 진행 중 요청 완료 — 정상 종료'); done(0); });
    server.closeIdleConnections?.();   // keep-alive 유휴 소켓은 즉시 정리(Node 18.2+)
  } catch { clearTimeout(timer); clearTimeout(hard); done(0); }
};
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('exit', svcmonShutdown);
