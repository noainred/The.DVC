/**
 * svcmon/trial.js — **시험 점검 후 사용**(v2.960 쉬운 등록 A · 설계 docs/design/monitoring-autoreg/README.md §11.2).
 *
 * 중지된 대상을 켜기 전에 점검을 한 번씩 실제로 돌려 본다. 통과(그 대상의 켜진 점검이 모두 정상 또는 경고) = 사용 · 실패 = 중지 유지 + 사유.
 *
 * 점검 위치(`planTrial` — 순수):
 *  - 대상에 담당 엣지가 있고 그 엣지 배정이 byAgent 이거나 없으면 **엣지 시험** — 대상을 켜고 배정을 다시 굳힌 뒤(엣지는 배정 스냅샷의
 *    켜진 대상만 돈다) 엣지의 **첫 보고**로 같은 기준을 판정한다. 시한(`edgeDeadlineMs`)을 넘기면 중지로 되돌린다(사용자 결정 — 시안 기본값).
 *  - 아니면 이 포탈이 점검을 직접 실행하는 역할일 때 **직접 시험**(폴러와 같은 워커 풀 `runBatch` · 데모 대상은 합성 결과 — 폴러와 같은 규칙).
 *  - 경로 기준 배정 엣지가 맡는 대상은 중앙(실행 안 함)에서 시험할 수 없다 — 건너뜀(엣지 배정 탭에서 다시 배포 · 자동으로 배정 범위를 바꾸지 않는다).
 *  - 중앙이고 담당 엣지도 없으면 점검할 곳이 없다 — 건너뜀.
 *
 * 알림: 시험 중인 대상은 `transitions.muteTarget` 으로 실패 · 경고 알림을 보내지 않는다(시한 = 이 시험의 시한 — 저절로 풀린다).
 * 직접 시험 결과는 폴러 결과 · 전이 이력 · CSV 에 넣지 않는다(시험은 감시가 아니다 — 켜면 폴러가 곧바로 다시 잰다).
 *
 * 엣지 대기는 파일(`svcmon-trial.json`)에 남는다 — 중앙이 재시작해도 이어서 판정하고, 시한이 지났으면 되돌린다(켠 채로 남지 않게).
 * 파일은 판정 상태라 설정 변경 자동 백업의 지문에서 뺀다(backup/service.js CHANGE_WATCH_EXCLUDE).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { listTargets, setEnabledMany } from './store.js';
import { executesHere } from './poller.js';
import { runBatch } from './pool.js';
import { splitSvcmonDue, demoSvcmonResult } from '../mock/demo/svcmon.js';
import { muteTarget, unmuteTarget } from './transitions.js';
import { edgeOfTarget, syncByAgentAssignments } from '../central/svcmonAssignSync.js';
import { listAssignments, DEFAULT_EXCEPT_TYPES } from '../central/svcmonAssign.js';
import { getAgentRaw } from '../central/svcmonEdge.js';
import { logAudit } from '../audit.js';

const t = (v) => String(v ?? '').trim();
const FILE = () => path.join(config.configDir, 'svcmon-trial.json');
const envNum = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };

export const TRIAL_MAX_IDS = 2000;
/** 통과 상태 — 경고(인증서 만료 임박 · 응답 지연)는 통과(사용자 결정 — 시안 기본값). */
export const PASS_STATES = Object.freeze(['ok', 'warn']);
/** 엣지 시험 시한 기본 — 엣지는 배정을 5분마다 당기고(SVCMON_CONFIG_PULL_MS 기본) push 주기마다 올린다. */
export const EDGE_DEADLINE_BASE_MS = envNum('SVCMON_TRIAL_EDGE_MS', 15 * 60_000);
export const EDGE_DEADLINE_MAX_MS = 60 * 60_000;
const TICK_MS = 15_000;
const JOBS_KEEP = 20;
const LAST_MAX = 20_000;
const LAST_TTL_MS = 24 * 3600_000;

