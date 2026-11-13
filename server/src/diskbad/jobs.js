/**
 * diskbad/jobs.js — **중앙**의 점검 작업(전체 · 법인 · 서버 1대)과 6시간 자동 점검(v2.915).
 *
 * 법인 · vCenter · 엣지는 1:1 이다(루트 CLAUDE.md). 그래서 작업 하나를 **엣지(agent) 단위 조각(unit)** 으로 나눈다:
 *  · 중앙 직결 서버 → 'local' 조각(중앙이 직접 읽는다 — 엣지가 없는 법인의 예외 경로).
 *  · 위임 법인 서버 → 'edge' 조각. 엣지가 1분마다 `GET /api/central/disk-bad-job` 으로 **가져가고**(claim) 그 법인 안에서 읽은 뒤
 *    25대씩 `POST /api/central/disk-bad` 로 올린다. 중앙은 서버 수만큼 WAN 을 왕복하지 않는다.
 *
 * 규칙(설계 README §9.3 · §13.1):
 *  · 잠금은 **엣지(법인) 단위** — 그 엣지에 대기 · 진행 중인 조각이 있으면 새 작업에서 그 엣지는 'busy' 로 건너뛴다(다른 엣지는 돈다).
 *  · 가져가지 않으면 15분 뒤 '시작 못 함', 진행 중인데 45분 소식이 없으면 '응답 없음'으로 닫는다(끝나지 않는 작업을 남기지 않는다).
 *  · 보고는 **그 엣지가 가져간 조각에만** 받는다(요청하지 않은 보고로 다른 법인 기록을 덮지 못하게).
 *  · 작업 기록은 메모리(최근 30개)다 — 재시작하면 진행 표시는 사라지지만 결과는 DB 에 남는다(화면이 그렇게 말한다).
 */
import { randomUUID } from 'node:crypto';
import { ingestServers } from './db.js';
import { scanServers, localServers } from './scan.js';
import { loadDiskBadSettings } from './settings.js';
import { notifyNewRecords } from './notify.js';

export const CLAIM_TIMEOUT_MS = 15 * 60_000;
export const STALL_TIMEOUT_MS = 45 * 60_000;
const JOBS_MAX = 30;
const isEdgeNode = async () => { try { return !!(await import('../config.js')).config.agent.centralUrl; } catch { return false; } };

const jobs = new Map();           // id → job
let _autoTimer = null;
let _autoLast = null;
let _corpOf = () => null;         // (agent, serverId) → { id, name } — 라우트가 주입(도메인이 routes 를 import 하지 않게)

export function setCorpResolver(fn) { if (typeof fn === 'function') _corpOf = fn; }

const now = () => Date.now();
const active = (st) => st === 'queued' || st === 'running';
const normAgent = (a) => String(a || '').trim().toLowerCase();

function trim() {
  const list = [...jobs.values()].sort((a, b) => b.at - a.at);
  for (const j of list.slice(JOBS_MAX)) if (!j.units.some((u) => active(u.state))) jobs.delete(j.id);
}

/** 대기 · 진행 조각의 시한을 본다(읽을 때마다 · 1분마다). */
export function sweepJobs(t = now()) {
  for (const j of jobs.values()) {
    for (const u of j.units) {
      if (u.state === 'queued' && u.kind === 'edge' && t - j.at > CLAIM_TIMEOUT_MS) { u.state = 'not-started'; u.finishedAt = t; u.error = '엣지가 작업을 가져가지 않았습니다(엣지가 꺼져 있거나 이 기능이 없는 판일 수 있습니다).'; }
      if (u.state === 'running' && u.kind === 'edge' && t - (u.updatedAt || u.claimedAt || j.at) > STALL_TIMEOUT_MS) { u.state = 'no-response'; u.finishedAt = t; u.error = '엣지가 진행을 보고하지 않습니다.'; }
    }
    if (!j.finishedAt && !j.units.some((u) => active(u.state))) j.finishedAt = t;
  }
}

