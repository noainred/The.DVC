import { Router } from 'express';
import fs from 'node:fs';
import { config } from '../config.js';
import { requireRole, listUsers, createUser, updateUser, deleteUser, beginTotpEnroll, confirmTotpEnroll, disableTotp } from '../auth/auth.js';
import { store } from '../store.js';
import { getDataSource, setDataSource, isDataSourceOverridden } from '../runtime-settings.js';
import { ledgerInfo } from '../ipam/db.js';
import { loadSettings as loadIpamSettings, saveSettings as saveIpamSettings } from '../ipam/settings.js';
import { saveNote, deleteNote } from '../release-notes.js';
import { loadLlmConfig, saveLlmConfig } from '../llm/config.js';
import { ollamaTest } from '../llm/ollama.js';
import { installOllama } from '../llm/ollamaDeploy.js';
import { deployAgent, testTarget, installerInfo } from '../agent/deploy.js';
import { fetchRemoteVersions, listLocalPackages, downloadPackage } from '../upgrade/fetchPackage.js';
import { getPackageSettings, savePackageSettings } from '../upgrade/packageSettings.js';
import { listTargets, getTargetRaw, saveTarget, removeTarget, recordResult } from '../agent/deployRegistry.js';
import { getLogs } from '../logbuffer.js';
import {
  listRegistry, addVcenter, updateVcenter, removeVcenter, testConnection, importVcenters,
} from '../vcenter/registry.js';
import { geocode } from '../vcenter/geocode.js';
import { getOrder, saveOrder } from '../vcenter/order.js';
import {
  listRegistry as listNsx, addManager as addNsx, updateManager as updateNsx,
  removeManager as removeNsx, testConnection as testNsx,
} from '../nsx/registry.js';
import { nsxStore } from '../nsx/store.js';
import { createJob as createProvisionJob } from '../provision/jobs.js';
import {
  listRegistry as listServers, addServer, updateServer, removeServer,
  testServer, importServers, parseCsv, bulkAddByIps, registerScanned,
} from '../idrac/registry.js';
import { expandIpList } from '../idrac/iprange.js';
import { scanForIdracs } from '../idrac/scan.js';
import { getPollerStatus, pollNow } from '../idrac/poller.js';
import { listCollectors, addCollector, updateCollector, removeCollector, loadCollectors } from '../collector/registry.js';
import { allCollectorStatus, getCollectorStatus } from '../collector/state.js';
import { pullNow } from '../collector/puller.js';
import { pushUpgradeToCollectors } from '../collector/upgradePush.js';
import { resolveBundleBytes } from '../upgrade/bundleSource.js';
import { upgradeManager } from '../upgrade/manager.js';
import {
  listAssignments, addAssignment, updateAssignment, removeAssignment, getResults,
  parseCsv as parseAssignmentsCsv, importAssignments,
} from '../central/assignments.js';

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

// --- User management (admin) ---
adminRouter.get('/users', adminOnly, (_req, res) => res.json({ users: listUsers() }));

