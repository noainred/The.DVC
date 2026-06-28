/**
 * Collector-agent export. When this instance runs at a datacenter as a
 * collector, it exposes its locally-collected power so the central portal can
 * pull and merge it. Only LOCAL data (this instance's iDRAC/OME) is exported —
 * never re-exported remote data — so there are no pull loops.
 */

import { config, currentVersion } from '../config.js';
import { localPowerByHostName } from '../idrac/service.js';
import { getPollerStatus } from '../idrac/poller.js';
import { allOmeDevices } from '../idrac/omeCache.js';

export async function buildExport() {
  const byNameMap = await localPowerByHostName();
  // 서버 1대당 한 행으로 중복 제거. localPowerByHostName은 한 서버를 여러 별칭(이름·서비스태그·
  // hostNames) 키로 넣으므로, 중복 제거 없이 export하면 중앙이 같은 서버를 별칭 수만큼 중복 집계한다
  // ('전력 보고' 수 과다·동일 호스트 중복의 원인). serverId 기준으로 첫 행만 내보낸다.
  const seen = new Set();
  const byHost = [];
  for (const [host, r] of byNameMap) {
    if (r.serverId != null && seen.has(r.serverId)) continue;
    if (r.serverId != null) seen.add(r.serverId);
    byHost.push({ host, watts: r.watts, ts: r.ts, serverName: r.serverName, serverId: r.serverId });
  }
  return {
    version: currentVersion(),
    datacenter: config.collector.datacenter || '',
    generatedAt: Date.now(),
    poller: getPollerStatus(),
    omeDevices: allOmeDevices().length,
    hosts: byHost.length,
    power: { byHost },
  };
}
