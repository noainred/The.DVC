/**
 * Portal-embedded iDRAC power poller. On an interval it reads current power
 * from every enabled registered Dell server (Redfish) and appends a sample to
 * the time-series DB. Runs inside the portal process; failures are isolated per
 * server so one unreachable iDRAC never stalls the rest.
 */

import { config } from '../config.js';
import { withJob } from '../perf/monitor.js'; // v2.498: 스톨 발생 시 '진행 중 작업' 표시(계측 전용)
import { loadRegistry } from './registry.js';
import { fetchPower, fetchInventory, fetchSensors } from './redfish.js';
import { pushSensorSample } from './sensorStore.js';
import { fetchOmeDevices } from './ome.js';
import { poolSettled } from '../util/pool.js'; // v2.579: 동시성 풀 단일 소스(예전 ome.eachLimited 와 같은 격리 의미)
import { setOmeDevices, dbKey } from './omeCache.js';
import { setInventory, inventoryStale } from './invCache.js';
import { getDb } from './db.js';
import { describeError } from '../util/errors.js';
import { isStopped } from '../security/emergencyStop.js';
import { isMockMode, mockIdracPollTick } from '../mock/seed.js';
import { onSnapshotRefreshed } from '../partfault/hooks.js'; // v2.548: 인벤토리 갱신 직후 파트 장애 판정/push 트리거

// Hardware inventory is largely static — refresh it at most every 30 minutes.
const INVENTORY_MAX_AGE_MS = 30 * 60_000;

let timer = null;
let lastRun = null; // { at, ok, failed, results: [{id, watts?, devices?, error?}] }
let running = false; // 재진입 방지(이전 폴이 끝나기 전 다음 틱이 겹쳐 도는 것 차단)
let pruneTick = 0; // retention prune 스로틀(10틱마다 1회)

