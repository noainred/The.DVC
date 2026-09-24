/**
 * In-memory state for distributed collection on the CENTRAL portal: the merged
 * host→power map pulled from remote collector agents, plus per-collector status.
 * Kept dependency-free to avoid import cycles (service.js merges this in).
 */

/**
 * v2.605(CEN2605-03): 저장 키에 **수집 서버(법인) 축**을 넣는다 — `${collectorId}\0${hostLower}`.
 * 예전에는 hostLower 하나가 키라 두 법인 엣지가 같은 짧은 호스트명(esx01)·사설 IP 를 보고하면 **나중에 pull 된 쪽이**
 * (ts 가 더 오래돼도) 앞의 것을 지웠고, 한 법인의 서버 전력이 함대 합계에서 조용히 사라졌다(v2.548 F2 와 같은 '법인 축 없는 키').
 * · `remotePowerEntries()` — 전 항목(법인별로 따로). 합계·개수는 이것을 쓴다.
 * · `remotePowerByHost()` — 호스트명 → **ts 가 가장 최신인** 항목(호스트명 매칭 소비처용 — 주석이 말하던 'most recent wins').
 * · `remoteHostConflicts()` — 같은 호스트명을 둘 이상의 수집 서버가 보고하는 목록(상태·화면이 밝힌다).
 * 각 항목에는 `host`(소문자 호스트명)가 붙는다.
 */
const remoteByKey = new Map();   // `${collectorId}\0${hostLower}` -> { host, watts, ts, datacenter, collectorId, serverName, source, dbKey? }
const status = new Map();          // collectorId -> { at, ok, hosts, version, datacenter, error }
const rkey = (collectorId, hostLower) => `${String(collectorId ?? '')}\0${hostLower}`;

export function setRemoteHost(hostLower, sample) {
  remoteByKey.set(rkey(sample?.collectorId, hostLower), { ...sample, host: hostLower });
}

/** 전 항목(법인별 구분). */
export function remotePowerEntries() {
  return [...remoteByKey.values()];
}

/** 호스트명 → ts 가 가장 최신인 항목(보기). 같은 호스트명을 여러 수집 서버가 보고하면 최신 하나만 보인다. */
export function remotePowerByHost() {
  const out = new Map();
  for (const s of remoteByKey.values()) {
    const cur = out.get(s.host);
    if (!cur || (Number(s.ts) || 0) > (Number(cur.ts) || 0)) out.set(s.host, s);
  }
  return out;
}

/** 같은 호스트명을 둘 이상의 수집 서버가 보고하는 경우 — [{ host, collectors:[...] }]. */
export function remoteHostConflicts() {
  const by = new Map();
  for (const s of remoteByKey.values()) {
    const set = by.get(s.host) || new Set();
    set.add(s.collectorId);
    by.set(s.host, set);
  }
  return [...by.entries()].filter(([, set]) => set.size > 1).map(([host, set]) => ({ host, collectors: [...set] }));
}

/** 다른 수집 서버가 지금 보고 중인 호스트명 집합(pull 이 DB 키를 고를 때 쓴다). */
export function hostsOfOtherCollectors(collectorId) {
  const out = new Set();
  for (const s of remoteByKey.values()) if (s.collectorId !== collectorId) out.add(s.host);
  return out;
}

/** Drop remote hosts contributed by a collector before re-applying its export. */
export function clearCollectorHosts(collectorId) {
  for (const [k, v] of remoteByKey) if (v.collectorId === collectorId) remoteByKey.delete(k);
}

/** 등록되지 않은(제거된) 수집서버가 남긴 원격 호스트를 제거 — 전력 보고 수의 유령 항목 정리.
 *  activeCollectorIds(Set)에 없는 collectorId의 호스트를 비운다. 제거 수 반환. */
export function clearStaleRemote(activeCollectorIds) {
  let removed = 0;
  for (const [k, v] of remoteByKey) {
    if (!activeCollectorIds.has(v.collectorId)) { remoteByKey.delete(k); status.delete(v.collectorId); removed++; }
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
