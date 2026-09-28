/**
 * ipam/scanSuggestSource.js — /24 대역 제안의 iDRAC 입력(v2.638). 라우트만 쓴다 — 대장(ledger.js)이 iDRAC 등록부를
 * 끌어오지 않게 scanDatacenterSource.js 와 나눴다(대장은 30초마다 도는 경로다).
 */
import { loadRegistry } from '../idrac/registry.js';
import { allRemoteServers } from '../collector/remoteInventory.js';
import { LOCAL } from './scanStore.js';

/**
 * 그 에이전트가 담당하는 iDRAC 서버. 이 포탈(__local__)은 중앙 등록부(OME 관리 콘솔 제외), 엣지는 그 엣지가 export 로 올린
 * 원격 서버 목록(수집 서버 pull — collectorId 가 그 에이전트의 id·name 별칭인 것). 엣지 목록은 중앙이 가진 **마지막 pull 사본**이다.
 * @returns {{ source: 'central-registry'|'edge-export', servers: Array<{id,host,name}>, error?: string }}
 */
export function agentIdracServers(agent, collectors = []) {
  const a = String(agent || '').trim().toLowerCase();
  if (!a || a === LOCAL.toLowerCase()) {
    try { return { source: 'central-registry', servers: loadRegistry().filter((s) => s && s.type !== 'ome').map((s) => ({ id: s.id, host: s.host, name: s.name })) }; }
    catch { return { source: 'central-registry', servers: [], error: 'registry' }; }
  }
  const ids = new Set([a]);
  for (const c of Array.isArray(collectors) ? collectors : []) {
    const id = String(c?.id || '').trim().toLowerCase(); const nm = String(c?.name || '').trim().toLowerCase();
    if (id === a || nm === a) { if (id) ids.add(id); if (nm) ids.add(nm); }
  }
  try {
    return { source: 'edge-export', servers: allRemoteServers().filter((s) => ids.has(String(s.collectorId || '').trim().toLowerCase())).map((s) => ({ id: s.id, host: s.host, name: s.name })) };
  } catch { return { source: 'edge-export', servers: [], error: 'remote' }; }
}
