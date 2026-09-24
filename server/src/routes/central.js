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

import { Router } from 'express';
import { config, loadVcenterConfig, currentVersion } from '../config.js';
import { instanceId } from '../instanceId.js';
import { getAssignment, setResult, listAssignments as listScanAssignments } from '../central/assignments.js';
import { tokenMatches } from '../util/secureCompare.js';
import { resolveAgentByToken, hasAnyAgentToken, listAgentTokens } from '../central/agentTokens.js';
import { setInventory, getInventory, listInventory } from '../central/inventory.js';
import { noteAgentIdentity, noteVcenterOwner } from '../central/agentIdentity.js';
import { isMockVcenter } from '../mock/generator.js';
import { setEdgeFleet } from '../central/fleet.js';
import { setGuestGpu } from '../gpu/store.js';
import { setGpuGuestDiag } from '../central/gpuGuestDiag.js';
import { takePingJobs, setPingResults } from '../central/pingJobs.js';
import { takeIdracScanJobs, setIdracScanResult, setIdracScanProgress, agentOfReq } from '../central/idracScanJobs.js';
import { pullNow as pullCollectorsNow } from '../collector/puller.js';
import { upsertCollectorFromAgent, ssrfBlockReasonResolved, verifyDerivedCollectorUrl } from '../collector/registry.js';
import { recordIngest, noteInventoryCompression } from '../central/ingestStats.js';
import { recordPull, PULL_UNAUTH_KEY } from '../central/pullStats.js';
// v2.570: 거부된 push 를 기록한다 — 아래 집계는 4xx/5xx 를 빼므로, 그것만으로는 '안 보냈다' 와
//         '보냈는데 막혔다' 가 화면에서 똑같이 보인다(조치가 정반대다).
import { recordReject, REJECT_KIND } from '../central/ingestReject.js';
import { notify } from '../alerts.js';
import { ingestReport } from '../central/svcmonEdge.js';
import { getAssignmentForAgent, markPulled, ackAssignment } from '../central/svcmonAssign.js';
import { setAgentConfig } from '../central/agentConfig.js';
import { getAssignedGpuGuest } from '../central/agentGpuGuestConfig.js';
import { getEffectiveUsers } from '../central/agentUsers.js';
import { takeLogQueries, setLogQueryResult, vcenterOfReq } from '../central/logQueries.js';
import { specToRange } from '../ipam/rangePolicies.js';
import { ipToNum } from '../ipam/ledger.js';
import { takeCaptureJobs, setCaptureResult, captureAgentOfReq } from '../central/captureJobs.js';
import { takeJobsWait as takeRmaJobsWait, setJobResult as setRmaJobResult, jobAgentOf as rmaJobAgentOf, noteHeartbeat as noteRmaHeartbeat, onlineInstances as rmaOnlineInstances } from '../rma/jobs.js';
import { accessFor as rmaAccessFor, ipAllowed as rmaIpAllowed, remoteFor as rmaRemoteFor } from '../rma/settings.js';
import { scheduleFor as rmaScheduleFor, assignForInstance as rmaAssign } from '../rma/schedules.js';
import { ingestResult as rmaIngestResult } from '../rma/testResults.js';
import { commitCollection as commitGuestDisk } from '../guestdisk/db.js';
import { commitVmSeries, setVmSeriesMeta } from '../vmseries/db.js';   // v2.510: 실시간 스파이크 push 수신(vCenter별 독립 DB)
import { loadVmSeriesSettings } from '../vmseries/settings.js';
import { commitCurUser } from '../curuser/db.js';                     // v2.520: '현재 사용자' push 수신
import { load as loadCurUserSettings } from '../curuser/settings.js';
import { recordCurUserActivity } from '../curuser/activityLog.js';
import { load as loadGuestDiskSettings } from '../guestdisk/settings.js';
import { sanitizeGuestDiskVms } from '../guestdisk/analyze.js';
import { brokerFetch as credentialBrokerFetch } from '../security/credentialStore.js';
import { logAudit } from '../audit.js';
import { takeBmstorJobs, ackBmstorJob, bmstorAgentOfReq } from '../bmstor/jobs.js';
import { applyBmstorResults } from '../bmstor/poller.js';
import { recordCapture } from '../net/captureHistory.js';
import { loadScanSettings, mergeScanResults, recordAgentReport } from '../ipam/scanStore.js';
import { putEdgeLinkReport } from '../central/linkCheckEdge.js';   // v2.552: 엣지가 잰 통신 링크 결과 수신
import { buildLinks, publicLink, EDGE_KINDS } from '../linkcheck/links.js';
// ⚠ **redact 된 목록**을 쓴다 — 링크 계산에 필요한 것은 name·url·host 뿐이고, 이 응답은 엣지로
//   나간다(비밀이 섞일 여지를 구조적으로 없앤다).
import { listCollectors as listCollectorsForLinks } from '../collector/registry.js';
import { listRegistry as listVcentersForLinks } from '../vcenter/registry.js';
import { loadLinkCheckSettings, linkCheckEnabled } from '../linkcheck/settings.js';

import { wrapAsyncRouter } from '../util/asyncRoute.js';
import { numOrNull } from '../util/numOrNull.js';   // v2.600 CEN2600-01·RECENT2600-01 — 엣지가 보낸 수치 좁히기
import { createChangeLogger } from '../util/logThrottle.js'; // v2.583: 반복 수신 로그 조절
const gpuRecvLog = createChangeLogger();
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
          ? { vcenterId: String(b.vcenterId || '').slice(0, 128), hosts: (b.hosts || []).length, vms: (b.vms || []).length,
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
  return { ...sharedStats, requireAgentToken: REQUIRE_AGENT_TOKEN, agentTokens: listAgentTokens().length };
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

// 요청이 다루려는 agent 이름(쿼리·헤더·본문 순).
const requestedAgent = (req) => strAgent(req.query?.agent) || strAgent(req.get('X-Agent-Name')) || strAgent(req.body?.agent);

/**
 * v2.600(감사 CEN2600-10): 요청이 주장한 agent 이름은 **글자일 때만** 쓰고 64자로 자른다(v2.591 PR-1 수신 집계와 같은 상한).
 * 예전에는 `String(b.agent || '')` 라 본문 `agent:{toString:'x'}` 하나로 String() 이 던져 공유 토큰 수신이 500 이었다.
 */
function strAgent(v) { return typeof v === 'string' ? v.trim().slice(0, 64) : ''; }

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
export const trimTrailingSlashes = (s) => { let e = s.length; while (e > 0 && s.charCodeAt(e - 1) === 47) e--; return e === s.length ? s : s.slice(0, e); };
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
  const want = requestedAgent(req);
  if (auth.mode === 'agent') {
    // 개별 토큰은 남의 이름으로 조회/보고/등록할 수 없다 — 자격증명 횡탈·데이터 위장 차단.
    // want(쿼리/헤더/본문 agent)와 register-collector 의 body.name 을 **둘 다** 대조한다.
    for (const claim of [want, registerName(req)]) {
      if (claim && claim.toLowerCase() !== String(auth.agent).toLowerCase()) {
        console.warn(`[central] agent 불일치 거부 — 토큰=${auth.agent} 요청=${claim} (${req.method} ${req.path})`);
        return res.status(403).json({ ok: false, reason: `이 토큰은 '${auth.agent}' 전용입니다(요청: '${claim}').` });
      }
    }
  }
  if (auth.mode === 'shared') {
    sharedStats.uses++; sharedStats.lastAt = Date.now();
    sharedStats.lastAgent = want || registerName(req) || '(unknown)'; sharedStats.lastPath = req.path;
  }
  next();
});

function authed(req) { return Boolean(req.centralAuth?.ok); }
// 인증 실패 사유(토큰 불일치 / 공유 토큰 금지)를 그대로 전달해 운영자가 원인을 알 수 있게.
const denyReason = (req) => req.centralAuth?.reason || '토큰 불일치';

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
centralRouter.get('/assignment', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화 (CENTRAL_TOKEN 미설정)' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const a = getAssignment(req.query.agent);
  if (!a || a.enabled === false) return res.json({ ok: true, assigned: false });
  res.json({ ok: true, assigned: true, agent: a.agent, ips: a.ips, username: a.username, password: a.password });
});

