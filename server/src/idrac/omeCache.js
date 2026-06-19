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
