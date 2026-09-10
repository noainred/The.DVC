/**
 * guestdisk/poller.js — 게스트 디스크 회수 리포트 주기 수집(v2.459).
 *
 * CLAUDE.md 규칙: 재진입 가드(진행 중이면 틱 건너뜀) + 수동 실행 API 와 가드 공유 +
 * vCenter 동시 수집 제한(한꺼번에 28대 로그인 방지). 기본 꺼짐(opt-in) — 설정에서 켜야 돈다.
 *
 * 게스트 파티션은 천천히 변하므로 주기는 시간 단위(기본 12h). 60초 틱으로 '주기 경과'만 확인한다.
 */
import { store } from '../store.js';
import { load as loadSettings } from './settings.js';
import { collectAndStore } from './service.js';
import { prune, getDb } from './db.js';

const TICK_MS = 60_000;
const CONCURRENCY = Math.max(1, Number(process.env.GUESTDISK_CONCURRENCY) || 4);

let running = false;       // 재진입 가드(폴러 + 수동 실행 공유)
let lastResult = null;     // { at, trigger, vcenters, vms, vmSeriesRows, partSeriesRows, ms, errors }
let lastRunTs = 0;
let lastPruneTs = 0;       // 보존 prune 스로틀(수집 enabled 와 무관하게 돈다 — 데이터가 push 로도 들어옴)
const PRUNE_EVERY_MS = 6 * 3_600_000; // 6h

export function guestDiskPollerStatus() { return { running, lastResult, lastRunTs }; }

/** 동시성 제한 실행 — items 를 최대 n 개씩 병렬로. */
async function pool(items, n, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]).catch((e) => ({ error: String(e.message || e) }));
    }
  });
  await Promise.all(workers);
  return results;
}

/** 전체 vCenter 수집 1회(수동/자동 공용). 진행 중이면 skipped. */
export async function runGuestDiskNow(trigger = 'manual') {
  if (running) return { ok: false, skipped: true, reason: '이미 수집이 진행 중입니다.' };
  running = true;
  const started = Date.now();
  try {
    const db = await getDb();
    if (!db) return { ok: false, reason: '게스트 디스크 DB 사용 불가(node:sqlite 없음)' };
    const s = loadSettings();
    const snap = store.get();
    const allVcs = snap.vcenters || [];
    if (!allVcs.length) return { ok: false, reason: '수집된 vCenter 스냅샷이 없습니다(폴링 전).' };
    // site 모드(엣지 위임) vCenter 는 중앙이 직접 SOAP 를 못 건다 — 라이브 조회하면 매번
    // 실패/타임아웃해 오류만 쌓인다. 그런 vCenter 의 게스트 디스크는 엣지가 /central/guest-disk 로
    // push 한다(agent/guestDiskPush.js). 여기서는 중앙이 직접 수집하는 vCenter 만 조회한다.
    const vcs = allVcs.filter((v) => v.collectSource !== 'site').map((v) => v.id);
    const siteDelegated = allVcs.length - vcs.length;
    if (!vcs.length) {
      lastRunTs = Date.now();
      lastResult = { at: lastRunTs, trigger, vcenters: 0, siteDelegated, vms: 0, vmSeriesRows: 0, partSeriesRows: 0, ms: Date.now() - started, errors: [] };
      return { ok: true, ...lastResult, note: `중앙 직접 수집 vCenter 없음 — site 위임 ${siteDelegated}개는 엣지 push 로 수신합니다.` };
    }
    let vms = 0; let vmSeriesRows = 0; let partSeriesRows = 0; const errors = [];
    const res = await pool(vcs, CONCURRENCY, (id) => collectAndStore(id, { changeThresholdGB: s.changeThresholdGB }));
    for (let k = 0; k < res.length; k++) {
      const r = res[k];
      if (!r || r.error) { errors.push({ vcenterId: vcs[k], error: r?.error || '알 수 없음' }); continue; }
      vms += r.withGuest;
      vmSeriesRows += r.commit?.vmSeriesRows || 0;
      partSeriesRows += r.commit?.partSeriesRows || 0;
    }
    await prune(s.retentionDays);
    lastRunTs = Date.now();
    lastResult = { at: lastRunTs, trigger, vcenters: vcs.length, siteDelegated, vms, vmSeriesRows, partSeriesRows, ms: Date.now() - started, errors };
    return { ok: true, ...lastResult };
  } finally {
    running = false;
  }
}

export function startGuestDiskPoller() {
  setInterval(async () => {
    if (running) return; // 재진입 가드
    try {
      const s = loadSettings();
      const db = await getDb();
      if (!db) return;                        // DB 불가 — 상태 API 가 사유 노출
      // 보존 prune 은 수집 enabled·site 위임 여부와 무관하게 돈다 — site 전용(순수 집계) 중앙은
      // 직접 수집이 없어 runGuestDiskNow 가 조기 반환하지만, guest-disk push 는 계속 series 를
      // 적재하므로 여기서 스로틀(6h) prune 을 걸지 않으면 보존기간이 영구 미적용돼 무한 증식한다.
      if (Date.now() - lastPruneTs >= PRUNE_EVERY_MS) {
        lastPruneTs = Date.now();
        try { await prune(s.retentionDays); } catch (e) { console.warn(`[guestdisk] prune 실패: ${e.message}`); }
      }
      if (!s.enabled) return;                 // opt-in — 주기 수집은 꺼져 있으면 안 한다(prune 은 위에서 이미 수행)
      const dueMs = Math.max(1, s.intervalHours) * 3_600_000;
      if (lastRunTs && Date.now() - lastRunTs < dueMs) return; // 주기 미경과
      await runGuestDiskNow('auto');
    } catch (e) {
      console.warn(`[guestdisk] 폴러 틱 오류: ${e.message}`);
    }
  }, TICK_MS).unref?.();
}
