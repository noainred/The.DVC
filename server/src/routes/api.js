import { Router } from 'express';
import { store } from '../store.js';
import { currentVersion, config } from '../config.js';
import { loadUiSettings, saveUiSettings } from '../ui-settings.js';
import { hostPower } from '../idrac/service.js';

export const api = Router();

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

api.get('/vcenters', (_req, res) => {
  res.json(store.get().rollups?.sites ?? []);
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

  const osDist = {};
  for (const v of vms) { const f = osFamily(v.guestOS); osDist[f] = (osDist[f] || 0) + 1; }

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
    byVcenter,
  });
});

api.get('/hosts', (req, res) => {
  const snap = store.get();
  let hosts = applyFilters(snap.hosts, req.query, snap, ['name', 'cluster']);
  if (req.query.state) hosts = hosts.filter((h) => h.connectionState === req.query.state);
  res.json({ total: hosts.length, items: hosts });
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
  res.json({ total: vms.length, items: vms.slice(0, limit) });
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
