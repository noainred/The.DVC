/**
 * Central orchestration endpoints used by agents (agent -> central). Mounted
 * outside user auth and gated by CENTRAL_TOKEN. Agents pull their IP assignment
 * by name and post scan results back.
 */

import { Router } from 'express';
import { config } from '../config.js';
import { getAssignment, setResult } from '../central/assignments.js';
import { loadScanSettings, mergeScanResults, recordAgentReport } from '../ipam/scanStore.js';

export const centralRouter = Router();

function authed(req) {
  if (!config.central.token) return false;
  const t = req.get('X-Central-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return t === config.central.token;
}

// Agent pulls the IP assignment for its name (incl. iDRAC credentials).
centralRouter.get('/assignment', (req, res) => {
  if (!config.central.token) return res.status(404).json({ ok: false, reason: 'central 비활성화 (CENTRAL_TOKEN 미설정)' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: '토큰 불일치' });
  const a = getAssignment(req.query.agent);
  if (!a || a.enabled === false) return res.json({ ok: true, assigned: false });
  res.json({ ok: true, assigned: true, agent: a.agent, ips: a.ips, username: a.username, password: a.password });
});

// Agent posts its scan result. Body: { agent, scanned, found:[...], unreachable, notIdrac, authFailed }
centralRouter.post('/result', (req, res) => {
  if (!config.central.token) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: '토큰 불일치' });
  const b = req.body || {};
  if (!b.agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  setResult(b.agent, {
    scanned: b.scanned || 0,
    foundCount: b.foundCount ?? (b.found?.length || 0),
    found: Array.isArray(b.found) ? b.found.slice(0, 5000) : [],
    unreachable: b.unreachable || 0,
    notIdrac: b.notIdrac || 0,
    authFailed: b.authFailed || 0,
    durationMs: b.durationMs || null,
  });
  res.json({ ok: true });
});

// Agent pulls its IP-scan assignment (TCP connect scan config) by name.
centralRouter.get('/ip-scan-assignment', (req, res) => {
  if (!config.central.token) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: '토큰 불일치' });
  const cfg = loadScanSettings(String(req.query.agent || ''));
  if (!cfg.enabled || !cfg.ranges.length) return res.json({ ok: true, assigned: false });
  res.json({ ok: true, assigned: true, ...cfg });
});

// Agent posts its IP-scan result. Body: { agent, alive:[{ip,openPorts,services,hostname}] }
centralRouter.post('/ip-scan-result', (req, res) => {
  if (!config.central.token) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: '토큰 불일치' });
  const b = req.body || {};
  if (!b.agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  if (Array.isArray(b.alive)) mergeScanResults(b.alive.slice(0, 8000), Date.now(), String(b.agent));
  recordAgentReport(String(b.agent), { scanned: b.scanned || 0, alive: Array.isArray(b.alive) ? b.alive.length : 0 });
  res.json({ ok: true, merged: Array.isArray(b.alive) ? b.alive.length : 0 });
});
