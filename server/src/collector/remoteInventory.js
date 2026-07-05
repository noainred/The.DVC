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

/**
 * 물리 식별키(서비스태그>id>주소)로 원격 서버 목록을 dedup한다. 같은 엣지를 둘 이상의
 * 수집서버(예: 대소문자만 다른 'nj'·'NJ')가 pull하면 동일 서버가 중복 유입돼 목록·집계가
 * 2배로 부풀던 것을 방지한다. 중복 시 datacenterId가 채워진 쪽을 우선 보존(귀속 손실 방지).
 * 서로 다른 엣지는 태그/id가 달라 합쳐지지 않는다.
 */
export function dedupRemoteServers(list = []) {
  const norm = (v) => String(v || '').trim().toLowerCase();
  const byKey = new Map();
  const out = [];
  for (const s of list) {
    const key = norm(s.serviceTag) || norm(s.id) || norm(String(s.host || '').replace(/^https?:\/\//, ''));
    if (!key) { out.push(s); continue; } // 키 없으면 합치지 않고 그대로
    const idx = byKey.get(key);
    if (idx === undefined) { byKey.set(key, out.length); out.push(s); continue; }
    if (!out[idx].datacenterId && s.datacenterId) out[idx] = s; // 중복: datacenterId 있는 쪽 우선
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
