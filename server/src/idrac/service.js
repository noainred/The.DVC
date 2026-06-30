/**
 * Glue between the iDRAC registry (which server maps to which ESXi host) and the
 * power-sample DB. Provides host-name → power lookups for the API and the
 * snapshot overlay.
 */

import { loadRegistry, matchKeys } from './registry.js';
import { getDb } from './db.js';
import { allOmeDevices, dbKey, clearOmeExcept } from './omeCache.js';
import { getInventory } from './invCache.js';
import { remotePowerByHost, clearStaleRemote } from '../collector/state.js';
import { loadCollectors } from '../collector/registry.js';
import { loadPowerSettings } from './powerSettings.js';

/** vCenter 호스트 전력 샘플의 안정적 DB/측정 키(현재값·시계열이 같은 키를 쓰도록). */
export function vcPowerKey(vcenterId, hostName) {
  return `vc:${String(vcenterId || '').trim().toLowerCase()}:${String(hostName || '').trim().toLowerCase()}`;
}

// 서버의 모델/서비스태그를 인벤토리(Redfish)·레지스트리에서 최선의 값으로 해석.
function serverIdentity(serverId, entry) {
  const inv = getInventory(serverId);
  const model = (inv?.system?.model || '').trim();
  const serviceTag = (inv?.system?.serviceTag || entry?.serviceTag || '').trim();
  return { model, serviceTag };
}

const norm = (s) => String(s || '').trim().toLowerCase();

/** Find an OME-discovered device matching an ESXi host name (serviceTag/name). */
function findOmeDeviceForHost(hostName) {
  const key = norm(hostName);
  if (!key) return null;
  for (const { entryId, device } of allOmeDevices()) {
    if (norm(device.serviceTag) === key || norm(device.name) === key) return { entryId, device };
  }
  return null;
}

/** registry entry (iDRAC-direct) that owns a given ESXi host name. */
export function findServerForHost(hostName) {
  if (!hostName) return null;
  const key = norm(hostName);
  for (const s of loadRegistry()) {
    if (s.type === 'ome') continue; // OME hosts resolve via discovered devices
    if (matchKeys(s).includes(key)) return s;
  }
  return null;
}

/**
 * Locally-collected power only (this instance's iDRAC-direct + OME). Used both
 * for the local overlay and for the collector-agent export.
 * Map<hostLower, { watts, ts, serverId, serverName }>.
 */
export async function localPowerByHostName() {
  const db = await getDb();
  const latest = db.latestAll(); // Map<serverId, {watts, ts}>
  const out = new Map();

  // iDRAC-direct entries: match by registry keys. (serviceTag/model을 함께 실어 중앙 dedup·표시에 사용)
  for (const s of loadRegistry()) {
    if (s.type === 'ome') continue;
    const sample = latest.get(s.id);
    if (!sample) continue;
    const { model, serviceTag } = serverIdentity(s.id, s);
    for (const key of matchKeys(s)) {
      out.set(key, { watts: sample.watts, ts: sample.ts, serverId: s.id, serverName: s.name, serviceTag, model });
    }
  }

  // OME-discovered devices: match by serviceTag/name.
  for (const { entryId, at, device } of allOmeDevices()) {
    if (device.watts == null) continue;
    const sample = latest.get(dbKey(entryId, device)) || { watts: device.watts, ts: at };
    for (const k of [norm(device.serviceTag), norm(device.name)]) {
      if (k) out.set(k, { watts: sample.watts, ts: sample.ts, serverId: dbKey(entryId, device), serverName: device.name, serviceTag: device.serviceTag || '', model: (device.model || '').trim() });
    }
  }
  return out;
}

/**
 * Map of lower-cased ESXi host name -> latest power sample for the dashboard,
 * merging locally-collected power with power pulled from remote collector
 * agents (most recent timestamp wins per host).
 */
export async function latestPowerByHostName() {
  const out = await localPowerByHostName();
  for (const [host, r] of remotePowerByHost()) {
    const cur = out.get(host);
    if (!cur || (r.ts || 0) > (cur.ts || 0)) {
      out.set(host, { watts: r.watts, ts: r.ts, serverId: `remote:${r.collectorId}`, serverName: r.serverName, datacenter: r.datacenter });
    }
  }
  return out;
}

