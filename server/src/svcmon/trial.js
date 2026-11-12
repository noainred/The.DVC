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
import { listTargets, setEnabledMany, getTarget } from './store.js';
import { executesHere } from './poller.js';
import { runBatch } from './pool.js';
import { splitSvcmonDue, demoSvcmonResult } from '../mock/demo/svcmon.js';
import { muteTarget, unmuteTarget } from './transitions.js';
import { assignReadiness } from '../central/svcmonAssign.js';
import { isMockMode } from '../mock/demo/flags.js';
import { demoEdgeList } from '../mock/demo/edge.js';
import { edgeOfTarget, syncByAgentAssignments } from '../central/svcmonAssignSync.js';
import { listAssignments, svcmonAssignLoadError, DEFAULT_EXCEPT_TYPES } from '../central/svcmonAssign.js';
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

/**
 * v2.960(반증 M1 — 재현): 시험에 실패해 중지로 되돌린 뒤에도 엣지는 **다음 배정 당기기**(기본 5분)까지 옛 스냅샷으로 그 대상을 잰다 —
 *   억제를 그 순간 풀면 연속 실패 알림이 나갔다. 되돌린 대상은 당기기 + push 주기를 덮는 동안 억제를 이어 간다(시한 있음). 통과면 곧바로 푼다.
 */
