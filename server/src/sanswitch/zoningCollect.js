/**
 * sanswitch/zoningCollect.js — 수집기(SSH/REST)가 공유하는 조닝 스냅샷 조립(v2.511).
 *
 * 왜 따로 두나: SSH 와 REST 두 수집기가 **같은 스키마**를 만들어야 한다(types.js 규약 —
 * "수집 방식이 달라도 요약 규칙은 하나"). 각자 조립하면 같은 스위치가 방식에 따라 다른
 * zone 수를 보고한다.
 *
 * ⚠ 스키마 주의: v2.510 까지 `zoning.zones` 는 **숫자(항상 0)** 였다. 이제 `zones` 는 **zone 배열**이고
 *   개수는 `zoneCount` 다. 숫자 `zones` 를 읽던 곳은 없었다(확인: 화면은 `effectiveConfig` 만 썼다).
 *   한 이름이 숫자와 배열 두 뜻을 갖지 않게 이렇게 정리한다.
 */
import { parseCfgShow, resolveZones, compactZoning, normWwn, isPropertyMember, ZONE_LIMITS } from './zoning.js';

/** 조닝 없음/미수집을 나타내는 빈 구조 — 모든 경로가 같은 모양을 돌려주게. */
export function emptyZoning(effectiveConfig = '', reason = '') {
  return { effectiveConfig, zones: [], zoneCount: 0, aliases: {}, source: 'none', available: false, reason,
    counts: { zones: 0, definedZones: 0, aliases: 0, cfgs: 0 }, truncated: false, limited: false };
}

/** cfgshow 원문 → 스냅샷 zoning 필드. 본문이 없으면 이름만 담은 빈 구조(기존 동작 유지). */
export function zoningFromText(cfgshowText, headerCfgName = '') {
  const text = String(cfgshowText || '');
  if (!text.trim()) return emptyZoning(headerCfgName, 'cfgshow 미수집(명령 없음·권한 부족·수집 실패)');
  const parsed = parseCfgShow(text);
  const resolved = resolveZones(parsed, { activeCfg: headerCfgName });
  const c = compactZoning(parsed, resolved);
  return {
    ...c,
    // 활성 설정 이름은 switchshow 헤더가 더 확실하다(cfgshow 에 활성 섹션이 없을 수 있다).
    effectiveConfig: headerCfgName || c.effectiveConfig,
    zoneCount: c.counts.zones,
    available: c.zones.length > 0,
    reason: c.zones.length ? '' : '조닝 설정이 없거나 활성 설정이 비어 있습니다',
  };
}

/**
 * FOS REST(`brocade-zone`) 응답 → 같은 스키마.
 * @param eff  brocade-zone/effective-configuration 응답
 * @param def  brocade-zone/defined-configuration 응답(없으면 별칭 해석 불가 — 그대로 밝힌다)
 */
export function zoningFromRest(eff, def) {
  const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const effCfg = arr(eff?.['effective-configuration'])[0] || {};
  const cfgName = effCfg['cfg-name'] || '';
  // 활성 설정의 zone 목록. FOS 는 `enabled-zone` 아래에 zone-name + member-entry 를 준다.
  // v2.742(DEV-04): peer zone 의 member-entry 는 entry-name(peer)과 principal-entry-name(principal — 보통 타깃) **둘 다**를 준다.
  //   예전 `entry-name ?? principal-entry-name` 은 둘이 함께 오면 principal 을 버렸고, 정의 zone 쪽은 principal 을 아예 읽지 않았다.
  //   ⚠ 정직 기록: FOS REST peer zone 응답 모양은 실장비로 확인하지 못했다(Brocade 모듈 필드 이름 기준).
  const zoneRow = (z) => {
    const me = z['member-entry'] || {};
    const principals = arr(me['principal-entry-name']).map(String);
    const zt = Number(z['zone-type']);
    return { name: z['zone-name'] || '', members: [...arr(me['entry-name']).map(String), ...principals], principals,
      peerType: zt === 1 || zt === 2 };   // zone-type 1 = 사용자 peer zone · 2 = 타깃이 만든 peer zone(0 = 일반)
  };
  const effZones = arr(effCfg['enabled-zone']).map(zoneRow).filter((z) => z.name);
  const defRoot = arr(def?.['defined-configuration'])[0] || {};
  const defZones = arr(defRoot.zone).map(zoneRow).filter((z) => z.name);
  const aliases = {};
  for (const a of arr(defRoot.alias)) {
    const n = a['alias-name']; if (!n) continue;
    aliases[n] = arr(a['member-entry']?.['alias-entry-name']).map(normWwn).filter(Boolean);
  }
  // 활성이 있으면 활성을, 없으면 정의를 쓴다(SSH 경로와 같은 우선순위).
  const src = effZones.length ? effZones : defZones;
  const source = effZones.length ? 'effective' : (defZones.length ? 'defined' : 'none');
  const resolveOne = (raw, aliasOf) => {
    const w = normWwn(raw);
    if (w) return [w];
    const av = aliases[raw];
    if (av?.length) { for (const x of av) aliasOf[x] = raw; return av; }
    return null;
  };
  const expand = (z) => {
    const wwns = []; const unresolved = []; const aliasOf = {};
    let properties = 0;
    for (const raw of z.members) {
      if (isPropertyMember(raw)) { properties++; continue; }   // peer zone 속성 멤버 — 끝점이 아니다(개수만)
      const r = resolveOne(raw, aliasOf);
      if (r) { for (const x of r) wwns.push(x); continue; }
      unresolved.push(String(raw));
    }
    const principals = [...new Set(z.principals.flatMap((raw) => resolveOne(raw, {}) || []).filter((w) => !isPropertyMember(w)))];
    const peer = z.peerType || properties > 0 || principals.length > 0;
    return { members: [...new Set(wwns)].concat(unresolved), aliasOf,
      ...(peer ? { peer: true, properties } : {}), ...(principals.length ? { principals } : {}) };
  };
  const zones = src.map((z) => ({ name: z.name, ...expand(z) })).slice(0, ZONE_LIMITS.zones);
  return {
    effectiveConfig: cfgName,
    zones,
    zoneCount: src.length,
    aliases,
    source,
    available: zones.length > 0,
    reason: zones.length ? '' : ((def || eff) ? '조닝 설정이 없거나 활성 설정이 비어 있습니다' : 'brocade-zone 모듈 미수집'),
    counts: { zones: src.length, definedZones: defZones.length, aliases: Object.keys(aliases).length, cfgs: arr(defRoot.cfg).length },
    truncated: false,
    limited: src.length > ZONE_LIMITS.zones,
  };
}
