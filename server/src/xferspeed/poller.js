/**
 * xferspeed/poller.js — 법인 간 전송 속도 측정 폴러(v2.735, **중앙 전용**).
 *
 * 한 주기 = 대상 엣지마다 ↓(엣지 → 메인) 다음 ↑(메인 → 엣지)를 차례로 잰다. 같은 엣지의 두 방향을 동시에 재지 않는다
 * (서로의 회선을 나눠 쓰면 둘 다 깎인다). 엣지끼리는 `concurrency`(기본 1 — 가장 정확)만큼만 겹친다.
 *
 * 규약(루트 CLAUDE.md 폴러 규약):
 *  · **재진입 가드**를 수동 실행('지금 측정')과 공유한다 — 연타가 회선 사용을 곱하지 않게.
 *  · **30초 틱**(`tickXferSchedule`)이 간격 실행과 예약 실행(1회·매일·매주·매월 — `schedule.js`)을 함께 판정한다.
 *    간격은 '마지막 실행 시작 + intervalMs' 라 예약으로 실행해도 바로 이어 돌지 않는다. 틱은 측정을 기다리지 않고
 *    시작만 한다 — 그래야 측정 중에 지난 예약 시각을 '이전 측정이 길어짐' 으로 알 수 있다. 예약 처리 기록은
 *    `xfer-speed-schedule-state.json`(상태 파일)에 남긴다 — 재시작 뒤 같은 시각을 두 번 실행하지 않게.
 *    틱은 `startAdaptiveTimer` 이고 설정 변경 알림으로 즉시 다시 잡는다(v2.409).
 *  · ⚠⚠ **주기 예산**: 한 주기가 주기를 넘기면 재진입 가드가 다음 틱을 계속 건너뛴다. 그래서 주기의 80% 가 지나면
 *    **새 엣지를 시작하지 않고** 그 엣지들을 `notTried` 로 밝힌다(조용히 빼지 않는다). 순서는 '가장 오래 안 잰 엣지 먼저' 라
 *    매번 같은 엣지가 밀리지 않는다.
 *  · prune 스로틀 `(++tick % N) === 0`(기동 첫 틱 즉발 금지 — v2.453).
 *  · 엣지 노드(CENTRAL_URL 있음)에서는 돌지 않는다 — 측정은 중앙이 주도한다(엣지는 `/api/collector/xfer-test` 상대일 뿐).
 *  · 데모(mock) 모드: 데모 엣지에는 접속하지 않고 합성값을 적재한다. 사람이 등록한 엣지는 mock 모드에서도 실제로 잰다(v2.708 규약).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { poolSettled } from '../util/pool.js';
import { loadCollectors } from '../collector/registry.js';
import { isMockMode } from '../mock/demo/flags.js';
import { isDemoCollector } from '../mock/demo/edge.js';
import { demoXferResult } from '../mock/demo/xferspeed.js';
import { loadXferSpeedSettings, xferSpeedEnabled, onXferSpeedSettingsChange, isExcluded } from './settings.js';
import { measureDown, measureUp } from './probe.js';
import { insertSamples, pruneXferSpeed, latestAll } from './db.js';
import { planTick, nextRunOf, nextOccurrence, GRACE_MS } from './schedule.js';
import { DAY_OFFSET_MIN } from '../util/dayKey.js';

/** 판정 틱 — 예약 시각의 정밀도이기도 하다(최대 이만큼 늦게 시작한다). */
export const TICK_MS = 30_000;
/** 예약 실행 한 번의 예산(그 뒤에는 새 엣지를 시작하지 않는다). 간격 실행은 간격의 80%. */
export const SCHEDULE_BUDGET_MS = 60 * 60_000;
const FIRST_TICK_DELAY_MS = 90_000;
const BOOT_AT = Date.now();

registerStateFile('xfer-speed-schedule-state.json');
const STATE_FILE = () => path.join(config.configDir, 'xfer-speed-schedule-state.json');

