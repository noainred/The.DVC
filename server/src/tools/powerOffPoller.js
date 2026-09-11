/**
 * tools/powerOffPoller.js — 전원 꺼짐 점검기(v2.484). 설정 주기(기본 6시간)마다 스냅샷의 꺼진 VM 을
 * power_off_seen 표에 기록한다: 처음 꺼진 것으로 보이면 off_since=지금, 계속 꺼져 있으면 last_seen 만 갱신,
 * 켜졌거나 사라지면 행 삭제(다음에 다시 꺼지면 새 구간). 그래서 off_since 는 '현재 꺼짐 구간' 의 관측 시작이며
 * 실제 꺼진 시각은 그 직전 점검과 이 점검 사이(정밀도 = 점검 주기) — 화면에는 '≥ N일 · 점검' 하한으로 표시.
 *
 * CLAUDE.md 규칙: 60초 틱 + 재진입 가드(수동 실행과 공유) + 설정은 매 틱 조회(재시작 없이 반영) + DB 단일 트랜잭션.
 * vCenter 왕복이 없고(스냅샷만 읽음) 쓰기는 꺼진 VM 수(수백 행)뿐이라 가볍다.
 */
import { store } from '../store.js';
import { loadPowerOffSettings } from './powerOffSettings.js';
import { commitPowerOffObservation, getDb, lastPowerOffObservationTs } from '../vmtrack/db.js';

const TICK_MS = 60_000;
let running = false;
let lastResult = null;   // { at, trigger, vcenters, offVms, newStreaks, cleared, ms }
let lastRunTs = 0;
let timer = null;

export function powerOffPollerStatus() {
  const s = loadPowerOffSettings();
  return { running, lastResult, lastRunTs, settings: s, nextRunTs: s.enabled && lastRunTs ? lastRunTs + s.intervalHours * 3_600_000 : null };
}

/** 점검 1회(수동/자동 공용). 진행 중이면 skipped. */
export async function runPowerOffCheckNow(trigger = 'manual', { now = Date.now() } = {}) {
  if (running) return { ok: false, skipped: true, reason: '이미 점검이 진행 중입니다.' };
  running = true;
  const started = Date.now();
  try {
    if (!(await getDb())) return { ok: false, reason: '추적 DB 사용 불가(node:sqlite 없음)' };
    const snap = store.get();
    if (!snap?.vcenters?.length) return { ok: false, reason: '수집된 vCenter 스냅샷이 없습니다(폴링 전).' };
    const perVc = new Map();
    for (const vc of snap.vcenters) perVc.set(vc.id, []);
    for (const v of snap.vms || []) {
      if (v.template || v.powerState === 'POWERED_ON') continue;
      if (!perVc.has(v.vcenterId)) perVc.set(v.vcenterId, []);
      perVc.get(v.vcenterId).push({ vmId: v.id, name: v.name || '' });
    }
    const r = await commitPowerOffObservation({ ts: now, perVc: [...perVc].map(([vcenterId, offVms]) => ({ vcenterId, offVms })) });
    lastRunTs = now;
    lastResult = { at: now, trigger, vcenters: perVc.size, offVms: r.offVms, newStreaks: r.inserted, cleared: r.deleted, ms: Date.now() - started };
    return { ok: true, ...lastResult };
  } finally {
    running = false;
  }
}

export function startPowerOffPoller() {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    try {
      const s = loadPowerOffSettings();   // 매 틱 조회 — 설정 변경이 재시작 없이 반영
      if (!s.enabled) return;
      if (!lastRunTs) { const t = await lastPowerOffObservationTs(); if (t) lastRunTs = t; } // 재시작 직후 즉시 재점검 방지
      if (Date.now() - lastRunTs < s.intervalHours * 3_600_000) return;
      if (!store.get()?.vcenters?.length) return;
      await runPowerOffCheckNow('auto');
    } catch (e) {
      console.error('[power-off] 점검 실패:', e.message);
    }
  }, TICK_MS);
  timer.unref?.();
}
