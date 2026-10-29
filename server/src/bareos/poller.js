/**
 * bareos/poller.js — Bareos 실행 상태 폴러(v2.820).
 *
 * 하는 일(주기 = 설정 pollIntervalSec, startAdaptiveTimer — 저장하면 즉시 재무장):
 *  ① 포탈이 시작한 실행(백업 pending·복원)만 `llist jobid=` 로 갱신 — 할 일이 없으면 **접속하지 않는다**.
 *  ② RECONCILE_EVERY 틱마다(첫 틱 포함) `.jobs`·`list jobs days=2` 로 대조 — Director 에서 사라진 잡 표시, Bareos 스케줄이 돌린
 *     실행을 lastRun 에 반영(포탈이 시작하지 않은 실행도 화면이 안다).
 * 규칙(docs/rules/perf-db.md · server/CLAUDE.md):
 *  - 재진입 가드(수동 '지금 조회' 와 공유) · 한 틱 전체 시한(withDeadline — 세션을 실제로 끊는다).
 *  - 인증 실패면 주기 조회를 멈춘다(service.withDirector) — 설정을 바꾸면 자동 재개. 0건이어도 상태(_last)를 남긴다(무음 실패 금지).
 *  - 데모 잡(demo:true)은 데모 Director 일 때만 조회한다(live 로 바꾸면 건너뛴다 — 원장에 남아도 실제 Director 에 묻지 않는다).
 */
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { withDeadline } from '../util/deadline.js';
import { loadSettings, onSettingsChange, directorConn } from './settings.js';
import { pendingWork, applyRunRow, applyRestoreRow, listJobs, patchJob } from './registry.js';
import { jobStatus, jobNames, recentJobs } from './director.js';
import { withDirector, isDemoActive, createBackupTarget } from './service.js';
import { ensureBareosDemo } from '../mock/demo/bareos.js';
import { store } from '../store.js';

export const RECONCILE_EVERY = 10;
export const MAX_PENDING_PER_TICK = 100;

let _busy = false;
let _tick = 0;
let _last = { at: null, ok: null, trigger: null, checked: 0, updated: 0, reconciled: false, error: '', configured: null };
let _timer = null;

export function pollerStatus() { return { ..._last, busy: _busy, running: !!_timer }; }

/**
 * 한 번 조회. @param {{ trigger?: 'timer'|'manual', reconcile?: boolean }} o
 */
export async function pollOnce({ trigger = 'timer', reconcile = null } = {}) {
  if (_busy) return { ...pollerStatus(), skipped: 'busy' };
  _busy = true;
  const at = Date.now();
  try {
    const settings = loadSettings();
    const demo = isDemoActive(settings);
    if (demo) {
      await ensureBareosDemo({ listJobs, createTarget: (o) => createBackupTarget({ ...o, by: 'demo' }), snapshot: store.get?.() }).catch(() => {});
    }
    if (!demo && !directorConn(settings).conn) {
      _last = { at, ok: null, trigger, checked: 0, updated: 0, reconciled: false, error: '', configured: false };
      return pollerStatus();
    }
    _tick += 1;
    const doReconcile = reconcile ?? (trigger !== 'timer' || _tick % RECONCILE_EVERY === 1);
    const work = pendingWork().filter((w) => (demo ? w.demo : !w.demo)).slice(0, MAX_PENDING_PER_TICK);
    if (!work.length && !doReconcile) {
      _last = { at, ok: true, trigger, checked: 0, updated: 0, reconciled: false, error: '', configured: true, idle: true, demo };
      return pollerStatus();
    }
    const budget = Math.max(30_000, (settings.director.timeoutMs || 15_000) * 4);
    const r = await withDeadline(budget, (signal) => withDirector(async (s) => {
      let checked = 0; let updated = 0;
      for (const w of work) {
        const row = await jobStatus(s, w.jobid);
        checked += 1;
        if (!row) continue;
        const res = w.kind === 'backup' ? applyRunRow(w.id, row) : applyRestoreRow(w.id, row);
        if (res) updated += 1;
      }
      let reconciled = false;
      if (doReconcile) {
        const mine = listJobs().filter((j) => (demo ? j.demo : !j.demo));
        if (mine.length) {
          const names = new Set(await jobNames(s));
          const rows = await recentJobs(s, 2);
          const newest = new Map();
          for (const row of rows) { const cur = newest.get(row.name); if (!cur || cur.jobid < row.jobid) newest.set(row.name, row); }
          for (const j of mine) {
            const missing = !names.has(j.bareosJob);
            if (missing !== !!j.missingInDirector) patchJob(j.id, { missingInDirector: missing });
            const row = newest.get(j.bareosJob);
            if (row) applyRunRow(j.id, row);
          }
        }
        reconciled = true;
      }
      return { checked, updated, reconciled };
    }, { trigger, signal }), 'Bareos 상태 조회 시한');
    _last = { at, ok: true, trigger, ...r, error: '', configured: true, demo };
  } catch (e) {
    _last = { at, ok: false, trigger, checked: 0, updated: 0, reconciled: false, error: String(e?.message || e).slice(0, 300), code: e?.code || '', configured: true };
    if (trigger === 'timer' && e?.code !== 'auth-stopped') console.warn(`[bareos] 상태 조회 실패: ${_last.error}`);
  } finally {
    _busy = false;
  }
  return pollerStatus();
}

export function startBareosPoller() {
  if (_timer) return;
  _timer = startAdaptiveTimer(
    () => (loadSettings().defaults.pollIntervalSec || 60) * 1000,
    () => pollOnce({ trigger: 'timer' }),
    { firstDelayMs: 50_000, name: 'Bareos 상태', subscribe: onSettingsChange },
  );
}

export function _resetPollerForTest() { _busy = false; _tick = 0; _last = { at: null, ok: null, trigger: null, checked: 0, updated: 0, reconciled: false, error: '', configured: null }; }
