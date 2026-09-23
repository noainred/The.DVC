/**
 * In-memory state for distributed collection on the CENTRAL portal: the merged
 * host→power map pulled from remote collector agents, plus per-collector status.
 * Kept dependency-free to avoid import cycles (service.js merges this in).
 */

const remoteByHost = new Map();   // hostLower -> { watts, ts, datacenter, collectorId, serverName, source }
const status = new Map();          // collectorId -> { at, ok, hosts, version, datacenter, error }

export function setRemoteHost(hostLower, sample) {
  remoteByHost.set(hostLower, sample);
}

export function remotePowerByHost() {
  return remoteByHost;
}

/** Drop remote hosts contributed by a collector before re-applying its export. */
export function clearCollectorHosts(collectorId) {
  for (const [k, v] of remoteByHost) if (v.collectorId === collectorId) remoteByHost.delete(k);
}

/** 등록되지 않은(제거된) 수집서버가 남긴 원격 호스트를 제거 — 전력 보고 수의 유령 항목 정리.
 *  activeCollectorIds(Set)에 없는 collectorId의 호스트를 비운다. 제거 수 반환. */
export function clearStaleRemote(activeCollectorIds) {
  let removed = 0;
  for (const [k, v] of remoteByHost) {
    if (!activeCollectorIds.has(v.collectorId)) { remoteByHost.delete(k); status.delete(v.collectorId); removed++; }
  }
  // v2.583 감사 #31: 원격 전력 호스트가 0개인 수집기(스토리지·SAN 전용 엣지 등)의 상태는 위 루프가 **절대** 만나지
  //   않아, 삭제된 수집기의 상태가 프로세스 수명 내내 남았다(토큰 점검·수신 진단에 유령 행). 상태 맵도 직접 훑는다.
  for (const id of [...status.keys()]) if (!activeCollectorIds.has(id)) status.delete(id);
  return removed;
}

/** 수집기 삭제 시 상태도 지운다(v2.583 #31). */
export function clearCollectorStatus(collectorId) { status.delete(collectorId); }

export function setCollectorStatus(collectorId, s) {
  status.set(collectorId, { at: Date.now(), ...s });
}

export function getCollectorStatus(collectorId) {
  return status.get(collectorId) || null;
}

export function allCollectorStatus() {
  return Object.fromEntries(status);
}
