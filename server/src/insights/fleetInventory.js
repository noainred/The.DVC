/**
 * 통합 서버 인벤토리 — iDRAC/OME에서 수집한 물리 서버와 vCenter ESXi 호스트를 한 데 묶어
 * '가상화 호스트'와 '베어메탈 서버'로 분류한다.
 *
 * 조합 키:
 *   - Dell 서비스태그(서버 ↔ ESXi 호스트의 summary.hardware.otherIdentifyingInfo) 우선
 *   - 실제 ESXi 호스트명 일치 (호스트 인덱스 직접 매칭)
 *
 * 분류 규칙(자동 + 수동 예외):
 *   - iDRAC/OME 물리 서버가 '실제 ESXi 호스트'에 매칭되면 → 가상화 호스트(그 호스트를 iDRAC가 받침)
 *   - 어느 호스트에도 매칭되지 않으면              → 베어메탈
 *   - fleet-tags의 수동 태그(baremetal/virtualization/exclude)가 자동 판정을 덮어쓴다.
 *   - 명시 vcenterId(법인 소유권)는 호스트 여부와 무관 — 베어메탈에 법인만 등록할 수 있다.
 *
 * 소속 법인(vCenter) 결정 우선순위(vcSource로 노출):
 *   registry(iDRAC 레지스트리, 권위) > assigned(수동 등록) > collector(원격 수집기 귀속) >
 *   inferred(OME 연결의 법인 상속) . 알 수 없는/삭제된 vCenter는 미지정 처리.
 *
 * 키 정규화: 태그/소속 키는 모두 소문자(norm). 같은 물리 1대(iDRAC·OME·ESXi 호스트)는 서비스태그
 * 우선의 안정 키(fleetId)로 일관 식별해 두 목록 사이의 중복/누락/split-brain을 막는다.
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
import { getEdgeFleetServers } from '../central/fleet.js';

const norm = (s) => String(s || '').trim().toLowerCase();
const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);
// 양수 전력만 유효(0/음수/NaN은 '미측정'). KPI와 법인별 합계가 같은 집합을 쓰도록 단일 판정.
const pos = (x) => (Number.isFinite(x) && x > 0 ? x : undefined);
const posOrNull = (x) => (Number.isFinite(x) && x > 0 ? Math.round(x) : null);
const isMeasured = (b) => Number.isFinite(b.watts) && b.watts > 0;

/**
 * 순수 분류 함수.
 * @param hosts     snap.hosts (vCenter ESXi 호스트)
 * @param vcenters  snap.vcenters
 * @param servers   물리 서버 목록 [{ serverId, serverName, serviceTag, host, hostNames, model, watts, source, vcenterId, vcInferred }]
 * @param tags      { 소문자 키 -> 'baremetal'|'virtualization'|'exclude' }
 * @param assign    { 소문자 키 -> 소속 법인(vCenter) id } — 수동 귀속
 */
