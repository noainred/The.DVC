/**
 * Capacity Advisor 샘플러 — 운영 중인 포탈 프로세스 안에서 30초마다 자기 호스트를 실측한다
 * (별도 벤치마크 프로세스 없음 — '운영 부하 그대로'가 측정 대상이다).
 *
 * 규약(CLAUDE.md 회귀 방지):
 *  - 재진입 가드: 이전 주기가 진행 중이면 이번 틱을 건너뛴다.
 *  - prune 스로틀: 매 샘플 DELETE 스캔 금지 — 20틱(10분)마다 1회.
 *  - 타이머 unref: 샘플러가 프로세스 종료를 붙잡지 않는다.
 *
 * 수집기 목록은 collectors.js 레지스트리가 진실의 원천이다 — 여기서는 순회만 한다.
 * 이벤트 루프 지연 히스토그램(monitorEventLoopDelay)은 샘플러가 소유하고 ctx.prev.eld 로
 * 수집기에 넘긴다(수집기는 percentile 을 읽고 reset — 창 단위 p99).
 */

import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { config } from '../config.js';
import { collectors, collectorMeta } from './collectors.js';
import { getCapacityDb } from './db.js';

const PRUNE_EVERY = 20;                        // 30초 × 20 = 10분마다 prune 1회

let timer = null;
let running = false;
let tick = 0;
let eld = null;                                // 이벤트 루프 지연 히스토그램(프로세스 수명 동안 유지)
const prev = {};                               // 델타형 수집기의 직전 원자료(cpu/net/pcpu/eld)
let lastRun = null;
let lastErr = '';

/** 이 호스트의 정적 메타 — 화면 헤더·권고 문구(코어 수 대비 부하 등)에 쓴다. */
export function hostMeta() {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    cores: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / (1024 * 1024)),
    nodeVersion: process.version,
    portalVersion: config.version || '',
    role: config.svcmonRole,
    intervalMs: config.capacity.sampleIntervalMs,
  };
}

/**
 * 스냅샷 1회 — 등록된 전 수집기를 돌려 {metric, v} 배열을 만든다. null(미측정)은 제외.
 * 순수 측정만 하고 저장하지 않는다 — 로컬 적재(sampleOnce)와 엣지 push(capacityPush)가 공유한다.
 */
export function collectSnapshot() {
  const ctx = { now: Date.now(), cores: os.cpus().length || 1, prev };
  if (eld) ctx.prev.eld = eld;
  const rows = [];
  for (const c of collectors()) {
    let v = null;
    try { v = c.sample(ctx); } catch { v = null; }   // 수집기 1개 실패가 전체 스냅샷을 막지 않는다
    if (v !== null && Number.isFinite(v)) rows.push({ metric: c.key, v });
  }
  return { ts: ctx.now, rows };
}

export async function sampleOnce() {
  if (running) return;                          // 재진입 가드 — 겹치면 이번 틱 스킵
  running = true;
  try {
    const snap = collectSnapshot();
    if (!snap.rows.length) return;              // 첫 틱은 델타 기준선만 잡혀 비어 있을 수 있다
    const db = await getCapacityDb();
    db.insertSnapshot('local', snap.rows, snap.ts, hostMeta());
    tick += 1;
    if (tick % PRUNE_EVERY === 1) db.prune(snap.ts);
    lastRun = { at: snap.ts, metrics: snap.rows.length };
    lastErr = '';
  } catch (e) {
    lastErr = e?.message || String(e);
    console.warn(`[capacity] 샘플 실패: ${lastErr}`);
  } finally {
    running = false;
  }
}

export function capacitySamplerStatus() {
  return {
    enabled: config.capacity.enabled,
    intervalMs: config.capacity.sampleIntervalMs,
    lastRun,
    lastErr,
    collectors: collectorMeta(),
    host: hostMeta(),
  };
}

export function startCapacitySampler() {
  if (timer || !config.capacity.enabled) return;
  // 지연 히스토그램은 상시 켜 둔다(오버헤드는 네이티브 타이머 수준으로 미미 — Node 공식 API).
  try { eld = monitorEventLoopDelay({ resolution: 20 }); eld.enable(); } catch { eld = null; }
  // 첫 샘플은 델타 기준선 확보용으로 곧바로, 이후 주기 실행.
  setTimeout(() => { sampleOnce().catch(() => {}); }, 5_000).unref?.();
  timer = setInterval(() => { sampleOnce().catch(() => {}); }, config.capacity.sampleIntervalMs);
  timer.unref?.();
  console.log(`[capacity] 리소스 샘플러 시작 (${Math.round(config.capacity.sampleIntervalMs / 1000)}초 주기 · 원본 ${config.capacity.rawRetentionHours}h · 롤업 ${config.capacity.rollupRetentionDays}d)`);
}