adminRouter.post('/users', adminOnly, (req, res) => {
  const r = createUser(req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

adminRouter.patch('/users/:username', adminOnly, (req, res) => {
  const r = updateUser(req.params.username, req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

adminRouter.delete('/users/:username', adminOnly, (req, res) => {
  if (req.params.username === req.user.username) return res.status(400).json({ ok: false, reason: '자기 자신은 삭제할 수 없습니다.' });
  const r = deleteUser(req.params.username);
  res.status(r.ok ? 200 : 400).json(r);
});

// TOTP (Google Authenticator) management for a user — admin enrolls and hands
// the QR to the user (since OTP-only users have no password to self-enroll).
adminRouter.post('/users/:username/totp/begin', adminOnly, (req, res) => {
  const r = beginTotpEnroll(req.params.username);
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.post('/users/:username/totp/confirm', adminOnly, (req, res) => {
  const r = confirmTotpEnroll(req.params.username, (req.body || {}).code);
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.post('/users/:username/totp/disable', adminOnly, (req, res) => {
  const r = disableTotp(req.params.username, req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

// --- Package auto-download (upgrade/install packages → packages dir) ---
adminRouter.get('/packages', adminOnly, async (req, res) => {
  const s = getPackageSettings();
  let remote = null;
  try { remote = await fetchRemoteVersions(req.query.baseUrl || s.baseUrl); }
  catch (e) { remote = { error: e.message }; }
  res.json({ dir: s.dir, baseUrl: s.baseUrl, settings: s, local: listLocalPackages(), remote });
});
// Web-editable package source (repository URL / download dir / token).
adminRouter.put('/packages/settings', adminOnly, (req, res) => {
  res.json({ ok: true, settings: savePackageSettings(req.body || {}) });
});
adminRouter.post('/packages/download', adminOnly, async (req, res) => {
  try { const r = await downloadPackage(req.body || {}); res.status(r.ok ? 200 : 400).json(r); }
  catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

// --- iDRAC-scan agent auto-deploy (SSH push install) ---
adminRouter.get('/agent-deploy/installer', adminOnly, (req, res) => res.json(installerInfo(req.query.path)));

adminRouter.post('/agent-deploy/test', adminOnly, async (req, res) => {
  res.json(await testTarget(req.body || {}));
});

adminRouter.post('/agent-deploy', adminOnly, async (req, res) => {
  const { installerPath, port, portalPort, ...target } = req.body || {};
  const r = await deployAgent(target, { installerPath, port: port || portalPort });
  res.status(r.ok ? 200 : 400).json(r);
});

// Saved targets + bulk deploy.
adminRouter.get('/agent-deploy/targets', adminOnly, (_req, res) => res.json({ targets: listTargets() }));

adminRouter.post('/agent-deploy/targets', adminOnly, (req, res) => {
  const r = saveTarget(req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

adminRouter.delete('/agent-deploy/targets/:id', adminOnly, (req, res) => {
  const r = removeTarget(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

adminRouter.post('/agent-deploy/targets/:id/deploy', adminOnly, async (req, res) => {
  const t = getTargetRaw(req.params.id);
  if (!t) return res.status(404).json({ ok: false, reason: '대상을 찾을 수 없습니다.' });
  const r = await deployAgent(t, { installerPath: t.installerPath, port: t.portalPort });
  recordResult(t.id, r);
  res.status(r.ok ? 200 : 400).json(r);
});

// Deploy to all enabled saved targets, sequentially (heavy SFTP transfers).
adminRouter.post('/agent-deploy/deploy-all', adminOnly, async (_req, res) => {
  const results = [];
  for (const t of listTargets().filter((x) => x.enabled !== false)) {
    const raw = getTargetRaw(t.id);
    const r = await deployAgent(raw, { installerPath: raw.installerPath, port: raw.portalPort });
    recordResult(t.id, r);
    results.push({ id: t.id, host: t.host, agentName: t.agentName, ok: r.ok, active: r.active, reason: r.reason });
  }
  res.json({ ok: true, deployed: results.filter((r) => r.ok).length, total: results.length, results });
});

// --- Local LLM (Ollama) config for natural-language search ---
adminRouter.get('/llm-config', adminOnly, (_req, res) => res.json({ config: loadLlmConfig() }));
adminRouter.put('/llm-config', adminOnly, (req, res) => res.json({ ok: true, config: saveLlmConfig(req.body || {}) }));
adminRouter.post('/llm-test', adminOnly, async (req, res) => {
  res.json(await ollamaTest({ ...loadLlmConfig(), ...(req.body || {}) }));
});

// SSH-install Ollama on a separate server (test reuses the agent SSH probe).
adminRouter.post('/ollama-deploy/test', adminOnly, async (req, res) => res.json(await testTarget(req.body || {})));
adminRouter.post('/ollama-deploy', adminOnly, async (req, res) => {
  const { mode, binaryPath, model, port, applyToPortal, ...target } = req.body || {};
  const r = await installOllama(target, { mode, binaryPath, model, port, applyToPortal });
  res.status(r.ok ? 200 : 400).json(r);
});

// Record / delete a release note (admin).
adminRouter.post('/release-notes', adminOnly, (req, res) => {
  const r = saveNote(req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/release-notes/:version', adminOnly, (req, res) => {
  const r = deleteNote(req.params.version);
  res.status(r.ok ? 200 : 400).json(r);
});

// Shareable IP ledger DB location + record count (for other-program integration).
adminRouter.get('/ipam/db-info', adminOnly, async (_req, res) => {
  res.json(await ledgerInfo());
});

// IPMS settings: ignore IP ranges (global + per-vCenter) hidden from the ledger.
adminRouter.get('/ipam/settings', adminOnly, (_req, res) => res.json({ settings: loadIpamSettings() }));
adminRouter.put('/ipam/settings', adminOnly, (req, res) => res.json({ ok: true, settings: saveIpamSettings(req.body || {}) }));

// Read the effective data source (UI override or env default).
adminRouter.get('/data-source', adminOnly, (_req, res) => {
  res.json({ dataSource: getDataSource(), envDefault: config.dataSource, overridden: isDataSourceOverridden() });
});

// Switch the data source at runtime (mock | live | auto) and re-poll.
adminRouter.put('/data-source', adminOnly, async (req, res) => {
  const result = setDataSource((req.body || {}).dataSource);
  if (!result.ok) return res.status(400).json(result);
  await store.refresh().catch(() => {});
  res.json({ ...result, overridden: isDataSourceOverridden() });
});

// List registered vCenters (credentials redacted) + current data-source mode.
adminRouter.get('/vcenters', adminOnly, (_req, res) => {
  res.json({ dataSource: getDataSource(), vcenters: listRegistry() });
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

// vCenter display order (applies to every "vCenter 선택" list in the web).
adminRouter.get('/vcenter-order', adminOnly, (_req, res) => {
  const order = getOrder();
  const rank = new Map(order.map((id, i) => [id, i]));
  // Return all registered vCenters in saved order; unsaved ones appended.
  const list = listRegistry().map((v) => ({ id: v.id, name: v.name, region: v.location?.region || '' }));
  list.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9) - (rank.has(b.id) ? rank.get(b.id) : 1e9));
  res.json({ order, vcenters: list });
});
adminRouter.put('/vcenter-order', adminOnly, (req, res) => {
  res.json({ ok: true, order: saveOrder((req.body || {}).order) });
});

// --- VM 프로비저닝: 대량 생성 작업 시작 (관리자) ---
adminRouter.post('/provision/jobs', adminOnly, (req, res) => {
  const result = createProvisionJob(req.body || {}, { user: req.user });
  res.status(result.ok ? 201 : 400).json(result);
});

// --- NSX Manager registry (separate from vCenter; managed by NSX Manager) ---
adminRouter.get('/nsx/managers', adminOnly, (_req, res) => {
  res.json({ dataSource: getDataSource(), managers: listNsx() });
});
adminRouter.post('/nsx/managers', adminOnly, (req, res) => {
  const result = addNsx(req.body || {});
  if (result.ok) nsxStore.refresh().catch(() => {});
  res.status(result.ok ? 201 : 400).json(result);
});
adminRouter.put('/nsx/managers/:id', adminOnly, (req, res) => {
  const result = updateNsx(req.params.id, req.body || {});
  if (result.ok) nsxStore.refresh().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});
adminRouter.delete('/nsx/managers/:id', adminOnly, (req, res) => {
  const result = removeNsx(req.params.id);
  if (result.ok) nsxStore.refresh().catch(() => {});
  res.status(result.ok ? 200 : 404).json(result);
});
adminRouter.post('/nsx/managers/test', adminOnly, async (req, res) => {
  res.json(await testNsx(req.body || {}));
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

// Scan an IP range and return only the IPs that are real Dell iDRACs (with
// identity). No writes. Body: { ips, username, password }
adminRouter.post('/idrac/scan', adminOnly, async (req, res) => {
  const { ips, username, password } = req.body || {};
  if (!ips) return res.status(400).json({ ok: false, reason: 'IP 대역을 입력하세요.' });
  if (!username || !password) return res.status(400).json({ ok: false, reason: 'iDRAC 계정/비밀번호가 필요합니다.' });
  try {
    const result = await scanForIdracs({ ips, username, password });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message });
  }
});

// Register iDRACs found by a scan, applying the shared credentials, then poll.
// Body: { found:[{ip,serviceTag,hostName,model}], username, password, mode? }
adminRouter.post('/idrac/register-scanned', adminOnly, (req, res) => {
  const { found, username, password, mode } = req.body || {};
  const result = registerScanned(found, username, password, mode === 'replace' ? 'replace' : 'merge');
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

// ---- Agent scan assignments (central orchestration) -----------------------

// List per-agent IP assignments (credentials redacted) + each agent's last
// reported scan result.
adminRouter.get('/assignments', adminOnly, (_req, res) => {
  res.json({ assignments: listAssignments(), results: getResults(), centralEnabled: Boolean(config.central.token) });
});

adminRouter.post('/assignments', adminOnly, (req, res) => {
  const result = addAssignment(req.body || {});
  res.status(result.ok ? 201 : 400).json(result);
});

adminRouter.put('/assignments/:agent', adminOnly, (req, res) => {
  const result = updateAssignment(req.params.agent, req.body || {});
  res.status(result.ok ? 200 : 400).json(result);
});

adminRouter.delete('/assignments/:agent', adminOnly, (req, res) => {
  const result = removeAssignment(req.params.agent);
  res.status(result.ok ? 200 : 404).json(result);
});

// Import assignments from CSV text or a JSON array. Body:
//   { csv:"...", mode? } | { assignments:[...], mode? } | bare array
adminRouter.post('/assignments/import', adminOnly, (req, res) => {
  const b = req.body || {};
  let list;
  if (typeof b.csv === 'string') list = parseAssignmentsCsv(b.csv);
  else list = Array.isArray(b) ? b : b.assignments;
  const result = importAssignments(list, b.mode === 'replace' ? 'replace' : 'merge');
  res.status(result.ok ? 200 : 400).json(result);
});

function existsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
