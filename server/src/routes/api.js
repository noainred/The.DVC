import { Router } from 'express';
import { requireRole } from '../auth/auth.js';
import { store } from '../store.js';
import { currentVersion, config, loadVcenterConfig } from '../config.js';
import { loadUiSettings, saveUiSettings } from '../ui-settings.js';
import { hostPower } from '../idrac/service.js';
import { fetchVmMetric, fetchHostMetric, PERF_INTERVALS, upgradeVmTools, getVmConsole } from '../vcenter/soapClient.js';
import { listMutes, addMute, removeMute } from '../alarm-mutes.js';
import { buildIpamRows, buildSubnetSheets, listSubnets } from '../ipam/ledger.js';
import { buildIpamInsights } from '../ipam/insights.js';
import { buildNetmap } from '../ipam/netmap.js';
import { listVcRanges } from '../ipam/rangeStore.js';
import { rangeSize } from '../ipam/scan.js';
import { getAnnotation, setAnnotation } from '../ipam/annotations.js';
import { getIpHistory, scanResultList, getIpHistoryMap } from '../ipam/scanStore.js';
import { getClassifier } from '../ipam/settings.js';
import { buildWorkbook } from '../ipam/excel.js';
import { listNotes } from '../release-notes.js';
import { nlSearch } from '../llm/nlSearch.js';
import { sortByOrder } from '../vcenter/order.js';
import { getMetricsDb } from '../metrics/db.js';
import { sendMaybeZip } from '../util/zip.js';
import { getGuestGpuHost, getGuestGpuVms } from '../gpu/store.js';
import { enqueuePing, getPingResults, setPingResults } from '../central/pingJobs.js';
import { pingMany } from '../util/ping.js';
import { snapshotFilter, slimVm } from '../search/deepSearch.js';
import { getServiceCheck } from '../health/services.js';
import { getNetworkCheck } from '../health/network.js';
import { buildVmwareConfigExport } from '../backup/vmwareExport.js';
import { getLogsDb } from '../logs/db.js';
import { enqueueLogQuery, getLogQueryResult } from '../central/logQueries.js';
import { listInventory } from '../central/inventory.js';
import { getAllGpuGuestDiag } from '../central/gpuGuestDiag.js';
import zlib from 'node:zlib';
import { nsxStore } from '../nsx/store.js';
import { loadRegistry as loadNsxRegistry } from '../nsx/registry.js';
import { fetchGroupMembers } from '../nsx/client.js';
import { expandSpec } from '../provision/spec.js';
import { listSources, listJobs, getJob } from '../provision/jobs.js';
import { getPlacement } from '../provision/placement.js';
import { listSaved, getSaved } from '../provision/saved.js';

export const api = Router();

const METRIC_TYPES = ['cpu', 'mem', 'disk', 'net'];
const METRIC_UNIT = { cpu: '%', mem: '%', disk: 'KBps', net: 'KBps' };

// On-demand VM performance time-series — NOT collected by the regular poll.
// Queried live from vCenter only when the user opens the metric viewer.
//   /vms/:id/metrics?type=cpu|mem|disk|net&interval=realtime|day|week|month|year
api.get('/vms/:id/metrics', async (req, res) => {
  const id = req.params.id;
  const type = METRIC_TYPES.includes(req.query.type) ? req.query.type : 'cpu';
  const interval = PERF_INTERVALS[req.query.interval] ? req.query.interval : 'realtime';
  // Optional explicit date range (ISO/datetime-local). Empty = rolling window.
  const start = req.query.start && !Number.isNaN(Date.parse(req.query.start)) ? req.query.start : null;
  const end = req.query.end && !Number.isNaN(Date.parse(req.query.end)) ? req.query.end : null;

  const snap = store.get();
  const vm = snap.vms.find((v) => v.id === id);
  if (!vm) return res.status(404).json({ ok: false, reason: 'VM을 찾을 수 없습니다.' });

  if (snap.source === 'mock') return res.json(synthMetric(vm, type, interval, { start, end }));

  const sep = id.indexOf(':');
  const vcId = sep >= 0 ? id.slice(0, sep) : id;
  const moref = sep >= 0 ? id.slice(sep + 1) : '';
  const vc = loadVcenterConfig().vcenters.find((v) => v.id === vcId);
  if (!vc) return res.status(404).json({ ok: false, reason: 'vCenter 설정을 찾을 수 없습니다.' });
  try {
    res.json(await fetchVmMetric(vc, moref, type, interval, { start, end }));
  } catch (err) {
    res.status(502).json({ ok: false, reason: err.message });
  }
});

// ESXi 호스트 성능 — CPU/메모리/디스크/네트워크 실시간 + 기간 조회(VM과 동일 방식).
//   /hosts/:id/metrics?type=cpu|mem|disk|net&interval=realtime|day|week|month|year
api.get('/hosts/:id/metrics', async (req, res) => {
  const id = req.params.id;
  const type = METRIC_TYPES.includes(req.query.type) ? req.query.type : 'cpu';
  const interval = PERF_INTERVALS[req.query.interval] ? req.query.interval : 'realtime';
  const start = req.query.start && !Number.isNaN(Date.parse(req.query.start)) ? req.query.start : null;
  const end = req.query.end && !Number.isNaN(Date.parse(req.query.end)) ? req.query.end : null;

  const snap = store.get();
  const host = (snap.hosts || []).find((h) => h.id === id);
  if (!host) return res.status(404).json({ ok: false, reason: '호스트를 찾을 수 없습니다.' });

  if (snap.source === 'mock') return res.json(synthMetric(host, type, interval, { start, end }));

  const sep = id.indexOf(':');
  const vcId = sep >= 0 ? id.slice(0, sep) : id;
  const moref = sep >= 0 ? id.slice(sep + 1) : '';
  const vc = loadVcenterConfig().vcenters.find((v) => v.id === vcId);
  if (!vc) return res.status(404).json({ ok: false, reason: 'vCenter 설정을 찾을 수 없습니다.' });
  try {
    res.json(await fetchHostMetric(vc, moref, type, interval, { start, end }));
  } catch (err) {
    res.status(502).json({ ok: false, reason: err.message });
  }
});

// VM remote console (원격 콘솔). Returns VMRC + HTML5 web-console launch URLs
// using a one-time vCenter clone ticket. Live only.
api.get('/vms/:id/console', async (req, res) => {
  const id = req.params.id;
  const snap = store.get();
  const vm = snap.vms.find((v) => v.id === id);
  if (!vm) return res.status(404).json({ ok: false, reason: 'VM을 찾을 수 없습니다.' });
  if (snap.source === 'mock') {
    return res.json({ ok: true, mock: true, vmName: vm.name, reason: '데모 모드입니다. 실제 vCenter(live) 연결 시 VMRC/웹 콘솔 링크가 생성됩니다.' });
  }
  const sep = id.indexOf(':');
  const vcId = sep >= 0 ? id.slice(0, sep) : id;
  const moref = sep >= 0 ? id.slice(sep + 1) : '';
  const vc = loadVcenterConfig().vcenters.find((v) => v.id === vcId);
  if (!vc) return res.status(404).json({ ok: false, reason: 'vCenter 설정을 찾을 수 없습니다.' });
  try {
    const c = await getVmConsole(vc, moref, vm.name);
    res.json({ ...c, vmName: vm.name });
  } catch (err) {
    res.status(502).json({ ok: false, reason: err.message });
  }
});

// Synthesize a realistic series for mock mode so the viewer works out of the box.
// Honors an explicit { start, end } date range when provided.
function synthMetric(vm, type, interval, range = {}) {
  const stepMs = { realtime: 20_000, day: 300_000, week: 1_800_000, month: 7_200_000, year: 86_400_000 }[interval] || 20_000;
  const defN = { realtime: 180, day: 288, week: 336, month: 360, year: 365 }[interval] || 180;
  let endMs = range.end ? Date.parse(range.end) : Date.now();
  let startMs = range.start ? Date.parse(range.start) : endMs - (defN - 1) * stepMs;
  if (startMs > endMs) [startMs, endMs] = [endMs, startMs];
  const n = Math.max(2, Math.min(2000, Math.round((endMs - startMs) / stepMs) + 1));
  const spec = { n, stepMs, startMs };
  const base = type === 'cpu' ? (vm.cpuUsagePct || 10)
    : type === 'mem' ? (vm.memUsagePct || 20)
      : type === 'disk' ? 1800 : 900; // KBps baselines
  const amp = type === 'cpu' || type === 'mem' ? base * 0.5 + 8 : base * 0.8;
  const seed = [...vm.id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const points = [];
  for (let i = 0; i < spec.n; i++) {
    const t = new Date(spec.startMs + i * spec.stepMs).toISOString();
    const wave = Math.sin((i + seed) / 9) * 0.6 + Math.sin((i + seed) / 23) * 0.4;
    let v = base + wave * amp + (((seed * (i + 1)) % 17) - 8) * (amp / 20);
    if (type === 'cpu' || type === 'mem') v = Math.max(0, Math.min(100, v));
    else v = Math.max(0, v);
    points.push({ t, v: Math.round(v * 10) / 10 });
  }
  return { ok: true, type, interval, unit: METRIC_UNIT[type], points, mock: true, start: range.start || null, end: range.end || null };
}

// Real iDRAC power for one host (current + history). Used by the host detail
// popup. ?name=<esxi host name>&hours=24
api.get('/idrac/host-power', async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ matched: false, reason: 'name이 필요합니다.' });
  try {
    const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 24));
    res.json(await hostPower(String(name), { hours }));
  } catch (err) {
    res.status(500).json({ matched: false, reason: err.message });
  }
});

/** Apply common query filters (?vcenterId=, ?region=, ?q=) to a collection. */
// Small deterministic hash for synthesized demo series (stable per key).
function hash(s) { let h = 2166136261; const str = String(s); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0); }
// Least-squares slope of y over x.
function linregSlope(xs, ys) {
  const n = xs.length; if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n; const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0; let den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? null : num / den;
}

// Run `fn` over items with at most `limit` concurrent (for bounded on-demand vCenter queries).
async function eachLimited(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

function applyFilters(items, query, snap, searchFields = ['name']) {
  let out = items;
  if (query.vcenterId) out = out.filter((x) => x.vcenterId === query.vcenterId);
  if (query.region) {
    const ids = snap.vcenters.filter((v) => v.location?.region === query.region).map((v) => v.id);
    out = out.filter((x) => ids.includes(x.vcenterId));
  }
  if (query.q) {
    const q = String(query.q).toLowerCase();
    // Optional: include the user/vCenter notes in the search (?notes=1).
    const fields = (query.notes === '1' || query.notes === 'true') ? [...searchFields, 'notes'] : searchFields;
    out = out.filter((x) => fields.some((f) => String(x[f] ?? '').toLowerCase().includes(q)));
  }
  return out;
}

/** Sort a collection by a numeric/string field. order: 'asc' | 'desc' (default). */
function sortBy(items, key, order = 'desc') {
  const dir = order === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const x = a[key], y = b[key];
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
    return String(x ?? '').localeCompare(String(y ?? '')) * dir;
  });
}

api.get('/health', (_req, res) => {
  const snap = store.get();
  const connected = snap.vcenters.filter((v) => v.status === 'connected').length;
  const g = snap.rollups?.global || {};
  res.json({
    status: 'ok',
    version: currentVersion(),
    source: snap.source,
    generatedAt: snap.generatedAt,
    uptimeSec: Math.floor(process.uptime()),
    vcenters: snap.vcenters.length,
    vcentersConnected: connected,
    hosts: g.hosts || 0,
    vms: g.vms || 0,
    vmsPoweredOn: g.vmsPoweredOn || 0,
    alarms: g.alarms || 0,
    alarmsCritical: g.alarmsCritical || 0,
    cpuUsagePct: g.cpuUsagePct || 0,
    features: { upgradeTab: config.ui.showUpgradeTab },
  });
});

// High-level KPIs + regional / per-site rollups for the dashboard landing view.
api.get('/overview', (_req, res) => {
  const snap = store.get();
  // GPU 집계: 설치된 GPU 카드 총 장수 + GPU 평균 사용률(글로벌 현황 KPI용).
  // 사용률은 GPU 보유 호스트의 util(ESXi 보고 + 게스트 오버레이)을 평균.
  let gpuCards = 0, gpuVms = 0;
  let utilSum = 0, utilN = 0;
  for (const h of snap.hosts) {
    const gn = (h.gpus || []).length;
    gpuCards += gn;
    if (gn) {
      const u = h.gpuUtilPct ?? getGuestGpuHost(h.id)?.utilPct;
      if (u != null && Number.isFinite(u)) { utilSum += u; utilN++; }
    }
  }
  for (const v of snap.vms) if (v.gpu) gpuVms++;
  const gpuUtilPct = utilN ? Math.round(utilSum / utilN) : 0;
  res.json({ generatedAt: snap.generatedAt, source: snap.source, ...snap.rollups, gpuCards, gpuVms, gpuUtilPct, gpuUtilHosts: utilN });
});

