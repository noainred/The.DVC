/**
 * snaphist/poller.js — VM 별 스냅샷 이력 기록 폴러(v3.26.0 · 설계 docs/design/snapshots §5 · §8 ⑧ 기본값 ‘하루 1번(새벽)’).
 *
 * 60초 틱:
 *   · 로컬 시각이 기록 시각(SNAPHIST_HOUR, 기본 3시) 이후이고 오늘 아직 'ok' 로 기록하지 않은 vCenter 가 있으면, 그 vCenter 들만 기록한다.
 *     그날 못 읽은 vCenter(점검중 · 수집 실패 · 낡음 · 첫 수집 중)는 그 사유만 남기고(빠진 날), **읽을 수 있게 되면 같은 날 안에 다시 시도**한다.
 *     포탈이 3시에 꺼져 있었으면 켜진 뒤 첫 틱에 채운다(누락보다 늦게 채우는 편이 낫다 — vmtrack 과 같은 판단).
 *   · 다시 시도는 10분에 한 번만(못 읽은 vCenter 가 남아 있는 동안 매분 트랜잭션을 열지 않는다).
 *   · 재진입 가드 · 정리(prune)는 12시간마다 · **기동 첫 틱에는 정리하지 않는다**(v2.453 규약).
 * vCenter 왕복 없음 — 이미 받은 인벤토리(store.get())만 읽는다.
 */
import { store } from '../store.js';
import { loadVmHygieneSettings } from '../vmhygiene/settings.js';
import { unreadVcenterReasons } from '../metrics/unreadVcenters.js';
import { dayRecord, dayKeyOf } from './record.js';
import { commitDay, okVcentersOfDay, pruneSnapHist, getSnapHistDb, retentionDays } from './db.js';
import { envPositive } from '../util/envNumber.js';

const TICK_MS = 60_000;
export const RETRY_MS = 10 * 60_000;
const PRUNE_EVERY_MS = 12 * 3_600_000;
export function recordHour() {
  // 0시는 '0' 이 양수가 아니라 envPositive 로 읽지 못한다 — 1~23 만 받고, 자정 기록은 24 로 적는다(24 → 0)
  const n = envPositive(process.env.SNAPHIST_HOUR, 3, { max: 24 });
  return n === 24 ? 0 : n;
}

let running = false;
let lastTry = { day: null, at: 0 };
let lastResult = null;
let lastPruneAt = Date.now();   // 기동 첫 틱에 정리하지 않는다

export function snapHistPollerStatus() { return { running, lastResult, recordHour: recordHour(), retentionDays: retentionDays() }; }

/** 기록이 필요한 vCenter — 등록된 것 중 오늘 'ok' 가 아닌 것. 순수(시험용). */
export function pendingVcenters(snap, okSet) {
  return (snap?.vcenters || []).filter((vc) => vc && vc.id != null && !okSet.has(String(vc.id))).map((vc) => String(vc.id));
}

/** 그 중 지금 읽을 수 있는 것(못 읽음 · 첫 수집 중 · 비활성 제외). 순수(시험용). */
export function readableNow(snap, ids) {
  const unread = unreadVcenterReasons(snap);
  const byId = new Map((snap?.vcenters || []).filter(Boolean).map((vc) => [String(vc.id), vc]));
  return ids.filter((id) => !unread.has(id) && byId.get(id)?.status !== 'pending' && byId.get(id)?.status !== 'disabled');
}

/** 한 번 실행(폴러 · 시험 공용). force 면 기록 시각 · 다시 시도 간격을 보지 않는다. */
export async function runSnapHistOnce({ now = Date.now(), force = false, trigger = 'tick' } = {}) {
  if (running) return { ok: false, skipped: true, reason: '이미 기록 중입니다.' };
  running = true;
  try {
    const db = await getSnapHistDb();
    if (!db) return { ok: false, reason: 'snap-history DB 사용 불가' };
    if (!force && new Date(now).getHours() < recordHour()) return { ok: true, idle: 'before-hour' };
    const snap = store.get();
    if (!snap?.vcenters?.length) return { ok: true, idle: 'no-inventory' };
    const day = dayKeyOf(now);
    const okSet = await okVcentersOfDay(day);
    if (!okSet) return { ok: false, reason: 'snap-history DB 사용 불가' };
    const todo = pendingVcenters(snap, okSet);
    if (!todo.length) return { ok: true, idle: 'done' };
    const firstToday = lastTry.day !== day;
    const readable = readableNow(snap, todo);
    // 오늘 첫 시도는 전부(못 읽은 것은 사유만 남긴다) · 그 뒤는 읽을 수 있게 된 것만, 10분에 한 번
    if (!force && !firstToday && (!readable.length || now - lastTry.at < RETRY_MS)) return { ok: true, idle: 'waiting' };
    lastTry = { day, at: now };
    let hygiene = null;
    try { hygiene = loadVmHygieneSettings(); } catch { hygiene = null; }
    const only = new Set(firstToday || force ? todo : readable);
    const rec = dayRecord(snap, { now, hygiene, only });
    const r = await commitDay(rec);
    lastResult = { at: now, day, trigger, ...r };
    if (!r.ok) console.warn(`[snaphist] 기록 실패: ${String(r.reason || '').slice(0, 200)}`);
    return r;
  } finally {
    running = false;
  }
}

export function startSnapHistPoller() {
  setInterval(async () => {
    try {
      await runSnapHistOnce();
      if (Date.now() - lastPruneAt > PRUNE_EVERY_MS) { lastPruneAt = Date.now(); pruneSnapHist().catch(() => {}); }
    } catch (e) {
      console.error('[snaphist] 기록 실패:', e?.message || e);
    }
  }, TICK_MS).unref?.();
}
