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
import { planTick, nextRunOf, nextOccurrence, rebaseClock, effectiveSince, GRACE_MS, CLOCK_TOL_MS } from './schedule.js';
import { DAY_OFFSET_MIN } from '../util/dayKey.js';
import { createChangeLogger } from '../util/logThrottle.js';

/** 판정 틱 — 예약 시각의 정밀도이기도 하다(최대 이만큼 늦게 시작한다). */
export const TICK_MS = 30_000;
/** 예약 실행 한 번의 예산(그 뒤에는 새 엣지를 시작하지 않는다). 간격 실행은 간격의 80%. */
export const SCHEDULE_BUDGET_MS = 60 * 60_000;
const FIRST_TICK_DELAY_MS = 90_000;
const BOOT_AT = Date.now();

registerStateFile('xfer-speed-schedule-state.json');
const STATE_FILE = () => path.join(config.configDir, 'xfer-speed-schedule-state.json');

/*
 * 예약 처리 기록 — { [일정 id]: { lastAt, result:'ran'|'missed', reason?, at, (sinceFrom, sinceCap, clockFrom) } }.
 * ⚠⚠ v2.740(감사 B-04 — 재현): 예전에는 매 틱 파일에서만 다시 읽어, 쓰기가 실패하면(디스크 가득·읽기 전용) 다음 30초 틱이 같은 예약을
 *   '아직 안 함' 으로 보고 유예 30분 동안 매 틱 다시 쟀다(6틱 6회 실측). 이제 **메모리가 1차**이고 파일은 재시작 대비 사본이다 —
 *   읽을 때 둘을 합치고(일정마다 lastAt 이 늦은 쪽), 쓰기에 실패하면 다음 틱에 다시 쓴다(`_schedDirty`).
 * ⚠ v2.740(감사 B-12): 파일을 못 읽은 것(EMFILE·EACCES·EIO 같은 일시 오류)은 손상이 아니다 — 원본을 옮기지 않는다.
 *   손상(JSON 해석 실패·모양이 아님)일 때만 보존하고 새로 시작한다.
 */
let _schedMem = null;      // 메모리 사본(1차). null = 이 프로세스가 아직 기록을 갖고 있지 않다
let _schedDirty = false;   // 마지막 쓰기가 실패했다 — 다음 틱에 다시 쓴다
const _warnOnce = createChangeLogger({ windowMs: 10 * 60_000 });

/** 파일 읽기 — `{ state, readError }`. readError 는 '못 읽음(일시 오류)' 이고 손상이 아니다. */
function readScheduleFile() {
  let text;
  try { text = fs.readFileSync(STATE_FILE(), 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return { state: {}, readError: null };
    return { state: {}, readError: e };
  }
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('객체가 아닌 JSON 값');
    const m = j.schedules && typeof j.schedules === 'object' && !Array.isArray(j.schedules) ? j.schedules : {};
    const out = {};
    for (const [id, v] of Object.entries(m)) if (v && typeof v === 'object' && Number.isFinite(Number(v.lastAt))) out[id] = v;
    return { state: out, readError: null };
  } catch {
    try { preserveCorrupt(STATE_FILE()); } catch { /* best effort */ }
    return { state: {}, readError: null };
  }
}

/** 파일 기록과 메모리 기록 합치기(순수) — 일정마다 lastAt 이 늦은 쪽. 시계 보정으로 내린 메모리 기록(clockFrom)은 그 미래 값을 이긴다. */
export function mergeScheduleState(disk = {}, mem = null) {
  const out = { ...(disk || {}) };
  for (const [id, v] of Object.entries(mem || {})) {
    const d = out[id];
    const vl = Number(v?.lastAt) || 0; const dl = Number(d?.lastAt) || 0;
    if (!d || vl >= dl || (v?.clockFrom != null && Number(v.clockFrom) === dl)) out[id] = v;
  }
  return out;
}

/** 지금 쓰는 예약 처리 기록 — 메모리 우선 + 파일 병합. */
export function loadScheduleState() {
  return mergeScheduleState(readScheduleFile().state, _schedMem);
}