// NSX overview — aggregated snapshot from the NSX Manager poller (separate from
// vCenter). Optional ?managerId= / ?region= scoping for the detail tables.
api.get('/nsx', (req, res) => {
  const snap = nsxStore.get();
  const { managerId, region } = req.query;
  const mIds = new Set(
    snap.managers
      .filter((m) => (!managerId || m.id === managerId) && (!region || m.region === region))
      .map((m) => m.id),
  );
  const scoped = managerId || region;
  res.json({
    generatedAt: snap.generatedAt,
    source: snap.source,
    rollup: snap.rollup,
    managers: snap.managers.filter((m) => mIds.has(m.id)),
    gateways: scoped ? snap.gateways.filter((g) => mIds.has(g.managerId)) : snap.gateways,
    segments: scoped ? snap.segments.filter((s) => mIds.has(s.managerId)) : snap.segments,
    transportNodes: scoped ? snap.transportNodes.filter((t) => mIds.has(t.managerId)) : snap.transportNodes,
    dfw: scoped ? (snap.dfw || []).filter((p) => mIds.has(p.managerId)) : (snap.dfw || []),
    securityGroups: scoped ? (snap.securityGroups || []).filter((g) => mIds.has(g.managerId)) : (snap.securityGroups || []),
    collectionErrors: snap.collectionErrors,
  });
});

