/**
 * Central orchestration endpoints used by agents (agent -> central). Mounted
 * outside user auth and gated by CENTRAL_TOKEN. Agents pull their IP assignment
 * by name and post scan results back.
 *
 * ## 신규 라우트 규약 (반드시 따를 것)
 * 이 라우터는 사용자 인증 밖에 있으므로 자격증명 횡탈 방어가 **라우트 작성자 책임**이다.
 * 새 엔드포인트를 만들 때:
 *  1. **`req.centralAuth.mode !== 'agent'` 면 거부한다.** 공유 CENTRAL_TOKEN 은 어떤 엣지의
 *     것인지 구별할 수 없어(config 기본값에서 COLLECTOR_TOKEN 과 같은 값이 된다) 엣지별
 *     데이터를 그 토큰으로 쓰게 하면 한 토큰 유출로 전 엣지 데이터가 위조된다.
 *  2. **저장 키는 `req.centralAuth.agent` 만 쓴다.** `body.agent`/`query.agent` 를 저장 키로
 *     읽으면 위 미들웨어의 바인딩 검사를 우회한다(이름 필드를 생략하면 검사가 아예 안 걸린다).
 *  3. 계측·바인딩 이중 방어를 위해 엣지가 `X-Agent-Name` 헤더를 붙이게 한다.
 * 기존 라우트 중 이 3가지를 모두 지키는 것은 `/svcmon-report` 뿐이므로, 다른 라우트를
 * 복사해 시작하면 이 방어가 빠진다.
 */

import { sanitizeVmDns } from '../central/vmDnsSanitize.js';
import { sanitizeVmCfg, sanitizeVmDev } from '../vmcfg/parse.js';   // v2.697(B10)
import { sanitizeSnapTree } from '../vcenter/soapParse.js';   // v2.898 스냅샷 트리
import { sanitizeVcInfo } from '../vcinfo/parse.js';   // v2.898 vCenter 알람·작업·권한
import { putFromEdge as putVcInfoFromEdge } from '../vcinfo/collect.js';
import { sanitizeHostCfg } from '../hostcfg/parse.js';   // v2.699
import { sanitizeDsCfg } from '../dscfg/parse.js';   // v2.700
import { sanitizeVmPerfc, sanitizeHostPerfc } from '../contention/parse.js'; // v2.706(C2·C3)
import { sanitizeHostSpath } from '../storpath/parse.js'; // v2.935(C-①) ESXi 경로 카운터
import { sanitizeClusterCfgList } from '../clustercfg/parse.js';   // v2.701
import { sanitizeTagInv } from '../tags/parse.js';   // v2.703
import { trimTrailingSlashes, COLLECTOR_URL_MAX } from '../util/trimSlashes.js';
import { summarizeRegistryError } from '../util/registryCore.js'; // v2.744(리드 후속 RY): registryUnreadable 503 사유는 요약(원문 없음)
import { safeLoadText } from '../util/atomicWrite.js'; // v2.744(회귀 검토 리드): 설정 파일 손상 사유도 요약(원문 = 파일 조각)
import { Router } from 'express';
import fs from 'node:fs';   // v2.793: VM 백업 위임 — 등록부 파일 존재 확인(읽지 못함 ≠ 비어 있음)
import path from 'node:path';
import { getDataSource as getDataSourceForVmClone } from '../runtime-settings.js';
import { config, loadVcenterConfig, currentVersion, clampIntervalMs } from '../config.js';
import { instanceId } from '../instanceId.js';
import { getAssignment, setResult, listAssignments as listScanAssignments, assignmentsLoadError } from '../central/assignments.js'; // v2.727(D-01): 손상 판정
import { tokenMatches } from '../util/secureCompare.js';
import { resolveAgentByToken, hasAnyAgentToken, listAgentTokens, agentTokensLoadError } from '../central/agentTokens.js';
import { setInventory, getInventory, listInventory } from '../central/inventory.js';
import { noteAgentIdentity, noteVcenterOwner } from '../central/agentIdentity.js';
import { isMockVcenter } from '../mock/generator.js';
import { setEdgeFleet, holdEdgeFleet } from '../central/fleet.js';
import { setGuestGpu, withGpuTrust, mbOrNull, tempOrNull } from '../gpu/store.js';
import { setGpuGuestDiag } from '../central/gpuGuestDiag.js';
import { takePingJobs, setPingResults } from '../central/pingJobs.js';
import { takeIdracScanJobs, applyIdracScanResult, setIdracScanProgress, agentOfReq, noteIdracScanBusyPoll } from '../central/idracScanJobs.js';
import { pullNow as pullCollectorsNow } from '../collector/puller.js';
import { upsertCollectorFromAgent, ssrfBlockReasonResolved, verifyDerivedCollectorUrl } from '../collector/registry.js';
import { selfRegisterDerivedUrl } from '../collector/transportPolicy.js'; // 2026-10-09 검토 S-09
import { recordIngest, noteInventoryCompression } from '../central/ingestStats.js';
import { recordPull, PULL_UNAUTH_KEY } from '../central/pullStats.js';
// v2.570: 거부된 push 를 기록한다 — 아래 집계는 4xx/5xx 를 빼므로, 그것만으로는 '안 보냈다' 와
//         '보냈는데 막혔다' 가 화면에서 똑같이 보인다(조치가 정반대다).
import { recordReject, REJECT_KIND } from '../central/ingestReject.js';
import { notify } from '../alerts.js';
import { ingestReport } from '../central/svcmonEdge.js';
import { getAssignmentForAgent, markPulled, ackAssignment, svcmonAssignLoadError } from '../central/svcmonAssign.js';
import { setAgentConfig } from '../central/agentConfig.js';
import { getAssignedGpuGuest, gpuGuestConfigLoadError } from '../central/agentGpuGuestConfig.js'; // v2.727(D-01): 손상 판정
import { getEffectiveUsers, registryLoadError as agentUsersLoadError } from '../central/agentUsers.js';
import { takeLogQueries, setLogQueryResult, vcenterOfReq } from '../central/logQueries.js';
import { specToRange } from '../ipam/rangePolicies.js';
import { ipToNum } from '../ipam/ledger.js';
import { takeCaptureJobs, applyCaptureResult, captureAgentOfReq } from '../central/captureJobs.js';
import { takeJobsWait as takeRmaJobsWait, setJobResult as setRmaJobResult, jobAgentOf as rmaJobAgentOf, getJob as getRmaJob, noteHeartbeat as noteRmaHeartbeat, onlineInstances as rmaOnlineInstances } from '../rma/jobs.js';
import { accessFor as rmaAccessFor, ipAllowed as rmaIpAllowed, remoteFor as rmaRemoteFor } from '../rma/settings.js';
import { scheduleFor as rmaScheduleFor, assignForInstance as rmaAssign, rmaSchedulesLoadError } from '../rma/schedules.js';
import { ingestResult as rmaIngestResult } from '../rma/testResults.js';
import { commitCollection as commitGuestDisk } from '../guestdisk/db.js';
import { commitVmSeries, setVmSeriesMeta } from '../vmseries/db.js';   // v2.510: 실시간 스파이크 push 수신(vCenter별 독립 DB)
import { loadVmSeriesSettings, vmSeriesSettingsLoadError } from '../vmseries/settings.js';
import { commitCurUser } from '../curuser/db.js';                     // v2.520: '현재 사용자' push 수신
import { load as loadCurUserSettings, curUserSettingsLoadError } from '../curuser/settings.js';
import { recordCurUserActivity } from '../curuser/activityLog.js';
import { load as loadGuestDiskSettings } from '../guestdisk/settings.js';
import { sanitizeGuestDiskVms, splitVmsByOwner } from '../guestdisk/analyze.js';
import { brokerFetch as credentialBrokerFetch } from '../security/credentialStore.js';
import { logAudit } from '../audit.js';
import { takeBmstorJobs, ackBmstorJob, bmstorAgentOfReq, lateBmstorResult, bmstorJobKnown } from '../bmstor/jobs.js';
import { applyBmstorResults } from '../bmstor/poller.js';
import { recordCapture } from '../net/captureHistory.js';
import { loadScanSettings, mergeScanResults, recordAgentReport, recordAgentIncomplete, scanSettingsLoadError } from '../ipam/scanStore.js';
import { recordScanLog } from '../ipam/scanLog.js'; // v2.636: 엣지 스캔 보고·거부를 실행 로그에
import { putEdgeLinkReport } from '../central/linkCheckEdge.js';   // v2.552: 엣지가 잰 통신 링크 결과 수신
import { buildLinks, publicLink, EDGE_KINDS } from '../linkcheck/links.js';
// ⚠ **redact 된 목록**을 쓴다 — 링크 계산에 필요한 것은 name·url·host 뿐이고, 이 응답은 엣지로
//   나간다(비밀이 섞일 여지를 구조적으로 없앤다).
import { listCollectors as listCollectorsForLinks, registryLoadError as collectorsRegistryLoadError } from '../collector/registry.js';
import { allCollectorStatus as allCollectorStatusForKnown } from '../collector/state.js'; // v2.604 CEN2604-04: pull 성공한 자기등록 항목만 '아는 엣지'
import { listRegistry as listVcentersForLinks } from '../vcenter/registry.js';
import { loadLinkCheckSettings, linkCheckEnabled, linkCheckSettingsLoadError } from '../linkcheck/settings.js';

import { wrapAsyncRouter } from '../util/asyncRoute.js';
import { stripCoercionTraps, strOf } from '../util/coercionTrap.js';
import { numOrNull } from '../util/numOrNull.js';
import { canonicalAgent } from '../util/agentKey.js';   // v2.611 CEN2611-02 — CVP 수신 저장 키 대소문자 정규화   // v2.600 CEN2600-01·RECENT2600-01 — 엣지가 보낸 수치 좁히기
import { createChangeLogger } from '../util/logThrottle.js'; // v2.583: 반복 수신 로그 조절
import { capStr, capTrim } from '../util/capStr.js'; // v2.606 TIM2606-02: 상주 기록 글자 평탄화
import { sanitizeVcenterTop } from '../central/vcenterTop.js'; // v2.938: vcenter 객체의 아는 최상위 필드만(엣지 수신 정제)
import { noteAgentContact } from '../central/agentContact.js'; // v2.849 — 엣지 마지막 인증 요청 시각(완전 설치 대상의 '엣지 응답')
const gpuRecvLog = createChangeLogger();
// v2.954(개선 검토 4번): 영역별 파일 — 등록은 아래 원래 자리에서(순서 그대로)
import { registerStorageRoutes } from './central/storageRoutes.js';
import { registerPduSanRoutes } from './central/pduSanRoutes.js';
import { registerCvpIsiduRoutes } from './central/cvpIsiduRoutes.js';
import { registerOpsRoutes } from './central/opsRoutes.js';
import { handleEdgeSync } from '../central/focusMonEdge.js'; // v2.976 집중 모니터링 엣지 동기화
export { EDGE_CLOCK_AHEAD_TOLERANCE_MS, stampEdgeCollectedAt } from './central/storageRoutes.js';
export { AGENT_CONFIG_FILE_MAX } from './central/opsRoutes.js';
export const centralRouter = Router();
let _getPaths = null;
/** 이 라우터에 선언된 GET 경로 집합(첫 호출 때 한 번 만든다 — 라우트 등록은 모듈 로드 때 끝난다). */
function declaredGetPaths() {
  if (!_getPaths) {
    _getPaths = new Set();
    for (const l of centralRouter.stack) if (l.route?.methods?.get && typeof l.route.path === 'string') _getPaths.add(l.route.path);
  }
  return _getPaths;
}
let _postPaths = null;
/** v2.599(WEB2599-01·04): 선언된 POST 경로 집합 — 없는 경로로 온 거부를 경로별 키로 쌓지 않게 한 칸으로 접는다. */
function declaredPostPaths() {
  if (!_postPaths) {
    _postPaths = new Set();
    for (const l of centralRouter.stack) if (l.route?.methods?.post && typeof l.route.path === 'string') _postPaths.add(l.route.path);
  }
  return _postPaths;
}
/** 라우터에 없는 경로로 온 거부의 경로 칸(한 칸) — 경로 문자열은 요청자가 고른 값이라 키로 쓰지 않는다. */
export const UNKNOWN_ROUTE_KEY = '(없는 경로)';
// v2.574 BUG-03: express 4 는 async 핸들러의 throw 를 잡지 않아 그 요청이 **응답 없이
// 매달린다**(소켓 fd 가 잡힌다). 라우트를 등록하기 **전에** 감싸 전역 에러 핸들러로 보낸다.
// ⚠ 라우트 등록보다 아래로 옮기지 말 것 — 그 뒤에 등록된 것만 보호된다.
wrapAsyncRouter(centralRouter);

// v2.603(감사 CEN2603-05): 본문 객체의 자기 속성 toString/valueOf 를 입구에서 지운다 — `{"toString":1}` 한 값이 String()/`${}`/
//   Number()/배열 join 에서 던져 수신 경로 16곳이 500 이었다(util/coercionTrap.js). 필드마다 고치면 다음 필드에서 또 난다.
//   모든 라우트보다 앞(인증·집계 미들웨어 포함 — 그쪽도 본문 agent 를 글자로 바꾼다).
centralRouter.use((req, _res, next) => {
  if (req.body && typeof req.body === 'object') {
    const n = stripCoercionTraps(req.body);
    if (n) req.coercionTrapsRemoved = n;
  }
  next();
});

// 수신 트래픽 진단 — 에이전트→중앙 POST의 와이어 바이트(Content-Length)·페이로드 요약을 에이전트·
// 엔드포인트별로 집계한다(특정 에이전트가 무엇을 얼마나 보내는지 화면에서 확인). 응답 완료 시 1회 기록.
centralRouter.use((req, res, next) => {
  // v2.587 — 엣지가 **가져가는**(GET) 요청도 기록한다(데이터 흐름 지도). 예전에는 POST 만 세어
  //   설정 pull·작업 인출이 언제·누가 가져갔는지 중앙에 남지 않았다. 키는 매칭된 라우트의 선언 경로
  //   (`req.route.path`) — 매칭되지 않은 요청은 세지 않는다(없는 경로로 키를 불리지 못하게).
  if (req.method === 'GET') {
    res.on('finish', () => {
      try {
        // 인증에서 막힌 요청은 라우트 매칭 전에 끝나 req.route 가 없다 — 그래도 **선언된 경로면** 실패로 센다
        // (막힌 pull 이 안 보이면 '안 가져갔다' 와 '막혔다' 가 구분되지 않는다).
        const ep = req.route?.path || (declaredGetPaths().has(req.path) ? req.path : '');
        if (!ep) return;
        const auth = req.centralAuth;
        // v2.589 — **인증에 실패한 요청의 이름은 믿지 않는다.** 예전에는 토큰 없이 ?agent=<실제 엣지> 만
        //   보내도 그 실패가 실제 엣지의 기록에 합쳐져(개별 토큰 엣지면 '검증됨' 행에) 지도에 거짓 장애가
        //   떴고, 이름 500개로 LRU 가 실제 기록을 밀어냈다(감사 3축이 독립 재현). 인증 실패는 이름을
        //   버리고 **한 칸**(PULL_UNAUTH_KEY)에만 센다 — 막힌 pull 이 있었다는 사실은 남긴다.
        const agent = auth?.ok
          ? (String(auth.agent || req.query?.agent || req.get('X-Agent-Name') || '').trim() || '(unknown)')
          : PULL_UNAUTH_KEY;
        recordPull(agent, ep, { status: res.statusCode, bytes: Number(res.get('content-length')) || 0, verified: !!auth?.ok && auth.mode === 'agent' });
      } catch { /* 진단은 best-effort */ }
    });
  }
  if (req.method === 'POST') {
    res.on('finish', () => {
      try {
        // v2.591(3차 감사 PR-1·PR-2): 이름은 **인증된 토큰의 것이 먼저**다. 예전에는 본문 agent 를 그대로 Map 키로 써서
        //   ① 개별 토큰 edge-a 가 본문에 edge-b 를 적으면 저장은 edge-a, 집계는 edge-b(죽은 엣지를 살아 있게 그림)였고
        //   ② 본문 agent 에 길이 상한이 없어 5MB 문자열 30개로 중앙 RSS 가 179→726MB, 데이터 흐름 지도가 10초 멈춘 뒤 500 이었다.
        //   공유 토큰이면 주장된 이름을 쓰되 64자로 자르고 verified:false 로 남긴다(형제 ingestReject·pullStats 와 같은 상한).
        const auth = req.centralAuth;
        const verified = !!auth?.ok && auth.mode === 'agent';
        // v2.599(WEB2599-01): **인증에 실패한 요청의 이름은 믿지 않는다** — v2.589 GET 계측과 같은 규약. 예전에는 무토큰
        //   POST 의 주장 이름(body.agent·X-Agent-Name)마다 거부 기록이 생겨 데이터 흐름·3단 지도에 가짜 엣지(최대 500)가 그려졌다.
        //   인증 실패는 한 칸(PULL_UNAUTH_KEY)에만 센다 — 막힌 push 가 있었다는 사실은 남긴다.
        const agent = auth && !auth.ok
          ? PULL_UNAUTH_KEY
          : (verified ? String(auth.agent || '').trim().slice(0, 64) : (strAgent(req.body?.agent) || strAgent(req.get('X-Agent-Name')))) || '(unknown)';
        const wireBytes = Number(req.get('content-length')) || 0;
        if (res.statusCode >= 400) {
          // v2.570 — 거부는 **수신 집계에서 빼되 따로 기록**한다. 예전에는 여기서 그냥 return 해
          // 거부된 push 가 어디에도 남지 않았고, 그래서 진단 표의 '최근 페이로드 —' 가
          // '안 보냈다'(엣지 문제)와 '막혔다'(중앙 판정)를 구분하지 못했다.
          // ⚠ 이 agent 이름은 **검증되지 않은 값**이다(거부됐으므로 토큰 바인딩을 통과하지 못했을
          //   수 있다) — `ingestReject.js` 가 상한을 걸고 응답이 그 사실을 밝힌다.
          const hint = res.locals?.ingestReject;
          // v2.599(WEB2599-04): 라우터에 없는 경로(req.route 없음 · 선언 목록에도 없음)는 '수신 꺼짐' 이 아니다 — 종류를
          //   따로 두고(unknown-route) 경로는 한 칸으로 접는다. 선언된 경로의 404 만 중앙 수신 비활성으로 본다.
          const declared = !!req.route || declaredPostPaths().has(req.path);
          const kindHint = hint?.kind
            || (!declared ? REJECT_KIND.UNKNOWN_ROUTE
              : res.statusCode === 404 ? (centralEnabled() ? REJECT_KIND.OTHER : REJECT_KIND.DISABLED) : '');
          recordReject(agent, declared ? req.path : UNKNOWN_ROUTE_KEY, {
            status: res.statusCode,
            kind: kindHint,
            reason: hint?.reason || (res.statusCode === 403 ? (req.centralAuth?.reason || '토큰 불일치') : ''),
            vcenterId: hint?.vcenterId || String(req.body?.vcenterId || ''),
            wireBytes,
          });
          return;
        }
        if (!wireBytes && agent === '(unknown)') return;
        // 인벤토리 push는 페이로드 규모(vCenter·호스트·VM 수)도 함께 기록 → '왜 큰지' 바로 파악.
        const b = req.body || {};
        const summary = res.locals?.ingestSummary || (req.path === '/inventory'
          ? { vcenterId: capStr(b.vcenterId, 128), hosts: (b.hosts || []).length, vms: (b.vms || []).length,
              datastores: (b.datastores || []).length, networks: (b.networks || []).length, alarms: (b.alarms || []).length,
              gzip: (req.get('content-encoding') || '').includes('gzip') }
          : null);
        recordIngest(agent, req.path, { wireBytes, summary, verified });
        // 무압축 대형 인벤토리 push 경고 승격(v2.344, #12) — 진단 표에만 보이던 '무압축(구버전
        // 엣지 추정)'을 알림 채널로. 연속 임계는 추적기가, 재발화 억제는 warned 래치+notify
        // 전역 억제 창이 담당. 알림 실패가 수신 경로를 막지 않게 catch.
        if (summary) {
          const ev = noteInventoryCompression(agent, { gzip: summary.gzip, wireBytes });
          if (ev?.type === 'warned') {
            notify({
              key: `ingest-plain:${ev.agent}`, severity: 'warning',
              title: `엣지 '${ev.agent}' 무압축 인벤토리 push 감지`,
              detail: `push당 ${(ev.wireBytes / 1048576).toFixed(1)}MB(무압축, 연속 ${ev.streak}회) — 구버전 엣지 또는 AGENT_PUSH_GZIP=false 추정. gzip 적용 시 ~1/5~1/10. 설정 › 수집 서버(원격) → 모두 업그레이드 권장.`,
            }).catch(() => {});
          } else if (ev?.type === 'resolved') {
            notify({
              key: `ingest-plain-ok:${ev.agent}`, severity: 'warning',
              title: `엣지 '${ev.agent}' 무압축 push 해소`,
              detail: 'gzip 압축 push 가 다시 관측되었습니다(업그레이드/설정 정상화).',
            }).catch(() => {});
          }
        }
      } catch { /* 진단은 best-effort */ }
    });
  }
  next();
});