/** 예약 처리 기록 — { [일정 id]: { lastAt, result:'ran'|'missed', reason?, at } }. 손상이면 보존하고 새로 시작한다. */
export function loadScheduleState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    const m = j && typeof j === 'object' && !Array.isArray(j) && j.schedules && typeof j.schedules === 'object' ? j.schedules : {};
    const out = {};
    for (const [id, v] of Object.entries(m)) if (v && typeof v === 'object' && Number.isFinite(Number(v.lastAt))) out[id] = v;
    return out;
  } catch (e) {
    if (e?.code !== 'ENOENT') { try { preserveCorrupt(STATE_FILE()); } catch { /* best effort */ } }
    return {};
  }
}
function saveScheduleState(state, settings) {
  const keep = new Set((settings?.schedules || []).map((x) => x.id));
  const out = {};
  for (const [id, v] of Object.entries(state || {})) if (keep.has(id)) out[id] = v;   // 지운 일정의 기록은 버린다
  try { atomicWriteFileSync(STATE_FILE(), `${JSON.stringify({ v: 1, schedules: out }, null, 2)}\n`, { mode: 0o600 }); }
  catch (e) { console.warn(`[xferspeed] 예약 처리 기록을 쓰지 못했습니다(재시작하면 같은 시각을 다시 볼 수 있습니다): ${e?.message || e}`); }
}

const isEdgeNode = () => !!String(config.agent?.centralUrl || '').trim();
const t = (v) => String(v ?? '').trim();
const randomBytesAsync = (n) => new Promise((resolve, reject) => crypto.randomBytes(n, (e, b) => (e ? reject(e) : resolve(b))));

let running = false;
let _last = null;
let _progress = null;
let _timer = null;
let _tick = 0;
let _lastRunAt = null;          // 마지막 실행 시작(간격 판정) — 첫 틱에 DB 의 마지막 측정 시각으로 채운다
let _lastRunKnown = false;
const _spans = [];              // 최근 실행 구간 { start, end } — 놓친 예약이 '측정이 길어져서' 인지 판단
const wasBusy = (occ) => (running && _progress && occ >= _progress.startedAt) || _spans.some((sp) => occ >= sp.start && occ <= sp.end + TICK_MS);

export function xferSpeedStatus(now = Date.now()) {
  const s = loadXferSpeedSettings();
  const enabled = xferSpeedEnabled(s);
  const state = loadScheduleState();
  let next = isEdgeNode() ? null : nextRunOf({ settings: s, state, now, lastRunAt: _lastRunAt, enabled });
  // 첫 틱 전(기동 직후)에는 '곧' 이 아니라 첫 틱 시각이다.
  if (next && !_lastRunKnown && _timer) next = { ...next, at: Math.max(next.at, BOOT_AT + FIRST_TICK_DELAY_MS) };
  return {
    enabled, running, role: isEdgeNode() ? 'edge' : 'central',
    ...(isMockMode() ? { demo: true } : {}),
    intervalOn: s.intervalOn, intervalMs: s.intervalMs, concurrency: s.concurrency, sizeMB: s.sizeMB,
    lastRunAt: _lastRunAt, graceMs: GRACE_MS, tickMs: TICK_MS, offsetMin: DAY_OFFSET_MIN, next,
    schedules: s.schedules.map((x) => {
      const rec = state[x.id] || null;
      const after = Math.max(now - 1, Number(x.since) || 0, Number(rec?.lastAt) || 0);
      return { id: x.id, next: x.enabled ? nextOccurrence(x, after) : null, last: rec };
    }),
    progress: _progress ? { ..._progress, current: [..._progress.current] } : null,
    last: _last,
  };
}

/**
 * 측정 대상(순수) — 등록부에서 켜져 있고 URL 이 있는 수집 서버. 제외 목록은 빼고 **개수와 이름을 밝힌다**.
 * @returns {{targets:object[], skipped:{id:string, reason:string}[]}}
 */