/**
 * 등록된 '모든' 서버의 최신 측정 전력(서버 단위, serverId로 중복 제거).
 * iDRAC-직접 + OME 장비 + 원격 수집서버를 포함한다. ESXi 호스트 인벤토리와 매핑되지 않은
 * 서버도 그대로 포함하므로(예: 호스트명이 인벤토리와 다른 경우), 측정된 실제 소비전력 합계가
 * 매핑 여부와 무관하게 집계된다. 각 항목의 host는 매핑 기준 이름(인벤토리 매칭 시도용).
 * 반환 [{ serverId, serverName, watts, ts, host, source }].
 */
export async function allMeasuredPower({ hosts = [], vcenterFirst = false } = {}) {
  const db = await getDb();
  const latest = db.latestAll(); // Map<serverId,{watts,ts}>
  const out = [];
  const seen = new Set();        // serverId 중복 방지
  const seenIdent = new Set();   // 같은 물리 서버(서비스태그/호스트)가 여러 소스(iDRAC/OME/원격)로
                                 // 중복 집계되어 서버 수·전력 합이 부풀려지는 것을 방지.
  const identKeys = (serviceTag, hostNames) => {
    const keys = [];
    const st = norm(serviceTag); if (st) keys.push(`st:${st}`);
    for (const h of (hostNames || [])) { const n = norm(h); if (n) keys.push(`h:${n}`); }
    return keys;
  };
  // entry를 추가하되, serverId 또는 물리 식별자(서비스태그/호스트)가 이미 집계됐으면 건너뛴다.
  const tryAdd = (entry, serviceTag, hostNames) => {
    if (seen.has(entry.serverId)) return;
    const keys = identKeys(serviceTag, hostNames);
    if (keys.some((k) => seenIdent.has(k))) return; // 다른 소스로 이미 집계된 동일 서버
    out.push(entry);
    seen.add(entry.serverId);
    keys.forEach((k) => seenIdent.add(k));
  };

  // 물리 실측 소스(iDRAC 직접 + OME 장비 + 원격 수집기).
  const addPhysical = () => {
    for (const s of loadRegistry()) {
      if (s.type === 'ome') continue;
      const sample = latest.get(s.id);
      if (!sample || sample.watts == null || !Number.isFinite(sample.watts)) continue;
      const { model, serviceTag } = serverIdentity(s.id, s);
      const hostNames = matchKeys(s);                  // 출력/귀속용(표시이름·태그 별칭 포함)
      // dedup 식별은 '실제 호스트명/IP'만 사용(표시 이름은 사용자가 임의 지정 가능 → 충돌로 오드롭 방지).
      const dedupHosts = [...(s.hostNames || []), s.host].filter(Boolean);
      tryAdd({ serverId: s.id, serverName: s.name, watts: sample.watts, ts: sample.ts, host: norm(s.host || hostNames[0] || s.name), hostNames, model, serviceTag, vcenterId: s.vcenterId || '', source: 'idrac' }, serviceTag, dedupHosts);
    }
    // OME 연결의 소속 법인 → 그 연결이 발견한 디바이스가 상속(전력 귀속을 PowerMap/FinOps/플릿이 공유).
    const omeEntryVc = new Map(loadRegistry().filter((s) => s.type === 'ome' && s.vcenterId).map((s) => [s.id, s.vcenterId]));
    for (const { entryId, at, device } of allOmeDevices()) {
      if (device.watts == null) continue;
      const key = dbKey(entryId, device);
      const sample = latest.get(key) || { watts: device.watts, ts: at };
      if (sample.watts == null || !Number.isFinite(sample.watts)) continue;
      const st = norm(device.serviceTag);
      const hostNames = [st, norm(device.name)].filter(Boolean);
      // OME 식별: 서비스태그 + 호스트명 모두 dedup 키로(서비스태그 없는 iDRAC과 같은 박스도 이름으로 dedup).
      const dedupHosts = [device.serviceTag, device.name].filter(Boolean);
      tryAdd({ serverId: key, serverName: device.name, watts: sample.watts, ts: sample.ts, host: st || norm(device.name), hostNames, model: (device.model || '').trim(), serviceTag: device.serviceTag || '', vcenterId: omeEntryVc.get(entryId) || '', source: 'ome' }, device.serviceTag, dedupHosts);
    }
    const seenRemoteOrigin = new Set(); // 같은 수집기의 동일 서버(여러 별칭 보고)를 한 번만 집계
    for (const [host, r] of remotePowerByHost()) {
      if (r.watts == null || !Number.isFinite(r.watts)) continue;
      // 출처 서버 식별: serverId가 있으면 그 기준으로 중복 제거(구버전 수집기의 별칭 중복 행 흡수).
      if (r.serverId != null) {
        const origin = `${r.collectorId}:${r.serverId}`;
        if (seenRemoteOrigin.has(origin)) continue;
        seenRemoteOrigin.add(origin);
      }
      const id = `remote:${r.collectorId}:${r.serverId != null ? r.serverId : host}`;
      const hostNames = [norm(host)];
      tryAdd({ serverId: id, serverName: r.serverName || host, watts: r.watts, ts: r.ts, host: norm(host), hostNames, model: (r.model || '').trim(), serviceTag: r.serviceTag || '', vcenterId: r.vcenterId || '', source: 'remote' }, r.serviceTag, [host].filter(Boolean));
    }
  };

  // vCenter PerformanceManager로 수집한 ESXi 호스트 전력(host.powerWatts).
  const addVcenter = () => {
    if (loadPowerSettings().includeVcenterPower === false) return;
    const now = Date.now();
    for (const h of (hosts || [])) {
      const w = Number(h.powerWatts);
      if (!Number.isFinite(w) || w <= 0) continue;
      const name = norm(h.name);
      const id = vcPowerKey(h.vcenterId, h.name);
      const hostNames = [name, norm(h.serviceTag)].filter(Boolean);
      tryAdd({ serverId: id, serverName: h.name, watts: w, ts: now, host: name, hostNames, model: (h.model || '').trim(), serviceTag: h.serviceTag || '', vcenterId: h.vcenterId || '', source: 'vcenter' }, h.serviceTag, [h.name].filter(Boolean));
    }
  };

  // 소스 우선순위(먼저 추가된 소스가 dedup에서 이김):
  //  - 기본(iDRAC 우선): 물리 실측을 먼저 → 같은 박스의 vCenter 추정은 dedup으로 스킵. iDRAC 메뉴/물리 집계용.
  //  - vcenterFirst(호스트=vCenter 추정): vCenter 호스트를 먼저 → 매칭된 Dell 호스트는 vCenter 값으로,
  //    iDRAC은 매칭 안 되는 '베어메탈'만 채운다. Overview/FinOps 등 메인 전력이 iDRAC을 호스트에 섞지 않게.
  if (vcenterFirst) { addVcenter(); addPhysical(); }
  else { addPhysical(); addVcenter(); }
  return out;
}

