/**
 * metrics/rollupBackfill.js — 롤업 도입(v2.252, 2026-08-08) 이전 원본을 시간당 롤업으로 옮긴다(v2.675).
 *
 * 왜: history() 는 롤업이 원본만큼 거슬러 올라가지 못하면(롤업 도입 이전 원본이 남은 키) **원본으로 폴백**한다(v2.600 DB2600-02).
 * 원본 보존 기본은 롤업과 같은 5년이고 ds_usedgb 는 분마다 쌓이므로, 긴 기간 차트 하나가 원본 수만~수십만 행을 동기로 집계했다
 * (v2.672 운영 장애의 한 갈래 — CLAUDE.md '남은 위험: 근본 해법은 롤업 이전 원본을 롤업으로 옮기는 백필'). 옮기고 나면
 * 롤업의 첫 시각이 원본 첫 표본과 같아져 history() 가 롤업을 쓴다(원본으로 떨어지지 않는다).
 *
 * 방식(db.rollupBackfillStep 머리말): 키마다 '롤업 첫 시각보다 이른 원본' 을 최근 쪽부터 한 조각씩 옮긴다 — 진행 상태를 따로
 * 저장하지 않아도 재시작 뒤 그 자리부터 이어진다. 끝나면 samples_meta 에 표지를 남겨 다음 기동부터는 건너뛴다.
 *
 * 부하: 원본을 한 번 읽어 시간당으로 묶는다(합성 실측 약 1~2µs/행). 일하는 시간과 쉬는 시간을 나눠(기본 40ms 일 · 80ms 쉼 ≈ 33%)
 * 포탈을 멈추지 않게 한다. 한 걸음(chunkHours 24 = 분 단위 1,440행)은 수 ms 다.
 *
 * 끄기: METRICS_ROLLUP_BACKFILL=0. 시작 지연: METRICS_ROLLUP_BACKFILL_DELAY_MS(기본 5분 — 기동 직후 첫 수집과 겹치지 않게).
 * 디스크 여유 하한: METRICS_ROLLUP_BACKFILL_MIN_FREE_GB(기본 5) — 아래로 내려가면 멈추고 다음 기동에 이어서 한다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getMetricsDb } from './db.js';
import { loadMetricsSettings } from './settings.js';
import { numOrNull } from '../util/numOrNull.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
export const BACKFILL_MARKER = 'rollupBackfill';
// 디스크 여유 가드 — 옮긴 롤업은 파일을 키운다(시간당 1행 · 원본 분 단위 60행당 1행 — 추정 원본 크기의 수 %).
//   여유가 이보다 적으면 멈추고(완료 표지 없음 — 다음 기동에 이어서 한다) 상태에 사유를 남긴다. 빈 값은 미지정(기본 5GB).
const MIN_FREE_BYTES = Math.max(0, numOrNull(process.env.METRICS_ROLLUP_BACKFILL_MIN_FREE_GB) ?? 5) * 1024 ** 3;
const DISK_CHECK_EVERY = 200;   // 걸음마다 statfs 를 부르지 않는다
function freeBytesOf(dir) {
  try { const st = fs.statfsSync(dir); return Number(st.bavail) * Number(st.bsize); } catch { return null; }   // 모르면 막지 않는다
}

const status = {
  state: 'idle',          // idle | waiting | running | done | error | unsupported | off | disk-low
  startedAt: null, finishedAt: null,
  metrics: 0, keysTotal: 0, keysDone: 0, keysFilled: 0,
  rows: 0, hours: 0, steps: 0, stuckKeys: 0,
  lastError: null,
  marker: null,           // 완료 표지(이전 실행이 남긴 것 포함)
};
let running = null;
let timer = null;

/** 화면·서비스 점검용 상태(사본). */
export function rollupBackfillStatus() { return { ...status }; }