export function xferTargets(collectors = [], settings = {}, { only = '' } = {}) {
  const targets = []; const skipped = [];
  const want = t(only).toLowerCase();
  for (const c of Array.isArray(collectors) ? collectors : []) {
    if (!c || typeof c !== 'object') continue;
    const id = t(c.id || c.name);
    if (!id) continue;
    if (want && id.toLowerCase() !== want && t(c.name).toLowerCase() !== want) continue;
    if (c.enabled === false) { skipped.push({ id, reason: 'disabled-central' }); continue; }
    if (!t(c.url)) { skipped.push({ id, reason: 'no-url' }); continue; }
    if (!want && isExcluded(settings, id, c.name)) { skipped.push({ id, reason: 'excluded' }); continue; }
    targets.push(c);
  }
  return { targets, skipped };
}

/** 가장 오래 안 잰 엣지 먼저(없으면 맨 앞) — 주기 예산에 걸려도 같은 엣지가 매번 밀리지 않는다. */
export function orderTargets(targets, latestRows = []) {
  const last = new Map();
  for (const r of latestRows) {
    const k = t(r.agent).toLowerCase();
    last.set(k, Math.max(last.get(k) ?? 0, Number(r.ts) || 0));
  }
  return [...targets].sort((a, b) => (last.get(t(a.id || a.name).toLowerCase()) ?? 0) - (last.get(t(b.id || b.name).toLowerCase()) ?? 0));
}

/** 한 엣지 — ↓ 다음 ↑. 데모 엣지는 합성. */
async function measureEdge(col, s, trig) {
  const bytes = s.sizeMB * 1_048_576;
  const agent = t(col.id || col.name);
  if (isMockMode() && isDemoCollector(col)) {
    const ts = Date.now();
    return [demoXferResult(col, 'down', { ts, bytes }), demoXferResult(col, 'up', { ts: ts + 1, bytes })].map((r) => ({ ...r, agent, trig }));
  }
  const down = await measureDown(col, { bytes, timeoutMs: s.timeoutMs });
  const payload = await randomBytesAsync(bytes);
  const up = await measureUp(col, { bytes, timeoutMs: s.timeoutMs, payload });
  // 같은 엣지·같은 ms 에 두 방향이 겹치면 PK(agent, dir, ts)는 다르지만, 화면 시간 정렬이 흔들리지 않게 시작 시각을 쓴다.
  return [down, up].map((r) => ({ ...r, agent, trig }));
}

/**
 * 한 주기. 수동 실행(`trigger:'manual'`)도 **같은 가드**를 쓴다. `only` 를 주면 그 엣지 하나만(제외 목록 무시 — 사람이 고른 것).
 */
