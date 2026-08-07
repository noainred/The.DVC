/**
 * 성능점검 폴러 — 각 점검의 intervalSec 이 지난 것만 골라 동시성 제한으로 실행.
 *
 * 성능 불변조건(CLAUDE.md): 재진입 가드(이전 틱이 안 끝나면 이번 틱 스킵 — 고RTT 대상이
 * 많을 때 중첩 실행으로 CPU 누적 방지), 수동 새로고침(runNow)도 같은 가드를 공유한다.
 * 결과는 인메모리만(시계열 없음 — v1). streak 은 같은 상태 연속 횟수(HostMonitor 의 Recurrences).
 */

import { listTargets } from './store.js';
import { runCheck } from './checker.js';

const TICK_MS = 10_000;
const CONCURRENCY = 8;

const results = new Map();  // testId -> { status, reply, ms, ts, streak }
let running = false;        // 재진입 가드(주기·수동 공유)
let lastSweepTs = 0;
let timer = null;

export function getResults() { return results; }
export function getLastSweep() { return lastSweepTs; }

async function pool(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await fn(item); } catch { /* runCheck 가 자체 격리 — 여기 도달은 방어용 */ }
    }
  });
  await Promise.all(workers);
}

async function sweep(force = false) {
  if (running) return false;   // 재진입 가드
  running = true;
  try {
    const now = Date.now();
    const due = [];
    for (const target of listTargets()) {
      if (target.enabled === false) continue;
      for (const test of target.tests) {
        if (test.enabled === false) continue;
        const prev = results.get(test.id);
        if (force || !prev || now - prev.ts >= test.intervalSec * 1000) {
          due.push({ target, test });
        }
      }
    }
    await pool(due, CONCURRENCY, async ({ target, test }) => {
      const r = await runCheck(test, target.host);
      const prev = results.get(test.id);
      results.set(test.id, {
        ...r,
        ts: Date.now(),
        streak: prev && prev.status === r.status ? prev.streak + 1 : 1,
      });
    });
    lastSweepTs = Date.now();
    return true;
  } finally {
    running = false;
  }
}

/** 수동 새로고침 — 진행 중이면 false(주기 폴러와 가드 공유, CLAUDE.md 패턴). */
export function runNow() { return sweep(true); }

export function startSvcmonPoller() {
  if (timer) return;
  sweep().catch(() => {});
  timer = setInterval(() => { sweep().catch(() => {}); }, TICK_MS);
  timer.unref?.();
  console.log('[svcmon] 성능점검 폴러 시작 (tick 10s)');
}