function keepIds(state, settings) {
  const keep = new Set((settings?.schedules || []).map((x) => x.id));
  const out = {};
  for (const [id, v] of Object.entries(state || {})) if (keep.has(id)) out[id] = v;   // 지운 일정의 기록은 버린다
  return out;
}
/** @returns {boolean} 파일에 썼는가 */
function saveScheduleState(state) {
  try { atomicWriteFileSync(STATE_FILE(), `${JSON.stringify({ v: 1, schedules: state }, null, 2)}\n`, { mode: 0o600 }); return true; }
  catch (e) {
    const msg = String(e?.message || e).slice(0, 200);
    if (_warnOnce('save', msg)) {
      console.warn(`[xferspeed] 예약 처리 기록을 파일에 쓰지 못했습니다 — 이 프로세스에서는 처리한 회차를 메모리에 두어 다시 재지 않지만, 쓰기가 되기 전에 포탈을 재시작하면 유예(${Math.round(GRACE_MS / 60_000)}분) 안의 같은 회차를 한 번 더 잴 수 있습니다. 다음 틱에 다시 씁니다: ${msg}`);
    }
    return false;
  }
}
/** 처리 기록에 시계 보정(sinceFrom·sinceCap)을 이어 둔다 — 실행·놓침 기록이 그 보정을 지우면 미래 since 가 다시 예약을 막는다. */
const keepCap = (r) => (r && r.sinceCap != null ? { sinceFrom: r.sinceFrom, sinceCap: r.sinceCap } : {});

const isEdgeNode = () => !!String(config.agent?.centralUrl || '').trim();
const t = (v) => String(v ?? '').trim();
const randomBytesAsync = (n) => new Promise((resolve, reject) => crypto.randomBytes(n, (e, b) => (e ? reject(e) : resolve(b))));

let running = false;
let _last = null;
let _progress = null;
let _timer = null;

/*
 * 보존 정리 — 시간 기준(v2.735.3). 예전엔 '측정 12회마다' 라 하루 1회 예약이면 12일마다, 자동 측정을 끄면 영영 돌지 않았다.
 * 30초 틱에서 6시간마다 — 첫 틱은 기준만 잡고 정리하지 않는다(v2.453 — 보존일을 줄이고 재시작한 순간 차액을 한 번에 지우지 않게).
 * 측정이 꺼져 있어도 돈다(쌓인 이력의 보존일은 설정대로 지켜야 한다). 기다리지 않는다(청크 정리 — db.pruneXferSpeed).
 */
export const PRUNE_EVERY_MS = 6 * 3_600_000;
let _lastPruneAt = null;
function maybePrune(s, now) {
  if (_lastPruneAt == null) { _lastPruneAt = now; return; }
  if (now - _lastPruneAt < PRUNE_EVERY_MS) return;
  _lastPruneAt = now;
  pruneXferSpeed({ sampleDays: s.sampleRetentionDays, dailyDays: s.dailyRetentionDays })
    .catch((e) => console.warn(`[xferspeed] 보존 정리 실패: ${String(e?.message || e).slice(0, 200)}`));
}
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
      const after = Math.max(now - 1, effectiveSince(x, rec), Number(rec?.lastAt) || 0);
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

