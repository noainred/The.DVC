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
import { upgradeManager } from '../upgrade/manager.js';
import { tokenMatches } from '../util/secureCompare.js';
import { upgradeFromBundleBytes, restartProcess, bundleShaIssue } from '../upgrade/upgrade.js';
import { setLocalPassword } from '../auth/auth.js';
import { logAudit } from '../audit.js';
import { runLocalIdracScan } from '../idrac/localScan.js';
import { collectMany as bmstorCollectMany } from '../bmstor/collect.js';
import { checkpointConfigDbs } from '../upgrade/dbCheckpoint.js';
import { tokenFingerprint } from '../util/tokenFingerprint.js'; // v2.560: 토큰 지문 표기는 한 곳이 소유한다

export const collectorRouter = Router();

// Verify the shared collector token on a request (상수시간 비교).
function checkToken(req) {
  if (!config.collector.token) return false;
  const token = req.get('X-Collector-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return tokenMatches(token, config.collector.token);
}

// 인증 거부(403/404) 진단 로그 — 요청이 이 엣지에 '도달했는지'와 '왜 거부됐는지'를 남긴다.
// (기존엔 403이 무로그라, 엣지에서 '요청이 안 옴'과 '토큰 틀림'을 구분할 수 없었다 — WA-IRS 사례.)
// 토큰 값은 절대 남기지 않는다(길이만). (endpoint, src IP)별 30초 스로틀로 스팸 방지.
// deny 통계(관측성): 엣지에서 무음으로 삼켜지던 인증 거부를 집계해 export에 실어 중앙 UI가
// '이 엣지에 최근 토큰 거부 N건'을 보여줄 수 있게 한다(토큰 값은 절대 포함하지 않음).
const denyStats = { count: 0, lastAt: null, lastWhy: '', lastEndpoint: '' };
// v2.437: 중앙 화면이 '거부 N' 배지만 보여 주고 원인을 못 보여 줬다(툴팁에 마지막 사유 한 줄뿐,
// 출처 IP 는 엣지 콘솔 로그에만 있어 SSH 로 들어가야 했다). 최근 거부를 **엣지 안에서** 링버퍼로
// 들고 있다가 export 에 실어 중앙에서 바로 열어 볼 수 있게 한다.
//   · 토큰 값은 절대 담지 않는다(길이·앞 4글자 지문만 — 지문은 '어느 토큰인지' 구분용).
//   · 크기 상한: 최근 20건 + 출처 12개(고RTT 회선에서 export 본문이 커지지 않게).
const DENY_KEEP = 20, DENY_SRC_KEEP = 12;
const denyRecent = [];              // [{ at, endpoint, ip, why, tokenLen, fp, ua }] — 최신이 앞
const denyBySrc = new Map();        // ip → { ip, count, firstAt, lastAt, lastWhy, lastEndpoint }
/**
 * 토큰 지문 — v2.560 에 `util/tokenFingerprint.js` 로 승격했다. **여기서 다시 구현하지 말 것** —
 * 중앙의 토큰 점검 화면이 같은 표기를 쓰므로 두 벌이 되면 '엣지 거부 기록의 지문' 과 '중앙 화면의
 * 지문' 을 눈으로 맞춰 볼 수 없다(v2.528 credFingerprint 규약과 같은 이유).
 */
const tokenFp = (t) => tokenFingerprint(t);
export function getCollectorDenyStats() {
  return {
    ...denyStats,
    recent: denyRecent.slice(0, DENY_KEEP),
    bySrc: [...denyBySrc.values()].sort((a, b) => b.count - a.count).slice(0, DENY_SRC_KEEP),
  };
}
export function _resetCollectorDenyStats() {
  denyStats.count = 0; denyStats.lastAt = null; denyStats.lastWhy = ''; denyStats.lastEndpoint = '';
  denyRecent.length = 0; denyBySrc.clear(); _denyLogAt.clear();
}
const _denyLogAt = new Map();
function logCollectorDeny(req, endpoint) {
  const ip = req.ip || req.socket?.remoteAddress || '?';
  const provided = req.get('X-Collector-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  // 사유는 세 갈래 — 이 구분이 해결 방법을 가른다(엣지 설정 / 요청자 헤더 누락 / 토큰 값 불일치).
  // 화면(상세 카드)용 문구와 콘솔 로그 문구를 분리한다 — 로그 문구는 운영 grep·기존 테스트가 고정한 계약이다.
  const why = !config.collector.token ? 'COLLECTOR_TOKEN 미설정(이 엣지의 수집 기능이 꺼져 있음)'
    : !provided ? '요청에 X-Collector-Token 헤더 없음'
      : '토큰 불일치';
  const logWhy = !config.collector.token ? 'COLLECTOR_TOKEN 미설정(collector 비활성)'
    : !provided ? '요청에 X-Collector-Token 없음'
      : '토큰 불일치';
  // 통계는 스로틀과 무관하게 매 거부마다 집계(로그만 스로틀).
  denyStats.count++;
  denyStats.lastAt = Date.now();
  denyStats.lastEndpoint = endpoint;
  denyStats.lastWhy = !config.collector.token ? 'COLLECTOR_TOKEN 미설정' : (provided ? '토큰 불일치' : '토큰 헤더 없음');
  const now = Date.now();
  denyRecent.unshift({
    at: now, endpoint, ip, why,
    tokenLen: provided ? provided.length : 0,
    fp: tokenFp(provided),
    ua: String(req.get('User-Agent') || '').slice(0, 80),
  });
  if (denyRecent.length > DENY_KEEP) denyRecent.length = DENY_KEEP;
  let src = denyBySrc.get(ip);
  if (!src) {
    // 백스톱: 출처가 무한히 늘지 않게(스캐너 대비) 가장 오래된 항목을 밀어낸다.
    if (denyBySrc.size >= DENY_SRC_KEEP * 4) {
      let oldest = null;
      for (const [k, v] of denyBySrc) if (!oldest || v.lastAt < oldest[1].lastAt) oldest = [k, v];
      if (oldest) denyBySrc.delete(oldest[0]);
    }
    src = { ip, count: 0, firstAt: now, lastAt: now, lastWhy: '', lastEndpoint: '' };
    denyBySrc.set(ip, src);
  }
  src.count++; src.lastAt = now; src.lastWhy = why; src.lastEndpoint = endpoint;
  const key = `${endpoint}:${ip}`;
  if (now - (_denyLogAt.get(key) || 0) < 30_000) return;
  _denyLogAt.set(key, now);
  console.warn(`[collector] 인증 거부(${endpoint}) — src=${ip} · ${logWhy} · 요청토큰=${provided ? `제공됨(len=${provided.length})` : '없음'}`);
}

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
    res.json(await buildExport());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// 중앙 포탈이 이 엣지의 로컬 계정 비밀번호를 원격 변경(기본 비번 일괄 교체용).
// COLLECTOR_TOKEN 가드 — 토큰을 가진 중앙만 호출 가능. 비밀번호는 로그/감사에 남기지 않는다.
collectorRouter.post('/set-password', express.json({ limit: '4kb' }), (req, res) => {
  if (!config.collector.token) { logCollectorDeny(req, 'set-password'); return res.status(404).json({ ok: false, reason: 'collector 비활성화(COLLECTOR_TOKEN 미설정)' }); }
  if (!checkToken(req)) { logCollectorDeny(req, 'set-password'); return res.status(403).json({ ok: false, reason: '토큰 불일치' }); }
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

// 중앙→엣지 직접(PUSH) iDRAC 스캔 — 엣지가 중앙으로 폴링하지 않아도, 중앙이 이 엣지의
// COLLECTOR_TOKEN으로 직접 스캔을 시키고 결과를 동기로 받는다(엣지 CENTRAL_URL 미설정에도 동작).
// 엣지가 현지에서 Redfish 스캔 → (noRegister 아니면) 현지 등록 → 요약 반환.
collectorRouter.post('/idrac-scan', express.json({ limit: '256kb' }), async (req, res) => {
  if (!config.collector.token) { logCollectorDeny(req, 'idrac-scan'); return res.status(404).json({ ok: false, reason: 'collector 비활성화(COLLECTOR_TOKEN 미설정)' }); }
  if (!checkToken(req)) { logCollectorDeny(req, 'idrac-scan'); return res.status(403).json({ ok: false, reason: '토큰 불일치' }); }
  const b = req.body || {};
  const ips = b.ips; const username = String(b.username || '').trim(); const password = b.password;
  if (!ips || !username || (password == null || password === '')) {
    return res.status(400).json({ ok: false, reason: 'ips/username/password가 필요합니다.' });
  }
  try {
    const r = await runLocalIdracScan({
      ips, username, password,
      noRegister: !!b.noRegister, vcenterId: String(b.vcenterId || '').trim(),
      datacenterId: String(b.datacenterId || '').trim(), mode: b.mode || 'merge',
    });
    logAudit({ user: 'central-portal', action: '중앙 PUSH iDRAC 스캔', target: String(b.datacenterId || '') || '(대역)', detail: `발견 ${r.foundCount || 0} · 등록 ${r.registered || 0}`, ip: req.ip || '' });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, reason: e.message });
  }
});

// 베어메탈 스토리지 위임 수집(v2.340) — 중앙이 엣지에 서버 목록(SSH 자격증명+마운트)을 보내면
// 엣지가 현지에서 df 수집 후 동기 반환한다(idrac-scan PUSH 와 같은 토큰 게이트/흐름).
// 자격증명은 저장하지 않고 이 요청 처리에만 사용, 응답·로그에 비밀번호를 남기지 않는다.
collectorRouter.post('/bmstor-collect', express.json({ limit: '512kb' }), async (req, res) => {
  if (!config.collector.token) { logCollectorDeny(req, 'bmstor-collect'); return res.status(404).json({ ok: false, reason: 'collector 비활성화(COLLECTOR_TOKEN 미설정)' }); }
  if (!checkToken(req)) { logCollectorDeny(req, 'bmstor-collect'); return res.status(403).json({ ok: false, reason: '토큰 불일치' }); }
  const servers = Array.isArray(req.body?.servers) ? req.body.servers : [];
  if (!servers.length) return res.status(400).json({ ok: false, reason: 'servers 배열이 필요합니다.' });
  if (servers.length > 200) return res.status(400).json({ ok: false, reason: '한 번에 최대 200대까지입니다.' });
  try {
    const results = await bmstorCollectMany(servers);
    logAudit({ user: 'central-portal', action: '중앙 PUSH 베어메탈 스토리지 수집', detail: `서버 ${servers.length} · 성공 ${results.filter((r) => r.ok).length}`, ip: req.ip || '' });
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, reason: e.message });
  }
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
    const result = upgradeFromBundleBytes(req.body, installDir, currentVersion(), upgradeManager.settings.packageName, { allowSame: force });
    res.json(result);
    if (result.ok && String(req.query.restart) === 'true') setTimeout(() => restartProcess(), 250);
  });
