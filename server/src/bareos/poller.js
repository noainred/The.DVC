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
import { pendingWork, applyRunRow, applyRestoreRow, listJobs, patchJob, inBatch, notePendingMiss, retiredNames, forgetRetired } from './registry.js';
import { jobStatus, jobStates, recentJobs, setJobEnabled } from './director.js';
import { withDirector, isDemoActive, createBackupTarget } from './service.js';
import { ensureBareosDemo } from '../mock/demo/bareos.js';
import { store } from '../store.js';

export const RECONCILE_EVERY = 10;
export const MAX_PENDING_PER_TICK = 100;

let _busy = false;
let _tick = 0;
let _last = { at: null, ok: null, trigger: null, checked: 0, updated: 0, reconciled: false, error: '', configured: null };
let _timer = null;
let _rot = 0;   // v2.822: 시한으로 잘린 틱이 목록 뒤쪽을 굶기지 않게 시작 위치를 돌린다
// v2.822.3(C2-3·P2-4·I2-9·P2-5 — 확인): 대조를 앞당겨야 할 때(자동 설정의 reload 가 꺼 둔 잡을 다시 켰다 · 시한에 잘려 대조를 못 끝냈다).
//   예전에는 다음 정기 대조(기본 10틱 ≈ 10분, 주기 상한이면 10시간)까지 지운·비활성 잡이 스케줄대로 돌았다.
let _reconcileDue = false;

/** 다음 기회에 대조한다 — 바쁘지 않으면 지금 한 번 돈다(주기 조회와 같은 가드·인증 정지 규칙). */
export function requestReconcile() {
  _reconcileDue = true;
  if (_busy) return;
  const t = setTimeout(() => { pollOnce({ trigger: 'timer', reconcile: true }).catch(() => {}); }, 0);
  t.unref?.();
}

/**
 * 상태(엣지 로그 spec 'collect.bareos' · 서비스 점검 · 화면). enabled = Director 가 설정됐거나 데모 Director —
 * 미설정이면 서비스 점검이 '꺼짐' 으로 칠한다(폴러는 돌지만 접속하지 않는다). 설정을 못 읽으면 켜진 것으로 둔다(모르는 것을 꺼짐으로 칠하지 않는다).
 */