// central 활성 조건 — 공유 CENTRAL_TOKEN 또는 엣지별 개별 토큰이 하나라도 있으면 활성.
// (개별 토큰만 발급하고 공유 토큰을 없애는 '완전 이관' 구성도 지원하기 위함.)
const centralEnabled = () => Boolean(config.central.token) || hasAnyAgentToken();

// 공유 토큰을 아예 금지하는 강화 모드(전 엣지 개별 토큰 이관 완료 후 켠다).
const REQUIRE_AGENT_TOKEN = process.env.CENTRAL_REQUIRE_AGENT_TOKEN === 'true';

// 공유 토큰 사용 통계 — 관리 화면이 '아직 개별 토큰으로 이관되지 않은 엣지가 있다'를 알 수 있게.
const sharedStats = { uses: 0, lastAt: null, lastAgent: '', lastPath: '' };
export function getCentralAuthStats() {
  // v2.771(점검 R6-F4-2): 토큰 파일을 읽지 못했으면 agentTokens 는 null(모름) + 사유 요약 — 0 은 '발급 없음' 으로 읽힌다.
  const tokErr = agentTokensLoadError();
  return { ...sharedStats, requireAgentToken: REQUIRE_AGENT_TOKEN, agentTokens: tokErr ? null : listAgentTokens().length, agentTokensUnreadable: tokErr };
}

/**
 * central 인증 — 엣지별 개별 토큰이 우선, 없으면 공유 CENTRAL_TOKEN(하위호환).
 * 개별 토큰으로 인증하면 req.centralAuth.agent 에 그 엣지 이름이 바인딩되고, 아래 미들웨어가
 * '자기 agent 데이터만' 접근하도록 강제한다(엣지 1대 침해로 전 사이트 자격증명이 새는 것 차단).
 */
/**
 * v2.538: export 한다 — index.js 의 BIG_JSON 게이트가 **본문을 파싱하기 전에** 이 함수로 토큰을 본다.
 * 순수(부작용 없음): 토큰 파일 캐시 조회 + 상수시간 비교뿐. sharedStats 갱신은 아래 use() 가 한다.
 */
export function resolveCentralAuth(req) {
  const t = req.get('X-Central-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const bound = resolveAgentByToken(t);
  if (bound) return { ok: true, mode: 'agent', agent: bound };
  if (config.central.token && tokenMatches(t, config.central.token)) {
    if (REQUIRE_AGENT_TOKEN) return { ok: false, reason: '공유 CENTRAL_TOKEN은 비활성입니다(CENTRAL_REQUIRE_AGENT_TOKEN=true) — 이 엣지의 개별 토큰을 사용하세요.' };
    return { ok: true, mode: 'shared', agent: null };
  }
  return { ok: false, reason: '토큰 불일치' };
}

/**
 * agent 주장의 **형식** 검사(v2.977) — 쿼리 · 본문의 agent 가 있는데 글자가 아니면 사유를 돌려준다(없거나 null 이면 통과).
 * Express 기본 쿼리 해석(extended)은 `agent[]=x` · `agent[0]=x` · `agent[k]=x` 를 배열 · 객체로 만든다. 헤더는 항상 글자다.
 * @returns {string|null}
 */
/** 쿼리 · 헤더 · 본문 agent 의 **잘리지 않은** 원문(글자인 것만 · 앞뒤 공백만 뗌 · 64자를 넘는 것만 — 짧으면 want 와 같다). */
function rawAgentClaims(req) {
  const out = [];
  for (const v of [req?.query?.agent, req?.get?.('X-Agent-Name'), req?.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body.agent : undefined]) {
    if (typeof v === 'string') { const t = v.trim(); if (t.length > 64) out.push(t); }
  }
  return out;
}
export function agentClaimTypeIssue(req) {
  const q = req?.query?.agent;
  if (q !== undefined && typeof q !== 'string') return `쿼리 agent 가 ${Array.isArray(q) ? '배열' : typeof q}`;
  const b = req?.body;
  if (b && typeof b === 'object' && !Array.isArray(b) && Object.hasOwn(b, 'agent') && b.agent != null && typeof b.agent !== 'string') return `본문 agent 가 ${Array.isArray(b.agent) ? '배열' : typeof b.agent}`;
  return null;
}

// 요청이 다루려는 agent 이름(쿼리·헤더·본문 순).
const requestedAgent = (req) => strAgent(req.query?.agent) || strAgent(req.get('X-Agent-Name')) || strAgent(req.body?.agent);

/**
 * v2.600(감사 CEN2600-10): 요청이 주장한 agent 이름은 **글자일 때만** 쓰고 64자로 자른다(v2.591 PR-1 수신 집계와 같은 상한).
 * 예전에는 `String(b.agent || '')` 라 본문 `agent:{toString:'x'}` 하나로 String() 이 던져 공유 토큰 수신이 500 이었다.
 */
// v2.606(감사 TIM2606-02): `.trim().slice(0, 64)` 는 SlicedString 이라 64자가 본문 원문(최대 16MB)을 붙잡은 채 수신 집계
//   Map 키로 상주했다(감사 실측: 5MB agent 30개 → 잔존 힙 143MB). capTrim 이 잘라 평탄화한다.
function strAgent(v) { return typeof v === 'string' ? capTrim(v, 64) : ''; }

// /register-collector 의 실제 저장 키는 body.name 이다 — 바인딩에서 **항상 별도로** 대조한다.
// ⚠ 보안(H-1, 2026-09-12): 이 값을 requestedAgent 의 OR 체인 끝에 두면, 공격자가 X-Agent-Name
// 에 자기 이름을 넣어 미들웨어를 통과시키고 body.name 에는 남의 엣지 이름을 넣어 그 수집 서버의
// URL·collectorToken 을 덮어쓸 수 있었다(중앙이 그 URL 로 자격증명을 실어 호출 → 유출 피벗).
// 그래서 헤더 유무와 무관하게 register-collector 는 body.name 을 반드시 검사한다.
// ⚠ 보안(v2.500 감사 C-1): `req.path === '/register-collector'` 정확 일치는 **Express 기본 라우팅
// 설정에서 우회된다**. strict routing=false·case sensitive=false 라 `/register-collector/`,
// `/Register-Collector`, `/register-collector/.` 도 핸들러에는 도달하지만 이 비교는 거짓이 되어
// body.name 대조가 통째로 건너뛰어졌다(실측: 3개 변형 모두 claim='' 인 채 200). 헤더·쿼리 agent 를
// 생략하면 requestedAgent 도 '' 이라 미들웨어 대조가 0건이 된다.
// 경로를 정규화해 심층 방어하고, **실제 강제는 핸들러 안**(registerBindingDenied)에서 한다 —
// 경로 문자열에 의존하는 게이트를 다시 만들지 말 것.
// v2.602(감사 SEC2602-01): 끝 '/' 는 **루프로** 뗀다 — `/\/+$/` 는 '/' 연속 뒤에 다른 글자가 오면 시작 위치마다 끝까지
//   훑어 O(n²) 이고, 이 함수는 인증 전 모든 central 요청에서 돈다(헤더 16KB 상한까지 요청당 약 0.2초).
// v2.611: 함수 본체는 util/trimSlashes.js 로 옮겼다(collector/registry.js 와 공유). 재수출은 import+export 형태(v2.575 — `export … from` 은 이 모듈 스코프에 이름을 만들지 않는다).
export { trimTrailingSlashes };
export const normPath = (p) => trimTrailingSlashes(typeof p === 'string' ? p : '').replace(/\/\.$/, '').toLowerCase();
const registerName = (req) => (normPath(req.path) === '/register-collector' ? (typeof req.body?.name === 'string' ? req.body.name.trim() : '') : '');

/**
 * register-collector 의 저장 키(body.name) ↔ 토큰 바인딩 대조 — **경로와 무관하게** 핸들러가 부른다.
 * 반환: null(허용) 또는 거부 사유. 공유 토큰 모드는 기존 신뢰 유지(TOFU).
 */
function registerBindingDenied(req, name) {
  if (req.centralAuth?.mode !== 'agent') return null;
  const bound = String(req.centralAuth.agent || '').trim();
  if (!name || name.toLowerCase() === bound.toLowerCase()) return null;
  return `이 토큰은 '${bound}' 전용입니다(요청: '${name}').`;
}

// 인증 1회 해석 + agent 바인딩 강제(모든 라우트 공통). 라우트별 authed(req)는 이 결과를 읽는다.
centralRouter.use((req, res, next) => {
  const auth = resolveCentralAuth(req);
  req.centralAuth = auth;
  if (!auth.ok) return next(); // 각 라우트가 404/403을 구분해 응답(하위호환 유지)
  // v2.977(전체 점검 — 심층 방어): agent 는 **글자 하나만**. `?agent[]=edge-b` · 본문 agent:['edge-b'] 는 strAgent 가 '' 로 읽어 아래 대조를 건너뛰고,
  //   핸들러의 `String(req.query.agent)` 는 'edge-b' 로 읽는다. ⚠ 정정(같은 날 반증): 운영 포탈에서는 index.js 의 queryNormalizer 가 이 라우터보다 먼저
  //   쿼리 배열을 글자로 바꿔 대조가 403 을 낸다 — 다른 법인 자격증명 유출은 **맨 express 구성(정규화 없음)에서만** 재현됐다. 정규화 순서가 바뀌어도
  //   이 대조가 무너지지 않게 여기서도 막는다. 글자가 아니면 어떤 모드든 400.
  const typeIssue = agentClaimTypeIssue(req);
  if (typeIssue) {
    console.warn(`[central] agent 형식 거부 — ${typeIssue} (${req.method} ${req.path}, 토큰=${auth.mode === 'agent' ? auth.agent : 'shared'})`);
    return res.status(400).json({ ok: false, reason: `agent 는 글자 하나여야 합니다(${typeIssue}).` });
  }
  const want = requestedAgent(req);
  if (auth.mode === 'agent') {
    // 개별 토큰은 남의 이름으로 조회/보고/등록할 수 없다 — 자격증명 횡탈·데이터 위장 차단.
    // want(쿼리/헤더/본문 agent)와 register-collector 의 body.name 을 **둘 다** 대조한다.
    // v2.977(반증 F5): strAgent 는 64자로 잘라 비교하는데 핸들러는 원문을 쓴다 — 64자 이름의 엣지가 '그 이름으로 시작하는 더 긴 이름' 의 설정을 받을 수 있었다.
    //   잘리지 않은 원문(앞뒤 공백만 뗌)도 함께 대조한다.
    for (const claim of [want, registerName(req), ...rawAgentClaims(req)]) {
      if (claim && claim.toLowerCase() !== String(auth.agent).toLowerCase()) {
        console.warn(`[central] agent 불일치 거부 — 토큰=${auth.agent} 요청=${String(claim).slice(0, 80)} (${req.method} ${req.path})`);
        return res.status(403).json({ ok: false, reason: `이 토큰은 '${auth.agent}' 전용입니다(요청: '${String(claim).slice(0, 80)}').` });
      }
    }
  }
  if (auth.mode === 'shared') {
    sharedStats.uses++; sharedStats.lastAt = Date.now();
    sharedStats.lastAgent = want || registerName(req) || '(unknown)'; sharedStats.lastPath = req.path;
  }
  // v2.849: 엣지 생존 신호 — 개별 토큰은 그 이름, 공유 토큰은 중앙이 이미 아는 이름일 때만(지어낸 이름으로 표를 채우지 못하게)
  try { noteAgentContact(auth.mode === 'agent' ? String(auth.agent || '') : (want && edgeNameKnown(want, _contactKnownNames) ? want : '')); } catch { /* 기록 실패는 요청을 막지 않는다 */ }
  next();
});

function authed(req) { return Boolean(req.centralAuth?.ok); }
// 인증 실패 사유(토큰 불일치 / 공유 토큰 금지)를 그대로 전달해 운영자가 원인을 알 수 있게.
const denyReason = (req) => req.centralAuth?.reason || '토큰 불일치';

/**
 * v2.613(감사 DEPS2613-09): 라우트마다 손으로 반복하던 2줄 게이트(404 central 비활성화 → 403 인증 실패)를 미들웨어 1벌로.
 *   51개 라우트가 같은 두 줄을 복사하고 있었고, 4곳(storage/pdu/sanswitch/cvp-config)은 위 `centralRouter.use` 미들웨어가
 *   `requestedAgent`(query.agent·X-Agent-Name·body.agent)로 **이미 끝낸** 토큰↔agent 대조를 부분집합(query·헤더)으로 다시 하고
 *   있었다(도달 불가 중복 — 함께 지웠다). 응답 본문은 라우트별 예전 값 그대로다(`notFound` 로 두 변형을 지정한다):
 *   기본 `{ok:false, reason:'central 비활성화'}` · /assignment·/register-collector `'central 비활성화 (CENTRAL_TOKEN 미설정)'` ·
 *   /result·/rma-result·/ping-result·/log-query-result·/capture-result·/bmstor-result·/ip-scan-result `{ok:false}`.
 *   ⚠ 순서가 계약이다 — 비활성(404)을 먼저 본다(예전과 같다: 토큰이 틀려도 central 이 꺼져 있으면 404).
 * @param {{notFound?:object}} [o]
 */
export function requireCentral({ notFound = { ok: false, reason: 'central 비활성화' } } = {}) {
  requireCentralGate.gate = Object.freeze({ kind: 'central' }); // v2.614 아키텍처 점검 태그(auth.js requireRole 참조)
  return requireCentralGate;
  function requireCentralGate(req, res, next) {
    // v2.771(점검 R6-F4-2): 개별 토큰 파일을 **읽지 못한** 동안의 거절은 '꺼짐(404)'·'토큰 불일치(403)' 가 아니라 503 이다 — 엣지는 404 를
    //   '중앙 미지원' 으로 6시간 물러나고 403 을 인증 실패로 다룬다(조치가 틀린다). 허용 범위는 넓히지 않는다(거절만 바꾼다). 판정은 실패 갈래에서만.
    if (!centralEnabled()) return agentTokensUnreadable(res) ? undefined : res.status(404).json(notFound);
    if (!authed(req)) return agentTokensUnreadable(res) ? undefined : res.status(403).json({ ok: false, reason: denyReason(req) });
    next();
  }
}

/** v2.771(R6-F4-2): 토큰 파일을 읽지 못했으면 503 registryUnreadable 로 답하고 true(사유는 요약 — 원문 없음). */
function agentTokensUnreadable(res) {
  let e = null;
  try { e = agentTokensLoadError(); } catch { e = null; }
  if (!e) return false;
  persistent503(res).json({ ok: false, reason: 'registryUnreadable', detail: `중앙 엣지 개별 토큰 파일(central-agent-tokens.json)을 읽지 못했습니다(${e.text}) — 엣지는 직전 상태를 유지하고 다시 시도합니다. 중앙 설정 디렉터리의 손상 보존본을 되돌리거나 토큰을 다시 발급하세요.`, since: e.at || null });
  return true;
}

/**
 * agent 가 이 vCenter 를 소유(inventory 등록)했나 — 조회/보고 select 키가 vcenters 인 라우트의
 * 소유권 검증. `?vcenters=` 로 데이터를 고르는 라우트는 미들웨어 바인딩(want 이 비면 단락)을
 * 우회하므로, 개별 토큰(agent 모드)이 남이 소유한 vCenter 의 잡/결과를 가로채/위조하지 못하게 한다.
 * 소유주가 없는 vCenter(미등록/direct-mode)는 TOFU 로 통과 — 정상 엣지 작업 분배를 깨지 않는다.
 * (공유 토큰 모드는 '구별 불가한 전체 신뢰'라 여기서 검사하지 않는다 — 완전 봉인은
 *  CENTRAL_REQUIRE_AGENT_TOKEN=true. gpu-guest-data 의 agent-모드-한정 검사와 동일 정책.)
 */
function agentOwnsVcenter(agent, vcenterId) {
  if (!agent || !vcenterId) return true;
  const owner = listInventory().find((e) => String(e.vcenterId) === String(vcenterId))?.agent || '';
  return !owner || owner.toLowerCase() === String(agent).toLowerCase();
}

/**
 * v2.600(감사 CEN2600-02·03): 엣지가 **이 vCenter 의 데이터를 써도 되는가** — 등록부 기준 판정.
 *  - 중앙 직접 수집(direct) vCenter 는 **어느 엣지도 쓸 수 없다** — 엣지는 그 vCenter 를 수집하지 않으므로 그 쓰기는 위조다.
 *    예전에는 gpu-guest-data 만 이 규칙이 있었고(v2.537) guest-disk·curuser·vmseries·ping-result·log-query-result 는
 *    agentOwnsVcenter 의 TOFU(소유주 없음 = 통과)로 받아, 개별 토큰 엣지가 direct vCenter 의 '현재 사용자'·게스트 디스크를 주입했다.
 *  - `requireSite`: 등록부에 **site 로 등록된** id 만 받는다(vmseries — 등록되지 않은 id 마다 SQLite 파일이 생겼다).
 *    위임 인벤토리 캐시도 등록부에 없는 id 는 매 주기 지운다(store.js pruneInventory) — 정상 엣지의 vCenter 는 site 로 등록돼 있다.
 *  - 등록부를 읽지 못하면 판정하지 않는다(null) — 설정 파일 문제가 모든 엣지 수신을 끊지 않게(기존 소유권 검사는 그대로 돈다).
 * ⚠ 공유 토큰에도 적용한다 — 소유권(누가)이 아니라 **대상의 구조적 성질**(엣지가 수집하지 않는 vCenter)이라 토큰 종류와 무관하다.
 * @returns {string|null} 거부 사유 또는 null(허용)
 */
let _vcModes = { at: 0, map: null };
function vcCollectModes() {
  const now = Date.now();
  if (_vcModes.map && now - _vcModes.at < 5_000) return _vcModes.map;
  let map = null;
  try {
    map = new Map();
    for (const v of loadVcenterConfig().vcenters || []) if (v && v.id != null) map.set(String(v.id), (v.collectMode || 'direct') === 'site' ? 'site' : 'direct');
  } catch { map = null; }
  _vcModes = { at: now, map };
  return map;
}
function edgeVcWriteDenied(vcenterId, { requireSite = false } = {}) {
  const modes = vcCollectModes();
  if (!modes) return null;
  const id = String(vcenterId ?? '');
  const mode = modes.get(id);
  if (mode === 'direct') return `vcenterId '${id.slice(0, 128)}' 는 중앙이 직접 수집하는(direct) vCenter 입니다 — 엣지가 이 vCenter 의 데이터를 쓸 수 없습니다.`;
  if (!mode && requireSite) return `vcenterId '${id.slice(0, 128)}' 는 중앙 vCenter 등록부에 사이트 위임(site)으로 등록돼 있지 않습니다 — 설정 › vCenter 에서 수집 방식을 '사이트 위임' 으로 등록하세요.`;
  return null;
}
export function _resetVcModesForTest() { _vcModes = { at: 0, map: null }; }

// 위임 잡(iDRAC 스캔·캡처) reqId 소유권 판정. reqId 는 예측가능(idscan_<time>_<seq>·cap_<time>_<seq>)
// 하므로, 개별 토큰 agent 가 남의 reqId 로 진행/결과를 위조 주입하지 못하게 막는다. 공유 CENTRAL_TOKEN
// (레거시)과 미상 잡(assignedAgent='')은 기존 신뢰를 유지(TOFU) — 정상 엣지 흐름 무회귀.
function reqAgentDenied(req, assignedAgent) {
  if (req.centralAuth?.mode !== 'agent') return false; // 공유 토큰: 기존 신뢰
  if (!assignedAgent) return false;                    // 미상 잡: TOFU 통과
  return String(req.centralAuth.agent || '').trim().toLowerCase() !== String(assignedAgent).trim().toLowerCase();
}

// Agent pulls the IP assignment for its name (incl. iDRAC credentials).
centralRouter.get('/assignment', requireCentral({ notFound: { ok: false, reason: 'central 비활성화 (CENTRAL_TOKEN 미설정)' } }), (req, res) => {
  // v2.727(감사 D-01): 배정 파일이 손상(보존본만 남음)이면 `assigned:false` 가 아니라 503 — 엣지는 '중앙 지정 없음' 과 구분해 직전 상태를 유지한다.
  if (settingsUnreadable(res, assignmentsLoadError, 'iDRAC 스캔 배정')) return;
  const a = getAssignment(req.query.agent);
  if (!a || a.enabled === false) return res.json({ ok: true, assigned: false });
  res.json({ ok: true, assigned: true, agent: a.agent, ips: a.ips, username: a.username, password: a.password });
});

// 엣지 자기등록(EDGE_MODE=all): 부팅한 엣지가 자기 이름/포트/수집토큰을 알리면 수집 서버
// 목록에 자동 upsert — 관리자의 '수집 서버 추가' 수동 절차가 필요 없어진다.
// Body: { name, port, collectorToken, datacenter?, urlHint?, version? }
const REGISTER_URL_MAX = COLLECTOR_URL_MAX; // v2.611: 관리자 등록과 같은 상한(util/trimSlashes.js)
const REGISTER_TOKEN_MAX = 1024;
centralRouter.post('/register-collector', requireCentral({ notFound: { ok: false, reason: 'central 비활성화 (CENTRAL_TOKEN 미설정)' } }), async (req, res) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : ''; // v2.600 CEN2600-10: 객체 name 이 String() 에서 던지지 않게
  if (!name) return res.status(400).json({ ok: false, reason: 'name이 필요합니다.' });
  // v2.500(감사 C-1): 미들웨어의 경로 일치가 우회돼도 여기서 반드시 막힌다.
  const bindDenied = registerBindingDenied(req, name);
  if (bindDenied) {
    console.warn(`[central] agent 불일치 거부(register-collector) — 토큰=${req.centralAuth?.agent} 요청=${name}`);
    return res.status(403).json({ ok: false, reason: bindDenied });
  }
  if (!b.collectorToken) return res.status(400).json({ ok: false, reason: 'collectorToken이 필요합니다(엣지의 export 인증 토큰).' });
  // v2.771(점검 R6-F4-2): 수집 서버 등록부를 읽지 못했으면 검증 ping(엣지로 나가는 요청) 전에 503 — 등록부도 자동 저장을 거절한다(upsertCollectorFromAgent).
  if (registryUnreadable(res, collectorsRegistryLoadError, '수집 서버')) return;
  // ⚠ v2.602(감사 SEC2602-01): urlHint·collectorToken 은 **글자·길이부터** 본다. 예전에는 길이 상한이 없어 '/' 12만 개 +
  //   'x' 인 urlHint 하나가 registry.js 의 `/\/+$/`(verifyDerivedCollectorUrl·normalize 두 번)에서 O(n²) 로 돌아 중앙
  //   이벤트 루프가 23초 멈췄다(동시 /api/auth/config 8.7초). 객체면 String() 이 던졌다.
  if (b.urlHint != null && typeof b.urlHint !== 'string') return res.status(400).json({ ok: false, reason: 'urlHint는 문자열이어야 합니다.' });
  if (typeof b.urlHint === 'string' && b.urlHint.length > REGISTER_URL_MAX) return res.status(400).json({ ok: false, reason: `urlHint가 너무 깁니다(${REGISTER_URL_MAX}자 이하).` });
  if (typeof b.collectorToken !== 'string' || b.collectorToken.length > REGISTER_TOKEN_MAX) return res.status(400).json({ ok: false, reason: `collectorToken은 ${REGISTER_TOKEN_MAX}자 이하 문자열이어야 합니다.` });
  // URL: 엣지가 명시(urlHint)하지 않으면 요청 peer IP + 알린 포트로 유도(NAT 없는 사내망 가정).
  let url = trimTrailingSlashes(String(b.urlHint || '').trim());
  const regDc = typeof b.datacenter === 'string' ? b.datacenter.slice(0, 128) : '';
  const regVer = typeof b.version === 'string' ? b.version.slice(0, 32) : '';
  if (!url) {
    const port = Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ ok: false, reason: 'port가 올바르지 않습니다(1~65535) — urlHint로 전체 주소를 지정하세요.' });
    }
    // v2.428: TRUST_PROXY 설정 시 express 가 X-Forwarded-For 로 계산한 req.ip 를 쓴다(중앙이 프록시 뒤일 때). 아니면 소켓 peer.
    let ip = String((req.app?.get('trust proxy') ? req.ip : '') || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    if (!ip) return res.status(400).json({ ok: false, reason: '요청 IP를 확인할 수 없습니다(urlHint를 지정하세요).' });
    // 중앙이 리버스 프록시(nginx/HAProxy) 뒤면 peer가 127.0.0.1이 되어 모든 엣지가 중앙
    // 자신으로 등록되는 사고가 난다 → 루프백이면 거절하고 urlHint를 요구.
    if (/^(127\.|::1$|::$)/.test(ip) || ip === 'localhost') {
      return res.status(400).json({ ok: false, reason: '요청 IP가 루프백입니다(중앙이 프록시 뒤). 엣지에 EDGE_ADVERTISE_URL(urlHint)를 지정하세요.' });
    }
    // 2026-10-09 검토 S-09: 엣지가 TLS 로 받는다고 알렸을 때만 https(scheme==='https'). 지어내지 않는다 — 평문이면 등록부가 판정한다.
    url = selfRegisterDerivedUrl({ ip, port, scheme: b.scheme });
  }
  // 엣지 자기등록 URL(특히 urlHint)은 신뢰 경계 밖 입력 — 저장 전 **해석형** SSRF 가드로 DNS 우회까지
  // 차단한다. 중앙이 이 URL 로 주기적 수집 요청을 보내므로(SSRF), 저장 경로 sync 검사만으로는 차단
  // 대역으로 '해석되는 이름'을 놓친다(감사 M-R4). RFC1918 사내 대역은 허용, 루프백/메타데이터만 차단.
  const ssrfReason = await ssrfBlockReasonResolved(String(url));
  if (ssrfReason) return res.status(400).json({ ok: false, reason: `수집 서버 URL: ${ssrfReason}` });
  // v2.424: peer IP 로 유도한 URL 은 **실제로 이 엣지에 닿는지** 확인한 뒤에만 등록한다. 중앙→엣지A→엣지B 처럼 B 가 A 의
  // 포워딩을 거쳐 오면 peer IP 는 A 라, 'B 이름 + A 주소:B 포트 + B 토큰' 항목이 생겨 A 에 403 을 반복하며 '오류'로 남았다
  // (실제 사례). ping 이 403/불일치/불통이면 등록하지 않고 EDGE_ADVERTISE_URL 을 요구한다.
  const hinted = !!String(b.urlHint || '').trim();
  let unverified = '';
  if (process.env.CENTRAL_VERIFY_SELF_REGISTER !== 'false') {
    const v = await verifyDerivedCollectorUrl({ url, name, datacenter: regDc, token: b.collectorToken });
    if (!v.ok) {
      // 유도 URL 은 거부(잘못된 항목 생성 방지). 관리자가 지정한 urlHint(EDGE_ADVERTISE_URL)는 등록은 하되 '미검증' 사유를 남긴다(v2.428, 미스매치 #10).
      if (!hinted) { console.warn(`[central] 엣지 자기등록 거부: ${name} — ${v.reason}`); return res.status(400).json({ ok: false, reason: v.reason }); }
      unverified = v.reason;
    }
  }
  // v2.604(감사 CEN2604-04): 검증 결과와 토큰 종류를 넘긴다 — 공유 토큰의 새 이름 생성은 개수 상한, 미검증 항목은 '아는 엣지' 가 아니다.
  const r = upsertCollectorFromAgent({ name, url, token: b.collectorToken, datacenter: regDc, unverified: !!unverified, shared: req.centralAuth?.mode !== 'agent' });
  if (!r.ok && r.code === 'insecure-http') console.warn(`[central] 엣지 자기등록 거부(평문 HTTP): ${name} → ${url} — ${r.reason}`);
  if (!r.ok && r.code === 'registry-unreadable') return registryUnreadable(res, () => collectorsRegistryLoadError() || { at: r.registryUnreadable?.at ?? Date.now(), reason: '' }, '수집 서버'); // 검사 뒤(검증 ping 동안) 손상된 경합
  if (!r.ok && r.capped) { console.warn(`[central] 엣지 자기등록 상한: ${name} — ${r.reason}`); return res.status(429).json({ ok: false, reason: r.reason, capped: true }); }
  if (r.ok) { _knownNames = { at: 0, set: null }; _contactKnownNames.at = 0; _contactKnownNames.set = null; } // 등록부가 바뀌었다 — '아는 엣지' 캐시를 버린다(v2.849 생존 기록용도)
  if (r.ok) console.log(`[central] 엣지 자기등록: ${name} → ${url}${regVer ? ` (v${regVer})` : ''}${unverified ? ` ⚠ 미검증: ${unverified}` : ''}`);
  if (r.ok && (unverified || regVer)) {
    // v2.548: 자기등록이 보낸 버전을 상태에 심어 둔다 — pull 이 한 번도 성공하지 못한 엣지(OC2SDBX 사례)는
    // puller.js:92 경로로 버전이 들어오지 않아 파트 장애 화면이 '버전 미상' 으로만 말했다. 기존 상태는 보존.
    // ⚠ v2.583 감사 #32: '미검증' 분기가 상태를 **통째로 바꿔** version·agent·authDeny·identity 를 지웠고(v2.548 H5
    //   '실패 경로는 직전 상태 위에 덮는다' 위반), 버전 심기는 else 쪽이라 **미검증 엣지(= pull 이 안 되는 전형)**
    //   에는 한 번도 돌지 않았다. 두 갈래를 합쳐 직전 상태 위에 덮는다.
    const { setCollectorStatus, getCollectorStatus } = await import('../collector/state.js');
    const id = r.collector?.id || name;
    const prev = getCollectorStatus(id) || {};
    const next = { ...prev };
    if (regVer && !prev.version) { next.version = regVer; next.registeredVersion = true; }
    if (unverified) { next.ok = false; next.error = `등록 URL(EDGE_ADVERTISE_URL) 검증 실패: ${unverified}`; next.unverified = true; }
    setCollectorStatus(id, next);
  }
  res.status(r.ok ? 200 : 400).json(r.ok ? { ...r, unverified: unverified || undefined } : r);
});