function busyAgents() {
  const out = new Set();
  for (const j of jobs.values()) for (const u of j.units) if (active(u.state)) out.add(normAgent(u.agent));
  return out;
}

/**
 * 작업을 만든다.
 * @param {{scope:'all'|'corp'|'server', target?:string, targetLabel?:string, mode?:'incremental'|'full', by?:string, auto?:boolean, manual?:boolean,
 *   units:Array<{agent:string, kind:'local'|'edge', serverIds:string[]|null, label?:string}>}} p
 */
export function createJob({ scope, target = '', targetLabel = '', mode = 'incremental', by = '', auto = false, manual = false, units = [] }) {
  sweepJobs();
  const busy = busyAgents();
  const job = {
    id: randomUUID(), scope, target: String(target).slice(0, 128), targetLabel: String(targetLabel).slice(0, 128),
    mode: mode === 'full' ? 'full' : 'incremental', by: String(by).slice(0, 64), auto: !!auto, manual: !!manual, at: now(), finishedAt: null,
    units: units.map((u) => ({
      agent: normAgent(u.agent), label: String(u.label || u.agent || '중앙 직결').slice(0, 128), kind: u.kind === 'local' ? 'local' : 'edge',
      serverIds: Array.isArray(u.serverIds) ? u.serverIds.map(String).slice(0, 5_000) : null,
      state: busy.has(normAgent(u.agent)) ? 'busy' : 'queued', total: Array.isArray(u.serverIds) ? u.serverIds.length : null,
      done: 0, failed: 0, excluded: 0, newRecords: 0, claimedAt: null, updatedAt: null, finishedAt: null, error: '', stop: false, _new: [],
    })),
  };
  jobs.set(job.id, job);
  trim();
  for (const u of job.units) if (u.kind === 'local' && u.state === 'queued') runLocal(job, u).catch(() => {});
  if (!job.units.some((u) => active(u.state))) job.finishedAt = now();
  return publicJob(job);
}

async function runLocal(job, u) {
  u.state = 'running'; u.claimedAt = now(); u.updatedAt = u.claimedAt;
  try {
    const servers = await localServers();
    const stat = await scanServers(servers, {
      mode: job.mode, manual: job.manual, serverIds: u.serverIds,
      shouldStop: () => u.stop,
      onProgress: (p) => { u.total = p.total; u.done = p.done; u.failed = p.failed; u.excluded = p.excluded; u.updatedAt = now(); },
      onChunk: async (batch) => {
        if (!batch.length) return;
        const { cleanServer } = await import('./ingest.js');
        const t = now();
        const r = await ingestServers('', batch.map((x) => cleanServer(x, t)).filter(Boolean), { now: t });
        if (!r.ok) throw new Error(r.reason || 'DB 저장 실패');
        u.newRecords += r.newRecords.length; u._new.push(...r.newRecords.slice(0, 2_000));
      },
    });
    u.total = stat.total; u.done = stat.done; u.failed = stat.failed; u.excluded = stat.excluded;
    u.state = u.stop ? 'stopped' : 'done';
  } catch (e) {
    u.state = 'failed'; u.error = String(e?.message || e).slice(0, 200);
    console.warn(`[diskbad] 중앙 직결 점검 실패: ${u.error}`);
  }
  u.finishedAt = now();
  finishUnit(job, u);
}

function finishUnit(job, u) {
  if (!job.units.some((x) => active(x.state))) job.finishedAt = now();
  const fresh = u._new; u._new = [];
  console.log(`[diskbad] ${job.auto ? '자동' : '수동'} 점검(${job.scope}${job.targetLabel ? ` ${job.targetLabel}` : ''}) ${u.label}: ${u.state} — 서버 ${u.done}/${u.total ?? '?'} · 실패 ${u.failed} · 새 기록 ${u.newRecords}`);
  if (fresh.length) notifyNewRecords(fresh, { corpOf: _corpOf, job }).catch((e) => console.warn(`[diskbad] 메일 실패: ${String(e?.message || e).slice(0, 200)}`));
}

