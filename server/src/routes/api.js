import { Router } from 'express';
import { store } from '../store.js';

export const api = Router();

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
  res.json({ status: 'ok', source: snap.source, generatedAt: snap.generatedAt, vcenters: snap.vcenters.length });
});

// High-level KPIs + regional / per-site rollups for the dashboard landing view.
api.get('/overview', (_req, res) => {
  const snap = store.get();
  res.json({ generatedAt: snap.generatedAt, source: snap.source, ...snap.rollups });
});

api.get('/vcenters', (_req, res) => {
  res.json(store.get().rollups?.sites ?? []);
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
  const ds = applyFilters(snap.datastores, req.query, snap, ['name', 'type']);
  res.json({ total: ds.length, items: ds });
});

api.get('/networks', (req, res) => {
  const snap = store.get();
  const nets = applyFilters(snap.networks, req.query, snap, ['name', 'type']);
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
    datastoresByUsage: top(datastores, 'usagePct'),
  });
});

api.get('/alarms', (req, res) => {
  const snap = store.get();
  let alarms = applyFilters(snap.alarms, req.query, snap, ['message', 'entity']);
  if (req.query.severity) alarms = alarms.filter((a) => a.severity === req.query.severity);
  res.json({ total: alarms.length, items: alarms });
});
