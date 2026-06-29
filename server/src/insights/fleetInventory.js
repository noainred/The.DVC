/**
 * 통합 서버 인벤토리 — iDRAC/OME에서 수집한 물리 서버와 vCenter ESXi 호스트를 한 데 묶어
 * '가상화 호스트'와 '베어메탈 서버'로 분류한다.
 *
 * 조합 키:
 *   - Dell 서비스태그(서버 ↔ ESXi 호스트의 summary.hardware.otherIdentifyingInfo) 우선
 *   - 호스트명 일치 / 명시 지정 vCenter (attribution.js의 resolveServerVcenter 재사용)
 *
 * 분류 규칙(자동 + 수동 예외):
 *   - iDRAC/OME 물리 서버가 어떤 vCenter ESXi 호스트에 매칭되면  → 가상화 호스트(그 호스트를 iDRAC가 받침)
 *   - 어느 호스트에도 매칭되지 않으면                             → 베어메탈
 *   - fleet-tags의 수동 태그(baremetal/virtualization/exclude)가 자동 판정을 덮어쓴다.
 *
 * 베어메탈 전력량은 이미 수집 중인 iDRAC/OME(또는 원격 수집기) watts를 베어메탈만 골라 합산한다.
 * 추가 계측 장치 없이 현재 측정값으로 총전력/kW를 낸다.
 *
 * classifyFleet(...)는 DB 없이 동작하는 순수 함수(단위테스트 대상)이고, getFleetInventory(snap)은
 * 전력 DB·레지스트리·OME 캐시에서 입력을 모아 호출하는 얇은 래퍼다.
 */

import { config } from '../config.js';
import { buildHostIndex } from '../idrac/attribution.js';
import { allMeasuredPower } from '../idrac/service.js';
import { loadRegistry, matchKeys } from '../idrac/registry.js';
import { allOmeDevices, dbKey } from '../idrac/omeCache.js';
import { getInventory } from '../idrac/invCache.js';
import { loadFleetTags } from './fleetTags.js';
import { loadFleetAssign } from './fleetAssign.js';

const norm = (s) => String(s || '').trim().toLowerCase();
const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);

/**
 * 순수 분류 함수.
 * @param hosts     snap.hosts (vCenter ESXi 호스트)
 * @param vcenters  snap.vcenters
 * @param servers   물리 서버 목록 [{ serverId, serverName, serviceTag, host, hostNames, model, watts, source, vcenterId }]
 *                  (allMeasuredPower 결과 + 전력 미보고 등록서버). 물리 1대당 1행(상위에서 dedup).
 * @param tags      { 키(소문자 서비스태그 또는 serverId) -> 'baremetal'|'virtualization'|'exclude' }
 * @param assign    { 키(소문자 서비스태그 또는 serverId) -> 소속 법인(vCenter) id } — 베어메탈 수동 귀속
 */
