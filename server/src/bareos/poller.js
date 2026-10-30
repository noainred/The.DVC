/**
 * bareos/poller.js — Bareos 실행 상태 폴러(v2.820 · v2.823 법인별 Director).
 *
 * 하는 일(주기 = 설정 pollIntervalSec, startAdaptiveTimer — 저장하면 즉시 재무장). **Director 마다 따로** 한다:
 *  ① 포탈이 시작한 실행(백업 pending·복원)만 `llist jobid=` 로 갱신 — 그 Director 에 할 일이 없으면 **접속하지 않는다**.
 *  ② RECONCILE_EVERY 틱마다(첫 틱 포함) `.jobs`·`list jobs days=2` 로 대조 — Director 에서 사라진 잡 표시, Bareos 스케줄이 돌린
 *     실행을 lastRun 에 반영, 포탈이 끈 잡·지운 잡이 reload 로 다시 켜졌으면 다시 끈다(I3).
 * 규칙(docs/rules/perf-db.md · server/CLAUDE.md · 루트 '느린 1개가 전체를 막지 않게'):
 *  - Director 들은 병렬(동시 DIRECTOR_CONCURRENCY) + **Director 마다 시한**(withDeadline — 세션을 실제로 끊는다). RTT 800ms 법인 하나가 나머지를 막지 않는다.
 *  - 재진입 가드(수동 '지금 조회' 와 공유) — 틱 전체가 끝날 때까지 다음 틱을 받지 않는다(각 Director 시한이 그 길이를 묶는다).
 *  - 인증 실패면 **그 Director 의** 주기 조회만 멈춘다(service.withDirector) — 설정을 바꾸면 자동 재개. 0건이어도 상태(_last)를 남긴다(무음 실패 금지).
 *  - 데모 잡(demo:true)은 데모 Director 일 때만 조회한다(live 로 바꾸면 건너뛴다 — 원장에 남아도 실제 Director 에 묻지 않는다).
 *  - 원장 반영은 Director 작업(ops.poll)이 돌아온 뒤 동기로(inBatch — 쓰기는 한 번).
 */
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { withDeadline } from '../util/deadline.js';
import { poolSettled } from '../util/pool.js';
import { loadSettings, onSettingsChange, directorConn, jobDirectorId } from './settings.js';
import { pendingWork, applyRunRow, applyRestoreRow, listJobs, patchJob, inBatch, notePendingMiss, retiredNames, forgetRetired } from './registry.js';
import { onDirector, isDemoActive, effectiveSettings, createBackupTarget } from './service.js';
import { ensureBareosDemo } from '../mock/demo/bareos.js';
import { store } from '../store.js';

export const RECONCILE_EVERY = 10;
export const MAX_PENDING_PER_TICK = 100;   // Director 하나에 한 틱
export const DIRECTOR_CONCURRENCY = 4;

let _busy = false;
let _tick = 0;
const EMPTY_LAST = Object.freeze({ at: null, ok: null, trigger: null, checked: 0, updated: 0, reconciled: false, error: '', configured: null });
let _last = { ...EMPTY_LAST };
/** Director 별 마지막 결과 — 화면의 Director 상태 칩. 지운 Director 는 다음 틱에 빠진다. */
let _byDir = new Map();
let _timer = null;
const _rot = new Map();   // v2.822: 시한으로 잘린 틱이 목록 뒤쪽을 굶기지 않게 시작 위치를 돌린다(Director 마다)
// v2.822.3(C2-3·P2-5): 대조를 앞당겨야 할 Director(자동 설정의 reload 가 꺼 둔 잡을 다시 켰다 · 시한에 잘려 대조를 못 끝냈다).
const _reconcileDue = new Set();
let _reconcileAll = false;

/**
 * 다음 기회에 대조한다 — 바쁘지 않으면 지금 한 번 돈다(주기 조회와 같은 가드·인증 정지 규칙).
 * @param {string} [directorId] 그 Director 만(자동 설정 뒤). 없으면 전부.
 */
export function requestReconcile(directorId = '') {
  if (directorId) _reconcileDue.add(directorId); else _reconcileAll = true;
  if (_busy) return;
  const t = setTimeout(() => { pollOnce({ trigger: 'timer' }).catch(() => {}); }, 0);
  t.unref?.();
}

/**
 * 상태(엣지 로그 spec 'collect.bareos' · 서비스 점검 · 화면). enabled = 접속할 Director 가 하나라도 있거나 데모 Director —
 * 미설정이면 서비스 점검이 '꺼짐' 으로 칠한다(폴러는 돌지만 접속하지 않는다). 설정을 못 읽으면 켜진 것으로 둔다.
 */