/**
 * vCenter 전력 수집 점검 — 스냅샷의 호스트별 vCenter 원본 전력(host.vcPowerWatts)을 vCenter별로
 * 집계해 '수집되고 있는지' 진단한다. host.vcPowerWatts는 하드웨어 상태 IPMI 'Pwr Consumption'
 * 센서(또는 power.power.average 폴백)에서 채워진다(null=미수집).
 * 행 state: collecting(수집됨) | zero(센서 0W) | nodata(전력 센서/카운터 없음) | empty(호스트 없음).
 */
export function vcenterPowerCheck(snap) {
  const byVc = new Map();
  for (const v of (snap?.vcenters || [])) {
    byVc.set(v.id, {
      vcenterId: v.id, name: v.name || v.id, region: v.location?.region || v.region || '',
      status: v.status || '', collectSource: v.collectSource || (v.collectMode === 'site' ? 'site' : 'direct'),
      hosts: 0, reporting: 0, zeroW: 0, noData: 0, watts: 0,
    });
  }
  for (const h of (snap?.hosts || [])) {
    const e = byVc.get(h.vcenterId);
    if (!e) continue;
    e.hosts++;
    const w = h.vcPowerWatts;
    if (w == null) e.noData++;
    else if (w > 0) { e.reporting++; e.watts += w; }
    else e.zeroW++;
  }
  const rows = [...byVc.values()].map((e) => ({
    ...e, watts: Math.round(e.watts),
    state: e.hosts === 0 ? 'empty' : (e.reporting > 0 ? 'collecting' : (e.zeroW > 0 ? 'zero' : 'nodata')),
  })).sort((a, z) => z.watts - a.watts || z.reporting - a.reporting);
  const totals = rows.reduce((a, r) => ({ hosts: a.hosts + r.hosts, reporting: a.reporting + r.reporting, watts: a.watts + r.watts }), { hosts: 0, reporting: 0, watts: 0 });
  return { rows, totals };
}

