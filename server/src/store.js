import { config, loadVcenterConfig } from './config.js';
import { generateSnapshot } from './mock/generator.js';
import { collectFromVCenter } from './vcenter/restClient.js';
import { describeError } from './util/errors.js';
import { latestPowerByHostName } from './idrac/service.js';
import { applyMutes } from './alarm-mutes.js';
import { getDataSource } from './runtime-settings.js';
import { buildIpamRows } from './ipam/ledger.js';
import { syncLedger } from './ipam/db.js';
import { getInventory, pruneInventory } from './central/inventory.js';

// 사이트 위임 vCenter가 이 시간 이상 push가 없으면 'stale'로 표시(데이터는 계속 서빙).
const SITE_STALE_MS = Number(process.env.SITE_INVENTORY_STALE_MS) || 300_000;

/**
 * Overlay real iDRAC power (Watts) onto hosts by matching the ESXi host name to
 * a registered Dell server. When matched, the measured value takes precedence
 * over any mock/SOAP estimate and is flagged with powerSource='idrac'.
 */
async function overlayIdracPower(snap) {
  try {
    const byName = await latestPowerByHostName();
    if (!byName.size) return snap;
    for (const h of snap.hosts) {
      const m = byName.get(String(h.name || '').trim().toLowerCase());
      if (m) { h.powerWatts = m.watts; h.powerSource = 'idrac'; }
    }
  } catch { /* power overlay is best-effort */ }
  return snap;
}

/** Drop alarms matching user-defined mute rules ("ignore this kind"). */
function applyAlarmMutes(snap) {
  try { snap.alarms = applyMutes(snap.alarms); } catch { /* best effort */ }
  return snap;
}

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
    this.vcCache = new Map(); // vcId -> { ok, data } | { ok:false, vc, err, at }
    this.vcLast = new Map();  // vcId -> last collection attempt (ms)
  }

  async refresh() {
    try {
      const dataSource = getDataSource();
      if (dataSource === 'mock') {
        this.snapshot = withRollups(applyAlarmMutes(await overlayIdracPower(generateSnapshot())));
        this.syncLedger();
        return;
      }

      const { vcenters } = loadVcenterConfig();
      const now = Date.now();
      const globalMs = config.pollIntervalMs;

      // Collect only the vCenters whose own interval has elapsed (or never
      // collected). High-RTT sites can use a longer pollIntervalSec so they
      // don't get re-polled every base tick; disabled ones are skipped.
      const due = vcenters.filter((vc) => {
        if (vc.enabled === false) return false;
        if (vc.collectMode === 'site') return false; // 사이트 위임: 중앙은 직접 폴링하지 않음
        const last = this.vcLast.get(vc.id) || 0;
        const intervalMs = vc.pollIntervalSec > 0 ? vc.pollIntervalSec * 1000 : globalMs;
        return now - last >= intervalMs - 500;
      });
      const results = await Promise.allSettled(due.map((vc) => collectFromVCenter(vc)));
      results.forEach((r, i) => {
        const vc = due[i];
        this.vcLast.set(vc.id, Date.now());
        if (r.status === 'fulfilled') {
          this.vcCache.set(vc.id, { ok: true, data: r.value });
        } else {
          const d = describeError(r.reason);
          console.error(`[collect] ${vc.id} (${vc.name}) 연결 실패: ${d.message}${d.hint ? ` — ${d.hint}` : ''}`);
          this.vcCache.set(vc.id, { ok: false, vc, err: d, at: Date.now() });
        }
      });
      // Drop cache entries for vCenters that were removed from the registry.
      const ids = new Set(vcenters.map((v) => v.id));
      for (const id of [...this.vcCache.keys()]) if (!ids.has(id)) this.vcCache.delete(id);
      pruneInventory(ids); // 위임 인벤토리 캐시도 동기화

      // Rebuild the merged snapshot from cache every tick (cheap), so non-due
      // vCenters keep serving their last-known data instead of disappearing.
      const merged = emptySnapshot();
      merged.source = dataSource;
      // auto 모드 폴백: 도달 불가 vCenter가 실제로 생겼을 때만 목 데이터를 1회 생성(지연).
      const isAuto = dataSource === 'auto';
      let mockSnap = null;
      const getMock = () => (mockSnap ||= generateSnapshot());
      for (const vc of vcenters) {
        if (vc.enabled === false) {
          merged.vcenters.push({ id: vc.id, name: vc.name, location: vc.location, status: 'disabled' });
          continue;
        }
        // 사이트 위임 vCenter: 현장 서버가 push한 인벤토리를 병합(중앙 폴링 없음).
        if (vc.collectMode === 'site') {
          const inv = getInventory(vc.id);
          if (inv?.data?.vcenter) {
            const s = inv.data;
            const stale = Date.now() - inv.at > SITE_STALE_MS;
            merged.vcenters.push({ ...s.vcenter, collectSource: 'site', collectedBy: inv.agent, receivedAt: inv.at, stale });
            merged.hosts.push(...(s.hosts || []));
            merged.vms.push(...(s.vms || []));
            merged.datastores.push(...(s.datastores || []));
            merged.networks.push(...(s.networks || []));
            merged.alarms.push(...(s.alarms || []));
          } else {
            merged.vcenters.push({ id: vc.id, name: vc.name, location: vc.location, status: 'pending', collectSource: 'site', note: '사이트 에이전트 수집 대기' });
          }
          continue;
        }
        const c = this.vcCache.get(vc.id);
        if (c?.ok) {
          const s = c.data;
          merged.vcenters.push(s.vcenter);
          merged.hosts.push(...s.hosts);
          merged.vms.push(...s.vms);
          merged.datastores.push(...s.datastores);
          merged.networks.push(...s.networks);
          merged.alarms.push(...s.alarms);
        } else if (c && !c.ok) {
          merged.collectionErrors.push({ vcenterId: vc.id, name: vc.name, ...c.err, at: c.at, fallback: isAuto });
          if (isAuto) pushSite(merged, getMock(), vc.id);
          else merged.vcenters.push({ id: vc.id, name: vc.name, location: vc.location, status: 'unreachable', error: c.err.message, hint: c.err.hint, code: c.err.code });
        } else {
          merged.vcenters.push({ id: vc.id, name: vc.name, location: vc.location, status: 'pending' });
        }
      }

      merged.generatedAt = new Date().toISOString();
      this.snapshot = withRollups(applyAlarmMutes(await overlayIdracPower(merged)));
      this.syncLedger();
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      console.error('[store] refresh failed:', err.message);
    }
  }

  // Export the current IP inventory to the shareable SQLite ledger (best-effort,
  // non-blocking) so other programs can read CONFIG_DIR/ipam.db.
  syncLedger() {
    try { syncLedger(buildIpamRows(this.snapshot).rows); } catch { /* best effort */ }
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
    source: getDataSource(),
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

  // byKey('vcenter')는 호스트/VM/DS 전체를 재순회하므로 vCenter 수만큼 호출하면 O(N²).
  // 한 번만 계산해 Map으로 조회한다.
  const vcRollup = byKey('vcenter');
  const vcMetrics = new Map(vcRollup.map((x) => [x.key, x]));
  const sites = snap.vcenters.map((vc) => ({ ...vc, metrics: vcMetrics.get(vc.id) }));

  snap.rollups = { global, byRegion: byKey('region'), sites };
  return snap;
}

const round = (v, d) => Number(v.toFixed(d));
const pct = (used, total) => (total > 0 ? Math.round((used / total) * 100) : 0);

export const store = new Store();