export function pollerStatus() {
  let enabled = true;
  let intervalMs = null;
  try {
    const s = loadSettings();
    intervalMs = (s.defaults.pollIntervalSec || 60) * 1000;
    enabled = isDemoActive(s) || s.directors.some((d) => !!directorConn(d).conn);
  } catch { /* 위 주석 */ }
  return { ..._last, busy: _busy, running: !!_timer, enabled, intervalMs, directors: Object.fromEntries(_byDir) };
}

/** Director 하나 조회(시한 안). 원장 반영까지. 던지지 않는다 — 결과 객체. */
async function pollDirector(d, { work, mine, retired, doReconcile, trigger, at, demo }) {
  const base = { at, name: d.name, trigger };
  const rot = _rot.get(d.id) || 0;
  const off = work.length ? rot % work.length : 0;
  const slice = [...work.slice(off), ...work.slice(0, off)].slice(0, MAX_PENDING_PER_TICK);
  const due = doReconcile || _reconcileDue.has(d.id);
  if (!slice.length && !due) return { ...base, ok: true, checked: 0, updated: 0, reconciled: false, error: '', idle: true };
  const live = new Set(mine.map((j) => j.bareosJob));
  const disableIfEnabled = [...mine.filter((j) => !j.enabled).map((j) => j.bareosJob), ...retired.filter((r) => !live.has(r.name)).map((r) => r.name)];
  const reconcileNow = due && (mine.length > 0 || retired.length > 0);
  const budget = Math.max(30_000, (d.timeoutMs || 15_000) * 4);
  try {
    const r = await withDeadline(budget, (signal) => onDirector(d.id, 'poll',
      { work: slice.map((w) => ({ jobid: w.jobid })), reconcile: reconcileNow, disableIfEnabled, recent: mine.length > 0 },
      { trigger, signal }), `Bareos 상태 조회 시한(${d.name})`);
    _rot.set(d.id, rot + r.rows.length);
    let updated = 0;
    const byJobid = new Map(slice.map((w) => [w.jobid, w]));
    inBatch(() => {   // 원장 쓰기는 이 묶음 끝에 한 번(P2·I4)
      for (const { jobid, row } of r.rows) {
        const w = byJobid.get(jobid);
        if (!w) continue;
        // 카탈로그에 없거나(재시작·다른 Director) 이름이 다른 행은 이 실행이 아니다 — 연속이면 추적을 멈춘다(P5)
        //   복원은 복원 잡(type R)이어야 한다(W15 — jobid 재사용으로 남의 백업 행을 반영하지 않게)
        if (!row || (w.kind === 'backup' && row.name && w.job && row.name !== w.job) || (w.kind === 'restore' && row.type && row.type !== 'R')) { notePendingMiss(w.id, w.kind, w.jobid); continue; }
        if (w.kind === 'backup' ? applyRunRow(w.id, row) : applyRestoreRow(w.id, row)) updated += 1;
      }
      if (r.reconciled) {
        const states = new Map(r.states || []);
        const newest = new Map();
        for (const row of r.recent || []) {
          if (row.type && row.type !== 'B') continue;   // Copy(C)·Migration(M) 행은 같은 이름을 쓰지만 이 잡의 백업 실행이 아니다(C9)
          const cur = newest.get(row.name); if (!cur || cur.jobid < row.jobid) newest.set(row.name, row);
        }
        for (const j of mine) {
          const missing = !states.has(j.bareosJob);
          if (states.size > 0 && missing !== !!j.missingInDirector) patchJob(j.id, { missingInDirector: missing });   // 빈 응답으로 전부 '없음' 칠하지 않는다
          const row = newest.get(j.bareosJob);
          if (row) applyRunRow(j.id, row);
        }
      }
    });
    if (r.reconciled) {
      // v2.822.3(I2-5 — 재현): `.jobs` 가 한 번 비어 오면 지운 잡 기록이 통째로 사라졌다 — 응답을 믿을 수 있을 때만 잊는다
      const states = new Map(r.states || []);
      const trusted = states.size > 0 && (!mine.length || mine.some((j) => states.has(j.bareosJob)));
      const gone = trusted ? retired.filter((x) => !live.has(x.name) && !states.has(x.name)).map((x) => x.name) : [];
      if (gone.length) forgetRetired(d.id, gone);
      if (r.redisabled.length) console.warn(`[bareos] ‘${d.name}’ Director 에서 다시 켜진 잡 ${r.redisabled.length}개를 다시 비활성화했습니다(reload·재시작 — disable 은 conf 에 남지 않는다).`);
    }
    if (due) { if (r.cut || (reconcileNow && !r.reconciled)) _reconcileDue.add(d.id); else _reconcileDue.delete(d.id); }   // 시한에 잘렸으면 다음 틱에(P2-5)
    return { ...base, ok: true, checked: r.rows.length, updated, reconciled: !!r.reconciled || (due && !reconcileNow), redisabled: r.redisabled.length, itemErrors: r.itemErrors, error: '', demo };
  } catch (e) {
    if (due) _reconcileDue.add(d.id);
    const error = String(e?.message || e).slice(0, 300);
    if (trigger === 'timer' && e?.code !== 'auth-stopped') console.warn(`[bareos] ‘${d.name}’ 상태 조회 실패: ${error}`);
    return { ...base, ok: false, checked: 0, updated: 0, reconciled: false, error, code: e?.code || '' };
  }
}