export function revertMuteMs(expectMs = 0) {
  const e = Number(expectMs) > 0 ? Number(expectMs) : 60_000;
  return Math.min(EDGE_DEADLINE_MAX_MS, Math.max(10 * 60_000, 5 * 60_000 + 3 * e));
}

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
export function planTrial(picked = [], { executes = false, assignments = [], assignUnreadable = false, pendingIds = new Set(), localAgents = new Set() } = {}) {
  const local = []; const edge = []; const skip = [];
  for (const tg of picked) {
    if (!tg) continue;
    const base = { targetId: tg.id, name: t(tg.name), path: t(tg.path), host: t(tg.host), kind: tg.kind === 'service' ? 'service' : 'infra' };
    if (pendingIds.has(tg.id)) { skip.push({ ...base, already: true, reason: '이미 시험 중입니다(엣지 보고 대기).' }); continue; }
    if (tg.enabled !== false) { skip.push({ ...base, already: true, reason: '이미 사용 중입니다.' }); continue; }
    const tests = (tg.tests || []).filter((x) => x.enabled !== false);
    if (!tests.length) { skip.push({ ...base, reason: '켜진 점검이 없습니다 — 점검을 먼저 켜거나 더하세요.' }); continue; }
    // v2.960(반증 H1): 배정 파일을 못 읽었으면 어느 엣지가 맡는지 모른다(빈 목록을 '배정 없음' 으로 읽으면 경로 기준 엣지를 byAgent 로 오분류한다).
    if (assignUnreadable && (t(tg.agent) || !executes)) { skip.push({ ...base, agent: t(tg.agent), reason: '엣지 배정 파일을 읽지 못했습니다 — 엣지 배정 탭에서 확인한 뒤 다시 시험하세요.' }); continue; }
    const e = edgeOfTarget(tg, assignUnreadable ? [] : assignments);
    // v2.987(반증 R8): 데모(mock)의 데모 엣지는 배정을 당기지도 보고하지도 않는다 — 엣지 시험으로 보내면 시한까지 기다린 뒤 전부 실패했다. 이 포탈이 대신 잰다.
    if (e.agent && e.mode === 'byAgent' && executes && localAgents.has(e.agent)) { local.push({ ...base, tests, note: `데모 엣지(${e.agent})는 보고하지 않아 이 포탈이 대신 잽니다(데모 전용).` }); continue; }
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
      // 시한은 지금 + 상한으로 자른다(반증 L4 — 파일을 손으로 고치거나 옛 번들을 복원해도 무기한 대기가 되지 않게).
      .map((p) => ({ targetId: t(p.targetId), jobId: t(p.jobId), agent: t(p.agent), path: t(p.path), name: t(p.name), host: t(p.host),
        // v2.987(반증 R2): v2.960 파일에는 구분이 없다 — 'infra' 로 가정하면 서비스 대상의 억제가 새고 판정이 0건이었다. 대상에서 채운다.
        kind: p.kind === 'service' || p.kind === 'infra' ? p.kind : (getTarget(t(p.targetId))?.kind === 'service' ? 'service' : 'infra'),
        sig: t(p.sig).slice(0, 64),
        startedAt: Number(p.startedAt) || 0, deadline: Math.min(Number(p.deadline), Date.now() + EDGE_DEADLINE_MAX_MS),
        expect: Array.isArray(p.expect) ? p.expect.map(t).slice(0, 200) : [], expectMs: Number(p.expectMs) || 0 }));
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
 * v2.987 '지금 한 번 점검' — 점검 하나를 이 포탈에서 한 번 실행해 결과만 돌려준다(사용 여부와 무관 · 폴러 결과 · 전이 · CSV · 알림에 넣지 않는다 — 시험과 같은 규칙).
 *   동시에 같은 점검은 하나 · 전체 동시 상한 RUN_ONCE_MAX(넘으면 busy). 데모 대상은 합성 결과(폴러 규칙).
 */
const RUN_ONCE_MAX = 8;
const _runOnce = new Set();
export async function runOnceTest(target, test, deps = {}) {
  const key = t(test?.id);
  if (!key) return { ok: false, error: '점검을 찾을 수 없습니다.' };
  if (_runOnce.has(key)) return { ok: false, busy: true, error: '이 점검을 이미 실행하고 있습니다.' };
  if (_runOnce.size >= RUN_ONCE_MAX) return { ok: false, busy: true, error: `동시에 ${RUN_ONCE_MAX}개까지 실행합니다 — 잠시 뒤 다시 시도하세요.` };
  _runOnce.add(key);
  try {
    const res = await runLocal([{ host: t(target?.host), target, tests: [test] }], deps);
    const r = res.get(test.id) || {};
    return { ok: true, result: { status: t(r.status) || 'none', reply: t(r.reply).slice(0, 300), ms: Number.isFinite(r.ms) ? r.ms : null, at: Date.now() } };
  } catch (e) { return { ok: false, error: `실행 실패 — ${t(e?.message).slice(0, 160)}` }; }
  finally { _runOnce.delete(key); }
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
  let assignUnreadable = false;
  if (!assignments) { assignUnreadable = !!svcmonAssignLoadError(); try { assignments = listAssignments(); } catch { assignments = []; assignUnreadable = true; } }
  // v2.960(반증 M2 — 재현): 중지된 대상에 남은 대기는 낡은 것이다(사람이 다른 경로로 껐다) — 같은 대상 대기가 둘이 되지 않게 먼저 지운다.
  //   켜진 채 대기 중인 대상은 '이미 시험 중' 으로 건너뛴다(대기를 지우면 판정 없이 켜진 채 남는다).
  const stale = want.filter((id) => byId.get(id)?.enabled === false && _pending.some((p) => p.targetId === id));
  if (stale.length) cancelTrials(stale, '다시 시험해 앞선 대기를 멈췄습니다.');
  const pendingIds = new Set(_pending.map((p) => p.targetId));
  const localAgents = deps.localAgents || (isMockMode() ? new Set(demoEdgeList().map((e) => e.name)) : new Set());
  const plan = planTrial(want.map((id) => byId.get(id) || null).filter(Boolean), { executes: deps.executes ?? executesHere(), assignments, assignUnreadable, pendingIds, localAgents });
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
    const sigOf = new Map(sync.filter((s) => s.ok).map((s) => [s.agent, t(s.sig)]));   // v2.987(반증 R1): 이번 시험이 굳힌 sig
    const revert = [];
    for (const e of plan.edge) {
      const item = { targetId: e.targetId, name: e.name, path: e.path, host: e.host, where: 'edge', agent: e.agent, tests: [] };
      if (failed.has(e.agent)) { revert.push(e.targetId); job.items.push({ ...item, state: 'fail', reason: `엣지 배정 동기화 실패 — ${failed.get(e.agent)}` }); continue; }
      const deadline = now + edgeDeadlineMs(e.expectMs);
      muteTarget(e.path, e.name, deadline, e.kind);
      _pending.push({ targetId: e.targetId, jobId: job.id, agent: e.agent, path: e.path, name: e.name, host: e.host, kind: e.kind, sig: sigOf.get(e.agent) || '', startedAt: now, deadline, expect: e.expect, expectMs: e.expectMs || 0 });
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
  const readyOf = deps.ready || (deps.ackAt ? (a) => ({ sig: '', ackAt: Number(deps.ackAt(a)) || 0, confirmAt: 0 }) : defaultReady());
  for (const [agent, list] of byAgent) {
    const rows = (deps.edgeRows || edgeRowsOf)(agent) || [];
    // v2.987(쉬운 등록 후속): 엣지가 **이번 시험 뒤의 배정을 적용한 것이 확인된 뒤** 잰 결과만 받는다 — 그 전 행은 옛 스냅샷의 측정이다(readyAtFor).
    const info = readyOf(agent);
    // (경로 · 대상 이름) → 대기 목록. 판정은 대기(=대상 id)마다 한다(반증 M2: 키가 같으면 앞 건을 덮었다).
    const byKey = new Map();
    for (const p of list) {
      const k = `${p.path}\u0001${p.name.toLowerCase()}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push({ p, got: new Map() });
    }
    for (const r of rows) {
      const ws = byKey.get(`${t(r.path)}\u0001${t(r.target).toLowerCase()}`);
      if (!ws) continue;
      for (const w of ws) {
        // v2.960(반증 M3 — 재현): 이번 시험의 행만 — 시작 뒤에 잰 것 · 지금 주소(옛 스냅샷의 옛 주소 행이 아님) · 기대 점검 이름. 같은 점검은 가장 최근 행 하나.
        if (!(Number(r.measuredAt) >= w.p.startedAt)) continue;
        const readyAt = readyAtFor(w.p, info);
        if (!readyAt || !(Number(r.measuredAt) >= readyAt)) continue;
        if (t(r.kind) && t(r.kind) !== w.p.kind) continue;   // v2.987: 같은 경로 · 이름의 다른 구분 대상 행(옛 엣지는 구분을 싣지 않는다 — 그때는 거르지 않는다)
        if (w.p.host && t(r.host) && t(r.host).toLowerCase() !== w.p.host.toLowerCase()) continue;
        const name = t(r.test);
        if (w.p.expect.length && !w.p.expect.includes(name)) continue;
        const prev = w.got.get(name);
        if (prev && prev.measuredAt >= Number(r.measuredAt)) continue;
        w.got.set(name, { name, status: t(r.status), reply: t(r.reply).slice(0, 160), ms: Number.isFinite(r.ms) ? r.ms : null, measuredAt: Number(r.measuredAt) });
      }
    }
    for (const ws of byKey.values()) {
      for (const { p, got: gotMap } of ws) {
        const got = [...gotMap.values()].map(({ measuredAt, ...x }) => x);
        const j = judgeTrial(got, p.expect.length || 1);
        if (j.verdict === 'wait') {
          if (now >= p.deadline) finished.push({ p, state: 'fail', reason: got.length ? `시한까지 일부만 보고됨(${got.length}/${p.expect.length}) — 중지로 되돌렸습니다.` : '시한까지 엣지 보고가 없었습니다 — 중지로 되돌렸습니다.', tests: got });
          continue;
        }
        finished.push({ p, state: j.verdict, reason: j.verdict === 'fail' ? j.reason : '', tests: got });
      }
    }
  }
  if (!finished.length) return { judged: 0 };
  const done = new Set(finished.map((f) => f.p));
  _pending = _pending.filter((p) => !done.has(p));
  const reverts = finished.filter((f) => f.state === 'fail');
  let syncFail = [];
  if (reverts.length) {
    // 이미 꺼져 있으면(사람이 껐다) 그대로 — setEnabledMany 는 바뀐 것만 센다. 배정은 시작 때 엣지 + 지금 대상의 엣지를 다시 굳힌다.
    const en = (deps.setEnabled || setEnabledMany)({ targets: reverts.map((f) => f.p.targetId), enabled: false });
    const agents = [...new Set([...reverts.map((f) => f.p.agent), ...(en?.agents || [])])];
    syncFail = ((deps.sync || syncByAgentAssignments)(agents, 'system', { note: '시험 점검 — 실패 대상 중지' }) || []).filter((x) => !x.ok);
  }
  const failAgents = new Map(syncFail.map((x) => [x.agent, x.reason || '']));
  for (const f of finished) {
    if (f.state === 'fail') {
      muteTarget(f.p.path, f.p.name, now + revertMuteMs(f.p.expectMs), f.p.kind);   // 반증 M1: 엣지가 다음 당기기까지 옛 스냅샷으로 잰다
      if (failAgents.has(f.p.agent)) f.reason = `${f.reason} 엣지 배정은 다시 굳히지 못했습니다 — ${failAgents.get(f.p.agent)}`.slice(0, 400);
    } else unmuteTarget(f.p.path, f.p.name, f.p.kind);
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
    out.push({ path: m.p, target: m.n, host: m.h, kind: m.k || '', test: m.t, status: r.s, reply: r.r, ms: r.m, measuredAt: r.measuredAt });
  }
  return out;
}

/**
 * 대기 취소 — 사람이 그 대상을 켜거나 끄거나 지우면(라우트) 시험 판정이 사람의 마지막 조작을 뒤집지 않게 멈춘다(반증 M2 — 재현:
 *   대기 중 사람이 껐다 다시 켰는데 시한이 지나자 system 이 껐다). 억제도 푼다(사람이 켠 대상의 실패는 알려야 한다).
 * @returns {number} 취소한 수
 */
export function cancelTrials(targetIds = [], reason = '사람이 사용/중지를 바꿔 시험을 멈췄습니다.') {
  loadPending();
  const ids = new Set((targetIds || []).map(t).filter(Boolean));
  if (!ids.size) return 0;
  const gone = _pending.filter((p) => ids.has(p.targetId));
  if (!gone.length) return 0;
  _pending = _pending.filter((p) => !ids.has(p.targetId));
  for (const p of gone) {
    unmuteTarget(p.path, p.name, p.kind);
    _last.delete(p.targetId);
    const job = _jobs.get(p.jobId);
    const item = job?.items.find((x) => x.targetId === p.targetId);
    if (item && item.state === 'wait') { item.state = 'skip'; item.reason = reason; recount(job); }
  }
  savePending();
  if (!_pending.length) stopTimer();
  return gone.length;
}

/** 엣지별 배정 ack 시각(배정 파일 — 한 판정에 한 번 읽는다). 못 읽으면 0(= 아직 적용 확인 안 됨 — 시한까지 기다린다). */
/**
 * v2.987(반증 R1 · R6): 이 대기 건의 행을 언제부터 받을까 — 0 이면 아직 기다린다.
 *   ① 시험이 굳힌 sig 가 지금 sig 이고 그 sig 의 ack 가 **시작 전**이다 = 대상이 이미 켜진 채 배정에 실려 있었다(sig 가 바뀌지 않아 ack 가 남았다 —
 *      PUT 으로 끈 대상 · 동기화 없이 처리된 대상) → 엣지는 이 정의로 계속 재고 있다: 시작 이후 행.
 *   ② ack(지금 sig) 또는 '변경 없음' pull 확인(지금 sig 가 오류 없이 적용된 적이 있을 때만 — svcmonAssign.noteUnchangedPull)이 시작 이후 → 그 시각 이후 행.
 *      배정이 엣지가 이미 적용한 sig 로 되돌아오면(A→B→A) 엣지는 unchanged 를 받고 다시 ack 하지 않는다 — ack 만 보면 시한까지 기다려 거짓 실패였다(R1 재현).
 *   여유를 두지 않는다(R6: ack − 10초 여유가 옛 스냅샷 행을 받았다). measuredAt 은 중앙 수신 시각 − 경과라 엣지 시계와 무관하다 — 적용 직후 잰 행을 놓쳐도 다음 주기에 받는다.
 */
export function readyAtFor(p, info) {
  if (!info) return 0;
  if (p.sig && info.sig === p.sig && info.ackAt && info.ackAt < p.startedAt) return p.startedAt;
  const at = Math.max(Number(info.ackAt) || 0, Number(info.confirmAt) || 0);
  return at >= p.startedAt ? at : 0;
}
function defaultReady() {
  const m = new Map();   // 틱 하나에 엣지마다 한 번
  return (agent) => {
    if (!m.has(agent)) { let v = null; try { v = assignReadiness(agent); } catch { v = null; } m.set(agent, v); }
    return m.get(agent);
  };
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
  for (const p of _pending) muteTarget(p.path, p.name, p.deadline, p.kind);
  console.log(`[svcmon] 시험 점검 엣지 대기 ${_pending.length}건을 이어서 판정합니다.`);
  ensureTimer();
  setTimeout(() => { try { trialTick(); } catch { /* 다음 주기 */ } }, 5_000).unref?.();
}

/** 테스트 전용. */
export function _resetTrialForTest({ reload = false } = {}) { _jobs.clear(); _last.clear(); _pending = []; _loaded = !reload; _localRunning = false; stopTimer(); }
