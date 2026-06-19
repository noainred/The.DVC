import { Router } from 'express';
import fs from 'node:fs';
import { config } from '../config.js';
import { requireRole } from '../auth/auth.js';
import { store } from '../store.js';
import { getLogs } from '../logbuffer.js';
import {
  listRegistry, addVcenter, updateVcenter, removeVcenter, testConnection, importVcenters,
} from '../vcenter/registry.js';
import { geocode } from '../vcenter/geocode.js';
import {
  listRegistry as listServers, addServer, updateServer, removeServer,
  testServer, importServers, parseCsv, bulkAddByIps,
} from '../idrac/registry.js';
import { expandIpList } from '../idrac/iprange.js';
import { getPollerStatus, pollNow } from '../idrac/poller.js';
import { listCollectors, addCollector, updateCollector, removeCollector, loadCollectors } from '../collector/registry.js';
import { allCollectorStatus, getCollectorStatus } from '../collector/state.js';
import { pullNow } from '../collector/puller.js';
import { pushUpgradeToCollectors } from '../collector/upgradePush.js';
import { resolveBundleBytes } from '../upgrade/bundleSource.js';
import { upgradeManager } from '../upgrade/manager.js';

export const adminRouter = Router();

const adminOnly = requireRole('admin');

// Server operational logs (ring buffer). ?since=<id>&level=info|warn|error
adminRouter.get('/logs', adminOnly, (req, res) => {
  res.json(getLogs({ since: req.query.since, level: req.query.level }));
});

// Data-source + per-vCenter collection errors (why a vCenter won't connect).
adminRouter.get('/status', adminOnly, (_req, res) => {
  const snap = store.get();
  res.json({
    dataSource: snap.source,
    generatedAt: snap.generatedAt,
    vcenters: snap.vcenters.length,
    collectionErrors: snap.collectionErrors || [],
  });
});

// List registered vCenters (credentials redacted) + current data-source mode.
adminRouter.get('/vcenters', adminOnly, (_req, res) => {
  res.json({ dataSource: config.dataSource, vcenters: listRegistry() });
});

// Register a new vCenter, then trigger a re-poll.
adminRouter.post('/vcenters', adminOnly, async (req, res) => {
  const result = addVcenter(req.body || {});
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 201 : 400).json(result);
});

// Update an existing vCenter (omit password to keep it), then re-poll.
adminRouter.put('/vcenters/:id', adminOnly, async (req, res) => {
  const result = updateVcenter(req.params.id, req.body || {});
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// Remove a vCenter, then re-poll.
adminRouter.delete('/vcenters/:id', adminOnly, async (req, res) => {
  const result = removeVcenter(req.params.id);
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 200 : 404).json(result);
});

// Test connectivity to a vCenter (new entry or a saved one by id).
adminRouter.post('/vcenters/test', adminOnly, async (req, res) => {
  res.json(await testConnection(req.body || {}));
});

// Offline geocode: city/country -> { lat, lon, match } for map plotting.
adminRouter.get('/geocode', adminOnly, (req, res) => {
  const g = geocode(req.query.city, req.query.country);
  res.json(g ? { ok: true, ...g } : { ok: false, reason: '좌표를 찾을 수 없습니다 (도시/국가명 확인).' });
});

// Import an uploaded vcenters.json. Body: { vcenters:[...], mode?:'merge'|'replace' }
// (a bare array is also accepted). Triggers a re-poll on success.
adminRouter.post('/vcenters/import', adminOnly, (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body) ? body : body.vcenters;
  const result = importVcenters(list, body.mode === 'replace' ? 'replace' : 'merge');
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// Default server-side path suggestions for the "server file" import.
adminRouter.get('/vcenters/import-suggestions', adminOnly, (_req, res) => {
  const candidates = [
    `${config.configDir}/vcenters.json`,
    '/etc/vmware-portal/vcenters.json',
    '/opt/vmware-portal/app/server/config/vcenters.json',
  ];
  res.json({ default: candidates[0], suggestions: [...new Set(candidates)].filter((p) => existsFile(p)) });
});

// Import a vcenters.json already stored on the server. Body: { path, mode? }
adminRouter.post('/vcenters/import-file', adminOnly, (req, res) => {
  const { path: filePath, mode } = req.body || {};
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ ok: false, reason: '파일 경로가 필요합니다.' });
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return res.status(400).json({ ok: false, reason: '파일이 아닙니다.' });
    if (stat.size > 5 * 1024 * 1024) return res.status(400).json({ ok: false, reason: '파일이 너무 큽니다(>5MB).' });
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const list = Array.isArray(json) ? json : json.vcenters;
    const result = importVcenters(list, mode === 'replace' ? 'replace' : 'merge');
    if (result.ok) store.refresh().catch(() => {});
    res.status(result.ok ? 200 : 400).json({ ...result, file: filePath });
  } catch (err) {
    res.status(400).json({ ok: false, reason: `파일 읽기 실패: ${err.message}` });
  }
});

// ---- iDRAC power collection (Dell Redfish) --------------------------------

