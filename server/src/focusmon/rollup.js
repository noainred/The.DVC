/**
 * focusmon/rollup.js — 요약 표 채우기(v3.13.0 ⑭ — 시안 History · 컨펌 ② ③).
 *
 *  · 1시간 요약: 1분 요약이 쓰인 (대상, 시간)을 '할 일' 로 적어 두고(`markDirty` — 기록기가 대기열을 쓴 뒤 부른다), **끝난 시간만** 그 시간의 1분 요약을 합쳐 쓴다(`rollupTick`).
 *    기동 때는 지난 48시간에서 1시간 요약이 없는 끝난 시간을 한 번 찾아 할 일에 넣는다(앞 프로세스가 마치지 못한 시간).
 *  · 백필(컨펌 ③ '한 번 조각으로 · 쉬어 가며'): 원본 분 가운데 1분 요약이 없는 것을 minute 순으로 조금씩 — 한 번에 `BACKFILL_SLICE_MS` 남짓 일하고 `BACKFILL_GAP_MS` 쉰다.
 *    끝까지 가면 멈추고(`done`), 그동안 긴 구간 조회는 '요약 만드는 중' 을 밝힌다(`backfillState`). 못 읽은 묶음에는 빈 요약을 남겨 같은 분을 되풀이하지 않는다.
 *  · 이벤트 루프를 오래 막지 않는다 — 조각마다 시간 기준으로 끊고 setImmediate 로 넘긴다(perf-db 규약).
 */
import * as db from './db.js';
import { decodeBlock } from './codec.js';
import { summarizeBlock, mergeSums, encodeSum, decodeSum, SUM_VERSION } from './summary.js';

export const BACKFILL_SLICE_MS = 60;
export const BACKFILL_GAP_MS = 500;
export const BACKFILL_BATCH = 20;
const DIRTY_MAX = 50_000;

const dirty = new Map(); // `${target}|${hour}` → { target, hour }
const bf = { started: false, done: false, cursor: -1, processed: 0, empty: 0, errors: 0, lastAt: 0, timer: null };

/** 1분 요약이 쓰인 (대상, 분) → 그 시간을 할 일로. */
export function markDirty(target, minute) {
  if (dirty.size >= DIRTY_MAX) return;
  const hour = Math.floor(minute / 60);
  dirty.set(`${target}|${hour}`, { target: String(target), hour });
}
export function dirtyCount() { return dirty.size; }

/** 끝난 시간들의 1시간 요약을 쓴다(한 번에 maxHours 까지). 쓴 시간 수. */
export async function rollupTick(now = Date.now(), maxHours = 30) {
  const curHour = Math.floor(now / 3_600_000);
  const todo = [...dirty.values()].filter((x) => x.hour < curHour).sort((a, b) => a.hour - b.hour).slice(0, maxHours);
  const rows = [];
  for (const x of todo) {
    const list = await db.readSum1(x.target, x.hour * 60, x.hour * 60 + 59, 120);
    if (list == null) return 0; // DB 를 못 열었다 — 할 일은 남긴다
    const sums = list.map((r) => decodeSum(r.data)).filter((s) => s && s.keys.length);
    const m = mergeSums(sums);
    dirty.delete(`${x.target}|${x.hour}`);
    if (m) rows.push({ kind: 's60', target: x.target, hour: x.hour, data: encodeSum({ ...m, h: x.hour }) });
    await new Promise((r) => setImmediate(r));
  }
  if (rows.length) { const w = await db.writeBlocks(rows); if (!w.ok) for (const r of rows) dirty.set(`${r.target}|${r.hour}`, { target: r.target, hour: r.hour }); }
  return rows.length;
}

/** 기동 때 한 번 — 지난 48시간의 끝난 시간 중 1시간 요약이 없는 것을 할 일에. */
export async function seedDirty(now = Date.now()) {
  const curHour = Math.floor(now / 3_600_000);
  const list = await db.hoursWithoutSum60(Math.floor(now / 60_000) - 48 * 60, curHour);
  for (const x of list || []) if (dirty.size < DIRTY_MAX) dirty.set(`${x.target}|${x.hour}`, x);
  return (list || []).length;
}

/** 백필 한 조각(시간 기준) — 요약이 없는 원본 분을 요약해 쓴다. 남은 것이 없으면 done. */
export async function backfillSlice(now = Date.now(), sliceMs = BACKFILL_SLICE_MS) {
  if (bf.done) return 0;
  const t0 = Date.now();
  const before = Math.floor(now / 60_000) - 2; // 아직 열린 분 · 막 닫힌 분은 기록기 몫
  let n = 0;
  while (Date.now() - t0 < sliceMs) {
    const rows = await db.metricsWithoutSum(bf.cursor, before, BACKFILL_BATCH);
    if (rows == null) return n; // DB 없음 — 다음에
    if (!rows.length) { bf.done = true; break; }
    const out = [];
    for (const r of rows) {
      let sm = null;
      try { const b = decodeBlock(r.data); sm = b ? summarizeBlock(b) : null; } catch { sm = null; }
      if (!sm) { bf.empty += 1; sm = { v: SUM_VERSION, m: r.minute, t0: null, t1: null, keys: [], n: [], a: [], lo: [], hi: [], meta: {} }; } // 빈 요약 — 같은 분을 되풀이하지 않게
      out.push({ kind: 's1', target: r.target, minute: r.minute, data: encodeSum(sm) });
    }
    const w = await db.writeBlocks(out);
    if (!w.ok) { bf.errors += 1; return n; }
    for (const r of out) markDirty(r.target, r.minute);
    n += out.length; bf.processed += out.length;
    // 같은 분에 대상이 더 있을 수 있다 — 꽉 찬 묶음이면 마지막 분을 다시 본다(이미 쓴 것은 NOT EXISTS 가 거른다)
    bf.cursor = rows.length >= BACKFILL_BATCH ? rows[rows.length - 1].minute - 1 : rows[rows.length - 1].minute;
    await new Promise((r) => setImmediate(r));
  }
  bf.lastAt = now;
  return n;
}

/** 백필 · 1시간 요약 타이머 시작(서비스 기동 때 한 번 · 테스트는 부르지 않는다). */
export function startRollup({ paused = () => false } = {}) {
  if (bf.started) return;
  bf.started = true;
  seedDirty().catch(() => {});
  const tick = async () => {
    // 기록기가 여유 공간 부족으로 멈췄으면 백필도 쉰다(쓰지 못할 요약을 만들지 않는다)
    try { if (!bf.done && !paused()) await backfillSlice(); } catch { bf.errors += 1; }
    bf.timer = setTimeout(tick, bf.done ? 60_000 : BACKFILL_GAP_MS); bf.timer.unref?.();
  };
  bf.timer = setTimeout(tick, 5_000); bf.timer.unref?.();
}
export function stopRollup() { clearTimeout(bf.timer); bf.started = false; }

/** 화면용 상태 — 긴 구간 응답이 '요약 만드는 중' 을 밝힌다. */
export function backfillState() { return { building: !bf.done, processed: bf.processed, empty: bf.empty, errors: bf.errors, cursorMinute: bf.cursor >= 0 ? bf.cursor : null }; }
export function _resetForTest() { dirty.clear(); Object.assign(bf, { started: false, done: false, cursor: -1, processed: 0, empty: 0, errors: 0, lastAt: 0 }); clearTimeout(bf.timer); bf.timer = null; }