export function classifyFleet({ hosts = [], vcenters = [], servers = [], tags = {}, assign = {} } = {}) {
  const vcName = new Map(vcenters.map((v) => [v.id, v.name || v.id]));
  const vcRegion = new Map(vcenters.map((v) => [v.id, v.location?.region || v.region || '']));
  const idx = buildHostIndex(hosts);

  const tagOf = (serviceTag, altKey) =>
    tags[norm(serviceTag)] || (altKey ? tags[norm(altKey)] : '') || '';
  const knownVc = (id) => (id && vcName.has(id) ? id : ''); // 삭제된/유령 vCenter는 미지정 처리

  // 소속 법인 + 출처 결정. authoritative(레지스트리 iDRAC)는 레지스트리 vcenterId가 권위.
  const resolveVc = (serviceTag, altKey, server) => {
    const a = assign[norm(serviceTag)] || (altKey ? assign[norm(altKey)] : '') || '';
    const fb = server?.vcenterId || '';
    const authoritative = server?.source === 'idrac';
    let id = '', src = '';
    if (authoritative && fb) { id = fb; src = 'registry'; }
    else if (a) { id = a; src = 'assigned'; }
    else if (fb) {
      id = fb;
      // OME 소속은 연결의 법인 상속(자동 추론), 원격은 수집기 귀속, 엣지는 현장 보고, 호스트는 호스팅 vCenter.
      src = server?.source === 'ome' ? 'inferred'
        : server?.source === 'remote' ? 'collector'
          : server?.source === 'edge' ? 'edge'
            : server?.source === 'host' ? 'host' : 'registry';
    }
    // 엣지가 보고한 vcenterId는 중앙 vCenter 목록에 없더라도 출처(DC) 정보를 보존(미지정 강등 방지).
    id = server?.source === 'edge' ? id : knownVc(id);
    if (!id) src = '';
    return { id, src };
  };
  const vcRow = (id, src) => ({ vcenterId: id, vcenter: id ? (vcName.get(id) || id) : '', region: id ? (vcRegion.get(id) || '') : '', vcSource: id ? src : '' });

  // '실제 ESXi 호스트인가' — 호스트 인덱스(서비스태그/호스트명) 직접 매칭. 매칭 근거(via) 반환.
  // 엣지 보고 서버는 현장에서 이미 베어메탈로 확정됐고 name이 전역 단축 호스트명(esxi-01 등)과
  // 충돌하기 쉬우므로, 중앙에서는 '전역 유일한 서비스태그'로만 매칭한다(이름 기반 오매칭 차단).
  const matchesHost = (s) => {
    if (s.serviceTag && idx.byTag.has(norm(s.serviceTag))) return 'tag';
    if (s.source === 'edge') return '';
    for (const n of (s.hostNames && s.hostNames.length ? s.hostNames : [s.host])) {
      if (n && idx.byName.has(norm(n))) return 'name';
    }
    return '';
  };

  // 유령 키 탐지용 'live' 키 집합(현재 존재하는 서버/호스트의 서비스태그·ID·호스트명).
  const liveKeys = new Set();
  for (const s of servers) { const t = norm(s.serviceTag); if (t) liveKeys.add(t); const id = norm(s.serverId); if (id) liveKeys.add(id); }
  for (const h of hosts) { const t = norm(h.serviceTag); if (t) liveKeys.add(t); const n = norm(h.name); if (n) liveKeys.add(n); }

  // 호스트 전력/받침 판정용 서버 인덱스(제외 태그 제거).
  const serverByTag = new Map();
  const serverByName = new Map();
  for (const s of servers) {
    if (tagOf(s.serviceTag, s.serverId) === 'exclude') continue;
    if (s.source === 'edge') continue; // 엣지 보고 서버는 중앙 ESXi 호스트를 '받치지' 않음(전역 이름 오염 방지)
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
  const claimedHostKeys = new Set(); // 강제 베어메탈 서버가 점유한 호스트 키 → 호스트 루프에서 가상화 제외(중복 방지)
  const orphanVirt = [];             // 'virtualization' 강제했지만 어느 ESXi 호스트에도 무매칭 → 합성 가상화 행

  for (const s of servers) {
    const t = tagOf(s.serviceTag, s.serverId);
    if (t === 'exclude') continue;
    if (t === 'virtualization') {
      if (s.source !== 'vcenter' && !matchesHost(s)) orphanVirt.push(s);
      continue;
    }
    if (t !== 'baremetal') {
      if (s.source === 'vcenter') continue;
      if (matchesHost(s)) continue;
    } else {
      // 엣지 서버는 전역 유일 서비스태그(t:)로만 점유 — 전역 짧은 이름(n:)은 타 DC 동명 호스트를 억제하므로 금지.
      if (s.serviceTag) claimedHostKeys.add(`t:${norm(s.serviceTag)}`);
      if (s.source !== 'edge') {
        for (const n of (s.hostNames || [])) if (n) claimedHostKeys.add(`n:${norm(n)}`);
        if (s.host) claimedHostKeys.add(`n:${norm(s.host)}`);
      }
    }
    const dk = norm(s.serviceTag) || norm(s.serverId);
    if (usedBmKeys.has(dk)) continue;
    usedBmKeys.add(dk);
    const vc = resolveVc(s.serviceTag, s.serverId, s);
    bareMetal.push({
      serverId: s.serverId, fleetId: dk, name: s.serverName || s.host || s.serviceTag || s.serverId,
      model: s.model || '', serviceTag: s.serviceTag || '', source: s.source,
      watts: posOrNull(s.watts), forced: t === 'baremetal', tag: t || '', tagKey: dk,
      remoteAgent: s.remoteAgent || '', // 엣지 보고 시 출처 DC/에이전트
      ...vcRow(vc.id, vc.src),
    });
  }

  // --- 2) 가상화 호스트 목록(=vCenter ESXi 호스트, 권위 소스) ---
  const virtualizationHosts = [];
  for (const h of hosts) {
    const altKey = norm(h.name);
    const hk = norm(h.serviceTag) || altKey; // 분류/소속 변경용 안정 키
    const t = tagOf(h.serviceTag, h.name);
    if (t === 'exclude') continue;

    const m = (h.serviceTag && serverByTag.get(norm(h.serviceTag))) || serverByName.get(altKey);
    const mForcedBm = !!(m && tagOf(m.serviceTag, m.serverId) === 'baremetal');
    const claimed = (h.serviceTag && claimedHostKeys.has(`t:${norm(h.serviceTag)}`)) || claimedHostKeys.has(`n:${altKey}`);

    if (t === 'baremetal') {
      // 받침 서버가 있으면 그 키도 점유 처리 → 같은 서버에 매칭되는 다른 호스트의 가상화 중복 방지.
      if (m) { if (m.serviceTag) claimedHostKeys.add(`t:${norm(m.serviceTag)}`); for (const n of (m.hostNames || [])) if (n) claimedHostKeys.add(`n:${norm(n)}`); }
      if (!usedBmKeys.has(hk)) {
        usedBmKeys.add(hk);
        const w = (m ? pos(m.watts) : undefined) ?? pos(h.powerWatts) ?? pos(h.vcPowerWatts);
        const vc = resolveVc(h.serviceTag, h.name, { vcenterId: h.vcenterId, source: 'host' });
        bareMetal.push({
          serverId: `host:${h.vcenterId}:${h.name}`, fleetId: hk, name: h.name, model: h.model || '',
          serviceTag: h.serviceTag || '', source: (m && m.source !== 'vcenter') ? m.source : 'vcenter',
          watts: posOrNull(w), forced: true, tag: 'baremetal', tagKey: hk, ...vcRow(vc.id, vc.src),
        });
      }
      continue;
    }
    if (mForcedBm || claimed) continue; // 같은 물리 박스가 베어메탈로 이동 → 가상화 중복 방지

    const backed = !!(m && m.source !== 'vcenter');
    const via = backed ? (h.serviceTag && norm(m.serviceTag) === norm(h.serviceTag) ? 'tag' : 'name') : '';
    // 0W·음수 vcPowerWatts 센서값은 '미측정'으로 간주(null 폴백) — pos()로 통일.
    const watts = (backed ? pos(m.watts) : undefined)
      ?? pos(h.powerWatts)
      ?? pos(h.vcPowerWatts)
      ?? (m ? pos(m.watts) : undefined)
      ?? null;
    virtualizationHosts.push({
      name: h.name, fleetId: hk, vcenterId: h.vcenterId, vcenter: vcName.get(h.vcenterId) || h.vcenterId,
      region: vcRegion.get(h.vcenterId) || '', model: h.model || '', serviceTag: h.serviceTag || '',
      cpuCores: h.cpuCores || 0, memGB: round((h.memTotalMB || 0) / 1024) || 0,
      connectionState: h.connectionState || '', watts: round(watts),
      powerSource: backed ? m.source : (Number.isFinite(watts) ? 'vcenter' : null),
      idracBacked: backed, via, tag: t || '', tagKey: hk,
    });
  }

  // orphan virtualization → 합성 가상화 행.
  for (const s of orphanVirt) {
    const dk = norm(s.serviceTag) || norm(s.serverId);
    const vc = resolveVc(s.serviceTag, s.serverId, s);
    virtualizationHosts.push({
      name: s.serverName || s.host || s.serviceTag || s.serverId, fleetId: dk, vcenterId: vc.id,
      vcenter: vc.id ? (vcName.get(vc.id) || vc.id) : '', region: vc.id ? (vcRegion.get(vc.id) || '') : '',
      model: s.model || '', serviceTag: s.serviceTag || '', cpuCores: 0, memGB: 0,
      connectionState: '', watts: posOrNull(s.watts), powerSource: pos(s.watts) ? s.source : null,
      idracBacked: true, via: 'forced', synthetic: true, tag: 'virtualization', tagKey: dk,
    });
  }

  bareMetal.sort((a, b) => (b.watts || 0) - (a.watts || 0) || String(a.name).localeCompare(String(b.name)));
  virtualizationHosts.sort((a, b) =>
    String(a.vcenter).localeCompare(String(b.vcenter)) || String(a.name).localeCompare(String(b.name)));

  const measured = bareMetal.filter(isMeasured);
  const bareMetalWatts = measured.reduce((acc, b) => acc + b.watts, 0);

  // 베어메탈을 소속 법인(vCenter)별로 묶는다('' = 미지정). 합산은 KPI와 동일 집합만.
  const byVcMap = new Map();
  for (const b of bareMetal) {
    const id = b.vcenterId || '';
    const e = byVcMap.get(id) || { vcenterId: id, name: id ? (vcName.get(id) || id) : '(미지정)', region: id ? (vcRegion.get(id) || '') : '', servers: 0, watts: 0 };
    e.servers += 1;
    if (isMeasured(b)) e.watts += b.watts;
    byVcMap.set(id, e);
  }
  const byVcenter = [...byVcMap.values()].map((e) => ({ ...e, watts: round(e.watts) || 0 }))
    .sort((a, z) => z.watts - a.watts || z.servers - a.servers);

  // 유령 키: tags/assign에 있지만 현재 어느 서버/호스트와도 매칭 안 되는 키(서버 교체·태그 변경 잔재).
  const cfgKeys = new Set([...Object.keys(tags), ...Object.keys(assign)]);
  let ghostKeys = 0; for (const k of cfgKeys) if (!liveKeys.has(k)) ghostKeys += 1;

  const summary = {
    virtualizationHosts: virtualizationHosts.length,
    idracBackedHosts: virtualizationHosts.filter((h) => h.idracBacked).length,
    syntheticVirt: virtualizationHosts.filter((h) => h.synthetic).length,
    bareMetal: bareMetal.length,
    bareMetalMeasured: measured.length,
    bareMetalWatts: round(bareMetalWatts) || 0,
    bareMetalKw: Math.round(bareMetalWatts / 100) / 10,
    bareMetalAssigned: bareMetal.filter((b) => b.vcenterId).length,
    bareMetalUnassigned: bareMetal.filter((b) => !b.vcenterId).length,
    bareMetalInferred: bareMetal.filter((b) => b.vcSource === 'inferred').length,
    forcedBareMetal: bareMetal.filter((b) => b.forced).length,
    excluded: Object.entries(tags).filter(([k, v]) => v === 'exclude' && liveKeys.has(k)).length, // live 제외만
    ghostKeys,
  };
  const vcList = vcenters.map((v) => ({ id: v.id, name: v.name || v.id, region: v.location?.region || v.region || '' }));
  // 엣지가 보고한, 중앙에 없는 vCenter id도 필터 목록에 노출(그 DC 베어메탈을 법인 필터로 좁힐 수 있게).
  const knownVcIds = new Set(vcList.map((v) => v.id));
  for (const b of bareMetal) {
    if (b.vcenterId && !knownVcIds.has(b.vcenterId)) { knownVcIds.add(b.vcenterId); vcList.push({ id: b.vcenterId, name: b.vcenterId, region: '', external: true }); }
  }
  return { virtualizationHosts, bareMetal, byVcenter, vcenters: vcList, summary, liveKeys: [...liveKeys] };
}

/**
 * 전력 미보고 등록 서버까지 포함해 물리 서버 universe를 구성.
 * allMeasuredPower(전력 보고분) + 레지스트리/OME에 등록됐지만 현재 전력 샘플이 없는 서버(watts=null).
 * extras끼리도 dedup(seenTag/seenHost를 갱신). OME 서버는 소속 OME 연결의 법인(vcenterId)을 상속(자동 추론).
 */
async function buildServerUniverse(hosts) {
  const measured = await allMeasuredPower({ hosts });
  const registry = loadRegistry();      // 1회만 읽는다(과거 3회 중복 I/O 제거)
  const omeDevices = allOmeDevices();    // 1회만 순회
  const seenTag = new Set(measured.map((s) => norm(s.serviceTag)).filter(Boolean));
  const seenHost = new Set(measured.flatMap((s) => (s.hostNames || []).map(norm)).filter(Boolean));

  // OME 연결(레지스트리 type=ome)에 지정된 법인 → 그 연결이 발견한 디바이스가 상속(entryId 기준, 모호성 없음).
  // 전력 보고분(measured)은 service.js에서 이미 vcenterId가 채워지고, 무전력 발견분(extras)은 아래에서 채운다.
  const omeEntryVc = new Map(registry.filter((s) => s.type === 'ome' && s.vcenterId).map((s) => [s.id, s.vcenterId]));

  const extras = [];
  for (const s of registry) {
    if (s.type === 'ome') continue;
    const keys = matchKeys(s);
    const regTag = norm(s.serviceTag);
    if ((regTag && seenTag.has(regTag)) || keys.some((k) => seenHost.has(k))) continue; // 1차 빠른 skip
    const inv = getInventory(s.id);
    const serviceTag = (inv?.system?.serviceTag || s.serviceTag || '').trim();
    const tag = norm(serviceTag);
    if (tag && seenTag.has(tag)) continue;
    const hostNames = [...new Set([...(s.hostNames || []).map(norm), tag].filter(Boolean))];
    extras.push({
      serverId: s.id, serverName: s.name, serviceTag, model: (inv?.system?.model || '').trim(),
      host: norm(s.host), hostNames, vcenterId: s.vcenterId || '', watts: null, source: 'idrac',
    });
    if (tag) seenTag.add(tag);
    keys.forEach((k) => seenHost.add(k));
  }
  for (const { entryId, device } of omeDevices) {
    const tag = norm(device.serviceTag);
    const nameKey = norm(device.name);
    // 대칭 dedup: 서비스태그/이름 어느 쪽이든 이미 집계된 물리 서버면 skip(중복 추가 방지).
    if ((tag && (seenTag.has(tag) || seenHost.has(tag))) || (nameKey && seenHost.has(nameKey))) continue;
    extras.push({
      serverId: dbKey(entryId, device), serverName: device.name, serviceTag: device.serviceTag || '',
      model: (device.model || '').trim(), host: tag || nameKey,
      hostNames: [tag, nameKey].filter(Boolean), watts: null,
      vcenterId: omeEntryVc.get(entryId) || '', source: 'ome',
    });
    if (tag) { seenTag.add(tag); seenHost.add(tag); } // 항상 양쪽 갱신(후속 동일 서버 dedup)
    if (nameKey) seenHost.add(nameKey);
  }

  return [...measured, ...extras];
}

/**
 * prune 전용 'live 키' 집합 — 전력 DB를 거치지 않고 레지스트리(등록된 모든 서버) + OME 캐시 + 호스트에서
 * 직접 키를 모은다. 전원오프·전력미보고라도 '등록된' 서버는 보호되어 prune이 정상 키를 지우지 않게 한다.
 */
export function fleetLiveKeys(snap) {
  const live = new Set();
  for (const s of loadRegistry()) {
    const id = norm(s.id); if (id) live.add(id);
    const t = norm(s.serviceTag); if (t) live.add(t);
    const invTag = norm(getInventory(s.id)?.system?.serviceTag); if (invTag) live.add(invTag);
    for (const n of (s.hostNames || [])) { const k = norm(n); if (k) live.add(k); }
  }
  for (const { entryId, device } of allOmeDevices()) {
    live.add(norm(dbKey(entryId, device)));
    const t = norm(device.serviceTag); if (t) live.add(t);
    const n = norm(device.name); if (n) live.add(n);
  }
  for (const h of (snap?.hosts || [])) {
    const t = norm(h.serviceTag); if (t) live.add(t);
    const n = norm(h.name); if (n) live.add(n);
  }
  // 엣지 보고 베어메탈의 키도 보호(중앙에서 단 태그/소속이 유령으로 오삭제되지 않게).
  if (config.central?.token && !config.agent?.centralUrl) {
    try {
      for (const e of getEdgeFleetServers()) {
        const id = norm(e.serverId); if (id) live.add(id);
        const t = norm(e.serviceTag); if (t) live.add(t);
        const n = norm(e.serverName); if (n) live.add(n);
      }
    } catch { /* */ }
  }
  return live;
}

/** 이 인스턴스 역할: 중앙(central) / 엣지(edge=중앙에 push하는 에이전트) / 단독(standalone). */
function instanceMode() {
  if (config.agent?.centralUrl) return 'edge';   // 중앙으로 push하는 현장/엣지 에이전트
  if (config.central?.token) return 'central';   // 에이전트 push를 받는 중앙
  return 'standalone';
}

/** 스냅샷 기준 통합 인벤토리 산출(라우트에서 호출). */
export async function getFleetInventory(snap) {
  const servers = await buildServerUniverse(snap?.hosts || []);
  // 중앙(엣지가 아닌)일 때만 엣지 push 베어메탈을 병합 — 자가 병합 방지(한 노드가 양쪽 설정인 경우).
  if (config.central?.token && !config.agent?.centralUrl) {
    try {
      // 로컬/원격으로 이미 잡힌 물리 서버는 제외하고 병합(서비스태그/호스트명 사전 dedup → 이중계산 방지).
      const seenTag = new Set(servers.map((s) => norm(s.serviceTag)).filter(Boolean));
      const seenHost = new Set(servers.flatMap((s) => (s.hostNames || []).map(norm)).filter(Boolean));
      for (const e of getEdgeFleetServers()) {
        const t = norm(e.serviceTag);
        const hostHit = (e.hostNames || []).some((h) => seenHost.has(norm(h)));
        // 대칭 dedup: 서비스태그가 있어도 호스트명 충돌을 함께 검사(서비스태그 없는 로컬 행과의 이중계산 방지).
        if ((t && (seenTag.has(t) || seenHost.has(t))) || hostHit) continue;
        servers.push(e);
        if (t) { seenTag.add(t); seenHost.add(t); }
        for (const h of (e.hostNames || [])) { const k = norm(h); if (k) seenHost.add(k); }
      }
    } catch { /* 엣지 데이터 없음 무시 */ }
  }
  const result = classifyFleet({
    hosts: snap?.hosts || [], vcenters: snap?.vcenters || [], servers,
    tags: loadFleetTags(), assign: loadFleetAssign(),
  });
  const edgeAgents = new Set(result.bareMetal.filter((b) => b.remoteAgent).map((b) => b.remoteAgent));
  result.summary.edgeReported = result.bareMetal.filter((b) => b.remoteAgent).length;
  result.summary.edgeAgents = edgeAgents.size;
  return { ...result, mode: instanceMode() };
}