export function classifyFleet({ hosts = [], vcenters = [], servers = [], tags = {}, assign = {} } = {}) {
  const vcName = new Map(vcenters.map((v) => [v.id, v.name || v.id]));
  const vcRegion = new Map(vcenters.map((v) => [v.id, v.location?.region || v.region || '']));
  const idx = buildHostIndex(hosts);
  const tagOf = (serviceTag, serverId) =>
    tags[norm(serviceTag)] || (serverId != null ? tags[String(serverId)] : '') || '';
  // 소속 법인: 수동 등록(assign) 우선, 없으면 서버가 들고 온 vcenterId(레지스트리/원격).
  const vcenterOf = (serviceTag, serverId, fallback) =>
    assign[norm(serviceTag)] || (serverId != null ? assign[String(serverId)] : '') || fallback || '';
  // '실제 ESXi 호스트인가' 판정 — 호스트 인덱스(이름/서비스태그) 직접 매칭만 사용한다.
  // 명시 vcenterId(법인 소유권 지정)는 호스트 여부와 무관하므로 여기서 보지 않는다(베어메탈에 법인만 등록 가능).
  const matchesHost = (s) => {
    if (s.serviceTag && idx.byTag.has(norm(s.serviceTag))) return true;
    for (const n of (s.hostNames && s.hostNames.length ? s.hostNames : [s.host])) {
      if (n && idx.byName.has(norm(n))) return true;
    }
    return false;
  };

  // 호스트 전력/매칭용 서버 인덱스(제외 태그는 빼고).
  const serverByTag = new Map();
  const serverByName = new Map();
  for (const s of servers) {
    if (tagOf(s.serviceTag, s.serverId) === 'exclude') continue;
    const t = norm(s.serviceTag);
    if (t && !serverByTag.has(t)) serverByTag.set(t, s);
    for (const n of (s.hostNames && s.hostNames.length ? s.hostNames : [s.host])) {
      const k = norm(n);
      if (k && !serverByName.has(k)) serverByName.set(k, s);
    }
  }

  // --- 1) 물리 서버 분류 → 베어메탈 추출 ---
  const bareMetal = [];
  const usedBmKeys = new Set();
  for (const s of servers) {
    const t = tagOf(s.serviceTag, s.serverId);
    if (t === 'exclude') continue;
    if (t === 'virtualization') continue;       // 가상화로 강제 → 베어메탈 아님
    if (t !== 'baremetal') {
      if (s.source === 'vcenter') continue;     // vCenter 원본 행은 호스트 자체
      if (matchesHost(s)) continue;             // 실제 ESXi 호스트에 매칭 → 가상화
    }
    const dk = norm(s.serviceTag) || String(s.serverId);
    if (usedBmKeys.has(dk)) continue;
    usedBmKeys.add(dk);
    const vcId = vcenterOf(s.serviceTag, s.serverId, s.vcenterId);
    bareMetal.push({
      serverId: s.serverId, name: s.serverName || s.host || s.serviceTag || s.serverId,
      model: s.model || '', serviceTag: s.serviceTag || '', source: s.source,
      watts: round(s.watts), forced: t === 'baremetal', tagKey: dk,
      vcenterId: vcId, vcenter: vcId ? (vcName.get(vcId) || vcId) : '', region: vcId ? (vcRegion.get(vcId) || '') : '',
    });
  }

  // --- 2) 가상화 호스트 목록(=vCenter ESXi 호스트, 권위 소스) ---
  const virtualizationHosts = [];
  for (const h of hosts) {
    const t = tagOf(h.serviceTag, null);
    if (t === 'exclude') continue;
    if (t === 'baremetal') {                    // 호스트를 베어메탈로 강제
      const dk = norm(h.serviceTag) || norm(h.name);
      if (!usedBmKeys.has(dk)) {
        usedBmKeys.add(dk);
        const w = Number.isFinite(h.powerWatts) && h.powerWatts > 0 ? h.powerWatts
          : (Number.isFinite(h.vcPowerWatts) ? h.vcPowerWatts : null);
        const vcId = vcenterOf(h.serviceTag, null, h.vcenterId);
        bareMetal.push({
          serverId: `host:${h.vcenterId}:${h.name}`, name: h.name, model: h.model || '',
          serviceTag: h.serviceTag || '', source: 'vcenter', watts: round(w), forced: true, tagKey: dk,
          vcenterId: vcId, vcenter: vcId ? (vcName.get(vcId) || vcId) : '', region: vcId ? (vcRegion.get(vcId) || '') : '',
        });
      }
      continue;
    }
    const m = (h.serviceTag && serverByTag.get(norm(h.serviceTag))) || serverByName.get(norm(h.name));
    const backed = !!(m && m.source !== 'vcenter' && tagOf(m.serviceTag, m.serverId) !== 'baremetal');
    const watts = backed && Number.isFinite(m.watts) ? m.watts
      : (Number.isFinite(h.powerWatts) && h.powerWatts > 0 ? h.powerWatts
        : (Number.isFinite(h.vcPowerWatts) ? h.vcPowerWatts
          : (m && Number.isFinite(m.watts) ? m.watts : null)));
    virtualizationHosts.push({
      name: h.name, vcenterId: h.vcenterId, vcenter: vcName.get(h.vcenterId) || h.vcenterId,
      region: vcRegion.get(h.vcenterId) || '', model: h.model || '', serviceTag: h.serviceTag || '',
      cpuCores: h.cpuCores || 0, memGB: round((h.memTotalMB || 0) / 1024) || 0,
      connectionState: h.connectionState || '', watts: round(watts),
      powerSource: backed ? m.source : (Number.isFinite(watts) ? 'vcenter' : null), idracBacked: backed,
    });
  }

  bareMetal.sort((a, b) => (b.watts || 0) - (a.watts || 0) || String(a.name).localeCompare(String(b.name)));
  virtualizationHosts.sort((a, b) =>
    String(a.vcenter).localeCompare(String(b.vcenter)) || String(a.name).localeCompare(String(b.name)));

  const measured = bareMetal.filter((b) => Number.isFinite(b.watts) && b.watts > 0);
  const bareMetalWatts = measured.reduce((acc, b) => acc + b.watts, 0);

  // 베어메탈을 소속 법인(vCenter)별로 묶는다('' = 미지정). 중앙 DC별 검색/집계용.
  const byVcMap = new Map();
  for (const b of bareMetal) {
    const id = b.vcenterId || '';
    const e = byVcMap.get(id) || { vcenterId: id, name: id ? (vcName.get(id) || id) : '(미지정)', region: id ? (vcRegion.get(id) || '') : '', servers: 0, watts: 0 };
    e.servers += 1;
    if (Number.isFinite(b.watts)) e.watts += b.watts;
    byVcMap.set(id, e);
  }
  const byVcenter = [...byVcMap.values()].map((e) => ({ ...e, watts: round(e.watts) || 0 }))
    .sort((a, z) => z.watts - a.watts || z.servers - a.servers);

  const summary = {
    virtualizationHosts: virtualizationHosts.length,
    idracBackedHosts: virtualizationHosts.filter((h) => h.idracBacked).length,
    bareMetal: bareMetal.length,
    bareMetalMeasured: measured.length,
    bareMetalWatts: round(bareMetalWatts) || 0,
    bareMetalKw: Math.round(bareMetalWatts / 100) / 10,
    bareMetalAssigned: bareMetal.filter((b) => b.vcenterId).length,
    forcedBareMetal: bareMetal.filter((b) => b.forced).length,
    excluded: Object.values(tags).filter((t) => t === 'exclude').length,
  };
  const vcList = vcenters.map((v) => ({ id: v.id, name: v.name || v.id, region: v.location?.region || v.region || '' }));
  return { virtualizationHosts, bareMetal, byVcenter, vcenters: vcList, summary };
}