// Agent posts its scan result. Body: { agent, scanned, found:[...], unreachable, notIdrac, authFailed }
centralRouter.post('/result', requireCentral({ notFound: { ok: false } }), (req, res) => {
  const b = req.body || {};
  // 저장 키는 개별 토큰이면 토큰에서 해석한 agent 를 강제한다(body.agent 위조 차단 —
  // ?agent=자기 + body.agent=남 우회 봉인). 공유 토큰(shared)은 어느 엣지인지 알 수 없어
  // 하위호환으로 body.agent 를 쓴다(완전 봉인은 CENTRAL_REQUIRE_AGENT_TOKEN=true).
  const agent = req.centralAuth.agent || String(b.agent && strAgent(b.agent) || ''); // v2.600 CEN2600-10: 글자일 때만(객체면 String() 이 던졌다)
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  // v2.601(감사 CEN2601-04): 결과는 **배정이 있는 agent 만** 저장한다. 엣지는 배정을 받아야 스캔·회신하므로(agent/scanner.js)
  //   배정 없는 이름의 결과는 정상 경로에서 생기지 않는다 — 예전에는 공유 토큰의 임의 이름 수천 개가 agent-results.json 에
  //   영속되고 knownAgentNames 로 번져 위임 드롭다운·포탈 점검에 유령 엣지가 떴다. 거절은 사유와 함께(엣지 로그가 남긴다).
  if (!getAssignment(agent)) return res.status(409).json({ ok: false, reason: `'${agent}' 에 배정된 스캔이 없어 결과를 저장하지 않았습니다.` });
  // v2.598(감사 CENTRAL-03): 본문을 그대로 싣지 않는다 — 정제는 setResult(sanitizeScanResult) 하나가 한다.
  setResult(agent, b);
  res.json({ ok: true });
});

// 사이트 위임 수집: 현장 서버가 로컬 vCenter 인벤토리 조각을 push.
// Body: { agent, vcenterId, vcenter, hosts[], vms[], datastores[], networks[], alarms[], generatedAt }
/**
 * 성능점검 엣지 보고 수신 (RMA Active). 엣지가 자기 대역을 로컬에서 점검하고 결과를 밀어 올린다.
 *
 * **개별 토큰 전용**이다. 저장 키는 토큰에서 해석한 `req.centralAuth.agent` 뿐이며 본문의
 * agent 필드는 읽지 않는다 — 그래야 한 엣지가 남의 이름으로 결과를 위조할 수 없다.
 */
centralRouter.post('/svcmon-report', requireCentral(), (req, res) => {
  if (req.centralAuth.mode !== 'agent') {
    return res.status(403).json({
      ok: false,
      reason: '이 엔드포인트는 엣지별 개별 토큰만 허용합니다(공유 CENTRAL_TOKEN 으로는 어느 엣지의 결과인지 신뢰할 수 없습니다). 설정 > 엣지 토큰에서 이 엣지의 토큰을 발급해 주세요.',
    });
  }
  const agent = req.centralAuth.agent;
  // 소켓 관측 주소 — 통신 진단(probe)의 목적지. 프록시 뒤면 프록시 주소일 수 있다.
  const sourceIp = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const r = ingestReport(agent, req.body || {}, Date.now(), { sourceIp });
  // v2.591(PR-2 ③): 예전에는 여기서 슬래시 없는 키('svcmon-report')로 **한 번 더** recordIngest 해 pushes 가 두 배가 되고
  //   데이터 흐름 지도가 그 키를 '라우터에 없는 경로(구버전 엣지일 수 있음)' 로 말했다. 요약만 넘기고 기록은 공용 훅이 한다.
  res.locals.ingestSummary = { accepted: r.accepted, dropped: r.dropped, rows: Array.isArray(req.body?.rows) ? req.body.rows.length : 0 };
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

/**
 * Capacity Advisor 엣지 보고 — 엣지가 자기 호스트 리소스 스냅샷({metric,v} 행 + 메타)을
 * 밀어 올린다. **개별 토큰 전용**(svcmon-report 와 같은 3규약: agent 모드 필수 · 저장 키는
 * req.centralAuth.agent 만 · X-Agent-Name 이중 방어). 시각은 중앙 수신 시각이 진실이다.
 */
/**
 * v2.976 집중 모니터링 엣지 동기화 — 엣지가 자기 법인 서버에서 모은 표본 · 프로세스 · 상태 · 공개키를 올리고, 지금 수집할 대상 목록을 받는다.
 * **개별 토큰 전용**(3규약: agent 모드 필수 · 저장 키는 req.centralAuth.agent 만 · X-Agent-Name 이중 방어). 정제 · 적재는 central/focusMonEdge.js —
 * 그 엣지가 맡지 않은 대상 id 는 버린다. 본문은 gzip · BIG_JSON(index.js) — 회선이 끊겼던 동안의 표본이 한 번에 올 수 있다.
 */
centralRouter.post('/focus-mon/sync', requireCentral(), (req, res) => {
  if (req.centralAuth.mode !== 'agent') {
    return res.status(403).json({ ok: false, reason: '이 엔드포인트는 엣지별 개별 토큰만 허용합니다(어느 엣지의 서버인지 신뢰할 수 없습니다).' });
  }
  try {
    const out = handleEdgeSync(req.centralAuth.agent, req.body);
    if (out.ok === false && out.code === 'registryUnreadable') return persistent503(res).json(out); // 지속형 — Retry-After 60(EDGE-03)
    res.locals.ingestSummary = { rows: out.accepted?.samples ?? 0 };
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, reason: `처리 실패: ${String(e?.message || e).slice(0, 200)}` });
  }
});

centralRouter.post('/capacity-report', requireCentral(), async (req, res) => {
  if (req.centralAuth.mode !== 'agent') {
    return res.status(403).json({ ok: false, reason: '이 엔드포인트는 엣지별 개별 토큰만 허용합니다(어느 엣지의 리소스인지 신뢰할 수 없습니다).' });
  }
  const agent = req.centralAuth.agent;
  try {
    const b = req.body || {};
    const rawRows = Array.isArray(b.rows) ? b.rows.slice(0, 64) : [];   // 수집기 수 상한(폭주 방어)
    const rows = [];
    for (const r of rawRows) {
      const metric = typeof r?.metric === 'string' ? r.metric.slice(0, 40) : '';
      const v = Number(r?.v);
      if (metric && /^[a-z0-9_]+$/.test(metric) && Number.isFinite(v)) rows.push({ metric, v });
    }
    const meta = b.meta && typeof b.meta === 'object'
      ? {
        hostname: String(b.meta.hostname || '').slice(0, 100),
        platform: String(b.meta.platform || '').slice(0, 20),
        cores: Number(b.meta.cores) || 0,
        totalMemMB: Number(b.meta.totalMemMB) || 0,
        nodeVersion: String(b.meta.nodeVersion || '').slice(0, 20),
        portalVersion: String(b.meta.portalVersion || '').slice(0, 20),
        role: String(b.meta.role || '').slice(0, 10),
        intervalMs: Number(b.meta.intervalMs) || 0,
      }
      : {};
    const { getCapacityDb } = await import('../capacity/db.js');
    const db = await getCapacityDb();
    // 빈 rows 도 hosts.lastTs 는 갱신한다 — '살아 있으나 첫 델타 기준선 중'과 '죽음'을 구별(하트비트).
    db.insertSnapshot(agent, rows, Date.now(), meta);
    res.locals.ingestSummary = { rows: rows.length }; // v2.591(PR-2 ③): 기록은 공용 훅이 한다(이중 기록 제거)
    res.json({ ok: true, accepted: rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, reason: `저장 실패: ${e.message}` });
  }
});

/**
 * 성능점검 정의 배포 — 엣지가 자기 배정을 받아 간다. **개별 토큰 전용.**
 * `query.agent` 는 미들웨어 바인딩 검사를 걸기 위한 것이고, 실제 조회 키는 토큰에서 해석한
 * 이름만 쓴다(쿼리 값을 신뢰하지 않는다).
 */
centralRouter.get('/svcmon-config', requireCentral(), (req, res) => {
  if (req.centralAuth.mode !== 'agent') {
    return res.status(403).json({ ok: false, reason: '이 엔드포인트는 엣지별 개별 토큰만 허용합니다.' });
  }
  const agent = req.centralAuth.agent;
  // v2.632(감사 EDGE2632-01): 배정 파일을 못 읽었으면 빈 배정(assigned:false)을 200 으로 내리지 않는다 — 엣지가 central:* 배치를 전부 지운다.
  if (settingsUnreadable(res, svcmonAssignLoadError, '성능점검 배정')) return;
  const r = getAssignmentForAgent(agent, String(req.query.sig || ''));
  if (r.assigned && !r.unchanged) markPulled(agent, r.sig);
  res.json({ ok: true, ...r });
});

/**
 * 엣지 적용 결과 회신 — **이것이 배포 성공 판정의 근거다.**
 * 적용 수가 배포 수와 다르면 중앙이 `mismatch` 로 남기고 그대로 노출한다.
 */
centralRouter.post('/svcmon-config-ack', requireCentral(), (req, res) => {
  if (req.centralAuth.mode !== 'agent') {
    return res.status(403).json({ ok: false, reason: '이 엔드포인트는 엣지별 개별 토큰만 허용합니다.' });
  }
  const b = req.body || {};
  const r = ackAssignment(req.centralAuth.agent, {
    sig: typeof b.sig === 'string' ? b.sig : '', applied: b.applied || {}, removed: b.removed, errors: b.errors, // v2.602 CEN2602-06: 글자일 때만(객체면 String() 이 던졌다)
  });
  res.status(r.ok ? 200 : 409).json(r);
});

