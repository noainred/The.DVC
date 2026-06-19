import { config, loadVcenterConfig } from './config.js';
import { generateSnapshot } from './mock/generator.js';
import { collectFromVCenter } from './vcenter/restClient.js';
import { describeError } from './util/errors.js';

/**
 * In-memory aggregated store. Holds the most recent global snapshot and
 * refreshes it on an interval. The API reads exclusively from here so HTTP
 * requests never block on slow/unreachable vCenters.
 */
class Store {
  constructor() {
    this.snapshot = emptySnapshot();
    this.lastError = null;
    this.timer = null;
  }

  async refresh() {
    try {
      if (config.dataSource === 'mock') {
        this.snapshot = withRollups(generateSnapshot());
        return;
      }

      const { vcenters } = loadVcenterConfig();
      const results = await Promise.allSettled(vcenters.map((vc) => collectFromVCenter(vc)));

      const merged = emptySnapshot();
      merged.source = config.dataSource;
      const mockFallback = config.dataSource === 'auto' ? generateSnapshot() : null;

      results.forEach((r, i) => {
        const vc = vcenters[i];
        if (r.status === 'fulfilled') {
          const s = r.value;
          merged.vcenters.push(s.vcenter);
          merged.hosts.push(...s.hosts);
          merged.vms.push(...s.vms);
          merged.datastores.push(...s.datastores);
          merged.networks.push(...s.networks);
          merged.alarms.push(...s.alarms);
        } else {
          const d = describeError(r.reason);
          console.error(`[collect] ${vc.id} (${vc.name}) 연결 실패: ${d.message}${d.hint ? ` — ${d.hint}` : ''}`);
          merged.collectionErrors.push({ vcenterId: vc.id, name: vc.name, ...d, at: Date.now(), fallback: Boolean(mockFallback) });
          if (mockFallback) {
            // auto mode: substitute mock data for this site so the portal stays whole
            pushSite(merged, mockFallback, vc.id);
          } else {
            merged.vcenters.push({
              id: vc.id, name: vc.name, location: vc.location,
              status: 'unreachable', error: d.message, hint: d.hint, code: d.code,
            });
          }
        }
      });

      merged.generatedAt = new Date().toISOString();
      this.snapshot = withRollups(merged);
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      console.error('[store] refresh failed:', err.message);
    }
  }

  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), config.pollIntervalMs);
    this.timer.unref?.();
  }

  get() {
    return this.snapshot;
  }
}

function pushSite(target, source, vcId) {
  const vc = source.vcenters.find((v) => v.id === vcId);
  if (vc) target.vcenters.push(vc);
  target.hosts.push(...source.hosts.filter((h) => h.vcenterId === vcId));
  target.vms.push(...source.vms.filter((v) => v.vcenterId === vcId));
  target.datastores.push(...source.datastores.filter((d) => d.vcenterId === vcId));
  target.networks.push(...source.networks.filter((n) => n.vcenterId === vcId));
  target.alarms.push(...source.alarms.filter((a) => a.vcenterId === vcId));
}

function emptySnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    source: config.dataSource,
    vcenters: [], hosts: [], vms: [], datastores: [], networks: [], alarms: [],
    collectionErrors: [],
    rollups: null,
  };
}