// 엣지 자기등록(EDGE_MODE=all): 부팅한 엣지가 자기 이름/포트/수집토큰을 알리면 수집 서버
// 목록에 자동 upsert — 관리자의 '수집 서버 추가' 수동 절차가 필요 없어진다.
// Body: { name, port, collectorToken, datacenter?, urlHint?, version? }
const REGISTER_URL_MAX = 2048;
const REGISTER_TOKEN_MAX = 1024;
centralRouter.post('/register-collector', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화 (CENTRAL_TOKEN 미설정)' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
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
    if (ip.includes(':')) ip = `[${ip}]`; // IPv6
    url = `http://${ip}:${port}`;
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
  const r = upsertCollectorFromAgent({ name, url, token: b.collectorToken, datacenter: regDc });
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
centralRouter.post('/result', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
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
centralRouter.post('/svcmon-report', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
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
centralRouter.post('/capacity-report', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
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
centralRouter.get('/svcmon-config', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  if (req.centralAuth.mode !== 'agent') {
    return res.status(403).json({ ok: false, reason: '이 엔드포인트는 엣지별 개별 토큰만 허용합니다.' });
  }
  const agent = req.centralAuth.agent;
  const r = getAssignmentForAgent(agent, String(req.query.sig || ''));
  if (r.assigned && !r.unchanged) markPulled(agent, r.sig);
  res.json({ ok: true, ...r });
});

/**
 * 엣지 적용 결과 회신 — **이것이 배포 성공 판정의 근거다.**
 * 적용 수가 배포 수와 다르면 중앙이 `mismatch` 로 남기고 그대로 노출한다.
 */
centralRouter.post('/svcmon-config-ack', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
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
  'hwVersion', 'storageType', 'severity', 'message', 'entity', 'entityType', 'status', 'location', 'overallStatus'];
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

function sanitizeInventoryList(list, vcId, max, dropped) {
  const out = [];
  for (const x of Array.isArray(list) ? list.slice(0, max) : []) {
    if (!isPlainObj(x)) { dropped.notObject += 1; continue; }
    if (x.vcenterId != null && String(x.vcenterId) !== vcId) { dropped.otherVcenter += 1; continue; }
    if (x.id != null && typeof x.id !== 'string' && !(typeof x.id === 'number' && Number.isFinite(x.id))) { dropped.badId += 1; continue; }
    const o = { ...x, vcenterId: vcId };
    for (const k of INV_TEXT_KEYS) {
      const v = o[k];
      if (v != null && typeof v === 'object') { o[k] = null; dropped.coerced += 1; }
    }
    out.push(o);
  }
  return out;
}

centralRouter.post('/inventory', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
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
    noteAgentIdentity(agent, { hostname: req.get('X-Agent-Hostname') || '', mock: true, peer: req.socket?.remoteAddress || '' });
    const why = mockByFlag
      ? `엣지가 스스로 mock 임을 알렸습니다(source=${b.source || 'mock'})`
      : `보낸 vCenter '${b.vcenterId}' 가 데모 생성기의 가짜 사이트와 id·이름이 같습니다(DATA_SOURCE=auto 로 접속 실패 시 목 데이터로 폴백했거나, 엣지가 구버전이라 mock 표시를 못 보냅니다)`;
    const reason = `엣지 '${agent}' 가 mock(가짜) 데이터를 보냈습니다 — 저장하지 않습니다. ${why}. 엣지 portal.env 에 DATA_SOURCE=live 를 넣고(auto 는 접속 실패 시 가짜로 채웁니다) vCenter 접속 정보를 확인·재시작하세요.`;
    // v2.570: 이것이 '보냈는데 중앙이 막은' 대표 사례다 — 기록하지 않으면 화면에서 '안 보냄' 과 구분되지 않는다.
    res.locals.ingestReject = { kind: REJECT_KIND.MOCK, reason, vcenterId: String(b.vcenterId || '') };
    return res.status(400).json({ ok: false, reason, mockBlocked: true, by: mockByFlag ? 'flag' : 'content' });
  }
  // v2.428(미스매치 #6/#7): 같은 vcenterId 를 다른 agent 가 번갈아 push 하거나, 같은 agent 이름이 다른 hostname 에서 오면 충돌로 기록.
  noteAgentIdentity(agent, { hostname: req.get('X-Agent-Hostname') || '', mock: false, peer: req.socket?.remoteAddress || '' });
  noteVcenterOwner(String(b.vcenterId), agent, { peer: req.socket?.remoteAddress || '', hostname: req.get('X-Agent-Hostname') || '' });
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
  const slice = {
    vcenter,
    hosts: sanitizeInventoryList(b.hosts, vcId, 50_000, dropped),
    vms: sanitizeInventoryList(b.vms, vcId, 500_000, dropped),
    datastores: sanitizeInventoryList(b.datastores, vcId, 50_000, dropped),
    networks: sanitizeInventoryList(b.networks, vcId, 50_000, dropped),
    alarms: sanitizeInventoryList(b.alarms, vcId, 50_000, dropped),
  };
  const droppedN = dropped.notObject + dropped.otherVcenter + dropped.badId;
  if (droppedN) console.warn(`[central] inventory: agent=${agent} vc=${vcId} 원소 ${droppedN}건 제외(객체 아님 ${dropped.notObject} · 다른 vCenter ${dropped.otherVcenter} · id 형식 ${dropped.badId})`);
  const saved = setInventory(vcId, slice, agent, b.generatedAt || null) || {};
  if (saved.held) console.warn(`[central] inventory: agent=${agent} vc=${vcId} 상태 ${slice.vcenter.status} · 호스트·VM 0 — 마지막 정상 목록을 지우지 않고 상태만 갱신했습니다(엣지가 인벤토리를 읽지 못함)`);
  res.locals.ingestSummary = {
    vcenterId: vcId.slice(0, 128), hosts: slice.hosts.length, vms: slice.vms.length, datastores: slice.datastores.length,
    networks: slice.networks.length, alarms: slice.alarms.length, gzip: (req.get('content-encoding') || '').includes('gzip'),
  };
  res.json({ ok: true, vcenterId: b.vcenterId, hosts: slice.hosts.length, vms: slice.vms.length,
    ...(droppedN || dropped.coerced ? { rejected: droppedN, dropped } : {}), ...(handover ? { ownerHandover: handover } : {}), ...(saved.held ? { held: true } : {}) });
});

// 사이트 위임 게스트 디스크 수신(v2.466) — 엣지가 로컬 vCenter 의 guest.disk 를 수집해 push.
// 중앙은 site 모드 vCenter 에 직접 SOAP 를 못 걸어 게스트 디스크 회수 리포트가 site vCenter 를
// 못 덮던 문제의 수신 절반. /inventory 와 같은 신뢰 경계(개별 토큰 → agent 강제 + TOFU 소유권 +
// mock 차단)를 적용하고, 받은 VM 배열을 sanitize 후 guest-disk.db 에 커밋한다.
// Body: { agent, source, vcenterId, vcenterName, vms:[{vmId,vmName,allocGB,usedGB,partCount,parts[]}], generatedAt }
centralRouter.post('/guest-disk', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
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
  const vms = sanitizeGuestDiskVms(b.vms);
  const vcName = String(b.vcenterName || '').slice(0, 256) || String(b.vcenterId);
  // 시계열 ts 는 중앙 수신시각(단일 권위 시계)을 쓴다 — 엣지 wall-clock(generatedAt)을 그대로
  // 쓰면 NTP 미동기 엣지의 시계 오차가 prune(중앙 Date.now 기준)·신선도와 어긋난다(미래 skew =
  // 영구 미prune 누적, 과거 skew = 방금 받은 추이가 즉시 prune). /inventory 도 generatedAt 을
  // 신선도 메타로만 쓰고 시계열 ts 로는 쓰지 않는다. generatedAt 은 참고용으로만 로그.
  const ts = Date.now();
  const commit = await commitGuestDisk(String(b.vcenterId), vcName, vms, { ts, changeThresholdGB: loadGuestDiskSettings().changeThresholdGB });
  if (!commit || !commit.ok) return res.status(500).json({ ok: false, reason: commit?.reason || 'guest-disk 커밋 실패(DB 사용 불가)' });
  noteVcenterOwner(String(b.vcenterId), agent, { peer: req.socket?.remoteAddress || '', hostname: req.get('X-Agent-Hostname') || '' });
  console.log(`[central] guest-disk 수신: agent=${agent} vc=${b.vcenterId} vms=${vms.length} (series vm=${commit.vmSeriesRows} part=${commit.partSeriesRows})`);
  res.json({ ok: true, vcenterId: b.vcenterId, vms: vms.length, vmSeriesRows: commit.vmSeriesRows, partSeriesRows: commit.partSeriesRows });
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
centralRouter.post('/vmseries', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
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
  noteVcenterOwner(vcId, agent, { peer: req.socket?.remoteAddress || '', hostname: req.get('X-Agent-Hostname') || '' });
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
    });
  }
  return out;
}
centralRouter.post('/curuser', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
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
    for (const vcId of new Set(kept.map((r) => r.vcenterId))) noteVcenterOwner(vcId, agent, { peer: req.socket?.remoteAddress || '', hostname: req.get('X-Agent-Hostname') || '' });
  }
  console.log(`[central] curuser 수신: agent=${agent} chunk=${b.chunk ?? 0}/${b.chunks ?? 1} records=${kept.length}${rejected.size ? ` 거부=${[...rejected].join(',')}` : ''}`);
  res.json({ ok: true, records: kept.length, rejected: [...rejected], replaced: replaceVcenters.length });
});

// '현재 사용자' 설정 배포(v2.520) — 엣지가 주기적으로 GET. 이 엣지가 소유한 vCenter 항목만 내려준다.
centralRouter.get('/curuser-config', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = String(req.centralAuth.agent || req.query.agent || '').trim().toLowerCase();
  const mine = new Set(listInventory().filter((e) => String(e.agent || '').toLowerCase() === agent).map((e) => String(e.vcenterId)));
  const s = loadCurUserSettings();
  const vcenters = Object.fromEntries(Object.entries(s.vcenters || {}).filter(([id]) => mine.has(id)));
  res.json({
    ok: true,
    settings: {
      enabled: s.enabled, intervalMs: s.intervalMs, retentionDays: s.retentionDays,
      concurrency: s.concurrency, vmTimeoutMs: s.vmTimeoutMs, maxVms: s.maxVms,
      guestPublishMs: s.guestPublishMs, staleFactor: s.staleFactor, vcenters,
    },
    vcenters: [...mine],
  });
});

