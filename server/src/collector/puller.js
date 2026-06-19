/**
 * Central-portal puller: periodically fetch each registered collector agent's
 * /api/collector/export and merge its host→power into shared state. Per-host
 * samples are also written to the local DB (key rmt:<host>) so the host detail
 * popup can show merged history. Failures are isolated per collector.
 */

import { config } from '../config.js';
import { loadCollectors } from './registry.js';
import { setRemoteHost, clearCollectorHosts, setCollectorStatus } from './state.js';
import { getDb } from '../idrac/db.js';
import { describeError } from '../util/errors.js';

let timer = null;

async function pullOne(c) {
  const res = await fetch(`${c.url}/api/collector/export`, {
    headers: { Accept: 'application/json', ...(c.token ? { 'X-Collector-Token': c.token } : {}) },
    signal: AbortSignal.timeout(config.collector.timeoutMs),
  });
  if (res.status === 401 || res.status === 403) throw new Error('수집 서버 토큰 불일치(인증 실패)');
  if (!res.ok) throw new Error(`export -> ${res.status} ${res.statusText}`);
  const data = await res.json();
  const db = await getDb();
  const ts = Date.now();
  clearCollectorHosts(c.id);
  let hosts = 0;
  for (const h of data?.power?.byHost || []) {
    const host = String(h.host || '').trim().toLowerCase();
    if (!host || h.watts == null) continue;
    const sample = { watts: h.watts, ts: h.ts || ts, datacenter: data.datacenter || c.datacenter, collectorId: c.id, serverName: h.serverName, source: 'remote' };
    setRemoteHost(host, sample);
    db.insert(`rmt:${host}`, h.watts, h.ts || ts);
    hosts++;
  }
  return { hosts, version: data.version, datacenter: data.datacenter || c.datacenter };
}

export async function pullNow() {
  const collectors = loadCollectors().filter((c) => c.enabled !== false && c.url);
  await Promise.all(collectors.map(async (c) => {
    try {
      const r = await pullOne(c);
      setCollectorStatus(c.id, { ok: true, hosts: r.hosts, version: r.version, datacenter: r.datacenter, error: null });
    } catch (err) {
      const d = describeError(err);
      setCollectorStatus(c.id, { ok: false, error: d.message });
      console.warn(`[collector] ${c.id} pull 실패: ${d.message}`);
    }
  }));
}

export function startCollectorPuller() {
  if (config.collector.pullIntervalMs <= 0) { console.log('[collector] puller disabled'); return; }
  setTimeout(() => pullNow(), 5_000).unref?.();
  timer = setInterval(() => pullNow(), config.collector.pullIntervalMs);
  timer.unref?.();
  console.log(`[collector] puller started (every ${Math.round(config.collector.pullIntervalMs / 1000)}s)`);
}
