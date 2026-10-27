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
import { allMeasuredPower, vcPowerSkipReason, vcPowerSkippedOf, vcPowerKey } from '../idrac/service.js';
import { unreadVcenterReasons } from '../metrics/unreadVcenters.js'; // v2.733(C2-02): 지표 샘플러와 같은 vCenter 판정
import { usageReadable } from '../store.js';                         // v2.733(C2-02): 사용률과 같은 호스트 판정
import { loadRegistry, matchKeys, registryLoadError } from '../idrac/registry.js';
import { allOmeDevices, dbKey, getOmeEntry } from '../idrac/omeCache.js';
import { getInventory } from '../idrac/invCache.js';
import { loadFleetTags } from './fleetTags.js';
import { loadFleetAssign } from './fleetAssign.js';
import { getEdgeFleetServers, listEdgeFleet, UNREADABLE_HOLD_MS } from '../central/fleet.js';
// v2.783(점검 Q2 P-B3): 유령 키 판정이 보는 원격 수집(collector pull) 출처 — 인벤토리·전력·수집 서버 등록부·수신 상태.
import { remotePowerEntries, getCollectorStatus } from '../collector/state.js';
import { allRemoteServers } from '../collector/remoteInventory.js';
import { loadCollectors, registryLoadError as collectorsLoadError } from '../collector/registry.js';
import { summarizeRegistryError, REGISTRY_ERROR_LABEL } from '../util/registryCore.js';

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
      // v2.625: 받치는 iDRAC 등록 id — 사용률 수집(bmusage)이 ESXi 호스트의 iDRAC 을 찾는 연결 고리.
      //   받침이 없거나 엣지 보고분(serverByTag 에서 제외)이면 빈 값이고, 그 호스트는 iDRAC 경로가 없다.
      idracServerId: backed ? (m.serverId || '') : '',
      // v2.733(C2-02): vCenter 추정 전력을 지금 값으로 쓰지 않은 사유(getFleetInventory 가 비운 호스트만 — 없으면 싣지 않는다).
      ...(h.powerUnread ? { powerUnread: h.powerUnread } : {}),
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
async function buildServerUniverse(hosts, vcSkip = {}) {
  const measured = await allMeasuredPower({ hosts, ...vcSkip }); // v2.733(C2-02): 읽지 못한 vCenter·끊긴 호스트의 vCenter 추정 전력은 넣지 않는다
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

/*
 * ⚠⚠ v2.783(점검 Q2 P-B3 — 데이터 손실): 유령 키 판정의 **코어는 이 파일의 fleetKeySources 하나**다. 화면 요약(summary.ghostKeys)과
 *   POST /insights/fleet/prune(미리보기·실제 삭제)이 같은 함수(fleetGhostReport)를 쓴다.
 *   예전에는 둘이 서로 다른 live 집합을 썼다 — 화면은 classifyFleet 의 liveKeys(전력이 신선한 원격 서버만), prune 은 fleetLiveKeys
 *   (원격 수집 서버가 아예 없음). 다른 진짜 유령이 1개라도 있으면 버튼 한 번에 **살아 있는 원격 베어메탈**의 법인 귀속·강제
 *   baremetal 태그가 함께 지워졌고(재현: 확인창 '1개' · 실제 3건 삭제), fleet-assign 은 bmusage 법인 귀속의 입력이라 그 법인 통계에서 빠졌다.
 *   규칙:
 *    ① live 는 classifyFleet 이 행을 만드는 출처 **전부의 합집합**이다 — 등록부(전원오프·비활성 포함) · OME 캐시 · 원격 인벤토리
 *       (allRemoteServers — 전력 신선도와 무관) · 원격 전력 항목 전부 · 스냅샷 호스트(+vCenter 추정 전력 키) · 엣지 push.
 *       새 출처를 classifyFleet 에 넣으면 여기에도 넣는다(server/test/audit2783b.test.js 가 '분류 liveKeys ⊆ 이 집합' 을 대조한다).
 *    ② **못 읽은 출처는 '없음' 이 아니다**(numOrNull 규약의 키 판본). 등록부 손상 · 이 기동에서 아직 장비 목록을 받지 못한 OME 연결 ·
 *       인벤토리를 받은 적 없는(또는 꺼진) 수집 서버 · 호스트 목록을 모르는 vCenter · 보류·일부·만료된 엣지 보고가 하나라도 있으면
 *       unreadable 에 사유를 싣고, prune 은 지우지 않는다(라우트가 409/503). 사유에 원문 오류(파일 조각)는 싣지 않는다.
 */

/** 엣지 push 가 보이다가 사라진(TTL 만료) 에이전트 — 사라진 뒤 UNREADABLE_HOLD_MS 동안 '못 읽음' 으로 본다(보류에는 시한). */
const _edgeSeen = new Map(); // agent -> 마지막으로 살아 있던 시각(ms)

/** 호스트 목록을 모르는 vCenter — 연결 전·실패·점검중인데 스냅샷에 그 vCenter 의 호스트가 하나도 없다(직전 값 이월이 없다). */
function hostListUnknownVcenters(snap) {
  const withHosts = new Set((snap?.hosts || []).map((h) => h && h.vcenterId).filter(Boolean));
  const out = [];
  for (const vc of snap?.vcenters || []) {
    if (!vc || vc.id == null) continue;
    if (vc.status === 'connected' || withHosts.has(vc.id)) continue; // 연결돼 호스트 0 은 '비어 있음' 을 읽은 것이다
    out.push({ id: String(vc.id), name: String(vc.name || vc.id), status: String(vc.status || '') });
  }
  return out;
}

const addKey = (set, v) => { const k = norm(v); if (k) set.add(k); };

/**
 * 유령 키 판정 입력 — { live:Set<소문자 키>, unreadable:[{source, id?, reason, registry?}] }.
 * @param {object} snap  store.get() 스냅샷
 * @param {{now?:number}} [o]
 */
export function fleetKeySources(snap, { now = Date.now() } = {}) {
  const live = new Set();
  const unreadable = [];
  if (!snap || typeof snap !== 'object') unreadable.push({ source: 'snapshot', reason: '인벤토리 스냅샷이 아직 없습니다(기동 직후)' });

  // 1) iDRAC/OME 등록부 — 전원오프·비활성·전력 미보고라도 '등록된' 서버는 보호한다.
  const regErr = registryLoadError();
  if (regErr) {
    const code = summarizeRegistryError(regErr)?.code;
    unreadable.push({ source: 'idrac-registry', registry: true, reason: `iDRAC 등록부(idrac.json)를 읽지 못했습니다(${REGISTRY_ERROR_LABEL[code] || REGISTRY_ERROR_LABEL['read-error']})` });
  }
  const registry = loadRegistry();
  for (const s of registry) {
    addKey(live, s.id); addKey(live, s.serviceTag); addKey(live, s.host);
    addKey(live, getInventory(s.id)?.system?.serviceTag);
    for (const k of matchKeys(s)) addKey(live, k);
    // OME 연결: 이 기동에서 장비 목록을 받은 적이 없으면(재시작 직후·연결 실패·비활성) 그 장비 키를 모른다.
    if (s.type === 'ome' && !getOmeEntry(s.id)) {
      unreadable.push({ source: 'ome', id: String(s.id), reason: s.enabled === false
        ? `OME 연결 '${s.name || s.id}' 이(가) 비활성이라 장비 목록을 받지 않았습니다(다시 켜서 한 번 수집되거나, 연결을 삭제하면 정리할 수 있습니다)`
        : `OME 연결 '${s.name || s.id}' 의 장비 목록을 이 기동에서 아직 받지 못했습니다(재시작 직후이거나 OME 연결 실패)` });
    }
  }
  for (const { entryId, device } of allOmeDevices()) {
    addKey(live, dbKey(entryId, device)); addKey(live, device.serviceTag); addKey(live, device.name);
  }

  // 2) 원격 수집(collector pull) — 전력 항목 전부(신선도 무관) + 인벤토리 전부. classifyFleet 의 원격 행 키는 remote:<수집기>:<서버>.
  for (const r of remotePowerEntries()) {
    addKey(live, `remote:${r.collectorId}:${r.serverId != null ? r.serverId : r.host}`);
    addKey(live, r.serviceTag); addKey(live, r.host); addKey(live, r.serverName);
  }
  for (const s of allRemoteServers()) {
    addKey(live, `remote:${s.collectorId}:${s.id}`);
    addKey(live, s.serviceTag); addKey(live, s.inv?.system?.serviceTag); addKey(live, s.name); addKey(live, s.host); addKey(live, s.hostName);
    for (const n of (Array.isArray(s.hostNames) ? s.hostNames : [])) addKey(live, n);
  }
  if (collectorsLoadError()) unreadable.push({ source: 'collector-registry', registry: true, reason: '수집 서버 등록부(collectors.json)를 읽지 못했습니다' });
  for (const c of loadCollectors()) {
    if (!c || !c.id || !c.url) continue; // URL 이 없는 항목은 당기지 않는다(받은 적도 없다)
    if (c.enabled === false) {
      unreadable.push({ source: 'collector', id: String(c.id), reason: `수집 서버 '${c.name || c.id}' 이(가) 비활성이라 그 현장 서버 목록을 모릅니다(다시 켜서 한 번 수집되거나, 수집 서버를 삭제하면 정리할 수 있습니다)` });
    } else if (!Number.isFinite(getCollectorStatus(c.id)?.hosts)) {
      // pull 성공 경로만 hosts 를 채운다(collector/puller.js statusFromPull) — 이 기동에서 한 번도 받지 못했다.
      unreadable.push({ source: 'collector', id: String(c.id), reason: `수집 서버 '${c.name || c.id}' 에서 이 기동 뒤 서버 목록을 아직 받지 못했습니다` });
    }
  }

  // 3) 스냅샷 호스트(+ vCenter 추정 전력 행 키 — classifyFleet 의 servers 에 serverId 로 들어간다).
  for (const h of (snap?.hosts || [])) {
    addKey(live, h.serviceTag); addKey(live, h.name);
    if (h.name) addKey(live, vcPowerKey(h.vcenterId, h.name));
  }
  for (const v of hostListUnknownVcenters(snap)) {
    unreadable.push({ source: 'vcenter', id: v.id, reason: v.status === 'disabled'
      ? `vCenter '${v.name}' 이(가) 비활성이라 호스트 목록을 모릅니다(다시 켜서 한 번 수집되거나, 등록을 삭제하면 정리할 수 있습니다)`
      : `vCenter '${v.name}' 의 호스트 목록을 아직 읽지 못했습니다(상태 ${v.status || '미상'})` });
  }

  // 4) 엣지 push 베어메탈(중앙일 때만 — getFleetInventory 의 병합 조건과 같다).
  if (config.central?.token && !config.agent?.centralUrl) {
    try {
      for (const e of getEdgeFleetServers()) {
        addKey(live, e.serverId); addKey(live, e.serviceTag); addKey(live, e.serverName);
        for (const n of (e.hostNames || [])) addKey(live, n);
      }
      const listed = listEdgeFleet();
      const alive = new Set();
      for (const x of listed) {
        alive.add(x.agent); _edgeSeen.set(x.agent, now);
        if (x.registryUnreadable) unreadable.push({ source: 'edge', id: x.agent, reason: `엣지 '${x.agent}' 가 iDRAC 등록부를 읽지 못해 직전 목록을 유지 중입니다` });
        else if (x.partial && x.withheldItems !== 0) unreadable.push({ source: 'edge', id: x.agent, reason: `엣지 '${x.agent}' 가 목록 일부를 빼고 보냈습니다(못 읽은 vCenter)` });
      }
      for (const [a, t] of [..._edgeSeen]) {
        if (alive.has(a)) continue;
        if (now - t > UNREADABLE_HOLD_MS) { _edgeSeen.delete(a); continue; } // 보류에는 시한
        unreadable.push({ source: 'edge', id: a, reason: `엣지 '${a}' 의 베어메탈 보고가 만료됐습니다(무보고 — 다시 보고하면 정리할 수 있습니다)` });
      }
    } catch {
      unreadable.push({ source: 'edge', reason: '엣지 베어메탈 보고를 읽지 못했습니다' });
    }
  }
  return { live, unreadable };
}

/** 하위 호환 — live 키 집합만(판정은 fleetGhostReport 를 쓸 것). */
export function fleetLiveKeys(snap) {
  return fleetKeySources(snap).live;
}

/**
 * v2.783(점검 Q2 P-B3): 유령 키 보고 — 화면 요약과 prune(미리보기·실제)이 함께 쓰는 단일 판정.
 * ghostKeys 는 tags ∪ assign 의 **고유 키 수**(화면 숫자와 미리보기 숫자가 같은 단위), tags·assign 은 저장소별 키 목록.
 * @returns {{ ghostKeys:number, keys:string[], tags:string[], assign:string[], unreadable:object[], blocked:boolean }}
 */
export function fleetGhostReport(snap, { tags = loadFleetTags(), assign = loadFleetAssign(), now = Date.now() } = {}) {
  const { live, unreadable } = fleetKeySources(snap, { now });
  const tagKeys = Object.keys(tags || {}).filter((k) => !live.has(k)).sort();
  const assignKeys = Object.keys(assign || {}).filter((k) => !live.has(k)).sort();
  const keys = [...new Set([...tagKeys, ...assignKeys])].sort();
  return { ghostKeys: keys.length, keys, tags: tagKeys, assign: assignKeys, unreadable, blocked: unreadable.length > 0 };
}

/** 이 인스턴스 역할: 중앙(central) / 엣지(edge=중앙에 push하는 에이전트) / 단독(standalone). */
function instanceMode() {
  if (config.agent?.centralUrl) return 'edge';   // 중앙으로 push하는 현장/엣지 에이전트
  if (config.central?.token) return 'central';   // 에이전트 push를 받는 중앙
  return 'standalone';
}

/** 스냅샷 기준 통합 인벤토리 산출(라우트에서 호출). */
export async function getFleetInventory(snap) {
  // v2.733(점검 3회차 C2-02): 읽지 못한 vCenter(연결 실패 이월·낡은 위임·점검중)·끊긴 호스트의 powerWatts 는 몇 시간 전 값이다 —
  //   측정 전력 목록에서 빼고(allMeasuredPower), 분류 입력 호스트의 전력도 비워(null — 0 이 아니다) 화면이 '지금 W' 로 보이지 않게 한다.
  //   분류(가상화/베어메탈 판정)는 바꾸지 않는다 — 전력 칸만 비운다. 뺀 대수는 summary.vcPowerSkipped 로 밝힌다.
  const vcSkip = { unread: unreadVcenterReasons(snap), hostReadable: usageReadable };
  const hostsIn = snap?.hosts || [];
  const hosts = hostsIn.map((h) => {
    const r = h && (h.powerWatts != null || h.vcPowerWatts != null) ? vcPowerSkipReason(h, vcSkip) : null;
    return r ? { ...h, powerWatts: null, vcPowerWatts: null, powerUnread: r } : h;
  });
  const servers = await buildServerUniverse(hostsIn, vcSkip);
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
    hosts, vcenters: snap?.vcenters || [], servers,
    tags: loadFleetTags(), assign: loadFleetAssign(),
  });
  result.summary.vcPowerSkipped = vcPowerSkippedOf(hostsIn, vcSkip); // v2.733(C2-02)
  // v2.783(점검 Q2 P-B3): 화면의 유령 키 수는 prune 미리보기와 **같은 판정**(fleetGhostReport)이다 — classifyFleet 의 ghostKeys 는
  //   순수 함수 입력(servers)만 보므로 여기서 덮는다. 못 읽은 출처가 있으면 그 종류만 싣는다(이름·사유는 관리자 미리보기에서).
  try {
    const g = fleetGhostReport(snap);
    result.summary.ghostKeys = g.ghostKeys;
    result.summary.ghostBlocked = [...new Set(g.unreadable.map((u) => u.source))];
  } catch { result.summary.ghostBlocked = ['error']; }
  const edgeAgents = new Set(result.bareMetal.filter((b) => b.remoteAgent).map((b) => b.remoteAgent));
  result.summary.edgeReported = result.bareMetal.filter((b) => b.remoteAgent).length;
  result.summary.edgeAgents = edgeAgents.size;
  return { ...result, mode: instanceMode() };
}