/** 엣지 시험 시한(ms) — 그 엣지의 push 주기(expectMs)가 길면 늘린다. 순수. */
export function edgeDeadlineMs(expectMs = 0) {
  const e = Number(expectMs) > 0 ? Number(expectMs) : 60_000;
  return Math.min(EDGE_DEADLINE_MAX_MS, Math.max(EDGE_DEADLINE_BASE_MS, 5 * 60_000 + 4 * e));
}

/**
 * 판정 — 순수. 결과가 하나도 없으면 실패(무음 통과 금지). 하나라도 통과 상태가 아니면 실패.
 * @param {{name:string,status:string,reply?:string}[]} results
 * @param {number} [expected] 기대 점검 수(엣지 — 다 오기 전에는 통과로 단정하지 않는다)
 * @returns {{verdict:'pass'|'fail'|'wait', reason:string}}
 */
export function judgeTrial(results = [], expected = 0) {
  const bad = results.find((r) => !PASS_STATES.includes(t(r.status)));
  if (bad) return { verdict: 'fail', reason: `${t(bad.name) || '점검'} — ${t(bad.reply) || t(bad.status) || '실패'}`.slice(0, 200) };
  if (!results.length) return expected ? { verdict: 'wait', reason: '' } : { verdict: 'fail', reason: '결과가 없습니다.' };
  if (expected && results.length < expected) return { verdict: 'wait', reason: `${results.length}/${expected} 점검 보고됨` };
  return { verdict: 'pass', reason: '' };
}

/**
 * 시험 계획 — 순수. 대상마다 점검 위치를 정한다.
 * @param {object[]} picked 대상(저장소 원본 모양)
 * @param {{executes:boolean, assignments:object[]}} o
 */
export function planTrial(picked = [], { executes = false, assignments = [] } = {}) {
  const local = []; const edge = []; const skip = [];
  for (const tg of picked) {
    if (!tg) continue;
    const base = { targetId: tg.id, name: t(tg.name), path: t(tg.path), host: t(tg.host) };
    if (tg.enabled !== false) { skip.push({ ...base, already: true, reason: '이미 사용 중입니다.' }); continue; }
    const tests = (tg.tests || []).filter((x) => x.enabled !== false);
    if (!tests.length) { skip.push({ ...base, reason: '켜진 점검이 없습니다 — 점검을 먼저 켜거나 더하세요.' }); continue; }
    const e = edgeOfTarget(tg, assignments);
    if (e.agent && e.mode === 'byAgent') {
      const a = assignments.find((x) => x.agent === e.agent);
      const except = new Set(a?.exceptTypes || DEFAULT_EXCEPT_TYPES);
      const expect = tests.filter((x) => !except.has(x.type)).map((x) => t(x.name));
      if (!expect.length) { skip.push({ ...base, agent: e.agent, reason: '엣지 배정에서 제외된 유형의 점검뿐입니다(엣지 배정 탭의 제외 유형).' }); continue; }
      edge.push({ ...base, agent: e.agent, expect, expectMs: a?.lastExpectMs || 0 });
      continue;
    }
    if (executes) {
      local.push({ ...base, tests, ...(e.mode === 'path' ? { note: `엣지 ${e.agent} 는 경로 기준 배정입니다 — 켠 뒤 엣지 반영은 엣지 배정 탭에서 다시 배포하세요.` } : {}) });
      continue;
    }
    skip.push({
      ...base, agent: e.agent,
      reason: e.mode === 'path'
        ? `경로 기준 배정 엣지(${e.agent})가 맡는 대상입니다 — 이 포탈은 직접 점검하지 않으므로 시험할 수 없습니다(엣지 배정 탭에서 다시 배포한 뒤 바로 사용으로 켜세요).`
        : '점검할 곳이 없습니다 — 이 포탈은 점검을 직접 실행하지 않고(중앙) 담당 엣지도 없습니다.',
    });
  }
  return { local, edge, skip };
}