// List registered Dell servers (credentials redacted) + poller status.
adminRouter.get('/idrac', adminOnly, (_req, res) => {
  res.json({ servers: listServers(), poller: getPollerStatus() });
});

// Register a server, then poll immediately so power shows up right away.
adminRouter.post('/idrac', adminOnly, async (req, res) => {
  const result = addServer(req.body || {});
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 201 : 400).json(result);
});

adminRouter.put('/idrac/:id', adminOnly, async (req, res) => {
  const result = updateServer(req.params.id, req.body || {});
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

adminRouter.delete('/idrac/:id', adminOnly, async (req, res) => {
  const result = removeServer(req.params.id);
  res.status(result.ok ? 200 : 404).json(result);
});

// Test connectivity + read current power for a server (new or saved by id).
adminRouter.post('/idrac/test', adminOnly, async (req, res) => {
  res.json(await testServer(req.body || {}));
});

// Trigger an immediate poll of all servers.
adminRouter.post('/idrac/poll', adminOnly, async (_req, res) => {
  res.json({ ok: true, lastRun: await pollNow() });
});

// Import servers (JSON array / { servers:[...] } / CSV text). Body:
//   { servers:[...], mode? } | { csv:"...", mode? } | bare array
adminRouter.post('/idrac/import', adminOnly, (req, res) => {
  const body = req.body || {};
  let list;
  if (typeof body.csv === 'string') list = parseCsv(body.csv);
  else list = Array.isArray(body) ? body : body.servers;
  const result = importServers(list, body.mode === 'replace' ? 'replace' : 'merge');
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// Preview how an IP list expands (count + sample + parse errors) — no writes.
adminRouter.post('/idrac/expand-ips', adminOnly, (req, res) => {
  const { ips, errors, truncated } = expandIpList((req.body || {}).ips || '');
  res.json({ ok: true, count: ips.length, truncated, sample: ips.slice(0, 12), errors });
});

// Bulk-register servers from an IP list with shared credentials, then poll.
// Body: { ips, username, password, namePrefix?, mode? }
adminRouter.post('/idrac/bulk-add', adminOnly, (req, res) => {
  const result = bulkAddByIps(req.body || {});
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// ---- Distributed collection: remote collector agents ----------------------

// List registered collectors (tokens redacted) + live pull status.
adminRouter.get('/collectors', adminOnly, (_req, res) => {
  res.json({ collectors: listCollectors(), status: allCollectorStatus() });
});

adminRouter.post('/collectors', adminOnly, (req, res) => {
  const result = addCollector(req.body || {});
  if (result.ok) pullNow().catch(() => {});
  res.status(result.ok ? 201 : 400).json(result);
});

adminRouter.put('/collectors/:id', adminOnly, (req, res) => {
  const result = updateCollector(req.params.id, req.body || {});
  if (result.ok) pullNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

adminRouter.delete('/collectors/:id', adminOnly, (req, res) => {
  const result = removeCollector(req.params.id);
  res.status(result.ok ? 200 : 404).json(result);
});

// Trigger an immediate pull of all collectors.
adminRouter.post('/collectors/pull', adminOnly, async (_req, res) => {
  await pullNow();
  res.json({ ok: true, status: allCollectorStatus() });
});

// Push an upgrade bundle to collector agents. Body: { id?, force? }.
// Brings one (id) or all registered agents up to the central portal's version.
adminRouter.post('/collectors/upgrade', adminOnly, async (req, res) => {
  const { id, force } = req.body || {};
  const bundle = await resolveBundleBytes(upgradeManager.settings);
  if (!bundle) {
    return res.status(409).json({ ok: false, reason: '업그레이드 번들을 찾을 수 없습니다 (감시 폴더/원격 소스 확인).' });
  }
  const results = await pushUpgradeToCollectors(bundle.bytes, { ids: id ? [id] : null, force: Boolean(force) });
  const ok = results.filter((r) => r.ok).length;
  res.json({ ok: true, version: bundle.version, source: bundle.source, pushed: results.length, succeeded: ok, results });
});

// Test connectivity to one collector (saved by id, or an ad-hoc {url, token}).
adminRouter.post('/collectors/test', adminOnly, async (req, res) => {
  const body = req.body || {};
  let { url, token } = body;
  if (body.id) { const saved = loadCollectors().find((c) => c.id === body.id); if (saved) { url = url || saved.url; token = token || saved.token; } }
  if (!url) return res.status(400).json({ ok: false, reason: 'url이 필요합니다.' });
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  const started = Date.now();
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/api/collector/export`, {
      headers: { Accept: 'application/json', ...(token ? { 'X-Collector-Token': token } : {}) },
      signal: AbortSignal.timeout(config.collector.timeoutMs),
    });
    if (!r.ok) return res.json({ ok: false, reason: `HTTP ${r.status}`, ms: Date.now() - started });
    const data = await r.json();
    res.json({ ok: true, ms: Date.now() - started, hosts: data.hosts, version: data.version, datacenter: data.datacenter });
  } catch (err) {
    res.json({ ok: false, reason: err.message, ms: Date.now() - started });
  }
});

function existsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
