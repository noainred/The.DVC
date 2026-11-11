/**
 * focusmon/recorder.js — 메모리 묶음을 DB 에 남기고(10초 틱 · 한 트랜잭션) 오래된 기록을 지운다(v2.976).
 *
 *  · 쓰기: store.drainWrites() 를 10초마다 한 트랜잭션으로(한 번에 최대 400줄 — 보통 수십 줄). 걸린 시간을 재서 상태로 낸다
 *    (운영에서 p99 가 50ms 를 넘으면 ipam/writeWorker.js 방식으로 옮긴다 — 설계 §9-2).
 *  · 정리: 보관 기간(설정 · 기본 30일) 밖을 500줄 조각으로 — 스로틀 `(++tick % 30) === 0`(5분마다 · 기동 첫 틱 금지).
 *  · 용량 상한(설정 · 기본 20GB): 넘으면 보관 기간 안이라도 가장 오래된 분부터 한 조각씩. SQLite 파일은 지워도 바로 줄지 않는다(빈 자리를 다시 쓴다).
 *  · 디스크 여유 보호: 이 노드 DB 폴더의 여유가 2GB 또는 5% 아래면 **기록만** 멈춘다(수집 · 실시간 화면은 계속) — 화면이 말한다.
 *  · 종료 때 열린 분을 닫아 동기로 쓴다(이미 열린 DB 일 때만). 비정상 종료면 아직 묶이지 않은 최대 약 1분을 잃는다(정직 기록).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import * as db from './db.js';
import { getSettings } from './registry.js';

const MIN_FREE_BYTES = 2 * 2 ** 30;
const MIN_FREE_RATIO = 0.05;
let tick = 0;
let busy = false;
const st = { lastWriteAt: 0, lastWriteRows: 0, lastWriteMs: null, maxWriteMs: 0, writes: 0, errors: 0, lastError: '', paused: false, pauseReason: '', freeBytes: null, lastPruneAt: 0, pruned: 0, capped: 0 };

function freeSpace() {
  try {
    const dir = path.dirname(db.dbPath());
    fs.mkdirSync(dir, { recursive: true });
    const s = fs.statfsSync(dir);
    const free = s.bavail * s.bsize; const total = s.blocks * s.bsize;
    return { free, total };
  } catch { return null; }
}

/** 10초 틱 하나. */
export async function recordTick(now = Date.now()) {
  if (busy) return st;
  busy = true;
  try {
    const fsx = freeSpace();
    st.freeBytes = fsx?.free ?? null;
    const low = fsx && (fsx.free < MIN_FREE_BYTES || (fsx.total > 0 && fsx.free / fsx.total < MIN_FREE_RATIO));
    if (low) {
      if (!st.paused) console.warn(`[focusmon] DB 폴더 여유 공간이 부족해 기록을 멈춥니다(여유 ${Math.round(fsx.free / 2 ** 20)}MB) — 수집과 실시간 화면은 계속됩니다.`);
      st.paused = true; st.pauseReason = 'disk-low';
      store.drainWrites(100_000); // 쌓아 두면 메모리만 는다 — 그 구간은 기록되지 않는다(화면이 말한다)
    } else {
      st.paused = false; st.pauseReason = '';
      const rows = store.drainWrites(400);
      if (rows.length) {
        const r = await db.writeBlocks(rows);
        if (r.ok) { st.lastWriteAt = now; st.lastWriteRows = rows.length; st.lastWriteMs = Math.round(r.ms * 100) / 100; st.maxWriteMs = Math.max(st.maxWriteMs, r.ms); st.writes += 1; st.lastError = ''; }
        else { st.errors += 1; st.lastError = r.error || ''; }
      }
    }
    tick += 1;
    if (tick % 30 === 0) await housekeep(now);
  } finally { busy = false; }
  return st;
}

async function housekeep(now) {
  const s = getSettings();
  const cutMinute = Math.floor((now - s.retentionDays * 86_400_000) / 60_000);
  let n = 0;
  for (let k = 0; k < 20; k++) { const d = await db.pruneChunk(cutMinute); n += d; if (d < db.PRUNE_CHUNK) break; await new Promise((r) => setImmediate(r)); }
  st.pruned += n; st.lastPruneAt = now;
  const bytes = db.dbBytes();
  if (bytes != null && bytes > s.capGb * 2 ** 30) {
    for (let k = 0; k < 10; k++) { const d = await db.pruneOldestChunk(); st.capped += d; if (!d) break; await new Promise((r) => setImmediate(r)); }
  }
}

export function recorderStatus() { return { ...st, queue: store.pendingWrites(), dbBytes: db.dbBytes(), dbError: db.dbError() }; }

/** 종료 직전(동기). */
export function flushOnExit() {
  try { store.closeAll(); return db.writeBlocksSync(store.drainWrites(100_000)); } catch { return 0; }
}

export function _resetForTest() { tick = 0; busy = false; Object.assign(st, { lastWriteAt: 0, lastWriteRows: 0, lastWriteMs: null, maxWriteMs: 0, writes: 0, errors: 0, lastError: '', paused: false, pauseReason: '', pruned: 0, capped: 0 }); }
