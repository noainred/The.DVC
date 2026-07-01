/**
 * Remote (edge-collected) iDRAC server inventory, pulled from collector agents'
 * /api/collector/export (the `servers` field). Keyed by collectorId so each
 * successful pull REPLACES that collector's set (a failed pull keeps the last
 * good snapshot — never wiped on error).
 *
 * Why: delegated (agent) datacenter scans register iDRACs into the EDGE agent's
 * local registry — the central never sees them. Only power flowed back before
 * (collector power pull). This store carries the edge's server list + compact
 * hardware inventory so the central "서버 분석" views (법인별 서버 정보 / 하드웨어
 * 집계 / GPU / BIOS·iDRAC 버전) can merge delegated-datacenter servers too.
 *
 * In-memory only (rebuilt on next pull, ≤ pull interval). O(N) per collector.
 */

const byCollector = new Map(); // collectorId -> { at, datacenter, servers: [...] }

/** Replace the whole server set reported by one collector. Call only on a
 *  successful pull (skip on failure to preserve the last good snapshot). */
export function setCollectorServers(collectorId, datacenter, servers) {
  const id = String(collectorId || '').trim();
  if (!id) return;
  const list = Array.isArray(servers) ? servers : [];
  byCollector.set(id, { at: Date.now(), datacenter: String(datacenter || ''), servers: list });
}

/** Drop a collector's remote servers (e.g. collector removed/disabled). */
export function clearCollectorServers(collectorId) {
  byCollector.delete(String(collectorId || '').trim());
}

/** All remote servers across collectors, tagged remote:true + collectorId.
 *  Each carries the compact inventory as `.inv` (null if the edge had none). */
export function allRemoteServers() {
  const out = [];
  for (const [collectorId, e] of byCollector) {
    for (const s of e.servers || []) {
      out.push({ ...s, remote: true, collectorId, collectorDatacenter: e.datacenter });
    }
  }
  return out;
}

/** Find one remote server by id (for the detail-inventory popup). */
export function findRemoteServer(id) {
  const want = String(id || '');
  for (const [collectorId, e] of byCollector) {
    for (const s of e.servers || []) {
      if (String(s.id) === want) return { ...s, remote: true, collectorId, collectorDatacenter: e.datacenter };
    }
  }
  return null;
}
