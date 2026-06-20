import { Router } from 'express';
import { store } from '../store.js';
import { currentVersion, config, loadVcenterConfig } from '../config.js';
import { loadUiSettings, saveUiSettings } from '../ui-settings.js';
import { hostPower } from '../idrac/service.js';
import { fetchVmMetric, PERF_INTERVALS, upgradeVmTools, getVmConsole } from '../vcenter/soapClient.js';
import { listMutes, addMute, removeMute } from '../alarm-mutes.js';
import { buildIpamRows, buildSubnetSheets, listSubnets } from '../ipam/ledger.js';
import { buildWorkbook } from '../ipam/excel.js';
import { listNotes } from '../release-notes.js';
import { nlSearch } from '../llm/nlSearch.js';
import { nsxStore } from '../nsx/store.js';
import { expandSpec } from '../provision/spec.js';
import { listSources, listJobs, getJob } from '../provision/jobs.js';

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
function applyFilters(items, query, snap, searchFields = ['name']) {
  let out = items;
  if (query.vcenterId) out = out.filter((x) => x.vcenterId === query.vcenterId);
  if (query.region) {
    const ids = snap.vcenters.filter((v) => v.location?.region === query.region).map((v) => v.id);
    out = out.filter((x) => ids.includes(x.vcenterId));
  }
  if (query.q) {
    const q = String(query.q).toLowerCase();
    out = out.filter((x) => searchFields.some((f) => String(x[f] ?? '').toLowerCase().includes(q)));
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
  res.json({ generatedAt: snap.generatedAt, source: snap.source, ...snap.rollups });
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
    collectionErrors: snap.collectionErrors,
  });
});

// --- VM 프로비저닝 (생성/대량 생성) ---
// Clonable source VMs/templates from the current snapshot (optionally scoped).
api.get('/provision/sources', (req, res) => {
  res.json({ sources: listSources(req.query.vcenterId) });
});
// Dry-run: expand a bulk spec into the concrete per-VM list (name/hostname/ip).
api.post('/provision/preview', (req, res) => {
  const { vms, errors } = expandSpec(req.body || {});
  res.json({ ok: errors.length === 0, count: vms.length, vms: vms.slice(0, 500), errors });
});
// Provisioning jobs (only the caller's own; admins see all).
api.get('/provision/jobs', (req, res) => res.json({ jobs: listJobs(req.user) }));
api.get('/provision/jobs/:id', (req, res) => {
  const job = getJob(req.params.id, req.user);
  if (!job) return res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다.' });
  res.json(job);
});

api.get('/vcenters', (_req, res) => {
  res.json(store.get().rollups?.sites ?? []);
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

// Per-/24 subnet ledger (Excel-style): subnet list, one subnet's rows, or full .xlsx.
api.get('/tools/ipam/subnets', (req, res) => {
  res.json({ subnets: listSubnets(store.get(), req.query.vcenterId) });
});
api.get('/tools/ipam/sheet', (req, res) => {
  const sheets = buildSubnetSheets(store.get(), { vcenterId: req.query.vcenterId, onlyBase: req.query.base });
  res.json(sheets[0] || { subnet: '', rows: [] });
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
api.get('/tools/gpu', (req, res) => {
  const snap = store.get();
  let hosts = snap.hosts;
  if (req.query.vcenterId) hosts = hosts.filter((h) => h.vcenterId === req.query.vcenterId);
  const hostsWithGpu = [];
  const byModel = {};
  const byVcenter = {};
  let totalGpus = 0;
  for (const h of hosts) {
    const gpus = h.gpus || [];
    if (!gpus.length) continue;
    totalGpus += gpus.length;
    hostsWithGpu.push({ host: h.name, vcenterId: h.vcenterId, cluster: h.cluster, count: gpus.length, model: gpus[0].model, memGB: gpus[0].memGB, vgpu: gpus[0].vgpuMode });
    for (const g of gpus) {
      byModel[g.model] = (byModel[g.model] || 0) + 1;
      byVcenter[h.vcenterId] = (byVcenter[h.vcenterId] || 0) + 1;
    }
  }
  res.json({
    totalGpus,
    hostsWithGpu: hostsWithGpu.length,
    byModel: Object.entries(byModel).map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count),
    byVcenter: Object.entries(byVcenter).map(([vcenterId, count]) => ({ vcenterId, count })).sort((a, b) => b.count - a.count),
    items: hostsWithGpu.sort((a, b) => b.count - a.count),
  });
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
api.post('/vms/upgrade-tools', async (req, res) => {
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
  };
  res.json({ total: vms.length, items: vms.slice(0, limit), totals });
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
api.post('/alarm-mutes', (req, res) => {
  const result = addMute(req.body || {});
  if (result.ok) store.refresh().catch(() => {}); // re-apply immediately
  res.status(result.ok ? 200 : 400).json(result);
});
api.delete('/alarm-mutes/:id', (req, res) => {
  const result = removeMute(decodeURIComponent(req.params.id));
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 200 : 404).json(result);
});