/**
 * '전력 보고' 수가 등록 서버 수보다 많은 이유를 소스별로 정확히 분해한다.
 * allMeasuredPower()의 각 항목 source(idrac/ome/remote)별 집계 + OME 연결별 디바이스 수 +
 * 수집서버별 원격 호스트 수 + 각 소스가 현재 '등록'돼 있는지(=정상) 여부를 반환한다.
 * 이걸로 "916대가 OME 'X'에서 온다 / 원격 수집기 'Y'에서 온다"를 화면에서 바로 확인할 수 있다.
 * { total, bySource, registeredIdrac, ome:{...}, remote:{...} }.
 */
export async function measuredPowerBreakdown({ hosts = [] } = {}) {
  const measured = await allMeasuredPower({ hosts });
  const bySource = { idrac: 0, ome: 0, remote: 0, vcenter: 0 };
  for (const m of measured) { if (bySource[m.source] != null) bySource[m.source]++; }

  const reg = loadRegistry();
  const registeredOme = new Map(reg.filter((s) => s.type === 'ome').map((s) => [s.id, s]));
  const registeredIdrac = reg.filter((s) => s.type !== 'ome').length;

  // OME 연결별: 캐시에 들어있는 디바이스 수 + 전력 보고(watts!=null) 수 + 등록 여부.
  const omeByEntry = new Map(); // entryId -> { devices, measured }
  for (const { entryId, device } of allOmeDevices()) {
    const e = omeByEntry.get(entryId) || { devices: 0, measured: 0 };
    e.devices++; if (device.watts != null) e.measured++;
    omeByEntry.set(entryId, e);
  }
  const omeEntries = [...omeByEntry.entries()].map(([entryId, v]) => ({
    entryId, name: registeredOme.get(entryId)?.name || entryId,
    registered: registeredOme.has(entryId), devices: v.devices, measured: v.measured,
  })).sort((a, z) => z.measured - a.measured);

  // 수집서버별: 원격 호스트 수 + 등록 여부.
  const activeCollectors = new Map(loadCollectors().map((c) => [c.id, c]));
  const remoteByCol = new Map(); // collectorId -> hosts
  for (const [, r] of remotePowerByHost()) remoteByCol.set(r.collectorId, (remoteByCol.get(r.collectorId) || 0) + 1);
  const collectors = [...remoteByCol.entries()].map(([collectorId, hosts]) => ({
    collectorId, name: activeCollectors.get(collectorId)?.name || collectorId,
    registered: activeCollectors.has(collectorId), hosts,
    vcenterId: activeCollectors.get(collectorId)?.vcenterId || '', // 귀속 vCenter(미지정 시 미매핑)
  })).sort((a, z) => z.hosts - a.hosts);

  return {
    total: measured.length, bySource, registeredIdrac,
    ome: { entries: omeEntries, cachedEntries: omeByEntry.size, cachedDevices: allOmeDevices().length },
    remote: { collectors, hosts: remotePowerByHost().size },
  };
}

