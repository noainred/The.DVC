/**
 * Remote-access API: manage HAProxy Data Plane config + per-target SSH/RDP
 * mappings, and serve connection artifacts (.rdp file; SSH uses the WS gateway).
 * Mounted behind authMiddleware; mutating/config endpoints require admin.
 */

import { Router } from 'express';
import { store } from '../store.js';
import { requireRole } from '../auth/auth.js';
import {
  getConfig, getConfigSafe, saveConfig,
  listMappings, getMapping, addMapping, removeMapping, setMappingStatus,
  listProxies, listProxiesSafe, getProxyById, resolveProxy, saveProxy, removeProxy,
} from '../proxy/registry.js';
import { testDataplane, applyMapping, removeMapping as haproxyRemove } from '../proxy/dataplane.js';
import { deployToProxy, previewConfig, testDeploy } from '../proxy/deploy.js';

export const remoteRouter = Router();
const adminOnly = requireRole('admin');

// Connection info for a mapping resolves through the mapping's assigned proxy.
const mappingProxy = (m) => getProxyById(m.proxyId);

// Public-ish (any authenticated user): list mappings + how to connect.
remoteRouter.get('/mappings', (_req, res) => {
  res.json({
    mappings: listMappings().map(({ error, ...m }) => {
      const p = mappingProxy(m);
      return { ...m, proxyName: p.name, proxyHost: p.proxyHost, guacdConfigured: !!p.guacd?.host };
    }),
  });
});

// vCenter → proxy assignments (any authenticated user; secrets redacted for admin view).
remoteRouter.get('/proxies', (_req, res) => {
  res.json({ proxies: listProxies().map((p) => ({ id: p.id, name: p.name, proxyHost: p.proxyHost, vcenterIds: p.vcenterIds, guacdConfigured: !!p.guacd?.host })) });
});

// Candidate targets from vCenter: VMs that have at least one IP, with all IPs
// so the user can pick which address to map (multi-homed VMs). Optional ?q / ?vcenterId.
remoteRouter.get('/targets', (req, res) => {
  const snap = store.get();
  const q = String(req.query.q || '').toLowerCase();
  const targets = [];
  for (const vm of snap.vms) {
    if (req.query.vcenterId && vm.vcenterId !== req.query.vcenterId) continue;
    const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
    if (!ips.length) continue;
    if (q && !vm.name.toLowerCase().includes(q) && !ips.some((ip) => ip.includes(q))) continue;
    targets.push({ id: vm.id, name: vm.name, vcenterId: vm.vcenterId, guestOS: vm.guestOS, powerState: vm.powerState, ips });
  }
  targets.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ targets: targets.slice(0, 500), total: targets.length });
});

remoteRouter.get('/config', adminOnly, (_req, res) => res.json({ config: getConfigSafe() }));

remoteRouter.put('/config', adminOnly, (req, res) => res.json({ ok: true, config: saveConfig(req.body || {}) }));

