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
  let vms = applyFilters(snap.vms, req.query, snap, ['name', 'guestOS', 'ipAddress', 'host']);
  if (req.query.powerState) vms = vms.filter((v) => v.powerState === req.query.powerState);
  const limit = Math.min(Number(req.query.limit) || 500, 5000);
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

api.get('/alarms', (req, res) => {
  const snap = store.get();
  let alarms = applyFilters(snap.alarms, req.query, snap, ['message', 'entity']);
  if (req.query.severity) alarms = alarms.filter((a) => a.severity === req.query.severity);
  res.json({ total: alarms.length, items: alarms });
});