/**
 * 오류/고아 전력 데이터 정리 — '전력 보고' 수가 등록 서버 수보다 비정상적으로 많을 때 사용.
 * mode='stale'(기본): 등록 해제된 소스만 정리한다.
 *   (1) 제거된 OME의 디바이스 캐시, (2) 등록 해제된 수집서버가 남긴 원격 호스트(in-memory),
 *   (3) 현재 활성 소스(등록 iDRAC·활성 OME 디바이스·활성 원격 호스트)에 속하지 않는 전력 DB 행.
 *   활성(등록) 소스는 보존한다.
 * mode='all'(강제): 등록 여부와 무관하게 OME 디바이스 캐시 전체 + 원격 호스트 전체를 비우고,
 *   전력 DB에서 등록 iDRAC 외의 모든 행을 삭제한다. (등록된 OME/수집기가 있으면 다음 폴링에
 *   다시 채워질 수 있음 — 그 경우 출처가 '실데이터'라는 뜻이며, 영구 제거하려면 해당 OME/수집기
 *   등록을 삭제해야 한다.) Returns { mode, dbRemoved, omeCleared, remoteCleared, activeKept }.
 */
export async function purgeStalePower(opts = {}) {
  const mode = opts.mode === 'all' ? 'all' : 'stale';
  const reg = loadRegistry();
  const omeEntryIds = new Set(reg.filter((s) => s.type === 'ome').map((s) => s.id));
  const idracIds = new Set(reg.filter((s) => s.type !== 'ome').map((s) => s.id));
  // 1) OME 캐시 비우기, 2) 원격 호스트 비우기 — mode='all'이면 등록된 것도 모두 비운다.
  const omeCleared = clearOmeExcept(mode === 'all' ? new Set() : omeEntryIds);
  const activeCollectors = new Set(mode === 'all' ? [] : loadCollectors().map((c) => c.id));
  const remoteCleared = clearStaleRemote(activeCollectors);
  // 3) 전력 DB에서 보존 대상이 아닌 server_id 삭제.
  const active = new Set(idracIds); // 등록 iDRAC은 항상 보존
  if (mode !== 'all') {
    for (const { entryId, device } of allOmeDevices()) active.add(dbKey(entryId, device)); // 잔여 활성 OME 디바이스 키
    for (const host of remotePowerByHost().keys()) active.add(`rmt:${host}`);               // 잔여 활성 원격 호스트 키
  }
  let dbRemoved = 0;
  try {
    const db = await getDb();
    if (db.serverIds && db.deleteServers) {
      const orphans = db.serverIds().filter((id) => !active.has(id));
      dbRemoved = db.deleteServers(orphans);
    }
  } catch { /* best effort */ }
  return { mode, dbRemoved, omeCleared, remoteCleared, activeKept: active.size };
}

/**
 * 전력 대시보드용 집계 — 플릿 현재/피크/평균(지정 시간), 시간대별 추세(시간 버킷), 서버별
 * 24h 피크/평균/최소·마지막관측·유휴 플래그, vCenter별 현재 전력 롤업. measured=allMeasuredPower() 결과.
 */
export async function buildPowerDashboard(measured, { hours = 24 } = {}) {
  const db = await getDb();
  const IDLE_W = Number(process.env.IDLE_WATT_THRESHOLD) || 100; // 평균<이 값 → '유휴 의심'
  const win = Math.max(1, Math.min(720, Number(hours) || 24));
  const since = Date.now() - win * 3_600_000;
  const stats = db.statsSince ? db.statsSince(since) : new Map();
  const buckets = db.bucketsSince ? db.bucketsSince(since, 3_600_000) : [];

  const perServer = measured.map((m) => {
    const st = stats.get(m.serverId) || {};
    const avg = st.avg ?? null;
    return {
      serverId: m.serverId, name: m.serverName, source: m.source, vcenterId: m.vcenterId || '',
      model: m.model || '', currentW: m.watts, ts: m.ts,
      peakW: st.peak ?? null, avgW: avg, minW: st.min ?? null, lastSeen: st.last ?? m.ts,
      idle: avg != null && avg < IDLE_W,
    };
  });

  // 플릿 시간 추세 — 버킷별로 각 서버 평균을 합산(누락 버킷은 직전값 forward-fill). O(서버×버킷).
  const bMap = new Map(); const bucketTimes = new Set();
  for (const b of buckets) {
    bucketTimes.add(b.bucket);
    if (!bMap.has(b.serverId)) bMap.set(b.serverId, new Map());
    bMap.get(b.serverId).set(b.bucket, b.avg);
  }
  const times = [...bucketTimes].sort((a, z) => a - z);
  const arrs = [];
  for (const [, m] of bMap) { let last = null; const arr = new Array(times.length); for (let i = 0; i < times.length; i++) { const v = m.get(times[i]); if (v != null) last = v; arr[i] = last; } arrs.push(arr); }
  const timeline = times.map((t, i) => { let tot = 0; for (const arr of arrs) { if (arr[i] != null) tot += arr[i]; } return { t, totalW: Math.round(tot) }; });
  const peakW = timeline.length ? timeline.reduce((mx, p) => Math.max(mx, p.totalW), 0) : null;
  const avgW = timeline.length ? Math.round(timeline.reduce((a, p) => a + p.totalW, 0) / timeline.length) : null;
  const currentW = measured.reduce((a, m) => a + (m.watts || 0), 0);

  const byVc = new Map();
  for (const m of measured) { const k = m.vcenterId || ''; const e = byVc.get(k) || { vcenterId: k, watts: 0, servers: 0 }; e.watts += (m.watts || 0); e.servers++; byVc.set(k, e); }
  const byVcenter = [...byVc.values()].sort((a, z) => z.watts - a.watts);

  return { windowHours: win, currentW, peakW, avgW, measured: measured.length, idleCount: perServer.filter((p) => p.idle).length, perServer, timeline, byVcenter };
}

