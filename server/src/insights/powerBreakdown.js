/**
 * 전력 분석 — 측정된 '모든' 서버의 소비전력을 법인(vCenter)·모델·지역별로 분해한다.
 * FinOps가 총량/비용에 초점이라면, 여기서는 "어디서·어떤 모델이 얼마나" 쓰는지를 본다.
 *
 * 매핑(서버 → ESXi 호스트 → vCenter)은 두 단계로 시도한다:
 *   1) 서버의 hostNames/이름 중 하나가 ESXi 호스트명과 일치
 *   2) 서버의 서비스태그가 ESXi 호스트의 서비스태그와 일치(Dell: iDRAC SKU == ESXi otherIdentifyingInfo)
 * 둘 다 실패하면 '(미매핑)'으로 분류하되 전력 합계에는 반드시 포함한다.
 */

import { loadFinopsConfig } from './finops.js';
import { buildHostIndex, resolveServerVcenter } from '../idrac/attribution.js';
import { matchDatacenterId } from '../collector/datacenterMatch.js';

const round = (x, d = 1) => (x == null || !Number.isFinite(x) ? 0 : Number(x.toFixed(d)));

/**
 * @param snap         store 스냅샷(hosts, vcenters)
 * @param measuredList allMeasuredPower() 결과 [{ serverName, watts, host, hostNames, model, serviceTag, source }]
 * @param opts         { vcenterId, assign, datacenters } — vcenterId 지정 시 그 법인으로 매핑되는
 *                     서버만 집계. assign=vCenter→DataCenter id 맵, datacenters=[{id,name}] (DataCenter
 *                     2단 분류용: 1차 DataCenter, 2차 vCenter/Baremetal).
 */
