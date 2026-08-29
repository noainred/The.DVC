/**
 * Collector-agent export endpoint. Mounted OUTSIDE the user-auth middleware and
 * guarded by a shared token (COLLECTOR_TOKEN) so datacenter agents can be pulled
 * by the central portal without user accounts. Disabled when no token is set.
 */

import { Router } from 'express';
import express from 'express';
import { config, currentVersion } from '../config.js';
import { buildExport } from '../collector/agent.js';
import { upgradeManager } from '../upgrade/manager.js';
import { tokenMatches } from '../util/secureCompare.js';
import { upgradeFromBundleBytes, restartProcess } from '../upgrade/upgrade.js';
import { setLocalPassword } from '../auth/auth.js';
import { logAudit } from '../audit.js';
import { runLocalIdracScan } from '../idrac/localScan.js';
import { collectMany as bmstorCollectMany } from '../bmstor/collect.js';
import { checkpointConfigDbs } from '../upgrade/dbCheckpoint.js';

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
export function getCollectorDenyStats() { return { ...denyStats }; }
const _denyLogAt = new Map();
function logCollectorDeny(req, endpoint) {
  const ip = req.ip || req.socket?.remoteAddress || '?';
  // 통계는 스로틀과 무관하게 매 거부마다 집계(로그만 스로틀).
  denyStats.count++;
  denyStats.lastAt = Date.now();
  denyStats.lastEndpoint = endpoint;
  denyStats.lastWhy = !config.collector.token ? 'COLLECTOR_TOKEN 미설정' : '토큰 불일치/누락';
  const key = `${endpoint}:${ip}`;
  const now = Date.now();
  if (now - (_denyLogAt.get(key) || 0) < 30_000) return;
  _denyLogAt.set(key, now);
  const provided = req.get('X-Collector-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const why = !config.collector.token ? 'COLLECTOR_TOKEN 미설정(collector 비활성)'
    : !provided ? '요청에 X-Collector-Token 없음'
      : '토큰 불일치';
  console.warn(`[collector] 인증 거부(${endpoint}) — src=${ip} · ${why} · 요청토큰=${provided ? `제공됨(len=${provided.length})` : '없음'}`);
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
  res.json({ ok: true, datacenter: config.collector.datacenter || '', version: currentVersion() });
});

// 중앙 포탈이 이 엣지의 로컬 계정 비밀번호를 원격 변경(기본 비번 일괄 교체용).
// COLLECTOR_TOKEN 가드 — 토큰을 가진 중앙만 호출 가능. 비밀번호는 로그/감사에 남기지 않는다.
collectorRouter.post('/set-password', express.json({ limit: '4kb' }), (req, res) => {
  if (!config.collector.token) { logCollectorDeny(req, 'set-password'); return res.status(404).json({ ok: false, reason: 'collector 비활성화(COLLECTOR_TOKEN 미설정)' }); }
  if (!checkToken(req)) { logCollectorDeny(req, 'set-password'); return res.status(403).json({ ok: false, reason: '토큰 불일치' }); }
  const username = String(req.body?.username || 'admin').trim();
  // trusted: COLLECTOR_TOKEN 으로 게이트된 중앙→엣지 **시스템** 경로(사용자 세션이 아님).
  // 중앙이 엣지 계정 비번을 일괄 교체하는 정상 기능이라 대리 변경 경계를 명시적으로 통과시킨다
  // (auth.js credentialGuardDenied — 기본은 fail-closed 이므로 이 명시가 없으면 보호 계정에서 막힌다).
  const r = setLocalPassword(username, req.body?.password, { trusted: true });
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
  express.raw({ type: ['application/gzip', 'application/octet-stream'], limit: '256mb' }),
  async (req, res) => {
    if (!req.body || !req.body.length) return res.status(400).json({ ok: false, reason: 'empty bundle' });

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