/**
 * 서비스태그(정규화) → 최신 전력 샘플. ESXi 호스트의 서비스태그와 대조해, 호스트명이 달라도
 * Dell 서버 전력을 호스트에 귀속할 수 있게 한다(이름 매칭 실패 보완).
 * Map<serviceTagLower, { watts, ts, serverName }>.
 */
export async function latestPowerByServiceTag() {
  const out = new Map();
  for (const m of await allMeasuredPower()) {
    const t = norm(m.serviceTag);
    if (!t) continue;
    const cur = out.get(t);
    if (!cur || (m.ts || 0) > (cur.ts || 0)) out.set(t, { watts: m.watts, ts: m.ts, serverName: m.serverName });
  }
  return out;
}

/** Detailed power for one host: current reading + history series + server info. */
export async function hostPower(hostName, { hours = 24, limit = 1000 } = {}) {
  const db = await getDb();
  const since = Date.now() - hours * 3600_000;

  // 1) iDRAC-direct
  const server = findServerForHost(hostName);
  if (server) {
    const latest = db.latest(server.id);
    return {
      matched: true,
      source: 'idrac',
      server: { id: server.id, name: server.name, host: server.host, serviceTag: server.serviceTag, enabled: server.enabled },
      current: latest ? { watts: latest.watts, ts: latest.ts } : null,
      history: db.history(server.id, since, limit),
      info: getInventory(server.id),
    };
  }

  // 2) OME-discovered device
  const ome = findOmeDeviceForHost(hostName);
  if (ome) {
    const key = dbKey(ome.entryId, ome.device);
    const latest = db.latest(key) || (ome.device.watts != null ? { watts: ome.device.watts, ts: Date.now() } : null);
    return {
      matched: true,
      source: 'ome',
      server: { id: key, name: ome.device.name, host: '(via OME)', serviceTag: ome.device.serviceTag, model: ome.device.model, enabled: true },
      current: latest ? { watts: latest.watts, ts: latest.ts } : null,
      history: db.history(key, since, limit),
      // OME devices expose basic identity; full Redfish inventory is iDRAC-only.
      info: { system: { model: ome.device.model, serviceTag: ome.device.serviceTag, powerState: ome.device.powerState } },
    };
  }

  // 3) remote collector agent (another datacenter)
  const r = remotePowerByHost().get(norm(hostName));
  if (r) {
    return {
      matched: true,
      source: 'remote',
      server: { id: `remote:${r.collectorId}`, name: r.serverName || hostName, host: `(수집서버 ${r.datacenter || r.collectorId})`, datacenter: r.datacenter, enabled: true },
      current: r.watts != null ? { watts: r.watts, ts: r.ts } : null,
      history: db.history(`rmt:${norm(hostName)}`, since, limit),
    };
  }

  return { matched: false };
}