export function computePowerBreakdown(snap, measuredList, opts = {}) {
  const cfg = loadFinopsConfig();
  const vcFilter = opts.vcenterId ? String(opts.vcenterId) : '';
  const assign = opts.assign || {};
  const datacenters = opts.datacenters || [];
  const dcNameById = new Map(datacenters.map((d) => [String(d.id), d.name || d.id]));

  const regionByVc = new Map();
  const validVcIds = new Set();
  for (const v of snap.vcenters || []) { regionByVc.set(v.id, v.location?.region || v.region || '기타'); validVcIds.add(v.id); }

  // ESXi 호스트 인덱스(이름·서비스태그) + 공유 귀속 규칙(명시 vcenterId 우선).
  const idx = buildHostIndex(snap.hosts || []);
  const list = Array.isArray(measuredList) ? measuredList : [];
  const resolveHost = (m) => resolveServerVcenter(m, idx, validVcIds);

  // 측정 서버의 소속 DataCenter id 해석:
  //  1) vCenter에 매핑되면 그 vCenter의 소속 법인(assign)
  //  2) 아니면 서버에 명시된 datacenterId(iDRAC 스캔 태깅)
  //  3) 그래도 없으면 원격 수집기 라벨/collectorId를 등록 DataCenter와 매칭(원격 베어메탈 귀속)
  const resolveDc = (m, hi) => {
    if (hi) return String(assign[hi.vcenterId] || '');
    const explicit = String(m.datacenterId || '').trim();
    if (explicit) return explicit;
    return matchDatacenterId([m.datacenterLabel, m.collectorId], datacenters);
  };

  const byVc = new Map();     // vcId -> { vcId, region, watts, servers }
  const byModel = new Map();  // model -> { model, watts, servers }
  const byRegion = new Map(); // region -> { region, watts, servers, vcenters:Set }
  const byDc = new Map();     // dcKey -> { dcId, watts, servers, children:Map }
  const servers = [];
  let totalW = 0, mapped = 0, unmapped = 0, unmappedW = 0;

  for (const m of list) {
    const w = Number(m.watts);
    if (!Number.isFinite(w)) continue;
    const hi = resolveHost(m);
    if (vcFilter && (!hi || hi.vcenterId !== vcFilter)) continue;

    const vcId = hi ? hi.vcenterId : '(미매핑)';
    const region = hi ? (regionByVc.get(hi.vcenterId) || '기타') : '(미매핑)';
    const model = (m.model || '').trim() || '(모델 미상)';
    totalW += w;
    if (hi) mapped++; else { unmapped++; unmappedW += w; }
    servers.push({ name: m.serverName || m.host, watts: Math.round(w), model, serviceTag: m.serviceTag || '', vcenterId: vcId, region, source: m.source || '', mapped: !!hi });

    const cv = byVc.get(vcId) || { vcId, region, watts: 0, servers: 0 };
    cv.watts += w; cv.servers++; byVc.set(vcId, cv);
    const cm = byModel.get(model) || { model, watts: 0, servers: 0 };
    cm.watts += w; cm.servers++; byModel.set(model, cm);
    const cr = byRegion.get(region) || { region, watts: 0, servers: 0, vcenters: new Set() };
    cr.watts += w; cr.servers++; cr.vcenters.add(vcId); byRegion.set(region, cr);

    // DataCenter 2단 분류: 1차 DataCenter → 2차 (vCenter | Baremetal).
    const dcId = resolveDc(m, hi);
    const dcKey = dcId || '__nodc__';
    let dg = byDc.get(dcKey);
    if (!dg) { dg = { dcId, watts: 0, servers: 0, children: new Map() }; byDc.set(dcKey, dg); }
    dg.watts += w; dg.servers++;
    // 2차: vCenter에 매핑되면 그 vCenter, 아니면 Baremetal(법인엔 속하나 vCenter엔 없음).
    const childKey = hi ? `vc:${hi.vcenterId}` : '__baremetal__';
    let ch = dg.children.get(childKey);
    if (!ch) { ch = { type: hi ? 'vcenter' : 'baremetal', key: childKey, vcenterId: hi ? hi.vcenterId : '', watts: 0, servers: 0 }; dg.children.set(childKey, ch); }
    ch.watts += w; ch.servers++;
  }

  // 에너지·비용·탄소(현재 전력 × PUE 기준)
  const energy = (watts, hours) => (watts * cfg.pue / 1000) * hours;
  const pack = (watts) => {
    const kwhMonth = energy(watts, 24 * 30), kwhYear = energy(watts, 24 * 365);
    return {
      watts: Math.round(watts),
      kwhMonth: round(kwhMonth), kwhYear: round(kwhYear, 0),
      costMonth: round(kwhMonth * cfg.tariffPerKwh, 0), costYear: round(kwhYear * cfg.tariffPerKwh, 0),
      co2YearKg: round(kwhYear * cfg.co2KgPerKwh, 0),
    };
  };

  return {
    config: cfg,
    scope: vcFilter || '',
    totalServers: servers.length,
    mappedServers: mapped,
    unmappedServers: unmapped,
    unmappedWatts: Math.round(unmappedW),
    totals: pack(totalW),
    byVcenter: [...byVc.values()].map((c) => ({ vcId: c.vcId, region: c.region, servers: c.servers, ...pack(c.watts) })).sort((a, b) => b.watts - a.watts),
    // 1차 DataCenter → 2차 vCenter/Baremetal. 미지정 법인(__nodc__)은 맨 뒤.
    byDatacenter: [...byDc.values()].map((d) => ({
      datacenterId: d.dcId || '',
      datacenterName: d.dcId ? (dcNameById.get(String(d.dcId)) || d.dcId) : '(법인 미지정)',
      servers: d.servers,
      ...pack(d.watts),
      children: [...d.children.values()].map((c) => ({
        type: c.type,
        name: c.type === 'baremetal' ? 'Baremetal' : c.vcenterId,
        vcenterId: c.vcenterId,
        servers: c.servers,
        ...pack(c.watts),
      })).sort((a, b) => (a.type === 'baremetal' ? 1 : 0) - (b.type === 'baremetal' ? 1 : 0) || b.watts - a.watts),
    })).sort((a, b) => (a.datacenterId ? 0 : 1) - (b.datacenterId ? 0 : 1) || b.watts - a.watts),
    byModel: [...byModel.values()].map((c) => ({ model: c.model, servers: c.servers, ...pack(c.watts) })).sort((a, b) => b.watts - a.watts),
    byRegion: [...byRegion.values()].map((c) => ({ region: c.region, servers: c.servers, vcenters: c.vcenters.size, ...pack(c.watts) })).sort((a, b) => b.watts - a.watts),
    servers: servers.sort((a, b) => b.watts - a.watts),
    generatedAt: Date.now(),
  };
}
