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
import { deployAgent, testTarget, installerInfo, checkAgentStatus } from '../agent/deploy.js';
import { fetchRemoteVersions, listLocalPackages, downloadPackage } from '../upgrade/fetchPackage.js';
import { getPackageSettings, savePackageSettings } from '../upgrade/packageSettings.js';
import { listTargets, getTargetRaw, saveTarget, removeTarget, recordResult } from '../agent/deployRegistry.js';
import { getLogs } from '../logbuffer.js';
import {
  listRegistry, addVcenter, updateVcenter, removeVcenter, testConnection, importVcenters,
} from '../vcenter/registry.js';
import { geocode } from '../vcenter/geocode.js';
import { getOrder, saveOrder } from '../vcenter/order.js';
import { listAudit } from '../audit.js';
import { alertStatus, saveAlertConfig, testAlert } from '../alerts.js';
import { loadMetricsSettings, saveMetricsSettings, METRICS_LIMITS } from '../metrics/settings.js';
import { forceGpuUtilCollect, clearGpuUtilForce } from '../vcenter/soapClient.js';
import { metricsSamplerStatus, rescheduleMetricsSampler } from '../metrics/sampler.js';
import { loadGpuGuestSettings, saveGpuGuestSettings, redactGpuGuestSettings, resolveVmCreds } from '../gpu/settings.js';
import { gpuGuestStatus, rescheduleGpuGuestPoller, passthruHostIds } from '../gpu/poller.js';
import { testVmGuest, VimSoapClient } from '../gpu/guestops.js';
import { loadVcenterConfig } from '../config.js';
import { loadScanSettings, saveScanSettings, scanResultList, scanInfo, listScanAgents, getAgentReports, getScanRuns, LOCAL } from '../ipam/scanStore.js';
import { startScan, scanStatus, rescheduleScanPoller } from '../ipam/scanPoller.js';
import { listAssignments as listIdracAssignments, getResults as getAgentResults } from '../central/assignments.js';
import { centralTokenInfo, generateCentralToken, setCentralToken } from '../central/token.js';
import { listInventory } from '../central/inventory.js';
import {
  listRegistry as listNsx, addManager as addNsx, updateManager as updateNsx,
  removeManager as removeNsx, testConnection as testNsx,
} from '../nsx/registry.js';
import { nsxStore } from '../nsx/store.js';
import { createJob as createProvisionJob } from '../provision/jobs.js';
import { updateSaved, removeSaved } from '../provision/saved.js';
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
// 배포 폼 자동 채우기용 기본값: 중앙 URL(접속한 호스트 기준 추정) + 포탈 포트 + 토큰 상태.
adminRouter.get('/agent-deploy/defaults', adminOnly, (req, res) => {
  const host = (req.get('host') || `localhost:${config.port}`).replace(/\/+$/, '');
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0];
  res.json({
    centralUrl: `${proto}://${host}`,
    portalPort: config.port,
    central: centralTokenInfo(),
  });
});

adminRouter.post('/agent-deploy/test', adminOnly, async (req, res) => {
  res.json(await testTarget(req.body || {}));
});