/* ───────────────────────────── 상태 ───────────────────────────── */

const _jobs = new Map();       // id -> job
const _last = new Map();       // targetId -> { state, reason, at, deadline, jobId }
let _pending = [];             // [{ targetId, jobId, agent, path, name, startedAt, deadline, expect:[] }]
let _loaded = false;
let _localRunning = false;
let _timer = null;

function loadPending() {
  if (_loaded) return;
  _loaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    _pending = (Array.isArray(j?.pending) ? j.pending : []).filter((p) => p && t(p.targetId) && t(p.agent) && Number(p.deadline) > 0)
      .map((p) => ({ targetId: t(p.targetId), jobId: t(p.jobId), agent: t(p.agent), path: t(p.path), name: t(p.name),
        startedAt: Number(p.startedAt) || 0, deadline: Number(p.deadline), expect: Array.isArray(p.expect) ? p.expect.map(t).slice(0, 200) : [] }));
  } catch (e) {
    if (e?.code !== 'ENOENT') preserveCorrupt(FILE(), e?.message);
    _pending = [];
  }
}
function savePending() {
  try { atomicWriteFileSync(FILE(), JSON.stringify({ v: 1, pending: _pending })); return true; }
  catch (e) { console.warn(`[svcmon] 시험 점검 상태 저장 실패: ${t(e?.message).slice(0, 160)}`); return false; }
}

function setLast(targetId, v) {
  if (!_last.has(targetId) && _last.size >= LAST_MAX) _last.delete(_last.keys().next().value);
  _last.set(targetId, v);
}
/** 대상의 최근 시험 결과(24시간) — /state 가 대상마다 싣는다(트리 표지). */
export function trialOf(targetId, now = Date.now()) {
  const v = _last.get(targetId);
  if (!v) return null;
  if (v.state !== 'wait' && now - v.at > LAST_TTL_MS) { _last.delete(targetId); return null; }
  return { state: v.state, reason: v.reason || '', at: v.at, ...(v.deadline ? { deadline: v.deadline } : {}) };
}

const recount = (job) => {
  const c = { pass: 0, fail: 0, wait: 0, skip: 0, running: 0 };
  for (const it of job.items) c[it.state] = (c[it.state] || 0) + 1;
  job.counts = c;
  job.state = c.running ? 'running' : (c.wait ? 'waiting' : 'done');
  if (job.state === 'done' && !job.finishedAt) job.finishedAt = Date.now();
};
function keepJob(job) {
  _jobs.set(job.id, job);
  while (_jobs.size > JOBS_KEEP) _jobs.delete(_jobs.keys().next().value);
}
export function getTrial(id) { const j = _jobs.get(t(id)); return j ? JSON.parse(JSON.stringify(j)) : null; }
export function trialBusy() { return _localRunning; }
export function pendingTrials() { loadPending(); return _pending.map((p) => ({ ...p })); }

/* ───────────────────────────── 실행 ───────────────────────────── */

/** 직접 시험 — 폴러와 같은 워커 풀 · 데모 대상은 합성 결과(폴러 splitSvcmonDue 와 같은 규칙). */
async function runLocal(items, deps) {
  const due = [];
  for (const it of items) for (const test of it.tests) due.push({ test, host: it.host, target: it.target || { batch: it.batch }, it });
  const { live, demo, skipped } = splitSvcmonDue(due);
  const out = new Map();
  const run = deps.run || runBatch;
  const res = live.length ? await run(live.map(({ test, host }) => ({ test, host }))) : [];
  for (const r of res || []) out.set(r.testId, r);
  for (const d of demo) out.set(d.test.id, { testId: d.test.id, ...demoSvcmonResult(d.test, d.host) });
  for (const d of skipped) out.set(d.test.id, { testId: d.test.id, status: 'skip', reply: '데모 대상 — live 모드에서는 점검하지 않습니다', ms: null });
  return out;
}