/** 엣지가 가져갈 작업(가장 오래된 대기 조각). 없으면 null. */
export function claimForAgent(agent) {
  sweepJobs();
  const a = normAgent(agent);
  const list = [...jobs.values()].sort((x, y) => x.at - y.at);
  for (const j of list) {
    const u = j.units.find((x) => x.kind === 'edge' && x.agent === a && x.state === 'queued');
    if (u) {
      u.state = 'running'; u.claimedAt = now(); u.updatedAt = u.claimedAt;
      return { id: j.id, mode: j.mode, manual: j.manual, serverIds: u.serverIds };
    }
  }
  return null;
}

/**
 * 엣지의 보고(정제된 묶음). 그 엣지가 가져간 조각이 아니면 받지 않는다.
 * @returns {Promise<{ok:boolean, stored:boolean, stop?:boolean, reason?:string, newRecords?:number}>}
 */
export async function acceptPush(agent, push) {
  const a = normAgent(agent);
  const j = jobs.get(push.jobId);
  const u = j ? j.units.find((x) => x.kind === 'edge' && x.agent === a) : null;
  if (!u || u.state !== 'running') return { ok: true, stored: false, reason: '이 엣지가 가져간 작업이 아니거나 이미 닫힌 작업입니다 — 보관하지 않았습니다.' };
  const t = now();
  const r = await ingestServers(a, push.servers, { now: t });
  if (!r.ok) return { ok: false, stored: false, reason: r.reason || 'DB 저장 실패' };
  u.newRecords += r.newRecords.length; u._new.push(...r.newRecords.slice(0, 2_000));
  if (push.total != null) u.total = push.total;
  if (push.done != null) u.done = push.done; else u.done += push.servers.length;
  if (push.failed != null) u.failed = push.failed;
  if (push.excluded != null) u.excluded = push.excluded;
  u.updatedAt = t;
  if (push.final) { u.state = u.stop ? 'stopped' : 'done'; u.finishedAt = t; finishUnit(j, u); }
  return { ok: true, stored: true, stop: u.stop === true, newRecords: r.newRecords.length };
}

/** 중단 — 대기 조각은 바로 닫고, 진행 조각은 다음 서버부터 멈추게 표시한다. agent 를 주면 그 조각만. */
export function stopJob(id, agent = null) {
  const j = jobs.get(String(id));
  if (!j) return null;
  const a = agent == null ? null : normAgent(agent);
  for (const u of j.units) {
    if (a != null && u.agent !== a) continue;
    if (u.state === 'queued') { u.state = 'stopped'; u.finishedAt = now(); }
    else if (u.state === 'running') u.stop = true;
  }
  if (!j.units.some((u) => active(u.state))) j.finishedAt = j.finishedAt || now();
  return publicJob(j);
}

/** 엣지 조각에 다시 보내기(시작 못 함 · 응답 없음 · 실패 뒤). 그 엣지가 바쁘면 거절. */
export function retryUnit(id, agent) {
  const j = jobs.get(String(id));
  const a = normAgent(agent);
  const u = j?.units.find((x) => x.agent === a);
  if (!u || active(u.state)) return null;
  if (busyAgents().has(a)) return { busy: true };
  Object.assign(u, { state: 'queued', done: 0, failed: 0, excluded: 0, newRecords: 0, claimedAt: null, updatedAt: null, finishedAt: null, error: '', stop: false, _new: [] });
  j.at = now(); j.finishedAt = null;
  if (u.kind === 'local') runLocal(j, u).catch(() => {});
  return publicJob(j);
}

