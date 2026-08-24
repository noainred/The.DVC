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

const TICK_MS = 60_000;
let running = false;      // 재진입 가드(폴러 + 수동 실행 공유)
let lastResult = null;    // { at, slot, vcenters, added, removed, ms, trigger }
let lastPruneAt = 0;
const PRUNE_EVERY_MS = 12 * 3_600_000; // 하루 2회 정도면 충분(행이 작아 정리 비용 무의미)

export function vmtrackPollerStatus() { return { running, lastResult }; }

/** 스냅샷 1회 실행(수동/자동 공용). 진행 중이면 skipped. */
export async function runVmtrackNow(trigger = 'manual') {
  if (running) return { ok: false, skipped: true, reason: '이미 스냅샷이 진행 중입니다.' };
  running = true;
  const started = Date.now();
  try {
    const snap = store.get();
    if (!snap?.vcenters?.length) return { ok: false, reason: '수집된 vCenter 스냅샷이 없습니다(폴링 전).' };
    const r = await takeVmSnapshot(snap, { trigger });
    if (r.ok) lastResult = { at: Date.now(), trigger, ...r, ms: Date.now() - started };
    return r;
  } finally {
    running = false;
  }
}

export function startVmtrackPoller() {
  setInterval(async () => {
    if (running) return; // 재진입 가드
    try {
      const db = await getDb();
      if (!db) return; // DB 불가 — 기능 비활성(상태 API 가 사유를 노출)
      const cur = slotKey(new Date());
      const last = await lastSnapshotSlot();
      if (last === cur) {
        // 슬롯이 이미 채워짐 — 유지보수만 간헐 실행.
        if (Date.now() - lastPruneAt > PRUNE_EVERY_MS) { lastPruneAt = Date.now(); pruneVmtrack().catch(() => {}); }
        return;
      }
      const snap = store.get();
      if (!snap?.vcenters?.length) return; // 아직 첫 수집 전 — 다음 틱에 재시도
      await runVmtrackNow('slot');
      if (Date.now() - lastPruneAt > PRUNE_EVERY_MS) { lastPruneAt = Date.now(); pruneVmtrack().catch(() => {}); }
    } catch (e) {
      console.error('[vmtrack] 스냅샷 실패:', e.message);
    }
  }, TICK_MS).unref?.();
}
