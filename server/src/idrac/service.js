/**
 * Glue between the iDRAC registry (which server maps to which ESXi host) and the
 * power-sample DB. Provides host-name → power lookups for the API and the
 * snapshot overlay.
 */

import { loadRegistry, matchKeys } from './registry.js';
import { getDb } from './db.js';
import { allOmeDevices, dbKey } from './omeCache.js';
import { getInventory } from './invCache.js';
import { remotePowerByHost } from '../collector/state.js';

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

  // iDRAC-direct entries: match by registry keys.
  for (const s of loadRegistry()) {
    if (s.type === 'ome') continue;
    const sample = latest.get(s.id);
    if (!sample) continue;
    for (const key of matchKeys(s)) {
      out.set(key, { watts: sample.watts, ts: sample.ts, serverId: s.id, serverName: s.name });
    }
  }

  // OME-discovered devices: match by serviceTag/name.
  for (const { entryId, at, device } of allOmeDevices()) {
    if (device.watts == null) continue;
    const sample = latest.get(dbKey(entryId, device)) || { watts: device.watts, ts: at };
    for (const k of [norm(device.serviceTag), norm(device.name)]) {
      if (k) out.set(k, { watts: sample.watts, ts: sample.ts, serverId: dbKey(entryId, device), serverName: device.name });
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
export async function allMeasuredPower() {
  const db = await getDb();
  const latest = db.latestAll(); // Map<serverId,{watts,ts}>
  const out = [];
  const seen = new Set();
  for (const s of loadRegistry()) {
    if (s.type === 'ome') continue;
    const sample = latest.get(s.id);
    if (!sample || sample.watts == null || !Number.isFinite(sample.watts)) continue;
    out.push({ serverId: s.id, serverName: s.name, watts: sample.watts, ts: sample.ts, host: norm(s.host || matchKeys(s)[0] || s.name), source: 'idrac' });
    seen.add(s.id);
  }
  for (const { entryId, at, device } of allOmeDevices()) {
    if (device.watts == null) continue;
    const key = dbKey(entryId, device);
    if (seen.has(key)) continue;
    const sample = latest.get(key) || { watts: device.watts, ts: at };
    if (sample.watts == null || !Number.isFinite(sample.watts)) continue;
    out.push({ serverId: key, serverName: device.name, watts: sample.watts, ts: sample.ts, host: norm(device.serviceTag || device.name), source: 'ome' });
    seen.add(key);
  }
  for (const [host, r] of remotePowerByHost()) {
    if (r.watts == null || !Number.isFinite(r.watts)) continue;
    const id = `remote:${r.collectorId}:${host}`;
    if (seen.has(id)) continue;
    out.push({ serverId: id, serverName: r.serverName || host, watts: r.watts, ts: r.ts, host: norm(host), source: 'remote' });
    seen.add(id);
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
