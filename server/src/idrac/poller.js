/**
 * Portal-embedded iDRAC power poller. On an interval it reads current power
 * from every enabled registered Dell server (Redfish) and appends a sample to
 * the time-series DB. Runs inside the portal process; failures are isolated per
 * server so one unreachable iDRAC never stalls the rest.
 */

import { config } from '../config.js';
import { loadRegistry } from './registry.js';
import { fetchPower, fetchInventory, fetchSensors } from './redfish.js';
import { pushSensorSample } from './sensorStore.js';
import { fetchOmeDevices, eachLimited } from './ome.js';
import { setOmeDevices, dbKey } from './omeCache.js';
import { setInventory, inventoryStale } from './invCache.js';
import { getDb } from './db.js';
import { describeError } from '../util/errors.js';
import { isStopped } from '../security/emergencyStop.js';
import { isMockMode, mockIdracPollTick } from '../mock/seed.js';

// Hardware inventory is largely static — refresh it at most every 30 minutes.
const INVENTORY_MAX_AGE_MS = 30 * 60_000;

let timer = null;
let lastRun = null; // { at, ok, failed, results: [{id, watts?, devices?, error?}] }
let running = false; // 재진입 방지(이전 폴이 끝나기 전 다음 틱이 겹쳐 도는 것 차단)
let pruneTick = 0; // retention prune 스로틀(10틱마다 1회)

async function pollOnce() {
  if (running) return; // 고RTT iDRAC 다수에서 한 주기가 간격을 넘겨 폴이 중첩되는 것 방지
  running = true;
  try {
    return await pollOnceInner();
  } finally {
    running = false;
  }
}

async function pollOnceInner() {
  if (isStopped()) { lastRun = { at: Date.now(), ok: 0, failed: 0, skipped: '긴급중단', results: [] }; return; }
  // mock 데모: 실제 Redfish 폴 대신 합성 전력 샘플 적재(전력 화면이 비지 않게). live/auto엔 무영향.
  if (isMockMode()) {
    try { const { store } = await import('../store.js'); const r = await mockIdracPollTick(store.get?.()); lastRun = { at: Date.now(), ok: r?.measured || 0, failed: 0, mock: true, results: [] }; } catch { /* */ }
    return;
  }
  // live/auto: mock 데모 잔존 항목(id 'mock-')은 실제 폴 대상에서 제외(가짜 주소 폴 잡음 방지).
  const servers = loadRegistry().filter((s) => s.enabled !== false && s.host && s.username && s.password && !String(s.id).startsWith('mock-'));
  if (!servers.length) { lastRun = { at: Date.now(), ok: 0, failed: 0, results: [] }; return; }
  const db = await getDb();
  const ts = Date.now();
  const results = [];
  const samples = []; // 전력 샘플을 모아 폴 종료 후 단일 트랜잭션으로 적재(서버 수만큼 fsync 방지).
  // 동시성 상한 — 무제한 Promise.all은 수백 대에 동시 TLS를 열어 CPU 스파이크/소켓 고갈.
  await eachLimited(servers, config.idrac.pollConcurrency, async (s) => {
    try {
      if (s.type === 'ome') {
        // One OME -> many devices. Persist a sample per device + cache for lookups.
        const { devices, usedMetricService, count } = await fetchOmeDevices(s);
        let measured = 0;
        for (const d of devices) {
          if (d.watts != null) { samples.push({ serverId: dbKey(s.id, d), watts: d.watts, ts }); measured++; }
        }
        setOmeDevices(s.id, devices, { usedMetricService });
        results.push({ id: s.id, name: s.name, type: 'ome', devices: count, measured, metric: usedMetricService ? 'powermanager' : 'inventory' });
      } else {
        const r = await fetchPower(s);
        samples.push({ serverId: s.id, watts: r.watts, ts });
        // 온도센서 + CPU 사용량을 매 주기(1분) 수집해 시계열에 적재(차트용, 격리).
        try { const sn = await fetchSensors(s); pushSensorSample(s.id, { t: ts, cpuUsagePct: sn.cpuUsagePct, temps: sn.temps, fans: sn.fans }); } catch { /* 센서 실패는 전력 수집과 무관 */ }
        // Refresh rich inventory on a slow cadence (best-effort, non-blocking).
        if (inventoryStale(s.id, INVENTORY_MAX_AGE_MS)) {
          try { setInventory(s.id, await fetchInventory(s)); } catch { /* keep last */ }
        }
        results.push({ id: s.id, name: s.name, type: 'idrac', watts: r.watts });
      }
    } catch (err) {
      const d = describeError(err);
      results.push({ id: s.id, name: s.name, type: s.type || 'idrac', error: d.message });
    }
  });
  // 모든 서버 폴 후 한 트랜잭션으로 배치 적재(insertMany 없으면 개별 insert 폴백).
  try { if (db.insertMany) db.insertMany(samples); else for (const sm of samples) db.insert(sm.serverId, sm.watts, sm.ts); }
  catch (e) { console.warn('[idrac] 전력 적재 실패:', e.message); }
  // Retention pruning — 매 폴 DELETE 스캔 금지(store.js/metrics 샘플러와 동일 스로틀 패턴).
  if (config.idrac.retentionDays > 0 && (++pruneTick % 10 === 0)) {
    try { db.prune(ts - config.idrac.retentionDays * 86_400_000); } catch { /* best effort */ }
  }
  const failed = results.filter((r) => r.error).length;
  lastRun = { at: ts, ok: results.length - failed, failed, results };
  if (failed) console.warn(`[idrac] poll: ${results.length - failed}/${results.length} 성공`);
}

export function getPollerStatus() {
  return {
    enabled: config.idrac.enabled,
    intervalMs: config.idrac.pollIntervalMs,
    servers: loadRegistry().length,
    lastRun,
  };
}

/** Trigger an immediate poll (e.g. right after a registry change). */
export async function pollNow() {
  try { await pollOnce(); } catch (err) { console.error('[idrac] pollNow 실패:', err.message); }
  return lastRun;
}

export function startIdracPoller() {
  if (!config.idrac.enabled) { console.log('[idrac] poller disabled (IDRAC_ENABLED=false)'); return; }
  // initial run shortly after boot, then on the configured interval
  setTimeout(() => pollNow(), 3_000).unref?.();
  timer = setInterval(() => pollNow(), config.idrac.pollIntervalMs);
  timer.unref?.();
  console.log(`[idrac] poller started (every ${Math.round(config.idrac.pollIntervalMs / 1000)}s)`);
}