// 실시간 스파이크 수집 설정 배포(v2.510) — 엣지가 주기적으로 GET. 이 엣지가 수집하는(인벤토리 소유)
// vCenter 의 targets 만 내려준다(다른 법인 id 비노출). scope='all' 은 그대로 내려간다.
centralRouter.get('/vmseries-config', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = String(req.centralAuth.agent || req.query.agent || '').trim().toLowerCase();
  const mine = new Set(listInventory().filter((e) => String(e.agent || '').toLowerCase() === agent).map((e) => String(e.vcenterId)));
  const s = loadVmSeriesSettings();
  const targets = Object.fromEntries(Object.entries(s.targets || {}).filter(([id]) => mine.has(id)));
  res.json({ ok: true, settings: { enabled: s.enabled, intervalMin: s.intervalMin, retentionDays: s.retentionDays, thresholds: s.thresholds, scope: s.scope, targets }, vcenters: [...mine] });
});

// 엣지 베어메탈 집계: 현장 포탈이 자기 DC의 베어메탈 목록(전력 미보고 포함)을 push.
// Body: { agent, baremetal:[{fleetId,name,model,serviceTag,watts,vcenterId,source}], generatedAt }
centralRouter.post('/fleet', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  const agent = req.centralAuth.agent || String(b.agent && strAgent(b.agent) || ''); // v2.600 CEN2600-10: 글자일 때만(객체면 String() 이 던졌다)
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  const list = Array.isArray(b.baremetal) ? b.baremetal : [];
  // v2.601(감사 CEN2601-02·03): ① 원소 vcenterId 는 이 엣지가 소유(인벤토리 기준)한 vCenter 에만 귀속한다 — 예전에는 본문 값을
  //   그대로 받아 남의 법인 vCenter 로 베어메탈을 귀속시킬 수 있었다(v2.599 CEN-02 는 /inventory 만 묶었다). 소유하지 않은 id 는
  //   원소를 버리지 않고 **귀속만 비운다**(서버 자체는 실재한다). ② 공유 토큰 + 중앙이 모르는 이름은 '미검증' 이라 이름 수·원소 수를
  //   작게 묶고, 소유를 증명할 길이 없으므로 귀속도 비운다. 뺀·비운 개수는 응답에 싣는다(조용한 상한 금지).
  const verified = req.centralAuth.mode === 'agent' || edgeNameKnown(agent);
  const vcAllowed = verified ? (vc) => agentOwnsVcenter(agent, vc) : () => false;
  const r = setEdgeFleet(agent, list, b.generatedAt || null, { verified, vcAllowed });
  res.json({ ok: true, agent, baremetal: r.accepted, ...(r.omitted ? { omitted: r.omitted } : {}), ...(r.vcenterBlanked ? { vcenterBlanked: r.vcenterBlanked } : {}), ...(verified ? {} : { unverifiedAgent: true }) });
});

/**
 * v2.601(감사 CEN2601-03): 중앙이 **이미 아는** 엣지 이름인가 — 발급 토큰 · 수집 서버 등록부 · 위임 인벤토리 소유 · 스캔 배정.
 * 공유 토큰은 본문 agent 를 마음대로 고를 수 있으므로, 여기 없는 이름은 '미검증' 으로 다룬다(5초 캐시 — 푸시마다 파일을 읽지 않게).
 * ⚠ knownAgentNames() 를 쓰지 않는다 — 그 합집합은 스캔 결과·설정 pull 처럼 **공유 토큰이 이름을 만들어 넣을 수 있는 소스**를 포함한다.
 */
let _knownNames = { at: 0, set: null };
function edgeNameKnown(name) {
  const now = Date.now();
  if (!_knownNames.set || now - _knownNames.at > 5_000) {
    const set = new Set();
    const add = (v) => { if (typeof v === 'string' && v.trim()) set.add(v.trim().toLowerCase()); };
    try { for (const t of listAgentTokens()) add(t.agent); } catch { /* 소스 미초기화 */ }
    try { for (const c of listCollectorsForLinks()) { add(c.id); add(c.name); } } catch { /* */ }
    try { for (const x of listInventory()) add(x.agent); } catch { /* */ }
    try { for (const x of listScanAssignments()) add(x.agent); } catch { /* */ }
    _knownNames = { at: now, set };
  }
  return _knownNames.set.has(String(name || '').trim().toLowerCase());
}

// 위임 iDRAC 스캔: 에이전트가 자기 이름의 온디맨드 스캔 잡을 인출.
centralRouter.get('/idrac-scan-jobs', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  res.json({ ok: true, jobs: takeIdracScanJobs(req.query.agent) });
});

// 위임 iDRAC 스캔: 에이전트가 스캔 진행률(중간)을 보고. Body: { reqId, scanned, total }
centralRouter.post('/idrac-scan-progress', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  if (reqAgentDenied(req, agentOfReq(String(b.reqId)))) return res.status(403).json({ ok: false, reason: '이 reqId 는 요청 에이전트의 잡이 아닙니다.' });
  setIdracScanProgress(String(b.reqId), b);
  res.json({ ok: true });
});

// 위임 iDRAC 스캔: 에이전트가 발견 목록·요약을 reqId와 함께 회신.
// Body: { agent, reqId, scanned, found:[...], unreachable, notIdrac, authFailed, registered, error? }
centralRouter.post('/idrac-scan-result', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  if (reqAgentDenied(req, agentOfReq(String(b.reqId)))) return res.status(403).json({ ok: false, reason: '이 reqId 는 요청 에이전트의 잡이 아닙니다.' });
  setIdracScanResult(String(b.reqId), b);
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
  if (x.utilNA === true) out.utilNA = true;
  for (const k of ['host', 'vcenterId', 'name']) if (x[k] != null) out[k] = typeof x[k] === 'string' ? x[k].slice(0, 256) : (typeof x[k] === 'number' && Number.isFinite(x[k]) ? String(x[k]) : null);
  return out;
}

// 게스트 GPU 수집 위임: ESXi 망에 닿는 현장 agent가 게스트 OS(nvidia-smi)에서 수집한
// GPU 사용률을 push. 중앙은 포탈이 ESXi에 직접 못 가는 환경에서 이 값을 오버레이로 사용.
// Body: { agent, hosts:[{hostId,utilPct}], vms:[{vmId,utilPct,memUsedPct,host,vcenterId}] }
centralRouter.post('/gpu-guest-data', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
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
  setGuestGpu({ hosts, vms, agent });
  if (b.diag) setGpuGuestDiag(agent, b.diag, { hosts: hosts.length, vms: vms.length }); // 수집 진단 보관
  // v2.583: 엣지마다 인벤토리 주기로 찍혀 저널을 덮었다(28곳 × 60초 ≈ 하루 4만 줄) — 값이 바뀔 때와
  //   1시간마다만 찍는다(util/logThrottle.js). 문구 형식은 그대로다(로그 분석 규칙이 이 형식을 읽는다).
  if (gpuRecvLog(agent, `${hosts.length}/${vms.length}`)) console.log(`[central] gpu-guest-data 수신: agent=${agent} hosts=${hosts.length} vms=${vms.length}`);
  res.json({ ok: true, agent, hosts: hosts.length, vms: vms.length });
});

// 중앙→엣지 GPU 게스트 설정 배포(pull): 엣지가 자기 이름으로 배포 설정을 가져가 로컬 적용.
// 폐쇄망/NAT 엣지도 아웃바운드 GET만으로 동작. 비밀번호 포함(엣지가 실제 인증에 사용) → 토큰 필수.
// GET /api/central/gpu-guest-config?agent=<이름>
centralRouter.get('/gpu-guest-config', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = String(req.query.agent || req.get('X-Agent-Name') || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  const settings = getAssignedGpuGuest(agent);
  if (!settings) return res.json({ ok: true, agent, assigned: false }); // 지정 없음 → 엣지는 로컬 설정 유지
  const { _updatedAt, ...s } = settings;
  res.json({ ok: true, agent, assigned: true, at: _updatedAt || 0, settings: s });
});

// 중앙→엣지 배포 사용자(pull): 엣지가 자기 이름으로 '중앙이 지정한 사용자 목록'을 가져가 로컬
// users.json에 managed로 반영. 비밀번호 해시 포함(엣지가 로그인 검증에 사용) → 토큰 필수.
// ── 스토리지 모니터링 위임(v2.302) ────────────────────────────────────────────
// GET /api/central/storage-config?agent=<이름> — 이 엣지 몫 스토리지 장비 목록(자격증명 포함:
// 엣지가 장비에 로그인해야 한다 — gpu-guest-config 의 계정 배포와 같은 신뢰 경계·WAN TLS 검증 ON).
// 개별 토큰이면 바인딩된 agent 와 요청 agent 불일치를 거부(자격증명 횡탈 차단 — 헤더 규약 2).
centralRouter.get('/storage-config', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = String(req.query.agent || req.get('X-Agent-Name') || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  if (req.centralAuth?.mode === 'agent' && String(req.centralAuth.agent).toLowerCase() !== agent.toLowerCase()) {
    return res.status(403).json({ ok: false, reason: '토큰의 agent 와 요청 agent 불일치' });
  }
  const { devicesForAgent } = await import('../storage/registry.js');
  // collectNow(v2.316): 중앙 UI 의 '수집' 클릭이 남긴 재수집 요청을 one-shot 으로 서빙 —
  // 엣지는 이 목록을 즉시 수집 + 즉시 push 한다(agent/storageConfigPull.js 참조).
  const { takeRequestsForAgent } = await import('../storage/collectRequests.js');
  // intervals(v2.409): 중앙이 이 엣지에 지정한 수집 주기(전역 위에 엣지별 덮어쓰기). **지정한 키만**
  // 내려간다 — 전 키를 채워 보내면 엣지 portal.env 의 현장 설정을 통째로 덮어쓴다(intervals.js 계약).
  const { intervalsForAgent } = await import('../storage/intervals.js');
  res.json({
    ok: true, agent, devices: devicesForAgent(agent), collectNow: takeRequestsForAgent(agent),
    intervals: intervalsForAgent(agent),
  });
});