/**
 * 전력 미보고 등록 서버까지 포함해 물리 서버 universe를 구성.
 * allMeasuredPower(전력 보고분) + 레지스트리/OME에 등록됐지만 현재 전력 샘플이 없는 서버(watts=null).
 */
async function buildServerUniverse(hosts) {
  const measured = await allMeasuredPower({ hosts });
  const seenTag = new Set(measured.map((s) => norm(s.serviceTag)).filter(Boolean));
  const seenHost = new Set(measured.flatMap((s) => (s.hostNames || []).map(norm)).filter(Boolean));

  const extras = [];
  for (const s of loadRegistry()) {
    if (s.type === 'ome') continue;
    const keys = matchKeys(s);
    const inv = getInventory(s.id);
    const serviceTag = (inv?.system?.serviceTag || s.serviceTag || '').trim();
    const tag = norm(serviceTag);
    if ((tag && seenTag.has(tag)) || keys.some((k) => seenHost.has(k))) continue;
    extras.push({
      serverId: s.id, serverName: s.name, serviceTag, model: (inv?.system?.model || '').trim(),
      host: norm(s.host), hostNames: keys, vcenterId: s.vcenterId || '', watts: null, source: 'idrac',
    });
  }
  for (const { entryId, device } of allOmeDevices()) {
    const tag = norm(device.serviceTag);
    if (tag && seenTag.has(tag)) continue;
    if (!tag && seenHost.has(norm(device.name))) continue;
    extras.push({
      serverId: dbKey(entryId, device), serverName: device.name, serviceTag: device.serviceTag || '',
      model: (device.model || '').trim(), host: tag || norm(device.name),
      hostNames: [tag, norm(device.name)].filter(Boolean), watts: null, source: 'ome',
    });
  }
  return [...measured, ...extras];
}

/** 이 인스턴스 역할: 중앙(central) / 엣지(edge=중앙에 push하는 에이전트) / 단독(standalone). */
function instanceMode() {
  if (config.central?.centralUrl) return 'edge';   // 중앙으로 보내는 현장/엣지 인스턴스
  if (config.central?.token) return 'central';     // 에이전트 push를 받는 중앙
  return 'standalone';
}

/** 스냅샷 기준 통합 인벤토리 산출(라우트에서 호출). */
export async function getFleetInventory(snap) {
  const servers = await buildServerUniverse(snap?.hosts || []);
  const result = classifyFleet({
    hosts: snap?.hosts || [], vcenters: snap?.vcenters || [], servers,
    tags: loadFleetTags(), assign: loadFleetAssign(),
  });
  return { ...result, mode: instanceMode() };
}
