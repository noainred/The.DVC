/**
 * 전력 측정 서버 → vCenter 귀속 로직(공유).
 *
 * 우선순위:
 *   1) 서버에 명시 지정된 vcenterId (등록/일괄/스캔 시 사용자가 지정) — 최우선
 *   2) ESXi 호스트명 일치 (서버의 hostNames/host == 호스트 name)
 *   3) Dell 서비스태그 일치 (서버 serviceTag == 호스트 serviceTag)
 *   4) 모두 실패 → null(=미매핑)
 *
 * store 스냅샷 롤업, FinOps, 전력 분석이 모두 같은 규칙을 쓰도록 한 곳에 둔다.
 */

const norm = (s) => String(s || '').trim().toLowerCase();

/** snap.hosts → { byName, byTag }(정규화 키 → { vcenterId, model }). */
export function buildHostIndex(hosts = []) {
  const byName = new Map();
  const byTag = new Map();
  for (const h of hosts) {
    const info = { vcenterId: h.vcenterId, model: h.model || '' };
    const n = norm(h.name);
    if (n) byName.set(n, info);
    const t = norm(h.serviceTag);
    if (t) byTag.set(t, info);
  }
  return { byName, byTag };
}

/**
 * 측정 서버 m을 vCenter에 귀속. 반환 { vcenterId, model, via } 또는 null.
 * @param m            { vcenterId?, hostNames?, host?, serviceTag?, model? }
 * @param idx          buildHostIndex 결과
 * @param validVcIds   유효한 vCenter id Set(명시 지정이 실제 존재하는 vCenter인지 검증). 없으면 검증 생략.
 */
export function resolveServerVcenter(m, idx, validVcIds = null) {
  // 1) 명시 지정(존재하는 vCenter일 때만)
  const explicit = String(m.vcenterId || '').trim();
  if (explicit && (!validVcIds || validVcIds.has(explicit))) {
    return { vcenterId: explicit, model: m.model || '', via: 'explicit' };
  }
  // 2) 호스트명 일치
  for (const k of (m.hostNames && m.hostNames.length ? m.hostNames : [m.host])) {
    const hit = idx.byName.get(norm(k));
    if (hit) return { ...hit, via: 'name' };
  }
  // 3) 서비스태그 일치
  const tag = norm(m.serviceTag);
  if (tag && idx.byTag.has(tag)) return { ...idx.byTag.get(tag), via: 'tag' };
  return null;
}

/**
 * 측정 전력 목록에서 '이 스냅샷의 vCenter 에 귀속되는' 항목만 남긴다.
 *
 * ⚠ 보안 경계(확정 버그, 2026-08-30): allMeasuredPower() 는 `hosts` 인자와 무관하게
 * loadRegistry()/OME/원격의 **전 등록 서버**를 반환한다. 범위 제한(scope) 계정에 스냅샷만
 * 좁혀서(scopeSlice) 넘기면, 범위 밖 vCenter 에 귀속된 서버는 귀속 판정에 실패해 '(미매핑)' 으로
 * 강등된 뒤 **집계·목록에 그대로 포함**됐다 → FinOps/전력분석에서 전 함대 서버 이름·서비스태그·
 * 모델·소비전력과 전사 총량이 노출. server/CLAUDE.md '귀속 없는 데이터는 범위 계정 미노출' 위반.
 *
 * 그래서 범위 제한 계정에는 이 필터를 **설정과 무관하게 강제**한다(전체 범위 계정은 기존대로
 * '(미매핑)' 포함 — 미매핑 전력을 봐야 하는 쪽은 전체 범위 운영자다).
 */
export function keepMappedMeasured(measured, snap) {
  if (!Array.isArray(measured)) return measured;
  const idx = buildHostIndex(snap?.hosts || []);
  const validVcIds = new Set((snap?.vcenters || []).map((v) => v.id));
  return measured.filter((m) => resolveServerVcenter(m, idx, validVcIds) != null);
}