// POST /api/central/part-faults — 엣지가 **로컬에서 판정한 파트 장애만** 올린다(v2.547).
// 사용자 지시: "엣지에서 수집해서 로컬에서 처리하고 장애만 중앙으로 보내게 해줘".
// ⚠ 본문은 `{open[], scanned, deviceOk}` 이고 **open 이 0건이어도 받는다** — 요약이 있어야
//   중앙이 '정상' 과 '수집 안 됨' 을 구분한다(v2.517 규약. `storage/push.js:30` 의 미수정 결함
//   — 장비 0대면 POST 자체를 안 하는 것 — 을 이 경로는 반복하지 않는다).
// ⚠ BIG_JSON 등록 필수(index.js) — 열린 장애가 많은 법인이 413 으로 **조용히 전량 소실**된다.
centralRouter.post('/part-faults', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  // 개별 토큰이면 **인증된 agent** 만 쓴다(body.agent 를 믿지 않는다 — 자격증명 횡탈 차단).
  const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : strAgent(req.body?.agent);
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  const { putEdgeReport } = await import('../central/partFaultEdge.js');
  // v2.548: 프로토콜 2(장애 + 전체 요약) — 수신이 스토리지·SAN 소유권을 검사하고(rejected) agent 를 덮어쓴다.
  // 수신 예외는 400 으로 답한다 — async 핸들러의 throw 는 express 4 가 잡지 않아 요청이 **응답 없이 매달린다**(v2.548 S1).
  let r;
  try { r = await putEdgeReport(agent, req.body || {}); } catch (e) {
    return res.status(400).json({ ok: false, reason: `본문 형식 오류: ${String(e?.message || e).slice(0, 200)}` });
  }
  if (!r.ok) return res.status(400).json(r);
  // 응답에 중앙의 스위치 상태를 실어 보낸다 — 엣지가 '보냈는데 중앙이 꺼져 있다' 를 알 수 있게.
  const { partFaultEnabled } = await import('../partfault/settings.js');
  return res.json({ ok: true, agent, protocol: r.protocol, devices: r.devices, rejected: r.rejected, open: r.open, centralEnabled: partFaultEnabled().enabled });
});

/**
 * 엣지 로그 폴백 큐(v2.549) — 중앙이 그 엣지에 **닿지 못할 때만** 쓰인다.
 * 엣지가 대기 요청을 인출(claim)하고 결과를 회신(ack)한다. 미들웨어가 이미 `?agent=` 와 토큰의
 * agent 일치를 강제하므로(개별 토큰), 여기서는 그 값을 그대로 쓴다.
 */
centralRouter.get('/edge-log-jobs', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = String(req.centralAuth.agent || req.query.agent || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  const { takeEdgeLogJob } = await import('../central/edgeLogJobs.js');
  res.json({ ok: true, job: takeEdgeLogJob(agent) });
});

centralRouter.post('/edge-log-result', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  // ⚠ 저장 키는 **인증된 agent** 다 — 본문의 `node.agent` 를 믿지 않는다(v2.548 F5 와 같은 규칙).
  const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : (strAgent(req.body?.agent) || strAgent(req.query?.agent));
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  try {
    const [{ putEdgeLog }, { ackEdgeLogJob }] = await Promise.all([
      import('../central/edgeLogStore.js'), import('../central/edgeLogJobs.js'),
    ]);
    // ⚠ v2.602(감사 CEN2602-02): 공유 토큰은 본문 agent 를 마음대로 고를 수 있다 — 예전에는 그 이름으로 **다른 엣지의
    //   보관분을 덮었다**. 공유 토큰 회신은 ① 중앙이 아는 이름(edgeNameKnown)이고 ② 중앙이 실제로 그 엣지에 요청해 둔
    //   작업(acked)일 때만 저장한다. 개별 토큰은 인증된 이름이므로 예전대로(요청 없는 회신도 버리지 않고 밝힌다).
    const shared = req.centralAuth?.mode !== 'agent';
    if (shared && !edgeNameKnown(agent)) return res.status(403).json({ ok: false, reason: `중앙이 모르는 엣지 이름(${agent}) — 공유 토큰 회신은 등록된 엣지 이름만 받습니다.`, unverifiedAgent: true });
    const { acked } = ackEdgeLogJob(agent);
    if (shared && !acked) return res.json({ ok: true, agent, stored: false, acked, reason: '요청한 적 없는 공유 토큰 회신은 보관하지 않습니다(다른 엣지 보관분을 덮지 못하게).' });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const rec = putEdgeLog(agent, { ...body, via: 'job', ok: true });
    // `acked:false` 는 '요청한 적 없는 회신'(기한 초과로 회수됐거나 중앙이 재시작) — 버리지 않고 밝힌다.
    res.json({ ok: true, agent, stored: !!rec, acked });
  } catch (e) {
    // async throw 는 express 4 가 잡지 않아 요청이 응답 없이 매달린다(v2.548 S1).
    res.status(400).json({ ok: false, reason: `본문 형식 오류: ${String(e?.message || e).slice(0, 200)}` });
  }
});

// 파트 장애 스위치 배포(v2.548 F3) — 엣지가 주기적으로 GET. 중앙 관리자가 전체/엣지별로 정한 값만 내려간다.
centralRouter.get('/partfault-config', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = String(req.centralAuth.agent || req.query.agent || '').trim().toLowerCase();
  const { settingsForAgent } = await import('../partfault/settings.js');
  res.json({ ok: true, settings: settingsForAgent(agent) });
});

// POST /api/central/storage-data — 엣지 수집 스냅샷 수신. 저장 키는 body.agent 가 아니라
// **인증된 agent**(개별 토큰 바인딩)만 쓴다. 공유 토큰(레거시)은 body.agent 신뢰(TOFU — 기존 축과 동일).
centralRouter.post('/storage-data', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : strAgent(req.body?.agent);
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  const { saveEdgeStorage, saveEdgeStorageStatus } = await import('../central/storageEdge.js');
  // v2.581(BUG-D): 상태 전용 보고(엣지가 0대일 때) — 장비 목록은 건드리지 않고 상태만 기록한다.
  if (req.body?.statusOnly === true) {
    const saved = saveEdgeStorageStatus(agent, req.body?.status);
    return res.json({ ok: true, saved: 0, statusOnly: true, recorded: saved });
  }
  // 소유권 필터(v2.417, sanswitch-data 와 동일): 개별 토큰 엣지는 자기에게 위임된 deviceId 만,
  // collectedAt 은 수신 시각으로 clamp. 공유 토큰(레거시)은 기존 신뢰 유지.
  let devices = Array.isArray(req.body?.devices) ? req.body.devices : [];
  let notOwned = 0; // v2.601 EDGE2601-04: 소유권 필터로 뺀 수도 응답에 싣는다(엣지가 상태·콘솔에 남긴다)
  const now = Date.now();
  devices = devices.map((d) => (d && typeof d === 'object' ? { ...d, collectedAt: Math.min(Number(d.collectedAt) || now, now) } : d));
  if (req.centralAuth.mode === 'agent') {
    const { devicesForAgent } = await import('../storage/registry.js');
    const owned = new Set(devicesForAgent(agent).map((d) => d.id));
    const before = devices.length;
    devices = devices.filter((d) => d && owned.has(d.deviceId));
    notOwned = before - devices.length;
    if (notOwned) console.warn(`[central] storage-data: ${agent} 미위임 deviceId ${notOwned}건 드롭(위조 방지)`);
  }
  // v2.599(CEN-2599-03·04·05): 모듈이 원소를 정리하고(객체 아님·식별자 아님·크기 초과를 빼고 표시 필드의 객체 값은 null)
  //   뺀 개수를 info 에 싣는다 — 응답이 그 사실을 말한다(조용한 제외 금지).
  const info = {};
  const saved = saveEdgeStorage(agent, devices, info);
  if (info.refused) return res.status(429).json({ ok: false, refused: true, reason: '중앙이 보관하는 엣지 수 상한에 닿았습니다(최근 보고한 엣지는 밀어내지 않습니다).' });
  res.json({ ok: true, saved, ...(edgeDropSummary(withNotOwned(info, notOwned))) });
});

/** v2.601(감사 EDGE2601-04): 소유권 필터로 뺀 수를 dropped.notOwned 로 합친다(원 객체는 바꾸지 않는다). */
function withNotOwned(info, notOwned) {
  if (!notOwned) return info;
  return { ...(info || {}), dropped: { ...((info && info.dropped) || {}), notOwned } };
}

/** v2.599: 엣지 장비 수신 정리 결과를 응답 필드로(뺀 것이 없으면 빈 객체). */
function edgeDropSummary(info) {
  const d = info?.dropped || {};
  const n = Object.values(d).reduce((a, x) => a + (Number(x) || 0), 0);
  return {
    ...(n ? { rejected: n, dropped: d } : {}),
    ...(info?.coerced ? { coerced: info.coerced } : {}),
    ...(info?.evicted ? { evicted: info.evicted } : {}),
    ...(info?.trimmed ? { zoningTrimmed: info.trimmed } : {}),   // v2.600 RECENT2600-02 — 조닝을 잘라 받은 장비 수(버린 것 아님)
  };
}

