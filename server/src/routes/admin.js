import { Router } from 'express';
import fs from 'node:fs';
import { config } from '../config.js';
import { requireRole, listUsers, createUser, updateUser, deleteUser, beginTotpEnroll, confirmTotpEnroll, disableTotp, verifyUserOtp, getUser } from '../auth/auth.js';
import { getEmergencyStatus, setEmergencyStop } from '../security/emergencyStop.js';
import { loadSessionSecurity, saveSessionSecurity } from '../security/securitySettings.js';
import { saveOsScanSettings, runOsScanNow, osScanStatus } from '../inventory/osScanner.js';
import { getOsResults } from '../inventory/osStore.js';
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
import { getOrder, saveOrder, sortByOrder } from '../vcenter/order.js';
import { listAudit, logAudit } from '../audit.js';
import { alertStatus, saveAlertConfig, testAlert, getAnomalySettings, saveAnomalySettings } from '../alerts.js';
import { loadMetricsSettings, saveMetricsSettings, METRICS_LIMITS } from '../metrics/settings.js';
import { forceGpuUtilCollect, clearGpuUtilForce } from '../vcenter/soapClient.js';
import { metricsSamplerStatus, rescheduleMetricsSampler } from '../metrics/sampler.js';
import { loadGpuGuestSettings, saveGpuGuestSettings, redactGpuGuestSettings, resolveVmCreds } from '../gpu/settings.js';
import { gpuGuestStatus, rescheduleGpuGuestPoller, gpuHostIds, vmUsesGpu, getGpuGuestDiag } from '../gpu/poller.js';
import { testVmGuest, VimSoapClient } from '../gpu/guestops.js';
import { testVmGuestSsh, detectPhysicalGpu } from '../gpu/sshCollect.js';
import { listPhysical, addPhysical, updatePhysical, removePhysical, getPhysicalRaw, findPhysicalByHost } from '../gpu/physicalRegistry.js';
import { getAllPhysicalGpu } from '../gpu/physicalStore.js';
import { physicalPollerStatus, pollPhysicalOnce } from '../gpu/physicalPoller.js';
import { getGuestGpuVms } from '../gpu/store.js';
import { getAllGpuGuestDiag } from '../central/gpuGuestDiag.js';
import { loadVcenterConfig } from '../config.js';
import { getVmHardware, reconfigVm } from '../provision/reconfig.js';
import { applyFleetAssign } from '../insights/fleetAssign.js';
import { probeRelayPath } from '../vcenter/relayProbe.js';
import { portalDbReport } from '../insights/portalDb.js';
import { loadScanSettings, saveScanSettings, scanResultList, scanInfo, listScanAgents, getAgentReports, getScanRuns, LOCAL } from '../ipam/scanStore.js';
import { startScan, scanStatus, rescheduleScanPoller } from '../ipam/scanPoller.js';
import { listVcRanges, saveVcRanges, removeVcRanges } from '../ipam/rangeStore.js';
import { listAssignments as listIdracAssignments, getResults as getAgentResults } from '../central/assignments.js';
import { centralTokenInfo, generateCentralToken, setCentralToken } from '../central/token.js';
import { listInventory } from '../central/inventory.js';
import { getIngestStats, resetIngestStats } from '../central/ingestStats.js';
import { listAgentConfigs } from '../central/agentConfig.js';
import { createBackup, listBackups, backupPath, deleteBackup, readBackup, restoreCentral } from '../backup/service.js';
import { loadBackupSettings, saveBackupSettings, backupStatus } from '../backup/settings.js';
import { saveLogSettings } from '../logs/settings.js';
import { logStatus, rescheduleLogPoller, pollLogsOnce } from '../logs/poller.js';
import { resetLogsDb } from '../logs/db.js';
import { runTrafficCapture, runDualCapture, runPcapCapture } from '../net/tcpdump.js';
import { analyzeLogsForIssues } from '../net/logIssues.js';
import { enqueueCapture, getCaptureResult } from '../central/captureJobs.js';
import { getAllAgentConfigs } from '../central/agentConfig.js';
import { recordCapture, listCaptures, getCapture, deleteCapture } from '../net/captureHistory.js';
import { listMonitors, saveMonitor, removeMonitor, runMonitorNow } from '../net/monitor.js';
import { addUsersToVms } from '../guest/accountService.js';
import { snapshotFilter, slimVm, guestProbe } from '../search/deepSearch.js';
import { analyzeLoginFails } from '../security/loginFails.js';
import { loadLoginMonitor, saveLoginMonitor, loginMonitorStatus, runLoginAnalysisNow } from '../security/loginMonitor.js';
import { listGuestScans, saveGuestScan, removeGuestScan, runGuestScanNow } from '../security/guestScanScheduler.js';
import { analyzeNetIssues } from '../security/netIssueStore.js';
import path from 'node:path';
import {
  listRegistry as listNsx, addManager as addNsx, updateManager as updateNsx,
  removeManager as removeNsx, testConnection as testNsx,
} from '../nsx/registry.js';
import { nsxStore } from '../nsx/store.js';
import { createJob as createProvisionJob } from '../provision/jobs.js';
import { updateSaved, removeSaved } from '../provision/saved.js';
import {
  listRegistry as listServers, addServer, updateServer, removeServer,
  testServer, importServers, parseCsv, bulkAddByIps, registerScanned, assignVcenter, deleteServers,
  loadRegistry as loadIdracRegistry,
} from '../idrac/registry.js';
import { expandIpList } from '../idrac/iprange.js';
import { scanForIdracs } from '../idrac/scan.js';
import { enqueueIdracScan, enqueueIdracRegister, getIdracScanResult, listIdracScanJobs } from '../central/idracScanJobs.js';
import { getPollerStatus, pollNow } from '../idrac/poller.js';
import { listScanRanges, saveScanRanges, removeScanRanges } from '../idrac/scanRanges.js';
import { startIdracScanNow, idracScanStatus } from '../idrac/scanPoller.js';
import { allMeasuredPower, buildPowerDashboard, purgeStalePower, measuredPowerBreakdown, vcenterPowerCheck } from '../idrac/service.js';
import { computeFinOps, loadFinopsConfig } from '../insights/finops.js';
import { loadPowerSettings, savePowerSettings, filterMeasuredByMapping } from '../idrac/powerSettings.js';
import { snapMemo, sendCached } from '../util/snapCache.js';
import { getInventory as getIdracInventory } from '../idrac/invCache.js';
import { getSensorSeries } from '../idrac/sensorStore.js';
import { fetchInventory as fetchIdracInventory, fetchSensors as fetchIdracSensors, probeGpuTelemetry } from '../idrac/redfish.js';
import { listCollectors, addCollector, updateCollector, removeCollector, loadCollectors } from '../collector/registry.js';
import { allRemoteServers, findRemoteServer } from '../collector/remoteInventory.js';
import { matchDatacenterId } from '../collector/datacenterMatch.js';
import { serverInScope } from '../insights/analysisScope.js';
import { listDatacenters, getDatacenterAssign, addDatacenter, updateDatacenter, removeDatacenter, setVcenterDatacenterMany } from '../datacenter/store.js';
import { allCollectorStatus, getCollectorStatus } from '../collector/state.js';
import { pullNow } from '../collector/puller.js';
import { pushUpgradeToCollectors } from '../collector/upgradePush.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { resolveBundleBytes } from '../upgrade/bundleSource.js';
import { upgradeManager } from '../upgrade/manager.js';
import {
  listAssignments, addAssignment, updateAssignment, removeAssignment, getResults,
  parseCsv as parseAssignmentsCsv, importAssignments,
} from '../central/assignments.js';

export const adminRouter = Router();

const adminOnly = requireRole('admin');

// 자격증명 디버그 표시용 마스킹 — 평문 비밀번호는 절대 응답에 넣지 않고 길이만 노출한다.
// (계정명/passwordless 여부는 디버그에 유용하므로 유지)
const maskPw = (p) => (p === '' || p == null) ? '(빈 비번/passwordless)' : `•••• (${String(p).length}자)`;

// 서버 분석 공용 필터 술어. 쿼리로 3가지 축을 지원한다:
//   ?vcenterId=<id>      — 그 vCenter의 가상화 장비만 (vcenterId 일치). __unmapped__=vCenter 미지정.
//   ?datacenterId=<id>   — 그 법인(DataCenter)의 모든 장비 (dcOf 일치). __unmapped__=법인 미지정.
//   ?baremetal=1         — vCenter에 속하지 않는 물리(베어메탈) 장비만.
// dcOf: 스캔 등록분은 datacenterId 직접, 그 외는 vCenter→DataCenter 할당으로 해석.
function analysisFilter(req) {
  const scope = {
    vcenterId: String(req?.query?.vcenterId || '').trim(),
    datacenterId: String(req?.query?.datacenterId || '').trim(),
    baremetal: String(req?.query?.baremetal || '') === '1',
  };
  const assign = getDatacenterAssign();
  return (s) => serverInScope(s, scope, assign);
}

// 서버 분석 공용 — iDRAC 서버 목록(OME 제외) + 위 필터. 중앙 로컬 레지스트리만
// (온도 시계열처럼 중앙 직접 수집분에만 의미 있는 뷰용).
function idracServersForAnalysis(req) {
  const pred = analysisFilter(req);
  return loadIdracRegistry().filter((s) => s.type !== 'ome' && pred(s));
}

// 수집기(에이전트) → DataCenter id 매핑. collector.datacenter 라벨/이름/ id를 등록된
// DataCenter(id 또는 name, 대소문자 무시)에 맞춘다. '에이전트로 검색하면 그 법인에 속하게'의 근거.
function collectorToDatacenterMap() {
  const dcs = listDatacenters();
  const map = new Map();
  for (const c of loadCollectors()) {
    map.set(String(c.id), matchDatacenterId([c.datacenter, c.id, c.name], dcs));
  }
  return map;
}

// 원격 서버 + DataCenter 해석: 엣지가 datacenterId를 태깅하지 못한 경우(스캔 시점/버전 차이)에도
// 그 서버를 보고한 수집기(에이전트)의 소속 DataCenter로 자동 귀속시킨다.
function remoteServersResolved() {
  const m = collectorToDatacenterMap();
  return allRemoteServers().map((s) => ({ ...s, datacenterId: s.datacenterId || m.get(String(s.collectorId)) || '' }));
}

// 서버 분석 공용(원격 포함) — 중앙 로컬 + 위임 법인의 원격 인벤토리를 병합(id 중복은 중앙 우선).
// 위임 스캔으로 엣지에만 등록된 서버가 서버 분석에 나타나게 한다. 온도(시계열)만 제외한다.
function analysisServersWithRemote(req) {
  const pred = analysisFilter(req);
  const local = loadIdracRegistry().filter((s) => s.type !== 'ome' && pred(s));
  const seen = new Set(local.map((s) => String(s.id)));
  const remote = remoteServersResolved().filter((s) => !seen.has(String(s.id)) && pred(s));
  return local.concat(remote);
}

