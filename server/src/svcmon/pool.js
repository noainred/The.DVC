/**
 * 성능점검 워커 풀 — 배치를 워커 N개에 **파이프라인**으로 공급한다.
 *
 * 왜 파이프라인인가(실측 근거)
 * - 초기 구현은 '웨이브' 방식(워커 수만큼 보내고 전부 끝나길 기다림)이었다. 이러면 웨이브마다
 *   가장 느린 배치를 기다려 유휴가 생긴다 — 죽은 호스트가 섞인 실환경에서 처리량이 반토막.
 * - 지금은 각 워커가 자기 배치를 끝내는 즉시 다음 배치를 받는다(작업 큐). 워커는 항상 바쁘다.
 *
 * 용량 산정(문서 docs/SVCMON-ARCHITECTURE.md 와 같은 식)
 *   초당 처리량 ≈ 워커수 × sockLimit ÷ 평균응답(초)
 *   예) 4 × 256 ÷ 4s = 256/s → 3만 항목을 60초 주기로 돌리려면 500/s 필요 → 워커 8개 권장.
 *
 * 폴백: 워커 생성/전송 실패·사망 시 항상 인라인 실행(모니터링이 통째로 멈추는 게 최악).
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { runCheck } from './checker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_FILE = path.join(HERE, 'worker.js');

const envNum = (k, dflt) => { const n = Number(process.env[k]); return Number.isFinite(n) ? n : dflt; };

const WORKER_COUNT = Math.max(0, envNum('SVCMON_WORKERS', Math.min(4, Math.max(1, os.cpus().length - 1))));
// 소켓 대기형 동시성 — 처리량을 직접 결정한다(죽은 호스트가 많을수록 중요).
const SOCK_LIMIT = Math.max(1, envNum('SVCMON_CONCURRENCY', 256));
// CLI 프로세스를 띄우는 ping/trace 전용 — 너무 크면 프로세스 폭주로 시스템이 먼저 죽는다.
const PROC_LIMIT = Math.max(1, envNum('SVCMON_PROC_CONCURRENCY', 64));
const BATCH = Math.max(50, envNum('SVCMON_BATCH', 250));

const workers = [];
let seq = 0;
let inlineFallbacks = 0;

function spawn(index) {
  try {
    const w = new Worker(WORKER_FILE, { workerData: { sockLimit: SOCK_LIMIT, procLimit: PROC_LIMIT } });
    const slot = { w, pending: new Map(), alive: true, index };
    w.on('message', ({ id, results }) => {
      const resolve = slot.pending.get(id);
      if (resolve) { slot.pending.delete(id); resolve(results); }
    });
    const die = (why) => {
      if (!slot.alive) return;
      slot.alive = false;
      console.error(`[svcmon] 워커 #${index} 종료(${why}) — 다음 배치에서 재생성`);
      for (const [, resolve] of slot.pending) resolve(null);   // 폴백 신호
      slot.pending.clear();
      workers[index] = null;
    };
    w.on('error', (e) => die(e?.message || 'error'));
    w.on('exit', (code) => die(`exit ${code}`));
    w.unref();
    workers[index] = slot;
    return slot;
  } catch (e) {
    console.error(`[svcmon] 워커 #${index} 생성 실패 — 인라인 폴백:`, e?.message);
    workers[index] = null;
    return null;
  }
}

const slotFor = (i) => (workers[i]?.alive ? workers[i] : spawn(i));

function send(slot, tests) {
  return new Promise((resolve) => {
    const id = ++seq;
    slot.pending.set(id, resolve);
    try { slot.w.postMessage({ id, tests }); }
    catch (e) {
      slot.pending.delete(id);
      console.error('[svcmon] 워커 전송 실패 — 폴백:', e?.message);
      resolve(null);
    }
  });
}

/** 인라인 폴백 — 워커와 같은 두 갈래 동시성 규칙을 따른다. */
async function inline(tests) {
  inlineFallbacks += 1;
  const out = [];
  const procQ = tests.filter((x) => ['ping', 'trace'].includes(x.test.type));
  const sockQ = tests.filter((x) => !['ping', 'trace'].includes(x.test.type));
  const drain = async (queue, limit) => {
    const q = [...queue];
    await Promise.all(Array.from({ length: Math.min(limit, q.length) }, async () => {
      while (q.length) {
        const { test, host } = q.shift();
        try { out.push({ testId: test.id, ...(await runCheck(test, host)) }); }
        catch (e) { out.push({ testId: test.id, status: 'bad', reply: String(e?.message || e).slice(0, 120), ms: 0 }); }
      }
    }));
  };
  await Promise.all([drain(procQ, PROC_LIMIT), drain(sockQ, SOCK_LIMIT)]);
  return out;
}

/**
 * 점검 목록 실행 → [{ testId, status, reply, ms }]
 * items: [{ test, host }]
 */
export async function runBatch(items) {
  if (!items?.length) return [];
  if (WORKER_COUNT === 0) return inline(items);

  const chunks = [];
  for (let i = 0; i < items.length; i += BATCH) chunks.push(items.slice(i, i + BATCH));

  const results = [];
  let cursor = 0;
  // 파이프라인: 워커 수만큼 소비자를 띄우고, 각 소비자는 끝나는 즉시 다음 배치를 집는다.
  await Promise.all(Array.from({ length: Math.min(WORKER_COUNT, chunks.length) }, async (_, k) => {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor++];
      const slot = slotFor(k);
      const r = slot ? await send(slot, chunk) : null;
      results.push(...(r === null ? await inline(chunk) : r));
    }
  }));
  return results;
}

export function poolStats() {
  return {
    workers: WORKER_COUNT,
    alive: workers.filter((s) => s?.alive).length,
    sockLimit: SOCK_LIMIT,
    procLimit: PROC_LIMIT,
    batch: BATCH,
    inlineFallbacks,
    // 이론 처리량(참고) — 평균 응답 4초 가정. 실측은 /api/svcmon/diag 의 lastSweepMs 로 본다.
    estPerSecAt4s: Math.round((WORKER_COUNT || 1) * SOCK_LIMIT / 4),
  };
}

export function closePool() {
  for (const slot of workers) if (slot?.w) { try { slot.w.terminate(); } catch { /* noop */ } }
  workers.length = 0;
}