/** Compute global / regional / per-vCenter rollups used by the dashboard. */
function withRollups(snap) {
  if (!snap.collectionErrors) snap.collectionErrors = [];
  const sum = (arr, fn) => arr.reduce((a, x) => a + (fn(x) || 0), 0);

  const cpuTotalMhz = sum(snap.hosts, (h) => h.cpuTotalMhz);
  const cpuUsedMhz = sum(snap.hosts, (h) => h.cpuUsageMhz);
  const memTotalMB = sum(snap.hosts, (h) => h.memTotalMB);
  const memUsedMB = sum(snap.hosts, (h) => h.memUsageMB);
  const storCapGB = sum(snap.datastores, (d) => d.capacityGB);
  const storUsedGB = sum(snap.datastores, (d) => d.usedGB);

  const global = {
    vcenters: snap.vcenters.length,
    vcentersConnected: snap.vcenters.filter((v) => v.status === 'connected').length,
    hosts: snap.hosts.length,
    hostsConnected: snap.hosts.filter((h) => h.connectionState === 'CONNECTED').length,
    hostsMaintenance: snap.hosts.filter((h) => h.connectionState === 'MAINTENANCE').length,
    hostsDisconnected: snap.hosts.filter((h) => h.connectionState === 'DISCONNECTED').length,
    vms: snap.vms.length,
    vmsPoweredOn: snap.vms.filter((v) => v.powerState === 'POWERED_ON').length,
    vmsPoweredOff: snap.vms.filter((v) => v.powerState !== 'POWERED_ON').length,
    cpuCores: sum(snap.hosts, (h) => h.cpuCores),
    cpuTotalGhz: round(cpuTotalMhz / 1000, 1),
    cpuUsedGhz: round(cpuUsedMhz / 1000, 1),
    cpuUsagePct: pct(cpuUsedMhz, cpuTotalMhz),
    memTotalGB: round(memTotalMB / 1024, 0),
    memUsedGB: round(memUsedMB / 1024, 0),
    memUsagePct: pct(memUsedMB, memTotalMB),
    storageTotalTB: round(storCapGB / 1024, 1),
    storageUsedTB: round(storUsedGB / 1024, 1),
    storageUsagePct: pct(storUsedGB, storCapGB),
    datastores: snap.datastores.length,
    networks: snap.networks.length,
    alarms: snap.alarms.length,
    alarmsCritical: snap.alarms.filter((a) => a.severity === 'critical').length,
    alarmsWarning: snap.alarms.filter((a) => a.severity === 'warning').length,
    powerWatts: sum(snap.hosts, (h) => h.powerWatts),
    powerKw: round(sum(snap.hosts, (h) => h.powerWatts) / 1000, 1),
    powerReporting: snap.hosts.filter((h) => h.powerWatts > 0).length,
  };

  const byKey = (key) => {
    const groups = new Map();
    for (const v of snap.vcenters) {
      const k = key === 'region' ? v.location?.region || 'Unknown' : v.id;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(v.id);
    }
    return [...groups.entries()].map(([k, ids]) => {
      const h = snap.hosts.filter((x) => ids.includes(x.vcenterId));
      const v = snap.vms.filter((x) => ids.includes(x.vcenterId));
      const d = snap.datastores.filter((x) => ids.includes(x.vcenterId));
      const a = snap.alarms.filter((x) => ids.includes(x.vcenterId));
      const cpuT = sum(h, (x) => x.cpuTotalMhz), cpuU = sum(h, (x) => x.cpuUsageMhz);
      const memT = sum(h, (x) => x.memTotalMB), memU = sum(h, (x) => x.memUsageMB);
      const stC = sum(d, (x) => x.capacityGB), stU = sum(d, (x) => x.usedGB);
      return {
        key: k,
        vcenters: ids.length,
        hosts: h.length,
        vms: v.length,
        vmsPoweredOn: v.filter((x) => x.powerState === 'POWERED_ON').length,
        cpuUsagePct: pct(cpuU, cpuT),
        memUsagePct: pct(memU, memT),
        storageUsagePct: pct(stU, stC),
        storageTotalTB: round(stC / 1024, 1),
        alarmsCritical: a.filter((x) => x.severity === 'critical').length,
        alarmsWarning: a.filter((x) => x.severity === 'warning').length,
        powerKw: round(sum(h, (x) => x.powerWatts) / 1000, 1),
      };
    });
  };

  const sites = snap.vcenters.map((vc) => {
    const r = byKey('vcenter').find((x) => x.key === vc.id);
    return { ...vc, metrics: r };
  });

  snap.rollups = { global, byRegion: byKey('region'), sites };
  return snap;
}

const round = (v, d) => Number(v.toFixed(d));
const pct = (used, total) => (total > 0 ? Math.round((used / total) * 100) : 0);

export const store = new Store();
