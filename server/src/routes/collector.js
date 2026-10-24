/**
 * Collector-agent export endpoint. Mounted OUTSIDE the user-auth middleware and
 * guarded by a shared token (COLLECTOR_TOKEN) so datacenter agents can be pulled
 * by the central portal without user accounts. Disabled when no token is set.
 */

import { Router } from 'express';
import express from 'express';
import os from 'node:os';
import { config, currentVersion } from '../config.js';
import { buildExport } from '../collector/agent.js';
import { registryLoadError as idracRegistryLoadError } from '../idrac/registry.js'; // v2.743(감사 EDGE-01)
import { summarizeRegistryError } from '../util/registryCore.js'; // v2.744(리드 후속 RY): 503 사유는 요약(원문 없음)
import { upgradeManager } from '../upgrade/manager.js';
import { tokenMatches } from '../util/secureCompare.js';
import { upgradeFromBundleBytes, restartProcess, bundleShaIssue } from '../upgrade/upgrade.js';
import { decodeManifestHeader, MANIFEST_HEADER } from '../upgrade/signature.js'; // v2.730(검토 S-10): push 의 서명 manifest
import { setLocalPassword } from '../auth/auth.js';
import { logAudit } from '../audit.js';
import { runLocalIdracScan } from '../idrac/localScan.js';
import { collectMany as bmstorCollectMany } from '../bmstor/collect.js';
import { tryAcquireScan, releaseScan } from '../idrac/scanPoller.js'; // v2.612 EDGE2612-01: 스캔 잠금 공유
import { checkpointConfigDbs } from '../upgrade/dbCheckpoint.js';
import { wrapAsyncRouter } from '../util/asyncRoute.js';
import { getCollectorDenyStats, _resetCollectorDenyStats, logCollectorDeny } from '../collector/denyLog.js'; // v2.579
import { edgeIsiduNudge, edgeIsiduTest } from '../isidu/edgeOps.js'; // v2.736 — 정적 import(엣지 로그 표가 부팅 모듈만 읽는다)

export const collectorRouter = Router();
// v2.574 BUG-03: express 4 는 async 핸들러의 throw 를 잡지 않아 그 요청이 **응답 없이
// 매달린다**(소켓 fd 가 잡힌다). 라우트를 등록하기 **전에** 감싸 전역 에러 핸들러로 보낸다.
// ⚠ 라우트 등록보다 아래로 옮기지 말 것 — 그 뒤에 등록된 것만 보호된다.
wrapAsyncRouter(collectorRouter);