// ── PDU 모니터링 위임(v2.424) — 스토리지 위임과 완전히 같은 규약 ────────────────
// GET /api/central/pdu-config?agent=<이름> — 이 엣지 몫 PDU 목록(자격증명 포함: 엣지가 PDU 에
// SSH 로그인해야 한다). 개별 토큰이면 바인딩된 agent 와 요청 agent 불일치를 거부(자격증명 횡탈 차단).
centralRouter.get('/pdu-config', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = String(req.query.agent || req.get('X-Agent-Name') || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  if (req.centralAuth?.mode === 'agent' && String(req.centralAuth.agent).toLowerCase() !== agent.toLowerCase()) {
    return res.status(403).json({ ok: false, reason: '토큰의 agent 와 요청 agent 불일치' });
  }
  const { devicesForAgent } = await import('../pdu/registry.js');
  const { takeRequestsForAgent } = await import('../pdu/collectRequests.js');
  // intervals: **지정한 키만** 내려간다 — 전 키를 채우면 엣지 portal.env 의 현장 설정을 덮어쓴다.
  const { intervalsForEdge } = await import('../pdu/intervals.js');
  res.json({
    ok: true, agent, devices: devicesForAgent(agent), collectNow: takeRequestsForAgent(agent),
    intervals: intervalsForEdge(),
  });
});

// POST /api/central/pdu-data — 엣지 수집 스냅샷 수신. 저장 키는 body.agent 가 아니라
// **인증된 agent**(개별 토큰 바인딩)만 쓴다. 미위임 장비 id 는 드롭(위조 방지).
centralRouter.post('/pdu-data', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : strAgent(req.body?.agent);
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  const { saveEdgePdu } = await import('../central/pduEdge.js');
  let snapshots = Array.isArray(req.body?.snapshots) ? req.body.snapshots : [];
  let notOwned = 0; // v2.601 EDGE2601-04
  const now = Date.now();
  snapshots = snapshots.map((s) => (s && typeof s === 'object' ? { ...s, collectedAt: Math.min(Number(s.collectedAt) || now, now) } : s));
  if (req.centralAuth.mode === 'agent') {
    const { devicesForAgent } = await import('../pdu/registry.js');
    const owned = new Set(devicesForAgent(agent).map((d) => d.id));
    const before = snapshots.length;
    snapshots = snapshots.filter((s) => s && owned.has(s.id));
    notOwned = before - snapshots.length;
    if (notOwned) console.warn(`[central] pdu-data: ${agent} 미위임 id ${notOwned}건 드롭(위조 방지)`);
  }
  const r = saveEdgePdu(agent, snapshots);
  if (r?.refused) return res.status(429).json({ ok: false, refused: true, reason: r.reason });
  // ⚠ 예전에는 결과 객체 전체를 saved 에 담았다({ok,count}). 하위호환으로 그 모양을 유지하고 뺀 개수를 옆에 싣는다.
  res.json({ ok: true, saved: r, ...(edgeDropSummary(withNotOwned(r, notOwned))) });
});

// ── SAN 스위치 모니터링 위임(v2.410) — 스토리지 위임과 완전히 같은 규약 ──────────
// GET /api/central/sanswitch-config?agent=<이름> — 이 엣지 몫 스위치 목록(자격증명 포함:
// 엣지가 스위치에 SSH/REST 로그인해야 한다). 개별 토큰이면 바인딩 agent 불일치를 거부.
centralRouter.get('/sanswitch-config', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = String(req.query.agent || req.get('X-Agent-Name') || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  if (req.centralAuth?.mode === 'agent' && String(req.centralAuth.agent).toLowerCase() !== agent.toLowerCase()) {
    return res.status(403).json({ ok: false, reason: '토큰의 agent 와 요청 agent 불일치' });
  }
  const { devicesForAgent } = await import('../sanswitch/registry.js');
  const { takeRequestsForAgent, takePerfRequestForAgent } = await import('../sanswitch/collectRequests.js');
  const { takeTestRequestsForAgent } = await import('../sanswitch/testRuns.js');
  const { loadPerfSettings } = await import('../sanswitch/perfSettings.js');
  // testNow(v2.421): 중앙 등록 화면의 '연결 테스트' 를 이 엣지가 현지에서 대행(비밀번호 포함 — 엣지가 로그인해야 한다).
  // perf(v2.423): 중앙의 포트 사용량 수집 설정(켜짐/주기/표본/보관)을 위임 스위치에도 적용 — 엣지가 현지 수집 후 중앙으로 중계.
  // perfCollectNow(v2.517): 중앙의 '지금 수집'(포트 사용량)을 이 엣지가 현지에서 대행 — 엣지 단위
  // one-shot 플래그다(엣지의 pollPerfOnce 는 자기 몫 전체를 한 주기에 수집한다).
  res.json({ ok: true, agent, devices: devicesForAgent(agent), collectNow: takeRequestsForAgent(agent), testNow: takeTestRequestsForAgent(agent), perf: loadPerfSettings(), perfCollectNow: takePerfRequestForAgent(agent) });
});

/**
 * POST /api/central/sanswitch-perf — 엣지가 현지 수집한 portperfshow 시계열 중계 수신(v2.423).
 * body { agent, chunk, chunks, rows:[[deviceId, ts, port, bytesPerSec]...], meta:[[deviceId, port, ts, name, wwn, speed, type]...] }
 * 소유권(sanswitch-data 와 동일): 개별 토큰 엣지는 자기에게 위임된 deviceId 만 — 남의 스위치 시계열 위조 차단.
 * ts 는 수신 시각으로 clamp(미래 시각이 '최신' 판정을 항상 이기는 것 방지). 적재는 perfDb.importSamples(트랜잭션·중복 건너뜀).
 */
centralRouter.post('/sanswitch-perf', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : strAgent(req.body?.agent);
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  const { devicesForAgent } = await import('../sanswitch/registry.js');
  const { importSamples } = await import('../sanswitch/perfDb.js');
  const { loadPerfSettings } = await import('../sanswitch/perfSettings.js');
  const { saveEdgePerfStatus } = await import('../central/sanSwitchPerfEdge.js');
  const ownedDevices = devicesForAgent(agent);
  const owned = new Set(ownedDevices.map((d) => String(d.id)));
  const now = Date.now();
  const rowsIn = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 100_000) : [];
  const metaIn = Array.isArray(req.body?.meta) ? req.body.meta.slice(0, 20_000) : [];
  const rows = rowsIn.filter((r) => Array.isArray(r) && owned.has(String(r[0]))).map((r) => ({ d: String(r[0]), ts: Math.min(Number(r[1]) || now, now), p: Number(r[2]), b: Number(r[3]) }));
  const meta = metaIn.filter((m) => Array.isArray(m) && owned.has(String(m[0]))).map((m) => ({ d: String(m[0]), p: Number(m[1]), ts: Math.min(Number(m[2]) || now, now), name: m[3], wwn: m[4], speed: m[5], type: m[6] }));
  const dropped = rowsIn.length - rows.length;
  if (dropped > 0) console.warn(`[central] sanswitch-perf: ${agent} 미위임 deviceId 표본 ${dropped}건 드롭(위조 방지)`);
  const r = await importSamples(rows, meta, loadPerfSettings().retentionDays);
  /**
   * v2.517: 엣지의 **수집 상태**를 함께 받는다(청크 0 에만 실린다). 표본이 0건이어도 엣지가 상태
   * 전용 하트비트를 올리므로, 중앙이 '엣지가 켜졌는지·돌았는지·왜 실패하는지' 를 알 수 있다 —
   * 예전에는 표본이 없으면 아무것도 오지 않아 중앙 화면이 '설정에서 켜세요' 한 문구로 전부를 덮었다.
   * 소유권은 시계열과 같은 규약(위임된 deviceId 만).
   */
  let statusSaved = 0;
  if (req.body?.status && typeof req.body.status === 'object') {
    try {
      const names = new Map(ownedDevices.map((d) => [String(d.id), d.name || d.host || d.id]));
      statusSaved = saveEdgePerfStatus(agent, req.body.status, { owned, names }).saved;
    } catch (e) { console.warn(`[central] sanswitch-perf 상태 저장 실패(${agent}): ${e.message}`); }
  }
  res.json({ ok: true, ...r, dropped, statusSaved });
});

// POST /api/central/sanswitch-test-result — 엣지가 대행한 연결 테스트 결과(추적 로그 포함) 회신(v2.421).
// 개별 토큰이면 바인딩 agent 만, 공유 토큰은 body.agent — 어느 쪽이든 그 요청의 대상 엣지와 같아야 한다.
centralRouter.post('/sanswitch-test-result', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : strAgent(req.body?.agent);
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  const { completeTestRun } = await import('../sanswitch/testRuns.js');
  const r = completeTestRun(String(req.body?.id || ''), agent, req.body?.result);
  if (!r.ok) return res.status(404).json(r);
  res.json({ ok: true });
});