/** 테스트 전용 — 상태를 처음으로. */
export function _resetRollupBackfillForTest() {
  Object.assign(status, { state: 'idle', startedAt: null, finishedAt: null, metrics: 0, keysTotal: 0, keysDone: 0, keysFilled: 0, rows: 0, hours: 0, steps: 0, stuckKeys: 0, lastError: null, marker: null });
  running = null;
  if (timer) { clearTimeout(timer); timer = null; }
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * 한 번 끝까지 돈다(진행 중이면 그 실행을 돌려준다 — 동시 실행 1건).
 * @param {{db?:object, workMs?:number, restMs?:number, chunkHours?:number, nowTs?:number, force?:boolean,
 *   minFreeBytes?:number, freeBytes?:()=>number|null}} opts
 *   force: 완료 표지가 있어도 다시 훑는다(테스트·진단용 — 옮길 것이 없으면 키마다 탐색 2회로 끝난다).
 *   minFreeBytes·freeBytes: 디스크 여유 가드(기본 env·statfs — 테스트가 바꾼다).
 */
export function runRollupBackfill(opts = {}) {
  if (running) return running;
  running = (async () => {
    const db = opts.db || await getMetricsDb();
    if (!db || db.kind !== 'sqlite' || typeof db.rollupBackfillStep !== 'function') {
      status.state = 'unsupported';
      return rollupBackfillStatus();
    }
    const marker = typeof db.metaValue === 'function' ? db.metaValue(BACKFILL_MARKER) : null;
    if (marker && marker.doneAt && !opts.force) {
      Object.assign(status, { state: 'done', marker });
      return rollupBackfillStatus();
    }
    const now = Number.isFinite(opts.nowTs) ? opts.nowTs : Date.now();
    const workMs = Number.isFinite(opts.workMs) && opts.workMs > 0 ? opts.workMs : 40;
    const restMs = Number.isFinite(opts.restMs) && opts.restMs >= 0 ? opts.restMs : 80;
    const chunkHours = Number.isFinite(opts.chunkHours) && opts.chunkHours > 0 ? opts.chunkHours : 24;
    let retentionDays = 0;
    try { retentionDays = Number(loadMetricsSettings().retentionDays) || 0; } catch { retentionDays = 0; }
    // 롤업 보존 밖(곧 지워질 시간)은 옮기지 않는다. 보존 0(무제한)이면 전부.
    const minTs = retentionDays > 0 ? now - retentionDays * DAY : 0;
    const capTs = Math.floor(now / HOUR) * HOUR;
    const minFree = Number.isFinite(opts.minFreeBytes) ? opts.minFreeBytes : MIN_FREE_BYTES;
    const freeOf = typeof opts.freeBytes === 'function' ? opts.freeBytes : () => freeBytesOf(path.dirname(config.temp.dbPath));
    const diskLow = () => { const f = freeOf(); return f != null && Number.isFinite(f) && f < minFree ? f : null; };
    const t0 = Date.now();   // 실제 시작 시각(now 는 판정 기준이라 테스트가 고정할 수 있다 — 소요 시간·상태 시각은 실제 시계로)
    Object.assign(status, { state: 'running', startedAt: t0, finishedAt: null, metrics: 0, keysTotal: 0, keysDone: 0, keysFilled: 0, rows: 0, hours: 0, steps: 0, stuckKeys: 0, lastError: null });
    let windowStart = performance.now();
    const throttle = async () => {
      if (performance.now() - windowStart < workMs) return;
      if (restMs > 0) await sleep(restMs); else await new Promise((r) => { setImmediate(r); });
      windowStart = performance.now();
    };
    try {
      const stopForDisk = (free) => {
        const gb = (x) => (x / 1024 ** 3).toFixed(1);
        Object.assign(status, { state: 'disk-low', finishedAt: Date.now(), lastError: `디스크 여유 ${gb(free)}GB — 하한 ${gb(minFree)}GB 아래라 멈췄습니다(옮긴 부분은 남고 다음 기동에 이어서 합니다).` });
        console.warn(`[metrics] 롤업 백필 중단 — ${status.lastError}`);
      };
      const low0 = diskLow();
      if (low0 != null) { stopForDisk(low0); return rollupBackfillStatus(); }
      const metrics = db.rollupBackfillMetrics();
      status.metrics = metrics.length;
      for (const metric of metrics) {
        const keys = db.rollupBackfillKeys(metric);
        status.keysTotal += keys.length;
        await throttle();
        for (const k of keys) {
          let filled = false;
          for (;;) {
            const r = db.rollupBackfillStep(metric, k, { minTs, chunkHours, capTs });
            status.steps++;
            if (r.done) break;
            status.rows += r.rows; status.hours += r.hours;
            // 걸음은 언제나 롤업의 첫 시각을 앞당긴다(db.rollupBackfillStep 머리말의 불변식). 앞당기지 못했으면 같은 걸음을 영원히
            //   되풀이하게 되므로 이 키를 그만두고 센다(조용히 넘기지 않는다 — 상태·로그에 남는다).
            if (!(r.hours > 0)) { status.stuckKeys = (status.stuckKeys || 0) + 1; console.warn(`[metrics] 롤업 백필 — ${metric}/${k} 가 진행하지 못해 건너뜁니다(걸음 ${status.steps}).`); break; }
            if (r.hours > 0) filled = true;
            if (status.steps % DISK_CHECK_EVERY === 0) { const low = diskLow(); if (low != null) { stopForDisk(low); return rollupBackfillStatus(); } }
            await throttle();
          }
          status.keysDone++;
          if (filled) status.keysFilled++;
          await throttle();
        }
      }
      const doneMarker = { doneAt: Date.now(), keys: status.keysTotal, keysFilled: status.keysFilled, rows: status.rows, hours: status.hours };
      try { db.setMetaValue?.(BACKFILL_MARKER, doneMarker); } catch (e) { console.warn(`[metrics] 롤업 백필 완료 표지 저장 실패(다음 기동에 다시 훑는다): ${e.message}`); }
      Object.assign(status, { state: 'done', finishedAt: Date.now(), marker: doneMarker });
      if (status.keysFilled > 0) {
        console.log(`[metrics] 롤업 백필 완료 — 옛 원본 ${status.rows.toLocaleString()}행을 시간당 ${status.hours.toLocaleString()}행으로 옮겼습니다(키 ${status.keysFilled}/${status.keysTotal}, ${Math.round((Date.now() - t0) / 1000)}초). 긴 기간 차트가 원본 대신 롤업을 씁니다.`);
      } else {
        console.log(`[metrics] 롤업 백필 — 옮길 옛 원본이 없습니다(키 ${status.keysTotal}개 확인).`);
      }
    } catch (e) {
      Object.assign(status, { state: 'error', finishedAt: Date.now(), lastError: String(e?.message || e).slice(0, 300) });
      console.warn(`[metrics] 롤업 백필 실패(다음 기동에 이어서 한다 — 옮긴 부분은 남는다): ${status.lastError}`);
    }
    return rollupBackfillStatus();
  })().finally(() => { running = null; });
  return running;
}

/** 기동 시 한 번 예약(sampler 가 부른다). 꺼져 있으면 상태만 'off'. */
export function scheduleRollupBackfill() {
  if (String(process.env.METRICS_ROLLUP_BACKFILL ?? '').trim() === '0') { status.state = 'off'; return; }
  if (timer) return;
  // 빈 값(KEY=)은 미지정이다 — Number('') === 0 이 '지연 0'(기동 직후 첫 수집과 겹침)이 되지 않게(v2.618 numEnv 규약).
  const raw = numOrNull(process.env.METRICS_ROLLUP_BACKFILL_DELAY_MS);
  const delay = raw != null && raw >= 0 ? Math.min(raw, 24 * HOUR) : 5 * 60_000;
  status.state = 'waiting';
  timer = setTimeout(() => { timer = null; runRollupBackfill().catch(() => {}); }, delay);
  timer.unref?.();
}