// Verify the shared collector token on a request (상수시간 비교).
function checkToken(req) {
  if (!config.collector.token) return false;
  const token = req.get('X-Collector-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return tokenMatches(token, config.collector.token);
}

/*
 * v2.741(EDGE-02): JSON 본문을 받는 POST 는 **토큰을 먼저 보고 그 뒤에** 본문을 읽는다(`/upgrade` 와 같은 순서).
 *  예전에는 index.js 의 전역 `express.json({limit:'1mb'})` 가 이 라우터 마운트보다 앞에 있어, 토큰 없는 요청도 1MB 까지
 *  읽고 JSON.parse 했고 각 라우트에 적힌 `express.json({limit:'4kb'…})` 는 **한 번도 적용되지 않았다**(body-parser 는
 *  req._body 가 이미 참이면 건너뛴다). 이제 index.js 가 이 라우터를 전역 파서보다 **먼저** 마운트하고, 라우트마다
 *  tokenFirst → 라우트 파서 순서다. 이 라우터에서 전역 파서에 기대던 경로는 없다(POST 전부가 자기 파서를 갖는다 —
 *  /xfer-test 는 스트림, /upgrade 는 raw). ⚠ 새 JSON POST 를 더하면 tokenFirst 와 라우트 파서를 **함께** 붙일 것 —
 *  없으면 req.body 가 비어 있다.
 */
function tokenFirst(name) {
  return (req, res, next) => {
    if (!config.collector.token) { logCollectorDeny(req, name); return res.status(404).json({ ok: false, reason: 'collector 비활성화(COLLECTOR_TOKEN 미설정)' }); }
    if (!checkToken(req)) { logCollectorDeny(req, name); return res.status(403).json({ ok: false, reason: '토큰 불일치' }); }
    next();
  };
}

// 인증 거부 기록은 v2.579 에 `collector/denyLog.js` 로 옮겼다(ARCH-03 — collector/agent 가 이 라우트
// 파일을 import 하던 순환 제거). 테스트 하니스가 이 파일에서 두 이름을 가져가므로 재수출한다.
export { getCollectorDenyStats, _resetCollectorDenyStats };

collectorRouter.get('/export', async (req, res) => {
  if (!config.collector.token) {
    logCollectorDeny(req, 'export');
    return res.status(404).json({ error: 'collector export 비활성화 (COLLECTOR_TOKEN 미설정)' });
  }
  if (!checkToken(req)) {
    logCollectorDeny(req, 'export');
    return res.status(403).json({ error: '토큰 불일치' });
  }
  try {
    // v2.743(감사 EDGE-01): iDRAC 등록부를 읽지 못했으면 **빈 목록을 2xx 로 보내지 않는다**. 예전에는 200 + servers:[]·전력 0 을
    //   표지 없이 보내 중앙이 그 법인의 위임 서버·원격 전력을 통째로 지웠다. 503 이면 중앙 puller 는 실패로 보고 직전 스냅샷을 유지한다
    //   (setCollectorServers 를 부르지 않는다 — 구버전 중앙도 비-2xx 는 실패다). 응답 전후 두 번 본다(사이에 손상이 드러난 경우).
    const sdSince = typeof req.query.sdSince === 'string' ? req.query.sdSince : null;
    const before = idracRegistryLoadError();
    if (before) return idracRegistryUnreadable(res, before);
    // v2.742(감사 EDGE-01): 중앙이 마지막으로 저장한 커서 — 그 뒤로 바뀌지 않은 서버의 센서 상세는 뺀다(collector/agent.js). 없으면 전량.
    const out = await buildExport({ sdSince });
    const after = idracRegistryLoadError();
    if (after) return idracRegistryUnreadable(res, after);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * v2.743(감사 EDGE-01): 엣지 iDRAC 등록부를 읽지 못함 → **지속형 503**. 머리는 중앙의 지속형 503(routes/central.js
 *   PERSISTENT_503_RETRY_AFTER_SEC — 60초 · no-store)과 같은 값이다(이 상태는 400·800ms 뒤에도 그대로다). 본문 `reason` 은 기계 판정용
 *   코드이고 중앙 puller 가 읽어 상태·통신 지도 사유(pull-edge-registry)로 싣는다.
 *   ⚠ v2.744(리드 후속 RY): `detail`·`error` 는 사유 **요약**(summarizeRegistryError — 분류 + 줄·칸·위치 숫자 + 시스템 오류 코드)이다. 예전에는
 *     '비밀 없음' 이라 적고 등록부 로드 오류 원문(V8 JSON.parse 메시지 = 오류 위치 앞뒤 원문 약 10자 — 손상된 idrac.json 의 평문 비밀번호 조각)을
 *     실어, 중앙 puller 가 그것을 수집 서버 상태 error 로 저장해 수집 서버 화면·통신 지도에 보였다(재현). 원문은 이 엣지의 보존본 파일에 있다.
 *     `registryError` 는 같은 요약의 기계 판정용 필드(code·line·column·position·sysCode — 숫자·코드만)다. 구버전 중앙은 모르는 필드라 무시한다.
 */
export const EDGE_EXPORT_503_RETRY_AFTER_SEC = 60;
const EDGE_EXPORT_503_HEADERS = Object.freeze({ 'Retry-After': String(EDGE_EXPORT_503_RETRY_AFTER_SEC), 'Cache-Control': 'no-store' });
function idracRegistryUnreadable(res, err) {
  const sum = summarizeRegistryError(err);
  return res.status(503).set(EDGE_EXPORT_503_HEADERS).json({
    ok: false, reason: 'registryUnreadable', registry: 'idrac',
    // v2.744(감사 EDGE-04): 엣지 정체 — 정상 export·/ping 과 같은 값(비밀 없음). 중앙의 수집 서버 상태는 인메모리라, 중앙 재시작 뒤
    //   처음부터 이 503 이면 버전을 알 길이 없어 '버전 미상'(iLO 전용 스캔 보류·파트 장애/CVP 판정)이 등록부 복구 때까지 이어졌다.
    //   구버전 중앙은 모르는 필드라 무시한다.
    version: currentVersion(), agent: config.agent.name || '', hostname: os.hostname(),
    detail: sum?.text || '', at: Number.isFinite(err?.at) ? err.at : null,
    registryError: sum ? { code: sum.code, line: sum.line, column: sum.column, position: sum.position, sysCode: sum.sysCode } : null,
    error: `엣지 iDRAC 등록부(idrac.json)를 읽지 못했습니다${sum?.text ? ` — ${sum.text}` : ''}`,
  });
}

// Lightweight liveness probe for the admin "테스트" button (no power payload).
collectorRouter.get('/ping', (req, res) => {
  if (!config.collector.token) { logCollectorDeny(req, 'ping'); return res.status(404).json({ ok: false }); }
  if (!checkToken(req)) { logCollectorDeny(req, 'ping'); return res.status(403).json({ ok: false }); }
  // agent/hostname(v2.424): 중앙이 '이 URL 이 실제로 어느 엣지에 닿았는지' 확인한다 — 엣지A 포트포워딩으로 엣지B 를
  // 등록한 토폴로지에서 포워딩이 A 자신으로 되돌아오거나 자기등록 URL 이 A 를 가리키는 사고를 드러낸다.
  res.json({ ok: true, datacenter: config.collector.datacenter || '', version: currentVersion(), agent: config.agent.name || '', hostname: os.hostname() });
});

/**
 * 엣지 로그 + 진행상태(v2.549 — 사용자 요청 "진행상태를 edge 의 로그를 읽어와서 확인").
 *
 * 중앙이 **필요할 때만** 당긴다 — 상시 트래픽 0. `collector/puller.js:23` 이 이미 같은 경로로
 * `/export` 를 당기고 있으므로 **새 네트워크 허용이 필요 없다**.
 *
 * ⚠ 이 응답에는 그 법인 포탈의 콘솔 로그가 들어 있다(호스트명·IP 가 흔하다). 그래서
 *   ① COLLECTOR_TOKEN 게이트(다른 엔드포인트와 같다) ② `edgelog/redact.js` 가 출구에서 비밀을 가림
 *   ③ 중앙 화면은 admin 전용(`routes/api/edgeLog.js`) — **셋을 같이 지킬 것.**
 * ⚠ 본문 크기는 `limit`(기본 400줄·최대 1,000줄)이 막는다. 잘린 것은 `logs.truncated` 로 밝힌다.
 */
collectorRouter.get('/edge-log', async (req, res) => {
  if (!config.collector.token) { logCollectorDeny(req, 'edge-log'); return res.status(404).json({ ok: false, reason: 'collector 비활성화(COLLECTOR_TOKEN 미설정)' }); }
  if (!checkToken(req)) { logCollectorDeny(req, 'edge-log'); return res.status(403).json({ ok: false, reason: '토큰 불일치' }); }
  try {
    const { collectEdgeLog } = await import('../edgelog/collect.js');
    const snap = await collectEdgeLog({
      since: req.query.since, level: req.query.level,
      limit: req.query.limit, withStatus: String(req.query.status ?? '1') !== '0',
    });
    res.json({ ok: true, ...snap });
  } catch (err) {
    // 무음 실패 금지 — 중앙이 '왜 못 읽었는지' 를 화면에 적을 수 있어야 한다.
    res.status(500).json({ ok: false, reason: String(err?.message || err).slice(0, 300) });
  }
});

/**
 * 엣지가 종합한 **베어메탈 사용률**(v2.554 — 사용자 지시 "엣지에서 종합하고 중앙으로 전달은
 * 중앙에서 조회할때만 한다").
 *
 * 중앙이 **필요할 때만** 당긴다 — 상시 push 0. `/edge-log` 와 **같은 url·같은 토큰**이므로
 * 새 네트워크 허용이 필요 없다.
 *
 * ⚠ 이 응답에는 그 법인 서버 이름·서비스태그·iDRAC 주소가 들어 있다(자격증명은 없다 —
 *   `publicTarget()` 이 뺀다). 그래서 ① COLLECTOR_TOKEN 게이트 ② 중앙 화면은 tools 권한 +
 *   vCenter scope(`routes/api/bmUsage.js`) — 둘을 같이 지킬 것.
 * ⚠ 수집이 꺼져 있어도 **200 + `enabled:false`** 로 답한다 — 중앙이 '안 켰다' 와 '못 읽었다' 를
 *   구분할 수 있어야 한다(v2.517 `sendStatusOnly` 규약).
 */
collectorRouter.get('/bm-usage', async (req, res) => {
  if (!config.collector.token) { logCollectorDeny(req, 'bm-usage'); return res.status(404).json({ ok: false, reason: 'collector 비활성화(COLLECTOR_TOKEN 미설정)' }); }
  if (!checkToken(req)) { logCollectorDeny(req, 'bm-usage'); return res.status(403).json({ ok: false, reason: '토큰 불일치' }); }
  try {
    const { buildBmUsageEnvelope } = await import('../bmusage/edgePull.js');
    const snap = await buildBmUsageEnvelope({ limit: req.query.limit });
    res.json({ ok: true, ...snap });
  } catch (err) {
    // 무음 실패 금지 — 중앙이 '왜 못 읽었는지' 를 화면에 적을 수 있어야 한다.
    res.status(500).json({ ok: false, reason: String(err?.message || err).slice(0, 300) });
  }
});

/**
 * 이 엣지의 **토큰 자기보고**(v2.560 — 사용자 요청 "등록된 모든 엣지/수집 서버의 모든 토큰 …
 * 중앙에 저장된 토큰과 엣지에 저장된 토큰이 동일한지 점검").
 *
 * 중앙이 **필요할 때만** 당긴다 — 상시 push 0. `/edge-log`·`/bm-usage` 와 **같은 url·같은 토큰**
 * 이므로 새 네트워크 허용이 필요 없다.
 * ⚠⚠ 이 경로를 **개별 토큰 전용 라우트로 만들지 말 것** — v2.554 가 기록한 한계가 그것이다
 *   (`/api/central/link-check` 는 개별 토큰 전용이라 공유 `CENTRAL_TOKEN` 만 쓰는 법인은 403 이고
 *   "403 을 받고 있다는 사실조차 보고할 수 없다"). 수집 토큰 게이트는 공유/개별과 무관하다.
 *
 * ⚠⚠ 응답에 **평문 토큰도 전체 해시도 싣지 않는다** — 8자 지문 + 길이 + 앞뒤공백 플래그뿐이다
 *   (`portalcheck/edgeReport.js` 머리말이 근거를 적는다). 전체 해시는 곧 중앙 저장값이고, 사람이
 *   정한 공유 토큰이면 오프라인 사전 공격이 성립한다.
 * ⚠ `?selfprobe=0` 이면 중앙에 두드려 보는 자기확인을 건너뛴다(그 사실을 응답이 밝힌다).
 */
collectorRouter.get('/token-check', async (req, res) => {
  if (!config.collector.token) { logCollectorDeny(req, 'token-check'); return res.status(404).json({ ok: false, reason: 'collector 비활성화(COLLECTOR_TOKEN 미설정)' }); }
  if (!checkToken(req)) { logCollectorDeny(req, 'token-check'); return res.status(403).json({ ok: false, reason: '토큰 불일치' }); }
  try {
    const { buildTokenCheckEnvelope } = await import('../portalcheck/edgeReport.js');
    const snap = await buildTokenCheckEnvelope({ selfProbe: String(req.query.selfprobe ?? '1') !== '0' });
    res.json({ ok: true, ...snap });
  } catch (err) {
    // 무음 실패 금지 — 중앙이 '왜 못 읽었는지' 를 화면에 적을 수 있어야 한다.
    res.status(500).json({ ok: false, reason: String(err?.message || err).slice(0, 300) });
  }
});

/**
 * 법인 간 전송 속도 측정 상대(v2.735 — 사용자 요청 "main 서버와 edge 포탈간에 30분에 1번씩 10MB 파일을 전송해서
 * 법인간 전송 속도를 테스트"). GET = 엣지 → 메인(무작위 N 바이트를 흘린다), POST = 메인 → 엣지(받은 바이트를 세고 버린다).
 *
 * `/edge-log`·`/bm-usage` 와 **같은 url·같은 토큰**이라 새 네트워크 허용이 필요 없다. 측정은 중앙이 주도한다
 * (`xferspeed/poller.js`). ⚠ 토큰 검사는 **본문을 읽기 전에** 한다 — 미인증 요청이 수십 MB 를 흘리게 두지 않는다
 * (`/upgrade` 와 같은 순서). 본문 파서(express.json)는 octet-stream 을 건드리지 않는다.
 * 현장에서 끄려면 `XFER_TEST_ENABLED=false`(404 + 사유 — 중앙이 '엣지에서 꺼짐' 으로 말한다).
 */
collectorRouter.get('/xfer-test', async (req, res) => {
  if (!config.collector.token) { logCollectorDeny(req, 'xfer-test'); return res.status(404).json({ ok: false, reason: 'collector 비활성화(COLLECTOR_TOKEN 미설정)' }); }
  if (!checkToken(req)) { logCollectorDeny(req, 'xfer-test'); return res.status(403).json({ ok: false, reason: '토큰 불일치' }); }
  const { serveXferDownload } = await import('../xferspeed/serve.js');
  return serveXferDownload(req, res);
});
collectorRouter.post('/xfer-test', async (req, res) => {
  if (!config.collector.token) { logCollectorDeny(req, 'xfer-test'); res.set('Connection', 'close'); return res.status(404).json({ ok: false, reason: 'collector 비활성화(COLLECTOR_TOKEN 미설정)' }); }
  if (!checkToken(req)) { logCollectorDeny(req, 'xfer-test'); res.set('Connection', 'close'); return res.status(403).json({ ok: false, reason: '토큰 불일치' }); }
  const { receiveXferUpload } = await import('../xferspeed/serve.js');
  return receiveXferUpload(req, res);
});

// 중앙 포탈이 이 엣지의 로컬 계정 비밀번호를 원격 변경(기본 비번 일괄 교체용).
// COLLECTOR_TOKEN 가드 — 토큰을 가진 중앙만 호출 가능. 비밀번호는 로그/감사에 남기지 않는다.
collectorRouter.post('/set-password', tokenFirst('set-password'), express.json({ limit: '4kb' }), (req, res) => {
  const username = String(req.body?.username || 'admin').trim();
  // ⚠ trusted 를 넘기지 않는다(6차 재감사). `trusted` 는 credentialGuardDenied 를 **첫 줄에서
  // 무조건 통과**시키는 로컬 콘솔 전용 플래그다. 여기에 붙이면 원격(중앙)에서 임의 계정명을
  // 지정해 **수퍼관리자·설정소유자의 비밀번호를 심을 수 있다** — 실제로 중앙의 비소유자 admin 이
  // `POST /admin/collectors/set-password {username:'noainred'}` 로 전 엣지의 수퍼관리자 비번을
  // 교체하고, 그 비번으로 로그인해 자력 OTP 등록 → 백업 다운로드까지 가는 체인이 재현됐다.
  // actor·trusted 를 모두 생략하면 **일반 계정은 종전대로 허용, 보호 계정만 거부**된다
  // (문서화된 용도 = 기본 admin 계정 비번 일괄 교체 → 기능 손실 없음).
  // 보호 계정 비번 교체가 정말 필요하면 그 엣지의 콘솔 도구(로컬 실행 = 진짜 신뢰 경계)를 쓴다.
  const r = setLocalPassword(username, req.body?.password);
  if (r.ok) logAudit({ user: 'central-portal', action: '엣지 비밀번호 원격 변경', target: username, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json({ ...r, version: currentVersion() });
});

// v2.776(엣지 개별 토큰 자동 적용): 중앙이 이 엣지의 **개별 central 토큰**을 내려준다. 수집 토큰을 먼저 보고(tokenFirst), 엣지는
//   portal.env 의 AGENT_CENTRAL_TOKEN 에 쓰고 새 토큰으로 중앙 health-probe 를 확인한 뒤에만 남긴다(실패면 되돌린다 — agent/centralTokenApply.js).
//   토큰 값은 감사·응답에 싣지 않는다(지문만).
collectorRouter.post('/central-token', tokenFirst('central-token'), express.json({ limit: '4kb' }), async (req, res) => {
  const { applyAgentCentralToken } = await import('../agent/centralTokenApply.js');
  const r = await applyAgentCentralToken({ token: req.body?.token });
  logAudit({ user: 'central-portal', action: r.ok ? '엣지 개별 central 토큰 적용' : '엣지 개별 central 토큰 적용 실패', target: config.agent.name || '', detail: `${r.fp ? `지문 ${r.fp}` : ''}${r.ok ? '' : ` · ${r.reason || ''}${r.reverted ? ' · 되돌림' : ''}`}`, ip: req.ip || '' });
  res.status(r.ok ? 200 : (r.reason === 'bad-token' ? 400 : r.reason === 'busy' ? 409 : 200)).json(r);
});

// 중앙→엣지 직접(PUSH) iDRAC 스캔 — 엣지가 중앙으로 폴링하지 않아도, 중앙이 이 엣지의
// COLLECTOR_TOKEN으로 직접 스캔을 시키고 결과를 동기로 받는다(엣지 CENTRAL_URL 미설정에도 동작).
// 엣지가 현지에서 Redfish 스캔 → (noRegister 아니면) 현지 등록 → 요약 반환.
// v2.741(EDGE-02): 한도는 **1mb** 다 — 예전 선언(256kb)은 적용된 적이 없고 실제로는 전역 1mb 였다. ips 는 사람이 붙여넣은 IP
//   목록(관리 화면 /idrac/scan)일 수 있어 256kb 로 줄이면 지금 동작하는 요청이 413 이 된다(줄이지 않았다).
collectorRouter.post('/idrac-scan', tokenFirst('idrac-scan'), express.json({ limit: '1mb' }), async (req, res) => {
  const b = req.body || {};
  const ips = b.ips; const username = String(b.username || '').trim(); const password = b.password;
  // v2.610: HPE iLO 계정(선택) — 아는 두 필드만 받는다. iLO 계정만 있는 대역(Dell 계정 없음)도 허용한다.
  const ilo = (b.ilo && typeof b.ilo === 'object' && String(b.ilo.username || '').trim() && typeof b.ilo.password === 'string' && b.ilo.password)
    ? { username: String(b.ilo.username).trim().slice(0, 128), password: String(b.ilo.password).slice(0, 512) } : null;
  const dellOk = Boolean(username) && !(password == null || password === '');
  if (!ips || (!dellOk && !ilo)) {
    return res.status(400).json({ ok: false, reason: 'ips 와 계정(iDRAC username/password 또는 iLO 계정)이 필요합니다.' });
  }
  // v2.612 EDGE2612-01: 한 번에 하나 — 중앙의 재전송·연타, 폴링 워커, 이 엣지의 주기 스캔과 **같은 잠금**을 쓴다.
  //   겹치면 같은 대역에 같은 계정으로 로그인이 두 벌 나가고 등록도 두 번 돈다. 진행 중이면 409 busy(중앙이 '이미 수행 중' 으로 말한다).
  const lock = tryAcquireScan('push');
  if (!lock.ok) return res.status(409).json({ ok: false, busy: true, reason: lock.reason });
  try {
    const r = await runLocalIdracScan({
      ips, username: dellOk ? username : '', password: dellOk ? password : '', ilo,
      noRegister: !!b.noRegister, vcenterId: String(b.vcenterId || '').trim(),
      datacenterId: String(b.datacenterId || '').trim(), mode: b.mode || 'merge',
      // v2.591(감사 F3): 주기 스캔만 인증 정지 IP 를 건너뛴다 — 값이 없으면(구버전 중앙) 수동으로 본다(전부 시도, 안전한 쪽).
      trigger: b.trigger === 'periodic' ? 'periodic' : 'manual', rangeId: String(b.rangeId || '').slice(0, 128),
    });
    logAudit({ user: 'central-portal', action: '중앙 PUSH iDRAC 스캔', target: String(b.datacenterId || '') || '(대역)', detail: `발견 ${r.foundCount || 0} · 등록 ${r.registered || 0}`, ip: req.ip || '' });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, reason: e.message });
  } finally { releaseScan(); }
});

// v2.736 아이실론 디렉터리 사용량 — 메인이 이 엣지에 du 를 '바로' 시키는 길(iDRAC PUSH 스캔과 같은 url·토큰).
//   isidu-run : 중앙 설정을 지금 다시 받아 '지금 수집' 요청을 시작한다(본문의 대상 id 를 믿지 않는다 — 중앙 큐가 정한다).
//   isidu-test: 메인이 보낸 대상(비밀 없음)을 다시 검증하고 이 엣지의 키·등록부로 `ls -d` 만 한다(du 는 돌리지 않는다).
collectorRouter.post('/isidu-run', tokenFirst('isidu-run'), express.json({ limit: '4kb' }), async (req, res) => {
  res.json(await edgeIsiduNudge());
});
collectorRouter.post('/isidu-test', tokenFirst('isidu-test'), express.json({ limit: '16kb' }), async (req, res) => {
  const r = await edgeIsiduTest(req.body || {});
  res.status(r.status).json(r.body);
});

let bmstorPushRunning = false; // v2.612 EDGE2612-01: /bmstor-collect 단일 비행
// 베어메탈 스토리지 위임 수집(v2.340) — 중앙이 엣지에 서버 목록(SSH 자격증명+마운트)을 보내면
// 엣지가 현지에서 df 수집 후 동기 반환한다(idrac-scan PUSH 와 같은 토큰 게이트/흐름).
// 자격증명은 저장하지 않고 이 요청 처리에만 사용, 응답·로그에 비밀번호를 남기지 않는다.
// v2.741(EDGE-02): 한도는 **1mb** 다 — 예전 선언(512kb)은 적용된 적이 없고 실제로는 전역 1mb 였다(서버 200대 × 마운트 64개면
//   512kb 를 넘을 수 있어 줄이지 않았다).
collectorRouter.post('/bmstor-collect', tokenFirst('bmstor-collect'), express.json({ limit: '1mb' }), async (req, res) => {
  const raw = Array.isArray(req.body?.servers) ? req.body.servers : [];
  // v2.741(EDGE-03): 원소는 **객체만** 받는다 — null·문자열 원소 하나가 collectMany 의 list[i].id 에서 던져 요청 전체가 500 이 되고
  //   같은 요청의 다른 서버 결과까지 잃었다. 뺀 개수는 응답 `dropped` 로 밝힌다(조용한 생략 금지 — 다른 수신 경로와 같은 규칙).
  const servers = raw.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  const dropped = raw.length - servers.length;
  if (!servers.length) {
    return res.status(400).json({ ok: false, reason: dropped ? `servers 원소가 객체가 아닙니다(${dropped}개를 받지 않았습니다).` : 'servers 배열이 필요합니다.', ...(dropped ? { dropped } : {}) });
  }
  if (servers.length > 200) return res.status(400).json({ ok: false, reason: '한 번에 최대 200대까지입니다.' });
  // v2.612 EDGE2612-01: 한 번에 하나 — 중앙이 시한 뒤 다시 보낸 요청이 앞 수집과 겹쳐 같은 서버에 SSH 세션을 두 벌 열지 않게.
  if (bmstorPushRunning) return res.status(409).json({ ok: false, busy: true, reason: '이전 위임 수집이 아직 진행 중입니다 — 끝난 뒤 다시 시도하세요.' });
  bmstorPushRunning = true;
  try {
    const results = await bmstorCollectMany(servers);
    logAudit({ user: 'central-portal', action: '중앙 PUSH 베어메탈 스토리지 수집', detail: `서버 ${servers.length} · 성공 ${results.filter((r) => r.ok).length}${dropped ? ` · 형식 오류로 뺀 원소 ${dropped}` : ''}`, ip: req.ip || '' });
    res.json({ ok: true, results, ...(dropped ? { dropped } : {}) });
  } catch (e) {
    res.status(500).json({ ok: false, reason: e.message });
  } finally { bmstorPushRunning = false; }
});

// Receive an upgrade bundle pushed by the central portal and self-install.
// Token-gated by COLLECTOR_TOKEN (no user account needed on the agent).
collectorRouter.post('/upgrade',
  // ★ 인증을 256MB raw 바디 버퍼링 '앞'에서 수행 — 미인증 요청이 대용량 바디를 메모리에
  //   적재하는 DoS 증폭을 막는다(토큰 검사 후에만 번들을 받는다).
  (req, res, next) => {
    if (!config.collector.token) { logCollectorDeny(req, 'upgrade'); return res.status(404).json({ ok: false, reason: 'collector 비활성화' }); }
    if (!checkToken(req)) { logCollectorDeny(req, 'upgrade'); return res.status(403).json({ ok: false, reason: '토큰 불일치' }); }
    next();
  },
  express.raw({ type: ['application/gzip', 'application/octet-stream'], limit: '210mb' }),
  async (req, res) => {
    if (!req.body || !req.body.length) return res.status(400).json({ ok: false, reason: 'empty bundle' });
    const shaIssue = bundleShaIssue(req.get('x-bundle-sha256'), req.body); // v2.480(3차 감사): 수집기 수신 번들도 검증
    if (shaIssue) return res.status(400).json({ ok: false, reason: shaIssue });

    // 파일 복사(config 보존) 전에 라이브 WAL SQLite 체크포인트 → 엣지 복사본 정합성 확보(best-effort).
    try { await checkpointConfigDbs(config.configDir); } catch { /* never block upgrade */ }

    // Default the install dir to the running app root so agents can be upgraded
    // without configuring UPGRADE_INSTALL_DIR explicitly.
    const installDir = upgradeManager.settings.installDir || config.appRoot;
    const force = String(req.query.force) === 'true';
    // v2.730(검토 S-10): 배포자 서명 — 이 수집기가 가진 신뢰 공개키로 설치 전에 검증한다(force 재설치도 같다).
    const result = upgradeFromBundleBytes(req.body, installDir, currentVersion(), upgradeManager.settings.packageName,
      { allowSame: force, manifestText: decodeManifestHeader(req.get(MANIFEST_HEADER)), where: 'push-collector' });
    // v2.736.2: 업그레이드 화면 '최근 적용 결과' 에 남긴다(파일에도 — 재시작 뒤 이 엣지가 업그레이드됐는지 보이게).
    upgradeManager.lastResult = { at: Date.now(), source: 'collector-push', ...result };
    res.json(result);
    if (result.ok && String(req.query.restart) === 'true') setTimeout(() => restartProcess(), 250);
  });