// POST /api/central/sanswitch-data — 엣지 수집 스냅샷 수신. 저장 키는 body.agent 가 아니라
// **인증된 agent**(개별 토큰 바인딩)만 쓴다. 공유 토큰(레거시)은 body.agent 신뢰(기존 축과 동일).
/**
 * RMA 원격 명령(v2.416) — 엣지의 별도 프로세스(rma/agent.js)가 자기 잡을 롱폴 인출(claim)하고
 * 결과를 회신(ack)한다. **개별 토큰 전용**(svcmon-report 3규약: agent 모드 필수 · 키는
 * req.centralAuth.agent 만 · X-Agent-Name 이중 방어). 공유 CENTRAL_TOKEN 으로는 어느 엣지가
 * 명령을 가져가는지 신뢰할 수 없고, 원격 명령은 자격증명보다 더 큰 권한이라 예외를 두지 않는다.
 * Body: { agent, instance, info:{hostname,version,os,pid,uptimeSec,priority,allowCustom,signed,busy}, wait }
 * instance = 같은 법인의 여러 RMA 프로세스 구별자(분배는 rma/jobs.js). 형식 검증 후 그대로 키로 쓴다.
 */
centralRouter.post('/rma-poll', async (req, res) => {
  res.locals.perfExpectSlow = true; // v2.498: 롱폴(최대 55초 대기)은 정상이다 — '느린 요청' 목록을 이걸로 채우지 않는다
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  if (req.centralAuth.mode !== 'agent') {
    return res.status(403).json({ ok: false, reason: '원격 명령(RMA)은 엣지별 개별 토큰만 허용합니다 — 설정 › 엣지 토큰에서 이 엣지의 토큰을 발급해 portal.env 의 EDGE_TOKEN/CENTRAL_TOKEN 에 넣으세요.' });
  }
  const agent = req.centralAuth.agent;
  const b = req.body || {};
  const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  // 접속 허용 IP(v2.418, HostMonitor 'Accept connections from…' 대응) — 법인별 목록이 있으면 그 밖의 출처는 거부.
  const access = rmaAccessFor(agent);
  if (!rmaIpAllowed(ip, access.allowedIps)) {
    console.warn(`[central] rma-poll: ${agent} 허용되지 않은 출처 IP ${ip} 거부`);
    return res.status(403).json({ ok: false, reason: `이 법인의 RMA 접속 허용 IP 목록에 없는 출처(${ip})입니다 — 설정 › 원격 명령 › 접속 허용 IP 를 확인하세요.` });
  }
  const instance = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(b.instance || '')) ? String(b.instance) : 'default';
  noteRmaHeartbeat(agent, instance, b.info || {}, { ip });
  // 점검 결과 동봉(outbox) — 이 법인의 스케줄에 있는 항목만 반영(남의 항목 id 로 상태 위조 차단).
  const sch = rmaScheduleFor(agent);
  const known = new Set(sch.tests.map((t) => t.id));
  const nameOf = new Map(sch.tests.map((t) => [t.id, t.name || '']));
  const results = Array.isArray(b.results) ? b.results.slice(0, 500) : [];
  let accepted = 0;
  for (const r of results) {
    if (!r || !known.has(String(r.id))) continue;
    try { await rmaIngestResult(agent, { ...r, instance }, { name: nameOf.get(String(r.id)) }); accepted++; } catch { /* */ }
  }
  const wait = Math.min(55_000, Math.max(0, Number(b.wait) || 0));
  // v2.428(미스매치 #11): 롱폴 대기 중 클라이언트(HAProxy 타임아웃 등)가 끊기면 깨어나도 claim 하지 않는다 — 예전에는 응답을
  // 버리면서 잡을 claim(MAX_CLAIMS=1)해 실행되지 않은 명령이 '미회신'으로 종결됐다.
  let gone = false;
  // ⚠ req.on('close') 는 본문을 다 읽으면 소켓이 살아 있어도 발생한다(Node 16+) — 응답 객체의 close(연결 종료) + writableFinished 로 판정.
  res.on('close', () => { if (!res.writableFinished) gone = true; });
  const jobs = await takeRmaJobsWait(agent, instance, wait, { isAlive: () => !gone });
  if (gone) return; // 소켓이 이미 닫혔다 — 응답 불가
  const out = { ok: true, jobs, accepted };
  // 스케줄 배포 — 엣지가 보고한 버전과 다를 때만(인스턴스별로 나눠 배정). 배정은 온라인 인스턴스 집합에
  // 결정적이라, 인스턴스가 늘거나 줄면 다음 폴에서 다시 내려간다(버전은 같아도 배정이 달라질 수 있어
  // 배정 서명(assignKey)을 함께 비교).
  const assign = rmaAssign(sch, instance, rmaOnlineInstances(agent));
  const assignKey = `${sch.version}:${assign.tests.map((t) => t.id).join(',')}`;
  if (String(b.assignKey || '') !== assignKey || Number(b.scheduleVersion) !== sch.version) out.schedule = { version: sch.version, assignKey, tests: assign.tests };
  const remote = rmaRemoteFor(agent);
  if (remote.longpollMs || remote.testConcurrency || remote.disabledTests.length) out.config = remote;
  res.json(out);
});
/**
 * 통합 계정 브로커(v2.419) — RMA 가 SSH 실행 직전에 계정(비밀 포함)을 받아 간다. **개별 토큰 전용** +
 * 계정의 법인/대상 호스트 범위 검사(credentialStore) + 법인당 분당 상한 + 감사로그(비밀 미기재).
 * Body: { credentialId, host }
 */
const credRate = new Map(); // agentLower → { winStart, n }
const CRED_RATE_PER_MIN = Math.max(10, Number(process.env.RMA_CRED_RATE_PER_MIN) || 120);
centralRouter.post('/rma-credential', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  if (req.centralAuth.mode !== 'agent') return res.status(403).json({ ok: false, reason: '계정 브로커는 엣지별 개별 토큰만 허용합니다.' });
  const agent = req.centralAuth.agent;
  const b = req.body || {};
  const id = String(b.credentialId || ''), host = String(b.host || '').trim();
  if (!/^cred_[A-Za-z0-9_]{1,64}$/.test(id) || !/^[A-Za-z0-9][A-Za-z0-9.:-]{0,253}$/.test(host)) return res.status(400).json({ ok: false, reason: 'credentialId/host 형식 오류' });
  const k = String(agent).toLowerCase(); const now = Date.now();
  const rl = credRate.get(k) || { winStart: now, n: 0 };
  if (now - rl.winStart > 60_000) { rl.winStart = now; rl.n = 0; }
  if (++rl.n > CRED_RATE_PER_MIN) { credRate.set(k, rl); return res.status(429).json({ ok: false, reason: '계정 인출 요청이 너무 잦습니다(분당 상한).' }); }
  credRate.set(k, rl);
  const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const r = credentialBrokerFetch(id, { agent, host });
  logAudit({ user: `rma:${agent}`, action: r.ok ? 'RMA 계정 브로커 인출' : 'RMA 계정 브로커 거부', target: r.ok ? r.name : id, detail: `→ ${host}${b.instance ? ` (인스턴스 ${String(b.instance).slice(0, 64)})` : ''}${r.ok ? '' : ` — ${r.reason}`}`, ip });
  if (!r.ok) return res.status(403).json({ ok: false, reason: r.reason });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, name: r.name, secret: r.secret });
});

// Body: { reqId, result }
centralRouter.post('/rma-result', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  if (req.centralAuth.mode !== 'agent') return res.status(403).json({ ok: false, reason: '원격 명령(RMA)은 엣지별 개별 토큰만 허용합니다.' });
  const b = req.body || {};
  if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  const owner = rmaJobAgentOf(String(b.reqId));
  if (!owner) return res.json({ ok: true, stale: true });
  if (owner.toLowerCase() !== String(req.centralAuth.agent).toLowerCase()) return res.status(403).json({ ok: false, reason: '이 reqId 는 요청 에이전트의 잡이 아닙니다.' });
  const stored = setRmaJobResult(String(b.reqId), b.result);
  res.json({ ok: true, stale: !stored });
});

centralRouter.post('/sanswitch-data', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = req.centralAuth?.mode === 'agent' ? req.centralAuth.agent : strAgent(req.body?.agent);
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  const { saveEdgeSanSwitch } = await import('../central/sanSwitchEdge.js');
  // 소유권 필터(v2.416 감사 L-1): 개별 토큰 엣지는 **자기에게 위임된 deviceId** 만 올릴 수 있다 — 남의
  // 스위치 id 로 '정상' 스냅샷을 밀어 실제 장애를 가리는 위조 차단. collectedAt 도 수신 시각으로 clamp
  // (미래 시각으로 '최신 우선' 병합을 항상 이기는 것 방지). 공유 토큰(레거시)은 기존 신뢰 유지.
  let devices = Array.isArray(req.body?.devices) ? req.body.devices : [];
  let sanNotOwned = 0; // v2.601 EDGE2601-04
  const now = Date.now();
  devices = devices.map((d) => (d && typeof d === 'object' ? { ...d, collectedAt: Math.min(Number(d.collectedAt) || now, now) } : d));
  if (req.centralAuth.mode === 'agent') {
    const { devicesForAgent } = await import('../sanswitch/registry.js');
    const owned = new Set(devicesForAgent(agent).map((d) => d.id));
    const before = devices.length;
    devices = devices.filter((d) => d && owned.has(d.deviceId));
    sanNotOwned = before - devices.length;
    if (sanNotOwned) console.warn(`[central] sanswitch-data: ${agent} 미위임 deviceId ${sanNotOwned}건 드롭(위조 방지)`);
  }
  const chunk = Math.max(0, Number(req.body?.chunk) || 0), chunks = Math.max(1, Number(req.body?.chunks) || 1);
  const info = {};
  const saved = saveEdgeSanSwitch(agent, devices, { chunk, chunks, info });
  if (info.refused) return res.status(429).json({ ok: false, refused: true, reason: '중앙이 보관하는 엣지 수 상한에 닿았습니다(최근 보고한 엣지는 밀어내지 않습니다).' });
  res.json({ ok: true, saved, ...(edgeDropSummary(withNotOwned(info, sanNotOwned))) });
});