/**
 * 한 번 조회. @param {{ trigger?: 'timer'|'manual', reconcile?: boolean, directorId?: string }} o
 */
export async function pollOnce({ trigger = 'timer', reconcile = null, directorId = '' } = {}) {
  if (_busy) return { ...pollerStatus(), skipped: 'busy' };
  _busy = true;
  const at = Date.now();
  try {
    const settings = loadSettings();
    const demo = isDemoActive(settings);
    if (demo) {
      await ensureBareosDemo({ listJobs, createTarget: (o) => createBackupTarget({ ...o, by: 'demo' }), snapshot: store.get?.() }).catch(() => {});
    }
    const eff = demo ? effectiveSettings() : settings;
    const ready = eff.directors.filter((d) => demo || !!directorConn(d).conn);
    // 지운 Director 의 상태는 버린다(화면에 남지 않게)
    const known = new Set(eff.directors.map((d) => d.id));
    for (const id of [..._byDir.keys()]) if (!known.has(id)) _byDir.delete(id);
    if (!ready.length) {
      _last = { ...EMPTY_LAST, at, trigger, configured: false };
      return pollerStatus();
    }
    _tick += 1;
    if (_reconcileAll) { for (const d of ready) _reconcileDue.add(d.id); _reconcileAll = false; }
    const doReconcile = reconcile ?? (trigger !== 'timer' || _tick % RECONCILE_EVERY === 1);
    const modeOk = (x) => (demo ? x.demo : !x.demo);
    const dirOfJob = (j) => jobDirectorId(j, eff);
    const work = pendingWork().filter(modeOk);
    const jobs = listJobs().filter(modeOk);
    const retired = retiredNames().filter(modeOk);
    const targets = directorId ? ready.filter((d) => d.id === directorId) : ready;
    const results = await poolSettled(targets, DIRECTOR_CONCURRENCY, (d) => pollDirector(d, {
      work: work.filter((w) => (w.directorId || dirOfJob(w)) === d.id),
      mine: jobs.filter((j) => dirOfJob(j) === d.id),
      retired: retired.filter((r) => r.directorId === d.id),
      doReconcile, trigger, at, demo,
    }));
    const per = results.map((x, i) => (x.status === 'fulfilled' ? x.value : { at, name: targets[i].name, ok: false, error: String(x.reason?.message || x.reason).slice(0, 300), checked: 0, updated: 0 }));
    targets.forEach((d, i) => _byDir.set(d.id, per[i]));
    const bad = per.filter((x) => !x.ok);
    _last = {
      at, trigger, configured: true, demo,
      ok: bad.length === 0,
      checked: per.reduce((a, x) => a + (x.checked || 0), 0),
      updated: per.reduce((a, x) => a + (x.updated || 0), 0),
      reconciled: per.some((x) => x.reconciled),
      redisabled: per.reduce((a, x) => a + (x.redisabled || 0), 0),
      itemErrors: per.reduce((a, x) => a + (x.itemErrors || 0), 0),
      idle: per.every((x) => x.idle),
      directorsPolled: per.filter((x) => !x.idle).length,
      directorsFailed: bad.length,
      error: bad.length ? `${bad.length}개 Director 조회 실패 — ${bad.slice(0, 3).map((x) => `${x.name}: ${x.error}`).join(' · ')}`.slice(0, 600) : '',
      code: bad[0]?.code || '',
    };
  } catch (e) {
    _last = { ...EMPTY_LAST, at, ok: false, trigger, error: String(e?.message || e).slice(0, 300), code: e?.code || '', configured: true };
    if (trigger === 'timer') console.warn(`[bareos] 상태 조회 실패: ${_last.error}`);
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

export function _resetPollerForTest() { _busy = false; _tick = 0; _last = { ...EMPTY_LAST }; _byDir = new Map(); _rot.clear(); _reconcileDue.clear(); _reconcileAll = false; }
