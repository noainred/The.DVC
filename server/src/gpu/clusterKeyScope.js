/**
 * v2.769(점검 R4-D5-4): 클러스터 추이 키(`${vcenterId}|${cluster}` — metrics/sampler.js gpu_cluster·temp_cluster 등)의
 * 소유 vCenter 판정 — 순수 함수(I/O 없음).
 *
 * 예전 판정은 `key.split('|')[0]` 이었다. vCenter id 는 제어문자만 막으므로(vcenter/registry.js) '|' 가 든 id 가 있으면
 * 범위 계정이 'kr' 만 볼 수 있을 때 다른 vCenter 'kr|pl' 의 클러스터 키 'kr|pl|cl1' 이 'kr' 로 읽혀 통과했다
 * (반대로 id 에 '|' 가 있는 범위 계정은 자기 클러스터가 빈 응답). server/CLAUDE.md '중앙 GPU 오버레이 봉인' 의 최장 프리픽스와
 * 같은 규칙으로 푼다: 알려진 vCenter id(스냅샷) ∪ 허용 id 중 `key.startsWith(id + '|')` 인 **가장 긴** id 가 소유자다.
 * ⚠ 허용 id 만으로 찾으면 안 된다 — 'kr|pl' 을 모르는 채로 'kr' 이 걸려 같은 우회가 남는다.
 */

/**
 * @param {string} key 클러스터 키
 * @param {Iterable<string>} ids 후보 vCenter id
 * @returns {string|null} 소유 vCenter id(없으면 null)
 */
export function clusterKeyVcenter(key, ids) {
  const k = String(key ?? '');
  let best = null;
  for (const id of ids || []) {
    if (typeof id !== 'string' || !id) continue;
    if (k.length > id.length && k.startsWith(id) && k.charCodeAt(id.length) === 124 /* '|' */ && (best == null || id.length > best.length)) best = id;
  }
  return best;
}

/**
 * 범위 계정이 이 클러스터 키를 볼 수 있는가.
 * @param {Set<string>|null} allowed scopedVcenterIds 결과(null = 전체 범위)
 * @param {string} key 클러스터 키
 * @param {object} snap store 스냅샷(vcenters·hosts 의 vCenter id 를 후보로 쓴다)
 */
export function ownsClusterKey(allowed, key, snap) {
  if (!allowed) return true;
  const ids = new Set(allowed);
  for (const v of (snap && snap.vcenters) || []) if (v && typeof v.id === 'string') ids.add(v.id);
  for (const h of (snap && snap.hosts) || []) if (h && typeof h.vcenterId === 'string') ids.add(h.vcenterId);
  const owner = clusterKeyVcenter(key, ids);
  return owner != null && allowed.has(owner);
}
