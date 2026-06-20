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
  listMappings, listMappingsForUser, getMapping, addMapping, removeMapping, setMappingStatus, touchMapping,
  listProxies, listProxiesSafe, getProxyById, resolveProxy, saveProxy, removeProxy,
} from '../proxy/registry.js';
import { testDataplane, applyMapping } from '../proxy/dataplane.js';
import { previewConfig, testDeploy, deployToProxy } from '../proxy/deploy.js';
import { provision, deprovision } from '../proxy/provision.js';
import { withSsh } from '../proxy/sshExec.js';

export const remoteRouter = Router();
const adminOnly = requireRole('admin');

// Connection info for a mapping resolves through the mapping's assigned proxy.
const mappingProxy = (m) => getProxyById(m.proxyId);

// Public-ish (any authenticated user): list mappings + how to connect.
remoteRouter.get('/mappings', (req, res) => {
  res.json({
    mappings: listMappingsForUser(req.user).map(({ error, ...m }) => {
      const p = mappingProxy(m);
      return { ...m, proxyName: p.name, proxyHost: p.proxyHost, guacdConfigured: !!p.guacd?.host };
    }),
  });
});

// Reachability probe: from the assigned proxy, ping the target and check the
// TCP port. Used to colour the VM "원격 접속" button (blue=open, red=closed).
const SAFE_HOST = /^[A-Za-z0-9._:-]+$/;
remoteRouter.post('/probe', async (req, res) => {
  const { vcenterId, targetHost } = req.body || {};
  const targetPort = Math.min(65535, Math.max(1, Number((req.body || {}).targetPort) || 22));
  if (!targetHost || !SAFE_HOST.test(targetHost)) return res.status(400).json({ ok: false, reason: '대상 호스트가 올바르지 않습니다.' });
  const proxy = resolveProxy(vcenterId);
  if (!proxy.deploy?.host || !proxy.deploy?.username) {
    return res.json({ ok: false, method: 'none', proxyName: proxy.name, reason: `프록시 '${proxy.name}'에 SSH(자동배포) 설정이 없어 사전 점검을 할 수 없습니다.` });
  }
  const creds = { host: proxy.deploy.host, port: proxy.deploy.port, username: proxy.deploy.username, password: proxy.deploy.password, privateKey: proxy.deploy.privateKey || undefined };
  try {
    const out = await withSsh(creds, async ({ exec }) => {
      const ping = await exec(`ping -c1 -W1 ${targetHost} 2>/dev/null | sed -n 's/.*time=\\([0-9.]*\\).*/\\1/p' | head -1`);
      const pingMs = parseFloat(ping.stdout.trim());
      const port = await exec(`timeout 2 bash -c '</dev/tcp/${targetHost}/${targetPort}' 2>/dev/null && echo OPEN || echo CLOSED`);
      return { pingOk: Number.isFinite(pingMs), pingMs: Number.isFinite(pingMs) ? pingMs : null, portOpen: port.stdout.includes('OPEN') };
    });
    res.json({ ok: true, method: 'ssh', proxyName: proxy.name, targetHost, targetPort, ...out });
  } catch (err) {
    res.json({ ok: false, method: 'ssh', proxyName: proxy.name, reason: err.message });
  }
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


// Create a mapping, then provision it on HAProxy. (admin-created = persistent)
remoteRouter.post('/mappings', adminOnly, async (req, res) => {
  const r = addMapping({ ...(req.body || {}), owner: req.user.username, ephemeral: false });
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

  // Reuse this user's existing mapping for the same target, else create an
  // ephemeral one owned by them (auto-removed 1 day after last use).
  let m = listMappings().find((x) => x.targetHost === targetHost && Number(x.targetPort) === targetPort && x.protocol === proto && (!x.owner || x.owner === req.user.username));
  if (!m) {
    const r = addMapping({ name: name || `${proto.toUpperCase()} ${targetHost}`, vcenterId, protocol: proto, targetHost, targetPort, owner: req.user.username, ephemeral: true });
    if (!r.ok) return res.status(400).json(r);
    await provision(r.mapping);
    m = getMapping(r.mapping.id);
  } else {
    touchMapping(m.id); m = getMapping(m.id);
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

remoteRouter.delete('/mappings/:id', async (req, res) => {
  const m = getMapping(req.params.id);
  if (!m) return res.status(404).json({ ok: false, reason: '매핑을 찾을 수 없습니다.' });
  // Owners can delete their own mapping; admins can delete any.
  if (req.user.role !== 'admin' && m.owner && m.owner !== req.user.username) {
    return res.status(403).json({ ok: false, reason: '본인 접속 기록만 삭제할 수 있습니다.' });
  }
  await deprovision(m);
  res.json(removeMapping(req.params.id));
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