adminRouter.post('/agent-deploy', adminOnly, async (req, res) => {
  // SSH 포트(target.port)와 포탈 포트(portalPort)를 혼동하지 않도록 분리.
  // portalPort만 install.sh --port 로 전달(예전 버그: SSH 22가 포탈 포트로 들어가 EACCES).
  const { installerPath, portalPort, ...target } = req.body || {};
  const r = await deployAgent(target, { installerPath, port: Number(portalPort) || 4000 });
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

// 저장된 대상의 서비스 상태를 재확인(재배포 없이). 결과를 '마지막 결과'에 반영.
adminRouter.post('/agent-deploy/targets/:id/status', adminOnly, async (req, res) => {
  const t = getTargetRaw(req.params.id);
  if (!t) return res.status(404).json({ ok: false, reason: '대상을 찾을 수 없습니다.' });
  const r = await checkAgentStatus(t);
  recordResult(t.id, r);
  res.json(r);
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

// 중앙 토큰(CENTRAL_TOKEN) — 조회/생성/저장(실행중 서버 + portal.env 영속).
adminRouter.get('/central-token', adminOnly, (_req, res) => res.json(centralTokenInfo()));
// 사이트 위임 수집 현황(어떤 vCenter를 어떤 에이전트가 언제 push했는지).
adminRouter.get('/central/inventory', adminOnly, (_req, res) => res.json({ inventory: listInventory() }));
adminRouter.post('/central-token/generate', adminOnly, (req, res) => {
  const r = generateCentralToken({ force: !!(req.body && req.body.force) });
  res.json({ ok: true, ...r });
});
adminRouter.put('/central-token', adminOnly, (req, res) => {
  try { res.json({ ok: true, token: setCentralToken(req.body && req.body.token) }); }
  catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

// IP 능동 스캔(TCP 커넥트) — 에이전트별 설정/상태/수동실행/결과.
// agent 미지정 = 이 포탈(중앙) 직접 스캔(__local__). 그 외 이름 = 분산 에이전트 할당.
adminRouter.get('/ipam/scan/settings', adminOnly, (req, res) => {
  const agent = req.query.agent || LOCAL;
  // 선택 가능한 에이전트: 로컬 + IP스캔 설정된 에이전트 + iDRAC 할당 + 중앙에 보고한
  // 에이전트(getResults) + 배포된 에이전트(agentName) + 수집 서버(datacenter).
  const names = new Set([LOCAL]);
  for (const a of listScanAgents()) names.add(a.name);
  for (const a of listIdracAssignments()) if (a.agent) names.add(a.agent);
  for (const k of Object.keys(getAgentResults() || {})) names.add(k);
  for (const t of listTargets()) if (t.agentName) names.add(t.agentName);
  for (const c of listCollectors()) if (c.datacenter) names.add(c.datacenter);
  for (const k of Object.keys(getAgentReports() || {})) if (k && k !== LOCAL) names.add(k);
  res.json({
    agent, settings: loadScanSettings(agent), agents: [...names],
    status: scanStatus(), info: scanInfo(),
    centralEnabled: !!config.central.token,   // 에이전트 보고 가능 여부(중앙 토큰 설정)
    reports: getAgentReports(),               // 에이전트별 마지막 보고
  });
});
adminRouter.put('/ipam/scan/settings', adminOnly, (req, res) => {
  const agent = (req.body && req.body.agent) || LOCAL;
  const settings = saveScanSettings(agent, req.body || {});
  if (agent === LOCAL) rescheduleScanPoller(); // 로컬 설정만 이 포탈 폴러에 적용
  res.json({ ok: true, agent, settings, status: scanStatus() });
});
adminRouter.post('/ipam/scan/run', adminOnly, (_req, res) => {
  const r = startScan({ manual: true }); // 비동기 시작 — 즉시 반환(백그라운드 실행, 창 닫아도 지속)
  res.json({ ...r, status: scanStatus(), info: scanInfo() });
});
// 진행 중 스캔 상태 + 완료된 스캔 이력(가벼운 폴링용).
adminRouter.get('/ipam/scan/status', adminOnly, (_req, res) => {
  res.json({ status: scanStatus(), info: scanInfo(), runs: getScanRuns(50), reports: getAgentReports() });
});
adminRouter.get('/ipam/scan/results', adminOnly, (_req, res) => {
  res.json({ results: scanResultList().slice(0, 5000), info: scanInfo() });
});

// Metrics sampler settings: 온도/용량/GPU 수집 주기 + 보존기간 (런타임 변경).
adminRouter.get('/metrics/settings', adminOnly, (_req, res) => {
  res.json({ settings: loadMetricsSettings(), limits: METRICS_LIMITS, status: metricsSamplerStatus() });
});
adminRouter.put('/metrics/settings', adminOnly, (req, res) => {
  const settings = saveMetricsSettings(req.body || {});
  rescheduleMetricsSampler(); // apply the new interval immediately
  res.json({ ok: true, settings, status: metricsSamplerStatus() });
});
// GPU 호스트 사용률 '지금 수집' — 주기를 무시하고 즉시 한 번 수집(다음 스냅샷 갱신에 반영).
adminRouter.post('/gpu/collect-util', adminOnly, async (_req, res) => {
  try {
    forceGpuUtilCollect();
    await store.refresh();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, reason: e.message });
  } finally { clearGpuUtilForce(); }
});

// GPU 게스트 수집: 어떤 법인을 게스트 OS 계정으로 GPU 모니터링할지 + 자격증명.
adminRouter.get('/gpu-guest/settings', adminOnly, (_req, res) => {
  res.json({ settings: redactGpuGuestSettings(loadGpuGuestSettings()), status: gpuGuestStatus() });
});
adminRouter.put('/gpu-guest/settings', adminOnly, (req, res) => {
  const settings = saveGpuGuestSettings(req.body || {});
  rescheduleGpuGuestPoller();
  res.json({ ok: true, settings: redactGpuGuestSettings(settings), status: gpuGuestStatus() });
});

// 선택한 법인(vCenter)에서 GPU를 패스쓰루로 쓰는 VM 목록 — VM별 자격증명 설정용.
// 패스쓰루 호스트 위의 VM(전원/Tools 무관)을 모두 보여주고, 현재 저장된 VM별 계정 여부도 함께.
adminRouter.get('/gpu-guest/vms', adminOnly, (req, res) => {
  const vcId = req.query.vcenterId;
  if (!vcId) return res.status(400).json({ error: 'vcenterId 필요' });
  const snap = store.get();
  const hostNames = passthruHostIds(snap, vcId);
  const s = loadGpuGuestSettings();
  const saved = (s.vcenters[vcId]?.vms) || {};
  const vms = (snap.vms || [])
    .filter((v) => v.vcenterId === vcId && hostNames.has(v.host))
    .map((v) => ({
      id: v.id, name: v.name, host: v.host, cluster: v.cluster || '',
      powerState: v.powerState, toolsStatus: v.toolsStatus || '', guestOS: v.guestOS || '',
      gpu: v.gpu || null,
      hasOwnCred: !!saved[v.id]?.username, ownUsername: saved[v.id]?.username || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ vcenterId: vcId, vcShared: { username: s.vcenters[vcId]?.username || '', hasPassword: !!s.vcenters[vcId]?.password }, vms });
});

// 게스트 로그인/데이터 읽기 테스트 — 개별 또는 일괄. body:
//   { vcenterId, items: [{ vmId, username, password, useShared }] }
// useShared=true 면 법인 공용 계정으로, 아니면 입력한(없으면 저장된 VM별) 계정으로 테스트.
adminRouter.post('/gpu-guest/test', adminOnly, async (req, res) => {
  const { vcenterId, items } = req.body || {};
  if (!vcenterId || !Array.isArray(items) || !items.length) return res.status(400).json({ error: 'vcenterId + items 필요' });
  const snap = store.get();
  const vmById = new Map((snap.vms || []).filter((v) => v.vcenterId === vcenterId).map((v) => [v.id, v]));
  const s = loadGpuGuestSettings();

  // 데모(mock) 환경: 실제 게스트가 없으므로 합성 결과.
  if (snap.source === 'mock') {
    return res.json({ mock: true, results: items.map((it) => {
      const v = vmById.get(it.vmId);
      const ok = !!v && v.powerState === 'POWERED_ON' && v.toolsStatus === 'RUNNING';
      return { vmId: it.vmId, login: ok, read: ok, error: ok ? null : 'VM 전원/Tools 미동작(mock)', sample: ok ? { gpus: 1, utilPct: 42 } : null };
    }) });
  }

  const vc = (loadVcenterConfig().vcenters || []).find((x) => x.id === vcenterId);
  if (!vc) return res.status(404).json({ error: '등록된 vCenter 아님' });
  const limit = Math.min(Math.max(1, s.concurrency || 4), 8);
  const results = new Array(items.length);
  let c;
  try {
    c = new VimSoapClient(vc);
    await c.login();
    const q = items.map((it, i) => ({ it, i }));
    const workers = Array.from({ length: Math.min(limit, q.length) }, async () => {
      while (q.length) {
        const { it, i } = q.shift();
        const v = vmById.get(it.vmId);
        if (!v) { results[i] = { vmId: it.vmId, login: false, read: false, error: 'VM을 찾을 수 없음' }; continue; }
        if (v.toolsStatus !== 'RUNNING') { results[i] = { vmId: it.vmId, login: false, read: false, error: 'VMware Tools 미실행' }; continue; }
        if (v.powerState !== 'POWERED_ON') { results[i] = { vmId: it.vmId, login: false, read: false, error: 'VM 전원 꺼짐' }; continue; }
        // 자격증명 결정: useShared면 법인 공용, 아니면 입력값(빈 비번은 저장값) → 없으면 해석값.
        const vcShared = s.vcenters[vcenterId] || {};
        let creds;
        if (it.useShared) creds = vcShared.username ? { username: vcShared.username, password: vcShared.password || '' } : null;
        else if (it.username) creds = { username: it.username, password: it.password || (vcShared.vms?.[it.vmId]?.password || '') };
        else creds = resolveVmCreds(s, vcenterId, it.vmId);
        if (!creds || !creds.username) { results[i] = { vmId: it.vmId, login: false, read: false, error: '계정 없음' }; continue; }
        const isWindows = /windows/i.test(v.guestOS || '');
        const r = await testVmGuest(c, String(v.id).split(':').slice(1).join(':'), creds, { isWindows, timeoutMs: s.timeoutMs }).catch((e) => ({ login: false, read: false, error: e.message }));
        results[i] = { vmId: it.vmId, ...r };
      }
    });
    await Promise.all(workers);
  } catch (e) {
    return res.status(500).json({ error: `vCenter 로그인 실패: ${e.message}` });
  } finally { try { await c?.logout(); } catch { /* */ } }
  res.json({ results });
});

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

// Audit log viewer (누가 언제 무엇을 했는지).
adminRouter.get('/audit', adminOnly, (req, res) => {
  res.json(listAudit({ limit: req.query.limit, offset: req.query.offset, user: req.query.user, q: req.query.q }));
});

// Alerting: config + current firing/recent, save config, send a test notification.
adminRouter.get('/alerts', adminOnly, (_req, res) => res.json(alertStatus()));
adminRouter.put('/alerts', adminOnly, (req, res) => res.json({ ok: true, config: saveAlertConfig(req.body || {}) }));
adminRouter.post('/alerts/test', adminOnly, async (req, res) => res.json(await testAlert(req.user?.username)));

// --- VM 프로비저닝: 대량 생성 작업 시작 (관리자) ---
adminRouter.post('/provision/jobs', adminOnly, (req, res) => {
  const result = createProvisionJob(req.body || {}, { user: req.user });
  res.status(result.ok ? 201 : 400).json(result);
});
// 저장된 작업 메모/태그 수정·삭제 (관리자)
adminRouter.put('/provision/saved/:id', adminOnly, (req, res) => {
  const r = updateSaved(req.params.id, req.body || {});
  res.status(r.ok ? 200 : 404).json(r);
});
adminRouter.delete('/provision/saved/:id', adminOnly, (req, res) => {
  const r = removeSaved(req.params.id);
  res.status(r.ok ? 200 : 404).json(r);
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