// 인벤토리 조회: 원격 서버는 엣지가 실어 보낸 콤팩트 인벤토리(s.inv)를, 중앙 서버는 캐시를 쓴다.
function invForServer(s) {
  return (s && s.remote) ? (s.inv || null) : getIdracInventory(s.id);
}

// ── 긴급중단(Emergency Stop) — 관리자 2명 OTP(2인 승인)로만 켜고/끈다 ──────────
adminRouter.get('/emergency-stop', adminOnly, (_req, res) => res.json(getEmergencyStatus()));

// Body: { action:'stop'|'resume', approvals:[{username,code},{username,code}] }
// 검증: 정확히 2명 · 서로 다른 계정 · 둘 다 admin · 둘 다 현재 OTP 일치.
adminRouter.post('/emergency-stop', adminOnly, (req, res) => {
  const b = req.body || {};
  const action = b.action === 'resume' ? 'resume' : 'stop';
  const approvals = Array.isArray(b.approvals) ? b.approvals : [];
  if (!config.auth.enabled) return res.status(400).json({ ok: false, reason: '인증이 비활성화되어 2인 OTP 승인을 사용할 수 없습니다(AUTH_ENABLED).' });
  if (approvals.length !== 2) return res.status(400).json({ ok: false, reason: '관리자 2명의 OTP 인증이 필요합니다.' });
  const names = approvals.map((a) => String(a?.username || '').trim());
  if (!names[0] || !names[1]) return res.status(400).json({ ok: false, reason: '두 계정의 ID를 모두 입력하세요.' });
  if (names[0].toLowerCase() === names[1].toLowerCase()) return res.status(400).json({ ok: false, reason: '서로 다른 관리자 2명이어야 합니다.' });
  for (const a of approvals) {
    const name = String(a?.username || '').trim();
    const u = getUser(name);
    if (!u) return res.status(400).json({ ok: false, reason: `사용자 '${name}'를 찾을 수 없습니다.` });
    if ((u.role || '') !== 'admin') return res.status(403).json({ ok: false, reason: `'${name}'는 관리자(admin)가 아닙니다.` });
    const v = verifyUserOtp(name, a?.code);
    if (!v.ok) return res.status(403).json({ ok: false, reason: `'${name}' OTP 인증 실패 — ${v.reason}`, needEnroll: v.needEnroll });
  }
  const status = setEmergencyStop(action === 'stop', names);
  logAudit({ user: `${names[0]} + ${names[1]}`, action: action === 'stop' ? '긴급중단 실행(2인 승인)' : '긴급중단 해제(2인 승인)', target: 'emergency-stop', detail: `승인자 ${names.join(', ')}`, ip: req.ip || '' });
  res.json({ ok: true, ...status });
});

// Server operational logs (ring buffer). ?since=<id>&level=info|warn|error
adminRouter.get('/logs', adminOnly, (req, res) => {
  res.json(getLogs({ since: req.query.since, level: req.query.level }));
});

