/**
 * In-memory cache of the devices most recently discovered from each OME server.
 * The poller writes it every cycle; the service layer reads it to resolve an
 * ESXi host name to a device's power. History is persisted in the sample DB
 * under the device key (see dbKey).
 */

const cache = new Map(); // entryId -> { at, usedMetricService, devices: [...] }

/** Stable DB/sample key for one OME device. */
export function dbKey(entryId, device) {
  return `ome:${entryId}:${device.serviceTag || device.name || device.id}`;
}

export function setOmeDevices(entryId, devices, meta = {}) {
  cache.set(entryId, { at: Date.now(), devices: devices || [], ...meta });
}

export function getOmeEntry(entryId) {
  return cache.get(entryId) || null;
}

/** Flattened [{ entryId, at, device }] across all OME servers. */
export function allOmeDevices() {
  const out = [];
  for (const [entryId, v] of cache) {
    for (const d of v.devices) out.push({ entryId, at: v.at, device: d });
  }
  return out;
}

/** 등록되지 않은(제거된) OME 항목의 캐시를 제거 — 전력 보고 수에 유령으로 잡히는 것 방지.
 *  activeEntryIds(Set)에 없는 entryId의 디바이스 캐시를 비운다. 제거된 디바이스 총수를 반환. */
export function clearOmeExcept(activeEntryIds) {
  let removed = 0;
  for (const [entryId, v] of [...cache]) {
    if (!activeEntryIds.has(entryId)) { removed += (v.devices || []).length; cache.delete(entryId); }
  }
  return removed;
}