/**
 * v2.599(EDGE2599-03): 인벤토리 소유권(TOFU)의 **자동 인계 시한**(opt-in, 기본 0 = 끔) — 켜면 소유 엣지의 마지막 push 가
 * 이보다 오래됐을 때 다른 개별 토큰 엣지가 넘겨받을 수 있다. 기본은 관리자 명시 해제/지정 API 가 유일한 경로다. 예전에는 소유권이 만료되지 않아 **담당 엣지를
 * 교체하면 새 엣지의 push 가 영구 403** 이었고, 유일한 해제 방법은 vCenter 를 등록부에서 지웠다 다시 넣는 것이었다.
 * ⚠ 보안 경계는 유지한다: 소유 엣지가 **살아 있는 동안**(시한 안에 push 하는 동안) 다른 엣지는 여전히 덮어쓸 수 없다.
 *   시한이 지난 인계는 그 vCenter 의 스냅샷이 이미 그만큼 낡은 경우뿐이고, 인계는 감사 로그·콘솔·응답에 남긴다.
 */
const INVENTORY_OWNER_HANDOVER_MS = (() => {
  const v = process.env.CENTRAL_INVENTORY_OWNER_HANDOVER_HOURS;
  // ⚠ 기본 0(자동 인계 끔) — 자동 인계는 '엣지가 남의 vCenter 를 가로채지 못한다' 를 시한 뒤 약화하므로 현장 opt-in 이다.
  //   기본 경로는 관리자 명시 해제/지정(POST /api/admin/central/inventory/owner)이다.
  if (v == null || String(v).trim() === '') return 0;
  const h = Number(v);
  return Number.isFinite(h) && h > 0 ? Math.max(1, h) * 3_600_000 : 0;   // 0·음수 = 인계 안 함
})();
const isPlainObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
/** 화면이 글자로 그리는 인벤토리 필드 — 객체·배열이면 null 로 바꾼다(React #31 방지 — CEN-2599-03). */
const INV_TEXT_KEYS = ['id', 'name', 'host', 'cluster', 'datacenter', 'type', 'version', 'build', 'vendor', 'model', 'cpuModel',
  'guestOS', 'powerState', 'connectionState', 'toolsStatus', 'toolsVersionStatus', 'ipAddress', 'folder', 'resourcePool', 'notes',
  'hwVersion', 'storageType', 'severity', 'message', 'entity', 'entityType', 'status', 'location', 'overallStatus',
  // v2.727(감사 D-05): 호스트 ↔ iDRAC 연결 규칙(idrac/hostMatch.js·serverForHost.js)이 글자로 읽는 식별 필드 — 객체가 오면 null(규칙 미적용 = 모름).
  'hostName', 'serviceTag', 'mgmtIp'];
/** v2.727(감사 D-05): 글자가 아니면 뜻이 없는 필드(IP 는 수가 아니다) — 문자열 외에는 null 로 버린다. */
// v2.820: VM 의 정확한 위치(vcenter/vmPlacement.js — Bareos 플러그인이 이 글자로 VM 을 찾는다) — 글자가 아니면 null(모름).
// v2.887: instanceUuid(서비스 인벤토리 VM 키)도 글자만 — 엣지가 객체를 보내면 null(읽지 못함).
// v2.901(점검 E8 — 정정): 예전 주석의 '길이는 아래 문자열 상한이 자른다' 는 사실이 아니었다(이 정제에는 문자열 길이 상한이 없다).
//   instanceUuid 는 키가 되므로 모양(INSTANCE_UUID_RE — 글자 · 숫자 · '_' · '-' 64자 이내)이 아니면 null(읽지 못함)로 버린다. 빈 값은 그대로(없음).
const INV_STR_ONLY_KEYS = ['mgmtIp', 'vcDcPath', 'folderPath', 'instanceUuid'];
export const INSTANCE_UUID_RE = /^[\w-]{1,64}$/;
/**
 * 롤업·화면이 수로 계산하는 인벤토리 필드(v2.605 CEN2605-01) — 호스트·VM·DS·네트워크의 수치 필드 합집합.
 * 정상 엣지(inventoryPush.js)는 숫자를 보내므로 정상 입력에는 무변경이다.
 */
const INV_NUM_KEYS = ['vmfsMajor', 'cpuCores', 'cpuSockets', 'cpuThreads', 'cpuTotalMhz', 'cpuUsageMhz', 'cpuUsagePct', 'memTotalMB', 'memUsageMB', 'memUsagePct',
  'vmCount', 'hostCount', 'powerWatts', 'powerWattsIdrac', 'tempC', 'tempMaxC', 'gpuUtilPct', 'gpuMemUsedPct', 'gpuMemUsedMB', 'gpuTempC', 'uptimeSec',
  'cpuCount', 'numCpu', 'memMB', 'memoryMB', 'storageGB', 'uncommittedGB', 'snapshotCount', 'snapshotSizeGB',
  'snapshotOldestTs', 'snapshotNewestTs', 'orphanDeltaGB', 'bootTime', 'capacityGB', 'freeGB', 'usedGB', 'usagePct', 'provisionedGB', 'vlanId'];
/**
 * 인벤토리 조각 원소 정리(v2.599 CEN-2599-01·02·03).
 *  - 평범한 객체만 받는다 — `hosts:[null]` 하나로 store.refresh 가 매 주기 throw 해 **전 함대 스냅샷이 멈췄다**.
 *  - 원소의 vcenterId 는 본문 vcenterId 여야 한다 — 다르면 **뺀다**(예전에는 그대로 병합돼 소유권 검사를 지나 남의 법인
 *    vCenter 에 호스트·VM 을 주입할 수 있었다). 없으면 본문 값으로 채운다(엣지는 항상 채워 보낸다 — inventoryPush.js).
 *  - id 가 식별자가 아니면 뺀다. 표시 필드의 객체 값은 null.
 */
/**
 * v2.600(RECENT2600-01): vCenter 위치 객체 정리 — 글자 필드는 글자(128자)로, 좌표는 유한수로. 객체가 아니면(글자 하나 등)
 * 위치로 쓸 수 없으므로 null(store.js 가 등록부의 위치로 채운다). 모르는 키는 싣지 않는다(화면이 쓰는 것만).
 * @returns {{ value: object|null, coerced: number }}
 */
export function sanitizeVcLocation(v) {
  if (!isPlainObj(v)) return { value: null, coerced: 1 };
  const out = {}; let coerced = 0;
  for (const k of ['city', 'country', 'region', 'name', 'site', 'datacenter']) {
    if (!Object.hasOwn(v, k) || v[k] == null) continue;
    if (typeof v[k] === 'string' || (typeof v[k] === 'number' && Number.isFinite(v[k]))) out[k] = String(v[k]).slice(0, 128);
    else coerced += 1;
  }
  for (const k of ['lat', 'lon', 'lng']) {
    if (!Object.hasOwn(v, k) || v[k] == null) continue;
    const n = numOrNull(v[k]);
    const lim = k === 'lat' ? 90 : 180;
    if (n != null && Math.abs(n) <= lim) out[k] = n; else coerced += 1;
  }
  return { value: out, coerced };
}

/*
 * v2.742(감사 VC-07): 엣지가 올린 vcenter.licenses·solutions 를 좁힌다. 예전에는 그대로 저장해 `solutions:'x'` 하나로
 *   /tools/solutions 가 전 법인 500(sols.filter is not a function)이 됐고, `licenses:'ab'` 는 /tools/licenses 에 글자 단위 항목
 *   ({0:'a'})·'(이름 없음)' 만료 행을 만들었다(v2.598·v2.599 '엣지 원소는 아는 필드만' 규약의 누락).
 *   규칙: 배열만(아니면 null = 모름 — 0개라 지어내지 않는다) · 평범한 객체 원소만 · 아는 필드만(soapClient retrieveLicenses·
 *   retrieveExtensions 의 모양) · 글자는 상한으로 자르고 수는 numOrNull · 개수 상한은 수집기와 같은 200·300.
 *   버린 원소·필드 개수는 dropped 로 밝힌다(조용한 상한 금지). null·키 없음은 그대로 둔다(수집기가 '조회 실패' 를 null 로 실을 수 있다).
 */
const VC_LICENSE_STR = { name: 256, key: 64, edition: 128, costUnit: 32, product: 256, productVersion: 64, expires: 64 };
const VC_LICENSE_NUM = ['total', 'used'];
const VC_SOLUTION_STR = { key: 256, version: 128, company: 256, label: 256 };
export const VC_LICENSES_MAX = 200;
export const VC_SOLUTIONS_MAX = 300;
function sanitizeVcObjList(v, { strKeys, numKeys = [], max, required = null }) {
  if (!Array.isArray(v)) return { value: null, dropped: 1 };
  const out = []; let dropped = Math.max(0, v.length - max);
  for (const x of v.slice(0, max)) {
    if (!isPlainObj(x)) { dropped += 1; continue; }
    const o = {};
    for (const [k, lim] of Object.entries(strKeys)) {
      if (!Object.hasOwn(x, k) || x[k] == null) continue;
      if (typeof x[k] === 'string' || (typeof x[k] === 'number' && Number.isFinite(x[k]))) o[k] = capStr(String(x[k]), lim);
      else dropped += 1;
    }
    for (const k of numKeys) {
      if (!Object.hasOwn(x, k) || x[k] == null) { if (Object.hasOwn(x, k)) o[k] = null; continue; }
      const n = typeof x[k] === 'number' || typeof x[k] === 'string' ? numOrNull(x[k]) : null;
      if (n == null) dropped += 1;
      o[k] = n;
    }
    if (required && !o[required]) { dropped += 1; continue; } // 식별 필드가 없는 원소는 화면이 묶을 수 없다
    if (!Object.keys(o).length) { dropped += 1; continue; }   // 아는 필드가 하나도 없으면 빈 행('(이름 없음)')이 된다 — 버린다
    out.push(o);
  }
  return { value: out, dropped };
}
/** @returns {{ value: object[]|null, dropped: number }} */
export function sanitizeVcLicenses(v) { return sanitizeVcObjList(v, { strKeys: VC_LICENSE_STR, numKeys: VC_LICENSE_NUM, max: VC_LICENSES_MAX }); }
/** @returns {{ value: object[]|null, dropped: number }} — key 가 없는 원소는 버린다(수집기도 key 없는 확장은 싣지 않는다). */
export function sanitizeVcSolutions(v) { return sanitizeVcObjList(v, { strKeys: VC_SOLUTION_STR, max: VC_SOLUTIONS_MAX, required: 'key' }); }

/** v2.852: moref 꼴(vm-12) · PCI 주소 꼴(0000:3b:00.0). */
const MOREF_RE = /^[\w.-]{1,64}$/;
const PCI_RE = /^[0-9a-fA-F:.]{5,32}$/;
const GPU_REFS_MAX = 256;
/** 글자 배열을 형식·상한으로 좁힌다. 배열이 아니면 null(키를 지운다). */
function refList(v, re, max) {
  if (!Array.isArray(v)) return { value: null, coerced: 1 };
  const out = []; let coerced = Math.max(0, v.length - max);
  for (const x of v.slice(0, max)) {
    if (typeof x === 'string' && re.test(x)) { if (!out.includes(x)) out.push(x); } else coerced += 1;
  }
  return { value: out, coerced };
}
/*
 * v2.871(감사 A3-06 — v2.870 '별건 다음 점검 첫 후보'): 호스트 gpus 원소 · VM gpu 를 **아는 키만** 받는다.
 *   예전에는 `{ ...g }` 로 원소를 통째로 복사하고 새 필드(vms · pciId · pciIds)만 형식을 봤다 — 엣지가 보낸 아무 키(큰 글자 · 객체 ·
 *   중첩 배열)가 중앙 스냅샷에 그대로 남아 응답·엑셀·캐시로 흘렀다(엣지 수신 계약: 아는 필드만 · 객체만 · 상한 · 문자열 수치는 수로).
 *   아는 키는 수집기(vcenter/soapClient.js parseGpus · parsePassthruGpus · parseVmGpu)와 데모 생성기(mock/generator.js mkGpus)가 만드는 것이다.
 *   형식 밖 값은 키를 지우거나 null(모름)로 두고 coerced 로 센다 — 0 이나 빈 배열로 지어내지 않는다. 모르는 키도 coerced 로 센다.
 *   ⚠ 수집기가 GPU 원소에 새 필드를 더하면 여기(GPU_HOST_KEYS · GPU_VM_KEYS)에도 넣을 것 — 빠지면 중앙에서 조용히 사라진다(시험이 수집기 출력과 대조한다).
 */
export const GPU_HOST_KEYS = Object.freeze(['model', 'vendor', 'memGB', 'mode', 'vgpuMode', 'pciId', 'busId', 'vms']);
// VM gpu 의 model 은 수집기가 만들지 않지만 데모 생성기가 싣고 화면 배지(components/primitives.jsx GpuBadge)가 툴팁으로 읽는다 — 글자로 받는다.
export const GPU_VM_KEYS = Object.freeze(['type', 'count', 'vgpu', 'passthrough', 'profile', 'model', 'pciIds']);
const GPU_MODES = Object.freeze(['vgpu', 'passthrough', 'vsga']);
const VM_GPU_TYPES = Object.freeze(['vgpu', 'passthrough', 'mixed']);
const GPU_TEXT_MAX = 128;
/** 글자 칸: 글자면 상한으로 자르고, 아니면 null(모름). */
function gpuText(v, max = GPU_TEXT_MAX) { return typeof v === 'string' ? capStr(v, max) : null; }
/** 정수 칸: 0..max 정수만(문자열 수치는 수로), 아니면 null. */
function gpuInt(v, max) { const n = numOrNull(v); return n != null && n >= 0 && n <= max && Number.isInteger(n) ? n : null; }

/**
 * 호스트 gpus — 배열이 아니면 [](읽지 못함 — 소비처가 배열로 읽는다), 원소는 평범한 객체만(64장 상한), 키는 GPU_HOST_KEYS 만.
 * @returns {{ value: object[], coerced: number }}
 */
export function sanitizeHostGpus(v) {
  if (!Array.isArray(v)) return { value: [], coerced: 1 };
  let coerced = Math.max(0, v.length - 64);
  const out = [];
  for (const g of v.slice(0, 64)) {
    if (!isPlainObj(g)) { coerced += 1; continue; }
    const o = {};
    for (const k of Object.keys(g)) if (!GPU_HOST_KEYS.includes(k)) coerced += 1;
    for (const k of ['model', 'vendor']) {
      if (!Object.hasOwn(g, k)) continue;
      o[k] = gpuText(g[k]); if (o[k] == null && g[k] != null) coerced += 1;
    }
    if (Object.hasOwn(g, 'memGB')) {
      const n = numOrNull(g.memGB); o.memGB = n != null && n >= 0 && n <= 4096 ? n : null;
      if (o.memGB == null && g.memGB != null) coerced += 1;
    }
    if (Object.hasOwn(g, 'mode')) { o.mode = GPU_MODES.includes(g.mode) ? g.mode : null; if (o.mode == null && g.mode != null) coerced += 1; }
    if (Object.hasOwn(g, 'vgpuMode')) { if (typeof g.vgpuMode === 'boolean') o.vgpuMode = g.vgpuMode; else coerced += 1; }
    if (Object.hasOwn(g, 'vms')) {
      const r = refList(g.vms, MOREF_RE, GPU_REFS_MAX); coerced += r.coerced;
      if (r.value != null) o.vms = r.value;
    }
    for (const k of ['pciId', 'busId']) {
      if (!Object.hasOwn(g, k)) continue;
      const x = g[k];
      if (x == null || (typeof x === 'string' && (x === '' || PCI_RE.test(x)))) o[k] = x ?? null; else { o[k] = null; coerced += 1; }
    }
    out.push(o);
  }
  return { value: out, coerced };
}
/** VM gpu — 객체가 아니면 null(GPU 모름). 키는 GPU_VM_KEYS 만 · pciIds 16개 상한. */
export function sanitizeVmGpuField(v) {
  if (!isPlainObj(v)) return { value: null, coerced: 1 };
  const o = {}; let coerced = 0;
  for (const k of Object.keys(v)) if (!GPU_VM_KEYS.includes(k)) coerced += 1;
  if (Object.hasOwn(v, 'type')) { o.type = VM_GPU_TYPES.includes(v.type) ? v.type : null; if (o.type == null && v.type != null) coerced += 1; }
  for (const k of ['count', 'vgpu', 'passthrough']) {
    if (!Object.hasOwn(v, k)) continue;
    o[k] = gpuInt(v[k], 64); if (o[k] == null && v[k] != null) coerced += 1;
  }
  if (Object.hasOwn(v, 'profile')) { o.profile = gpuText(v.profile, 64); if (o.profile == null && v.profile != null) coerced += 1; }
  if (Object.hasOwn(v, 'model')) { o.model = gpuText(v.model); if (o.model == null && v.model != null) coerced += 1; }
  if (Object.hasOwn(v, 'pciIds')) {
    const r = refList(v.pciIds, PCI_RE, 16); coerced += r.coerced;
    if (r.value != null) o.pciIds = r.value;
  }
  return { value: o, coerced };
}

export function sanitizeInventoryList(list, vcId, max, dropped) {
  const out = [];
  // v2.727(감사 D-04): 상한(max)으로 넘친 원소 수를 센다 — 예전 `slice(0, max)` 는 셋째 원소가 어디에도 남지 않았다(조용한 상한 금지).
  //   넘침이 없으면 키를 만들지 않는다(응답 `dropped` 의 모양은 예전 그대로 — 기존 소비처·테스트 호환).
  const over = Array.isArray(list) ? Math.max(0, list.length - max) : 0;
  if (over) dropped.overCount = (dropped.overCount || 0) + over;
  for (const x of Array.isArray(list) ? list.slice(0, max) : []) {
    if (!isPlainObj(x)) { dropped.notObject += 1; continue; }
    if (x.vcenterId != null && String(x.vcenterId) !== vcId) { dropped.otherVcenter += 1; continue; }
    if (x.id != null && typeof x.id !== 'string' && !(typeof x.id === 'number' && Number.isFinite(x.id))) { dropped.badId += 1; continue; }
    const o = { ...x, vcenterId: vcId };
    for (const k of INV_TEXT_KEYS) {
      const v = o[k];
      if (v != null && typeof v === 'object') { o[k] = null; dropped.coerced += 1; }
    }
    for (const k of INV_STR_ONLY_KEYS) { // v2.727(D-05)
      const v = o[k];
      if (v != null && typeof v !== 'string') { o[k] = null; dropped.coerced += 1; }
    }
    if (typeof o.instanceUuid === 'string' && o.instanceUuid !== '' && !INSTANCE_UUID_RE.test(o.instanceUuid)) { o.instanceUuid = null; dropped.coerced += 1; }   // v2.901 E8
    // v2.605(CEN2605-01): 수치 필드도 좁힌다 — '32' 같은 글자가 오면 store 롤업의 `+=` 가 문자열 연결이 되어 **전 함대**
    //   KPI(global·byRegion)가 오류 없이 틀린다(cpuCores '3232'). 숫자 글자는 수로, 그 밖(객체·'abc')은 null(읽지 못함).
    for (const k of INV_NUM_KEYS) {
      const v = o[k];
      if (v == null || (typeof v === 'number' && Number.isFinite(v))) continue;
      o[k] = numOrNull(v); dropped.coerced += 1;
    }
    // v2.695: VM 이 쓰는 DNS 서버(soapClient.vmDns) — 아는 모양만 담는다(모양이 아니면 null = 모름).
    if (Object.hasOwn(o, 'dns') && o.dns != null) {
      const d = sanitizeVmDns(o.dns);
      if (d == null) dropped.coerced += 1;
      o.dns = d;
    }
    // v2.697(B10): VM 구성 속성·장치 위생 요약 — 아는 필드만(모양이 아니면 null = 모름).
    if (Object.hasOwn(o, 'cfg') && o.cfg != null) { const v = sanitizeVmCfg(o.cfg); if (v == null) dropped.coerced += 1; o.cfg = v; }
    if (Object.hasOwn(o, 'dev') && o.dev != null) { const v = sanitizeVmDev(o.dev); if (v == null) dropped.coerced += 1; o.dev = v; }
    // v2.898: 스냅샷 트리(soapParse.snapshotTreeNodes) — 아는 키만 · 64개 상한(배열이 아니면 null = 모름).
    if (Object.hasOwn(o, 'snapshotTree') && o.snapshotTree != null) { const v = sanitizeSnapTree(o.snapshotTree); if (v == null) dropped.coerced += 1; o.snapshotTree = v; }
    // v2.699: 호스트 구성·보안(hostcfg/parse.js) — 아는 필드만.
    if (Object.hasOwn(o, 'hcfg') && o.hcfg != null) { const v = sanitizeHostCfg(o.hcfg); if (v == null) dropped.coerced += 1; o.hcfg = v; }
    // v2.700(A17): 데이터스토어 운영 속성(dscfg/parse.js) — 아는 필드만.
    if (Object.hasOwn(o, 'dcfg') && o.dcfg != null) { const v = sanitizeDsCfg(o.dcfg); if (v == null) dropped.coerced += 1; o.dcfg = v; }
    // v2.706(C2·C3): CPU 경합·디스크 지연(contention/parse.js) — VM·호스트 모양이 달라 둘 다 시도하지 않고 키로 가른다.
    if (Object.hasOwn(o, 'perfc') && o.perfc != null) {
      const v = Object.hasOwn(o.perfc, 'diskMaxMs') || Array.isArray(o.perfc?.ds) ? sanitizeHostPerfc(o.perfc) : sanitizeVmPerfc(o.perfc);
      if (v == null) dropped.coerced += 1; o.perfc = v;
    }
    // v2.935(C-①): ESXi 경로 카운터(storpath/parse.js) — 아는 필드만 · 타깃 64 상한 · 엣지 시각은 수신 시각으로.
    if (Object.hasOwn(o, 'spath') && o.spath != null) { const v = sanitizeHostSpath(o.spath); if (v == null) dropped.coerced += 1; o.spath = v; }
    if (Object.hasOwn(o, 'dsUuid') && o.dsUuid != null && !(typeof o.dsUuid === 'string' && /^[\w.:-]{1,64}$/.test(o.dsUuid))) { o.dsUuid = null; dropped.coerced += 1; }
    // v2.742(VC-05 후속): 호스트·VM 의 소속 클러스터 moref(clusterRef)와 vSphere 데이터센터 이름(vcDatacenter) — 수집기(soapClient)는
    //   글자 또는 null 만 싣는다. clusterRef 는 moref 꼴(64자) 글자만, vcDatacenter 는 글자만(128자로 자른다) — 객체·배열·숫자·형식 밖은
    //   null(모름). 클러스터 묶음 키(clustercfg/analyze.js refOf)는 글자만 쓰므로 null 은 그 vCenter 를 예전 이름 키로 떨어뜨린다.
    if (Object.hasOwn(o, 'clusterRef') && o.clusterRef != null && !(typeof o.clusterRef === 'string' && /^[\w.:-]{1,64}$/.test(o.clusterRef))) { o.clusterRef = null; dropped.coerced += 1; }
    if (Object.hasOwn(o, 'vcDatacenter') && o.vcDatacenter != null) {
      if (typeof o.vcDatacenter === 'string') { if (o.vcDatacenter.length > 128) dropped.coerced += 1; o.vcDatacenter = capStr(o.vcDatacenter, 128); }
      else { o.vcDatacenter = null; dropped.coerced += 1; }
    }
    // v2.852(GPU 할당 계층): 호스트 GPU 목록(gpus)·VM GPU(gpu)의 새 필드 — gpus[].vms(GPU 를 쓰는 VM moref)·pciId · gpu.pciIds.
    //   예전에는 gpus·gpu 를 통째로 그대로 받았다. 모양만 좁힌다: gpus 는 배열(아니면 [] — 소비처가 `.map`·`.length` 로 읽는다) ·
    //   원소는 평범한 객체만 · 새 필드는 형식 밖이면 키를 지운다(= 배치 정보 없음 — 0 대로 지어내지 않는다). gpu 는 객체가 아니면 null.
    if (Object.hasOwn(o, 'gpus') && o.gpus != null) {
      const v = sanitizeHostGpus(o.gpus);
      dropped.coerced += v.coerced; o.gpus = v.value;
    }
    if (Object.hasOwn(o, 'gpu') && o.gpu != null) {
      const v = sanitizeVmGpuField(o.gpu);
      dropped.coerced += v.coerced; o.gpu = v.value;
    }
    out.push(o);
  }
  return out;
}