// Data-source + per-vCenter collection errors (why a vCenter won't connect).
// vCenter 중계 경로 단계별 진단 — TCP→TLS→HTTP 어디서 막혔는지. ?vcenterId= 또는 ?host=
adminRouter.get('/vcenter/relay-test', adminOnly, async (req, res) => {
  let host = String(req.query.host || '').trim();
  if (!host && req.query.vcenterId) {
    const vc = (loadVcenterConfig().vcenters || []).find((x) => x.id === req.query.vcenterId);
    if (!vc) return res.status(404).json({ ok: false, reason: '등록된 vCenter가 아닙니다.' });
    host = vc.host;
  }
  if (!host) return res.status(400).json({ ok: false, reason: 'vcenterId 또는 host가 필요합니다.' });
  try { res.json({ ok: true, ...(await probeRelayPath(host, { timeoutMs: 6000 })) }); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 포탈 DB 인벤토리 — 사용 중 모든 데이터 파일의 경로·파일명·용도·크기·증가 추이.
adminRouter.get('/portal-db', adminOnly, (_req, res) => res.json(portalDbReport()));

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
  const r = beginTotpEnroll(req.params.username, req.get('host') || '');
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

// 배포 성공 후, 그 호스트를 중앙에 '수집 서버'로 자동 등록(설치+등록 원클릭).
// collectorToken이 있고 registerCollector!==false 일 때만. 같은 id면 갱신.
function autoRegisterCollector(target, portalPort) {
  if (!target?.collectorToken || target.registerCollector === false) return null;
  const port = Number(portalPort) || 4000;
  const id = (String(target.collectorDatacenter || target.agentName || target.host || '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')) || `col-${target.host}`;
  const url = `http://${target.host}:${port}`;
  const body = { id, name: target.agentName || target.collectorDatacenter || target.host, datacenter: target.collectorDatacenter || '', url, token: target.collectorToken, enabled: true };
  const exists = loadCollectors().find((c) => c.id === id);
  const r = exists ? updateCollector(id, body) : addCollector(body);
  if (r.ok) pullNow().catch(() => {});
  return r.ok ? { registered: true, id, url, updated: !!exists } : { registered: false, reason: r.reason };
}

adminRouter.post('/agent-deploy', adminOnly, async (req, res) => {
  // SSH 포트(target.port)와 포탈 포트(portalPort)를 혼동하지 않도록 분리.
  // portalPort만 install.sh --port 로 전달(예전 버그: SSH 22가 포탈 포트로 들어가 EACCES).
  const { installerPath, portalPort, ...target } = req.body || {};
  const r = await deployAgent(target, { installerPath, port: Number(portalPort) || 4000 });
  if (r.ok) r.collector = autoRegisterCollector(target, portalPort); // 설치 성공 시 중앙에 수집 서버로 자동 등록
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
  if (r.ok) r.collector = autoRegisterCollector(t, t.portalPort); // 설치 성공 시 중앙에 수집 서버로 자동 등록
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
// 에이전트별 수신 트래픽 진단 — 누가 무엇을 얼마나 보내는지(와이어 바이트·push 빈도·페이로드 규모).
// iftop에서 특정 에이전트 트래픽이 비정상적으로 높을 때 원인(큰 페이로드 vs 잦은 push)을 짚어낸다.
adminRouter.get('/central/ingest-stats', adminOnly, (_req, res) => res.json({ ok: true, ...getIngestStats() }));
adminRouter.post('/central/ingest-stats/reset', adminOnly, (req, res) => { resetIngestStats(); logAudit({ user: req.user?.username, action: '수신 트래픽 통계 초기화', target: 'ingest-stats' }); res.json({ ok: true }); });
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

// vCenter별 스캔 대역 저장/삭제 + 즉시 스캔(주기 스캔이 이 대역들을 함께 스캔).
adminRouter.put('/ipam/vc-ranges', adminOnly, (req, res) => {
  const b = req.body || {};
  const r = saveVcRanges(b.vcenterId, { ranges: b.ranges, enabled: b.enabled });
  if (r.ok) { try { rescheduleScanPoller(); } catch { /* */ } }
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/ipam/vc-ranges/:vcenterId', adminOnly, (req, res) => {
  const r = removeVcRanges(req.params.vcenterId);
  res.status(r.ok ? 200 : 404).json(r);
});
adminRouter.post('/ipam/vc-ranges/scan', adminOnly, (_req, res) => {
  const r = startScan({ manual: true });
  res.json({ ...r, status: scanStatus() });
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

// GPU 게스트 수집 진단 — 어느 단계에서 막혔는지(선별 깔때기 + VM별 성공/실패·에러).
// 중앙 본인이 직접 수집하면 local, agent들이 push한 건 agents 로 함께 반환.
adminRouter.get('/gpu-guest/diag', adminOnly, (_req, res) => {
  res.json({ local: getGpuGuestDiag(), agents: getAllGpuGuestDiag() });
});

// 선택한 법인(vCenter)에서 GPU를 패스쓰루로 쓰는 VM 목록 — VM별 자격증명 설정용.
// 패스쓰루 호스트 위의 VM(전원/Tools 무관)을 모두 보여주고, 현재 저장된 VM별 계정 여부도 함께.
adminRouter.get('/gpu-guest/vms', adminOnly, (req, res) => {
  const vcId = req.query.vcenterId;
  if (!vcId) return res.status(400).json({ error: 'vcenterId 필요' });
  const snap = store.get();
  const hostNames = gpuHostIds(snap, vcId);
  const s = loadGpuGuestSettings();
  const saved = (s.vcenters[vcId]?.vms) || {};
  // 실제 수집 상태(게스트에서 읽어온 마지막 값) — vmId 기준.
  const collectedBy = new Map(getGuestGpuVms().map((x) => [x.vmId, x]));
  const vms = (snap.vms || [])
    // 해당 vCenter에서 GPU(패스쓰루·vGPU)를 할당받은 VM(템플릿 제외).
    .filter((v) => v.vcenterId === vcId && !v.template && hostNames.has(v.host) && vmUsesGpu(v))
    .map((v) => {
      const c = collectedBy.get(v.id);
      return {
        id: v.id, name: v.name, host: v.host, cluster: v.cluster || '',
        powerState: v.powerState, toolsStatus: v.toolsStatus || '', guestOS: v.guestOS || '',
        gpu: v.gpu || null,
        hasOwnCred: !!saved[v.id]?.username, ownUsername: saved[v.id]?.username || '', ownPwless: !!saved[v.id]?.passwordless,
        collected: c ? { utilPct: c.utilPct, memUsedPct: c.memUsedPct ?? null, at: c.at } : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ vcenterId: vcId, vcShared: { username: s.vcenters[vcId]?.username || '', hasPassword: !!s.vcenters[vcId]?.password }, vms });
});

// ── 물리(베어메탈) 서버 GPU 수집 — IP+계정으로 SSH nvidia-smi(가상화 안 한 서버) ──────
adminRouter.get('/gpu-physical', adminOnly, (_req, res) => {
  res.json({ servers: listPhysical(), results: getAllPhysicalGpu(), status: physicalPollerStatus() });
});
adminRouter.post('/gpu-physical', adminOnly, (req, res) => {
  const r = addPhysical(req.body || {});
  if (r.ok) pollPhysicalOnce().catch(() => {});
  res.status(r.ok ? 201 : 400).json(r);
});
adminRouter.put('/gpu-physical/:id', adminOnly, (req, res) => {
  const r = updatePhysical(req.params.id, req.body || {});
  if (r.ok) pollPhysicalOnce().catch(() => {});
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/gpu-physical/:id', adminOnly, (req, res) => {
  const r = removePhysical(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.post('/gpu-physical/poll', adminOnly, async (_req, res) => {
  res.json({ ok: true, lastRun: await pollPhysicalOnce() });
});
// IP+ID+PW+소속 vCenter만 받아 SSH 로그인→GPU/OS/호스트명 자동 감지→자동 등록.
// 같은 host가 이미 있으면 갱신. Body { host, username, password, port?, vcenterId? }
adminRouter.post('/gpu-physical/auto-register', adminOnly, async (req, res) => {
  const b = req.body || {};
  const host = String(b.host || '').trim();
  const username = String(b.username || '').trim();
  if (!host || !username) return res.status(400).json({ ok: false, reason: 'IP/호스트와 계정이 필요합니다.' });
  const st = loadGpuGuestSettings();
  const det = await detectPhysicalGpu(host, { username, password: b.password || '' }, { timeoutMs: st.timeoutMs, port: Number(b.port) || 22 });
  if (!det.reachable) return res.status(400).json({ ok: false, reason: `SSH 접속 실패 — ${det.error || '계정/네트워크 확인'}`, detected: det });
  // 로그인은 됐지만 GPU/드라이버 미발견: force가 아니면 등록하지 않고 확인을 유도(프론트가 재확인).
  if (!det.gpuModels.length && !b.force) {
    return res.json({ ok: false, reachable: true, noGpu: true, reason: '로그인은 되었지만 GPU/드라이버를 찾지 못했습니다(nvidia-smi 미설치).', detected: det });
  }
  const os = /microsoft|windows/i.test(det.os) ? 'windows' : 'linux';
  const fields = { name: det.hostname || host, host, port: Number(b.port) || 22, username, password: b.password || '', os, vcenterId: String(b.vcenterId || '').trim(), gpuModels: det.gpuModels, enabled: true };
  const exist = findPhysicalByHost(host);
  let id;
  if (exist) { updatePhysical(exist.id, fields); id = exist.id; }
  else { const r = addPhysical(fields); if (!r.ok) return res.status(400).json({ ok: false, reason: r.reason, detected: det }); id = r.id; }
  pollPhysicalOnce().catch(() => {});
  res.json({ ok: true, id, updated: !!exist, noGpu: !det.gpuModels.length, detected: det });
});

// 여러 IP 일괄 자동 등록 — 대역/CIDR을 펼쳐 각 IP에 SSH 로그인→감지→등록(동시성 제한).
// Body { ips, username, password?, port?, vcenterId?, force? }
adminRouter.post('/gpu-physical/bulk-auto-register', adminOnly, async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  if (!b.ips || !username) return res.status(400).json({ ok: false, reason: 'IP 목록과 계정이 필요합니다.' });
  const { ips: list, errors, truncated } = expandIpList(b.ips);
  const MAX = 512;
  const targets = list.slice(0, MAX);
  if (!targets.length) return res.status(400).json({ ok: false, reason: '유효한 IP가 없습니다.', ipErrors: errors });
  const st = loadGpuGuestSettings();
  const port = Number(b.port) || 22; const password = b.password || ''; const vcenterId = String(b.vcenterId || '').trim(); const force = !!b.force;
  const results = new Array(targets.length);
  let idx = 0;
  const worker = async () => {
    while (idx < targets.length) {
      const i = idx++; const ip = targets[i];
      const det = await detectPhysicalGpu(ip, { username, password }, { timeoutMs: st.timeoutMs, port }).catch((e) => ({ reachable: false, error: e.message, gpuModels: [] }));
      if (!det.reachable) { results[i] = { ip, ok: false, reachable: false, error: det.error || '접속 실패' }; continue; }
      if (!det.gpuModels.length && !force) { results[i] = { ip, ok: false, reachable: true, noGpu: true, host: det.hostname || '' }; continue; }
      const os = /microsoft|windows/i.test(det.os) ? 'windows' : 'linux';
      const fields = { name: det.hostname || ip, host: ip, port, username, password, os, vcenterId, gpuModels: det.gpuModels, enabled: true };
      const exist = findPhysicalByHost(ip);
      if (exist) updatePhysical(exist.id, fields); else addPhysical(fields);
      results[i] = { ip, ok: true, updated: !!exist, noGpu: !det.gpuModels.length, gpuCount: det.gpuModels.length, host: det.hostname || ip };
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, targets.length) }, worker));
  pollPhysicalOnce().catch(() => {});
  const registered = results.filter((r) => r && r.ok).length;
  res.json({ ok: true, total: targets.length, registered, results, ipErrors: errors, truncated: truncated || list.length > MAX });
});

// 단건 SSH 테스트(저장 전 검증 가능) — body { host, username, password?, port?, revealCreds? } 또는 { id }
adminRouter.post('/gpu-physical/test', adminOnly, async (req, res) => {
  const b = req.body || {};
  let host = String(b.host || '').trim(); let username = String(b.username || '').trim(); let password = String(b.password || ''); let port = Number(b.port) || 22;
  if (b.id) { const s = getPhysicalRaw(b.id); if (s) { host = s.host; username = s.username; password = b.password || s.password; port = s.port || 22; } }
  if (!host || !username) return res.status(400).json({ ok: false, reason: 'host, username이 필요합니다.' });
  const st = loadGpuGuestSettings();
  const seed = b.revealCreds ? [{ t: Date.now(), msg: `🔓 자격증명: id=${username} · pw=${maskPw(password)} · 포트=${port}` }] : [];
  try {
    const r = await testVmGuestSsh({ ipAddresses: [host] }, { username, password }, { timeoutMs: st.timeoutMs, port, trace: seed });
    res.json({ ok: true, host, port, ...r });
  } catch (e) { res.json({ ok: false, host, port, login: false, read: false, error: e.message, trace: seed }); }
});


//   { vcenterId, items: [{ vmId, username, password, useShared }] }
// useShared=true 면 법인 공용 계정으로, 아니면 입력한(없으면 저장된 VM별) 계정으로 테스트.
adminRouter.post('/gpu-guest/test', adminOnly, async (req, res) => {
  const { vcenterId, items } = req.body || {};
  const revealCreds = !!req.body?.revealCreds; // 관리자 디버그: 실행 로그에 실제 id/pw 평문 표시(응답에만, 디스크/중앙 미기록)
  if (!vcenterId || !Array.isArray(items) || !items.length) return res.status(400).json({ error: 'vcenterId + items 필요' });
  const snap = store.get();
  const vmById = new Map((snap.vms || []).filter((v) => v.vcenterId === vcenterId).map((v) => [v.id, v]));
  // 호스트명 → 다운로드 후보 호스트(vCenter 실제 IP → ESXi IP → ESXi FQDN).
  const dlByHost = new Map();
  for (const h of snap.hosts || []) if (h.vcenterId === vcenterId) dlByHost.set(h.name, [h.mgmtServerIp, h.mgmtIp, h.name].filter(Boolean));
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
        if (!v) { results[i] = { vmId: it.vmId, login: false, read: false, error: 'VM을 찾을 수 없음', trace: [{ t: Date.now(), msg: '✗ 건너뜀 — VM을 스냅샷에서 찾을 수 없음' }] }; continue; }
        if (v.toolsStatus !== 'RUNNING') { results[i] = { vmId: it.vmId, login: false, read: false, error: 'VMware Tools 미실행', trace: [{ t: Date.now(), msg: `✗ 건너뜀 — VMware Tools 미실행(status=${v.toolsStatus || '?'}) · 게스트 작업 불가` }] }; continue; }
        if (v.powerState !== 'POWERED_ON') { results[i] = { vmId: it.vmId, login: false, read: false, error: 'VM 전원 꺼짐', trace: [{ t: Date.now(), msg: '✗ 건너뜀 — VM 전원 꺼짐' }] }; continue; }
        const isWindows = /windows/i.test(v.guestOS || '');
        // 자격증명 결정: useShared면 법인 공용(OS별), 아니면 입력값(빈 비번은 저장값) → 없으면 해석값.
        const vcShared = s.vcenters[vcenterId] || {};
        const sharedForOs = (isWindows && vcShared.winUsername)
          ? { username: vcShared.winUsername, password: vcShared.winPassword || '' }
          : (vcShared.username ? { username: vcShared.username, password: vcShared.password || '' } : null);
        let creds;
        if (it.useShared) creds = sharedForOs;
        // passwordless = 비번 없는 계정 → 빈 비번으로 인증(저장값으로 폴백하지 않음).
        else if (it.username) creds = { username: it.username, password: it.passwordless ? '' : (it.password || (vcShared.vms?.[it.vmId]?.password || '')), passwordless: !!it.passwordless };
        else creds = resolveVmCreds(s, vcenterId, it.vmId, isWindows);
        if (!creds || !creds.username) { results[i] = { vmId: it.vmId, login: false, read: false, error: '계정 없음', trace: [{ t: Date.now(), msg: '✗ 건너뜀 — 사용할 계정 없음(공용/별도 계정 미설정)' }] }; continue; }
        const moref = String(v.id).split(':').slice(1).join(':');
        const dlHosts = dlByHost.get(v.host) || [];
        const method = ['guestops', 'ssh', 'auto'].includes(req.body?.method) ? req.body.method : (s.collectMethod || 'guestops');
        // 디버그(revealCreds): 실제 전송되는 id/pw를 평문으로 trace에 기록(이 응답에만, 디스크/중앙 미기록).
        const seed = revealCreds ? [{ t: Date.now(), msg: `🔓 자격증명: id=${creds.username} · pw=${maskPw(creds.password)} · 방식=${method} · 출처=${it.useShared ? '공용' : (it.passwordless ? '별도(비번없음)' : '별도입력')}` }] : [];
        let r;
        if (method === 'ssh') {
          r = await testVmGuestSsh(v, creds, { timeoutMs: s.timeoutMs, port: s.sshPort, trace: seed }).catch((e) => ({ login: false, read: false, error: e.message, trace: seed.concat({ t: Date.now(), msg: `✗ 예외: ${e.message}` }) }));
        } else if (method === 'auto') {
          // 수집과 동일: VMware Tools 게스트작업 먼저 → 실패 시 SSH 폴백.
          r = await testVmGuest(c, moref, creds, { isWindows, timeoutMs: s.timeoutMs, dlHosts, trace: seed }).catch(() => null);
          if (!r || !r.read) {
            const seed2 = (r?.trace || seed).concat({ t: Date.now(), msg: '게스트작업 미수집 → SSH로 폴백' });
            r = await testVmGuestSsh(v, creds, { timeoutMs: s.timeoutMs, port: s.sshPort, trace: seed2 }).catch((e) => ({ login: false, read: false, error: e.message, trace: seed2 }));
          }
        } else {
          r = await testVmGuest(c, moref, creds, { isWindows, timeoutMs: s.timeoutMs, dlHosts, trace: seed }).catch((e) => ({ login: false, read: false, error: e.message, trace: seed.concat({ t: Date.now(), msg: `✗ 예외: ${e.message}` }) }));
        }
        results[i] = { vmId: it.vmId, ...r };
      }
    });
    await Promise.all(workers);
  } catch (e) {
    return res.status(500).json({ error: `vCenter 로그인 실패: ${e.message}` });
  } finally { try { await c?.logout(); } catch { /* */ } }
  res.json({ results });
});

// 빠른 단일 테스트(SSH) — VM 목록 로딩/ vCenter 없이 IP+계정만으로 nvidia-smi 1대 테스트.
// Body: { ip, username, password?, port?, revealCreds? }
adminRouter.post('/gpu-guest/test-ssh', adminOnly, async (req, res) => {
  const b = req.body || {};
  const ip = String(b.ip || '').trim();
  const username = String(b.username || '').trim();
  if (!ip || !username) return res.status(400).json({ error: 'ip, username(계정)이 필요합니다.' });
  const s = loadGpuGuestSettings();
  const port = Number(b.port) || s.sshPort || 22;
  const creds = { username, password: String(b.password || ''), privateKey: b.privateKey || undefined };
  const seed = b.revealCreds ? [{ t: Date.now(), msg: `🔓 자격증명: id=${username} · pw=${maskPw(b.password)} · 포트=${port}` }] : [];
  try {
    const r = await testVmGuestSsh({ ipAddresses: [ip] }, creds, { timeoutMs: s.timeoutMs, port, trace: seed });
    res.json({ ip, port, ...r });
  } catch (e) {
    res.json({ ip, port, login: false, read: false, error: e.message, trace: seed.concat({ t: Date.now(), msg: `✗ 예외: ${e.message}` }) });
  }
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
  res.json({ dataSource: getDataSource(), vcenters: sortByOrder(listRegistry()) }); // 저장된 표시 순서 적용
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

// 등록된 모든 vCenter 연결을 병렬로 한 번에 테스트(느린 1곳이 전체를 막지 않게 per-vCenter 독립).
// ?only=enabled 면 '수집 사용'인 것만. 실패 시 중계 경로(TCP·TLS·HTTP) 단계 진단을 자동 첨부해
// 'TCP부터 안 됨(경로/방화벽)' vs 'TCP는 되는데 TLS만 막힘(HAProxy backend 끊김)'을 바로 구분.
adminRouter.post('/vcenters/test-all', adminOnly, async (req, res) => {
  const onlyEnabled = String(req.query.only || (req.body || {}).only || '') === 'enabled';
  const withRelay = String(req.query.relay || (req.body || {}).relay || 'true') !== 'false';
  let list = sortByOrder(listRegistry());
  if (onlyEnabled) list = list.filter((v) => v.enabled !== false);
  const results = await Promise.all(list.map(async (vc) => {
    const r = await testConnection({ id: vc.id }).catch((e) => ({ ok: false, reason: e.message }));
    const base = { id: vc.id, name: vc.name, host: vc.host, enabled: vc.enabled !== false, collectMode: vc.collectMode || 'direct', ...r };
    // 실패 시에만 경로 진단(짧은 6s 단계 타임아웃, 병렬) — 어디서 막혔는지 즉시 노출.
    if (!r.ok && withRelay) base.relay = await probeRelayPath(vc.host, { timeoutMs: 6000 }).catch(() => null);
    return base;
  }));
  res.json({ ok: true, testedAt: Date.now(), total: results.length, okCount: results.filter((r) => r.ok).length, results });
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

// 이상동작 탐지(동시 다운) — vCenter별 임계 설정.
adminRouter.get('/anomaly', adminOnly, (_req, res) => res.json(getAnomalySettings()));
adminRouter.put('/anomaly', adminOnly, (req, res) => res.json({ ok: true, settings: saveAnomalySettings(req.body || {}) }));

// 세션 보안(유휴 자동 로그아웃) — 조회는 자유, 변경은 OTP 재인증 + 감사 기록.
adminRouter.get('/security/session', adminOnly, (_req, res) => res.json(loadSessionSecurity()));
adminRouter.put('/security/session', adminOnly, (req, res) => {
  const username = req.user?.username || 'unknown';
  // 인증이 켜져 있으면 변경 시 본인 OTP 재인증을 강제(누가 바꿨는지 신원 확정 + 무단변경 방지).
  if (config.auth.enabled) {
    const v = verifyUserOtp(username, req.body?.otp);
    if (!v.ok) return res.status(401).json({ ok: false, reason: v.reason, needEnroll: !!v.needEnroll });
  }
  const before = loadSessionSecurity();
  let after;
  try {
    after = saveSessionSecurity({ idleLogoutEnabled: req.body?.idleLogoutEnabled, idleLogoutMin: req.body?.idleLogoutMin, settingsOwners: req.body?.settingsOwners });
  } catch (e) { return res.status(400).json({ ok: false, reason: e.message }); }
  const fmt = (s) => (s.idleLogoutEnabled ? `${s.idleLogoutMin}분` : '비활성');
  const parts = [];
  if (fmt(before) !== fmt(after)) parts.push(`유휴 로그아웃 ${fmt(before)} → ${fmt(after)}`);
  if (before.settingsOwners.join(',') !== after.settingsOwners.join(',')) parts.push(`설정 소유 계정 [${before.settingsOwners.join(', ')}] → [${after.settingsOwners.join(', ')}]`);
  logAudit({ user: username, action: '세션 보안/설정 접근 변경', target: 'security/session', detail: parts.join(' · ') || '변경 없음', ip: req.ip || '' });
  res.json({ ok: true, settings: after });
});

// 실제 OS 인벤토리(게스트에서 읽은 실제 설치 OS) — 조회·설정·즉시 실행·결과·CSV.
adminRouter.get('/os-scan', adminOnly, (_req, res) => res.json(osScanStatus()));
adminRouter.put('/os-scan/settings', adminOnly, (req, res) => res.json({ ok: true, ...osScanStatus(), settings: saveOsScanSettings(req.body || {}) }));
adminRouter.post('/os-scan/run', adminOnly, async (req, res) => res.json(await runOsScanNow(req.body?.vcenterId || '')));
adminRouter.get('/os-scan/results', adminOnly, (req, res) => {
  const rows = getOsResults({ vcenterId: req.query.vcenterId || '', mismatch: req.query.mismatch === '1' });
  res.json({ total: rows.length, items: rows.slice(0, 10000) });
});
adminRouter.get('/os-scan/results.csv', adminOnly, (req, res) => {
  const rows = getOsResults({ vcenterId: req.query.vcenterId || '', mismatch: req.query.mismatch === '1' });
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['vm', 'vcenter', 'cluster', 'host', 'esxi_guest_os', 'real_os', 'real_version', 'family', 'kernel', 'mismatch', 'scanned_at', 'error'];
  const lines = [head.join(',')];
  for (const r of rows) lines.push([r.vmName, r.vcenterId, r.cluster, r.host, r.esxiGuestOS, r.os, r.osVersion, r.family, r.kernel, r.mismatch ? 'Y' : 'N', new Date(r.at).toISOString(), r.error].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="real-os-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

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
// 임의 파일 읽기 방지: configDir 하위(.json) 또는 알려진 표준 위치만 허용.
function isAllowedImportPath(p) {
  const abs = path.resolve(String(p));
  if (!abs.endsWith('.json')) return false;
  const allowDirs = [path.resolve(config.configDir), '/etc/vmware-portal', '/opt/vmware-portal/app/server/config'];
  return allowDirs.some((d) => abs === d || abs.startsWith(d + path.sep));
}
adminRouter.post('/vcenters/import-file', adminOnly, (req, res) => {
  const { path: filePath, mode } = req.body || {};
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ ok: false, reason: '파일 경로가 필요합니다.' });
  if (!isAllowedImportPath(filePath)) return res.status(400).json({ ok: false, reason: '허용된 경로(설정 디렉터리의 .json)만 불러올 수 있습니다.' });
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
// 중앙 로컬 레지스트리 + 위임 법인의 원격 서버(엣지 수집분)를 병합해 반환한다(id 중복은 중앙 우선).
// 원격 서버는 remote:true로 표시(프론트가 구분/상세 처리). 서버 자격증명은 애초에 실려오지 않는다.
adminRouter.get('/idrac', adminOnly, (_req, res) => {
  const local = listServers();
  const seen = new Set(local.map((s) => String(s.id)));
  const remote = remoteServersResolved()
    .filter((s) => !seen.has(String(s.id)))
    .map((s) => ({ id: s.id, name: s.name, host: s.host, serviceTag: s.serviceTag || '', model: s.model || s.inv?.system?.model || '', vcenterId: s.vcenterId || '', datacenterId: s.datacenterId || '', type: s.type || 'idrac', remote: true, collectorId: s.collectorId, hasInventory: !!s.inv }));
  res.json({ servers: local.concat(remote), poller: getPollerStatus() });
});

// Register a server, then poll immediately so power shows up right away.
adminRouter.post('/idrac', adminOnly, async (req, res) => {
  const result = addServer(req.body || {});
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 201 : 400).json(result);
});

// NOTE: 파라미터 라우트 PUT/DELETE '/idrac/:id'는 '/idrac/scan-ranges'·'/idrac/power-settings'
// 같은 리터럴 라우트를 가리지 않도록 이 섹션의 '맨 끝'(모든 리터럴 라우트 뒤)에 정의한다.

// Test connectivity + read current power for a server (new or saved by id).
adminRouter.post('/idrac/test', adminOnly, async (req, res) => {
  res.json(await testServer(req.body || {}));
});

// Trigger an immediate poll of all servers.
adminRouter.post('/idrac/poll', adminOnly, async (_req, res) => {
  res.json({ ok: true, lastRun: await pollNow() });
});

// 전력 집계 표시 설정 — excludeUnmapped: vCenter 미매핑 측정 전력을 총합/보고/목록에서 제외.
adminRouter.get('/idrac/power-settings', adminOnly, (_req, res) => res.json({ ok: true, settings: loadPowerSettings() }));
adminRouter.put('/idrac/power-settings', adminOnly, async (req, res) => {
  const settings = savePowerSettings(req.body || {});
  await store.refresh().catch(() => {}); // Overview 총합/보고 즉시 반영
  logAudit({ user: req.user?.username, action: '전력 집계 설정 변경', target: `미매핑 제외=${settings.excludeUnmapped}` });
  res.json({ ok: true, settings });
});

// 오류/고아 전력 데이터 정리 — '전력 보고' 수가 등록 수보다 비정상적으로 많을 때 정리한다.
// body.mode='stale'(기본): 등록 해제된 OME/수집서버 잔여 + 고아 DB 행만 삭제(활성 소스 보존).
// body.mode='all'(강제): 등록 여부 무관하게 OME 캐시·원격 호스트 전체를 비우고 등록 iDRAC 외 DB 행 삭제.
//   (등록된 OME/수집기가 있으면 다음 폴링에 다시 채워질 수 있음 = 출처가 실데이터.) 정리 후 분해 결과 반환.
adminRouter.post('/idrac/power-purge', adminOnly, async (req, res) => {
  try {
    const mode = (req.body || {}).mode === 'all' ? 'all' : 'stale';
    const before = await measuredPowerBreakdown().catch(() => null);
    const r = await purgeStalePower({ mode });
    const after = await measuredPowerBreakdown().catch(() => null);
    logAudit({ user: req.user?.username, action: `전력 데이터 정리(${mode === 'all' ? '강제 전체' : '고아 삭제'})`, target: `DB ${r.dbRemoved} · OME ${r.omeCleared} · 원격 ${r.remoteCleared} · ${before?.total ?? '?'}→${after?.total ?? '?'}대` });
    res.json({ ok: true, ...r, beforeTotal: before?.total ?? null, afterTotal: after?.total ?? null, breakdown: after });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 하드웨어 집계 — 모든 데이터센터(법인)의 iDRAC 수집 인벤토리를 모델/CPU/메모리/GPU 종류별로
// 집계한다. ?datacenterId= 로 특정 법인만. 서버의 법인은 datacenterId(스캔 등록) 또는
// vCenter→DataCenter 할당으로 해석. 응답: { totalServers, collected, missing, byModel/byCpu/byMemory/byGpu }.
adminRouter.get('/idrac/hardware-summary', adminOnly, (req, res) => {
  const dcFilter = String(req.query.datacenterId || '').trim();
  const assign = getDatacenterAssign();
  const dcOf = (s) => String(s.datacenterId || assign[String(s.vcenterId || '')] || '');
  // 중앙 로컬 + 위임 법인 원격 서버 병합(id 중복은 중앙 우선).
  const localAll = loadIdracRegistry().filter((s) => s.type !== 'ome');
  const seen = new Set(localAll.map((s) => String(s.id)));
  const merged = localAll.concat(remoteServersResolved().filter((s) => !seen.has(String(s.id))));
  const servers = merged.filter((s) => (!dcFilter || dcOf(s) === (dcFilter === '__unmapped__' ? '' : dcFilter)) && (dcFilter !== '__unmapped__' || !dcOf(s)));
  const byModel = new Map(), byCpu = new Map(), byMem = new Map(), byGpu = new Map();
  let collected = 0, missing = 0, totalGpuCards = 0;
  const bump = (map, key, by = 1) => { const k = String(key || '').trim(); if (!k) return; map.set(k, (map.get(k) || 0) + by); };
  for (const s of servers) {
    const inv = invForServer(s);
    if (!inv || !inv.collectedAt) { missing++; continue; }
    collected++;
    bump(byModel, inv.system?.model || '미상');
    const cpu = inv.cpu || {};
    const cpuLabel = (cpu.model || '미상') + (cpu.count ? ` ×${cpu.count}` : '');
    bump(byCpu, cpuLabel);
    const gib = inv.memory?.totalGiB;
    if (gib != null && Number.isFinite(Number(gib))) bump(byMem, `${Math.round(Number(gib))} GiB`);
    for (const g of (inv.gpus || [])) { const m = (g.model || g.name || '').trim(); if (m) { bump(byGpu, m); totalGpuCards++; } }
  }
  const toArr = (map, numericKey = false) => [...map.entries()].map(([key, count]) => ({ key, count }))
    .sort((a, b) => (numericKey ? (parseInt(b.key) - parseInt(a.key)) : 0) || b.count - a.count || String(a.key).localeCompare(String(b.key), undefined, { numeric: true }));
  res.json({
    ok: true, datacenterId: dcFilter, totalServers: servers.length, collected, missing, totalGpuCards,
    byModel: toArr(byModel), byCpu: toArr(byCpu), byMemory: toArr(byMem, true), byGpu: toArr(byGpu),
  });
});

// 서버 분석 — 전체 iDRAC 서버의 최신 온도센서(CPU/GPU/Inlet/Exhaust 등) 평탄화(정렬용).
adminRouter.get('/idrac/temps', adminOnly, (req, res) => {
  const servers = idracServersForAnalysis(req);
  const rows = [];
  const serverList = [];
  let missing = 0;
  for (const s of servers) {
    const latest = getSensorSeries(s.id).latest;
    const temps = latest?.temps || {};
    if (!Object.keys(temps).length) { missing++; continue; }
    const list = Object.entries(temps).map(([name, celsius]) => ({ name, celsius }));
    const serviceTag = s.serviceTag || getIdracInventory(s.id)?.system?.serviceTag || '';
    serverList.push({ id: s.id, name: s.name, serviceTag, vcenterId: s.vcenterId || '', at: latest.t, maxC: Math.max(...list.map((x) => x.celsius)), temps: list });
    for (const { name, celsius } of list) {
      rows.push({ server: s.name, serverId: s.id, serviceTag, vcenterId: s.vcenterId || '', sensor: name, celsius, at: latest.t });
    }
  }
  rows.sort((a, b) => b.celsius - a.celsius);
  res.json({ rows, servers: serverList, sampledServers: serverList.length, totalServers: servers.length, missing, maxCelsius: rows.length ? rows[0].celsius : null });
});

// 서버 분석 — 서버 모델(R760/R770 등)별로 펌웨어/드라이버 버전 분포(버전별 설치 서버 수).
adminRouter.get('/idrac/firmware-inventory', adminOnly, (req, res) => {
  const CAT_ORDER = ['iDRAC', 'BIOS', 'NIC', 'HBA', 'Storage', 'GPU', 'PSU', 'CPLD', 'Disk', 'Driver', '기타'];
  const servers = analysisServersWithRemote(req);
  const models = new Map(); // model -> { servers:Set, cats: Map<cat, Map<version, Set<serverName>>> }
  const missing = [];
  for (const s of servers) {
    const inv = invForServer(s);
    if (!inv) { missing.push({ id: s.id, name: s.name }); continue; }
    const model = (inv.system?.model || '미상').trim() || '미상';
    let m = models.get(model);
    if (!m) { m = { model, servers: new Set(), cats: new Map() }; models.set(model, m); }
    const sname = s.name || s.id;
    m.servers.add(sname);
    const add = (cat, version) => {
      if (!version) return;
      let c = m.cats.get(cat); if (!c) { c = new Map(); m.cats.set(cat, c); }
      let v = c.get(version); if (!v) { v = new Set(); c.set(version, v); }
      v.add(sname);
    };
    add('iDRAC', inv.idrac?.firmwareVersion);
    add('BIOS', inv.bios?.version || inv.system?.biosVersion);
    for (const f of (inv.firmware || [])) add(f.type || '기타', f.version);
  }
  const out = [...models.values()].map((m) => ({
    model: m.model,
    serverCount: m.servers.size,
    categories: [...m.cats.entries()].map(([category, vmap]) => ({
      category,
      versions: [...vmap.entries()].map(([version, set]) => ({ version, count: set.size, servers: [...set].sort() })).sort((a, b) => b.count - a.count),
    })).sort((a, b) => (CAT_ORDER.indexOf(a.category) + 1 || 99) - (CAT_ORDER.indexOf(b.category) + 1 || 99)),
  })).sort((a, b) => b.serverCount - a.serverCount);
  res.json({ models: out, missing, totalServers: servers.length, collectedServers: servers.length - missing.length });
});

// 서버 분석 — 모든 iDRAC가 수집한 GPU를 모델별로 집계(어떤 모델 몇 장, 어느 서버).
adminRouter.get('/idrac/gpu-inventory', adminOnly, (req, res) => {
  const servers = analysisServersWithRemote(req);
  const byModel = new Map();
  const serverList = [];
  const missing = [];
  let collected = 0;
  for (const s of servers) {
    const inv = invForServer(s);
    if (!inv) { missing.push({ id: s.id, name: s.name }); continue; }
    collected++;
    const gpus = inv.gpus || [];
    const serviceTag = s.serviceTag || inv.system?.serviceTag || '';
    serverList.push({ id: s.id, name: s.name, serviceTag, vcenterId: s.vcenterId || '', host: (s.host || '').replace(/^https?:\/\//, ''), gpuCount: gpus.length, gpus });
    for (const g of gpus) {
      const model = (g.model || '미상').trim() || '미상';
      const e = byModel.get(model) || { model, count: 0, servers: new Map() };
      e.count++;
      const sv = e.servers.get(s.id) || { id: s.id, name: s.name, serviceTag, vcenterId: s.vcenterId || '', count: 0 };
      sv.count++; e.servers.set(s.id, sv);
      byModel.set(model, e);
    }
  }
  // 추천: 물리(베어메탈) GPU 서버도 같은 모델 집계에 합친다(source='physical').
  const vcFilter = String(req.query.vcenterId || '').trim();
  let physServers = listPhysical();
  if (vcFilter) physServers = physServers.filter((s) => (vcFilter === '__unmapped__' ? !s.vcenterId : s.vcenterId === vcFilter));
  let physCount = 0;
  for (const s of physServers) {
    const gms = s.gpuModels || [];
    if (!gms.length) continue;
    physCount++;
    serverList.push({ id: s.id, name: s.name, serviceTag: '', vcenterId: s.vcenterId || '', host: s.host, gpuCount: gms.length, source: 'physical', gpus: gms.map((m) => ({ model: m })) });
    for (const gm of gms) {
      const model = (gm || '미상').trim() || '미상';
      const e = byModel.get(model) || { model, count: 0, servers: new Map() };
      e.count++;
      const key = `phys:${s.id}`;
      const sv = e.servers.get(key) || { id: s.id, name: s.name, serviceTag: '', vcenterId: s.vcenterId || '', source: 'physical', count: 0 };
      sv.count++; e.servers.set(key, sv);
      byModel.set(model, e);
    }
  }
  const models = [...byModel.values()]
    .map((e) => ({ model: e.model, count: e.count, serverCount: e.servers.size, servers: [...e.servers.values()].sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.count - a.count);
  res.json({
    totalGpus: models.reduce((a, b) => a + b.count, 0),
    models,
    servers: serverList.sort((a, b) => b.gpuCount - a.gpuCount),
    collectedServers: collected, totalServers: servers.length,
    physicalServers: physCount,
    missing,
  });
});

// 서버 상세 인벤토리(iDRAC/BIOS/드라이버 버전 등). 캐시 우선, ?refresh=1이면 즉시 재수집.
adminRouter.get('/idrac/:id/inventory', adminOnly, async (req, res) => {
  const s = loadIdracRegistry().find((x) => x.id === req.params.id);
  if (!s) {
    // 위임 법인의 원격 서버 — 중앙이 직접 못 닿으므로 엣지가 실어보낸 인벤토리를 그대로 반환(재수집 불가).
    const rs = findRemoteServer(req.params.id);
    if (rs) return res.json({ ok: true, fresh: false, remote: true, collectorId: rs.collectorId, inventory: rs.inv || null });
    return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });
  }
  if (s.type === 'ome') return res.status(400).json({ ok: false, reason: 'OME 소스는 상세 인벤토리를 지원하지 않습니다(iDRAC 직접만).' });
  if (req.query.refresh === '1') {
    try { return res.json({ ok: true, fresh: true, inventory: await fetchIdracInventory(s) }); }
    catch (e) { return res.status(502).json({ ok: false, reason: e.message }); }
  }
  const inv = getIdracInventory(s.id);
  res.json({ ok: true, fresh: false, inventory: inv?.data || inv || null });
});

// 온도센서 + CPU 사용량 시계열(차트용). ?minutes=N 으로 최근 구간만. ?live=1 즉시 1샘플 수집.
adminRouter.get('/idrac/:id/sensors', adminOnly, async (req, res) => {
  const s = loadIdracRegistry().find((x) => x.id === req.params.id);
  if (!s) {
    // 위임 법인 원격 서버: 중앙에 시계열이 없음(온도 동기화는 후속). 상세 팝업이 에러나지 않게 빈 응답.
    if (findRemoteServer(req.params.id)) return res.json({ ok: true, remote: true, latest: null, series: [], live: null });
    return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });
  }
  if (s.type === 'ome') return res.status(400).json({ ok: false, reason: 'OME 소스는 센서 시계열을 지원하지 않습니다.' });
  let live = null;
  if (req.query.live === '1') {
    try { live = await fetchIdracSensors(s); } catch (e) { live = { error: e.message }; }
  }
  const minutes = Math.max(0, Math.min(1440, Number(req.query.minutes) || 0));
  res.json({ ok: true, ...getSensorSeries(s.id, { minutes }), live, intervalMs: getPollerStatus().intervalMs });
});

// iDRAC에서 GPU 사용률 수집 가능 여부 실측 확인(GPU 목록 + 텔레메트리 리포트).
adminRouter.get('/idrac/:id/gpu-probe', adminOnly, async (req, res) => {
  const s = loadIdracRegistry().find((x) => x.id === req.params.id);
  if (!s) {
    // 위임 법인 원격 서버: 중앙이 iDRAC에 직접 못 닿아 실시간 프로브 불가(현장 에이전트에서 수행).
    if (findRemoteServer(req.params.id)) return res.status(400).json({ ok: false, reason: '위임 법인의 원격 서버는 중앙에서 실시간 GPU 프로브를 할 수 없습니다(현장 에이전트가 수집). 인벤토리의 GPU 목록을 참고하세요.' });
    return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });
  }
  if (s.type === 'ome') return res.status(400).json({ ok: false, reason: 'OME 소스는 GPU 프로브를 지원하지 않습니다(iDRAC 직접만).' });
  try { res.json({ ok: true, ...(await probeGpuTelemetry(s)) }); }
  catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
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
// identity). No writes. Body: { ips, username, password, agent? }
// agent 미지정/'__local__' = 이 포탈에서 직접 스캔(동기). 그 외 = 해당 에이전트에 위임.
adminRouter.post('/idrac/scan', adminOnly, async (req, res) => {
  const { ips, username, password } = req.body || {};
  const agent = String(req.body?.agent || '').trim();
  if (!ips) return res.status(400).json({ ok: false, reason: 'IP 대역을 입력하세요.' });
  if (!username || !password) return res.status(400).json({ ok: false, reason: 'iDRAC 계정/비밀번호가 필요합니다.' });

  // 에이전트 위임 스캔(원격 사이트 iDRAC에 중앙이 직접 못 닿는 경우).
  if (agent && agent !== '__local__') {
    if (!config.central.token) return res.status(400).json({ ok: false, reason: '중앙(CENTRAL_TOKEN) 미설정 — 에이전트 위임 스캔을 사용할 수 없습니다.' });
    // noRegister: 스캔만 하고 등록은 UI 확인 후 별도 '등록' 잡으로(자동등록 안 함).
    const reqId = enqueueIdracScan(agent, { ips, username, password, vcenterId: String(req.body?.vcenterId || '').trim(), noRegister: true });
    if (!reqId) return res.status(429).json({ ok: false, reason: '대기 중인 스캔 잡이 너무 많습니다. 잠시 후 다시 시도하세요.' });
    return res.json({ ok: true, delegated: true, agent, reqId });
  }

  try {
    const result = await scanForIdracs({ ips, username, password });
    res.json({ ok: true, delegated: false, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message });
  }
});

// 위임 스캔 결과 폴링. Query: reqId
adminRouter.get('/idrac/scan-result', adminOnly, (req, res) => {
  res.json(getIdracScanResult(String(req.query.reqId || '')));
});

// 위임 스캔에 사용할 수 있는 에이전트 이름 목록(중앙에 보고/등록된 에이전트들).
adminRouter.get('/idrac/scan-agents', adminOnly, (_req, res) => {
  const names = new Set();
  for (const k of Object.keys(getAllAgentConfigs() || {})) if (k) names.add(k);
  for (const x of listInventory()) if (x.agent) names.add(x.agent);
  for (const x of getAllGpuGuestDiag()) if (x.agent) names.add(x.agent);
  for (const a of listAssignments()) if (a.agent) names.add(a.agent);
  for (const k of Object.keys(getResults() || {})) if (k) names.add(k);
  res.json({ agents: [...names].sort(), centralEnabled: Boolean(config.central.token) });
});

// Register iDRACs found by a scan, applying the shared credentials, then poll.
// Body: { found:[...], username, password, mode?, vcenterId?, agent? }
// mode: 'merge'(기본) | 'replace'(전체 교체) | 'replace-vcenter'(소속 vCenter만 교체).
// agent 지정(위임): 에이전트가 현지에 등록(중앙 못 닿는 대역) → reqId 반환, UI가 폴링.
const normIdracMode = (m) => (['replace', 'replace-vcenter', 'merge'].includes(m) ? m : 'merge');
adminRouter.post('/idrac/register-scanned', adminOnly, (req, res) => {
  const { found, username, password, mode, vcenterId, agent } = req.body || {};
  const ag = String(agent || '').trim();
  if (ag && ag !== '__local__') {
    if (!config.central.token) return res.status(400).json({ ok: false, reason: '중앙(CENTRAL_TOKEN) 미설정 — 위임 등록을 사용할 수 없습니다.' });
    const reqId = enqueueIdracRegister(ag, { found, username, password, vcenterId: vcenterId || '', mode: normIdracMode(mode) });
    if (!reqId) return res.status(429).json({ ok: false, reason: '등록할 iDRAC가 없거나 대기 잡이 너무 많습니다.' });
    return res.json({ ok: true, delegated: true, agent: ag, reqId });
  }
  const result = registerScanned(found, username, password, normIdracMode(mode), vcenterId || '');
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// ---- vCenter별 iDRAC 스캔 대역 + 주기 자동 발견(IPMS의 'vCenter별 스캔 대역'과 동일 흐름) ----
// 각 vCenter에 iDRAC IP 대역 + 계정을 저장하면, 주기 스캐너가 그 대역을 돌며 Dell iDRAC을
// 발견해 해당 vCenter로 자동 등록한다. 비밀번호는 응답에서 마스킹된다.
adminRouter.get('/idrac/scan-ranges', adminOnly, (_req, res) => {
  res.json({ ok: true, ranges: listScanRanges(), status: idracScanStatus(), centralEnabled: Boolean(config.central.token) });
});
// 저장/수정. Body: { datacenterId, ranges?, username?, password?, agent?, enabled?, mode? }
// (구버전 클라이언트 호환: vcenterId로 와도 datacenterId로 처리)
adminRouter.put('/idrac/scan-ranges', adminOnly, (req, res) => {
  const b = req.body || {};
  const dcId = b.datacenterId || b.vcenterId;
  const r = saveScanRanges(dcId, b);
  if (r.ok) logAudit({ user: req.user?.username, action: 'iDRAC 스캔 대역 저장', target: `${dcId} (대역 ${(r.ranges || []).length}개${r.enabled ? '' : ', 비활성'})` });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/idrac/scan-ranges/:datacenterId', adminOnly, (req, res) => {
  const r = removeScanRanges(req.params.datacenterId);
  if (r.ok) logAudit({ user: req.user?.username, action: 'iDRAC 스캔 대역 삭제', target: req.params.datacenterId });
  res.status(r.ok ? 200 : 404).json(r);
});
// 지금 스캔(비동기). Body: { datacenterId? } 미지정 시 enabled인 전체 대역.
adminRouter.post('/idrac/scan-ranges/scan', adminOnly, (req, res) => {
  const datacenterId = String(req.body?.datacenterId || req.body?.vcenterId || '').trim();
  const r = startIdracScanNow(datacenterId ? { datacenterId } : {});
  logAudit({ user: req.user?.username, action: 'iDRAC 대역 즉시 스캔', target: datacenterId || '(전체)' });
  res.status(r.ok ? 200 : 400).json({ ...r, status: idracScanStatus() });
});
// 진행 상태(가벼운 폴링용).
adminRouter.get('/idrac/scan-ranges/status', adminOnly, (_req, res) => res.json({ ok: true, status: idracScanStatus() }));

// 스캔 현황 — 주기 스캐너 상태 + 진행 중·최근 위임 스캔/등록 잡 목록(어디서든 진행 확인용).
// 위임 스캔으로 에이전트 현지 등록된 전력은 '원격 수집(collector)'로 반영되므로, 스캔 에이전트가
// 수집 서버로 등록돼 있는지 UI가 진단할 수 있게 수집 서버 요약(상태 포함)도 함께 반환한다.
adminRouter.get('/idrac/scan-jobs', adminOnly, (_req, res) => {
  const st = allCollectorStatus();
  const collectors = listCollectors().map((c) => ({
    id: c.id, name: c.name, datacenter: c.datacenter || '', enabled: c.enabled !== false,
    ok: st[c.id]?.ok ?? null, hosts: st[c.id]?.ok ? (st[c.id]?.hosts ?? 0) : 0, at: st[c.id]?.at || null, error: st[c.id]?.error || null,
  }));
  res.json({ ok: true, status: idracScanStatus(), jobs: listIdracScanJobs(), collectors, centralEnabled: Boolean(config.central.token) });
});

// 서버 일괄 삭제. Body: { all:true } 또는 { vcenterId } (빈 문자열=미지정 서버 삭제).
adminRouter.post('/idrac/delete', adminOnly, (req, res) => {
  const b = req.body || {};
  const result = b.all
    ? deleteServers({ all: true })
    : (Object.prototype.hasOwnProperty.call(b, 'vcenterId')
      ? deleteServers({ vcenterId: b.vcenterId })
      : { ok: false, reason: 'all=true 또는 vcenterId가 필요합니다.' });
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// 다수 iDRAC 서버의 소속 vCenter 일괄 지정/해제. Body: { ids?:[], vcenterId, all? }
// ids 미지정 + all=true → 전체 적용. 빈 vcenterId = 지정 해제(이름/태그 매칭으로 복귀).
adminRouter.post('/idrac/assign-vcenter', adminOnly, (req, res) => {
  const b = req.body || {};
  const ids = b.all ? null : (Array.isArray(b.ids) ? b.ids : []);
  if (!b.all && (!ids || !ids.length)) return res.status(400).json({ ok: false, reason: '대상(ids) 또는 all=true가 필요합니다.' });
  const result = assignVcenter({ ids, vcenterId: b.vcenterId || '' });
  if (result.ok) pollNow().catch(() => {});
  res.json(result);
});

// 파라미터 라우트는 반드시 위의 모든 리터럴 '/idrac/...' 라우트 뒤에 둔다. 그렇지 않으면
// PUT/DELETE '/idrac/:id'가 '/idrac/scan-ranges'·'/idrac/power-settings' 같은 리터럴을 가려
// id="scan-ranges"로 잘못 처리되어 '없는 서버: scan-ranges' 오류가 난다.
adminRouter.put('/idrac/:id', adminOnly, async (req, res) => {
  const result = updateServer(req.params.id, req.body || {});
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

adminRouter.delete('/idrac/:id', adminOnly, async (req, res) => {
  const result = removeServer(req.params.id);
  res.status(result.ok ? 200 : 404).json(result);
});

// ---- Distributed collection: remote collector agents ----------------------

// List registered collectors (tokens redacted) + live pull status.
adminRouter.get('/collectors', adminOnly, (_req, res) => {
  res.json({ collectors: listCollectors(), status: allCollectorStatus() });
});

adminRouter.post('/collectors', adminOnly, (req, res) => {
  const result = addCollector(req.body || {});
  if (result.ok) { pullNow().catch(() => {}); logAudit({ user: req.user?.username, action: '수집 서버 등록', target: result.collector?.id || '', detail: `url=${result.collector?.url || ''} vcenterId=${result.collector?.vcenterId || ''}`, ip: req.ip || '' }); }
  res.status(result.ok ? 201 : 400).json(result);
});

adminRouter.put('/collectors/:id', adminOnly, (req, res) => {
  const result = updateCollector(req.params.id, req.body || {});
  if (result.ok) { pullNow().catch(() => {}); logAudit({ user: req.user?.username, action: '수집 서버 수정', target: req.params.id, detail: `url=${result.collector?.url || ''} vcenterId=${result.collector?.vcenterId || ''}`, ip: req.ip || '' }); }
  res.status(result.ok ? 200 : 400).json(result);
});

adminRouter.delete('/collectors/:id', adminOnly, (req, res) => {
  const result = removeCollector(req.params.id);
  if (result.ok) logAudit({ user: req.user?.username, action: '수집 서버 삭제', target: req.params.id, ip: req.ip || '' });
  res.status(result.ok ? 200 : 404).json(result);
});

// ── DataCenter(법인) — vCenter의 상위 개념. 설정에서 종류 정의 + vCenter 할당 (관리자) ────────
adminRouter.get('/datacenters', adminOnly, (_req, res) => res.json({ datacenters: listDatacenters(), assign: getDatacenterAssign() }));
adminRouter.post('/datacenters', adminOnly, (req, res) => {
  const r = addDatacenter(req.body || {});
  if (r.ok) logAudit({ user: req.user?.username, action: 'DataCenter 등록', target: r.datacenter?.id || '', detail: r.datacenter?.name || '', ip: req.ip || '' });
  res.status(r.ok ? 201 : 400).json(r);
});
// '/datacenters/assign'을 '/:id'보다 먼저 둬야 라우트 충돌이 없다.
adminRouter.put('/datacenters/assign', adminOnly, (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries.slice(0, 5000) : [];
  if (!entries.length) return res.status(400).json({ ok: false, reason: 'entries가 비었습니다.' });
  const r = setVcenterDatacenterMany(entries);
  if (r.ok) logAudit({ user: req.user?.username, action: 'vCenter→DataCenter 할당', target: `${r.changed}건`, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.put('/datacenters/:id', adminOnly, (req, res) => {
  const r = updateDatacenter(req.params.id, req.body || {});
  if (r.ok) logAudit({ user: req.user?.username, action: 'DataCenter 수정', target: req.params.id, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/datacenters/:id', adminOnly, (req, res) => {
  const r = removeDatacenter(req.params.id);
  if (r.ok) logAudit({ user: req.user?.username, action: 'DataCenter 삭제', target: req.params.id, ip: req.ip || '' });
  res.status(r.ok ? 200 : 404).json(r);
});

// ── VM 사양 변경(ReconfigVM) — vCPU/RAM/디스크 증설·추가, NIC 추가/삭제 (관리자) ──────────
// vmId 형식 '<vcId>:<moref>'. 스냅샷으로 VM 존재·vCenter 자격증명을 확인한 뒤 SOAP 실행.
function resolveVmTarget(vmId) {
  const snap = store.get();
  const vm = (snap.vms || []).find((v) => v.id === vmId);
  if (!vm) return { error: 'VM을 찾을 수 없습니다(현재 스냅샷에 없음 — 해당 vCenter 연결이 끊겼거나 폴링 전일 수 있습니다).', code: 404 };
  if (snap.source === 'mock') return { error: '데모(mock) 모드에서는 사양 변경을 사용할 수 없습니다.', code: 400 };
  const sep = String(vmId).indexOf(':');
  const vcId = sep >= 0 ? vmId.slice(0, sep) : vmId;
  const moref = sep >= 0 ? vmId.slice(sep + 1) : '';
  const vc = (loadVcenterConfig().vcenters || []).find((v) => v.id === vcId);
  // vCenter가 이 포탈에 직접 등록돼 있지 않으면(위임/엣지 수집 vCenter) 자격증명이 없어 사양 변경 불가.
  if (!vc) return { error: `이 VM의 vCenter('${vcId}')가 이 포탈에 등록되어 있지 않아 사양 변경을 할 수 없습니다(위임/엣지 수집 vCenter). 해당 vCenter가 직접 등록된 포탈에서 변경하세요.`, code: 400 };
  return { vm, vc, moref, snap };
}

// 현재 하드웨어 + NIC 추가용 네트워크 목록.
adminRouter.get('/vm/:id/hardware', adminOnly, async (req, res) => {
  const t = resolveVmTarget(req.params.id);
  if (t.error) return res.status(t.code).json({ ok: false, reason: t.error });
  try {
    const hw = await getVmHardware(t.vc, t.moref);
    // 이름 자연정렬(숫자 접미사 고려: uplink1 < uplink10, VMAX-2 < VMAX-10).
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
    const networks = (t.snap.networks || [])
      .filter((n) => n.vcenterId === t.vc.id)
      .map((n) => ({ id: n.id, name: n.name, type: n.type, moref: String(n.id).split(':').slice(1).join(':') }))
      .sort(byName);
    // 디스크 추가 시 선택할 데이터스토어 후보(해당 vCenter). 이름순으로 정렬(여유/총용량은 라벨에 표시).
    const datastores = (t.snap.datastores || [])
      .filter((d) => d.vcenterId === t.vc.id)
      .map((d) => ({ name: d.name, freeGB: d.freeGB, capacityGB: d.capacityGB }))
      .sort(byName);
    res.json({ ok: true, vmName: t.vm.name, powerState: hw.powerState, hw, networks, datastores });
  } catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});

// 사양 변경 실행. body: { numCPUs?, memoryMB?, diskGrows?, diskAdds?, nicAdds?, nicRemoves? }
adminRouter.post('/vm/:id/reconfig', adminOnly, async (req, res) => {
  const t = resolveVmTarget(req.params.id);
  if (t.error) return res.status(t.code).json({ ok: false, reason: t.error });
  const b = req.body || {};
  const plan = {
    numCPUs: b.numCPUs != null ? Number(b.numCPUs) : undefined,
    coresPerSocket: b.coresPerSocket != null ? Number(b.coresPerSocket) : undefined,
    memoryMB: b.memoryMB != null ? Number(b.memoryMB) : undefined,
    diskGrows: Array.isArray(b.diskGrows) ? b.diskGrows.slice(0, 64) : [],
    diskAdds: Array.isArray(b.diskAdds) ? b.diskAdds.slice(0, 16).map((a) => ({
      sizeGB: a?.sizeGB, controllerKey: a?.controllerKey,
      datastore: a?.datastore ? String(a.datastore) : undefined,
    })) : [],
    nicAdds: Array.isArray(b.nicAdds) ? b.nicAdds.slice(0, 10) : [],
    nicRemoves: Array.isArray(b.nicRemoves) ? b.nicRemoves.slice(0, 10) : [],
    nicConnects: Array.isArray(b.nicConnects) ? b.nicConnects.slice(0, 20) : [],
  };
  // 선택한 데이터스토어가 이 vCenter의 실제 데이터스토어인지 검증(오타·타 vCenter 차단).
  const validDs = new Set((t.snap.datastores || []).filter((d) => d.vcenterId === t.vc.id).map((d) => d.name));
  for (const a of plan.diskAdds) {
    if (a.datastore && !validDs.has(a.datastore)) return res.status(400).json({ ok: false, reason: `데이터스토어 '${a.datastore}'를 찾을 수 없습니다(이 vCenter의 데이터스토어를 선택하세요).` });
  }
  try {
    const r = await reconfigVm(t.vc, t.moref, plan);
    logAudit({
      user: req.user?.username, action: 'VM 사양 변경',
      target: t.vm.name,
      detail: r.ok ? (r.changes || []).join(', ') : `실패: ${r.error}`,
      ip: req.ip || '',
    });
    if (r.ok) { store.refresh().catch(() => {}); return res.json({ ok: true, changes: r.changes }); }
    res.status(400).json({ ok: false, reason: r.error, changes: r.changes });
  } catch (e) {
    logAudit({ user: req.user?.username, action: 'VM 사양 변경', target: t.vm.name, detail: `오류: ${e.message}`, ip: req.ip || '' });
    res.status(502).json({ ok: false, reason: e.message });
  }
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
  let retried = 0;
  try {
    // 단발 fetch는 고RTT·일시적 네트워크 블립에 '가끔 연결 안 됨'으로 오판된다 → 재시도로 흡수.
    const r = await resilientFetch(`${url.replace(/\/+$/, '')}/api/collector/export`, {
      headers: { Accept: 'application/json', ...(token ? { 'X-Collector-Token': token } : {}) },
      timeoutMs: config.collector.timeoutMs, retries: 2,
      onRetry: () => { retried++; },
    });
    if (!r.ok) return res.json({ ok: false, reason: `HTTP ${r.status}`, ms: Date.now() - started, retried });
    const data = await r.json();
    res.json({ ok: true, ms: Date.now() - started, retried, hosts: data.hosts, version: data.version, datacenter: data.datacenter });
  } catch (err) {
    res.json({ ok: false, reason: err.message, ms: Date.now() - started, retried });
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

// ───────────────────────── 포탈 백업 ─────────────────────────
// 중앙 + 엣지(에이전트 push) 설정 통합 백업. 정기/변경자동/수동 + 다운로드 + 복원.
adminRouter.get('/backup/status', adminOnly, (_req, res) => {
  res.json({ ...backupStatus(), backups: listBackups(), edges: listAgentConfigs() });
});
adminRouter.put('/backup/settings', adminOnly, (req, res) => res.json(saveBackupSettings(req.body || {})));
adminRouter.post('/backup/now', adminOnly, (_req, res) => {
  try { res.json({ ok: true, ...createBackup('manual', { retention: loadBackupSettings().retention }) }); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
adminRouter.get('/backup/download/:name', adminOnly, (req, res) => {
  const p = backupPath(req.params.name);
  if (!p) return res.status(404).json({ ok: false, reason: '백업을 찾을 수 없습니다.' });
  res.download(p, path.basename(p));
});
adminRouter.get('/backup/view/:name', adminOnly, (req, res) => {
  const a = readBackup(req.params.name);
  if (!a) return res.status(404).json({ ok: false, reason: '백업을 찾을 수 없습니다.' });
  res.json({ // 자격증명 내용은 빼고 요약만.
    createdAt: a.createdAt, reason: a.reason, centralVersion: a.central?.version,
    centralFiles: Object.keys(a.central?.files || {}),
    edges: Object.entries(a.edges || {}).map(([agent, e]) => ({ agent, at: e.at, files: Object.keys(e.files || {}) })),
  });
});
adminRouter.delete('/backup/:name', adminOnly, (req, res) => res.json({ ok: deleteBackup(req.params.name) }));
adminRouter.post('/backup/restore/:name', adminOnly, (req, res) => {
  try {
    const a = readBackup(req.params.name);
    if (!a) return res.status(404).json({ ok: false, reason: '백업을 찾을 수 없습니다.' });
    const r = restoreCentral(a);
    res.json({ ok: true, ...r, note: '중앙 설정 복원 완료 — 적용하려면 포탈 재시작. 복원 전 현재 설정은 자동 백업(pre-restore)됨.' });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ───────────────────────── vCenter 로그 보관 ─────────────────────────
adminRouter.get('/vclogs/status', adminOnly, async (_req, res) => {
  try { res.json(await logStatus()); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
adminRouter.put('/vclogs/settings', adminOnly, (req, res) => {
  const s = saveLogSettings(req.body || {});
  if (s._pathChanged) resetLogsDb(); // 저장 경로 변경 → 다음 접근 시 새 경로로 재오픈
  rescheduleLogPoller();
  delete s._pathChanged;
  res.json(s);
});
adminRouter.post('/vclogs/collect', adminOnly, async (_req, res) => {
  try { res.json({ ok: true, ...(await pollLogsOnce()) }); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ───────────────────────── 네트워크 트래픽 분석 ─────────────────────────
// 위임 캡처용 에이전트 목록(엣지가 사설망 서버를 대신 캡처).
adminRouter.get('/net/agents', adminOnly, (_req, res) => {
  const agents = new Set([...Object.keys(getAllAgentConfigs() || {}), ...listInventory().map((x) => x.agent).filter(Boolean), ...getAllGpuGuestDiag().map((x) => x.agent).filter(Boolean)]);
  res.json({ agents: [...agents] });
});

// 두 서버 간 tcpdump 캡처/분석(관리자 전용, SSH+root). 단일/동시(dual) + 중앙직접/에이전트위임.
// Body: { via:'central'|'agent', agent?, dual?, hostA:{...}, hostB?:{...}, peer?, iface, seconds, maxPackets, useSudo }
adminRouter.post('/net/capture', adminOnly, async (req, res) => {
  const b = req.body || {};
  const dual = !!b.dual;
  if (!b.hostA?.host || !b.hostA?.username) return res.status(400).json({ ok: false, reason: 'A 서버 SSH 접속정보(host/username)가 필요합니다.' });
  if (dual ? (!b.hostB?.host || !b.hostB?.username) : !b.peer) return res.status(400).json({ ok: false, reason: dual ? 'B 서버 SSH 접속정보가 필요합니다.' : '대상 서버(B) IP가 필요합니다.' });
  const opts = { iface: b.iface || 'any', seconds: b.seconds, maxPackets: b.maxPackets, useSudo: b.useSudo !== false };

  // 에이전트 위임: 큐잉만 하고 reqId 반환(클라이언트가 폴링).
  if (b.via === 'agent') {
    if (!b.agent) return res.status(400).json({ ok: false, reason: '위임할 엣지 에이전트를 선택하세요.' });
    const spec = dual ? { dual: true, hostA: b.hostA, hostB: b.hostB, ...opts } : { host: b.hostA.host, port: b.hostA.port, username: b.hostA.username, password: b.hostA.password, privateKey: b.hostA.privateKey, peer: String(b.peer).trim(), ...opts };
    return res.json({ ok: true, delegated: true, reqId: enqueueCapture(String(b.agent), spec) });
  }

  // 중앙 직접 실행.
  try {
    const r = dual
      ? await runDualCapture({ hostA: b.hostA, hostB: b.hostB, ...opts })
      : await runTrafficCapture({ hostA: b.hostA, peer: String(b.peer).trim(), ...opts });
    try { recordCapture(r, { source: 'manual', via: 'central', hostA: b.hostA.host, peer: b.peer }); } catch { /* 이력 실패 무시 */ }
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 위임 캡처 결과 폴링.
adminRouter.get('/net/capture', adminOnly, (req, res) => {
  if (!req.query.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  res.json(getCaptureResult(String(req.query.reqId)));
});

// pcap 파일 캡처 + 다운로드(중앙 직접). tshark 심층 분석용.
adminRouter.post('/net/pcap', adminOnly, async (req, res) => {
  const b = req.body || {};
  if (!b.hostA?.host || !b.hostA?.username || !b.peer) return res.status(400).json({ ok: false, reason: 'A 접속정보·대상 B IP가 필요합니다.' });
  try {
    const r = await runPcapCapture({ hostA: b.hostA, peer: String(b.peer).trim(), iface: b.iface || 'any', seconds: b.seconds, maxPackets: b.maxPackets, useSudo: b.useSudo !== false });
    if (!r.pcapBase64) return res.json({ ok: false, reason: r.warn || 'pcap을 회수하지 못했습니다(권한/tcpdump 확인).' });
    res.json({ ok: true, fileName: r.fileName, captured: r.captured, size: r.size, summary: r.summary, pcapBase64: r.pcapBase64 });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 캡처 이력
adminRouter.get('/net/history', adminOnly, (req, res) => res.json({ captures: listCaptures({ limit: Number(req.query.limit) || 100 }) }));
adminRouter.get('/net/history/:id', adminOnly, (req, res) => { const c = getCapture(req.params.id); return c ? res.json(c) : res.status(404).json({ ok: false }); });
adminRouter.delete('/net/history/:id', adminOnly, (req, res) => res.json({ ok: deleteCapture(req.params.id) }));

// 연속 모니터링
adminRouter.get('/net/monitors', adminOnly, (_req, res) => res.json({ monitors: listMonitors() }));
adminRouter.put('/net/monitors', adminOnly, (req, res) => res.json(saveMonitor(req.body || {})));
adminRouter.delete('/net/monitors/:id', adminOnly, (req, res) => res.json({ ok: removeMonitor(req.params.id) }));
adminRouter.post('/net/monitors/:id/run', adminOnly, async (req, res) => { try { res.json(await runMonitorNow(req.params.id)); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); } });
// 로그 자체 분석(장애/이슈 탐지).
adminRouter.get('/net/log-issues', adminOnly, async (req, res) => {
  try { res.json(await analyzeLogsForIssues({ vcenterId: req.query.vcenterId || '', days: Number(req.query.days) || 7 })); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ───────────────────────── 게스트 계정 추가 ─────────────────────────
// VMware Tools(게스트 작업)로 게스트 OS에 sudo 계정 추가. 관리자 전용 + 감사 로그.
// Body: { vcenterId, vmIds[], username, password, sudo, nopasswd, guestUser, guestPass }
adminRouter.post('/guest/add-user', adminOnly, async (req, res) => {
  const b = req.body || {};
  try { res.json(await addUsersToVms(b)); }
  catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

// 심층 검색(게스트 탐침) — GPU 드라이버/프로세스 등 게스트 OS 조건. 관리자 전용(게스트 명령 실행).
// Body: { vcenterIds[], filters{}, probe:{type,pattern}, guestUser, guestPass, maxVms }
adminRouter.post('/deep-search/probe', adminOnly, async (req, res) => {
  const b = req.body || {};
  if (!b.probe?.type) return res.status(400).json({ ok: false, reason: 'probe.type이 필요합니다.' });
  try {
    const candidates = snapshotFilter(store.get(), { vcenterIds: b.vcenterIds || [], f: b.filters || {} }).map(slimVm);
    const r = await guestProbe(candidates, b.probe, { guestUser: b.guestUser || '', guestPass: b.guestPass || '', maxVms: Math.min(500, Number(b.maxVms) || 100) });
    res.json({ candidates: candidates.length, ...r });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ───────────────────────── 로그인 실패 분석 ─────────────────────────
adminRouter.get('/security/login-fails', adminOnly, async (req, res) => {
  try { res.json(await analyzeLoginFails({ vcenterId: req.query.vcenterId || '', days: Number(req.query.days) || loadLoginMonitor().days, threshold: Number(req.query.threshold) || loadLoginMonitor().threshold, windowMin: Number(req.query.windowMin) || loadLoginMonitor().windowMin })); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
adminRouter.get('/security/login-fails/status', adminOnly, (_req, res) => res.json(loginMonitorStatus()));
adminRouter.put('/security/login-fails/settings', adminOnly, (req, res) => res.json(saveLoginMonitor(req.body || {})));
adminRouter.post('/security/login-fails/run', adminOnly, async (_req, res) => { try { await runLoginAnalysisNow(); res.json({ ok: true, ...loginMonitorStatus() }); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); } });

// 게스트 네트워크 이슈(패킷드랍/에러) 분석.
adminRouter.get('/security/net-issues', adminOnly, (req, res) => { try { res.json(analyzeNetIssues({ vcenterId: req.query.vcenterId || '', days: Number(req.query.days) || 7 })); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); } });

// 게스트 조사 스케줄(로그인 실패 / 네트워크 이슈) — vCenter별·OS별·주기.
adminRouter.get('/security/guest-scans', adminOnly, (_req, res) => res.json({ jobs: listGuestScans() }));
adminRouter.put('/security/guest-scans', adminOnly, (req, res) => res.json(saveGuestScan(req.body || {})));
adminRouter.delete('/security/guest-scans/:id', adminOnly, (req, res) => res.json({ ok: removeGuestScan(req.params.id) }));
adminRouter.post('/security/guest-scans/:id/run', adminOnly, async (req, res) => { try { res.json(await runGuestScanNow(req.params.id)); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); } });

function existsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