// NSX 보안그룹 라이브 멤버 조회(온디맨드). groupId는 스냅샷의 "managerId:rawId" 형식.
api.get('/nsx/group-members', async (req, res) => {
  const full = String(req.query.groupId || '');
  const sep = full.indexOf(':');
  const managerId = req.query.managerId || (sep > 0 ? full.slice(0, sep) : '');
  const rawId = sep > 0 ? full.slice(sep + 1) : full;
  if (!managerId || !rawId) return res.status(400).json({ error: 'managerId/groupId가 필요합니다.' });
  if (nsxStore.get().source === 'mock') {
    // 데모: 합성 멤버.
    const n = 3 + (hash(rawId) % 12);
    const vms = Array.from({ length: n }, (_, i) => ({ name: `${rawId.slice(0, 8)}-vm-${i + 1}`, os: 'Linux', powerState: 'POWERED_ON', ips: [`10.94.${hash(rawId) % 200}.${i + 10}`] }));
    return res.json({ mock: true, vmCount: vms.length, vms, ipCount: vms.length, ips: vms.map((v) => v.ips[0]) });
  }
  const mgr = loadNsxRegistry().find((m) => m.id === managerId);
  if (!mgr) return res.status(404).json({ error: `NSX Manager를 찾을 수 없습니다: ${managerId}` });
  try {
    const data = await fetchGroupMembers(mgr, rawId);
    res.json({ mock: false, ...data });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- VM 프로비저닝 (생성/대량 생성) ---
// Clonable source VMs/templates from the current snapshot. ?vcenterId= scopes to
// one 법인; ?q= prefix-matches the name (A → all VMs/templates starting with A).
api.get('/provision/sources', (req, res) => {
  res.json(listSources(req.query.vcenterId, req.query.q));
});
// Placement options for one 법인(vCenter): cluster/host/datastore/folder/pool/profile.
api.get('/provision/placement', async (req, res) => {
  try { res.json(await getPlacement(req.query.vcenterId)); }
  catch (e) { res.status(500).json({ error: e.message, clusters: [], hosts: [], datastores: [], folders: [], resourcePools: [], profiles: [] }); }
});
// Dry-run: expand a bulk spec into the concrete per-VM list (name/hostname/ip).
api.post('/provision/preview', (req, res) => {
  const { vms, errors } = expandSpec(req.body || {});
  res.json({ ok: errors.length === 0, count: vms.length, vms: vms.slice(0, 500), errors });
});
// Saved provisioning jobs (reusable). ?vcenterId= filters; ?limit=&offset= paginate.
api.get('/provision/saved', (req, res) => {
  res.json(listSaved({ vcenterId: req.query.vcenterId, limit: req.query.limit, offset: req.query.offset }));
});
api.get('/provision/saved/:id', (req, res) => {
  const item = getSaved(req.params.id);
  if (!item) return res.status(404).json({ ok: false, reason: '저장된 작업을 찾을 수 없습니다.' });
  res.json(item);
});

// Provisioning jobs (only the caller's own; admins see all).
api.get('/provision/jobs', (req, res) => res.json({ jobs: listJobs(req.user) }));
api.get('/provision/jobs/:id', (req, res) => {
  const job = getJob(req.params.id, req.user);
  if (!job) return res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다.' });
  res.json(job);
});

api.get('/vcenters', (_req, res) => {
  res.json(sortByOrder(store.get().rollups?.sites ?? [], (s) => s.id));
});

// Special tool: find IPv4 addresses assigned to more than one VM, optionally
// scoped to one vCenter (?vcenterId=). Helps catch duplicate/conflicting IPs.
api.get('/tools/duplicate-ips', (req, res) => {
  const snap = store.get();
  let vms = snap.vms;
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  const map = new Map();
  for (const v of vms) {
    const ips = v.ipAddresses?.length ? v.ipAddresses : (v.ipAddress ? [v.ipAddress] : []);
    for (const ip of new Set(ips)) {
      if (!map.has(ip)) map.set(ip, []);
      map.get(ip).push({ id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host, cluster: v.cluster, powerState: v.powerState, guestOS: v.guestOS, ipAddresses: v.ipAddresses, ipAddress: v.ipAddress });
    }
  }
  const items = [...map.entries()]
    .filter(([, vs]) => vs.length > 1)
    .map(([ip, vs]) => ({
      ip, count: vs.length, vms: vs,
      crossVcenter: new Set(vs.map((x) => x.vcenterId)).size > 1,
    }))
    .sort((a, b) => b.count - a.count || a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  res.json({
    scope: req.query.vcenterId || 'all',
    duplicateIps: items.length,
    affectedVms: items.reduce((a, d) => a + d.count, 0),
    scannedVms: vms.length,
    items,
  });
});

// Installed VMware solutions (vCenter extensions) per vCenter, NSX highlighted.
api.get('/tools/solutions', (_req, res) => {
  const snap = store.get();
  const items = (snap.vcenters || []).map((vc) => {
    const sols = vc.solutions || [];
    return {
      vcenterId: vc.id, name: vc.name, status: vc.status,
      version: vc.version, build: vc.build, fullName: vc.fullName,
      solutions: sols,
      nsx: sols.filter((s) => /nsx/i.test(s.key) || /nsx/i.test(s.label)),
    };
  });
  const nsxVer = {};
  for (const it of items) for (const s of it.nsx) { const v = s.version || '?'; nsxVer[v] = (nsxVer[v] || 0) + 1; }
  const vcVer = {};
  for (const it of items) { const v = it.version || '?'; vcVer[v] = (vcVer[v] || 0) + 1; }
  res.json({
    items,
    nsxVersions: Object.entries(nsxVer).map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count),
    vcenterVersions: Object.entries(vcVer).map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count),
  });
});

// VMware Tools version distribution (optionally per vCenter).
api.get('/tools/vmtools', (req, res) => {
  const snap = store.get();
  let vms = snap.vms;
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  const map = new Map();
  for (const v of vms) {
    const ver = v.toolsVersion || '없음';
    if (!map.has(ver)) map.set(ver, { version: ver, count: 0, running: 0, outdated: 0, notRunning: 0, ids: [] });
    const e = map.get(ver); e.count++;
    if (e.ids.length < 2000) e.ids.push(v.id);
    if (v.toolsStatus === 'RUNNING') e.running++;
    else if (v.toolsStatus === 'OUTDATED') e.outdated++;
    else e.notRunning++;
  }
  res.json({
    scannedVms: vms.length,
    versions: [...map.values()].sort((a, b) => b.count - a.count),
  });
});

// VMs that have snapshots (optionally per vCenter).
api.get('/tools/snapshots', (req, res) => {
  const snap = store.get();
  let vms = snap.vms.filter((v) => (v.snapshotCount || 0) > 0);
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  const items = vms.map((v) => ({
    id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host, cluster: v.cluster,
    snapshotCount: v.snapshotCount, snapshotSizeGB: v.snapshotSizeGB || 0,
    powerState: v.powerState, guestOS: v.guestOS,
  }));
  res.json({
    count: items.length,
    totalSizeGB: Math.round(items.reduce((a, v) => a + (v.snapshotSizeGB || 0), 0) * 10) / 10,
    items,
  });
});

// Natural-language search (local LLM interprets → query runs on local data).
api.post('/search/nl', async (req, res) => {
  const query = String((req.body || {}).query || '').trim();
  if (!query) return res.status(400).json({ error: 'query is required' });
  try { res.json(await nlSearch(query)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Release notes (built-in changelog + admin-recorded), newest first.
api.get('/release-notes', (_req, res) => {
  res.json({ current: currentVersion(), notes: listNotes() });
});

// Per-center IP ledger (IP 관리대장): every IPv4 collected from vCenter (VM
// guest IPs, multi-homed NICs, and hosts registered by management IP), grouped
// by center, with the owning entity embedded so the UI can show details on click.
api.get('/tools/ipam', (req, res) => {
  res.json(buildIpamRows(store.get(), req.query.vcenterId));
});

// IPAM 추천 기능 30선 — 유명 IPAM 솔루션 대표 기능을 수집 데이터로 계산.
api.get('/tools/ipam/insights', (req, res) => {
  res.json(buildIpamInsights(store.get(), req.query.vcenterId || ''));
});

// Per-/24 subnet ledger (Excel-style): subnet list, one subnet's rows, or full .xlsx.
api.get('/tools/ipam/subnets', (req, res) => {
  res.json({ subnets: listSubnets(store.get(), req.query.vcenterId) });
});
api.get('/tools/ipam/sheet', (req, res) => {
  const sheets = buildSubnetSheets(store.get(), { vcenterId: req.query.vcenterId, onlyBase: req.query.base });
  res.json(sheets[0] || { subnet: '', rows: [] });
});

// Per-IP usage history (scan-derived online/offline transitions over time).
api.get('/tools/ipam/history', (req, res) => {
  res.json({ ip: req.query.ip, history: getIpHistory(String(req.query.ip || '')) });
});

// vCenter별 등록 스캔 대역 목록(+vCenter 이름·IP 수 추정).
api.get('/tools/ipam/vc-ranges', (req, res) => {
  const snap = store.get();
  const vcName = {};
  for (const vc of snap.vcenters || []) vcName[vc.id] = vc.name;
  const list = listVcRanges().map((e) => ({
    ...e, vcenterName: vcName[e.vcenterId] || e.vcenterId,
    ipCount: e.ranges.reduce((a, s) => a + rangeSize(s), 0),
  }));
  // 등록 안 된 vCenter도 선택할 수 있게 전체 vCenter 목록을 함께 내려준다.
  res.json({ ranges: list, vcenters: (snap.vcenters || []).map((v) => ({ id: v.id, name: v.name })) });
});

// 네트워크 맵 — 대역(/24) 선택 시 OS별·시간대별 사용/미사용 격자.
api.get('/tools/ipam/netmap', (req, res) => {
  res.json(buildNetmap(store.get(), {
    vcenterId: req.query.vcenterId || '', base: req.query.base || '',
    days: req.query.days, buckets: req.query.buckets,
  }));
});

// 스캔 결과를 '첨부파일'처럼 내려받기(CSV). 현재 결과 + 이력(상태/최초관측) 조인.
api.get('/tools/ipam/scan-report.csv', (req, res) => {
  const histMap = getIpHistoryMap();
  const rows = scanResultList();
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const iso = (t) => (t ? new Date(t).toISOString() : '');
  const head = 'ip,hostname,status,open_ports,services,first_seen,last_seen,agent';
  const lines = rows.map((r) => {
    const h = histMap[r.ip] || {};
    return [r.ip, r.hostname || '', h.status || '', (r.openPorts || []).join(' '), (r.services || []).join(' '),
      iso(h.firstSeen), iso(r.lastSeen || h.lastSeen), r.agent || ''].map(esc).join(',');
  });
  const csv = `${head}\n${lines.join('\n')}\n`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ip-scan-report-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// Per-IP user annotation (custom memo + tags), separate from vCenter notes.
api.get('/tools/ipam/annotation', (req, res) => {
  res.json({ ip: req.query.ip, annotation: getAnnotation(req.query.ip) });
});
api.put('/tools/ipam/annotation', (req, res) => {
  const { ip, memo, tags } = req.body || {};
  const r = setAnnotation(ip, { memo, tags }, req.user);
  res.status(r.ok ? 200 : 400).json(r);
});
api.get('/tools/ipam.xlsx', async (req, res) => {
  try {
    const sheets = buildSubnetSheets(store.get(), { vcenterId: req.query.vcenterId });
    const wb = await buildWorkbook(sheets);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ip-ledger-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CSV export of the IP ledger for sharing with other tools/spreadsheets.
api.get('/tools/ipam.csv', (req, res) => {
  const { rows } = buildIpamRows(store.get(), req.query.vcenterId);
  const head = ['ip', 'vcenter_id', 'vcenter_name', 'owner_type', 'owner_name', 'power_state', 'guest_os', 'host_name', 'cluster', 'scope', 'multi_homed', 'duplicate'];
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [head.join(',')];
  for (const r of rows) lines.push([r.ip, r.vcenterId, r.vcenterName, r.ownerType, r.ownerName, r.powerState, r.guestOS, r.hostName, r.cluster, r.scope, r.multiHomed ? 1 : 0, r.duplicate ? 1 : 0].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ipam-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n')); // BOM for Excel
});

// Host hardware (vendor/model) summary — per vendor, per model, and the
// vCenter × vendor × model breakdown ("어떤 법인에 어떤 모델 몇 대").
api.get('/tools/hardware', (req, res) => {
  const snap = store.get();
  let hosts = snap.hosts;
  if (req.query.vcenterId) hosts = hosts.filter((h) => h.vcenterId === req.query.vcenterId);
  const vcName = {};
  for (const vc of snap.vcenters || []) vcName[vc.id] = vc.name;
  const byVendor = {};
  const byModel = {};
  const combo = new Map(); // vcenter|vendor|model -> count
  for (const h of hosts) {
    const vendor = h.vendor || '미상';
    const model = h.model || '미상';
    byVendor[vendor] = (byVendor[vendor] || 0) + 1;
    byModel[`${vendor} ${model}`] = (byModel[`${vendor} ${model}`] || 0) + 1;
    const key = `${h.vcenterId}|${vendor}|${model}`;
    combo.set(key, (combo.get(key) || 0) + 1);
  }
  const items = [...combo.entries()].map(([k, count]) => {
    const [vcenterId, vendor, model] = k.split('|');
    return { vcenterId, vcenterName: vcName[vcenterId] || vcenterId, vendor, model, count };
  }).sort((a, b) => b.count - a.count);
  res.json({
    hosts: hosts.length,
    byVendor: Object.entries(byVendor).map(([vendor, count]) => ({ vendor, count })).sort((a, b) => b.count - a.count),
    byModel: Object.entries(byModel).map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count),
    items,
  });
});

// ESXi version distribution + host list (optionally per vCenter).
api.get('/tools/esxi', (req, res) => {
  const snap = store.get();
  let hosts = snap.hosts;
  if (req.query.vcenterId) hosts = hosts.filter((h) => h.vcenterId === req.query.vcenterId);
  const map = new Map();
  for (const h of hosts) {
    const v = h.version || 'unknown';
    if (!map.has(v)) map.set(v, { version: v, count: 0 });
    map.get(v).count++;
  }
  res.json({
    scanned: hosts.length,
    versions: [...map.values()].sort((a, b) => b.count - a.count),
    items: hosts.map((h) => ({ host: h.name, vcenterId: h.vcenterId, cluster: h.cluster, version: h.version || 'unknown', build: h.build || '', connectionState: h.connectionState })),
  });
});

// GPU inventory per host + aggregate counts by model and vCenter.
// GPU 인벤토리 집계(호스트별 GPU 장수·모드·사용률·할당 VM) — /tools/gpu 와 CSV/JSON export 공용.
function buildGpuInventory(snap, vcenterId) {
  let hosts = snap.hosts;
  if (vcenterId) hosts = hosts.filter((h) => h.vcenterId === vcenterId);
  const hostsWithGpu = [];
  const byModel = {};
  const byVcenter = {};
  const byMode = { vgpu: 0, passthrough: 0, vsga: 0 };
  let totalGpus = 0;
  // GPU가 할당된 VM을 호스트(이름)별로 집계 — 각 GPU 호스트에 몇 개 VM이 GPU를 쓰는지.
  const gpuVmByHost = {};
  for (const v of (snap.vms || [])) {
    if (!v.gpu || !v.host) continue;
    const e = gpuVmByHost[v.host] || { vms: 0, on: 0, off: 0, vgpu: 0, passthrough: 0, names: [] };
    e.vms++; e.vgpu += v.gpu.vgpu || 0; e.passthrough += v.gpu.passthrough || 0;
    if (v.powerState === 'POWERED_ON') e.on++; else e.off++;
    if (v.name) e.names.push({ name: v.name, on: v.powerState === 'POWERED_ON' });
    gpuVmByHost[v.host] = e;
  }
  // 게스트 수집 사용률은 '전원 ON GPU VM'만 집계(전원 OFF VM의 stale 값 제외) → 호스트(이름)별 평균.
  const onGpuVmIds = new Set((snap.vms || []).filter((v) => v.gpu && v.powerState === 'POWERED_ON').map((v) => v.id));
  const guestUtilByHost = new Map(); // hostName -> [utilPct...]
  for (const g of getGuestGpuVms()) {
    if (!onGpuVmIds.has(g.vmId) || g.utilPct == null) continue;
    const arr = guestUtilByHost.get(g.host) || []; arr.push(g.utilPct); guestUtilByHost.set(g.host, arr);
  }
  for (const h of hosts) {
    const gpus = h.gpus || [];
    if (!gpus.length) continue;
    totalGpus += gpus.length;
    // 한 호스트에 모드가 섞일 수 있으므로 대표 모드(가장 많은 것) + 개수 분포를 함께 제공.
    const modes = {};
    for (const g of gpus) { const md = g.mode || (g.vgpuMode ? 'vgpu' : 'passthrough'); modes[md] = (modes[md] || 0) + 1; byMode[md] = (byMode[md] || 0) + 1; }
    const primaryMode = Object.entries(modes).sort((a, b) => b[1] - a[1])[0][0];
    // ESXi가 사용률을 못 보는 패스쓰루 호스트는 게스트 OS 수집 오버레이로 보완(전원 ON VM만).
    const gu = guestUtilByHost.get(h.name);
    const guestUtil = gu && gu.length ? Math.round(gu.reduce((a, b) => a + b, 0) / gu.length) : null;
    const utilPct = h.gpuUtilPct ?? guestUtil;
    const vmAlloc = gpuVmByHost[h.name] || { vms: 0, on: 0, off: 0, vgpu: 0, passthrough: 0, names: [] };
    hostsWithGpu.push({
      id: h.id, host: h.name, vcenterId: h.vcenterId, cluster: h.cluster, count: gpus.length,
      model: gpus[0].model, memGB: gpus[0].memGB, mode: primaryMode, modes,
      vgpu: primaryMode === 'vgpu', utilPct, utilSource: h.gpuUtilPct != null ? 'esxi' : (guestUtil != null ? 'guest' : null),
      assignedVms: vmAlloc.vms, assignedVmsOn: vmAlloc.on || 0, assignedVmsOff: vmAlloc.off || 0, assignedVmNames: vmAlloc.names || [],
    });
    for (const g of gpus) {
      byModel[g.model] = (byModel[g.model] || 0) + 1;
      byVcenter[h.vcenterId] = (byVcenter[h.vcenterId] || 0) + 1;
    }
  }
  const utils = hostsWithGpu.map((x) => x.utilPct).filter((x) => x != null);
  // GPU를 사용하는 VM 수(스코프 내, 템플릿 제외) — 상단 요약용.
  const gpuVmCount = (snap.vms || []).filter((v) => v.gpu && !v.template && (!vcenterId || v.vcenterId === vcenterId)).length;
  return {
    totalGpus,
    hostsWithGpu: hostsWithGpu.length,
    gpuVmCount,
    utilReporting: utils.length,
    avgUtilPct: utils.length ? Math.round(utils.reduce((a, b) => a + b, 0) / utils.length) : null,
    byMode,
    byModel: Object.entries(byModel).map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count),
    byVcenter: Object.entries(byVcenter).map(([vcenterId, count]) => ({ vcenterId, count })).sort((a, b) => b.count - a.count),
    items: hostsWithGpu.sort((a, b) => b.count - a.count),
  };
}

api.get('/tools/gpu', (req, res) => {
  res.json(buildGpuInventory(store.get(), req.query.vcenterId));
});

// GPU 사용량/인벤토리 JSON export — 집계 결과 그대로 파일로 내려받기.
api.get('/tools/gpu.json', (req, res) => {
  const data = buildGpuInventory(store.get(), req.query.vcenterId);
  const body = JSON.stringify({ generatedAt: new Date().toISOString(), vcenterId: req.query.vcenterId || null, ...data }, null, 2);
  sendMaybeZip(res, `gpu-${new Date().toISOString().slice(0, 10)}.json`, body, 'application/json; charset=utf-8');
});

// GPU 사용량/인벤토리 CSV export — 호스트별 한 행(모델·장수·모드·사용률·할당 VM).
api.get('/tools/gpu.csv', (req, res) => {
  const data = buildGpuInventory(store.get(), req.query.vcenterId);
  const head = ['host', 'vcenter_id', 'cluster', 'gpu_model', 'gpu_count', 'mem_gb', 'mode', 'mode_breakdown', 'util_pct', 'util_source', 'assigned_vms'];
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [head.join(',')];
  for (const r of data.items) {
    const breakdown = Object.entries(r.modes || {}).map(([m, n]) => `${m}:${n}`).join(' ');
    lines.push([r.host, r.vcenterId, r.cluster, r.model, r.count, r.memGB, r.mode, breakdown,
      r.utilPct == null ? '' : r.utilPct, r.utilSource || '', r.assignedVms].map(esc).join(','));
  }
  sendMaybeZip(res, `gpu-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + lines.join('\r\n'), 'text/csv; charset=utf-8'); // BOM for Excel
});

// GPU 사용률 시계열 수집 메타 — '언제부터 데이터가 쌓였는지'(수집 시작/마지막/샘플 수).
// export 모달에서 사용자가 수집 시작 일시를 보고 전체/기간을 고르도록.
api.get('/tools/gpu/series-meta', async (req, res) => {
  try {
    const db = await getMetricsDb();
    const m = db.meta('gpu_util');
    res.json({ collectedSince: m.firstTs, latestAt: m.lastTs, sampleCount: m.count });
  } catch { res.json({ collectedSince: null, latestAt: null, sampleCount: 0 }); }
});

// GPU 사용률 '수집된 전체 데이터' export — 시계열(샘플마다 한 행). range=all(수집 시작~현재)
// 또는 range=days(최근 N일). vcenterId로 법인 스코프. format은 .csv/.json.
async function gpuSeriesExport(req, res, fmt) {
  const range = req.query.range === 'days' ? 'days' : 'all';
  const days = Math.max(1, Math.min(1830, Number(req.query.days) || 30));
  const vcId = req.query.vcenterId || null;
  const snap = store.get();
  const hostMap = new Map(); // host.id -> {name,vcenterId,cluster}
  for (const h of snap.hosts || []) hostMap.set(h.id, h);
  const db = await getMetricsDb();
  const meta = db.meta('gpu_util');
  const until = Date.now();
  const since = range === 'days' ? until - days * 86_400_000 : (meta.firstTs ?? 0);
  const raw = db.dump('gpu_util', since, until, 1_000_000);
  // 법인 스코프면 해당 법인 호스트만. 이름/클러스터는 현재 스냅샷 기준으로 매핑.
  const out = [];
  // gpu_util은 %(0~100). 과거 일부 샘플이 vSphere 1/100% 단위로 ×100 저장된 경우가 있어
  // 100 초과면 ÷100로 정규화하고 0~100으로 클램프(util 최대 100이라 안전).
  const normPct = (v) => { const n = Number(v); if (!Number.isFinite(n)) return 0; const p = n > 100 ? n / 100 : n; return Math.max(0, Math.min(100, Math.round(p))); };
  for (const r of raw) {
    const h = hostMap.get(r.k);
    if (vcId && (!h || h.vcenterId !== vcId)) continue;
    out.push({ ts: r.ts, host: h?.name || r.k, vcenterId: h?.vcenterId || '', cluster: h?.cluster || '', utilPct: normPct(r.v) });
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const sinceIso = meta.firstTs ? new Date(meta.firstTs).toISOString() : '없음';
  if (fmt === 'json') {
    const body = JSON.stringify({
      generatedAt: new Date().toISOString(), collectedSince: meta.firstTs ? new Date(meta.firstTs).toISOString() : null,
      range, days: range === 'days' ? days : null, vcenterId: vcId, sampleCount: out.length,
      points: out.map((p) => ({ ...p, tsIso: new Date(p.ts).toISOString() })),
    }, null, 2);
    sendMaybeZip(res, `gpu-history-${range}-${stamp}.json`, body, 'application/json; charset=utf-8');
    return;
  }
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['timestamp_iso', 'epoch_ms', 'host', 'vcenter_id', 'cluster', 'gpu_util_pct'];
  const lines = [
    `# GPU 사용률 수집 데이터 — 수집 시작: ${sinceIso} (그날부터 누적) | 범위: ${range === 'all' ? '전체' : `최근 ${days}일`} | 생성: ${new Date().toISOString()} | 샘플 ${out.length}`,
    '# 단위: gpu_util_pct = GPU 사용률 %(0~100) · epoch_ms = Unix epoch 밀리초(엑셀은 지수표기로 보일 수 있음) · timestamp_iso = ISO8601 시각',
    head.join(','),
  ];
  for (const p of out) lines.push([new Date(p.ts).toISOString(), p.ts, p.host, p.vcenterId, p.cluster, p.utilPct].map(esc).join(','));
  sendMaybeZip(res, `gpu-history-${range}-${stamp}.csv`, '﻿' + lines.join('\r\n'), 'text/csv; charset=utf-8'); // BOM for Excel
}
api.get('/tools/gpu/export.csv', (req, res) => gpuSeriesExport(req, res, 'csv'));
api.get('/tools/gpu/export.json', (req, res) => gpuSeriesExport(req, res, 'json'));

// 중앙에서 직접 ping 시도 후 결과 저장(에이전트 없이도 같은 망이면 즉시 결과). 실패 격리.
async function pingLocallyAndStore(vcenterId, ips) {
  const rows = await pingMany(ips, { timeoutMs: 1500 });
  // 도달한 것만 저장 — 중앙이 못 가는 IP는 alive=false로 덮어쓰지 않고 에이전트 보고를 기다림.
  const reachable = rows.filter((r) => r.alive);
  if (reachable.length) setPingResults(vcenterId, reachable);
}

// VM IP Ping(위임) — 중앙은 VM 사설 IP에 직접 못 가므로, 그 vCenter 담당 에이전트가
// ping을 대행한다. POST로 요청 큐잉 → 에이전트가 인출/실행/보고 → GET으로 녹/적 조회.
// 중앙이 직접 수집하는 vCenter(에이전트 없음)는 중앙이 직접 ping해 즉시 결과를 채운다.
api.post('/tools/ip-ping', async (req, res) => {
  const vcenterId = String(req.body?.vcenterId || '').trim();
  const ips = Array.isArray(req.body?.ips) ? req.body.ips.map((s) => String(s).trim()).filter(Boolean).slice(0, 16) : [];
  if (!vcenterId || !ips.length) return res.status(400).json({ ok: false, reason: 'vcenterId·ips가 필요합니다.' });
  enqueuePing(vcenterId, ips);
  // 에이전트가 없는(중앙 직접 수집) vCenter는 중앙에서 직접 ping 시도(같은 망일 때 즉시 결과).
  if (config.dataSource !== 'mock') pingLocallyAndStore(vcenterId, ips).catch(() => {});
  res.json({ ok: true, queued: ips.length });
});
api.get('/tools/ip-ping', (req, res) => {
  const vcenterId = String(req.query.vcenterId || '').trim();
  const ips = String(req.query.ips || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!vcenterId || !ips.length) return res.status(400).json({ ok: false, reason: 'vcenterId·ips가 필요합니다.' });
  res.json({ ok: true, results: getPingResults(vcenterId, ips) });
});

// GPU가 할당된 VM 목록 — 어떤 VM이 어떤 방식(vGPU/패스쓰루)·프로파일로 GPU를 쓰는지.
// 선택 필터: vcenterId, host, mode(vgpu|passthrough|mixed), model(호스트 GPU 모델).
api.get('/tools/gpu/vms', (req, res) => {
  const snap = store.get();
  // 호스트명 → GPU 모델 매핑(모델 필터용)
  const hostModel = {};
  for (const h of snap.hosts) if ((h.gpus || []).length) hostModel[h.name] = h.gpus[0].model;
  let vms = (snap.vms || []).filter((v) => v.gpu);
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  if (req.query.host) vms = vms.filter((v) => v.host === req.query.host);
  if (req.query.model) vms = vms.filter((v) => hostModel[v.host] === req.query.model);
  if (req.query.mode) vms = vms.filter((v) => v.gpu.type === req.query.mode || (req.query.mode === 'vgpu' && v.gpu.vgpu) || (req.query.mode === 'passthrough' && v.gpu.passthrough));
  // 게스트 OS(nvidia-smi)에서 수집한 VM별 GPU 사용률/메모리 오버레이(패스쓰루 GPU는 ESXi가 못 봄).
  const guestByVm = new Map(getGuestGpuVms().map((g) => [g.vmId, g]));
  res.json({
    total: vms.length,
    vms: vms.map((v) => {
      // 전원 OFF VM은 사용률 계산/표시에서 제외(이전에 수집된 stale 값 무시).
      const g = v.powerState === 'POWERED_ON' ? guestByVm.get(v.id) : null;
      return {
        id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host, cluster: v.cluster,
        powerState: v.powerState, model: hostModel[v.host] || '', gpu: v.gpu,
        guestUtilPct: g ? g.utilPct : null, guestMemPct: g ? (g.memUsedPct ?? null) : null, guestAt: g ? g.at : null,
      };
    }).sort((a, b) => (a.vcenterId === b.vcenterId ? a.name.localeCompare(b.name) : a.vcenterId.localeCompare(b.vcenterId))).slice(0, 5000),
  });
});

// 심층 검색(스냅샷 1차) — 다조건 + 범위(전체/특정/복수 vCenter). Body: { vcenterIds[], filters{} }.
api.post('/tools/deep-search', (req, res) => {
  const b = req.body || {};
  const vms = snapshotFilter(store.get(), { vcenterIds: b.vcenterIds || [], f: b.filters || {} });
  res.json({ total: vms.length, items: vms.slice(0, 2000).map(slimVm) });
});

// 다빈치 서비스 점검 — 포탈 내부 서비스/수집기 상태 통합.
api.get('/tools/service-check', (_req, res) => {
  try { res.json(getServiceCheck()); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 글로벌 네트워크 점검 — 제어플레인(vCenter/NSX) 도달성·RTT + 네트워크 객체 요약.
api.get('/tools/network-check', async (_req, res) => {
  try { res.json(await getNetworkCheck()); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 사이트 VMware 솔루션 구성 백업 — 수집 구성 스냅샷. ?vcenterId=로 사이트 한정, ?download=1로 gzip 파일.
api.get('/tools/vmware-config', (req, res) => {
  try {
    const data = buildVmwareConfigExport({ vcenterId: req.query.vcenterId || null });
    if (req.query.download === '1') {
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(data, null, 2)));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fn = `vmware-config-${data.meta.scope}-${stamp}.json.gz`;
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
      return res.end(gz);
    }
    res.json(data);
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 로그 출처 — 이 포탈 로컬 보관(local) vs 엣지 보관(remote, 연합 조회 필요).
api.get('/tools/vclogs/sources', (_req, res) => {
  const localIds = new Set((loadVcenterConfig().vcenters || []).map((v) => v.id));
  const vcAgent = new Map();
  for (const inv of listInventory()) if (inv.agent) vcAgent.set(inv.vcenterId, inv.agent);
  for (const a of getAllGpuGuestDiag()) { if (!a.agent) continue; for (const vc of a.vcenters || []) if (vc.vcId) vcAgent.set(vc.vcId, a.agent); }
  const remote = [];
  for (const [vcenterId, agent] of vcAgent) if (!localIds.has(vcenterId)) remote.push({ vcenterId, agent });
  res.json({ local: [...localIds], remote });
});

// 엣지 로그 연합 조회 — 요청 큐잉(POST) / 결과 폴링(GET ?reqId=).
api.post('/tools/vclogs/federate', (req, res) => {
  const b = req.body || {};
  const vcenterId = String(b.vcenterId || '').trim();
  if (!vcenterId) return res.status(400).json({ ok: false, reason: 'vcenterId가 필요합니다.' });
  const filter = { vcenterId, severity: b.severity || '', q: b.q || '', since: Number(b.since) || 0, until: Number(b.until) || 0, limit: Math.min(500, Number(b.limit) || 200) };
  res.json({ ok: true, reqId: enqueueLogQuery(vcenterId, filter) });
});
api.get('/tools/vclogs/federate', (req, res) => {
  const reqId = String(req.query.reqId || '');
  if (!reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  res.json({ ok: true, ...getLogQueryResult(reqId) });
});

// vCenter 장기 보관 로그 조회 — 필터: vcenterId·severity·q·since·until + 페이징.
api.get('/tools/vclogs', async (req, res) => {
  try {
    const db = await getLogsDb();
    const f = { vcenterId: req.query.vcenterId || '', severity: req.query.severity || '', q: req.query.q || '',
      since: req.query.since ? Number(req.query.since) : 0, until: req.query.until ? Number(req.query.until) : 0 };
    const limit = Math.min(1000, Number(req.query.limit) || 200);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json({ total: db.count(f), rows: db.query(f, limit, offset), meta: db.meta(), dbKind: db.kind });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
api.get('/tools/vclogs/export.csv', async (req, res) => {
  try {
    const db = await getLogsDb();
    const f = { vcenterId: req.query.vcenterId || '', severity: req.query.severity || '', q: req.query.q || '',
      since: req.query.since ? Number(req.query.since) : 0, until: req.query.until ? Number(req.query.until) : 0 };
    const rows = db.query(f, 100_000, 0);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['time,vcenter,severity,type,user,entity,message',
      ...rows.map((r) => [new Date(r.ts).toISOString(), r.vcenterId, r.severity, r.type, r.user, r.entity, r.message].map(esc).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vcenter-logs-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + csv); // BOM(엑셀 한글)
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 운영 인사이트 — 기존 스냅샷만으로 계산하는 모니터링 분석 묶음:
//  ② VM 라이트사이징(유휴/과대/과소)  ④ 클러스터 N+1(호스트 1대 장애 여력)
//  ⑧ 알람 핫스팟(심각도/엔티티/센터)   ⑩ GPU 유휴/낭비
api.get('/tools/insights', (req, res) => {
  const snap = store.get();
  const vc = req.query.vcenterId;
  const hosts = vc ? snap.hosts.filter((h) => h.vcenterId === vc) : snap.hosts;
  const vms = vc ? snap.vms.filter((v) => v.vcenterId === vc) : snap.vms;
  const alarms = vc ? (snap.alarms || []).filter((a) => a.vcenterId === vc) : (snap.alarms || []);
  const on = vms.filter((v) => v.powerState === 'POWERED_ON');
  const r0 = (n, d = 0) => Number((n || 0).toFixed(d));
  const gb = (mb) => Math.round((mb || 0) / 1024);

  // ② 라이트사이징
  const slim = (v) => ({ name: v.name, vcenterId: v.vcenterId, host: v.host || '', cpuPct: v.cpuUsagePct ?? null, memPct: v.memUsagePct ?? null, vcpu: v.cpuCount || 0, ramGB: gb(v.memMB) });
  const idle = on.filter((v) => (v.cpuUsagePct ?? 100) < 5 && (v.memUsagePct ?? 100) < 20).map(slim);
  const oversized = on.filter((v) => (v.cpuCount || 0) >= 4 && (v.cpuUsagePct ?? 100) < 10 && !((v.cpuUsagePct ?? 100) < 5 && (v.memUsagePct ?? 100) < 20)).map(slim);
  const undersized = on.filter((v) => (v.cpuUsagePct ?? 0) > 85 || (v.memUsagePct ?? 0) > 90).map(slim);
  const rightsizing = {
    idleCount: idle.length, oversizedCount: oversized.length, undersizedCount: undersized.length,
    reclaimableVcpu: [...idle, ...oversized].reduce((a, v) => a + (v.vcpu || 0), 0),
    reclaimableRamGB: [...idle, ...oversized].reduce((a, v) => a + (v.ramGB || 0), 0),
    idle: idle.slice(0, 200), oversized: oversized.slice(0, 200), undersized: undersized.slice(0, 200),
  };

  // ④ 클러스터 N+1 (가장 큰 호스트 1대 장애 시 잔여 용량으로 현재 사용량 수용 가능?)
  const cmap = new Map();
  for (const h of hosts) {
    const k = `${h.vcenterId}|${h.cluster || 'standalone'}`;
    const g = cmap.get(k) || { vcenterId: h.vcenterId, cluster: h.cluster || 'standalone', hosts: 0, cpuMhz: 0, cpuUsed: 0, memMB: 0, memUsed: 0, maxCpu: 0, maxMem: 0 };
    g.hosts++; g.cpuMhz += h.cpuTotalMhz || 0; g.cpuUsed += h.cpuUsageMhz || 0; g.memMB += h.memTotalMB || 0; g.memUsed += h.memUsageMB || 0;
    g.maxCpu = Math.max(g.maxCpu, h.cpuTotalMhz || 0); g.maxMem = Math.max(g.maxMem, h.memTotalMB || 0);
    cmap.set(k, g);
  }
  const clusters = [...cmap.values()].map((g) => {
    const remCpu = g.cpuMhz - g.maxCpu, remMem = g.memMB - g.maxMem;
    const cpuOkPct = remCpu > 0 ? r0((g.cpuUsed / remCpu) * 100) : 999;
    const memOkPct = remMem > 0 ? r0((g.memUsed / remMem) * 100) : 999;
    const n1Ok = g.hosts >= 2 && cpuOkPct <= 90 && memOkPct <= 90;
    return { vcenterId: g.vcenterId, cluster: g.cluster, hosts: g.hosts, n1Ok, cpuAfterFailPct: cpuOkPct, memAfterFailPct: memOkPct,
      cpuUsagePct: g.cpuMhz ? r0((g.cpuUsed / g.cpuMhz) * 100) : 0, memUsagePct: g.memMB ? r0((g.memUsed / g.memMB) * 100) : 0 };
  }).sort((a, b) => (a.n1Ok === b.n1Ok ? b.cpuAfterFailPct - a.cpuAfterFailPct : a.n1Ok ? 1 : -1));

  // ⑧ 알람 핫스팟
  const bySev = { critical: 0, warning: 0, info: 0 };
  const byEntity = new Map(); const byVc = new Map();
  for (const a of alarms) {
    const sev = (a.severity || 'info').toLowerCase(); bySev[sev] = (bySev[sev] || 0) + 1;
    const ent = a.entity || '(미상)'; byEntity.set(ent, (byEntity.get(ent) || 0) + 1);
    byVc.set(a.vcenterId || '', (byVc.get(a.vcenterId || '') + 1 || 1));
  }
  const alarmHotspot = {
    total: alarms.length, bySeverity: bySev,
    topEntities: [...byEntity.entries()].map(([entity, count]) => ({ entity, count })).sort((a, b) => b.count - a.count).slice(0, 20),
    byVcenter: [...byVc.entries()].map(([vcenterId, count]) => ({ vcenterId, count })).sort((a, b) => b.count - a.count),
  };

  // ⑩ GPU 유휴/낭비 (ESXi 보고 사용률 기준)
  const gpuHosts = hosts.filter((h) => (h.gpus || []).length);
  const gpuVmByHost = {};
  for (const v of vms) if (v.gpu && v.host) gpuVmByHost[v.host] = (gpuVmByHost[v.host] || 0) + 1;
  const idleGpu = gpuHosts.filter((h) => h.gpuUtilPct != null && h.gpuUtilPct < 10)
    .map((h) => ({ host: h.name, vcenterId: h.vcenterId, model: h.gpus[0].model, count: h.gpus.length, util: h.gpuUtilPct, assignedVms: gpuVmByHost[h.name] || 0 }))
    .sort((a, b) => a.util - b.util);
  const gpuWaste = {
    totalGpuHosts: gpuHosts.length, totalGpus: gpuHosts.reduce((a, h) => a + h.gpus.length, 0),
    idleHostCount: idleGpu.length, idleGpus: idleGpu.reduce((a, x) => a + x.count, 0),
    unreporting: gpuHosts.filter((h) => h.gpuUtilPct == null).length, list: idleGpu.slice(0, 100),
  };

  res.json({ generatedAt: snap.generatedAt, rightsizing, clusters, alarmHotspot, gpuWaste });
});

// 위협 탐지 — (A) 텔레메트리 기반 + (B) NSX 분산 IDS 이벤트. 자사 인프라 방어 목적.
const RISKY_PORTS = { 21: 'FTP', 23: 'Telnet', 135: 'RPC', 139: 'NetBIOS', 445: 'SMB', 1433: 'MSSQL', 3306: 'MySQL', 3389: 'RDP', 5432: 'PostgreSQL', 5900: 'VNC', 6379: 'Redis', 9200: 'Elasticsearch', 27017: 'MongoDB', 11211: 'Memcached' };
const EOL_OS = [
  [/windows.*(\bxp\b|2000|2003|2008|vista|\b7\b|\bnt\b)/i, 'Windows (EOL)'],
  [/cent\s?os.*(\b5\b|\b6\b|\b7\b)/i, 'CentOS (EOL)'],
  [/red\s?hat.*(\b5\b|\b6\b|\b7\b)/i, 'RHEL (EOL)'],
  [/ubuntu.*(1[0-6]\.(04|10)|8\.04|9\.|0[0-9]\.)/i, 'Ubuntu (EOL)'],
  [/debian.*(\b[1-9]\b)\b/i, 'Debian old'],
];
api.get('/tools/threats', (req, res) => {
  const snap = store.get();
  const vc = req.query.vcenterId;
  const vms = vc ? snap.vms.filter((v) => v.vcenterId === vc) : snap.vms;
  const on = vms.filter((v) => v.powerState === 'POWERED_ON');
  const classify = getClassifier();
  const slim = (v) => ({ name: v.name, vcenterId: v.vcenterId, host: v.host || '', cpuPct: v.cpuUsagePct ?? null, memPct: v.memUsagePct ?? null });

  // A1) 크립토마이닝 의심 — 고CPU 지속(현재 스냅샷 기준; 사용률 미보고는 제외)
  const mining = on.filter((v) => (v.cpuUsagePct ?? -1) >= 90).map(slim).sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0));

  // A2) EOL/취약 OS
  const eol = vms.map((v) => { const m = EOL_OS.find(([re]) => re.test(v.guestOS || '')); return m ? { ...slim(v), os: v.guestOS, reason: m[1] } : null; }).filter(Boolean);

  // A3) 위험 포트 노출(스캔 결과) — 공인 노출이면 high
  const scan = scanResultList();
  const risky = scan.map((s) => {
    const hits = (s.openPorts || []).filter((p) => RISKY_PORTS[p]);
    if (!hits.length) return null;
    const pub = classify(s.ip) === 'public';
    return { ip: s.ip, hostname: s.hostname || '', ports: hits.map((p) => `${p}/${RISKY_PORTS[p]}`), public: pub, severity: pub ? 'high' : 'medium' };
  }).filter(Boolean).sort((a, b) => (b.public - a.public) || (b.ports.length - a.ports.length));

  // A4) 신규 rogue IP — vCenter가 모르고, 최근 7일 내 처음 스캔된 IP
  const known = new Set();
  for (const v of (snap.vms || [])) { const ips = v.ipAddresses?.length ? v.ipAddresses : (v.ipAddress ? [v.ipAddress] : []); for (const ip of ips) known.add(ip); }
  for (const h of (snap.hosts || [])) known.add(h.name);
  const hist = getIpHistoryMap();
  const cut = Date.now() - 7 * 86_400_000;
  const rogue = scan.filter((s) => !known.has(s.ip) && (hist[s.ip]?.firstSeen || 0) > cut)
    .map((s) => ({ ip: s.ip, hostname: s.hostname || '', firstSeen: hist[s.ip]?.firstSeen || null, ports: (s.openPorts || []), services: s.services || [] }))
    .sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));

  // B) NSX 분산 IDS 이벤트(있으면)
  const nsx = nsxStore.get();
  let idsEvents = nsx.idsEvents || [];
  const idsManagers = (nsx.managers || []).map((m) => ({ name: m.name, enabled: m.idsEnabled ?? null, profiles: m.idsProfiles || 0, events: m.idsEventCount || 0 }));
  const sev = (e) => e.severity;
  idsEvents = idsEvents.slice(0, 500);

  res.json({
    generatedAt: snap.generatedAt,
    summary: {
      mining: mining.length, eol: eol.length, riskyPublic: risky.filter((r) => r.public).length, riskyTotal: risky.length,
      rogue: rogue.length, idsEvents: idsEvents.length, idsCritical: idsEvents.filter((e) => /crit|high/.test(sev(e))).length,
    },
    mining: mining.slice(0, 200), eol: eol.slice(0, 300), risky: risky.slice(0, 300), rogue: rogue.slice(0, 300),
    ids: { managers: idsManagers, events: idsEvents },
  });
});

// GPU 사용률 히스토리(5년까지). level=host|cluster|vc, key=대상키, days=기간.
api.get('/tools/gpu/history', async (req, res) => {
  const level = ['host', 'cluster', 'vc'].includes(req.query.level) ? req.query.level : 'host';
  const metric = { host: 'gpu_util', cluster: 'gpu_cluster', vc: 'gpu_vc' }[level];
  const key = String(req.query.key || '');
  const days = Math.max(1, Math.min(1830, Number(req.query.days) || 7));
  const since = Date.now() - days * 86_400_000;
  const bucketMs = days <= 2 ? 3_600_000 : days <= 14 ? 6 * 3_600_000 : days <= 120 ? 86_400_000 : days <= 800 ? 7 * 86_400_000 : 30 * 86_400_000;
  let points = [];
  try { const db = await getMetricsDb(); points = db.history(metric, key, since, bucketMs, 1000); } catch { points = []; }
  let synthesized = false;
  if (points.length < 2 && store.get().source === 'mock') {
    // 데모: 일과 시간대·요일 부하를 반영한 0~100% 합성 시계열.
    synthesized = true; points = [];
    const base = 25 + (hash(key) % 30);
    for (let t = since; t <= Date.now(); t += bucketMs) {
      const day = t / 86_400_000;
      let v = base + 22 * Math.abs(Math.sin(day / 9)) + 14 * Math.sin(day) + (hash(key + t) % 8);
      v = Math.max(0, Math.min(100, v));
      points.push({ ts: Math.floor(t), avg: Number(v.toFixed(1)), min: Number(Math.max(0, v - 12).toFixed(1)), max: Number(Math.min(100, v + 10).toFixed(1)) });
    }
  }
  res.json({ level, key, days, bucketMs, unit: '%', synthesized, points });
});

// Capacity report — per-cluster compute capacity, allocation, overcommit, headroom.
api.get('/tools/capacity', (req, res) => {
  const snap = store.get();
  const vcId = req.query.vcenterId;
  const hosts = snap.hosts.filter((h) => !vcId || h.vcenterId === vcId);
  const vms = snap.vms.filter((v) => (!vcId || v.vcenterId === vcId) && !v.template);
  const r1 = (x) => Number((x || 0).toFixed(1));
  const byCluster = new Map();
  const key = (h) => `${h.vcenterId} ${h.cluster || 'standalone'}`;
  for (const h of hosts) {
    const k = key(h);
    const c = byCluster.get(k) || { vcenterId: h.vcenterId, cluster: h.cluster || 'standalone', hosts: 0, cores: 0, cpuTotalMhz: 0, cpuUsedMhz: 0, memTotalGB: 0, memUsedGB: 0, vcpuOn: 0, vcpuAll: 0, ramOnGB: 0, vmsOn: 0, vms: 0 };
    c.hosts++; c.cores += h.cpuCores || 0; c.cpuTotalMhz += h.cpuTotalMhz || 0; c.cpuUsedMhz += h.cpuUsageMhz || 0;
    c.memTotalGB += (h.memTotalMB || 0) / 1024; c.memUsedGB += (h.memUsageMB || 0) / 1024;
    byCluster.set(k, c);
  }
  for (const v of vms) {
    const k = `${v.vcenterId} ${v.cluster || 'standalone'}`;
    const c = byCluster.get(k); if (!c) continue;
    c.vms++; const on = v.powerState === 'POWERED_ON';
    c.vcpuAll += v.cpuCount || 0;
    if (on) { c.vcpuOn += v.cpuCount || 0; c.ramOnGB += (v.memMB || 0) / 1024; c.vmsOn++; }
  }
  const clusters = [...byCluster.values()].map((c) => ({
    vcenterId: c.vcenterId, cluster: c.cluster, hosts: c.hosts, vms: c.vms, vmsOn: c.vmsOn,
    cores: c.cores, memTotalGB: Math.round(c.memTotalGB),
    vcpuAllocated: c.vcpuOn, vcpuTotal: c.vcpuAll, ramAllocatedGB: Math.round(c.ramOnGB),
    vcpuPerCore: c.cores ? r1(c.vcpuOn / c.cores) : 0,
    ramOvercommitPct: c.memTotalGB ? Math.round((c.ramOnGB / c.memTotalGB) * 100) : 0,
    cpuUsedPct: c.cpuTotalMhz ? Math.round((c.cpuUsedMhz / c.cpuTotalMhz) * 100) : 0,
    memUsedPct: c.memTotalGB ? Math.round((c.memUsedGB / c.memTotalGB) * 100) : 0,
    ramHeadroomGB: Math.round(c.memTotalGB - c.ramOnGB),
  })).sort((a, b) => b.ramOvercommitPct - a.ramOvercommitPct);
  const sum = (f) => clusters.reduce((a, x) => a + f(x), 0);
  res.json({
    scope: vcId || 'all',
    clusters,
    totals: {
      clusters: clusters.length, hosts: sum((c) => c.hosts), cores: sum((c) => c.cores),
      memTotalGB: sum((c) => c.memTotalGB), vcpuAllocated: sum((c) => c.vcpuAllocated), ramAllocatedGB: sum((c) => c.ramAllocatedGB),
      vcpuPerCore: sum((c) => c.cores) ? r1(sum((c) => c.vcpuAllocated) / sum((c) => c.cores)) : 0,
      ramHeadroomGB: sum((c) => c.ramHeadroomGB),
    },
  });
});

// Waste report — 자원 낭비 후보 모음(스냅샷 기반): 전원 꺼진 VM, 스냅샷 보유 VM,
// thin 회수가능, Tools 미설치. (고아 VMDK는 데이터스토어 파일 스캔이 필요해 미포함)
api.get('/tools/waste', (req, res) => {
  const snap = store.get();
  const vcId = req.query.vcenterId;
  const vms = snap.vms.filter((v) => (!vcId || v.vcenterId === vcId) && !v.template);
  const r1 = (x) => Number((x || 0).toFixed(1));
  const off = vms.filter((v) => v.powerState !== 'POWERED_ON');
  const snaps = vms.filter((v) => (v.snapshotCount || 0) > 0);
  const thin = vms.filter((v) => v.thin);
  const noTools = vms.filter((v) => v.powerState === 'POWERED_ON' && v.toolsStatus && v.toolsStatus !== 'RUNNING');
  const top = (arr, fn, n = 50) => [...arr].sort((a, b) => fn(b) - fn(a)).slice(0, n);
  res.json({
    scope: vcId || 'all',
    poweredOff: { count: off.length, storageGB: off.reduce((a, v) => a + (v.storageGB || 0), 0),
      vms: top(off, (v) => v.storageGB || 0).map((v) => ({ id: v.id, name: v.name, vcenterId: v.vcenterId, storageGB: v.storageGB, guestOS: v.guestOS })) },
    snapshots: { count: snaps.length, sizeGB: r1(snaps.reduce((a, v) => a + (v.snapshotSizeGB || 0), 0)),
      vms: top(snaps, (v) => v.snapshotSizeGB || 0).map((v) => ({ id: v.id, name: v.name, vcenterId: v.vcenterId, snapshotCount: v.snapshotCount, snapshotSizeGB: v.snapshotSizeGB })) },
    thinReclaim: { count: thin.length, reclaimableGB: thin.reduce((a, v) => a + (v.uncommittedGB || 0), 0) },
    noTools: { count: noTools.length, vms: noTools.slice(0, 50).map((v) => ({ id: v.id, name: v.name, vcenterId: v.vcenterId, toolsStatus: v.toolsStatus })) },
  });
});

// Thin-provisioned VM finder. thin = uncommitted(여유)이 큰 VM(추정). committed=실사용,
// provisioned=committed+uncommitted. 회수 가능 추정 = uncommitted 합계.
api.get('/tools/thin-vms', (req, res) => {
  const snap = store.get();
  let vms = snap.vms;
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  const round = (v, d = 1) => Number((v || 0).toFixed(d));
  const items = vms.filter((v) => v.thin).map((v) => ({
    id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host, cluster: v.cluster,
    powerState: v.powerState, guestOS: v.guestOS,
    committedGB: v.storageGB || 0,
    uncommittedGB: v.uncommittedGB || 0,
    provisionedGB: (v.storageGB || 0) + (v.uncommittedGB || 0),
  })).sort((a, b) => b.uncommittedGB - a.uncommittedGB);
  res.json({
    scope: req.query.vcenterId || 'all',
    totalVms: vms.length,
    thinVms: items.length,
    thinPct: vms.length ? Math.round((items.length / vms.length) * 100) : 0,
    committedTB: round(items.reduce((a, x) => a + x.committedGB, 0) / 1024, 1),
    provisionedTB: round(items.reduce((a, x) => a + x.provisionedGB, 0) / 1024, 1),
    reclaimableTB: round(items.reduce((a, x) => a + x.uncommittedGB, 0) / 1024, 1),
    items,
  });
});

// Advanced VM finder: scope by 다수 vCenter + folder/cluster/resourcePool +
// conditions. Optional withAvg → 1일/1주 평균 CPU(유휴 판정). 평균은 live는
// vCenter 성능 API 온디맨드(상한 있음), mock은 현재값 기반 합성.
api.post('/tools/vm-finder', async (req, res) => {
  const b = req.body || {};
  const snap = store.get();
  const inList = (v, arr) => !arr || !arr.length || arr.includes(v);
  // Facets reflect the chosen vCenter scope (so 폴더/클러스터/풀 목록이 좁혀짐).
  const scopeVms = snap.vms.filter((v) => inList(v.vcenterId, b.vcenterIds));
  const facets = {
    vcenters: [...new Set(snap.vms.map((v) => v.vcenterId))].sort(),
    folders: [...new Set(scopeVms.map((v) => v.folder).filter(Boolean))].sort(),
    clusters: [...new Set(scopeVms.map((v) => v.cluster).filter(Boolean))].sort(),
    resourcePools: [...new Set(scopeVms.map((v) => v.resourcePool).filter(Boolean))].sort(),
  };
  const term = String(b.q || '').trim().toLowerCase();
  let vms = scopeVms.filter((v) =>
    inList(v.folder, b.folders) && inList(v.cluster, b.clusters) && inList(v.resourcePool, b.resourcePools)
    && (!b.powerState || v.powerState === b.powerState)
    && (!b.os || String(v.guestOS || '').toLowerCase().includes(String(b.os).toLowerCase()))
    && (!term || v.name.toLowerCase().includes(term) || String(v.ipAddress || '').includes(term))
    && (b.includeTemplates || !v.template));

  const round1 = (x) => Number((x || 0).toFixed(1));
  const items = vms.map((v) => ({
    id: v.id, name: v.name, vcenterId: v.vcenterId, folder: v.folder, cluster: v.cluster, resourcePool: v.resourcePool,
    host: v.host, powerState: v.powerState, guestOS: v.guestOS, cpuCount: v.cpuCount, memMB: v.memMB,
    cpuUsagePct: v.cpuUsagePct, memUsagePct: v.memUsagePct, storageGB: v.storageGB,
    avgDayCpu: null, avgWeekCpu: null, idle: null,
  }));

  const result = { facets, total: items.length, items, avgComputed: false };

  if (b.withAvg && items.length) {
    const threshold = Number(b.idleThreshold) || 5;
    const CAP = 40;
    const targets = items.slice(0, CAP);
    result.avgCap = CAP; result.avgComputed = true; result.avgTruncated = items.length > CAP;
    if (snap.source === 'mock') {
      for (const it of targets) {
        // 합성: 현재값 주변으로 일/주 평균(전원 꺼짐=0).
        const base = it.powerState === 'POWERED_ON' ? it.cpuUsagePct : 0;
        it.avgDayCpu = round1(Math.max(0, base * 0.85));
        it.avgWeekCpu = round1(Math.max(0, base * 0.7));
      }
    } else {
      const cfgs = loadVcenterConfig().vcenters;
      await eachLimited(targets, 6, async (it) => {
        const vc = cfgs.find((x) => x.id === it.vcenterId);
        if (!vc) return;
        const moref = it.id.split(':').slice(1).join(':');
        try {
          const [day, week] = await Promise.all([
            fetchVmMetric(vc, moref, 'cpu', 'day').catch(() => null),
            fetchVmMetric(vc, moref, 'cpu', 'week').catch(() => null),
          ]);
          const avg = (m) => { const pts = (m?.points || []).map((p) => p.v).filter((x) => x != null); return pts.length ? round1(pts.reduce((a, x) => a + x, 0) / pts.length) : null; };
          it.avgDayCpu = avg(day); it.avgWeekCpu = avg(week);
        } catch { /* per-VM best effort */ }
      });
    }
    for (const it of targets) {
      const a = it.avgWeekCpu ?? it.avgDayCpu;
      it.idle = it.powerState === 'POWERED_ON' && a != null && a <= threshold;
    }
    result.idleCount = targets.filter((x) => x.idle).length;
    result.idleThreshold = threshold;
  }
  res.json(result);
});

// ESXi 온도 — 현재 값(호스트/클러스터/법인별 그룹) + 5년 히스토리 시계열.
api.get('/tools/esxi-temp', async (req, res) => {
  const snap = store.get();
  const vcId = req.query.vcenterId;
  const hosts = (snap.hosts || []).filter((h) => (!vcId || h.vcenterId === vcId) && h.tempC != null);
  const r1 = (x) => (x == null ? null : Number(x.toFixed(1)));
  // 최근 5분 평균/최대(시계열). 표시 컬럼: 현재온도 / 5분 평균 / 최대 온도.
  let avg5Host = new Map(); let avg5Cluster = new Map(); let avg5Vc = new Map();
  try {
    const db = await getMetricsDb();
    const since = Date.now() - 5 * 60_000;
    avg5Host = db.recentAvg('temp_host', since);
    avg5Cluster = db.recentAvg('temp_cluster', since);
    avg5Vc = db.recentAvg('temp_vc', since);
  } catch { /* 시계열 없으면 5분 평균은 null */ }
  const grp = (keyFn, avg5Map) => {
    const m = new Map();
    for (const h of hosts) { const k = keyFn(h); const g = m.get(k) || { key: k, count: 0, sum: 0, max: -Infinity }; g.count++; g.sum += h.tempC; g.max = Math.max(g.max, h.tempMaxC ?? h.tempC); m.set(k, g); }
    return [...m.values()].map((g) => {
      const a5 = avg5Map.get(g.key);
      return { key: g.key, hosts: g.count, curC: r1(g.sum / g.count), avg5C: a5 ? a5.avg : null, maxC: r1(Math.max(g.max, a5?.max ?? -Infinity)) };
    }).sort((a, b) => b.curC - a.curC);
  };
  res.json({
    scope: vcId || 'all',
    reportingHosts: hosts.length,
    totalHosts: (snap.hosts || []).filter((h) => !vcId || h.vcenterId === vcId).length,
    hosts: hosts.map((h) => {
      const a5 = avg5Host.get(h.id);
      return { id: h.id, name: h.name, vcenterId: h.vcenterId, cluster: h.cluster, curC: h.tempC, avg5C: a5 ? a5.avg : null, tempMaxC: r1(Math.max(h.tempMaxC ?? h.tempC, a5?.max ?? -Infinity)), temps: h.temps || [] };
    }).sort((a, b) => b.curC - a.curC),
    clusters: grp((h) => `${h.vcenterId}|${h.cluster || 'standalone'}`, avg5Cluster),
    vcenters: grp((h) => h.vcenterId, avg5Vc),
  });
});

// Temperature history (5년까지). level=host|cluster|vc, key=대상키, days=기간.
api.get('/tools/esxi-temp/history', async (req, res) => {
  const level = ['host', 'cluster', 'vc'].includes(req.query.level) ? req.query.level : 'host';
  const metric = { host: 'temp_host', cluster: 'temp_cluster', vc: 'temp_vc' }[level];
  const key = String(req.query.key || '');
  const days = Math.max(1, Math.min(1830, Number(req.query.days) || 7));
  const since = Date.now() - days * 86_400_000;
  // 집계 단위(기준): 분/시간/일 명시 선택, 미지정 시 기간에 따라 자동.
  const BUCKET = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
  const bucket = BUCKET[req.query.bucket] ? req.query.bucket : 'auto';
  const bucketMs = BUCKET[req.query.bucket]
    || (days <= 2 ? 3_600_000 : days <= 14 ? 6 * 3_600_000 : days <= 120 ? 86_400_000 : days <= 800 ? 7 * 86_400_000 : 30 * 86_400_000);
  // 분 단위 등 미세 집계는 점이 많아질 수 있어 상한을 넉넉히.
  const limit = bucketMs <= 60_000 ? 5000 : bucketMs <= 3_600_000 ? 3000 : 1500;
  let points = [];
  try { const db = await getMetricsDb(); points = db.history(metric, key, since, bucketMs, limit); } catch { points = []; }
  let synthesized = false;
  if (points.length < 2 && store.get().source === 'mock') {
    // 데모: 합성 시계열(계절·일교차·분 변동 반영). 분 단위는 점이 많아 최근 구간만.
    synthesized = true; points = [];
    const cap = limit;
    let startT = since;
    if ((Date.now() - since) / bucketMs > cap) startT = Date.now() - cap * bucketMs;
    const base = 26 + (hash(key) % 8);
    for (let t = startT; t <= Date.now(); t += bucketMs) {
      const day = t / 86_400_000; const minute = t / 60_000;
      const v = base + 6 * Math.sin(day / 58) + 3 * Math.sin(day) + 1.2 * Math.sin(minute / 7) + (hash(key + t) % 3);
      points.push({ ts: Math.floor(t), avg: Number(v.toFixed(1)), min: Number((v - 2).toFixed(1)), max: Number((v + 4).toFixed(1)) });
    }
  }
  res.json({ level, key, days, bucket, bucketMs, synthesized, points });
});

// 데이터스토어 용량 추세/예측 — ds_usedgb 히스토리로 선형회귀 → 가득 찰 예상일.
api.get('/tools/capacity-forecast', async (req, res) => {
  const snap = store.get();
  const vcId = req.query.vcenterId;
  const dss = (snap.datastores || []).filter((d) => !vcId || d.vcenterId === vcId);
  let db = null; try { db = await getMetricsDb(); } catch { /* */ }
  const mock = snap.source === 'mock';
  const items = [];
  for (const d of dss) {
    let pts = [];
    if (db) { try { pts = db.history('ds_usedgb', d.id, Date.now() - 120 * 86_400_000, 86_400_000, 200); } catch { /* */ } }
    let slope = null; let synthesized = false; // GB/day
    if (pts.length >= 3) {
      slope = linregSlope(pts.map((p) => p.ts / 86_400_000), pts.map((p) => p.avg));
    } else if (mock) {
      synthesized = true; slope = Math.max(0, (d.capacityGB * 0.0008) + (hash(d.id) % 5) * 0.2); // 합성 증가율
    }
    const freeGB = d.freeGB ?? Math.max(0, (d.capacityGB || 0) - (d.usedGB || 0));
    const daysToFull = slope && slope > 0.01 ? Math.round(freeGB / slope) : null;
    items.push({ id: d.id, name: d.name, vcenterId: d.vcenterId, type: d.type, capacityGB: d.capacityGB, usedGB: d.usedGB, freeGB, usagePct: d.usagePct, growthGBperDay: slope == null ? null : Number(slope.toFixed(2)), daysToFull, synthesized });
  }
  items.sort((a, b) => (a.daysToFull ?? Infinity) - (b.daysToFull ?? Infinity));
  res.json({ scope: vcId || 'all', mock, items });
});

// Guest OS distribution — VM counts grouped by Guest OS (종류·버전), optionally
// per vCenter. Family rollup + full-name detail; power(on/off) split.
api.get('/tools/guest-os', (req, res) => {
  const snap = store.get();
  let vms = snap.vms;
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  // 전원(on/off) · 종류(vm/template) 필터
  if (req.query.power === 'on') vms = vms.filter((v) => v.powerState === 'POWERED_ON');
  else if (req.query.power === 'off') vms = vms.filter((v) => v.powerState !== 'POWERED_ON');
  if (req.query.kind === 'vm') vms = vms.filter((v) => !v.template);
  else if (req.query.kind === 'template') vms = vms.filter((v) => v.template);
  const byName = new Map();
  const byFamily = new Map();
  for (const v of vms) {
    const name = (v.guestOS || '미상').trim() || '미상';
    const on = v.powerState === 'POWERED_ON';
    const n = byName.get(name) || { os: name, family: osFamily(v.guestOS), total: 0, on: 0, off: 0 };
    n.total++; if (on) n.on++; else n.off++;
    byName.set(name, n);
    const fam = osFamily(v.guestOS);
    const f = byFamily.get(fam) || { family: fam, total: 0, on: 0 };
    f.total++; if (on) f.on++;
    byFamily.set(fam, f);
  }
  res.json({
    total: vms.length,
    distinctOs: byName.size,
    families: [...byFamily.values()].sort((a, b) => b.total - a.total),
    items: [...byName.values()].sort((a, b) => b.total - a.total),
  });
});

// 특정 Guest OS(종류·버전) 또는 계열에 해당하는 VM 목록 — VM 수 클릭 시 대상 VM/CSV용.
// 쿼리: vcenterId·power(on/off)·kind(vm/template) + os(정확 일치) 또는 family(계열).
api.get('/tools/guest-os/vms', (req, res) => {
  const snap = store.get();
  let vms = snap.vms;
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  if (req.query.power === 'on') vms = vms.filter((v) => v.powerState === 'POWERED_ON');
  else if (req.query.power === 'off') vms = vms.filter((v) => v.powerState !== 'POWERED_ON');
  if (req.query.kind === 'vm') vms = vms.filter((v) => !v.template);
  else if (req.query.kind === 'template') vms = vms.filter((v) => v.template);
  if (req.query.os) { const os = String(req.query.os); vms = vms.filter((v) => ((v.guestOS || '미상').trim() || '미상') === os); }
  if (req.query.family) { const fam = String(req.query.family); vms = vms.filter((v) => osFamily(v.guestOS) === fam); }
  const items = vms.map((v) => ({
    name: v.name, vcenterId: v.vcenterId, cluster: v.cluster || '', host: v.host || '',
    guestOS: v.guestOS || '', powerState: v.powerState,
    cpu: v.cpuCount || 0, memGB: Math.round((v.memMB || 0) / 1024), diskGB: v.storageGB || 0,
    ip: (v.ipAddresses?.length ? v.ipAddresses : (v.ipAddress ? [v.ipAddress] : [])).join(' '),
  })).sort((a, b) => (a.vcenterId === b.vcenterId ? a.name.localeCompare(b.name) : a.vcenterId.localeCompare(b.vcenterId)));
  res.json({ total: items.length, items: items.slice(0, 10000) });
});

// Host HBA adapters and their link speeds (optionally per vCenter).
api.get('/tools/hba', (req, res) => {
  const snap = store.get();
  let hosts = snap.hosts;
  if (req.query.vcenterId) hosts = hosts.filter((h) => h.vcenterId === req.query.vcenterId);
  const items = [];
  const speedDist = {};
  for (const h of hosts) {
    for (const hba of h.hbas || []) {
      items.push({ host: h.name, vcenterId: h.vcenterId, cluster: h.cluster, name: hba.name, type: hba.type, model: hba.model, speedGbps: hba.speedGbps || 0, wwn: hba.wwn || '', status: hba.status || '' });
      const k = hba.speedGbps ? `${hba.speedGbps}Gb` : '미상';
      speedDist[k] = (speedDist[k] || 0) + 1;
    }
  }
  res.json({
    hostsWithHba: hosts.filter((h) => (h.hbas || []).length).length,
    adapters: items.length,
    speedDistribution: Object.entries(speedDist).map(([speed, count]) => ({ speed, count })).sort((a, b) => parseFloat(b.speed) - parseFloat(a.speed)),
    items,
  });
});

// License overview across all vCenters (optionally one). Aggregates per product.
api.get('/tools/licenses', (req, res) => {
  const snap = store.get();
  let vcs = snap.vcenters || [];
  if (req.query.vcenterId) vcs = vcs.filter((v) => v.id === req.query.vcenterId);
  const items = [];
  for (const vc of vcs) for (const l of vc.licenses || []) items.push({ vcenterId: vc.id, vcenterName: vc.name, ...l });
  // rollup by license name
  const roll = new Map();
  for (const l of items) {
    const k = l.name || l.edition || 'unknown';
    if (!roll.has(k)) roll.set(k, { name: k, total: 0, used: 0, product: l.product, productVersion: l.productVersion, count: 0 });
    const e = roll.get(k); e.total += l.total || 0; e.used += l.used || 0; e.count++;
  }
  res.json({
    items,
    byLicense: [...roll.values()].sort((a, b) => b.used - a.used),
    totalAssigned: items.reduce((a, l) => a + (l.used || 0), 0),
  });
});

// Trigger VMware Tools upgrade on one or more VMs. Body: { ids:[vmId,...] }.
api.post('/vms/upgrade-tools', requireRole('admin', 'operator'), async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ ok: false, reason: '대상 VM이 없습니다.' });
  const snap = store.get();
  if (snap.source === 'mock') {
    return res.json({ ok: true, mock: true, requested: ids.length, results: ids.map((id) => ({ id, ok: true })) });
  }
  // live: group by vCenter and call UpgradeTools_Task
  const byVc = new Map();
  for (const id of ids) {
    const sep = id.indexOf(':');
    const vcId = sep >= 0 ? id.slice(0, sep) : id;
    const moref = sep >= 0 ? id.slice(sep + 1) : '';
    if (!byVc.has(vcId)) byVc.set(vcId, []);
    byVc.get(vcId).push({ id, moref });
  }
  const cfg = loadVcenterConfig().vcenters;
  const results = [];
  for (const [vcId, list] of byVc) {
    const vc = cfg.find((v) => v.id === vcId);
    if (!vc) { for (const x of list) results.push({ id: x.id, ok: false, error: 'vCenter 설정 없음' }); continue; }
    try {
      const r = await upgradeVmTools(vc, list.map((x) => x.moref));
      r.forEach((rr, i) => results.push({ id: list[i].id, ok: rr.ok, error: rr.error }));
    } catch (err) {
      for (const x of list) results.push({ id: x.id, ok: false, error: err.message });
    }
  }
  res.json({ ok: true, requested: ids.length, succeeded: results.filter((r) => r.ok).length, results });
});

// Shared UI settings (e.g. dashboard map height) — same for all users.
api.get('/ui-settings', (_req, res) => res.json(loadUiSettings()));
api.put('/ui-settings', (req, res) => res.json(saveUiSettings(req.body || {})));

/** Map a guest OS string to a coarse family for distribution charts. */
function osFamily(os = '') {
  const s = os.toLowerCase();
  if (s.includes('windows')) return 'Windows';
  if (s.includes('red hat') || s.includes('rhel')) return 'RHEL';
  if (s.includes('ubuntu')) return 'Ubuntu';
  if (s.includes('centos')) return 'CentOS';
  if (s.includes('suse')) return 'SUSE';
  if (s.includes('debian')) return 'Debian';
  return 'Other';
}

// Consolidated summary: SUM of every resource across all vCenters, with
// allocation totals, overcommit ratios, OS distribution and per-vCenter
// contribution. Optional ?vcenterId= / ?region= scoping.
api.get('/summary', (req, res) => {
  const snap = store.get();
  const vcenters = applyFilters(snap.vcenters.map((v) => ({ ...v, vcenterId: v.id })), req.query, snap, ['name']);
  const vcIds = new Set(vcenters.map((v) => v.id));
  const hosts = snap.hosts.filter((h) => vcIds.has(h.vcenterId));
  const vms = snap.vms.filter((v) => vcIds.has(v.vcenterId));
  const datastores = snap.datastores.filter((d) => vcIds.has(d.vcenterId));
  const networks = snap.networks.filter((n) => vcIds.has(n.vcenterId));
  const alarms = snap.alarms.filter((a) => vcIds.has(a.vcenterId));
  const sum = (arr, fn) => arr.reduce((a, x) => a + (fn(x) || 0), 0);

  const clusters = new Set(hosts.map((h) => `${h.vcenterId}/${h.cluster}`)).size;
  const cpuCores = sum(hosts, (h) => h.cpuCores);
  const cpuTotalMhz = sum(hosts, (h) => h.cpuTotalMhz);
  const cpuUsedMhz = sum(hosts, (h) => h.cpuUsageMhz);
  const memTotalMB = sum(hosts, (h) => h.memTotalMB);
  const memUsedMB = sum(hosts, (h) => h.memUsageMB);
  const storCapGB = sum(datastores, (d) => d.capacityGB);
  const storUsedGB = sum(datastores, (d) => d.usedGB);

  // VM allocation totals (what is provisioned, regardless of host capacity)
  const vmVcpu = sum(vms, (v) => v.cpuCount);
  const vmRamMB = sum(vms, (v) => v.memMB);
  const vmProvGB = sum(vms, (v) => v.storageGB);

  // OS allocation table can be filtered by power state and VM/template.
  const osVms = vms.filter((v) => {
    if (req.query.power === 'on' && v.powerState !== 'POWERED_ON') return false;
    if (req.query.power === 'off' && v.powerState !== 'POWERED_OFF') return false;
    if (req.query.kind === 'template' && !v.template) return false;
    if (req.query.kind === 'vm' && v.template) return false;
    return true;
  });
  const osDist = {};
  const osAlloc = {}; // OS family -> { vms, vcpu, ramMB, diskGB }
  for (const v of osVms) {
    const f = osFamily(v.guestOS);
    osDist[f] = (osDist[f] || 0) + 1;
    const a = osAlloc[f] || (osAlloc[f] = { name: f, vms: 0, vcpu: 0, ramMB: 0, diskGB: 0 });
    a.vms += 1;
    a.vcpu += v.cpuCount || 0;
    a.ramMB += v.memMB || 0;
    a.diskGB += v.storageGB || 0;
  }

  const round = (v, d = 0) => Number((v || 0).toFixed(d));
  const pct = (u, t) => (t > 0 ? Math.round((u / t) * 100) : 0);

  // Per-vCenter contribution (the SUM each site adds to the whole)
  const byVcenter = vcenters.map((vc) => {
    const h = hosts.filter((x) => x.vcenterId === vc.id);
    const v = vms.filter((x) => x.vcenterId === vc.id);
    const d = datastores.filter((x) => x.vcenterId === vc.id);
    return {
      id: vc.id, name: vc.name, region: vc.location?.region, status: vc.status,
      hosts: h.length,
      vms: v.length,
      vmsPoweredOn: v.filter((x) => x.powerState === 'POWERED_ON').length,
      cpuCores: sum(h, (x) => x.cpuCores),
      memTotalGB: round(sum(h, (x) => x.memTotalMB) / 1024),
      storageTotalTB: round(sum(d, (x) => x.capacityGB) / 1024, 1),
      vcpuAllocated: sum(v, (x) => x.cpuCount),
      ramAllocatedGB: round(sum(v, (x) => x.memMB) / 1024),
      provisionedTB: round(sum(v, (x) => x.storageGB) / 1024, 1),
      powerKw: round(sum(h, (x) => x.powerWatts) / 1000, 1),
    };
  }).sort((a, b) => b.vms - a.vms);

  const powerWatts = sum(hosts, (h) => h.powerWatts);
  const powerReporting = hosts.filter((h) => h.powerWatts > 0).length;

  res.json({
    generatedAt: snap.generatedAt,
    source: snap.source,
    counts: {
      vcenters: vcenters.length,
      vcentersConnected: vcenters.filter((v) => v.status === 'connected').length,
      clusters,
      hosts: hosts.length,
      hostsConnected: hosts.filter((h) => h.connectionState === 'CONNECTED').length,
      hostsMaintenance: hosts.filter((h) => h.connectionState === 'MAINTENANCE').length,
      hostsDisconnected: hosts.filter((h) => h.connectionState === 'DISCONNECTED').length,
      vms: vms.length,
      vmsPoweredOn: vms.filter((v) => v.powerState === 'POWERED_ON').length,
      vmsPoweredOff: vms.filter((v) => v.powerState !== 'POWERED_ON').length,
      datastores: datastores.length,
      networks: networks.length,
      alarms: alarms.length,
      alarmsCritical: alarms.filter((a) => a.severity === 'critical').length,
      alarmsWarning: alarms.filter((a) => a.severity === 'warning').length,
    },
    compute: {
      cpuCores,
      cpuTotalGhz: round(cpuTotalMhz / 1000, 1),
      cpuUsedGhz: round(cpuUsedMhz / 1000, 1),
      cpuUsagePct: pct(cpuUsedMhz, cpuTotalMhz),
      memTotalGB: round(memTotalMB / 1024),
      memUsedGB: round(memUsedMB / 1024),
      memUsagePct: pct(memUsedMB, memTotalMB),
    },
    storage: {
      capacityTB: round(storCapGB / 1024, 1),
      usedTB: round(storUsedGB / 1024, 1),
      freeTB: round((storCapGB - storUsedGB) / 1024, 1),
      usagePct: pct(storUsedGB, storCapGB),
    },
    power: {
      watts: powerWatts,
      kw: round(powerWatts / 1000, 1),
      reporting: powerReporting,
      // Rough annual energy & cost projection (24/7), informational only.
      annualMwh: round((powerWatts * 24 * 365) / 1e9, 1),
    },
    allocation: {
      vcpuAllocated: vmVcpu,
      ramAllocatedGB: round(vmRamMB / 1024),
      provisionedStorageTB: round(vmProvGB / 1024, 1),
      // Overcommit: allocated vCPU / physical cores, allocated RAM / physical RAM
      vcpuPerCore: cpuCores > 0 ? round(vmVcpu / cpuCores, 2) : 0,
      ramOvercommitPct: memTotalMB > 0 ? Math.round((vmRamMB / memTotalMB) * 100) : 0,
      avgVmPerHost: hosts.length > 0 ? round(vms.length / hosts.length, 1) : 0,
    },
    osDistribution: Object.entries(osDist).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    osAllocation: Object.values(osAlloc).map((a) => ({
      name: a.name,
      vms: a.vms,
      vcpu: a.vcpu,
      ramGB: round(a.ramMB / 1024),
      diskGB: a.diskGB,
      diskTB: round(a.diskGB / 1024, 1),
    })).sort((a, b) => b.vcpu - a.vcpu),
    byVcenter,
  });
});

api.get('/hosts', (req, res) => {
  const snap = store.get();
  let hosts = applyFilters(snap.hosts, req.query, snap, ['name', 'cluster']);
  if (req.query.state) hosts = hosts.filter((h) => h.connectionState === req.query.state);

  // Global host summary for the top of the 호스트 screen.
  const sm = (fn) => hosts.reduce((a, h) => a + (fn(h) || 0), 0);
  const hostNames = new Set(hosts.map((h) => h.name));
  // vCore = vCPU allocated to VMs running on the in-scope hosts.
  const vcoreAllocated = snap.vms.filter((v) => hostNames.has(v.host)).reduce((a, v) => a + (v.cpuCount || 0), 0);
  const verMap = {};
  for (const h of hosts) { const v = h.version || 'unknown'; verMap[v] = (verMap[v] || 0) + 1; }
  const physicalCores = sm((h) => h.cpuCores);
  const summary = {
    total: hosts.length,
    connected: hosts.filter((h) => h.connectionState === 'CONNECTED').length,
    maintenance: hosts.filter((h) => h.connectionState === 'MAINTENANCE').length,
    disconnected: hosts.filter((h) => h.connectionState === 'DISCONNECTED').length,
    poweredOn: hosts.filter((h) => h.powerState === 'POWERED_ON').length,
    poweredOff: hosts.filter((h) => h.powerState && h.powerState !== 'POWERED_ON').length,
    physicalCores,
    logicalCores: sm((h) => h.cpuThreads || h.cpuCores),
    vcoreAllocated,
    vcorePerCore: physicalCores > 0 ? Math.round((vcoreAllocated / physicalCores) * 100) / 100 : 0,
    memTotalGB: Math.round(sm((h) => h.memTotalMB) / 1024),
    powerKw: Math.round(sm((h) => h.powerWatts) / 100) / 10,
    esxiVersions: Object.entries(verMap).map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count),
  };
  res.json({ total: hosts.length, items: hosts, summary });
});

api.get('/vms', (req, res) => {
  const snap = store.get();
  const q = req.query;
  let vms = applyFilters(snap.vms, q, snap, ['name', 'guestOS', 'ipAddress', 'host']);
  if (q.powerState) vms = vms.filter((v) => v.powerState === q.powerState);

  // Spec-based search: numeric range filters on VM sizing & live usage.
  const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
  const ranges = [
    ['cpuCount', num(q.vcpuMin), num(q.vcpuMax)],
    ['memMB', num(q.ramMinGB) != null ? num(q.ramMinGB) * 1024 : undefined, num(q.ramMaxGB) != null ? num(q.ramMaxGB) * 1024 : undefined],
    ['storageGB', num(q.diskMinGB), num(q.diskMaxGB)],
    ['cpuUsagePct', num(q.cpuUsageMin), num(q.cpuUsageMax)],
    ['memUsagePct', num(q.memUsageMin), num(q.memUsageMax)],
  ];
  for (const [field, min, max] of ranges) {
    if (min != null && !Number.isNaN(min)) vms = vms.filter((v) => v[field] >= min);
    if (max != null && !Number.isNaN(max)) vms = vms.filter((v) => v[field] <= max);
  }
  if (q.os) vms = vms.filter((v) => String(v.guestOS).toLowerCase().includes(String(q.os).toLowerCase()));
  if (q.toolsStatus) vms = vms.filter((v) => v.toolsStatus === q.toolsStatus);

  // GPU 할당 VM 집계(현재 필터 범위) + GPU 전용/종류 필터.
  const gpuType = (v) => v.gpu?.type || null;
  const gpuCounts = {
    total: vms.filter((v) => v.gpu).length,
    vgpu: vms.filter((v) => gpuType(v) === 'vgpu').length,
    passthrough: vms.filter((v) => gpuType(v) === 'passthrough').length,
    mixed: vms.filter((v) => gpuType(v) === 'mixed').length,
  };
  if (q.gpu === '1' || q.gpu === 'true') vms = vms.filter((v) => v.gpu);
  if (q.gpuType) vms = vms.filter((v) => gpuType(v) === q.gpuType);

  if (q.sortBy) vms = sortBy(vms, q.sortBy, q.order);
  const limit = Math.min(Number(q.limit) || 500, 5000);

  // Aggregate over ALL matched VMs (not just the page) so the UI can show the
  // sum of the searched resources: vCPU/RAM/disk allocation + avg usage.
  const sm = (fn) => vms.reduce((a, v) => a + (fn(v) || 0), 0);
  const on = vms.filter((v) => v.powerState === 'POWERED_ON');
  const avg = (arr, fn) => (arr.length ? Math.round((arr.reduce((a, v) => a + (fn(v) || 0), 0) / arr.length) * 10) / 10 : 0);
  const totals = {
    count: vms.length,
    poweredOn: on.length,
    poweredOff: vms.length - on.length,
    vcpu: sm((v) => v.cpuCount),
    ramGB: Math.round(sm((v) => v.memMB) / 1024),
    diskGB: sm((v) => v.storageGB),
    diskTB: Math.round(sm((v) => v.storageGB) / 1024 * 10) / 10,
    avgCpuUsagePct: avg(on, (v) => v.cpuUsagePct),
    avgMemUsagePct: avg(on, (v) => v.memUsagePct),
    // 평균 디스크 사용율 = 프로비저닝(committed+uncommitted) 대비 실제 사용(committed).
    // thick 디스크는 uncommitted=0 → 100%. 게스트 파일시스템 사용율과는 다름.
    avgDiskUsagePct: avg(vms.filter((v) => (v.storageGB || 0) + (v.uncommittedGB || 0) > 0),
      (v) => ((v.storageGB || 0) / ((v.storageGB || 0) + (v.uncommittedGB || 0))) * 100),
    gpu: gpuCounts,
  };
  res.json({ total: vms.length, items: vms.slice(0, limit), totals });
});

// VM 단건 조회 — 이름/IP/호스트명으로 스냅샷에서 찾아 상세 팝업에 쓴다(모든 화면 공용).
api.get('/vms/lookup', (req, res) => {
  const { name, ip, vcenterId } = req.query;
  const vms = (store.get().vms || []).filter((v) => !vcenterId || v.vcenterId === vcenterId);
  let vm = null;
  if (ip) vm = vms.find((v) => (v.ipAddresses || []).includes(ip) || v.ipAddress === ip);
  if (!vm && name) {
    const n = String(name).toLowerCase();
    vm = vms.find((v) => (v.name || '').toLowerCase() === n) || vms.find((v) => (v.name || '').toLowerCase().includes(n));
  }
  res.json({ vm: vm || null });
});

api.get('/datastores', (req, res) => {
  const snap = store.get();
  let ds = applyFilters(snap.datastores, req.query, snap, ['name', 'type']);
  if (req.query.type) ds = ds.filter((d) => String(d.type || '').toLowerCase().includes(String(req.query.type).toLowerCase()));
  res.json({ total: ds.length, items: ds });
});

api.get('/networks', (req, res) => {
  const snap = store.get();
  let nets = applyFilters(snap.networks, req.query, snap, ['name', 'type']);
  if (req.query.type) nets = nets.filter((n) => n.type === req.query.type);
  res.json({ total: nets.length, items: nets });
});

// Top resource consumers across the whole estate (or a filtered scope).
// ?vcenterId= / ?region= scope it; ?limit= controls list length (default 10).
api.get('/top', (req, res) => {
  const snap = store.get();
  const limit = Math.min(Number(req.query.limit) || 10, 100);
  const vms = applyFilters(snap.vms, req.query, snap, ['name']);
  const hosts = applyFilters(snap.hosts, req.query, snap, ['name']);
  const datastores = applyFilters(snap.datastores, req.query, snap, ['name']);
  const onVms = vms.filter((v) => v.powerState === 'POWERED_ON');

  const top = (arr, key, n = limit) =>
    [...arr].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, n);

  res.json({
    generatedAt: snap.generatedAt,
    scope: { vms: vms.length, hosts: hosts.length, datastores: datastores.length },
    vmsByCpuUsage: top(onVms, 'cpuUsagePct'),
    vmsByMemUsage: top(onVms, 'memUsagePct'),
    vmsByVcpu: top(vms, 'cpuCount'),
    vmsByRam: top(vms, 'memMB'),
    vmsByStorage: top(vms, 'storageGB'),
    hostsByCpu: top(hosts, 'cpuUsagePct'),
    hostsByMem: top(hosts, 'memUsagePct'),
    hostsByVmCount: top(hosts, 'vmCount'),
    hostsByPower: top(hosts.filter((h) => h.powerWatts > 0), 'powerWatts'),
    datastoresByUsage: top(datastores, 'usagePct'),
  });
});

api.get('/alarms', (req, res) => {
  const snap = store.get();
  let alarms = applyFilters(snap.alarms, req.query, snap, ['message', 'entity']);
  if (req.query.severity) alarms = alarms.filter((a) => a.severity === req.query.severity);
  res.json({ total: alarms.length, items: alarms });
});

// Alarm mute rules — "이 알람 앞으로 무시". Muted alarms are filtered globally.
api.get('/alarm-mutes', (_req, res) => res.json({ mutes: listMutes() }));
api.post('/alarm-mutes', requireRole('admin', 'operator'), (req, res) => {
  const result = addMute(req.body || {});
  if (result.ok) store.refresh().catch(() => {}); // re-apply immediately
  res.status(result.ok ? 200 : 400).json(result);
});
api.delete('/alarm-mutes/:id', requireRole('admin', 'operator'), (req, res) => {
  const result = removeMute(decodeURIComponent(req.params.id));
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 200 : 404).json(result);
});
