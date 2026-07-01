/**
 * In-memory NSX aggregator + poller. Mirrors the vCenter store design: each
 * NSX Manager is polled in parallel with a per-manager timeout so one slow/
 * high-RTT site (폴란드/미국동부 800ms+) never stalls the rest. The API reads
 * only from the cached snapshot, never blocking on a live call.
 */

import { config } from '../config.js';
import { getDataSource } from '../runtime-settings.js';
import { describeError } from '../util/errors.js';
import { loadRegistry } from './registry.js';
import { collectFromNsx } from './client.js';
import { generateNsxSnapshot, generateNsxForManager } from './mock.js';

class NsxStore {
  constructor() {
    this.snapshot = empty();
    this.cache = new Map();   // managerId -> { ok, data } | { ok:false, mgr, err, at }
    this.last = new Map();    // managerId -> last attempt (ms)
    this.timer = null;
  }

  async refresh() {
    if (this._refreshing) return; // 재진입 방지(이전 폴 진행 중이면 이번 틱 건너뜀)
    this._refreshing = true;
    try {
      return await this._refreshInner();
    } finally {
      this._refreshing = false;
    }
  }

  async _refreshInner() {
    const dataSource = getDataSource();
    const managers = loadRegistry();

    // Mock mode (or no managers registered yet) → synthesize a snapshot so the
    // dashboard is populated without a real NSX Manager.
    if (dataSource === 'mock' || managers.length === 0) {
      this.snapshot = rollup(merge(generateNsxSnapshot(managers), [], dataSource));
      return;
    }

    const now = Date.now();
    const globalMs = config.pollIntervalMs;
    const due = managers.filter((m) => {
      if (m.enabled === false) return false;
      const last = this.last.get(m.id) || 0;
      const intervalMs = m.pollIntervalSec > 0 ? m.pollIntervalSec * 1000 : globalMs;
      return now - last >= intervalMs - 500;
    });
    const results = await Promise.allSettled(due.map((m) => collectFromNsx(m)));
    results.forEach((r, i) => {
      const m = due[i];
      this.last.set(m.id, Date.now());
      if (r.status === 'fulfilled') this.cache.set(m.id, { ok: true, data: r.value });
      else {
        const d = describeError(r.reason);
        console.error(`[nsx] ${m.id} (${m.name}) 연결 실패: ${d.message}${d.hint ? ` — ${d.hint}` : ''}`);
        this.cache.set(m.id, { ok: false, mgr: m, err: d, at: Date.now() });
      }
    });
    const ids = new Set(managers.map((m) => m.id));
    for (const id of [...this.cache.keys()]) if (!ids.has(id)) this.cache.delete(id);

    const parts = [];
    const errors = [];
    const mockFallback = dataSource === 'auto';
    for (const m of managers) {
      if (m.enabled === false) { parts.push({ manager: disabledManager(m), gateways: [], segments: [], transportNodes: [], firewall: { policies: 0, rules: 0 }, groups: 0 }); continue; }
      const c = this.cache.get(m.id);
      if (c?.ok) parts.push(c.data);
      else if (c && !c.ok) {
        errors.push({ managerId: m.id, name: m.name, ...c.err, at: c.at, fallback: mockFallback });
        if (mockFallback) parts.push(generateNsxForManager(m));
        else parts.push({ manager: unreachableManager(m, c.err), gateways: [], segments: [], transportNodes: [], firewall: { policies: 0, rules: 0 }, groups: 0 });
      } else parts.push({ manager: pendingManager(m), gateways: [], segments: [], transportNodes: [], firewall: { policies: 0, rules: 0 }, groups: 0 });
    }
    this.snapshot = rollup(merge(parts, errors, dataSource));
  }

  start() {
    this.refresh().catch((e) => console.error('[nsx] refresh 실패:', e.message));
    this.timer = setInterval(() => this.refresh().catch(() => {}), config.pollIntervalMs);
    this.timer.unref?.();
  }

  get() { return this.snapshot; }
}

const disabledManager = (m) => ({ id: m.id, name: m.name, host: m.host, region: m.location?.region || '', vcenterId: m.vcenterId || '', status: 'disabled', version: '', nodeCount: 0 });
const pendingManager = (m) => ({ id: m.id, name: m.name, host: m.host, region: m.location?.region || '', vcenterId: m.vcenterId || '', status: 'pending', version: '', nodeCount: 0 });
const unreachableManager = (m, err) => ({ id: m.id, name: m.name, host: m.host, region: m.location?.region || '', vcenterId: m.vcenterId || '', status: 'unreachable', version: '', nodeCount: 0, error: err.message, hint: err.hint, code: err.code });

function empty() {
  return { generatedAt: new Date().toISOString(), source: getDataSource(), managers: [], gateways: [], segments: [], transportNodes: [], dfw: [], securityGroups: [], idsEvents: [], collectionErrors: [], rollup: null };
}

function merge(parts, errors, source) {
  const snap = empty();
  snap.source = source;
  snap.collectionErrors = errors;
  for (const p of parts) {
    snap.managers.push({ ...p.manager, gateways: p.gateways.length, segments: p.segments.length, transportNodes: p.transportNodes.length, firewall: p.firewall, groups: p.groups });
    snap.gateways.push(...p.gateways);
    snap.segments.push(...p.segments);
    snap.transportNodes.push(...p.transportNodes);
    snap.dfw.push(...(p.dfw || []));
    snap.securityGroups.push(...(p.securityGroups || []));
    snap.idsEvents.push(...(p.ids?.events || []));
  }
  snap.generatedAt = new Date().toISOString();
  return snap;
}

function rollup(snap) {
  const g = snap.gateways, tn = snap.transportNodes;
  snap.rollup = {
    managers: snap.managers.length,
    managersUp: snap.managers.filter((m) => m.status === 'connected').length,
    managersDegraded: snap.managers.filter((m) => m.status === 'degraded').length,
    t0: g.filter((x) => x.tier === 'T0').length,
    t1: g.filter((x) => x.tier === 'T1').length,
    segments: snap.segments.length,
    overlaySegments: snap.segments.filter((s) => s.type === 'OVERLAY').length,
    vlanSegments: snap.segments.filter((s) => s.type === 'VLAN').length,
    hostNodes: tn.filter((x) => x.type === 'host').length,
    edgeNodes: tn.filter((x) => x.type === 'edge').length,
    dfwPolicies: snap.managers.reduce((a, m) => a + (m.firewall?.policies || 0), 0),
    dfwRules: snap.managers.reduce((a, m) => a + (m.firewall?.rules || 0), 0),
    groups: snap.managers.reduce((a, m) => a + (m.groups || 0), 0),
  };
  return snap;
}

export const nsxStore = new NsxStore();

export function startNsxPoller() {
  nsxStore.start();
  console.log(`[nsx] poller started (every ${Math.round(config.pollIntervalMs / 1000)}s)`);
}