centralRouter.post('/inventory', requireCentral(), (req, res) => {
  const b = req.body || {};
  if (!b.vcenterId || !b.vcenter) return res.status(400).json({ ok: false, reason: 'vcenterId/vcenter가 필요합니다.' });
  // v2.599(CEN-2599-01): vcenter 는 객체, vcenterId 는 글자여야 한다 — 그 밖의 모양은 병합 단계에서 스냅샷을 멈춘다.
  if (!isPlainObj(b.vcenter) || (typeof b.vcenterId !== 'string' && typeof b.vcenterId !== 'number') || String(b.vcenterId).length > 128) {
    return res.status(400).json({ ok: false, reason: 'vcenter 는 객체, vcenterId 는 128자 이하 글자여야 합니다.' });
  }
  // 출처 agent 는 개별 토큰이면 토큰에서 해석한 값을 강제(body.agent 위조 무효화).
  const agent = req.centralAuth.agent || String(b.agent && strAgent(b.agent) || ''); // v2.600 CEN2600-10: 글자일 때만(객체면 String() 이 던졌다)
  // 소유권 경계(TOFU): 이 vcenterId 를 이미 다른 엣지가 등록했다면 개별 토큰은 덮어쓸 수 없다.
  // (엣지 A 가 남의 vCenter 스냅샷을 위조·블랭킹하는 것을 차단. 공유 토큰은 agent 가 없어 검사 생략 —
  //  완전 봉인은 CENTRAL_REQUIRE_AGENT_TOKEN=true.)
  let handover = null;
  if (req.centralAuth.mode === 'agent') {
    const cur = getInventory(String(b.vcenterId));
    const owner = cur?.agent || '';
    if (owner && owner.toLowerCase() !== agent.toLowerCase()) {
      const silentMs = Date.now() - (Number(cur.pushAt || cur.at) || 0); // v2.600: 목록 보존(held) 중에도 엣지는 push 하고 있다 — 마지막 push 시각
      if (INVENTORY_OWNER_HANDOVER_MS > 0 && silentMs > INVENTORY_OWNER_HANDOVER_MS) {
        // v2.599(EDGE2599-03): 소유 엣지가 시한 넘게 조용하다 — 인계한다(감사·콘솔·응답에 남긴다).
        handover = { from: owner, silentMs };
        console.warn(`[central] inventory 소유권 인계: vc=${b.vcenterId} ${owner} → ${agent} (옛 소유 엣지 마지막 push ${Math.round(silentMs / 3_600_000)}시간 전)`);
        try { logAudit({ user: `edge:${agent}`, action: 'central-inventory-owner-handover', target: String(b.vcenterId), detail: `from=${owner} silentHours=${Math.round(silentMs / 3_600_000)}`, ip: req.socket?.remoteAddress || '' }); } catch { /* 감사 실패가 수신을 막지 않게 */ }
      } else {
        const hours = Math.round(INVENTORY_OWNER_HANDOVER_MS / 3_600_000);
        const reason = `vcenterId '${b.vcenterId}'는 '${owner}' 소유입니다(다른 엣지가 덮어쓸 수 없습니다).`
          + ` 담당 엣지를 교체했다면 중앙 관리자가 소유 엣지를 해제·지정하세요 — POST /api/admin/central/inventory/owner {vcenterId, agent}(agent 비우면 해제 → 다음 개별 토큰 push 가 소유).`
          + (INVENTORY_OWNER_HANDOVER_MS > 0 ? ` 또는 옛 엣지의 마지막 push 후 ${hours}시간이 지나면 자동으로 넘겨받습니다(CENTRAL_INVENTORY_OWNER_HANDOVER_HOURS).` : '');
        // v2.570: 거부 기록에 종류를 남긴다 — '소유권' 과 '토큰 불일치' 는 조치가 다르다.
        res.locals.ingestReject = { kind: REJECT_KIND.OWNER, reason, vcenterId: String(b.vcenterId) };
        return res.status(403).json({ ok: false, reason, owner, ownerSilentMs: silentMs, handoverAfterMs: INVENTORY_OWNER_HANDOVER_MS || null });
      }
    }
  }
  // v2.428(미스매치 #12): mock 노드의 인벤토리는 저장하지 않는다 — IRS 들이 DATA_SOURCE=mock 으로 같은 가짜 vCenter id 를 push 해
  // 서로 덮어쓰고 실데이터와 섞였다. 엣지는 v2.408 부터 자기 로그로만 경고했다.
  // v2.443: 플래그(source)만 믿지 않는다 — `DATA_SOURCE=auto` 는 vCenter 접속 실패 시 목 데이터로
  // 폴백하면서도 source 는 'auto' 라 이 검사를 통과했고, 구버전 엣지는 source 필드 자체가 없다.
  // 그래서 **내용으로도** 판정한다: 생성기의 id·이름이 둘 다 일치하면 목업이다(오탐 사실상 없음).
  // 사용자 신고: 신규 배포 엣지를 live 로 바꿨는데 중앙 vCenter 목록에 'east us' 목업이 올라왔다.
  const mockByFlag = b.source === 'mock' || b.mock === true;
  const mockByContent = isMockVcenter(b.vcenter) || isMockVcenter({ id: String(b.vcenterId || ''), name: b.vcenter?.name });
  if (mockByFlag || mockByContent) {
    noteAgentIdentity(agent, { hostname: agentHostnameOf(req), mock: true, peer: req.socket?.remoteAddress || '', verified: req.centralAuth.mode === 'agent' || edgeNameKnown(agent) });
    const why = mockByFlag
      ? `엣지가 스스로 mock 임을 알렸습니다(source=${b.source || 'mock'})`
      : `보낸 vCenter '${b.vcenterId}' 가 데모 생성기의 가짜 사이트와 id·이름이 같습니다(DATA_SOURCE=auto 로 접속 실패 시 목 데이터로 폴백했거나, 엣지가 구버전이라 mock 표시를 못 보냅니다)`;
    const reason = `엣지 '${agent}' 가 mock(가짜) 데이터를 보냈습니다 — 저장하지 않습니다. ${why}. 엣지 portal.env 에 DATA_SOURCE=live 를 넣고(auto 는 접속 실패 시 가짜로 채웁니다) vCenter 접속 정보를 확인·재시작하세요.`;
    // v2.570: 이것이 '보냈는데 중앙이 막은' 대표 사례다 — 기록하지 않으면 화면에서 '안 보냄' 과 구분되지 않는다.
    res.locals.ingestReject = { kind: REJECT_KIND.MOCK, reason, vcenterId: String(b.vcenterId || '') };
    return res.status(400).json({ ok: false, reason, mockBlocked: true, by: mockByFlag ? 'flag' : 'content' });
  }
  // v2.607(감사 CEN2607-06 — 재현): 형제(guest-disk·vmseries·curuser·ping)와 같이 중앙 직접 수집(direct) vCenter 는 받지 않는다.
  //   예전에는 엣지가 중앙 직접 수집 vCenter id 로 인벤토리를 저장하고 소유자로 기록돼, curuser-config·vmseries-config 가
  //   그 vCenter 의 설정을 엣지로 내려보냈다. ⚠ mock 판정 **뒤**에 둔다 — 목 폴백 거부의 종류(MOCK)가 바뀌지 않게(v2.570).
  //   등록부에 없는 id 는 여기서 막지 않는다(형제 판정·기존 흐름과 같은 기준 — 위임 인벤토리 캐시가 등록부에 없는 id 를 매 주기 지운다).
  const invDeny = edgeVcWriteDenied(b.vcenterId);
  if (invDeny) {
    res.locals.ingestReject = { kind: REJECT_KIND.OWNER, reason: invDeny, vcenterId: String(b.vcenterId).slice(0, 128) };
    return res.status(403).json({ ok: false, reason: invDeny });
  }
  // v2.428(미스매치 #6/#7): 같은 vcenterId 를 다른 agent 가 번갈아 push 하거나, 같은 agent 이름이 다른 hostname 에서 오면 충돌로 기록.
  noteAgentIdentity(agent, { hostname: agentHostnameOf(req), mock: false, peer: req.socket?.remoteAddress || '', verified: req.centralAuth.mode === 'agent' || edgeNameKnown(agent) }); // v2.603 CEN2603-04: 미검증 이름은 작은 링
  noteVcenterOwner(String(b.vcenterId), agent, { peer: req.socket?.remoteAddress || '', hostname: agentHostnameOf(req) });
  const vcId = String(b.vcenterId);
  const dropped = { notObject: 0, otherVcenter: 0, badId: 0, coerced: 0 };
  const vcenter = { ...b.vcenter, id: vcId }; // v2.599(CEN-2599-02): vcenter.id 는 본문 vcenterId 로 고정
  for (const k of ['name', 'version', 'build', 'region', 'status']) if (vcenter[k] != null && typeof vcenter[k] === 'object') { vcenter[k] = null; dropped.coerced += 1; }
  // v2.600(감사 RECENT2600-01): location 은 **원래 객체**다({city,country,region,lat,lon}). v2.599 가 다른 표시 필드와 함께
  //   null 로 만들어 정상 push 마다 위치가 사라졌고(지역 롤업 'Unknown' · 지도 좌표 소실) — 하위 필드만 좁힌다.
  if (vcenter.location != null) {
    const loc = sanitizeVcLocation(vcenter.location);
    if (loc.coerced) dropped.coerced += loc.coerced;
    vcenter.location = loc.value;
  }
  // v2.701(A6): 클러스터 HA·DRS 구성 — 아는 필드만(규칙 이름·VM 참조는 길이·개수 상한). 배열이 아니면 null(미수집).
  if (Object.hasOwn(vcenter, 'clusterCfg')) {
    const cc = sanitizeClusterCfgList(vcenter.clusterCfg);
    if (cc.dropped) dropped.coerced += cc.dropped;
    vcenter.clusterCfg = cc.value;
  }
  // v2.703(A15): 태그·사용자 지정 속성 — 아는 필드만·상한·VM 참조 형식(예약어 거부). 객체가 아니면 null(미수집).
  if (Object.hasOwn(vcenter, 'tagInv')) {
    const ti = sanitizeTagInv(vcenter.tagInv);
    if (ti.dropped) dropped.coerced += ti.dropped;
    vcenter.tagInv = ti.value;
  }
  // v2.898: vCenter 알람 · 최근 작업 · 권한 목록 — vcenter 객체에 남기지 않는다(스냅샷 vCenter 객체는 /vcenters 로 모든 인증 사용자에게
  //   나간다 — 권한 목록이 새면 안 된다). 정제한 값은 아래 저장(setInventory)이 끝난 뒤 vcinfo 캐시에 넣는다(수신이 받아들여졌을 때만).
  let vcInfoIn = null;
  if (Object.hasOwn(vcenter, 'vcInfo')) {
    vcInfoIn = sanitizeVcInfo(vcenter.vcInfo);
    if (vcInfoIn == null && vcenter.vcInfo != null) dropped.coerced += 1;
    delete vcenter.vcInfo;
  }
  // v2.742(감사 VC-07): 라이선스·설치 솔루션 — 배열·객체 원소·아는 필드·상한만. 뺀 개수는 dropped.vcLicenses·vcSolutions(0 이면 키 없음 — 예전 모양).
  for (const [k, fn, dk] of [['licenses', sanitizeVcLicenses, 'vcLicenses'], ['solutions', sanitizeVcSolutions, 'vcSolutions']]) {
    // 조회 실패 사유(`licensesError`·`solutionsError` — corelicense/analyze.js vcListUnread 가 읽는다)도 글자만·상한으로.
    const ek = `${k}Error`;
    if (Object.hasOwn(vcenter, ek)) {
      if (typeof vcenter[ek] === 'string') vcenter[ek] = capStr(vcenter[ek], 300);
      else { if (vcenter[ek] != null) dropped[dk] = (dropped[dk] || 0) + 1; delete vcenter[ek]; }
    }
    if (!Object.hasOwn(vcenter, k) || vcenter[k] == null) continue;
    const r = fn(vcenter[k]);
    vcenter[k] = r.value;
    if (r.dropped) dropped[dk] = (dropped[dk] || 0) + r.dropped;
  }
  // v2.938(점검 — vCenter 규칙 '별건'): 그 밖의 최상위 키는 아는 것만·형식대로 남긴다. 예전에는 `{ ...b.vcenter }` 의 모르는 키가
  //   형식·길이 제한 없이 저장돼 /api/vcenters 로 모든 인증 사용자에게 나갔다. 버린 키는 이름(최대 20)·개수로 응답·콘솔에 밝힌다.
  const top = sanitizeVcenterTop(vcenter);
  if (top.droppedCount) { dropped.vcTopUnknown = top.droppedCount; dropped.vcTopKeys = top.droppedKeys; }
  if (top.coerced) dropped.coerced += top.coerced;
  if (top.droppedCount) console.warn(`[central] inventory: agent=${agent} vc=${vcId} vcenter 객체의 모르는 필드 ${top.droppedCount}개를 버렸습니다(${top.droppedKeys.join(', ')}) — 엣지가 중앙보다 새 버전이면 중앙을 올리세요`);
  const slice = {
    vcenter: { ...top.value, id: vcId },
    hosts: sanitizeInventoryList(b.hosts, vcId, 50_000, dropped),
    vms: sanitizeInventoryList(b.vms, vcId, 500_000, dropped),
    datastores: sanitizeInventoryList(b.datastores, vcId, 50_000, dropped),
    networks: sanitizeInventoryList(b.networks, vcId, 50_000, dropped),
    alarms: sanitizeInventoryList(b.alarms, vcId, 50_000, dropped),
  };
  const droppedN = dropped.notObject + dropped.otherVcenter + dropped.badId + (dropped.overCount || 0); // v2.727(D-04): 상한 넘침도 '뺀 것' 이다
  if (droppedN) console.warn(`[central] inventory: agent=${agent} vc=${vcId} 원소 ${droppedN}건 제외(객체 아님 ${dropped.notObject} · 다른 vCenter ${dropped.otherVcenter} · id 형식 ${dropped.badId}${dropped.overCount ? ` · 상한 초과 ${dropped.overCount}` : ''})`);
  if (dropped.vcLicenses || dropped.vcSolutions) console.warn(`[central] inventory: agent=${agent} vc=${vcId} vCenter 라이선스 ${dropped.vcLicenses || 0}건 · 솔루션 ${dropped.vcSolutions || 0}건을 모양이 달라 뺐습니다(배열 아님·객체 아닌 원소·모르는 형식의 필드·상한 초과)`);
  const saved = setInventory(vcId, slice, agent, b.generatedAt || null) || {};
  // v2.898(반증 하-5): 사이트 위임으로 등록된 vCenter 만 받는다(등록부에 없는 id 를 바꿔 가며 메모리를 늘리지 못하게) ·
  //   받은 것으로 통째로 바꾼다 — 엣지가 접속처를 바꿔 캐시를 비웠으면 옛 vCenter 의 권한 목록을 중앙이 계속 보이지 않게(없으면 지운다).
  //   v2.901(점검 E3): 키가 없으면(옛 엣지 · 중앙 버전을 확인하지 못한 엣지) 직전 값을 그대로 둔다 — {} 일 때만 지운다.
  if (vcInfoIn && !edgeVcWriteDenied(vcId, { requireSite: true })) putVcInfoFromEdge(vcId, vcInfoIn, agent);   // v2.898
  if (saved.held) console.warn(`[central] inventory: agent=${agent} vc=${vcId} 상태 ${slice.vcenter.status} · 호스트·VM 0 — 마지막 정상 목록을 지우지 않고 상태만 갱신했습니다(엣지가 인벤토리를 읽지 못함)`);
  res.locals.ingestSummary = {
    vcenterId: vcId.slice(0, 128), hosts: slice.hosts.length, vms: slice.vms.length, datastores: slice.datastores.length,
    networks: slice.networks.length, alarms: slice.alarms.length, gzip: (req.get('content-encoding') || '').includes('gzip'),
  };
  res.json({ ok: true, vcenterId: b.vcenterId, hosts: slice.hosts.length, vms: slice.vms.length,
    ...(droppedN || dropped.coerced || dropped.vcLicenses || dropped.vcSolutions || dropped.vcTopUnknown ? { rejected: droppedN, dropped } : {}), ...(handover ? { ownerHandover: handover } : {}), ...(saved.held ? { held: true } : {}) });
});