/**
 * 시험 시작. 직접 시험은 뒤에서 돌고(작업 id 로 진행을 본다), 엣지 시험은 대상을 켜고 배정을 다시 굳힌 뒤 대기로 둔다.
 * @param {string[]} ids 대상 id
 * @param {{user?:string, now?:number, deps?:object}} o deps(테스트 주입): targets · executes · assignments · run · sync · edgeRows
 * @returns {{ok:boolean, error?:string, job?:object, done?:Promise}}
 */
export function startTrial(ids, { user = '', now = Date.now(), deps = {} } = {}) {
  loadPending();
  const want = [...new Set((Array.isArray(ids) ? ids : []).map(t).filter(Boolean))];
  if (!want.length) return { ok: false, error: '시험할 대상을 고르세요.' };
  if (want.length > TRIAL_MAX_IDS) return { ok: false, error: `한 번에 ${TRIAL_MAX_IDS}개까지 시험할 수 있습니다(요청 ${want.length}개).` };
  const all = deps.targets || listTargets();
  const byId = new Map(all.map((x) => [x.id, x]));
  let assignments = deps.assignments;
  if (!assignments) { try { assignments = listAssignments(); } catch { assignments = []; } }
  const plan = planTrial(want.map((id) => byId.get(id) || null).filter(Boolean), { executes: deps.executes ?? executesHere(), assignments });
  const missing = want.filter((id) => !byId.has(id));
  if (plan.local.length && _localRunning) return { ok: false, busy: true, error: '다른 시험 점검이 아직 돌고 있습니다 — 끝난 뒤 다시 시도하세요.' };

  const job = { id: `tr-${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`, at: now, by: user, items: [], counts: {}, state: 'running' };
  for (const s of plan.skip) {
    const { already, ...rest } = s;
    job.items.push({ ...rest, where: 'skip', state: 'skip', tests: [] });
    // 중지된 대상의 건너뜀 사유는 트리에 남긴다(점검할 곳 없음 등) — 이미 켠 대상은 남기지 않는다(표지 소음).
    if (!already) setLast(s.targetId, { state: 'skip', reason: s.reason, at: now, jobId: job.id });
  }
  for (const id of missing) job.items.push({ targetId: id, name: '', path: '', host: '', where: 'skip', state: 'skip', reason: '대상을 찾을 수 없습니다(지워졌을 수 있습니다).', tests: [] });

  // 엣지 시험 — 켜고(배정 스냅샷에 켜진 상태로 실리게) 배정을 다시 굳힌다. 배정을 굳히지 못한 엣지의 대상은 곧바로 되돌린다.
  if (plan.edge.length) {
    const en = (deps.setEnabled || setEnabledMany)({ targets: plan.edge.map((e) => e.targetId), enabled: true });
    const sync = (deps.sync || syncByAgentAssignments)([...new Set(plan.edge.map((e) => e.agent))], user, { note: '시험 점검' });
    const failed = new Map(sync.filter((s) => !s.ok).map((s) => [s.agent, s.reason || '배정을 다시 굳히지 못했습니다.']));
    const revert = [];
    for (const e of plan.edge) {
      const item = { targetId: e.targetId, name: e.name, path: e.path, host: e.host, where: 'edge', agent: e.agent, tests: [] };
      if (failed.has(e.agent)) { revert.push(e.targetId); job.items.push({ ...item, state: 'fail', reason: `엣지 배정 동기화 실패 — ${failed.get(e.agent)}` }); continue; }
      const deadline = now + edgeDeadlineMs(e.expectMs);
      muteTarget(e.path, e.name, deadline);
      _pending.push({ targetId: e.targetId, jobId: job.id, agent: e.agent, path: e.path, name: e.name, startedAt: now, deadline, expect: e.expect });
      job.items.push({ ...item, state: 'wait', deadline, reason: '배정을 내려보냈습니다 — 엣지 첫 보고를 기다리는 중' });
      setLast(e.targetId, { state: 'wait', reason: '엣지 첫 보고 대기', at: now, deadline, jobId: job.id });
    }
    if (revert.length) (deps.setEnabled || setEnabledMany)({ targets: revert, enabled: false });
    if (_pending.length) { savePending(); ensureTimer(); }
    job.edgeEnabled = en?.changed ?? 0;
  }
  for (const it of plan.local) job.items.push({ targetId: it.targetId, name: it.name, path: it.path, host: it.host, where: 'local', state: 'running', reason: it.note || '', tests: [] });
  recount(job);
  keepJob(job);

  let done = Promise.resolve();
  if (plan.local.length) {
    _localRunning = true;
    const byTarget = new Map(plan.local.map((it) => [it.targetId, { ...it, target: byId.get(it.targetId) }]));
    done = (async () => {
      try {
        const res = await runLocal([...byTarget.values()], deps);
        const passIds = [];
        for (const item of job.items) {
          if (item.where !== 'local') continue;
          const it = byTarget.get(item.targetId);
          item.tests = it.tests.map((x) => { const r = res.get(x.id); return { name: t(x.name), type: x.type, status: t(r?.status) || 'none', reply: t(r?.reply).slice(0, 160), ms: Number.isFinite(r?.ms) ? r.ms : null }; });
          const skipped = item.tests.filter((x) => x.status === 'skip');
          if (skipped.length) { item.state = 'skip'; item.reason = skipped[0].reply; continue; }
          const j = judgeTrial(item.tests);
          item.state = j.verdict === 'pass' ? 'pass' : 'fail';
          item.reason = j.verdict === 'pass' ? (item.reason || '') : j.reason;
          if (item.state === 'pass') passIds.push(item.targetId);
          setLast(item.targetId, { state: item.state, reason: item.state === 'pass' ? '' : item.reason, at: Date.now(), jobId: job.id });
        }
        if (passIds.length) (deps.setEnabled || setEnabledMany)({ targets: passIds, enabled: true });
        logAudit({ user, action: 'svcmon.trial.local', target: job.id, detail: `통과 ${passIds.length} · 실패 ${job.items.filter((x) => x.where === 'local' && x.state === 'fail').length}` });
      } catch (e) {
        for (const item of job.items) if (item.where === 'local' && item.state === 'running') { item.state = 'fail'; item.reason = `시험 실행 실패 — ${t(e?.message).slice(0, 160)}`; }
      } finally {
        _localRunning = false;
        recount(job);
      }
    })();
  }
  return { ok: true, job: getTrial(job.id), done };
}

