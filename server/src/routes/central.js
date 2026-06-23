/**
 * Central orchestration endpoints used by agents (agent -> central). Mounted
 * outside user auth and gated by CENTRAL_TOKEN. Agents pull their IP assignment
 * by name and post scan results back.
 */

import { Router } from 'express';
import { config } from '../config.js';
import { getAssignment, setResult } from '../central/assignments.js';
import { setInventory } from '../central/inventory.js';
import { setGuestGpu } from '../gpu/store.js';
import { setGpuGuestDiag } from '../central/gpuGuestDiag.js';
import { takePingJobs, setPingResults } from '../central/pingJobs.js';
import { setAgentConfig } from '../central/agentConfig.js';
import { takeLogQueries, setLogQueryResult } from '../central/logQueries.js';
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

// 사이트 위임 수집: 현장 서버가 로컬 vCenter 인벤토리 조각을 push.
// Body: { agent, vcenterId, vcenter, hosts[], vms[], datastores[], networks[], alarms[], generatedAt }
centralRouter.post('/inventory', (req, res) => {
  if (!config.central.token) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: '토큰 불일치' });
  const b = req.body || {};
  if (!b.vcenterId || !b.vcenter) return res.status(400).json({ ok: false, reason: 'vcenterId/vcenter가 필요합니다.' });
  const arr = (x, n) => (Array.isArray(x) ? x.slice(0, n) : []);
  const slice = {
    vcenter: b.vcenter,
    hosts: arr(b.hosts, 50_000),
    vms: arr(b.vms, 500_000),
    datastores: arr(b.datastores, 50_000),
    networks: arr(b.networks, 50_000),
    alarms: arr(b.alarms, 50_000),
  };
  setInventory(String(b.vcenterId), slice, String(b.agent || ''), b.generatedAt || null);
  res.json({ ok: true, vcenterId: b.vcenterId, hosts: slice.hosts.length, vms: slice.vms.length });
});

// 게스트 GPU 수집 위임: ESXi 망에 닿는 현장 agent가 게스트 OS(nvidia-smi)에서 수집한
// GPU 사용률을 push. 중앙은 포탈이 ESXi에 직접 못 가는 환경에서 이 값을 오버레이로 사용.
// Body: { agent, hosts:[{hostId,utilPct}], vms:[{vmId,utilPct,memUsedPct,host,vcenterId}] }
centralRouter.post('/gpu-guest-data', (req, res) => {
  if (!config.central.token) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: '토큰 불일치' });
  const b = req.body || {};
  if (!b.agent) return res.status(400).json({ ok: false, reason: 'agent가 필요합니다.' });
  const hosts = Array.isArray(b.hosts) ? b.hosts.slice(0, 50_000) : [];
  const vms = Array.isArray(b.vms) ? b.vms.slice(0, 500_000) : [];
  setGuestGpu({ hosts, vms }); // 로컬 폴러와 동일한 게스트 오버레이에 기록 → /tools/gpu·샘플러가 그대로 사용
  if (b.diag) setGpuGuestDiag(b.agent, b.diag, { hosts: hosts.length, vms: vms.length }); // 수집 진단 보관
  console.log(`[central] gpu-guest-data 수신: agent=${b.agent} hosts=${hosts.length} vms=${vms.length}`);
  res.json({ ok: true, agent: b.agent, hosts: hosts.length, vms: vms.length });
});

// 위임 Ping: 현장 에이전트가 자기 담당 vCenter들의 대기 IP를 인출 → ping → 결과 보고.
// 중앙이 VM 사설 IP에 직접 못 가는 환경에서, 그 망에 닿는 에이전트가 ping을 대행.
centralRouter.get('/ping-jobs', (req, res) => {
  if (!config.central.token) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: '토큰 불일치' });
  const vcs = String(req.query.vcenters || '').split(',').map((s) => s.trim()).filter(Boolean);
  res.json({ ok: true, jobs: takePingJobs(vcs) });
});

// Body: { vcenterId, results:[{ ip, alive, rttMs }] }
centralRouter.post('/ping-result', (req, res) => {
  if (!config.central.token) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: '토큰 불일치' });
  const b = req.body || {};
  if (!b.vcenterId) return res.status(400).json({ ok: false, reason: 'vcenterId가 필요합니다.' });
  setPingResults(String(b.vcenterId), Array.isArray(b.results) ? b.results.slice(0, 200) : []);
  res.json({ ok: true, count: Array.isArray(b.results) ? b.results.length : 0 });
});

// 엣지 설정 push: 에이전트가 자기 CONFIG_DIR 설정을 보내 중앙 통합 백업에 합쳐지게 한다.
// Body: { agent, files:{ name: content } }
centralRouter.post('/agent-config', (req, res) => {
  if (!config.central.token) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: '토큰 불일치' });
  const b = req.body || {};
  if (!b.agent || !b.files || typeof b.files !== 'object') return res.status(400).json({ ok: false, reason: 'agent·files가 필요합니다.' });
  // 파일 수/크기 상한(남용 방지).
  const files = {};
  let n = 0;
  for (const [k, v] of Object.entries(b.files)) { if (n++ >= 200) break; if (typeof v === 'string' && v.length <= 8_000_000) files[require_basename(k)] = v; }
  setAgentConfig(String(b.agent).slice(0, 120), files);
  console.log(`[central] agent-config 수신: agent=${b.agent} (${Object.keys(files).length}개)`);
  res.json({ ok: true, agent: b.agent, files: Object.keys(files).length });
});
function require_basename(p) { return String(p).split(/[\\/]/).pop().slice(0, 200); }

// 엣지 로그 연합 조회: 에이전트가 자기 vCenter들의 대기 조회를 인출 → 로컬 로그 DB 조회 → 결과 보고.
centralRouter.get('/log-queries', (req, res) => {
  if (!config.central.token) return res.status(404).json({ ok: false, reason: 'central 비활성화' });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: '토큰 불일치' });
  const vcs = String(req.query.vcenters || '').split(',').map((s) => s.trim()).filter(Boolean);
  res.json({ ok: true, queries: takeLogQueries(vcs) });
});
// Body: { reqId, vcenterId, total, rows, dbKind }
centralRouter.post('/log-query-result', (req, res) => {
  if (!config.central.token) return res.status(404).json({ ok: false });
  if (!authed(req)) return res.status(403).json({ ok: false, reason: '토큰 불일치' });
  const b = req.body || {};
  if (!b.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  setLogQueryResult(String(b.reqId), b);
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
  recordAgentReport(String(b.agent), { scanned: b.scanned || 0, alive: Array.isArray(b.alive) ? b.alive.length : 0, durationMs: b.durationMs || null });
  res.json({ ok: true, merged: Array.isArray(b.alive) ? b.alive.length : 0 });
});
