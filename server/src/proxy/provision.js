/**
 * Apply / remove a remote-access mapping on its assigned proxy (HAProxy), via
 * the Data Plane API or SSH auto-deploy. Shared by the remote routes and the
 * ephemeral-mapping expiry job.
 */

import { getProxyById, listMappings, setMappingStatus } from './registry.js';
import { applyMapping, removeMapping as haproxyRemove } from './dataplane.js';
import { deployToProxy } from './deploy.js';

const proxyOf = (m) => getProxyById(m.proxyId);

/** Provision a mapping on its proxy. */
export async function provision(mapping) {
  const proxy = proxyOf(mapping);
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

/** Remove a mapping from its proxy (call BEFORE deleting it from the registry). */
export async function deprovision(mapping) {
  const proxy = proxyOf(mapping);
  if (proxy.dataplane?.enabled) {
    try { await haproxyRemove(proxy.dataplane, mapping); } catch { /* best effort */ }
  } else if (proxy.deploy?.enabled) {
    const ms = listMappings().filter((m) => (m.proxyId || 'default') === proxy.id && m.id !== mapping.id);
    await deployToProxy(proxy.deploy, ms, { bindAddress: proxy.dataplane?.bindAddress || '*' }).catch(() => {});
  }
}