export function publicJob(j) {
  const units = j.units.map(({ _new, ...u }) => u);
  const sum = (k) => units.reduce((acc, u) => acc + (Number(u[k]) || 0), 0);
  const knownTotal = units.every((u) => u.total != null) ? sum('total') : null;
  return {
    id: j.id, scope: j.scope, target: j.target, targetLabel: j.targetLabel, mode: j.mode, by: j.by, auto: j.auto, at: j.at, finishedAt: j.finishedAt,
    running: units.some((u) => active(u.state)), total: knownTotal, done: sum('done'), failed: sum('failed'), excluded: sum('excluded'), newRecords: sum('newRecords'),
    units,
  };
}

export function listJobs() {
  sweepJobs();
  return [...jobs.values()].sort((a, b) => b.at - a.at).map(publicJob);
}

export function getJob(id) { sweepJobs(); const j = jobs.get(String(id)); return j ? publicJob(j) : null; }

/** 엣지가 볼 중단 표시(진행 중 조각의 stop). */
export function stopFlagFor(agent, jobId) {
  const j = jobs.get(String(jobId));
  const u = j?.units.find((x) => x.agent === normAgent(agent));
  return !!u?.stop;
}

/** '전체' 작업의 조각 — 중앙 직결 서버 + 원격 서버를 가진 엣지마다 하나. */
export async function unitsForAll() {
  const units = [];
  const local = (await localServers()).filter((s) => s && s.type !== 'ome');
  if (local.length) units.push({ agent: '', kind: 'local', serverIds: null, label: '중앙 직결' });
  let remote = [];
  try { remote = (await import('../collector/remoteInventory.js')).allRemoteServers(); } catch { remote = []; }
  const agents = [...new Set(remote.map((s) => normAgent(s.collectorId)).filter(Boolean))];
  for (const a of agents) units.push({ agent: a, kind: 'edge', serverIds: null, label: a });
  return units;
}

/** 6시간 자동 점검. 설정이 꺼져 있으면 아무것도 하지 않는다(매 틱 다시 본다). 엣지에서는 돌지 않는다. */
export async function autoTick(t = now()) {
  if (await isEdgeNode()) return null;
  const st = loadDiskBadSettings();
  if (!st.autoEnabled) return null;
  const every = st.intervalHours * 3_600_000;
  if (_autoLast && t - _autoLast < every) return null;
  _autoLast = t;
  const units = await unitsForAll();
  const job = createJob({ scope: 'all', targetLabel: '전체', mode: 'incremental', by: 'auto', auto: true, units });
  console.log(`[diskbad] 자동 점검 시작 — 조각 ${units.length}개(${st.intervalHours}시간마다)`);
  return job;
}

export function autoStatus() {
  const st = loadDiskBadSettings();
  return { enabled: st.autoEnabled, intervalHours: st.intervalHours, lastAt: _autoLast, nextAt: st.autoEnabled ? (_autoLast ? _autoLast + st.intervalHours * 3_600_000 : null) : null };
}

export function startDiskBadJobs() {
  if (_autoTimer) return;
  _autoTimer = setInterval(() => { sweepJobs(); autoTick().catch((e) => console.warn(`[diskbad] 자동 점검 실패: ${String(e?.message || e).slice(0, 200)}`)); }, 60_000);
  _autoTimer.unref?.();
  // 기동 직후가 아니라 5분 뒤 첫 판정(다른 폴러와 겹치지 않게). 데모 모드는 화면이 비지 않게 한 번 읽는다.
  setTimeout(async () => {
    try {
      const { isMockMode } = await import('../mock/demo/flags.js');
      if (isMockMode() && !(await isEdgeNode()) && !listJobs().length) {
        createJob({ scope: 'all', targetLabel: '전체(데모)', mode: 'incremental', by: 'demo', units: await unitsForAll() });
      }
    } catch { /* */ }
  }, 20_000).unref?.();
  console.log(`[diskbad] 작업 관리 시작 — 자동 점검 ${loadDiskBadSettings().autoEnabled ? `켜짐(${loadDiskBadSettings().intervalHours}시간)` : '꺼짐(화면에서 켤 수 있음)'}`);
}

export function _resetJobsForTest() { jobs.clear(); _autoLast = null; }
