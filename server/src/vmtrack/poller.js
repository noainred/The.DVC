/**
 * vmtrack/poller.js — VM 수량 추이 스냅샷 폴러(v2.345).
 *
 * 사용자 요구: "매일 00시·12시 기준" — 60초 틱으로 현재 슬롯(slotKey)을 확인하고, 그 슬롯이
 * 아직 기록되지 않았으면 1회 수집한다. 슬롯 기반이라 재시작·일시 정지에도 중복/누락이 없다
 * (포탈이 00:00 에 꺼져 있었고 00:30 에 켜지면 그 슬롯을 '늦게' 채운다 — 누락보다 낫다).
 *
 * CLAUDE.md 규칙: 재진입 가드(진행 중이면 틱 건너뜀) + 수동 실행 API 와 가드 공유.
 * 적재는 DB 단일 트랜잭션(vmtrack/db.commitSnapshot).
 */

import { store } from '../store.js';
import { slotKey } from './diff.js';
import { takeVmSnapshot } from './service.js';
import { lastSnapshotSlot, pruneVmtrack, getDb } from './db.js';
import { snapshotFrozenByStop } from '../metrics/sampler.js'; // 164회차: 긴급중단으로 얼어 있는 스냅샷 판정(샘플러와 같은 것)

const TICK_MS = 60_000;
let running = false;      // 재진입 가드(폴러 + 수동 실행 공유)
let lastResult = null;    // { at, slot, vcenters, added, removed, ms, trigger }
let lastPruneAt = Date.now();   // v2.595(감사 T2595-04): 기동 첫 틱에 prune 하지 않는다(v2.453 규약)
const PRUNE_EVERY_MS = 12 * 3_600_000; // 하루 2회 정도면 충분(행이 작아 정리 비용 무의미)
export const PENDING_WAIT_MS = 30 * 60_000;   // 첫 수집 대기 상한(v2.594)
let waiting = null;   // { at, slot, pending } — 첫 수집 대기로 이번 슬롯 기록을 미룬 사실

// 143회차(재현): 상태가 lastResult(슬롯 기록 — 하루 2번) 하나라 포탈 상태(health/services.js pollerCheck)가 기록 30분 뒤부터 다음 슬롯까지
//   ‘주기의 2배를 넘겼습니다’, 재시작 뒤 슬롯이 이미 채워져 있으면 ‘한 번도 돌지 않았습니다’ 였다(틱은 매분 돈다 — snaphist 138회차 N138-4 와 같은 꼴).
//   틱마다(재진입으로 건너뛴 틱 제외) 시각 · 성패를 남기고 lastRun · intervalMs · 실패(warn)를 싣는다. lastResult 는 그대로(화면 ‘최근 스냅샷’).
let lastTick = null;   // { at, ok, reason }
export function vmtrackPollerStatus() {
  const bad = lastTick && !lastTick.ok;
  return { running, lastResult, waiting, lastRun: lastTick ? { at: lastTick.at } : null, intervalMs: TICK_MS,
    ...(bad ? { warn: true, warnText: String(lastTick.reason || '스냅샷 실패').slice(0, 200) } : {}), ...(lastTick?.emergencyStop ? { emergencyStop: true } : {}) };
}

/** 스냅샷 1회 실행(수동/자동 공용). 진행 중이면 skipped. */
export async function runVmtrackNow(trigger = 'manual') {
  if (running) return { ok: false, skipped: true, reason: '이미 스냅샷이 진행 중입니다.' };
  running = true;
  const started = Date.now();
  try {
    const snap = store.get();
    if (!snap?.vcenters?.length) return { ok: false, reason: '수집된 vCenter 스냅샷이 없습니다(폴링 전).' };
    // 164회차(결정 6): 긴급중단 중 · 푼 뒤 다음 병합 전에는 스냅샷이 얼어 있다 — 그 VM 수를 이 슬롯의 값으로 남기지 않는다(슬롯은 비워 두고 병합 뒤 늦게 채운다)
    if (snapshotFrozenByStop(snap)) return { ok: false, emergencyStop: true, reason: '긴급중단으로 수집이 멈춰 인벤토리가 지금 값이 아닙니다 — 이 슬롯은 해제 뒤 다음 수집이 끝나면 기록합니다.' };
    const r = await takeVmSnapshot(snap, { trigger });
    if (r.ok) lastResult = { at: Date.now(), trigger, ...r, ms: Date.now() - started };
    return r;
  } finally {
    running = false;
  }
}

/** 60초 틱 한 번(폴러 · 시험 공용). 재진입이면 아무것도 남기지 않는다. */
export async function vmtrackTick() {
    if (running) return; // 재진입 가드
    let fail = null;
    let stopped = false;
    try {
      const db = await getDb();
      if (!db) { fail = 'vmtrack DB 사용 불가'; return; } // DB 불가 — 기능 비활성(상태 API 가 사유를 노출)
      const cur = slotKey(new Date());
      const last = await lastSnapshotSlot();
      if (last === cur) {
        // 슬롯이 이미 채워짐 — 유지보수만 간헐 실행.
        if (Date.now() - lastPruneAt > PRUNE_EVERY_MS) { lastPruneAt = Date.now(); pruneVmtrack().catch(() => {}); }
        return;
      }
      const snap = store.get();
      if (!snap?.vcenters?.length) return; // 아직 첫 수집 전 — 다음 틱에 재시도
      // v2.594(감사 DATA2594-03 — 재현): 재시작 직후 첫 수집 중(pending)인 vCenter 는 VM 0 이라 이번 슬롯에서 빠지고,
      //   그 부분 합이 '전 함대 합계' 로 기록돼 차트에 **거짓 하락**이 찍혔다. 첫 수집이 끝날 때까지(최대 PENDING_WAIT_MS)
      //   기다린다 — 슬롯은 12시간 단위라 몇 분 늦게 채워도 누락이 아니다. 그 뒤에도 남으면 기록하되 빠진 수를 남긴다.
      const pending = snap.vcenters.filter((v) => v.status === 'pending').length;
      // v2.595(감사 R2595-03): 대기 기준은 슬롯 시작이 아니라 **이 슬롯에서 첫 수집 중(pending)을 처음 본 시각**이다 —
      //   슬롯 시작 30분 뒤 재시작하면 대기 없이 부분 합이 기록됐다(업그레이드·장애 복구가 흔히 그렇다).
      if (pending) {
        const first = waiting?.slot === cur ? waiting.firstSeenAt : Date.now();
        if (Date.now() - first < PENDING_WAIT_MS) { waiting = { at: Date.now(), firstSeenAt: first, slot: cur, pending }; return; }
      }
      waiting = null;
      const r = await runVmtrackNow('slot');
      if (r?.emergencyStop) stopped = true;   // 164회차: 의도한 정지 — 실패(warn)가 아니다
      else if (r && r.ok === false && !r.skipped) fail = r.reason || '스냅샷 실패';
      if (Date.now() - lastPruneAt > PRUNE_EVERY_MS) { lastPruneAt = Date.now(); pruneVmtrack().catch(() => {}); }
    } catch (e) {
      fail = e?.message || '예외';
      console.error('[vmtrack] 스냅샷 실패:', e.message);
    } finally {
      lastTick = { at: Date.now(), ok: !fail, reason: fail, ...(stopped ? { emergencyStop: true } : {}) };
    }
}

export function startVmtrackPoller() {
  setInterval(vmtrackTick, TICK_MS).unref?.();
}