async function pollOnce() {
  if (running) return; // 고RTT iDRAC 다수에서 한 주기가 간격을 넘겨 폴이 중첩되는 것 방지
  let invRefreshed = 0; // v2.548: 이번 폴에서 인벤토리를 갱신한 서버 수 → 0 이 아니면 파트 장애 훅
  running = true;
  try {
    return await withJob('idrac.poll', pollOnceInner);
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
  const registry = loadRegistry();
  const servers = registry.filter((s) => s.enabled !== false && s.host && s.username && s.password && !String(s.id).startsWith('mock-'));
  // v2.493: 폴 대상에서 제외된 서버를 **이유와 함께** 기록한다. 이전에는 조용히 빠져 lastRun 에
  // 흔적조차 없었다 — 비밀번호 미저장·비활성 서버가 '수집이 멈춘 것' 으로 오해되고, 화면·로그
  // 어디에도 구분 단서가 없었다(2026-09-12 신고 진단 중 확인).
  const skipReason = (s) => (!s.host ? '주소 없음'
    : !s.username ? '계정 없음'
      : !s.password ? '비밀번호 미저장'
        : s.enabled === false ? '비활성(사용 안 함)'
          : String(s.id).startsWith('mock-') ? 'mock 데모 잔존 항목' : '');
  // 필드명은 notPolled — 긴급중단 경로가 `skipped` 를 문자열로 쓰고 있어(위 isStopped 분기) 타입이 섞이면
  // 화면이 둘을 구분할 수 없다.
  const notPolled = registry.filter((s) => !servers.includes(s)).map((s) => ({ id: s.id, name: s.name, reason: skipReason(s) }));
  if (!servers.length) { lastRun = { at: Date.now(), ok: 0, failed: 0, results: [], notPolled }; return; }
  const db = await getDb();
  const ts = Date.now();
  const results = [];
  const samples = []; // 전력 샘플을 모아 폴 종료 후 단일 트랜잭션으로 적재(서버 수만큼 fsync 방지).
  // 동시성 상한 — 무제한 Promise.all은 수백 대에 동시 TLS를 열어 CPU 스파이크/소켓 고갈.
  await poolSettled(servers, config.idrac.pollConcurrency, async (s) => {
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
        // v2.493: 전력 조회 실패가 **센서·인벤토리 수집을 막지 않게** 개별로 격리한다.
        // 이전에는 fetchPower 가 던지면 이 블록 전체가 catch 로 빠져 온도·CPU 가 통째로 0샘플이
        // 됐다(전력 메트릭만 막힌 iDRAC·라이선스 차이에서 발생 가능). 온도 수집이 전력 수집에
        // 종속될 이유는 없다. 실패 사유는 results 에 남겨 '지금 폴' 응답에서 보이게 한다.
        let powerErr = null;
        const r = await fetchPower(s).catch((e) => { powerErr = e; return null; });
        if (r && r.watts != null) samples.push({ serverId: s.id, watts: r.watts, ts });
        // 온도센서 + CPU 사용량을 매 주기(1분) 수집해 시계열에 적재(차트용, 격리).
        // 시계열에는 팬을 {name,rpm}만 싣는다 — 파트 필드(model/partNumber)는 정적 정보라
        // 1440샘플 시계열에 반복 저장하면 메모리만 낭비(인벤토리 갱신 시에만 보관).
        let sensorFans = null;
        let sensorErr = null;
        try {
          const sn = await fetchSensors(s);
          sensorFans = sn.fans;
          pushSensorSample(s.id, { t: ts, cpuUsagePct: sn.cpuUsagePct, temps: sn.temps, fans: (sn.fans || []).map((f) => ({ name: f.name, rpm: f.rpm })) });
        } catch (e) {
          // v2.493: 조용히 삼키지 않는다 — 센서만 실패하는 상황(Thermal 미지원 등)을 진단할 수
          // 있게 사유를 results 에 남긴다(전력 수집과는 무관하게 계속 진행).
          sensorErr = e;
        }
        // Refresh rich inventory on a slow cadence (best-effort, non-blocking).
        if (inventoryStale(s.id, INVENTORY_MAX_AGE_MS)) {
          try {
            const inv = await fetchInventory(s);
            // 팬 파트 정보 — Thermal 은 fetchSensors 가 방금 받았으므로 재호출 없이 이관(추가 HTTP 0회).
            if (sensorFans?.length) inv.fans = sensorFans.map(({ name, model, partNumber, manufacturer, health, redundant }) => ({ name, model, partNumber, manufacturer, health, redundant }));
            // v2.548 F1: 팬은 Thermal 경로라 fetchInventory 의 컬렉션 메타에 없다 — 여기서 찍는다.
            if (inv.collections && typeof inv.collections === 'object') inv.collections.fans = sensorFans?.length ? 'ok' : (sensorErr ? 'failed' : 'ok');
            setInventory(s.id, inv);
            invRefreshed += 1;
          } catch { /* keep last */ }
        }
        results.push({
          id: s.id, name: s.name, type: 'idrac', watts: r ? r.watts : null,
          ...(powerErr ? { error: describeError(powerErr).message } : {}),
          ...(sensorErr ? { sensorError: describeError(sensorErr).message } : {}),
        });
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
    try {
      // v2.451: 원본은 rawRetentionDays(설정 시), 롤업은 retentionDays. 0 이면 기존과 동일.
      const keep = config.idrac.retentionDays;
      const raw = config.idrac.rawRetentionDays > 0 ? Math.min(config.idrac.rawRetentionDays, keep) : keep;
      await db.prune(ts - raw * 86_400_000, ts - keep * 86_400_000);
    } catch (e) { console.warn(`[idrac] prune 실패: ${e.message}`); }
  }
  const failed = results.filter((r) => r.error).length;
  lastRun = { at: ts, ok: results.length - failed, failed, results, notPolled };
  if (failed) console.warn(`[idrac] poll: ${results.length - failed}/${results.length} 성공`);
  // v2.548 F7: 인벤토리가 하나라도 갱신됐으면 파트 장애 판정(중앙)/push(엣지)를 즉시 트리거한다 —
  //   탐지 지연을 '인벤토리 주기 + 몇 초' 로 줄인다(v2.547 은 최대 ~50분). 디바운스는 훅이 한다.
  if (invRefreshed > 0) { try { onSnapshotRefreshed('idrac'); } catch { /* 훅 실패가 폴을 막지 않는다 */ } }
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
