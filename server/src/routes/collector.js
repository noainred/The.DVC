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
const _denyLogAt = new Map();
function logCollectorDeny(req, endpoint) {
  const ip = req.ip || req.socket?.remoteAddress || '?';
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

// Receive an upgrade bundle pushed by the central portal and self-install.
// Token-gated by COLLECTOR_TOKEN (no user account needed on the agent).
collectorRouter.post('/upgrade',
  express.raw({ type: ['application/gzip', 'application/octet-stream'], limit: '256mb' }),
  async (req, res) => {
    if (!config.collector.token) { logCollectorDeny(req, 'upgrade'); return res.status(404).json({ ok: false, reason: 'collector 비활성화' }); }
    if (!checkToken(req)) { logCollectorDeny(req, 'upgrade'); return res.status(403).json({ ok: false, reason: '토큰 불일치' }); }
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