// --- per-vCenter proxy CRUD (admin) ---
remoteRouter.get('/proxies/full', adminOnly, (_req, res) => res.json({ proxies: listProxiesSafe() }));
remoteRouter.post('/proxies', adminOnly, (req, res) => {
  const r = saveProxy(req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});
remoteRouter.delete('/proxies/:id', adminOnly, (req, res) => {
  const r = removeProxy(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

// Test a proxy's Data Plane API (by proxyId, or the default).
remoteRouter.post('/test', adminOnly, async (req, res) => {
  const proxy = getProxyById((req.body || {}).proxyId);
  const dp = { ...proxy.dataplane, ...((req.body || {}).dataplane || {}) };
  if (dp.password === '********') dp.password = proxy.dataplane.password;
  res.json(await testDataplane(dp));
});

// --- SSH-based proxy auto-deploy (alternative to Data Plane API) ---
remoteRouter.post('/deploy/test', adminOnly, async (req, res) => {
  const proxy = getProxyById((req.body || {}).proxyId);
  const dep = { ...proxy.deploy, ...((req.body || {}).deploy || {}) };
  if (dep.password === '********') dep.password = proxy.deploy.password;
  if (dep.privateKey === '********') dep.privateKey = proxy.deploy.privateKey;
  res.json(await testDeploy(dep));
});

// Push the generated HAProxy config for each proxy's mappings and reload.
remoteRouter.post('/deploy', adminOnly, async (req, res) => {
  const onlyId = (req.body || {}).proxyId;
  const results = [];
  for (const proxy of listProxies()) {
    if (onlyId && proxy.id !== onlyId) continue;
    if (!proxy.deploy?.enabled) continue;
    const ms = listMappings().filter((m) => (m.proxyId || 'default') === proxy.id);
    const r = await deployToProxy(proxy.deploy, ms, { bindAddress: proxy.dataplane?.bindAddress || '*' });
    if (r.ok) for (const m of ms) setMappingStatus(m.id, 'active', null);
    results.push({ proxy: proxy.name, ...r });
  }
  res.json({ ok: results.every((r) => r.ok), results });
});

// Provision a freshly-added mapping on ITS proxy (Data Plane or SSH deploy).
async function provision(mapping) {
  const proxy = mappingProxy(mapping);
  if (proxy.dataplane?.enabled) {
    try { await applyMapping(proxy.dataplane, mapping); setMappingStatus(mapping.id, 'active', null); }
    catch (err) { setMappingStatus(mapping.id, 'error', err.message); }
  } else if (proxy.deploy?.enabled) {
    const ms = listMappings().filter((m) => (m.proxyId || 'default') === proxy.id);
    const d = await deployToProxy(proxy.deploy, ms, { bindAddress: proxy.dataplane?.bindAddress || '*' });
    if (d.ok) for (const m of ms) setMappingStatus(m.id, 'active', null);
    else setMappingStatus(mapping.id, 'error', d.reason);
  } else {
    setMappingStatus(mapping.id, 'manual', `프록시 '${proxy.name}' Data Plane/SSH 배포 미사용 — 수동 설정 필요`);
  }
}

// Create a mapping, then provision it on HAProxy.
remoteRouter.post('/mappings', adminOnly, async (req, res) => {
  const r = addMapping(req.body || {});
  if (!r.ok) return res.status(400).json(r);
  await provision(r.mapping);
  res.json({ ok: true, mapping: getMapping(r.mapping.id) });
});

// One-click connect from a VM detail: reuse an existing mapping for the same
// target+port+protocol, else create+provision one. Any authenticated user.
remoteRouter.post('/quick-connect', async (req, res) => {
  const { protocol = 'ssh', targetHost, vcenterId, name } = req.body || {};
  const proto = protocol === 'rdp' ? 'rdp' : 'ssh';
  const targetPort = Number((req.body || {}).targetPort) || (proto === 'rdp' ? 3389 : 22);
  if (!targetHost) return res.status(400).json({ ok: false, reason: '대상 IP가 필요합니다.' });

  let m = listMappings().find((x) => x.targetHost === targetHost && Number(x.targetPort) === targetPort && x.protocol === proto);
  if (!m) {
    const r = addMapping({ name: name || `${proto.toUpperCase()} ${targetHost}`, vcenterId, protocol: proto, targetHost, targetPort });
    if (!r.ok) return res.status(400).json(r);
    await provision(r.mapping);
    m = getMapping(r.mapping.id);
  }
  const p = mappingProxy(m);
  res.json({ ok: true, mapping: m, proxyName: p.name, proxyHost: p.proxyHost, guacdConfigured: !!p.guacd?.host });
});

// Re-apply (e.g. after fixing Data Plane settings).
remoteRouter.post('/mappings/:id/apply', adminOnly, async (req, res) => {
  const m = getMapping(req.params.id);
  if (!m) return res.status(404).json({ ok: false, reason: '매핑을 찾을 수 없습니다.' });
  try { await applyMapping(mappingProxy(m).dataplane, m); setMappingStatus(m.id, 'active', null); res.json({ ok: true, mapping: getMapping(m.id) }); }
  catch (err) { setMappingStatus(m.id, 'error', err.message); res.status(400).json({ ok: false, reason: err.message }); }
});

remoteRouter.delete('/mappings/:id', adminOnly, async (req, res) => {
  const m = getMapping(req.params.id);
  if (!m) return res.status(404).json({ ok: false, reason: '매핑을 찾을 수 없습니다.' });
  const proxy = mappingProxy(m);
  if (proxy.dataplane?.enabled) { try { await haproxyRemove(proxy.dataplane, m); } catch { /* remove locally anyway */ } }
  const result = removeMapping(req.params.id);
  // SSH-deploy mode: re-push that proxy's config without the removed mapping.
  if (result.ok && !proxy.dataplane?.enabled && proxy.deploy?.enabled) {
    const ms = listMappings().filter((x) => (x.proxyId || 'default') === proxy.id);
    await deployToProxy(proxy.deploy, ms, { bindAddress: proxy.dataplane?.bindAddress || '*' }).catch(() => {});
  }
  res.json(result);
});

// Download an .rdp file pointing at proxyHost:publicPort (client-side RDP).
remoteRouter.get('/rdp/:id', (req, res) => {
  const m = getMapping(req.params.id);
  if (!m || m.protocol !== 'rdp') return res.status(404).end();
  const proxyHost = mappingProxy(m).proxyHost;
  const host = proxyHost || m.targetHost;
  const port = proxyHost ? m.publicPort : m.targetPort;
  const rdp = [
    `full address:s:${host}:${port}`,
    'prompt for credentials:i:1',
    'administrative session:i:0',
    'screen mode id:i:2',
    'redirectclipboard:i:1',
    `gatewayhostname:s:`,
  ].join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'application/x-rdp');
  res.setHeader('Content-Disposition', `attachment; filename="${m.name.replace(/[^\w.-]/g, '_')}.rdp"`);
  res.send(rdp);
});