// GET /api/central/users-config?agent=<이름>
centralRouter.get('/users-config', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const agent = String(req.query.agent || req.get('X-Agent-Name') || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  // 글로벌('*') 공통 사용자 + 이 엣지 전용을 합쳐서 반환(개별이 글로벌보다 우선).
  res.json({ ok: true, agent, users: getEffectiveUsers(agent) });
});

// 위임 Ping: 현장 에이전트가 자기 담당 vCenter들의 대기 IP를 인출 → ping → 결과 보고.
// 중앙이 VM 사설 IP에 직접 못 가는 환경에서, 그 망에 닿는 에이전트가 ping을 대행.
centralRouter.get('/ping-jobs', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  let vcs = String(req.query.vcenters || '').split(',').map((s) => s.trim()).filter(Boolean);
  // 개별 토큰은 자기가 소유한 vCenter 의 대기 ping 작업만 인출(남의 사이트 대상 IP 목록 가로채기 차단).
  if (req.centralAuth.mode === 'agent') vcs = vcs.filter((vc) => agentOwnsVcenter(req.centralAuth.agent, vc));
  res.json({ ok: true, jobs: takePingJobs(vcs) });
});

// Body: { vcenterId, results:[{ ip, alive, rttMs }] }
centralRouter.post('/ping-result', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  if (!b.vcenterId) return res.status(400).json({ ok: false, reason: 'vcenterId가 필요합니다.' });
  // 개별 토큰은 자기 소유 vCenter 의 도달성만 보고(남의 사이트 상태 위조 차단).
  if (req.centralAuth.mode === 'agent' && !agentOwnsVcenter(req.centralAuth.agent, b.vcenterId)) {
    return res.status(403).json({ ok: false, reason: `vcenterId '${b.vcenterId}'는 '${req.centralAuth.agent}' 소유가 아닙니다.` });
  }
  // v2.600(CEN2600-02): direct vCenter 의 도달성은 중앙이 직접 잰다(v2.590 P11 — 엣지 큐에 올리지 않는다) — 엣지 보고는 위조다.
  const pingDeny = edgeVcWriteDenied(b.vcenterId);
  if (pingDeny) return res.status(403).json({ ok: false, reason: pingDeny });
  setPingResults(String(b.vcenterId), Array.isArray(b.results) ? b.results.slice(0, 200) : []);
  res.json({ ok: true, count: Array.isArray(b.results) ? b.results.length : 0 });
});

// 엣지 설정 push: 에이전트가 자기 CONFIG_DIR 설정을 보내 중앙 통합 백업에 합쳐지게 한다.
// Body: { agent, files:{ name: content } }
centralRouter.post('/agent-config', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  // 저장 키는 개별 토큰이면 토큰 해석 agent 강제(body.agent 로 남의 통합백업 config 위조 차단).
  const agent = req.centralAuth.agent || String(b.agent && strAgent(b.agent) || ''); // v2.600 CEN2600-10: 글자일 때만(객체면 String() 이 던졌다)
  if (!agent || !b.files || typeof b.files !== 'object') return res.status(400).json({ ok: false, reason: 'agent·files가 필요합니다.' });
  // 파일 수/크기 상한(남용 방지).
  // v2.600(감사 RECENT2600-05): 길이 상한은 엣지의 수집 상한(backup/service.js FILE_SIZE_CAP = 8MiB 바이트)과 같아야 한다 —
  //   예전 8,000,000 은 그보다 작아 8,000,001~8,388,608 사이 파일이 **기록도 개수도 없이** 사라졌다. UTF-8 에서 글자 수 ≤ 바이트 수이므로
  //   8MiB 바이트 이하 파일은 전부 통과한다. 그래도 빠진 파일은 이름을 응답·로그에 밝힌다(조용한 상한 금지).
  const files = {};
  const lenOmitted = [];
  let n = 0;
  for (const [k, v] of Object.entries(b.files)) {
    if (n++ >= 200) { lenOmitted.push({ name: require_basename(k), reason: 'count' }); continue; }
    if (typeof v !== 'string') { lenOmitted.push({ name: require_basename(k), reason: 'not-string' }); continue; }
    if (v.length > AGENT_CONFIG_FILE_MAX) { lenOmitted.push({ name: require_basename(k), reason: 'too-large', length: v.length }); continue; }
    files[require_basename(k)] = v;
  }
  const r = setAgentConfig(agent.slice(0, 120), files) || {};
  if (r.refused) return res.status(429).json({ ok: false, refused: true, reason: '중앙이 보관하는 엣지 수 상한에 닿았습니다(최근 보고한 엣지는 밀어내지 않습니다).' });
  const lenNote = lenOmitted.length ? ` · 수신 상한으로 ${lenOmitted.length}개 제외(${lenOmitted.slice(0, 5).map((x) => `${x.name}:${x.reason}`).join(', ')}${lenOmitted.length > 5 ? ' …' : ''})` : '';
  (lenOmitted.length ? console.warn : console.log)(`[central] agent-config 수신: agent=${agent} (${Object.keys(files).length}개${r.omitted ? ` · 합계 상한으로 ${r.omitted}개 제외` : ''}${lenNote})`);
  res.json({ ok: true, agent, files: Object.keys(files).length, ...(r.omitted ? { omitted: r.omitted } : {}), ...(lenOmitted.length ? { rejectedFiles: lenOmitted.slice(0, 50), rejectedFileCount: lenOmitted.length } : {}), ...(r.evicted ? { evicted: r.evicted } : {}) });
});
/** v2.600 RECENT2600-05 — 엣지 설정 사본 파일 1개 길이 상한 = 엣지 수집 상한(backup/service.js FILE_SIZE_CAP, 8MiB). */
export const AGENT_CONFIG_FILE_MAX = 8 * 1024 * 1024;
function require_basename(p) { return String(p).split(/[\\/]/).pop().slice(0, 200); }

// 엣지 로그 연합 조회: 에이전트가 자기 vCenter들의 대기 조회를 인출 → 로컬 로그 DB 조회 → 결과 보고.
centralRouter.get('/log-queries', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  let vcs = String(req.query.vcenters || '').split(',').map((s) => s.trim()).filter(Boolean);
  // 개별 토큰은 자기 소유 vCenter 의 대기 조회만 인출(운영자 검색 필터·계정명 유출 차단).
  if (req.centralAuth.mode === 'agent') vcs = vcs.filter((vc) => agentOwnsVcenter(req.centralAuth.agent, vc));
  res.json({ ok: true, queries: takeLogQueries(vcs) });
});
// Body: { reqId, vcenterId, total, rows, dbKind }
centralRouter.post('/log-query-result', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  // 개별 토큰은 자기 소유 vCenter 의 reqId 결과만 보고(위조 로그 주입 차단). reqId 의 진짜 vCenter 는
  // 발급 시각에 기록해 둔 값(vcenterOfReq)으로 판정 — body 값(위조 가능)이 아니다. 미상 reqId 는 무시.
  if (req.centralAuth.mode === 'agent') {
    const vc = vcenterOfReq(b.reqId);
    if (!vc || !agentOwnsVcenter(req.centralAuth.agent, vc)) {
      return res.status(403).json({ ok: false, reason: '이 reqId 는 소유하지 않은(또는 만료된) 조회입니다.' });
    }
  }
  // v2.600(CEN2600-02): 조회의 진짜 vCenter 가 direct 면 엣지 결과를 받지 않는다(중앙이 자기 로그 DB 로 답한다).
  //   ⚠ 미등록 id 는 거부하지 않는다 — 연합 조회의 원격 목록은 배정표에서 오고 중앙 등록부에 없을 수 있다(checksLogs.js).
  { const lqDeny = edgeVcWriteDenied(vcenterOfReq(b.reqId)); if (lqDeny) return res.status(403).json({ ok: false, reason: lqDeny }); }
  setLogQueryResult(String(b.reqId), b);
  res.json({ ok: true });
});

// 위임 tcpdump 캡처: 에이전트가 자기 이름의 대기 캡처 작업을 인출 → 로컬 SSH 캡처 → 결과 보고.
centralRouter.get('/capture-jobs', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  res.json({ ok: true, jobs: takeCaptureJobs(String(req.query.agent || '')) });
});
// Body: { reqId, result }
centralRouter.post('/capture-result', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  if (reqAgentDenied(req, captureAgentOfReq(String(b.reqId)))) return res.status(403).json({ ok: false, reason: '이 reqId 는 요청 에이전트의 잡이 아닙니다.' });
  setCaptureResult(String(b.reqId), b.result || { ok: false, reason: '빈 결과' });
  // v2.600(CEN2600-09): 엣지 워커가 결과에 싣는 A 호스트(잡 spec.host)를 이력의 hostA 로 — 글자만, 제어문자 제거, 255자.
  const hostA = typeof b.result?.hostA === 'string' ? b.result.hostA.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255) : '';
  try { if (b.result?.ok) recordCapture(b.result, { source: 'manual', via: 'agent', ...(hostA ? { hostA } : {}) }); } catch { /* */ }
  res.json({ ok: true });
});