export async function runXferCycle({ trigger = 'timer', only = '', scheduleIds = [] } = {}) {
  if (isEdgeNode()) return { ok: false, skipped: 'edge-node' };
  if (running) return { ok: false, skipped: 'already-running' };
  const s = loadXferSpeedSettings();
  if (trigger !== 'manual' && !xferSpeedEnabled(s)) return { ok: false, skipped: 'disabled' };
  running = true;
  if (isMockMode()) await demoBackfillXfer().catch(() => {});   // 데모 — 첫 측정 전에 14일 이력(한 번만, 이력이 있으면 덮지 않는다)
  const startedAt = Date.now();
  // 예산: 간격의 80%(수동 전체 실행은 30분, 예약 실행은 60분). 그 뒤에는 새 엣지를 시작하지 않는다.
  const budgetMs = trigger === 'manual' ? Math.min(30 * 60_000, s.intervalMs) : trigger === 'schedule' ? SCHEDULE_BUDGET_MS : Math.floor(s.intervalMs * 0.8);
  // 간격은 '마지막 실행 시작' 부터 다시 센다 — 한 엣지만 고른 수동 실행은 전체 주기가 아니라 세지 않는다.
  if (!t(only)) { _lastRunAt = startedAt; _lastRunKnown = true; }
  const span = { start: startedAt, end: Number.MAX_SAFE_INTEGER };
  _spans.push(span); while (_spans.length > 10) _spans.shift();
  const deadline = startedAt + budgetMs;
  try {
    const { targets, skipped } = xferTargets(loadCollectors(), s, { only });
    const ordered = orderTargets(targets, await latestAll());
    _progress = { startedAt, total: ordered.length, done: 0, current: new Set(), trigger, only: t(only) || null, scheduleIds: [...scheduleIds] };
    const notTried = [];
    let measured = 0; let failed = 0; let dbErrors = 0; let lastDbError = '';
    await poolSettled(ordered, s.concurrency, async (col) => {
      const name = t(col.id || col.name);
      if (Date.now() > deadline) { notTried.push(name); return; }
      _progress.current.add(name);
      try {
        const rows = await measureEdge(col, s, trigger);
        const saved = await insertSamples(rows);
        if (!saved.ok) { dbErrors += 1; lastDbError = saved.error || ''; }
        measured += 1;
        if (rows.some((r) => !r.ok)) failed += 1;
      } finally {
        _progress.current.delete(name);
        _progress.done += 1;
      }
    });
    if (notTried.length) console.warn(`[xferspeed] 주기 예산(${Math.round(budgetMs / 60_000)}분)을 넘겨 ${notTried.length}곳은 이번 주기에 재지 못했습니다 — 다음 주기에 먼저 잽니다: ${notTried.slice(0, 10).join(', ')}${notTried.length > 10 ? ' …' : ''}`);
    if (dbErrors) console.warn(`[xferspeed] 측정 ${dbErrors}건을 DB 에 쓰지 못했습니다: ${lastDbError}`);
    if ((++_tick % 12) === 0) await pruneXferSpeed({ sampleDays: s.sampleRetentionDays, dailyDays: s.dailyRetentionDays });
    _last = {
      at: startedAt, finishedAt: Date.now(), ms: Date.now() - startedAt, trigger, only: t(only) || null,
      ...(scheduleIds.length ? { scheduleIds: [...scheduleIds] } : {}),
      targets: ordered.length, measured, failed, notTried: notTried.length, notTriedNames: notTried.slice(0, 20),
      skipped: skipped.length, skippedReasons: skipped.slice(0, 20),
      dbOk: dbErrors === 0, dbError: lastDbError.slice(0, 200),
    };
    return { ok: true, ...(_last) };
  } catch (e) {
    _last = { at: startedAt, finishedAt: Date.now(), ms: Date.now() - startedAt, trigger, error: String(e?.message || e).slice(0, 300) };
    console.warn(`[xferspeed] 측정 주기 실패: ${_last.error}`);
    return { ok: false, error: _last.error };
  } finally {
    span.end = Date.now();
    running = false;
    _progress = null;
  }
}

/** DB 의 마지막 측정 시각(간격 판정의 출발점 — 재시작 뒤 곧바로 한 주기를 더 돌지 않게). 없으면 null(곧 실행). */
async function lastMeasuredAt() {
  let m = null;
  for (const r of await latestAll()) { const ts = Number(r?.ts); if (Number.isFinite(ts) && (m == null || ts > m)) m = ts; }
  return m;
}

/**
 * 30초 틱 — 간격·예약 판정. 측정은 **시작만** 하고 기다리지 않는다(돌아온 promise 는 테스트용).
 * 측정 중이면 판정을 미룬다 — 유예 시간(30분) 안에 끝나면 그 예약을 이어서 실행한다.
 */
