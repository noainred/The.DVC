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
import { parseCfgShow, resolveZones, compactZoning, normWwn, ZONE_LIMITS } from './zoning.js';

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
  const effZones = arr(effCfg['enabled-zone']).map((z) => ({
    name: z['zone-name'] || '',
    members: arr(z['member-entry']?.['entry-name'] ?? z['member-entry']?.['principal-entry-name'] ?? []),
  })).filter((z) => z.name);
  const defRoot = arr(def?.['defined-configuration'])[0] || {};
  const defZones = arr(defRoot.zone).map((z) => ({
    name: z['zone-name'] || '',
    members: arr(z['member-entry']?.['entry-name'] ?? []),
  })).filter((z) => z.name);
  const aliases = {};
  for (const a of arr(defRoot.alias)) {
    const n = a['alias-name']; if (!n) continue;
    aliases[n] = arr(a['member-entry']?.['alias-entry-name']).map(normWwn).filter(Boolean);
  }
  // 활성이 있으면 활성을, 없으면 정의를 쓴다(SSH 경로와 같은 우선순위).
  const src = effZones.length ? effZones : defZones;
  const source = effZones.length ? 'effective' : (defZones.length ? 'defined' : 'none');
  const expand = (members) => {
    const wwns = []; const unresolved = []; const aliasOf = {};
    for (const raw of members) {
      const w = normWwn(raw);
      if (w) { wwns.push(w); continue; }
      const av = aliases[raw];
      if (av?.length) { for (const x of av) { wwns.push(x); aliasOf[x] = raw; } continue; }
      unresolved.push(String(raw));
    }
    return { members: [...new Set(wwns)].concat(unresolved), aliasOf };
  };
  const zones = src.map((z) => ({ name: z.name, ...expand(z.members) })).slice(0, ZONE_LIMITS.zones);
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