/**
 * DB 의 마지막 측정 시각(간격 판정의 출발점 — 재시작 뒤 곧바로 한 주기를 더 돌지 않게). 없으면 null(곧 실행).
 * 지금보다 뒤(시계가 뒤로 감)인 값은 틱이 지금으로 잘라 쓴다(v2.740 B-09 — 아래 tickXferSchedule, 한 곳에서만 자른다).
 */
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
  maybePrune(s, now);
  const enabled = xferSpeedEnabled(s);
  if (!_lastRunKnown) { _lastRunAt = await lastMeasuredAt(); _lastRunKnown = true; }
  // v2.740(감사 B-09): 마지막 실행(DB 의 마지막 측정 · 이 프로세스가 기억한 실행)이 지금보다 뒤면(시계가 뒤로 감) 지금으로 내린다 —
  //   그대로 쓰면 그 미래 시각 + 간격까지 측정이 서지 않았다(재현: 6시간 뒤 시각이면 6.5시간 동안 측정 0).
  if (_lastRunAt != null && _lastRunAt > now + CLOCK_TOL_MS) {
    if (_warnOnce('clock-run', String(_lastRunAt))) console.warn(`[xferspeed] 마지막 측정 시각이 지금보다 ${Math.round((_lastRunAt - now) / 60_000)}분 뒤입니다 — 서버 시계가 뒤로 바뀐 것으로 보고 간격을 지금부터 다시 셉니다.`);
    _lastRunAt = now;
  }
  if (running) return { skipped: 'running' };
  const { state: disk, readError } = readScheduleFile();
  // 파일을 못 읽었고(일시 오류) 메모리에도 기록이 없으면 이번 틱은 예약을 판정하지 않는다 — 기록 없이 판정하면 이미 잰 회차를 다시 잴 수 있다.
  const blind = !!readError && _schedMem == null;
  if (readError && _warnOnce('read', String(readError?.code || readError?.message || readError))) {
    console.warn(`[xferspeed] 예약 처리 기록 파일을 읽지 못했습니다(${readError?.code || readError?.message || readError}) — 손상이 아니라 파일은 그대로 둡니다. ${blind ? '이 프로세스의 기록도 없어 이번 틱은 예약을 판정하지 않습니다(간격 실행은 그대로).' : '이 프로세스의 기록으로 판정합니다.'}`);
  }
  let state = mergeScheduleState(disk, _schedMem);
  // 지운 일정의 기록이 남아 있으면 정리한다(현재 일정만 남긴다).
  const ids = new Set(s.schedules.map((x) => x.id));
  let changed = Object.keys(state).some((id) => !ids.has(id));
  if (!blind) {
    const rb = rebaseClock({ settings: s, state, now });
    if (rb.rebased.length) {
      state = rb.state; changed = true;
      console.warn(`[xferspeed] 예약 ${rb.rebased.length}건의 기록 시각이 지금보다 뒤입니다 — 서버 시계가 뒤로 바뀐 것으로 보고 지금으로 다시 잡았습니다(지금 이전 회차는 다시 재지 않습니다): ${rb.rebased.map((r) => `${r.id}(${r.field})`).join(', ')}`);
    }
  }
  const plan = planTick({ settings: blind ? { ...s, schedules: [] } : s, state, now, lastRunAt: _lastRunAt, bootAt: BOOT_AT, enabled, wasBusy });
  for (const m of plan.missed) { state[m.id] = { ...keepCap(state[m.id]), lastAt: m.occ, result: 'missed', reason: m.reason, at: now }; changed = true; }
  const loud = plan.missed.filter((m) => m.reason !== 'off');
  if (loud.length) console.warn(`[xferspeed] 예약 측정 ${loud.length}건을 놓쳤습니다(유예 ${Math.round(GRACE_MS / 60_000)}분 초과 — 몰아서 실행하지 않습니다): ${loud.map((m) => `${m.id}(${m.reason})`).join(', ')}`);
  if (plan.run) for (const f of plan.fire) { state[f.id] = { ...keepCap(state[f.id]), lastAt: f.occ, result: 'ran', at: now }; changed = true; }
  if (!blind) {
    // 메모리가 1차 — 파일 쓰기가 실패해도 같은 프로세스는 같은 회차를 다시 재지 않는다(B-04).
    const kept = keepIds(state, s);
    _schedMem = kept;
    if (changed || _schedDirty) _schedDirty = !saveScheduleState(kept);
  }
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
export function _resetXferPollerForTest() { running = false; _last = null; _progress = null; _lastPruneAt = null; _demoBackfilled = false; _lastRunAt = null; _lastRunKnown = false; _spans.length = 0; _schedMem = null; _schedDirty = false; }