// 사이트 위임 게스트 디스크 수신(v2.466) — 엣지가 로컬 vCenter 의 guest.disk 를 수집해 push.
// 중앙은 site 모드 vCenter 에 직접 SOAP 를 못 걸어 게스트 디스크 회수 리포트가 site vCenter 를
// 못 덮던 문제의 수신 절반. /inventory 와 같은 신뢰 경계(개별 토큰 → agent 강제 + TOFU 소유권 +
// mock 차단)를 적용하고, 받은 VM 배열을 sanitize 후 guest-disk.db 에 커밋한다.
// Body: { agent, source, vcenterId, vcenterName, vms:[{vmId,vmName,allocGB,usedGB,partCount,parts[]}], generatedAt }
centralRouter.post('/guest-disk', requireCentral(), async (req, res) => {
  const b = req.body || {};
  if (!b.vcenterId) return res.status(400).json({ ok: false, reason: 'vcenterId가 필요합니다.' });
  // 출처 agent 는 개별 토큰이면 토큰에서 해석한 값을 강제(body.agent 위조 무효화).
  const agent = req.centralAuth.agent || String(b.agent && strAgent(b.agent) || ''); // v2.600 CEN2600-10: 글자일 때만(객체면 String() 이 던졌다)
  // v2.600(CEN2600-02): direct vCenter · 미등록 id 는 받지 않는다(엣지가 수집하지 않는 vCenter 의 게스트 디스크 = 위조).
  const gdDeny = edgeVcWriteDenied(b.vcenterId, { requireSite: true });
  if (gdDeny) { res.locals.ingestReject = { kind: REJECT_KIND.OWNER, reason: gdDeny, vcenterId: String(b.vcenterId).slice(0, 128) }; return res.status(403).json({ ok: false, reason: gdDeny }); }
  // 소유권 경계(TOFU): 이 vcenterId 인벤토리를 이미 다른 엣지가 등록했다면 개별 토큰은 덮어쓸 수 없다.
  if (req.centralAuth.mode === 'agent' && !agentOwnsVcenter(agent, String(b.vcenterId))) {
    const owner = getInventory(String(b.vcenterId))?.agent || '';
    return res.status(403).json({ ok: false, reason: `vcenterId '${b.vcenterId}'는 '${owner}' 소유입니다(다른 엣지가 덮어쓸 수 없습니다).` });
  }
  // mock(가짜) 데이터는 저장하지 않는다(/inventory 와 동일 — 실데이터 오염 차단).
  if (b.source === 'mock' || b.mock === true || isMockVcenter({ id: String(b.vcenterId || ''), name: b.vcenterName })) {
    return res.status(400).json({ ok: false, reason: `엣지 '${agent}' 가 mock(가짜) 게스트 디스크를 보냈습니다 — 저장하지 않습니다.`, mockBlocked: true });
  }
  // v2.767(점검 R2-B2-02 — 재현): vmId 는 `${vcenterId}:` 네임스페이스여야 한다(최장 프리픽스 — vc.id 에 콜론). 아니면 남의 vCenter VM 행을
  //   vm_id PK 로 덮어 그 이력·파티션 경로가 이 vCenter 범위 계정에 열렸다. 토큰 종류와 무관한 구조 규칙이라 공유 토큰에도 건다. 뺀 수는 dropped 로 밝힌다.
  const gdKnownVcIds = (() => { try { return (loadVcenterConfig().vcenters || []).map((v) => String(v?.id || '')).filter(Boolean); } catch { return []; } })();
  const gdOwn = splitVmsByOwner(sanitizeGuestDiskVms(b.vms), String(b.vcenterId), gdKnownVcIds);
  const vms = gdOwn.kept;
  if (gdOwn.foreign) console.warn(`[central] guest-disk: ${String(agent).slice(0, 64)} vc=${String(b.vcenterId).slice(0, 128)} 의 vCenter 네임스페이스가 아닌 VM ${gdOwn.foreign}개 드롭(위조 방지)`);
  const vcName = String(b.vcenterName || '').slice(0, 256) || String(b.vcenterId);
  // 시계열 ts 는 중앙 수신시각(단일 권위 시계)을 쓴다 — 엣지 wall-clock(generatedAt)을 그대로
  // 쓰면 NTP 미동기 엣지의 시계 오차가 prune(중앙 Date.now 기준)·신선도와 어긋난다(미래 skew =
  // 영구 미prune 누적, 과거 skew = 방금 받은 추이가 즉시 prune). /inventory 도 generatedAt 을
  // 신선도 메타로만 쓰고 시계열 ts 로는 쓰지 않는다. generatedAt 은 참고용으로만 로그.
  const ts = Date.now();
  const commit = await commitGuestDisk(String(b.vcenterId), vcName, vms, { ts, changeThresholdGB: loadGuestDiskSettings().changeThresholdGB });
  if (!commit || !commit.ok) return res.status(500).json({ ok: false, reason: commit?.reason || 'guest-disk 커밋 실패(DB 사용 불가)' });
  noteVcenterOwner(String(b.vcenterId), agent, { peer: req.socket?.remoteAddress || '', hostname: agentHostnameOf(req) });
  console.log(`[central] guest-disk 수신: agent=${agent} vc=${b.vcenterId} vms=${vms.length} (series vm=${commit.vmSeriesRows} part=${commit.partSeriesRows})`);
  // v2.613(감사 CONTRACT2613-03): 적재하지 않고 **센** 행(v2.601 RECENT2601-01 — 숫자가 아닌 VM·파티션)을 응답에 싣는다. 예전에는 로그에만
  //   남아 엣지 상태·로그가 '보냈다(N대)' 인데 중앙에는 그만큼 없었다(v2.606 centralReply 규약의 누락). 뺀 것이 없으면 필드 자체가 없다(구버전 엣지 호환).
  const gdSkipped = (Number(commit.skippedVms) || 0) + (Number(commit.skippedParts) || 0) + gdOwn.foreign;
  res.json({ ok: true, vcenterId: b.vcenterId, vms: vms.length, vmSeriesRows: commit.vmSeriesRows, partSeriesRows: commit.partSeriesRows,
    ...(gdSkipped ? { dropped: { vms: Number(commit.skippedVms) || 0, parts: Number(commit.skippedParts) || 0, ...(gdOwn.foreign ? { notOwned: gdOwn.foreign } : {}) } } : {}) });
});

// 사이트 위임 실시간 스파이크 수신(v2.510) — 엣지 vmseries 폴러가 저장한 같은 주기 결과를 push.
// /guest-disk 와 같은 신뢰 경계(개별 토큰 → agent 강제 + TOFU 소유권 + mock 차단). 받은 행은 형식·크기를
// 검증한 뒤 **그 vCenter 의 독립 DB 파일**에 커밋한다(vmseries/db.js — 다른 vCenter 파일에 섞일 길 없음).
// Body: { agent, source, vcenterId, vcenterName, chunk, chunks, spikes:[{kind,ref,t0,t1,n,cols[],data(base64),mxcpu,mxmem}],
//         cover?:[{kind,ref,h,samples}], cursors?:[{kind,ref,lastTs}], stats?, historicalInterval?, generatedAt }
const VMS_REF_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const VMS_COL_RE = /^[A-Za-z0-9]{1,32}$/;
function sanitizeVmSeriesBody(b, now) {
  const yr = 366 * 86_400_000;
  const okTs = (t) => Number.isFinite(t) && t > now - yr && t < now + 86_400_000;
  const kindOk = (k) => k === 'vm' || k === 'host';
  const spikes = [];
  for (const s of (Array.isArray(b.spikes) ? b.spikes : []).slice(0, 20_000)) {
    if (!s || !kindOk(s.kind) || !VMS_REF_RE.test(String(s.ref || ''))) continue;
    const t0 = Number(s.t0); const t1 = Number(s.t1); const n = Number(s.n);
    if (!okTs(t0) || !okTs(t1) || t1 < t0 || !(n >= 1 && n <= 100_000)) continue;
    const cols = Array.isArray(s.cols) ? s.cols.slice(0, 32).map(String) : [];
    if (!cols.length || !cols.every((c) => VMS_COL_RE.test(c))) continue;
    const b64 = String(s.data || '');
    if (b64.length > 4_000_000) continue;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== n * (cols.length + 1) * 4) continue;      // 레이아웃 불일치 = 위조/손상
    spikes.push({ kind: s.kind, ref: String(s.ref), t0, t1, n, cols, buf, mxcpu: Number.isFinite(Number(s.mxcpu)) ? Number(s.mxcpu) : -1, mxmem: Number.isFinite(Number(s.mxmem)) ? Number(s.mxmem) : -1 });
  }
  const cover = [];
  for (const c of (Array.isArray(b.cover) ? b.cover : []).slice(0, 200_000)) {
    const h = Number(c?.h); const samples = Number(c?.samples);
    if (!c || !kindOk(c.kind) || !VMS_REF_RE.test(String(c.ref || '')) || !okTs(h) || !(samples >= 1 && samples <= 10_000)) continue;
    cover.push({ kind: c.kind, ref: String(c.ref), h: Math.floor(h / 3_600_000) * 3_600_000, samples: Math.floor(samples) });
  }
  const cursors = [];
  for (const c of (Array.isArray(b.cursors) ? b.cursors : []).slice(0, 20_000)) {
    const lastTs = Number(c?.lastTs);
    if (!c || !kindOk(c.kind) || !VMS_REF_RE.test(String(c.ref || '')) || !okTs(lastTs)) continue;
    cursors.push({ kind: c.kind, ref: String(c.ref), lastTs });
  }
  let historicalInterval = null;
  if (Array.isArray(b.historicalInterval)) {
    historicalInterval = b.historicalInterval.slice(0, 8).map((x) => ({ key: Number(x?.key) || 0, samplingPeriod: Number(x?.samplingPeriod) || null, length: Number(x?.length) || null, name: String(x?.name || '').slice(0, 64), level: Number(x?.level) || null, enabled: x?.enabled !== false }));
  }
  return { spikes, cover, cursors, historicalInterval };
}
centralRouter.post('/vmseries', requireCentral(), async (req, res) => {
  const b = req.body || {};
  if (!b.vcenterId) return res.status(400).json({ ok: false, reason: 'vcenterId가 필요합니다.' });
  const agent = req.centralAuth.agent || String(b.agent && strAgent(b.agent) || ''); // v2.600 CEN2600-10: 글자일 때만(객체면 String() 이 던졌다)
  // v2.600(CEN2600-02·03): site 로 등록된 vCenter 만 — 예전에는 등록되지 않은 임의 id 마다 SQLite 파일(.db·-wal·-shm)이 생겼다.
  const vsDeny = edgeVcWriteDenied(b.vcenterId, { requireSite: true });
  if (vsDeny) { res.locals.ingestReject = { kind: REJECT_KIND.OWNER, reason: vsDeny, vcenterId: String(b.vcenterId).slice(0, 128) }; return res.status(403).json({ ok: false, reason: vsDeny }); }
  if (req.centralAuth.mode === 'agent' && !agentOwnsVcenter(agent, String(b.vcenterId))) {
    const owner = getInventory(String(b.vcenterId))?.agent || '';
    return res.status(403).json({ ok: false, reason: `vcenterId '${b.vcenterId}'는 '${owner}' 소유입니다(다른 엣지가 덮어쓸 수 없습니다).` });
  }
  if (b.source === 'mock' || b.mock === true || isMockVcenter({ id: String(b.vcenterId || ''), name: b.vcenterName })) {
    return res.status(400).json({ ok: false, reason: `엣지 '${agent}' 가 mock(가짜) 스파이크 데이터를 보냈습니다 — 저장하지 않습니다.`, mockBlocked: true });
  }
  const rows = sanitizeVmSeriesBody(b, Date.now());
  const vcId = String(b.vcenterId);
  let commit;
  // v2.600(EDGE2600-03): 같은 청크의 재전송(시한 초과 뒤 resilientFetch 재시도)이 cover 표본을 두 번 더하지 않게 지문을 준다.
  const dedupeTag = `${typeof b.generatedAt === 'string' || typeof b.generatedAt === 'number' ? String(b.generatedAt).slice(0, 64) : ''}|${Number(b.chunk) || 0}/${Number(b.chunks) || 1}`;
  try { commit = await commitVmSeries(vcId, rows, { dedupeTag }); }
  catch (e) { return res.status(500).json({ ok: false, reason: `vmseries 커밋 실패: ${e?.message || e}` }); }
  if (!commit?.ok) return res.status(500).json({ ok: false, reason: commit?.reason || 'vmseries 커밋 실패(DB 사용 불가)' });
  if (rows.historicalInterval) await setVmSeriesMeta(vcId, 'historicalInterval', { at: Date.now(), intervals: rows.historicalInterval });
  if (Number(b.chunk) === 0 || b.chunk == null) await setVmSeriesMeta(vcId, 'vcenter', { id: vcId, name: String(b.vcenterName || vcId).slice(0, 256), lastPollAt: Date.now(), agent });
  noteVcenterOwner(vcId, agent, { peer: req.socket?.remoteAddress || '', hostname: agentHostnameOf(req) });
  console.log(`[central] vmseries 수신: agent=${agent} vc=${vcId} chunk=${b.chunk ?? 0}/${b.chunks ?? 1} spikes=${rows.spikes.length} cover=${rows.cover.length}${commit.coverDuplicate ? ' (재전송 — cover 가산 생략)' : ''}`);
  res.json({ ok: true, vcenterId: vcId, spikes: rows.spikes.length, cover: rows.cover.length, cursors: rows.cursors.length, ...(commit.coverDuplicate ? { coverDuplicate: true } : {}) });
});

// 위임 '현재 사용자' 수신(v2.520) — 엣지 curuser 폴러가 읽은 `guestinfo.curuser.*` 해석 결과를 push.
// /vmseries 와 같은 신뢰 경계(개별 토큰 → agent 강제 + TOFU 소유권 + mock 차단).
// Body: { agent, generatedAt, chunk, chunks, vcenterIds?:string[], records:[{vmId,vcenterId,name,folder,at,kind,ok,active,disc,other,sessions,users:[{name,kind}],error,guestHost}] }
//
// ⚠ 레코드의 `kind` 는 엣지가 계산한 값이지만, 중앙 화면은 **조회 시점에 `at` 로 다시 판정**한다
//   (`curuser/report.js refreshKinds`) — 엣지가 push 를 멈춰도 며칠 전 값이 '정상' 으로 남지 않는다.
const CU_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CU_KINDS = new Set(['ok', 'stale', 'no-agent', 'guest-error', 'incomplete', 'unparsed', 'clock-skew', 'not-found']);
/** 엣지 중복 기록 제거 — 엣지는 주기마다 전 대상을 다시 보낸다(`_lastRec` 규약, v2.516). */
const _cuLastRec = new Map();
function sanitizeCurUserRecords(b) {
  const out = [];
  for (const r of (Array.isArray(b.records) ? b.records : []).slice(0, 5000)) {
    if (!r || !CU_ID_RE.test(String(r.vmId || '')) || !CU_ID_RE.test(String(r.vcenterId || ''))) continue;
    const at = Number(r.at);
    const n = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(100_000, Math.floor(Number(v)))));
    out.push({
      vmId: String(r.vmId), vcenterId: String(r.vcenterId),
      name: String(r.name || '').slice(0, 200), folder: String(r.folder || '').slice(0, 400),
      at: Number.isFinite(at) && at > 0 ? at : null,
      kind: CU_KINDS.has(String(r.kind)) ? String(r.kind) : 'unknown',
      ok: r.ok === true, active: n(r.active), disc: n(r.disc), other: n(r.other), sessions: n(r.sessions),
      users: (Array.isArray(r.users) ? r.users : []).slice(0, 200)
        .map((u) => ({ name: String(u?.name || '').slice(0, 128), kind: ['active', 'disc', 'other'].includes(String(u?.kind)) ? String(u.kind) : 'other' }))
        .filter((u) => u.name),
      error: String(r.error || '').slice(0, 300), guestHost: String(r.guestHost || '').slice(0, 120),
      truncated: r.truncated === true, // v2.606 COL2606-01: 발행기가 원문을 잘랐다(인원은 하한) — 엣지 위임 경로에서도 표지를 잃지 않게
    });
  }
  return out;
}
centralRouter.post('/curuser', requireCentral(), async (req, res) => {
  const b = req.body || {};
  const agent = req.centralAuth.agent || String(b.agent && strAgent(b.agent) || ''); // v2.600 CEN2600-10: 글자일 때만(객체면 String() 이 던졌다)
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  const records = sanitizeCurUserRecords(b);
  // 소유권 — 이 엣지가 인벤토리를 소유한 vCenter 의 레코드만 받는다(다른 엣지가 덮어쓸 수 없게).
  const kept = []; const rejected = new Set();
  for (const r of records) {
    if (edgeVcWriteDenied(r.vcenterId, { requireSite: true })) { rejected.add(r.vcenterId); continue; } // v2.600 CEN2600-02
    if (req.centralAuth.mode === 'agent' && !agentOwnsVcenter(agent, r.vcenterId)) { rejected.add(r.vcenterId); continue; }
    if (isMockVcenter({ id: r.vcenterId })) { rejected.add(r.vcenterId); continue; }
    kept.push(r);
  }
  const chunk0 = Number(b.chunk) === 0 || b.chunk == null;
  // 청크 0 만 latest 를 교체한다(이후 청크는 병합) — 교체를 매 청크에 하면 마지막 청크만 남는다
  // (sanSwitchEdge v2.410 과 같은 규약).
  const replaceVcenters = chunk0
    ? [...new Set((Array.isArray(b.vcenterIds) ? b.vcenterIds : kept.map((r) => r.vcenterId)).map(String))]
      .filter((id) => CU_ID_RE.test(id) && !edgeVcWriteDenied(id, { requireSite: true }) && (req.centralAuth.mode !== 'agent' || agentOwnsVcenter(agent, id)))
    : [];
  const ts = Date.now();
  let commit;
  try { commit = await commitCurUser({ ts, records: kept, series: [], replaceVcenters }); }
  catch (e) { return res.status(500).json({ ok: false, reason: `curuser 커밋 실패: ${e?.message || e}` }); }
  if (!commit?.ok) return res.status(500).json({ ok: false, reason: commit?.reason || 'curuser 커밋 실패(DB 사용 불가)' });
  // 작업 로그 — 엣지가 주기마다 전 대상을 다시 보내므로 `generatedAt` 으로 중복을 제거한다.
  if (chunk0) {
    const gen = Number(b.generatedAt) || ts;
    for (const vcId of new Set(kept.map((r) => r.vcenterId))) {
      const key = `${agent}|${vcId}`;
      if (_cuLastRec.get(key) === gen) continue;
      _cuLastRec.set(key, gen);
      const rs = kept.filter((r) => r.vcenterId === vcId);
      const uniq = new Set(rs.filter((r) => r.ok).flatMap((r) => r.users.map((u) => u.name.trim().toLowerCase())).filter(Boolean));
      recordCurUserActivity({ at: gen, deviceId: vcId, name: vcId, source: agent, ok: true, durationMs: null, vms: rs.length, users: uniq.size });
    }
    if (_cuLastRec.size > 5000) _cuLastRec.clear();
    for (const vcId of new Set(kept.map((r) => r.vcenterId))) noteVcenterOwner(vcId, agent, { peer: req.socket?.remoteAddress || '', hostname: agentHostnameOf(req) });
  }
  console.log(`[central] curuser 수신: agent=${agent} chunk=${b.chunk ?? 0}/${b.chunks ?? 1} records=${kept.length}${rejected.size ? ` 거부=${[...rejected].join(',')}` : ''}`);
  res.json({ ok: true, records: kept.length, rejected: [...rejected], replaced: replaceVcenters.length });
});

/**
 * v2.682(감사 R3A-08): 엣지는 ASCII 로 실을 수 없는 호스트명을 `encodeURIComponent` 로 보낸다(agent/agentNameCarry.js
 *   hostnameHeaderValue — v2.681 R2F-01). 중앙이 그대로 저장하면 수집 서버 진단 화면에 `%ED%95%9C…` 가 보인다. 퍼센트 표기가
 *   있을 때만 풀고(호스트명에 '%' 가 실제로 들어갈 일은 없다), 실패하면 원문을 쓴다. 상주 기록이므로 길이 상한 + 평탄화.
 */
export function agentHostnameOf(req) {
  const raw = req?.get?.('X-Agent-Hostname');
  if (typeof raw !== 'string' || !raw) return '';
  const head = raw.length > 1024 ? raw.slice(0, 1024) : raw;
  let v = head;
  if (/%[0-9A-Fa-f]{2}/.test(head)) { try { v = decodeURIComponent(head); } catch { v = head; } }
  return capStr(v, 255);
}

