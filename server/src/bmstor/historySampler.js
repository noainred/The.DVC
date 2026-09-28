/**
 * bmstor/historySampler.js — 베어메탈 스토리지 디스크 사용량 **12시간 적재**(v2.635).
 *
 * 60초 틱마다 확인하고, 현재 12시간 슬롯(KST 0시·12시)에 합계 행이 없거나 부분 합뿐이면 폴러의 최신 결과로 적재한다.
 *  · **장비에 접속하지 않는다** — `poller.js` 가 이미 들고 있는 최신 결과(`getBmLatest()`)를 떼어 저장할 뿐이다.
 *  · 폴러가 기동 뒤 한 번도 돌지 않았으면 기다린다(재시작 직후 빈 결과를 '0 바이트' 로 적재하지 않는다).
 *  · 부분 합이면 같은 슬롯 안에서 **폴러가 새로 수집할 때마다** 다시 시도한다 — 더 온전한 값만 덮는다(historyDb.js).
 *  · 재진입 가드(CLAUDE.md 폴러 규약). 재시작해도 DB 의 슬롯 기록을 보고 같은 슬롯을 다시 적재하지 않는다.
 *  · `BMSTOR_HISTORY=0` 이면 끈다.
 */
import { listBmServers } from './registry.js';
import { getBmLatest, bmPollerStatus } from './poller.js';
import { buildHistoryRows, slotOf, slotStart, freshMsFor, historyIntervalHours, historyRetentionDays } from './history.js';
import { commitBmHistory, totalOfSlot, pruneBmHistory } from './historyDb.js';

const TICK_MS = 60_000;
const disabled = () => String(process.env.BMSTOR_HISTORY ?? '').trim() === '0';

let running = false;
let lastRunAt = 0;         // 마지막으로 행을 적재한 시각
let last = null;           // { at, slot, rows, written, partial, read, servers, stale, reason }
let doneSlot = null;       // 온전한 합계를 적재한 슬롯
let triedSlot = null;      // 부분 합으로 시도한 슬롯
let triedPollAt = 0;       // 그때 쓴 폴러 수집 시각(같은 수집으로 다시 시도하지 않는다)
let idleReason = '';

export function bmHistoryStatus() {
  const hours = historyIntervalHours();
  const now = Date.now();
  const slot = slotOf(now, hours);
  return {
    enabled: !disabled() && !idleReason.startsWith('등록'),
    running, lastRunAt, intervalMs: hours * 3_600_000, intervalHours: hours,
    retentionDays: historyRetentionDays(),
    last, doneSlot, currentSlot: slot, nextSlotAt: slotStart(slot + 1, hours),
    idleReason: disabled() ? '꺼짐(BMSTOR_HISTORY=0)' : idleReason,
  };
}

/**
 * 한 번 확인·적재. 테스트는 `deps` 로 입력을 주입한다.
 * @returns {Promise<{skipped?:boolean, reason?:string, ok?:boolean, written?:number, partial?:boolean}>}
 */
export async function sampleBmHistoryOnce({ now = Date.now(), deps = {} } = {}) {
  if (disabled()) return { skipped: true, reason: 'disabled' };
  if (running) return { skipped: true, reason: 'running' };
  running = true;
  try {
    const listServers = deps.listServers || listBmServers;
    const latestOf = deps.latest || getBmLatest;
    const pollStatus = deps.pollStatus || bmPollerStatus;
    const hours = historyIntervalHours();
    const servers = listServers();
    if (!servers.some((s) => s.enabled !== false)) { idleReason = '등록된(활성) 서버가 없습니다'; return { skipped: true, reason: 'no-servers' }; }
    const poll = pollStatus() || {};
    if (!poll.lastRunAt) { idleReason = '기동 뒤 첫 수집을 기다리는 중입니다'; return { skipped: true, reason: 'no-collection' }; }
    idleReason = '';
    const slot = slotOf(now, hours);
    if (doneSlot === slot) return { skipped: true, reason: 'slot-done' };
    if (triedSlot === slot && triedPollAt === poll.lastRunAt) return { skipped: true, reason: 'same-collection' };
    // 재시작 뒤: 이 슬롯에 이미 온전한 합계가 있으면 다시 적재하지 않는다.
    const prev = await totalOfSlot(slot);
    if (prev?.exists && !prev.partial) { doneSlot = slot; return { skipped: true, reason: 'slot-done' }; }

    const { rows, stale } = buildHistoryRows(servers, latestOf(), { now, freshMs: freshMsFor(poll.intervalMinutes) });
    triedSlot = slot; triedPollAt = poll.lastRunAt;
    if (!rows.length) {
      last = { at: now, slot, rows: 0, written: 0, partial: true, read: 0, servers: servers.length, stale, reason: '신선한 수집 결과가 없어 적재하지 않았습니다' };
      return { skipped: true, reason: 'no-fresh' };
    }
    const r = await commitBmHistory({ slot, ts: now, rows });
    const tot = rows.find((x) => x.kind === 'total');
    last = { at: now, slot, rows: rows.length, written: r.written ?? 0, partial: !!tot?.partial, read: tot?.read ?? 0, servers: tot?.servers ?? 0, stale, reason: r.ok ? '' : r.reason };
    if (!r.ok) { console.warn(`[bmstor-history] 적재 실패: ${r.reason}`); return { ok: false, reason: r.reason }; }
    lastRunAt = now;
    if (tot && !tot.partial) doneSlot = slot;
    return { ok: true, written: r.written, partial: !!tot?.partial };
  } finally {
    running = false;
  }
}

export function startBmstorHistory() {
  if (disabled()) { console.log('[bmstor-history] BMSTOR_HISTORY=0 — 12시간 이력 적재를 끕니다'); return; }
  setInterval(() => {
    sampleBmHistoryOnce().catch((e) => console.warn(`[bmstor-history] ${e?.message || e}`));
    // 6시간에 한 번(60초 × 360) 보존 정리 — 첫 틱에는 돌지 않는다(v2.453).
    pruneBmHistory(historyRetentionDays(), { every: 360 }).catch(() => {});
  }, TICK_MS).unref?.();
}

export function _resetBmHistorySamplerForTest() {
  running = false; lastRunAt = 0; last = null; doneSlot = null; triedSlot = null; triedPollAt = 0; idleReason = '';
}