/**
 * 엣지 대기 판정 — 주기(15초) · 시작 직후 · 재시작 뒤. 엣지 하나당 행을 한 번만 훑는다.
 * @param {number} now
 * @param {{edgeRows?:(agent:string)=>({path:string,target:string,test:string,status:string,reply:string,measuredAt:number}[]|null), sync?:Function, setEnabled?:Function}} deps
 */
export function trialTick(now = Date.now(), deps = {}) {
  loadPending();
  if (!_pending.length) return { judged: 0 };
  const byAgent = new Map();
  for (const p of _pending) { if (!byAgent.has(p.agent)) byAgent.set(p.agent, []); byAgent.get(p.agent).push(p); }
  const finished = [];   // { p, state, reason, tests }
  for (const [agent, list] of byAgent) {
    const rows = (deps.edgeRows || edgeRowsOf)(agent) || [];
    const want = new Map(list.map((p) => [`${p.path}\u0001${p.name.toLowerCase()}`, { p, got: [] }]));
    for (const r of rows) {
      const w = want.get(`${t(r.path)}\u0001${t(r.target).toLowerCase()}`);
      if (!w || !(Number(r.measuredAt) >= w.p.startedAt)) continue;
      w.got.push({ name: t(r.test), status: t(r.status), reply: t(r.reply).slice(0, 160), ms: Number.isFinite(r.ms) ? r.ms : null });
    }
    for (const { p, got } of want.values()) {
      const j = judgeTrial(got, p.expect.length || 1);
      if (j.verdict === 'wait') {
        if (now >= p.deadline) finished.push({ p, state: 'fail', reason: got.length ? `시한까지 일부만 보고됨(${got.length}/${p.expect.length}) — 중지로 되돌렸습니다.` : '시한까지 엣지 보고가 없었습니다 — 중지로 되돌렸습니다.', tests: got });
        continue;
      }
      finished.push({ p, state: j.verdict, reason: j.verdict === 'fail' ? j.reason : '', tests: got });
    }
  }
  if (!finished.length) return { judged: 0 };
  const done = new Set(finished.map((f) => f.p));
  _pending = _pending.filter((p) => !done.has(p));
  const reverts = finished.filter((f) => f.state === 'fail');
  if (reverts.length) {
    (deps.setEnabled || setEnabledMany)({ targets: reverts.map((f) => f.p.targetId), enabled: false });
    (deps.sync || syncByAgentAssignments)([...new Set(reverts.map((f) => f.p.agent))], 'system', { note: '시험 점검 — 실패 대상 중지' });
  }
  for (const f of finished) {
    unmuteTarget(f.p.path, f.p.name);
    setLast(f.p.targetId, { state: f.state, reason: f.reason, at: now, jobId: f.p.jobId });
    const job = _jobs.get(f.p.jobId);
    const item = job?.items.find((x) => x.targetId === f.p.targetId);
    if (item) { item.state = f.state; item.reason = f.reason || '엣지 첫 보고로 통과 — 사용 중'; item.tests = f.tests; recount(job); }
  }
  savePending();
  if (reverts.length) logAudit({ user: 'system', action: 'svcmon.trial.revert', detail: `엣지 시험 실패 · 시한 초과 ${reverts.length}건 중지` });
  if (!_pending.length) stopTimer();
  return { judged: finished.length, failed: reverts.length };
}

