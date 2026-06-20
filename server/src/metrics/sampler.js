/**
 * Metrics sampler — on an interval, snapshots host temperature (per host +
 * per-cluster/per-vCenter averages), datastore used GB, and GPU utilization
 * into the time-series DB. Enables 5-year history (온도) and capacity forecast.
 * Failures are isolated; sampling never blocks the event loop meaningfully.
 */

import { config } from '../config.js';
import { store } from './../store.js';
import { getMetricsDb } from './db.js';

let timer = null;
let lastRun = null;

const avg = (arr) => (arr.length ? arr.reduce((a, x) => a + x, 0) / arr.length : null);

async function sampleOnce() {
  const snap = store.get();
  const db = await getMetricsDb();
  const ts = Date.now();
  const rows = [];

  // Host temperature (only hosts that report a sensor reading).
  const hostsWithTemp = (snap.hosts || []).filter((h) => h.tempC != null);
  const byCluster = new Map();
  const byVc = new Map();
  for (const h of hostsWithTemp) {
    rows.push({ metric: 'temp_host', k: h.id, v: h.tempC });
    const ck = `${h.vcenterId}|${h.cluster || 'standalone'}`;
    (byCluster.get(ck) || byCluster.set(ck, []).get(ck)).push(h.tempC);
    (byVc.get(h.vcenterId) || byVc.set(h.vcenterId, []).get(h.vcenterId)).push(h.tempC);
  }
  for (const [k, arr] of byCluster) rows.push({ metric: 'temp_cluster', k, v: round1(avg(arr)) });
  for (const [k, arr] of byVc) rows.push({ metric: 'temp_vc', k, v: round1(avg(arr)) });

  // Datastore used GB (for capacity forecast).
  for (const d of snap.datastores || []) if (d.usedGB != null) rows.push({ metric: 'ds_usedgb', k: d.id, v: d.usedGB });

  // GPU utilization (only hosts reporting it).
  for (const h of snap.hosts || []) if (h.gpuUtilPct != null) rows.push({ metric: 'gpu_util', k: h.id, v: h.gpuUtilPct });

  if (rows.length) { try { db.insertMany(rows, ts); } catch (e) { console.warn('[metrics] insert 실패:', e.message); } }

  // Retention prune.
  if (config.temp.retentionDays > 0) { try { db.prune(ts - config.temp.retentionDays * 86_400_000); } catch { /* */ } }
  lastRun = { at: ts, rows: rows.length, hostsWithTemp: hostsWithTemp.length };
}

const round1 = (x) => (x == null ? null : Number(x.toFixed(1)));

export function metricsSamplerStatus() { return { intervalMs: config.temp.sampleIntervalMs, retentionDays: config.temp.retentionDays, lastRun }; }

export function startMetricsSampler() {
  setTimeout(() => sampleOnce().catch((e) => console.error('[metrics] sample 실패:', e.message)), 12_000).unref?.();
  timer = setInterval(() => sampleOnce().catch(() => {}), config.temp.sampleIntervalMs);
  timer.unref?.();
  console.log(`[metrics] sampler started (every ${Math.round(config.temp.sampleIntervalMs / 1000)}s, retention ${config.temp.retentionDays}d)`);
}
