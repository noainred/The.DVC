/**
 * Apply / remove a remote-access mapping on its assigned proxy (HAProxy), via
 * the Data Plane API or SSH auto-deploy. Shared by the remote routes and the
 * ephemeral-mapping expiry job.
 */

import { getProxyById, listMappings, setMappingStatus } from './registry.js';
import { applyMapping, removeMapping as haproxyRemove } from './dataplane.js';
import { deployToProxy } from './deploy.js';

const proxyOf = (m) => getProxyById(m.proxyId);

// HAProxy 변경(Data Plane 트랜잭션/SSH 배포)을 전역 직렬화한다. 동시 원격접속이 많을 때
// 병렬 트랜잭션은 Data Plane 버전 충돌을 일으키고, 동시 graceful reload가 누적되면 HAProxy
// 프로세스가 죽거나 메모리 폭증으로 서버가 리붓된다. 한 번에 하나씩 처리해 reload를 직렬화.
let _chain = Promise.resolve();
function serialize(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.then(() => {}, () => {}); // 에러가 나도 체인이 끊기지 않게
  return run;
}

/** Provision a mapping on its proxy. (HAProxy 변경은 직렬화) */
export function provision(mapping) {
  return serialize(() => doProvision(mapping));
}

async function doProvision(mapping) {
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

/** Remove a mapping from its proxy (call BEFORE deleting it from the registry). (직렬화) */
export function deprovision(mapping) {
  return serialize(() => doDeprovision(mapping));
}

async function doDeprovision(mapping) {
  const proxy = proxyOf(mapping);
  if (proxy.dataplane?.enabled) {
    try { await haproxyRemove(proxy.dataplane, mapping); } catch { /* best effort */ }
  } else if (proxy.deploy?.enabled) {
    const ms = listMappings().filter((m) => (m.proxyId || 'default') === proxy.id && m.id !== mapping.id);
    await deployToProxy(proxy.deploy, ms, { bindAddress: proxy.dataplane?.bindAddress || '*' }).catch(() => {});
  }
}