/** 엣지 수신 상태에서 그 엣지의 (경로 · 대상 · 점검 · 상태 · 측정 시각) 행. 메타(이름)가 없는 행은 대상을 알 수 없어 뺀다. */
function edgeRowsOf(agent) {
  const a = getAgentRaw(agent);
  if (!a) return null;
  const out = [];
  for (const [id, r] of a.rows) {
    const m = a.meta.get(id);
    if (!m) continue;
    out.push({ path: m.p, target: m.n, test: m.t, status: r.s, reply: r.r, ms: r.m, measuredAt: r.measuredAt });
  }
  return out;
}

function ensureTimer() {
  if (_timer) return;
  _timer = setInterval(() => { try { trialTick(); } catch (e) { console.warn(`[svcmon] 시험 점검 판정 실패: ${t(e?.message).slice(0, 160)}`); } }, TICK_MS);
  _timer.unref?.();
}
function stopTimer() { if (_timer) { clearInterval(_timer); _timer = null; } }

/** 기동 — 재시작 전 엣지 대기를 이어 받는다(시한 안이면 알림 억제를 다시 걸고, 지났으면 첫 판정에서 되돌린다). */
export function startSvcmonTrials() {
  loadPending();
  if (!_pending.length) return;
  for (const p of _pending) muteTarget(p.path, p.name, p.deadline);
  console.log(`[svcmon] 시험 점검 엣지 대기 ${_pending.length}건을 이어서 판정합니다.`);
  ensureTimer();
  setTimeout(() => { try { trialTick(); } catch { /* 다음 주기 */ } }, 5_000).unref?.();
}

/** 테스트 전용. */
export function _resetTrialForTest({ reload = false } = {}) { _jobs.clear(); _last.clear(); _pending = []; _loaded = !reload; _localRunning = false; stopTimer(); }
