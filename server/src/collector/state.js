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

/**
 * v2.606 RECENT2606-02: 충돌은 **신선한 항목끼리만** 센다. 죽은 엣지(pull 실패는 항목을 지우지 않는다)·비활성 수집기가 마지막으로
 * 보고한 호스트가 남아 있으면, 같은 사이트의 새 엣지가 같은 서버를 보고하는 순간 '다른 법인의 다른 서버' 로 판정돼 이력 키가
 * rmt:<host> → rmt:<cid>:<host> 로 바뀌었다. 신선도 기준은 전력 합산과 같은 POWER_CURRENT_STALE_MS(기본 2시간).
 */
export const REMOTE_FRESH_MS = Number(process.env.POWER_CURRENT_STALE_MS) || 2 * 3_600_000;
const isFresh = (s, now, staleMs) => {
  const t = Number(s?.ts);
  return Number.isFinite(t) && t > 0 && now - t <= staleMs;
};

/** 같은 호스트명을 둘 이상의 수집 서버가 (신선하게) 보고하는 경우 — [{ host, collectors:[...] }]. */
export function remoteHostConflicts({ now = Date.now(), staleMs = REMOTE_FRESH_MS, activeIds = null } = {}) {
  const by = new Map();
  for (const s of remoteByKey.values()) {
    if (!isFresh(s, now, staleMs)) continue;
    if (activeIds && !activeIds.has(s.collectorId)) continue;
    const set = by.get(s.host) || new Set();
    set.add(s.collectorId);
    by.set(s.host, set);
  }
  return [...by.entries()].filter(([, set]) => set.size > 1).map(([host, set]) => ({ host, collectors: [...set] }));
}

/**
 * 다른 수집 서버가 **지금**(신선한 ts · activeIds 가 주어지면 그 안의 활성 수집기) 보고 중인 호스트명 집합 — pull 이 DB 키를 고를 때 쓴다.
 * v2.606 RECENT2606-02: 예전에는 ts·enabled 를 보지 않아 며칠 전 죽은 엣지의 항목도 충돌로 셌다.
 */
export function hostsOfOtherCollectors(collectorId, { now = Date.now(), staleMs = REMOTE_FRESH_MS, activeIds = null } = {}) {
  const out = new Set();
  for (const s of remoteByKey.values()) {
    if (s.collectorId === collectorId) continue;
    if (!isFresh(s, now, staleMs)) continue;
    if (activeIds && !activeIds.has(s.collectorId)) continue;
    out.add(s.host);
  }
  return out;
}

/**
 * v2.606 RECENT2606-02: 원격 전력 DB 계열 키 선택(순수 — `hasSeries(key)` 로 DB 에 계열이 있는지 묻는다).
 *  ① 이 수집기 전용 계열 `rmt:<cid>:<host>` 가 **이미 DB 에 있으면** 그것을 쓴다 — 충돌 결정은 한 번 나면 영속이다.
 *     예전에는 인메모리 순서로만 판정해, 중앙 재시작 직후 먼저 pull 을 끝낸 엣지가 매번 옛 키 rmt:<host> 에 1표본을 쓰고
 *     다음 주기에 새 키로 넘어갔다(어느 엣지가 먼저냐에 따라 옛 계열에 두 서버 값이 섞였다 — CEN2605-03 이 막으려던 현상).
 *  ② 없으면, 다른 활성 수집기가 같은 호스트명을 신선하게 보고 중일 때만 새 계열로 나눈다.
 *  ③ 그 밖은 예전 키 `rmt:<host>`(이력 유지).
 * 반환 { key, conflict }.
 */
export function remoteSeriesKey(collectorId, hostLower, otherHosts, hasSeries = () => false) {
  const split = `rmt:${collectorId}:${hostLower}`;
  let persisted = false;
  try { persisted = Boolean(hasSeries(split)); } catch { persisted = false; }
  if (persisted || otherHosts.has(hostLower)) return { key: split, conflict: true, persisted };
  return { key: `rmt:${hostLower}`, conflict: false, persisted: false };
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