/*
 * v2.682(감사 R3E-03): '배정 보류'(아래 held)에 시한을 둔다 — v2.601 '보류(withhold)에는 반드시 시한' 규약.
 *   v2.681 R2F-04 는 엣지의 vCenter 를 하나도 모를 때 배정 필드를 빼 '직전 배정 유지' 로 만들었는데, 시한이 없어 그 엣지가
 *   담당하던 vCenter 를 전부 옮기거나 지우면 엣지가 옛 스파이크·현재 사용자 배정을 **무기한** 들고 수집을 계속했다(중앙은 매번 거절).
 *   보류 시작 시각을 엣지·종류별로 기억하고 LASTGOOD_HOLD_MS(기본 6시간 — 인벤토리 마지막 정상 목록 보존 창과 같은 값)를
 *   넘기면 **빈 배정을 명시적으로** 내려보낸다(`…HeldExpired`). 인메모리라 중앙이 재시작하면 보류가 처음부터 다시 잰다
 *   (더 오래 유지하는 쪽 — 보수적). 상한 512 키(공유 토큰은 이름을 주장할 수 있다).
 */
const EDGE_CONFIG_HOLD_MAX_MS = clampIntervalMs(numOrNull(process.env.LASTGOOD_HOLD_MS) ?? 6 * 3_600_000, 6 * 3_600_000, 60_000);
const _heldSince = new Map();
export function edgeConfigHoldExpired(kind, agentLower, held, now = Date.now()) {
  const k = `${kind}|${capStr(agentLower, 128)}`;
  if (!held) { _heldSince.delete(k); return false; }
  let since = _heldSince.get(k);
  if (since == null) {
    if (_heldSince.size >= 512) { const first = _heldSince.keys().next().value; if (first !== undefined) _heldSince.delete(first); }
    since = now; _heldSince.set(k, since);
  }
  return now - since >= EDGE_CONFIG_HOLD_MAX_MS;
}
export function _resetEdgeConfigHoldForTest() { _heldSince.clear(); }
export const EDGE_CONFIG_HOLD_MS = EDGE_CONFIG_HOLD_MAX_MS;

/**
 * v2.681(감사 R2F-04): 이 엣지가 수집하는 vCenter 집합 = 인벤토리 캐시 소유(TOFU) ∪ 등록부 위임(collectMode 'site' +
 *   remoteAgent, 대소문자 무시). 예전에는 캐시 소유만 봐서 소유권 해제(v2.599 owner API)·손상 캐시로 빈 채 기동한 직후
 *   엣지 pull 이 '대상 0' 을 200 으로 받아 그 주기 수집을 멈췄다. 등록부를 못 읽으면 캐시 소유만 쓴다.
 */
function edgeVcenterSet(agentLower) {
  const mine = new Set(listInventory().filter((e) => String(e.agent || '').toLowerCase() === agentLower).map((e) => String(e.vcenterId)));
  if (!agentLower) return mine;
  try {
    for (const v of loadVcenterConfig().vcenters || []) {
      if (!v || v.id == null || (v.collectMode || 'direct') !== 'site') continue;
      if (String(v.remoteAgent || '').trim().toLowerCase() === agentLower) mine.add(String(v.id));
    }
  } catch { /* 등록부를 못 읽으면 캐시 소유만 */ }
  return mine;
}

// '현재 사용자' 설정 배포(v2.520) — 엣지가 주기적으로 GET. 이 엣지가 소유한 vCenter 항목만 내려준다.
centralRouter.get('/curuser-config', requireCentral(), (req, res) => {
  if (settingsUnreadable(res, curUserSettingsLoadError, '현재 사용자')) return; // v2.631 EDGE2631-01
  const agent = String(req.centralAuth.agent || req.query.agent || '').trim().toLowerCase();
  const mine = edgeVcenterSet(agent);
  const s = loadCurUserSettings();
  const vcenters = Object.fromEntries(Object.entries(s.vcenters || {}).filter(([id]) => mine.has(id)));
  // v2.681(R2F-04): 이 엣지의 vCenter 를 하나도 알 수 없으면 settings.vcenters 를 **싣지 않는다** — 엣지 applyCentral 은
  //   로컬 위에 병합하므로 키가 없으면 직전 배정이 유지된다(빈 객체를 보내면 '배정 해제' 로 적용된다).
  // v2.682(R3E-03): 보류가 시한을 넘기면 빈 배정을 명시적으로 보낸다(엣지 applyCentral 이 '배정 해제' 로 적용).
  const expired = edgeConfigHoldExpired('curuser', agent, mine.size === 0);
  const held = mine.size === 0 && !expired;
  res.json({
    ok: true,
    settings: {
      enabled: s.enabled, intervalMs: s.intervalMs, retentionDays: s.retentionDays,
      concurrency: s.concurrency, vmTimeoutMs: s.vmTimeoutMs, maxVms: s.maxVms,
      guestPublishMs: s.guestPublishMs, staleFactor: s.staleFactor, ...(held ? {} : { vcenters }),
    },
    vcenters: [...mine], ...(held ? { vcentersHeld: true } : {}), ...(expired ? { vcentersHeldExpired: true } : {}),
  });
});

// 실시간 스파이크 수집 설정 배포(v2.510) — 엣지가 주기적으로 GET. 이 엣지가 수집하는(인벤토리 소유)
// vCenter 의 targets 만 내려준다(다른 법인 id 비노출). scope='all' 은 그대로 내려간다.
centralRouter.get('/vmseries-config', requireCentral(), (req, res) => {
  if (settingsUnreadable(res, vmSeriesSettingsLoadError, '실시간 스파이크')) return; // v2.631 EDGE2631-01
  const agent = String(req.centralAuth.agent || req.query.agent || '').trim().toLowerCase();
  const mine = edgeVcenterSet(agent);
  const s = loadVmSeriesSettings();
  const targets = Object.fromEntries(Object.entries(s.targets || {}).filter(([id]) => mine.has(id)));
  // v2.681(R2F-04): 이 엣지의 vCenter 를 모르면 targets 를 싣지 않는다 — 새 엣지(vmSeriesConfigPull)는 '필드 없음 = 직전 유지'.
  //   (구버전 엣지는 빈 객체로 읽는다 — 예전 중앙이 {} 를 보내던 것과 같아 퇴행은 없다.)
  const expired = edgeConfigHoldExpired('vmseries', agent, mine.size === 0);   // v2.682(R3E-03)
  const held = mine.size === 0 && !expired;
  res.json({ ok: true, settings: { enabled: s.enabled, intervalMin: s.intervalMin, retentionDays: s.retentionDays, thresholds: s.thresholds, scope: s.scope, ...(held ? {} : { targets }) }, vcenters: [...mine], ...(held ? { targetsHeld: true } : {}), ...(expired ? { targetsHeldExpired: true } : {}) });
});

// 엣지 베어메탈 집계: 현장 포탈이 자기 DC의 베어메탈 목록(전력 미보고 포함)을 push.
// Body: { agent, baremetal:[{fleetId,name,model,serviceTag,watts,vcenterId,source}], generatedAt }
centralRouter.post('/fleet', requireCentral(), (req, res) => {
  const b = req.body || {};
  const agent = req.centralAuth.agent || String(b.agent && strAgent(b.agent) || ''); // v2.600 CEN2600-10: 글자일 때만(객체면 String() 이 던졌다)
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  const list = Array.isArray(b.baremetal) ? b.baremetal : [];
  // v2.601(감사 CEN2601-02·03): ① 원소 vcenterId 는 이 엣지가 소유(인벤토리 기준)한 vCenter 에만 귀속한다 — 예전에는 본문 값을
  //   그대로 받아 남의 법인 vCenter 로 베어메탈을 귀속시킬 수 있었다(v2.599 CEN-02 는 /inventory 만 묶었다). 소유하지 않은 id 는
  //   원소를 버리지 않고 **귀속만 비운다**(서버 자체는 실재한다). ② 공유 토큰 + 중앙이 모르는 이름은 '미검증' 이라 이름 수·원소 수를
  //   작게 묶고, 소유를 증명할 길이 없으므로 귀속도 비운다. 뺀·비운 개수는 응답에 싣는다(조용한 상한 금지).
  const verified = req.centralAuth.mode === 'agent' || edgeNameKnown(agent);
  // v2.744(감사 EDGE-01): 엣지가 iDRAC 등록부를 읽지 못해 보낸 **상태 전용 보고** — 목록을 교체하지 않고 직전 목록의 만료만 미룬다
  //   (agent/fleetPush.js 가 중앙 2.744.0 이상을 확인한 뒤에만 보낸다). 이름을 검증하지 못한 보고는 보관분을 건드리지 않는다
  //   (공유 토큰으로 남의 이름을 골라 옛 목록을 붙잡아 두지 못하게 — 기록만 응답한다).
  if (b.statusOnly === true) {
    if (!verified) return res.json({ ok: true, agent, statusOnly: true, kept: 0, unverifiedAgent: true });
    const st = b.status && typeof b.status === 'object' && !Array.isArray(b.status) ? b.status : {};
    const h = holdEdgeFleet(agent, { registryUnreadable: st.registryUnreadable });
    if (h.changed) console.warn(`[central] fleet: '${agent}' 엣지가 iDRAC 등록부를 읽지 못했다고 보고했습니다 — ${h.noPrior ? '보관 중인 목록이 없어 아무것도 바꾸지 않았습니다' : h.holdExpired ? '직전 목록 유지 시한이 지나 만료를 미루지 않았습니다' : `직전 목록 ${h.kept}대를 유지합니다`}`);
    return res.json({ ok: true, agent, statusOnly: true, kept: h.kept, ...(h.noPrior ? { noPrior: true } : {}), ...(h.holdExpired ? { holdExpired: true } : {}) });
  }
  const vcAllowed = verified ? (vc) => agentOwnsVcenter(agent, vc) : () => false;
  // v2.606(RECENT2606-03): 엣지가 일부를 빼고 보낸 목록이면(partial) 그 사실을 저장해 중앙이 밝힌다 — 예전에는 버렸다.
  const r = setEdgeFleet(agent, list, b.generatedAt || null, { verified, vcAllowed, partial: b });
  res.json({ ok: true, agent, baremetal: r.accepted, ...(r.omitted ? { omitted: r.omitted } : {}), ...(r.vcenterBlanked ? { vcenterBlanked: r.vcenterBlanked } : {}), ...(verified ? {} : { unverifiedAgent: true }), ...(r.partial ? { partial: r.partial } : {}) });
});

/**
 * v2.601(감사 CEN2601-03): 중앙이 **이미 아는** 엣지 이름인가 — 발급 토큰 · 수집 서버 등록부 · 위임 인벤토리 소유 · 스캔 배정.
 * 공유 토큰은 본문 agent 를 마음대로 고를 수 있으므로, 여기 없는 이름은 '미검증' 으로 다룬다(5초 캐시 — 푸시마다 파일을 읽지 않게).
 * ⚠ knownAgentNames() 를 쓰지 않는다 — 그 합집합은 스캔 결과·설정 pull 처럼 **공유 토큰이 이름을 만들어 넣을 수 있는 소스**를 포함한다.
 */
let _knownNames = { at: 0, set: null };
/**
 * v2.849 정정(회귀 — audit2601c CEN2601-02): 인증 미들웨어의 엣지 생존 기록(noteAgentContact)은 **이 캐시를 쓰지 않는다**. 같은 캐시를 쓰면
 *   미들웨어가 요청 처리 **전에** 캐시를 채워, 그 요청(인벤토리 push)으로 새로 '아는 이름' 이 된 엣지가 5초 동안 /fleet 에서 미검증으로 판정됐다.
 */
const _contactKnownNames = { at: 0, set: null };
function edgeNameKnown(name, holder = null) {
  const now = Date.now();
  const c = holder || _knownNames;
  if (!c.set || now - c.at > 5_000) {
    const set = new Set();
    const add = (v) => { if (typeof v === 'string' && v.trim()) set.add(v.trim().toLowerCase()); };
    try { for (const t of listAgentTokens()) add(t.agent); } catch { /* 소스 미초기화 */ }
    // v2.604(감사 CEN2604-04): 수집 서버 등록부는 **관리자 등록(managed)** 이거나 자기등록 검증을 통과한(selfRegUnverified 없음)
    //   항목, 또는 이 프로세스에서 pull 이 한 번이라도 성공한 항목만 센다. 예전에는 공유 토큰이 검증에 실패한 urlHint 로 만든
    //   이름까지 '아는 엣지' 가 되어 v2.601 CEN2601-03 의 미검증 제한(/fleet·/gpu-guest-data·log-query-result)을 우회했다.
    try {
      const st = allCollectorStatusForKnown();
      for (const c of listCollectorsForLinks()) {
        if (c.managed || !c.selfRegUnverified || st[c.id]?.ok === true) { add(c.id); add(c.name); }
      }
    } catch { /* */ }
    try { for (const x of listInventory()) add(x.agent); } catch { /* */ }
    try { for (const x of listScanAssignments()) add(x.agent); } catch { /* */ }
    c.at = now; c.set = set;
  }
  return c.set.has(String(name || '').trim().toLowerCase());
}

/** v2.605(RECENT2605-02): 수집 서버 등록부에 있는 이름인가(자기등록 미검증 포함) — edge-log-result 의 acked 회신 전용. */
function edgeNameRegistered(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  try {
    for (const c of listCollectorsForLinks()) {
      if (String(c.id || '').trim().toLowerCase() === n || String(c.name || '').trim().toLowerCase() === n) return true;
    }
  } catch { /* 등록부 없음 */ }
  return false;
}

// 위임 iDRAC 스캔: 에이전트가 자기 이름의 온디맨드 스캔 잡을 인출.
centralRouter.get('/idrac-scan-jobs', requireCentral(), (req, res) => {
  // v2.604(감사 TIM2604-04): 개별 토큰이면 토큰 이름을 먼저 쓴다(바인딩 검사와 같은 이름). 공유 토큰만 ?agent= 를 쓴다.
  const who = req.centralAuth?.mode === 'agent' && req.centralAuth.agent ? req.centralAuth.agent : req.query.agent;
  // v2.622(감사 RECENT-03·EDGE-02): ?busy=1 = 엣지가 스캔 잠금 중이라 잡을 받을 수 없다 — 폴 시각만 갱신하고 잡은 주지 않는다.
  //   busyAck 로 '이 중앙은 busy 를 이해한다' 를 알린다(엣지는 health-probe 버전으로 먼저 확인한 뒤에만 이 폴을 보낸다).
  if (String(req.query.busy || '') === '1') { noteIdracScanBusyPoll(who); return res.json({ ok: true, jobs: [], busyAck: true }); }
  res.json({ ok: true, jobs: takeIdracScanJobs(who) });
});

// 위임 iDRAC 스캔: 에이전트가 스캔 진행률(중간)을 보고. Body: { reqId, scanned, total }
centralRouter.post('/idrac-scan-progress', requireCentral(), (req, res) => {
  const b = req.body || {};
  if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  if (reqAgentDenied(req, agentOfReq(String(b.reqId)))) return res.status(403).json({ ok: false, reason: '이 reqId 는 요청 에이전트의 잡이 아닙니다.' });
  // v2.621(감사 EDGE-01): 중앙에 없는 잡(만료·중앙 재시작)이면 410 — 예전에는 반환값을 보지 않고 200 이라 엣지는 성공으로 적고
  //   중앙은 아무것도 반영하지 않았다(조용한 소실). 410 은 재전송 대상이 아니다(엣지가 상태·콘솔에 남긴다).
  if (!setIdracScanProgress(String(b.reqId), b)) return res.status(410).json({ ok: false, reason: 'unknown-job', detail: '중앙에 이 스캔 잡이 없습니다(만료되었거나 중앙이 재시작됨) — 진행 보고를 반영하지 않았습니다.' });
  res.json({ ok: true });
});

// 위임 iDRAC 스캔: 에이전트가 발견 목록·요약을 reqId와 함께 회신.
// Body: { agent, reqId, scanned, found:[...], unreachable, notIdrac, authFailed, registered, error? }
centralRouter.post('/idrac-scan-result', requireCentral(), (req, res) => {
  const b = req.body || {};
  if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  if (reqAgentDenied(req, agentOfReq(String(b.reqId)))) return res.status(403).json({ ok: false, reason: '이 reqId 는 요청 에이전트의 잡이 아닙니다.' });
  const applied = applyIdracScanResult(String(b.reqId), b);
  // v2.621(감사 EDGE-01): 중앙에 없는 잡이면 410 — 예전에는 반환값을 보지 않고 200 이라 엣지는 '회신 성공' 으로 적고 결과·스캔 로그·
  //   대역 '최근 결과' 는 조용히 사라졌다. 엣지는 410 을 상태·콘솔에 남긴다(현지 등록은 이미 끝났으므로 인벤토리는 잃지 않는다).
  if (applied.unknown) {
    console.warn(`[central] idrac-scan-result: 중앙에 없는 잡(${String(b.reqId).slice(0, 64)}) 의 결과 — 만료·중앙 재시작으로 반영하지 못했습니다(410)`);
    return res.status(410).json({ ok: false, reason: 'unknown-job', detail: '중앙에 이 스캔 잡이 없습니다(만료되었거나 중앙이 재시작됨) — 결과를 반영하지 않았습니다. 엣지 현지 등록은 그대로입니다.' });
  }
  // v2.621(감사 EDGE-07): 같은 결과의 재전송(응답 유실 후 엣지 재시도)은 ack 만 한다 — 수집 서버 pull 도 다시 걸지 않는다.
  if (applied.duplicate) return res.json({ ok: true, duplicate: true });
  // 위임 스캔이 에이전트 현지에 서버를 등록했으면, 그 전력은 '원격 수집(collector pull)'로 중앙에
  // 반영된다. 다음 정기 풀(최대 60s)을 기다리지 않고 즉시 + 지연(에이전트 전력 수집 시간 고려)으로
  // 당겨와 반영을 앞당긴다. best-effort(실패 무시).
  if (Number(b.registered) > 0) {
    pullCollectorsNow().catch(() => {});
    setTimeout(() => pullCollectorsNow().catch(() => {}), 30_000).unref?.();
  }
  res.json({ ok: true });
});

/**
 * v2.600(CEN2600-01): gpu-guest-data 원소 좁히기 — 식별자는 글자(128자), 사용률은 0~100 유한수 또는 null, 나머지 표시 필드는 글자.
 * 식별자가 없으면 버린다(null). 사용률이 이상값이면 null 로 두고 `dropped.badPct` 를 센다.
 */
export function narrowGpuRow(x, dropped = { badPct: 0 }) {
  const idOf = (v) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v).slice(0, 256) : '');
  const pctOf = (v) => {
    if (v == null) return null;
    const n = numOrNull(v);
    if (n == null || n < 0 || n > 100) { dropped.badPct += 1; return null; }
    return n;
  };
  const out = {};
  if (x.hostId != null) { const id = idOf(x.hostId); if (!id) return null; out.hostId = id; }
  if (x.vmId != null) { const id = idOf(x.vmId); if (!id) return null; out.vmId = id; }
  if (out.hostId == null && out.vmId == null) return null;
  if (Object.hasOwn(x, 'utilPct')) out.utilPct = pctOf(x.utilPct);
  if (Object.hasOwn(x, 'memUsedPct')) out.memUsedPct = pctOf(x.memUsedPct);
  // v2.650: 메모리 MB·온도·GPU 수 — 범위 밖은 null(gpu/store.js 가 같은 규칙으로 다시 좁힌다). 구버전 엣지는 필드가 없다.
  if (Object.hasOwn(x, 'memUsedMB')) out.memUsedMB = mbOrNull(x.memUsedMB);
  if (Object.hasOwn(x, 'memTotalMB')) out.memTotalMB = mbOrNull(x.memTotalMB);
  if (Object.hasOwn(x, 'tempC')) out.tempC = tempOrNull(x.tempC);
  if (Object.hasOwn(x, 'gpus')) { const n = numOrNull(x.gpus); out.gpus = n != null && n >= 0 && n <= 64 ? Math.floor(n) : null; }
  // v2.769(점검 R4-D5-3): 응답 없는 GPU 장수 — gpus 와 같은 범위 규칙(밖이면 null = 모름). 구버전 엣지는 필드가 없다.
  if (Object.hasOwn(x, 'gpuErrors')) { const n = numOrNull(x.gpuErrors); out.gpuErrors = n != null && n >= 0 && n <= 64 ? Math.floor(n) : null; }
  if (x.utilNA === true) out.utilNA = true;
  for (const k of ['host', 'vcenterId', 'name']) if (x[k] != null) out[k] = typeof x[k] === 'string' ? x[k].slice(0, 256) : (typeof x[k] === 'number' && Number.isFinite(x[k]) ? String(x[k]) : null);
  return out;
}