export async function tickXferSchedule({ now = Date.now() } = {}) {
  if (isEdgeNode()) return { skipped: 'edge-node' };
  const s = loadXferSpeedSettings();
  const enabled = xferSpeedEnabled(s);
  if (!_lastRunKnown) { _lastRunAt = await lastMeasuredAt(); _lastRunKnown = true; }
  if (running) return { skipped: 'running' };
  const state = loadScheduleState();
  const plan = planTick({ settings: s, state, now, lastRunAt: _lastRunAt, bootAt: BOOT_AT, enabled, wasBusy });
  // 지운 일정의 기록이 남아 있으면 정리한다(saveScheduleState 가 현재 일정만 남긴다).
  const ids = new Set(s.schedules.map((x) => x.id));
  let changed = Object.keys(state).some((id) => !ids.has(id));
  for (const m of plan.missed) { state[m.id] = { lastAt: m.occ, result: 'missed', reason: m.reason, at: now }; changed = true; }
  const loud = plan.missed.filter((m) => m.reason !== 'off');
  if (loud.length) console.warn(`[xferspeed] 예약 측정 ${loud.length}건을 놓쳤습니다(유예 ${Math.round(GRACE_MS / 60_000)}분 초과 — 몰아서 실행하지 않습니다): ${loud.map((m) => `${m.id}(${m.reason})`).join(', ')}`);
  if (plan.run) for (const f of plan.fire) { state[f.id] = { lastAt: f.occ, result: 'ran', at: now }; changed = true; }
  if (changed) saveScheduleState(state, s);
  if (!plan.run) return { plan };
  const trigger = plan.fire.length ? 'schedule' : 'timer';
  const promise = runXferCycle({ trigger, scheduleIds: plan.fire.map((f) => f.id) });
  promise.catch(() => { /* runXferCycle 가 상태·콘솔에 남긴다 */ });
  return { plan, started: true, trigger, promise };
}

/** 수동 실행 — 기다리지 않고 시작만 한다(한 주기가 수 분 걸린다). 진행 중이면 거절. */
export function startXferRun({ only = '' } = {}) {
  if (isEdgeNode()) return { ok: false, reason: 'edge-node' };
  if (running) return { ok: false, reason: 'already-running' };
  runXferCycle({ trigger: 'manual', only }).catch(() => { /* runXferCycle 가 상태·콘솔에 남긴다 */ });
  return { ok: true, started: true };
}

/* ── 데모(mock) — 첫 주기 전에 14일 이력을 한 번 채운다(이력이 있으면 덮지 않는다) ── */
let _demoBackfilled = false;
export async function demoBackfillXfer({ days = 14, now = Date.now() } = {}) {
  if (_demoBackfilled || !isMockMode()) return { ok: false, skipped: true };
  const cols = loadCollectors().filter(isDemoCollector).filter((c) => c.enabled !== false);
  if (!cols.length) return { ok: false, skipped: 'no-demo-edges' };   // 데모 엣지가 아직 등록 전이면 다음 기회에(표지를 세우지 않는다)
  _demoBackfilled = true;
  if ((await latestAll()).length) return { ok: false, skipped: 'has-history' };
  const s = loadXferSpeedSettings();
  const bytes = s.sizeMB * 1_048_576;
  const step = 30 * 60_000;
  let n = 0;
  for (let ts = now - days * 86_400_000; ts < now - step; ts += step) {
    const rows = [];
    for (const c of cols) {
      const agent = t(c.id || c.name);
      rows.push({ ...demoXferResult(c, 'down', { ts, bytes }), agent, trig: 'demo' }, { ...demoXferResult(c, 'up', { ts: ts + 1, bytes }), agent, trig: 'demo' });
    }
    await insertSamples(rows);
    n += rows.length;
    await new Promise((r) => setImmediate(r));   // 기동 1회 백필이 이벤트 루프를 오래 막지 않게
  }
  if (n) console.log(`[mock] 전송 속도 데모 이력 백필: ${days}일 × 엣지 ${cols.length}곳 (${n}행)`);
  return { ok: true, rows: n };
}

export function startXferSpeedPoller() {
  if (_timer) return _timer;
  if (isEdgeNode()) { console.log('[xferspeed] 엣지 노드라 전송 속도 측정 폴러를 시작하지 않습니다(측정은 중앙이 주도한다).'); return null; }
  _timer = startAdaptiveTimer(
    () => TICK_MS,
    () => tickXferSchedule(),
    { firstDelayMs: FIRST_TICK_DELAY_MS, name: 'xferspeed', subscribe: onXferSpeedSettingsChange },
  );
  return _timer;
}

export function stopXferSpeedPoller() { _timer?.stop?.(); _timer = null; }
export function _resetXferPollerForTest() { running = false; _last = null; _progress = null; _tick = 0; _demoBackfilled = false; _lastRunAt = null; _lastRunKnown = false; _spans.length = 0; }