// 베어메탈 스토리지 폴링 위임(v2.341): 엣지가 자기 이름의 df 수집 잡을 인출(claim) →
// 현지 SSH 수집 → 결과 회신(ack). 캡처/iDRAC 스캔과 동일한 claim→ack + 소유권 검증.
centralRouter.get('/bmstor-jobs', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  res.json({ ok: true, jobs: takeBmstorJobs(String(req.query.agent || '')) });
});
// Body: { reqId, results: [{ id, ok, mounts, missing?, error? }] } — 비밀번호 없음(용량 수치만).
centralRouter.post('/bmstor-result', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  if (reqAgentDenied(req, bmstorAgentOfReq(String(b.reqId)))) return res.status(403).json({ ok: false, reason: '이 reqId 는 요청 에이전트의 잡이 아닙니다.' });
  const ackd = ackBmstorJob(String(b.reqId));
  if (!ackd) return res.json({ ok: true, stale: true }); // TTL 정리/중복 회신 — 무해하게 무시
  // 결과는 **그 잡에 실제로 할당된 서버 id 로만** 반영한다 — 인증된 엣지가 b.results 에 남의
  // 서버 id 를 끼워 넣어 그 서버의 latest 용량 수치를 위조하는 것을 차단(잡 소유권 = 서버 소유권).
  const owned = new Set((ackd.serverIds || []).map(String));
  const results = (Array.isArray(b.results) ? b.results : []).filter((r) => r && owned.has(String(r.id)));
  applyBmstorResults(ackd.agent, results);
  res.json({ ok: true });
});

// Agent pulls its IP-scan assignment (TCP connect scan config) by name.
centralRouter.get('/ip-scan-assignment', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const cfg = loadScanSettings(String(req.query.agent || ''));
  if (!cfg.enabled || !cfg.ranges.length) return res.json({ ok: true, assigned: false });
  res.json({ ok: true, assigned: true, ...cfg });
});

// Agent posts its IP-scan result. Body: { agent, alive:[{ip,openPorts,services,hostname}] }
centralRouter.post('/ip-scan-result', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  const b = req.body || {};
  const agent = req.centralAuth.agent || String(b.agent && strAgent(b.agent) || ''); // v2.600 CEN2600-10: 글자일 때만(객체면 String() 이 던졌다)
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  let alive = Array.isArray(b.alive) ? b.alive.slice(0, 8000) : [];
  // 개별 토큰은 자기 배정 스캔 ranges 안의 IP 만 보고할 수 있다(범위 밖 임의 IP 의 열린포트·소유
  // agent 위조 차단 — gpu-guest-data 소유권 필터와 동일 모델). ranges 미설정 agent 는 통과(TOFU).
  // ⚠️ ranges 는 **필터 진입 전 1회 로드·컴파일**한다 — IP 마다 loadScanSettings(무캐시 파일 읽기)를
  // 부르면 8,000개 보고에 동기 read 8,000회로 이벤트 루프가 막힌다(CLAUDE.md 논블로킹 불변조건).
  if (req.centralAuth.mode === 'agent') {
    const bounds = ((loadScanSettings(agent)?.ranges) || []).map(specToRange).filter(Boolean);
    if (bounds.length) {   // ranges 미설정이면 전량 통과(TOFU) — 기존 동작 유지
      const before = alive.length;
      alive = alive.filter((h) => { const n = h && ipToNum(h.ip); return n != null && bounds.some((r) => n >= r.lo && n <= r.hi); });
      if (before !== alive.length) console.warn(`[central] ip-scan-result: ${agent} 배정 범위 밖 IP ${before - alive.length}개 드롭(위조 방지)`);
    }
  }
  // v2.594(감사 EDGE2-03): 형식이 틀린 원소는 병합에서 버려진다 — 버리기 전 개수를 merged·alive 로 보고하면 수치가 부풀었다.
  const validAlive = alive.filter((h) => h && ipToNum(h.ip) != null);
  const dropped = alive.length - validAlive.length;
  if (validAlive.length) mergeScanResults(validAlive, Date.now(), agent);
  recordAgentReport(agent, { scanned: b.scanned || 0, alive: validAlive.length, durationMs: b.durationMs || null });
  res.json({ ok: true, merged: validAlive.length, ...(dropped ? { dropped } : {}) });
});

/*
 * ── 통신 점검(v2.552) ──────────────────────────────────────────────────────────
 *
 * `GET /health-probe` — **엣지가 '중앙까지 닿는가' 를 재는 표적**이다. 엣지는 이 응답의
 *   `yourAgent` 로 '내 토큰이 중앙에서 내 이름으로 해석되는가' 까지 확인한다(토큰 뒤바뀜 탐지).
 *   ⚠ 인벤토리 같은 무거운 경로를 표적으로 쓰지 말 것 — 점검이 곧 부하가 된다.
 *   ⚠ 응답에 **다른 엣지의 이름·주소를 싣지 않는다**(한 법인이 다른 법인 구성을 알게 된다).
 *
 * `POST /link-check` — 엣지가 잰 링크(엣지→중앙·엣지→vCenter·엣지↔엣지) 결과.
 *   개별 토큰 전용이고 저장 키는 `req.centralAuth.agent` 뿐이다(본문 agent 미사용 — v2.548 F5).
 *   ⚠ async 핸들러의 throw 는 express 4 가 잡지 않아 **요청이 응답 없이 매달린다** — try/catch 로
 *     400 을 돌려준다(v2.548 S1, 리뷰에서 실제 hang 을 확인했다).
 */
centralRouter.get('/health-probe', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    at: Date.now(),
    version: currentVersion(),
    instance: instanceId(),
    role: 'central',
    // 공유 토큰이면 어느 엣지인지 알 수 없다 — **빈 값**이고 그것 자체가 진단이다(개별 토큰 미이관).
    yourAgent: req.centralAuth?.mode === 'agent' ? String(req.centralAuth.agent || '') : '',
    tokenMode: req.centralAuth?.mode === 'agent' ? 'agent' : 'shared',
  });
});

centralRouter.post('/link-check', async (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  if (req.centralAuth.mode !== 'agent') {
    return res.status(403).json({
      ok: false,
      reason: '이 엔드포인트는 엣지별 개별 토큰만 허용합니다(공유 CENTRAL_TOKEN 으로는 어느 엣지의 측정인지 신뢰할 수 없습니다). 설정 > 엣지 토큰에서 이 엣지의 토큰을 발급해 주세요.',
    });
  }
  try {
    const out = await putEdgeLinkReport(req.centralAuth.agent, req.body || {});
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  }
});

/*
 * `GET /link-check-config?agent=<이름>` — **그 엣지가 재야 하는 링크**를 중앙이 계산해 내려준다.
 *
 * 왜 엣지가 스스로 만들지 않는가: 켜진 종류·엣지↔엣지 짝·시한은 **중앙 설정**이고, 엣지가 자기
 * 복사본을 들고 있으면 중앙에서 바꾼 설정이 그 법인에 영원히 안 먹는다(v2.409 스토리지 주기와
 * 같은 사고). 판정 규칙은 중앙이 소유한다.
 *
 * ⚠ **자기 몫만** 내려간다(`from === agent`). 전 링크를 내려보내면 한 법인이 다른 법인의 주소를
 *   알게 되고, 남의 링크를 재서 올릴 수도 있다(수신은 거부하지만 애초에 주지 않는다).
 * ⚠ 엣지↔엣지 짝은 **상대 엣지의 주소**를 필요로 하므로 그 링크에만 상대 주소가 실린다 —
 *   관리자가 명시한 짝뿐이고(자동 전량 생성 없음), 그 사실을 문서와 화면이 밝힌다.
 * ⚠ 링크 객체에는 **토큰이 없다**(`links.js` 규약) — 엣지는 자기 `CENTRAL_TOKEN` 을 쓴다.
 */
centralRouter.get('/link-check-config', (req, res) => {
  if (!centralEnabled()) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: denyReason(req) });
  if (req.centralAuth.mode !== 'agent') {
    return res.status(403).json({ ok: false, reason: '이 엔드포인트는 엣지별 개별 토큰만 허용합니다(설정 > 엣지 토큰).' });
  }
  const agent = String(req.centralAuth.agent || '');
  const reqAgent = String(req.query.agent || '').trim();
  if (reqAgent && reqAgent.toLowerCase() !== agent.toLowerCase()) {
    return res.status(403).json({ ok: false, reason: `요청한 agent('${reqAgent}')가 이 토큰의 엣지('${agent}')와 다릅니다.` });
  }
  const s = loadLinkCheckSettings();
  let links = [];
  try {
    const built = buildLinks({
      collectors: listCollectorsForLinks(), vcenters: listVcentersForLinks(), pairs: s.pairs, settings: s,
    });
    links = built.links
      .filter((l) => EDGE_KINDS.includes(l.kind) && l.enabled !== false
        && String(l.from || '').toLowerCase() === agent.toLowerCase())
      .map(publicLink);
  } catch (e) {
    return res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 200) });
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    // ⚠ 꺼져 있으면 **빈 목록이 아니라 enabled:false** 를 준다 — 엣지가 '링크가 없다' 와
    //   '중앙이 껐다' 를 구분해 화면·로그에 말할 수 있어야 한다.
    enabled: linkCheckEnabled(),
    intervalMs: s.intervalMs, concurrency: s.concurrency,
    timeouts: { dnsMs: s.dnsTimeoutMs, tcpMs: s.tcpTimeoutMs, tlsMs: s.tlsTimeoutMs, httpMs: s.httpTimeoutMs },
    links, count: links.length,
  });
});