// 게스트 GPU 수집 위임: ESXi 망에 닿는 현장 agent가 게스트 OS(nvidia-smi)에서 수집한
// GPU 사용률을 push. 중앙은 포탈이 ESXi에 직접 못 가는 환경에서 이 값을 오버레이로 사용.
// Body: { agent, hosts:[{hostId,utilPct}], vms:[{vmId,utilPct,memUsedPct,host,vcenterId}] }
centralRouter.post('/gpu-guest-data', requireCentral(), (req, res) => {
  const b = req.body || {};
  const agent = req.centralAuth.agent || String(b.agent && strAgent(b.agent) || ''); // v2.600 CEN2600-10: 글자일 때만(객체면 String() 이 던졌다)
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  // v2.591(3차 감사 PR-8): null·문자열 원소를 건너뛴다(v2.548 S1 규약) — `{"hosts":[null]}` 가 `h.hostId` TypeError → 500 이었다.
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  // v2.600(감사 CEN2600-01): 원소를 **아는 필드만** 좁혀 싣는다. 예전에는 utilPct 가 그대로 저장돼 객체 하나가 다음
  //   지표 샘플러의 적재 트랜잭션(metrics/db.js insertMany — 배치 1회)을 bind 오류로 **통째로 롤백**시켰다(그 분 전 지표 소실).
  //   사용률은 0~100 의 유한수만, 밖이면 null(없는 값을 지어내지 않는다 — 호스트는 null 이면 오버레이를 만들지 않는다).
  const gpuDropped = { badPct: 0 };
  let hosts = Array.isArray(b.hosts) ? b.hosts.slice(0, 50_000).filter(isObj).map((h) => narrowGpuRow(h, gpuDropped)).filter(Boolean) : [];
  let vms = Array.isArray(b.vms) ? b.vms.slice(0, 500_000).filter(isObj).map((v) => narrowGpuRow(v, gpuDropped)).filter(Boolean) : [];
  if (gpuDropped.badPct) console.warn(`[central] gpu-guest-data: ${agent} 사용률 값 ${gpuDropped.badPct}개가 0~100 의 수가 아니라 비웠습니다`);
  // 엣지 간 쓰기 격리: hostId/vmId 는 `${vc.id}:${moRef}` 네임스페이스다. 개별 토큰(agent 모드)일 때,
  // 그 vCenter 를 소유(최초 등록)한 엣지가 아니면 그 항목을 버린다 — 한 엣지가 남의 vCenter GPU
  // 오버레이를 덮어쓰는 것을 차단(/inventory TOFU 소유권과 동일 모델). 미등록 vCenter(owner='')는
  // TOFU 로 통과. 공유 토큰은 어느 엣지인지 알 수 없어 검사 생략(완전 봉인=CENTRAL_REQUIRE_AGENT_TOKEN).
  if (req.centralAuth.mode === 'agent') {
    // hostId/vmId 는 `${vc.id}:${moRef}`. vc.id 자체가 콜론을 포함할 수 있어(registry 가 콜론 허용)
    // 첫 콜론 기준 단순 분리로는 vcId 를 잘못 뽑아 소유권 검사가 우회된다. 등록된 vcenterId 중 이 id 의
    // 프리픽스인 것(가장 긴 것)으로 소유 vCenter 를 판정한다(최장 프리픽스 매칭).
    const invOwners = listInventory().map((e) => ({ vc: String(e.vcenterId || ''), agent: String(e.agent || '') }));
    // direct-mode(중앙 직접 수집) vCenter 의 GPU 는 로컬 폴러(agent='')만 기록해야 한다 — 엣지는
    // 그 vCenter 를 수집하지 않으므로 어떤 엣지의 쓰기도 위조다. collectMode!=='site' = direct.
    const directIds = (() => {
      try { return (loadVcenterConfig().vcenters || []).filter((v) => (v.collectMode || 'direct') !== 'site').map((v) => String(v.id)); }
      catch { return []; }
    })();
    const ownsVc = (id) => {
      const s = String(id || '');
      let owner = ''; let best = -1; let direct = false;
      // 등록된 vcenterId 중 이 id 의 프리픽스(가장 긴 것)로 소유 vCenter 판정 — vc.id 에 콜론이
      // 있어도(registry 가 콜론 허용) 안전하게 매칭(단순 split(':') 오파싱 방지).
      for (const e of invOwners) {
        if (e.vc && (s === e.vc || s.startsWith(`${e.vc}:`)) && e.vc.length > best) { best = e.vc.length; owner = e.agent; }
      }
      for (const vc of directIds) {   // direct-mode 도 최장 프리픽스로 — site 와 동률이면 direct 우선(안전측 거부)
        if ((s === vc || s.startsWith(`${vc}:`)) && vc.length >= best) { best = vc.length; direct = true; }
      }
      if (direct) return false;       // direct-mode = 중앙 소유, 엣지 쓰기 금지(잔여 위조 봉인)
      return !owner || owner.toLowerCase() === agent.toLowerCase();  // 미등록 site = TOFU 통과(부트스트랩)
    };
    const hBefore = hosts.length; const vBefore = vms.length;
    hosts = hosts.filter((h) => ownsVc(h.hostId));
    vms = vms.filter((v) => ownsVc(v.vmId));
    const dropped = (hBefore - hosts.length) + (vBefore - vms.length);
    if (dropped) console.warn(`[central] gpu-guest-data: ${agent} 가 소유하지 않은 vCenter 항목 ${dropped}개 드롭(위조 방지)`);
  }
  // v2.603(감사 CEN2603-01): 식별자의 vCenter 접두는 **등록부에 사이트 위임(site)으로 등록된 id** 여야 한다(토큰 종류 무관 —
  //   대상의 구조적 성질이다. v2.600 edgeVcWriteDenied requireSite 와 같은 판단). 예전에는 등록되지 않은 접두를 TOFU 로 받아
  //   접두를 바꿔 가며 항목을 무한히 만들 수 있었다. 등록부를 읽지 못하면 판정하지 않는다(설정 문제가 수신을 끊지 않게).
  const modes = vcCollectModes();
  let unregistered = 0;
  if (modes) {
    const siteIds = [...modes].filter(([, m]) => m === 'site').map(([id]) => id);
    const onSite = (id) => { const s = String(id || ''); return siteIds.some((vc) => s === vc || s.startsWith(`${vc}:`)); };
    const hB = hosts.length; const vB = vms.length;
    hosts = hosts.filter((h) => onSite(h.hostId));
    vms = vms.filter((v) => onSite(v.vmId));
    unregistered = (hB - hosts.length) + (vB - vms.length);
    if (unregistered) console.warn(`[central] gpu-guest-data: ${agent} 등록되지 않은 vCenter 의 항목 ${unregistered}개 드롭`);
  }
  const verifiedGpu = req.centralAuth.mode === 'agent' || edgeNameKnown(agent);
  const put = withGpuTrust(verifiedGpu, () => setGuestGpu({ hosts, vms, agent })); // 미검증 이름은 작은 상한(gpu/store.js)
  const omitted = (put.omittedHosts || 0) + (put.omittedVms || 0);
  if (omitted) console.warn(`[central] gpu-guest-data: ${agent} 상한 초과로 ${omitted}개를 받지 않았습니다(호스트 ${put.omittedHosts} · VM ${put.omittedVms})`);
  // v2.681(R2F-02): 진단도 검증 여부를 싣는다 — 미검증 이름이 검증된 엣지의 진단을 상한 퇴출로 밀지 않게.
  const diagPut = b.diag ? setGpuGuestDiag(agent, b.diag, { hosts: hosts.length, vms: vms.length }, { verified: verifiedGpu }) : null; // 수집 진단 보관
  // v2.583: 엣지마다 인벤토리 주기로 찍혀 저널을 덮었다(28곳 × 60초 ≈ 하루 4만 줄) — 값이 바뀔 때와
  //   1시간마다만 찍는다(util/logThrottle.js). 문구 형식은 그대로다(로그 분석 규칙이 이 형식을 읽는다).
  if (gpuRecvLog(agent, `${hosts.length}/${vms.length}`)) console.log(`[central] gpu-guest-data 수신: agent=${agent} hosts=${hosts.length} vms=${vms.length}`);
  res.json({ ok: true, agent, hosts: put.hosts, vms: put.vms,
    ...(omitted ? { omitted: { hosts: put.omittedHosts, vms: put.omittedVms } } : {}),
    ...(unregistered ? { unregistered } : {}), ...(verifiedGpu ? {} : { unverifiedAgent: true }),
    ...(diagPut && diagPut.stored === false ? { diagNotStored: diagPut.reason } : {}) });
});

// 중앙→엣지 GPU 게스트 설정 배포(pull): 엣지가 자기 이름으로 배포 설정을 가져가 로컬 적용.
// 폐쇄망/NAT 엣지도 아웃바운드 GET만으로 동작. 비밀번호 포함(엣지가 실제 인증에 사용) → 토큰 필수.
// GET /api/central/gpu-guest-config?agent=<이름>
centralRouter.get('/gpu-guest-config', requireCentral(), (req, res) => {
  const agent = String(req.query.agent || req.get('X-Agent-Name') || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  // v2.727(감사 D-01): 배포 파일이 손상(보존본만 남음)이면 `assigned:false` 가 아니라 503 — 엣지는 직전 적용분(로컬 사본)을 유지한다.
  if (settingsUnreadable(res, gpuGuestConfigLoadError, 'GPU 게스트 수집 배포')) return;
  const settings = getAssignedGpuGuest(agent);
  if (!settings) return res.json({ ok: true, agent, assigned: false }); // 지정 없음 → 엣지는 로컬 설정 유지
  const { _updatedAt, ...s } = settings;
  res.json({ ok: true, agent, assigned: true, at: _updatedAt || 0, settings: s });
});

// 중앙→엣지 배포 사용자(pull): 엣지가 자기 이름으로 '중앙이 지정한 사용자 목록'을 가져가 로컬
// users.json에 managed로 반영. 비밀번호 해시 포함(엣지가 로그인 검증에 사용) → 토큰 필수.
/**
 * v2.742(감사 EDGE-03): **지속형 503**(등록부·설정 파일을 못 읽음 · 중앙 DB 를 쓸 수 없음)에는 Retry-After 를 싣는다.
 *   이 상태는 400·800ms 뒤에도 그대로다(isidu/db.js 등은 열기 실패를 래치한다) — 그런데 Retry-After 가 없어 엣지 resilientFetch 가
 *   같은 큰 본문을 400·800ms 간격으로 두 번 더 올렸다. 헤더가 있으면 재시도가 그 간격(상한 30초 — resilientFetch.retryDelayMs)을 따른다.
 *   ⚠ bigJsonGate 의 503(큰 본문 해석 혼잡)은 **일시 상태**라 따로 짧은 Retry-After 를 싣는다 — 이 헬퍼를 거기에 쓰지 말 것.
 *   값은 '다음 주기쯤 다시' 라는 뜻의 60초다(엣지 push·pull 주기는 1~10분). 큰 본문 push(isidu·edge-log-result)는 503 을 호출 안에서
 *   아예 다시 보내지 않는다(엣지 쪽 규칙 — 다음 주기 재전송에 맡긴다).
 */
export const PERSISTENT_503_RETRY_AFTER_SEC = 60;
const PERSISTENT_503_HEADERS = Object.freeze({ 'Retry-After': String(PERSISTENT_503_RETRY_AFTER_SEC), 'Cache-Control': 'no-store' });
function persistent503(res) { return res.status(503).set(PERSISTENT_503_HEADERS); }

/**
 * v2.612 LEFT2612-01: 중앙 등록부를 읽지 못했으면(손상 → 보존) 설정 pull 에 **503** 으로 답한다. 빈 목록을 ok:true 로
 *   내려보내면 엣지가 장비 목록·스냅샷·관리 계정을 통째로 지웠다. 엣지 pull 은 비-2xx 를 실패로 보고 직전 목록을 유지한다.
 *   ⚠ 재수집 요청 큐(take*)를 꺼내기 **전에** 본다 — 꺼낸 뒤 503 이면 요청이 사라진다.
 */
function registryUnreadable(res, errOf, what) {
  let e = null;
  try { e = typeof errOf === 'function' ? errOf() : null; } catch (x) { e = { at: Date.now(), reason: x?.message || String(x) }; }
  if (!e) return false;
  // v2.744(리드 후속 RY): 사유는 중앙 등록부 로드 오류 **원문**(JSON.parse 메시지 = 손상된 자격증명 파일 조각)이 아니라 요약이다 —
  //   이 응답은 엣지로 가서 그 엣지의 설정 pull 상태·콘솔(→ 엣지 로그)에 실린다. 원문은 중앙의 보존본 파일에 있다. 문장 모양은 그대로다.
  const why = summarizeRegistryError(e)?.text || '사유 미상';
  persistent503(res).json({ ok: false, reason: 'registryUnreadable', detail: `중앙 ${what} 등록부를 읽지 못했습니다(${why}) — 엣지는 직전 목록을 유지합니다. 중앙 설정 디렉터리의 손상 보존본을 복구하거나 등록을 다시 저장하세요.`, since: e.at || null });
  return true;
}

/**
 * v2.631(EDGE2631-01): 중앙 **설정 파일**(엣지에 배포되는 값)을 읽지 못했으면 설정 pull 에 503 {settingsUnreadable} 으로 답한다.
 *   손상 → preserveCorrupt → 기본값(꺼짐·빈 범위)을 200 으로 내려보내면 엣지가 그것을 '중앙이 명시한 값' 으로 보고 사본을 덮거나
 *   지워 전 엣지의 수집이 한 번에 꺼졌다(등록부는 v2.612 에 막았는데 설정 배포 경로가 빠져 있었다). 엣지 pull 은 비-2xx 를
 *   실패로 보고 직전 사본을 유지한다. 중앙 자신의 로컬 동작(꺼짐 표시)은 바꾸지 않는다.
 */
/**
 * v2.744(회귀 검토 리드 — RY 보고): 중앙 **설정 파일** 손상 사유(대개 JSON.parse 오류 원문 = 그 파일의 조각 — agent-assignments.json 의 iDRAC 비밀번호,
 *   GPU 게스트 배포의 게스트 비밀번호가 들어 있다)를 엣지 응답·콘솔에 싣기 전에 요약한다(`safeLoadText` — 따옴표가 든 원문만 분류·위치로 바꾸고 이미 만든 사람 문장은 그대로). 원문은 중앙의 보존본 파일에 있다.
 */
const loadWhy = (reason) => safeLoadText(reason) || '사유 미상';
const settingsUnreadableLog = createChangeLogger({ windowMs: 3_600_000 }); // v2.632 AX1-2632-02: 같은 사유는 1시간에 1줄
function settingsUnreadable(res, errOf, what) {
  let e = null;
  try { e = typeof errOf === 'function' ? errOf() : null; } catch (x) { e = { at: Date.now(), reason: x?.message || String(x) }; }
  if (!e) return false;
  // v2.632(감사 AX1-2632-02): 예전에는 콘솔에도 남기지 않아 503 이 나가는 동안 중앙 어디에서도 그 사실이 보이지 않았다.
  if (settingsUnreadableLog(what, String(e.reason || ''))) {
    console.warn(`[central] 중앙 ${what} 설정 파일을 읽지 못해 설정 pull 에 503 으로 답합니다(엣지는 직전 설정 유지): ${loadWhy(e.reason)}`);
  }
  persistent503(res).json({ ok: false, reason: 'settingsUnreadable', detail: `중앙 ${what} 설정 파일을 읽지 못했습니다(${loadWhy(e.reason)}) — 엣지는 직전 설정을 유지합니다. 중앙 설정 디렉터리의 손상 보존본을 복구하거나 설정을 다시 저장하세요.`, since: e.at || null });
  return true;
}

/**
 * v2.632(감사 EDGE2632-03): 스토리지·PDU 설정 pull 의 `intervals` 부분. 주기 설정 파일을 못 읽었으면 —
 *   · 엣지가 `?intervalsHold=1`(이 규약을 아는 2.632+ 엣지)을 보냈으면 intervals 를 빼고 `intervalsUnreadable` 을 싣는다
 *     (장비 목록·collectNow 는 등록부가 원천이라 그대로 — cvp-config 와 같은 모양). 엣지는 직전 주기를 유지한다.
 *   · 구버전 엣지는 intervals 가 없으면 `{}` 로 적용해 중앙 지정 주기를 풀어 버리므로 **응답 전체를 503** 으로 답한다
 *     (비-2xx 면 엣지는 장비 목록·주기를 전부 그대로 둔다). 재수집 요청은 큐에 남는다(인출하지 않는다).
 * @returns {object|null} 응답에 펼칠 부분 — null 이면 이미 503 으로 답했다.
 */
function intervalsPartOrUnreadable(req, res, errOf, what, valuesOf) {
  let e = null;
  try { e = typeof errOf === 'function' ? errOf() : null; } catch (x) { e = { at: Date.now(), reason: x?.message || String(x) }; }
  if (!e) return { intervals: valuesOf() };
  if (String(req.query.intervalsHold || '') !== '1') { settingsUnreadable(res, () => e, what); return null; }
  if (settingsUnreadableLog(what, String(e.reason || ''))) {
    console.warn(`[central] 중앙 ${what} 설정 파일을 읽지 못해 설정 pull 에서 intervals 를 뺍니다(엣지는 직전 주기 유지): ${loadWhy(e.reason)}`);
  }
  return { intervalsUnreadable: { reason: loadWhy(e.reason), since: e.at || null } };
}

/**
 * v2.620(EDGE2620-01): 엣지 **수신(push)** 라우트도 소유 판정 전에 등록부 손상을 본다. 손상 → 보존 → 빈 목록이면 소유 집합이
 *   비어 cvp-data 는 그 엣지의 상태·장비 행을 지우고, sanswitch-perf 는 전 표본을 '미위임(위조 방지)' 으로 버리고, storage/pdu/
 *   sanswitch-data 는 그 엣지 목록을 빈 목록으로 교체한 채 **200 ok** 를 줬다 — 엣지는 커서를 전진해 표본이 영구 소실됐다.
 *   503 은 재전송 대상이다(엣지 push 는 비-2xx 를 실패로 보고 커서·해시를 남긴다). 상태 전용 보고는 등록부를 쓰지 않으므로 먼저 받는다.
 */
async function receiveRegistryUnreadable(res, registryPath, what) {
  let errOf = null;
  try { errOf = (await import(registryPath)).registryLoadError; } catch (x) { errOf = () => ({ at: Date.now(), reason: x?.message || String(x) }); }
  if (!registryUnreadable(res, errOf, what)) return false;
  console.warn(`[central] ${what} 수신: 중앙 등록부를 읽지 못해 503 으로 답했습니다(엣지는 다음 주기에 다시 보냅니다)`);
  return true;
}

// ── 스토리지 · 파트 장애 · 엣지 로그 · 베어메탈 사용률 위임 → routes/central/storageRoutes.js(v2.954 영역별 파일 · 등록 순서 그대로) ──
registerStorageRoutes(centralRouter, { edgeNameKnown, edgeNameRegistered, intervalsPartOrUnreadable, receiveRegistryUnreadable, registryUnreadable, requireCentral, settingsUnreadable, strAgent });
// ── PDU · SAN 스위치 · 원격 명령(RMA) 위임 → routes/central/pduSanRoutes.js(v2.954 영역별 파일 · 등록 순서 그대로) ──
registerPduSanRoutes(centralRouter, { intervalsPartOrUnreadable, loadWhy, persistent503, receiveRegistryUnreadable, registryUnreadable, requireCentral, settingsUnreadable, settingsUnreadableLog, strAgent });
// ── Arista CVP · 아이실론 디렉터리 사용량 위임 → routes/central/cvpIsiduRoutes.js(v2.954 영역별 파일 · 등록 순서 그대로) ──
registerCvpIsiduRoutes(centralRouter, { loadWhy, persistent503, receiveRegistryUnreadable, registryUnreadable, requireCentral, settingsUnreadable, strAgent });
// ── Veeam · Bareos · 핑 · 엣지 설정 · 로그 · 캡처 · VM 백업 · 베어메탈 스토리지 · IP 스캔 · 통신 점검 → routes/central/opsRoutes.js(v2.954 영역별 파일 · 등록 순서 그대로) ──
registerOpsRoutes(centralRouter, { PERSISTENT_503_HEADERS, agentOwnsVcenter, edgeVcWriteDenied, persistent503, registryUnreadable, reqAgentDenied, requireCentral, settingsUnreadable, strAgent });