export function pollerStatus() {
  let enabled = true;
  let intervalMs = null;
  try {
    const s = loadSettings();
    intervalMs = (s.defaults.pollIntervalSec || 60) * 1000;
    enabled = isDemoActive(s) || !!directorConn(s).conn;
  } catch { /* 위 주석 */ }
  return { ..._last, busy: _busy, running: !!_timer, enabled, intervalMs };
}

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
    const doReconcile = reconcile ?? (trigger !== 'timer' || _tick % RECONCILE_EVERY === 1 || _reconcileDue);
    const allWork = pendingWork().filter((w) => (demo ? w.demo : !w.demo));
    const off = allWork.length ? _rot % allWork.length : 0;
    const work = [...allWork.slice(off), ...allWork.slice(0, off)].slice(0, MAX_PENDING_PER_TICK);
    if (!work.length && !doReconcile) {
      _last = { at, ok: true, trigger, checked: 0, updated: 0, reconciled: false, error: '', configured: true, idle: true, demo };
      return pollerStatus();
    }
    const budget = Math.max(30_000, (settings.director.timeoutMs || 15_000) * 4);
    const r = await withDeadline(budget, (signal) => withDirector(async (s) => {
      let checked = 0; let updated = 0; let itemErrors = 0;
      for (const w of work) {
        if (signal.aborted) break;   // 시한 — 남은 것은 다음 틱(세션은 service.withDirector 가 끊는다)
        checked += 1;
        _rot += 1;
        let row;
        // 한 건의 명령 거부(jsonrpc)가 틱 전체를 멈추지 않게(C5) — 세션째 문제(끊김·시한)는 그대로 던진다
        try { row = await jobStatus(s, w.jobid); } catch (e) { if (e?.code !== 'jsonrpc') throw e; itemErrors += 1; continue; }
        // 카탈로그에 없거나(재시작·다른 Director) 이름이 다른 행(같은 jobid 를 다른 잡이 쓴다)은 이 실행이 아니다 — 연속이면 추적을 멈춘다(P5)
        //   복원은 복원 잡(type R)이어야 한다 — Director 가 바뀌어 jobid 가 다시 쓰이면 남의 백업 행을 복원 결과로 반영했다(W15)
        if (!row || (w.kind === 'backup' && row.name && w.job && row.name !== w.job) || (w.kind === 'restore' && row.type && row.type !== 'R')) { notePendingMiss(w.id, w.kind, w.jobid); continue; }
        const res = w.kind === 'backup' ? applyRunRow(w.id, row) : applyRestoreRow(w.id, row);
        if (res) updated += 1;
      }
      let reconciled = false;
      let redisabled = 0;
      if (doReconcile && signal.aborted) _reconcileDue = true;   // 시한에 잘려 대조를 못 했다 — 다음 틱에
      if (doReconcile && !signal.aborted) {
        const mine = listJobs().filter((j) => (demo ? j.demo : !j.demo));
        const retired = retiredNames().filter((r) => (demo ? r.demo : !r.demo));
        if (mine.length || retired.length) {
          const states = await jobStates(s);
          const rows = mine.length ? await recentJobs(s, 2) : [];
          const newest = new Map();
          for (const row of rows) {
            if (row.type && row.type !== 'B') continue;   // Copy(C)·Migration(M) 행은 같은 이름을 쓰지만 이 잡의 백업 실행이 아니다(C9)
            const cur = newest.get(row.name); if (!cur || cur.jobid < row.jobid) newest.set(row.name, row);
          }
          const toDisable = [];
          inBatch(() => {   // 원장 쓰기는 이 묶음 끝에 한 번(P2·I4)
            for (const j of mine) {
              const missing = !states.has(j.bareosJob);
              if (states.size > 0 && missing !== !!j.missingInDirector) patchJob(j.id, { missingInDirector: missing });   // 빈 응답으로 전부 '없음' 칠하지 않는다
              const row = newest.get(j.bareosJob);
              if (row) applyRunRow(j.id, row);
              // disable 은 Director 메모리 값이라 reload·재시작이면 다시 켜진다(I3) — 포탈이 끈 잡이 켜져 있으면 다시 끈다
              if (!j.enabled && states.get(j.bareosJob) === true) toDisable.push(j.bareosJob);
            }
          });
          const live = new Set(mine.map((j) => j.bareosJob));
          // v2.822.3(I2-5 — 재현): `.jobs` 가 한 번 비어 오면(ACL·일시 오류) 지운 잡 기록이 통째로 사라졌다 — 응답을 믿을 수 있을 때만 잊는다
          const trusted = states.size > 0 && (!mine.length || mine.some((j) => states.has(j.bareosJob)));
          const gone = [];
          for (const r of retired) {
            if (live.has(r.name)) continue;
            if (!states.has(r.name)) { if (trusted) gone.push(r.name); }   // 관리자가 conf 를 지웠다 — 더 볼 것 없다
            else if (states.get(r.name) === true) toDisable.push(r.name);
          }
          if (gone.length) forgetRetired(gone);
          let cut = false;
          for (const name of toDisable) {
            if (signal.aborted) { cut = true; break; }
            try { await setJobEnabled(s, name, false); redisabled += 1; } catch (e) { if (e?.code !== 'jsonrpc') throw e; itemErrors += 1; }
          }
          _reconcileDue = cut;   // 다시 끄기가 시한에 잘렸으면 다음 틱에 이어서(P2-5)
          if (redisabled) console.warn(`[bareos] Director 에서 다시 켜진 잡 ${redisabled}개를 다시 비활성화했습니다(reload·재시작 — disable 은 conf 에 남지 않는다).`);
        }
        reconciled = true;
        if (!mine.length && !retired.length) _reconcileDue = false;
      }
      return { checked, updated, reconciled, redisabled, itemErrors };
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
