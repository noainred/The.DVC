/**
 * vmclone/dispatch.js — VM 백업 센터의 **법인(엣지) 위임**(v2.793, 중앙 쪽).
 *
 * 사용자 요구(2026-10-26): "법인별로 백업 — 법인별 vCenter 와 법인별 백업 NFS 를 따로". 결정(사용자 선택):
 *   · 법인 = 그 vCenter 를 수집하는 엣지(수집 서버). 중앙이 직접 수집하는 vCenter 는 '중앙' 법인 하나.
 *   · 백업은 **담당 엣지가 실행**한다 — 중앙은 정의·화면·이력만. 중앙은 site vCenter 에 로그인하지 않는다(vcenter/collectTarget.js).
 *
 * 흐름
 *   정의   : 중앙 vm-clone.json 이 진실. 엣지가 GET /api/central/vm-clone-sync 로 자기 담당 vCenter 의 잡 정의를 당겨
 *            로컬 저장소에 위임 잡(origin:'central')으로 맞춘다(store.applyDelegatedJobs). 스케줄은 **엣지 스케줄러**가 돈다 —
 *            중앙과 통신이 끊겨도 백업은 계속된다.
 *   작업   : 지금 실행·검증·복구·NFS 데이터스토어 연결은 이 모듈의 작업 등록부(createOp)에 올린다. 실행 위치가 중앙이면 바로
 *            execOp.executeOp, 엣지면 대기(pending) → 엣지가 sync 응답으로 인출(claim) → 실행 → report 의 acks 로 회신(ack).
 *   상태   : 엣지가 POST /api/central/vm-clone-report 로 위임 잡의 lastRun·이력·원장·실행 상태·엣지 NFS 마운트를 올린다(인메모리).
 *
 * 규칙(되돌리지 말 것)
 *   · 담당 엣지는 **등록값(remoteAgent)이 먼저**이고, 관측값(위임 인벤토리를 올린 엣지)과 다르면 '충돌' 이다 — 어느 쪽에도 위임하지
 *     않는다(같은 VM 을 두 엣지가 스냅샷하지 않게. commmap/build.js ④ 와 같은 판정 순서).
 *   · 엣지 보고는 **아는 필드만·상한·글자만** 받는다(sanitizeReport). 잡 상태는 그 엣지 담당 vCenter 의 중앙 잡 id 만, 회신(ack)은
 *     그 엣지에 배정된 작업만 받는다(남의 결과 위조 차단).
 *   · 작업 회신에는 시한이 있다 — 대기는 PENDING_TTL_MS, 인출 뒤 진행 보고(inflight)가 CLAIM_MS 동안 없으면 '결과 미확인' 으로
 *     닫는다(복구·연결은 다시 내려보내지 않는다 — 같은 복구 VM 이 두 번 만들어지지 않게).
 *   · 엣지 보고·작업 등록부는 인메모리다 — 중앙이 재시작하면 대기 작업은 사라지고(화면이 말한다) 엣지 보고는 30초 안에 다시 찬다.
 */

import { listJobs, recordOp, listOps as listStoredOps } from './store.js';
import { applyAttachResult } from './nfsDs.js';
import { OP_KINDS, OP_LABEL } from './execOp.js';

export const PROTO = 1;
export const PENDING_TTL_MS = 30 * 60_000;   // 엣지가 가져가지 않은 작업의 수명
export const CLAIM_MS = 15 * 60_000;         // 인출 뒤 진행 보고 없이 기다리는 시한(보고마다 연장)
const OPS_MEM_MAX = 300;

const t = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const lower = (v) => t(v, 64).toLowerCase();

// ── 실행 위치 ────────────────────────────────────────────────────────────────

/**
 * vCenter 의 백업 실행 위치(순수).
 * @param {object|undefined} vc 등록부 항목 · @param {string} observedAgent 그 vCenter 인벤토리를 올린 엣지(없으면 '')
 * @returns {{where:'local'}|{where:'edge', agent:string}|{where:'conflict'|'none', reason:string, agent?:string}}
 */
export function execTargetOf(vc, observedAgent = '', { mock = false } = {}) {
  if (mock) {
    // 데모(mock)에는 실제 엣지가 없다 — 실행은 이 노드가 시뮬레이션하고, 법인 묶음만 데모 엣지 이름으로 보여 준다(corpAgent).
    const corpAgent = vc?.collectMode === 'site' ? (t(vc.remoteAgent, 64) || t(observedAgent, 64)) : '';
    return corpAgent ? { where: 'local', corpAgent } : { where: 'local' };
  }
  if (!vc) return { where: 'none', reason: '이 vCenter 의 등록 정보를 찾을 수 없습니다' };
  if (vc.collectMode !== 'site') return { where: 'local' };
  const declared = t(vc.remoteAgent, 64);
  const observed = t(observedAgent, 64);
  if (declared && observed && declared.toLowerCase() !== observed.toLowerCase()) {
    return { where: 'conflict', agent: declared, reason: `담당 엣지 불일치 — 등록 ‘${declared}’ · 실제로 인벤토리를 올린 엣지 ‘${observed}’ — 어느 쪽에도 맡기지 않습니다(설정 › vCenter 의 담당 엣지를 확인하세요)` };
  }
  const agent = declared || observed;
  if (!agent) return { where: 'none', reason: '담당 엣지를 아직 모릅니다 — 등록부에 담당 엣지가 없고 이 vCenter 인벤토리를 올린 엣지도 없습니다' };
  return { where: 'edge', agent };
}

/** 등록부·위임 인벤토리 → vcenterId → 실행 위치(순수). */
export function execTargets(vcenters, inventory, { mock = false } = {}) {
  const obs = new Map();
  for (const e of Array.isArray(inventory) ? inventory : []) if (e?.vcenterId != null) obs.set(String(e.vcenterId), t(e.agent, 64));
  const out = new Map();
  for (const v of Array.isArray(vcenters) ? vcenters : []) if (v?.id != null) out.set(String(v.id), execTargetOf(v, obs.get(String(v.id)) || '', { mock }));
  return out;
}

/**
 * 법인 묶음(순수) — 실행 위치가 같은 vCenter 끼리. 중앙 직접 수집은 key 'central'.
 * @returns {{key:string, label:string, agent:string, vcenterIds:string[], problem?:string}[]}
 */
export function corpsOf(vcenters, targets) {
  const m = new Map();
  for (const v of Array.isArray(vcenters) ? vcenters : []) {
    const id = String(v?.id ?? ''); if (!id) continue;
    const tg = targets.get(id) || { where: 'none', reason: '' };
    const sim = tg.where === 'local' && tg.corpAgent;   // 데모: 데모 엣지 이름으로 묶되 실행은 이 노드
    const key = sim ? `edge:${tg.corpAgent.toLowerCase()}` : tg.where === 'local' ? 'central' : tg.where === 'edge' ? `edge:${tg.agent.toLowerCase()}` : 'unassigned';
    if (!m.has(key)) {
      m.set(key, { key, label: sim ? tg.corpAgent : tg.where === 'local' ? '중앙' : tg.where === 'edge' ? tg.agent : '담당 미확정',
        agent: tg.where === 'edge' ? tg.agent : '', vcenterIds: [], ...(sim ? { simulated: true } : {}) });
    }
    const c = m.get(key);
    c.vcenterIds.push(id);
    if (key === 'unassigned' && tg.reason && !c.problem) c.problem = tg.reason;
  }
  return [...m.values()].sort((a, b) => (a.key === 'central' ? -1 : b.key === 'central' ? 1 : a.label.localeCompare(b.label)));
}

// ── 엣지 → 중앙 보고 ─────────────────────────────────────────────────────────

const _edges = new Map();   // agentLower → { agent, at, version, proto, runner, jobs: Map, mounts, sync }

const numOr = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const bool = (v) => v === true;
function cleanRun(r) {
  if (!r || typeof r !== 'object') return null;
  const at = numOr(r.at); if (at == null) return null;
  return { at, ok: bool(r.ok), detail: t(r.detail, 400), ms: Math.max(0, numOr(r.ms) || 0), ...(t(r.skipped, 40) ? { skipped: t(r.skipped, 40) } : {}) };
}
function cleanHist(h) {
  if (!h || typeof h !== 'object') return null;
  const at = numOr(h.at); if (at == null) return null;
  const kind = ['backup', 'verify', 'restore'].includes(h.kind) ? h.kind : 'backup';
  const phases = Array.isArray(h.phases) ? h.phases.slice(0, 12).map((p) => ({ n: t(p?.n, 60), ms: Math.max(0, numOr(p?.ms) || 0), ...(p?.ok === false ? { ok: false } : {}) })).filter((p) => p.n) : [];
  return { at, kind, ok: bool(h.ok), detail: t(h.detail, 300), ms: Math.max(0, numOr(h.ms) || 0),
    ...(t(h.trigger, 20) ? { trigger: t(h.trigger, 20) } : {}), ...(t(h.skipped, 40) ? { skipped: t(h.skipped, 40) } : {}), ...(phases.length ? { phases } : {}) };
}
function cleanClone(c) {
  if (!c || typeof c !== 'object') return null;
  const ref = t(c.ref, 120); const name = t(c.name, 200); const at = numOr(c.at);
  if (!ref || !name || at == null) return null;
  const bytes = numOr(c.bytes);
  const v = c.verify && typeof c.verify === 'object' ? { at: numOr(c.verify.at) || 0, ok: bool(c.verify.ok), detail: t(c.verify.detail, 300) } : null;
  return { ref, name, at, ...(bytes != null && bytes >= 0 ? { bytes } : {}), ...(v ? { verify: v } : {}) };
}

/**
 * 엣지 보고 정제(순수 — 테스트 고정). 아는 필드만·객체만·상한·문자열 수치는 수로.
 * @returns {{version:string, proto:number, runner:object, jobs:object[], mounts:object[], inflight:string[], acks:object[], sync:object}}
 */
export function sanitizeReport(b) {
  const body = b && typeof b === 'object' ? b : {};
  const jobs = [];
  for (const j of Array.isArray(body.jobs) ? body.jobs.slice(0, 200) : []) {
    const id = t(j?.id, 80); if (!id) continue;
    jobs.push({
      id, lastRun: cleanRun(j.lastRun),
      history: (Array.isArray(j.history) ? j.history.slice(-30) : []).map(cleanHist).filter(Boolean),
      clones: (Array.isArray(j.clones) ? j.clones.slice(-30) : []).map(cleanClone).filter(Boolean),
      ...(j.running === true ? { running: true } : {}),
      ...(t(j.problem, 200) ? { problem: t(j.problem, 200) } : {}),
    });
  }
  const r = body.runner && typeof body.runner === 'object' ? body.runner : {};
  const run = r.running && typeof r.running === 'object' ? {
    jobId: t(r.running.jobId, 80), kind: t(r.running.kind, 20), phase: t(r.running.phase, 120), startedAt: numOr(r.running.startedAt) || 0,
  } : null;
  const runner = {
    running: run && (run.jobId || run.kind) ? run : null,
    queued: (Array.isArray(r.queued) ? r.queued.slice(0, 200) : []).map((x) => t(x, 80)).filter(Boolean),
    queuedOps: (Array.isArray(r.queuedOps) ? r.queuedOps.slice(0, 100) : []).map((o) => ({ id: t(o?.id, 80), kind: t(o?.kind, 20), jobId: t(o?.jobId, 80) })).filter((o) => o.id),
  };
  const mounts = (Array.isArray(body.mounts) ? body.mounts.slice(0, 20) : []).map((m) => {
    const id = t(m?.id, 80); if (!id) return null;
    const free = numOr(m.freeBytes); const total = numOr(m.totalBytes);
    return { id, label: t(m.label, 300), mounted: bool(m.mounted), ...(free != null && free >= 0 ? { freeBytes: free } : {}), ...(total != null && total > 0 ? { totalBytes: total } : {}) };
  }).filter(Boolean);
  const acks = (Array.isArray(body.acks) ? body.acks.slice(0, 50) : []).map((a) => {
    const id = t(a?.id, 80); if (!id) return null;
    const hosts = (Array.isArray(a.hosts) ? a.hosts.slice(0, 500) : []).map((h) => ({ hostId: t(h?.hostId, 300), ok: bool(h?.ok), detail: t(h?.detail, 300) })).filter((h) => h.hostId);
    return { id, ok: bool(a.ok), detail: t(a.detail, 400), ms: Math.max(0, numOr(a.ms) || 0), ...(hosts.length ? { hosts } : {}), ...(t(a.newName, 80) ? { newName: t(a.newName, 80) } : {}) };
  }).filter(Boolean);
  const s = body.sync && typeof body.sync === 'object' ? body.sync : {};
  const list = (v) => (Array.isArray(v) ? v.slice(0, 20).map((x) => t(x, 200)).filter(Boolean) : []);
  return {
    version: t(body.version, 40), proto: numOr(body.proto) || 0, runner, jobs, mounts,
    inflight: (Array.isArray(body.inflight) ? body.inflight.slice(0, 100) : []).map((x) => t(x, 80)).filter(Boolean),
    acks,
    sync: { at: numOr(s.at) || 0, added: numOr(s.added) || 0, updated: numOr(s.updated) || 0, removed: numOr(s.removed) || 0, conflicts: list(s.conflicts), invalid: list(s.invalid), ...(t(s.error, 300) ? { error: t(s.error, 300) } : {}) },
  };
}

/**
 * 정제된 보고를 받는다. 잡 상태는 **이 엣지가 담당인 vCenter 의 중앙 잡**만, 회신은 이 엣지에 배정된 작업만.
 * @param {Map<string,object>} targets execTargets() 결과
 * @returns {{ok:true, jobs:number, droppedJobs:number, acked:string[], droppedAcks:number}}
 */
export function ingestReport(agent, clean, targets, now = Date.now()) {
  const key = lower(agent);
  const central = new Map(listJobs().map((j) => [j.id, j]));
  const mine = (vcId) => { const tg = targets.get(String(vcId)); return tg?.where === 'edge' && tg.agent.toLowerCase() === key; };
  const jobs = new Map();
  let droppedJobs = 0;
  for (const j of clean.jobs) {
    const def = central.get(j.id);
    if (!def || !mine(def.vcenterId)) { droppedJobs++; continue; }
    jobs.set(j.id, j);
  }
  _edges.set(key, { agent: t(agent, 64), at: now, version: clean.version, proto: clean.proto, runner: clean.runner, jobs, mounts: clean.mounts, sync: clean.sync, droppedJobs });
  noteInflight(agent, clean.inflight, now);
  const acked = []; let droppedAcks = 0;
  for (const a of clean.acks) { if (ackOp(agent, a.id, a, now)) acked.push(a.id); else droppedAcks++; }
  return { ok: true, jobs: jobs.size, droppedJobs, acked, droppedAcks };
}

/** 엣지 보고 상태(없으면 null). */
export function edgeStateOf(agent) { return _edges.get(lower(agent)) || null; }

// ── 작업 등록부 ──────────────────────────────────────────────────────────────

const _ops = new Map();   // id → op

function trimOps() {
  if (_ops.size <= OPS_MEM_MAX) return;
  const done = [..._ops.values()].filter((o) => o.state === 'done').sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0));
  for (const o of done.slice(0, _ops.size - OPS_MEM_MAX)) _ops.delete(o.id);
}

/** 작업 등록. 실행 위치(target)는 호출부가 정한다 — edge 면 대기로 두고 엣지가 인출한다. */
export function createOp({ kind, jobId = '', vcenterId = '', vmName = '', spec = {}, by = '', target }, now = Date.now()) {
  if (!OP_KINDS.includes(kind)) throw new Error(`모르는 작업 종류: ${kind}`);
  const id = `vco-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const op = {
    id, kind, label: OP_LABEL[kind], jobId: t(jobId, 80), vcenterId: t(vcenterId, 200), vmName: t(vmName, 200), spec, by: t(by, 80),
    where: target?.where === 'edge' ? 'edge' : 'local', agent: target?.where === 'edge' ? target.agent : '',
    state: 'pending', createdAt: now, claimedAt: 0, deadline: 0, doneAt: 0, result: null,
  };
  _ops.set(id, op);
  trimOps();
  return op;
}

/** 작업 마무리 — 결과 기록(영속) + NFS 연결 결과 반영. 이미 끝났으면 늦은 결과로 결과만 바꾼다. */
export function finishOp(op, result, now = Date.now(), { late = false } = {}) {
  const r = result && typeof result === 'object' ? result : { ok: false, detail: '빈 결과' };
  op.state = 'done'; op.doneAt = now;
  op.result = { ok: !!r.ok, detail: t(String(r.detail ?? ''), 400), ...(r.ms != null ? { ms: Math.max(0, Number(r.ms) || 0) } : {}), ...(r.newName ? { newName: t(r.newName, 80) } : {}), ...(late ? { late: true } : {}) };
  if (op.kind === 'nfsds-attach' && Array.isArray(r.hosts) && op.spec?.nfsDsId) applyAttachResult(op.spec.nfsDsId, r.hosts, now);
  try {
    recordOp({ id: op.id, kind: op.kind, jobId: op.jobId, vcenterId: op.vcenterId, vmName: op.vmName, at: now, ok: op.result.ok, detail: op.result.detail, ms: op.result.ms || (now - op.createdAt), agent: op.agent, by: op.by, target: op.spec?.newName || op.spec?.name || '' });
  } catch (e) { console.warn(`[vmclone] 작업 기록 저장 실패(${e?.message || e})`); }
  return op;
}

/** 엣지 인출 — 이 엣지에 배정된 대기 작업을 인출 상태로 바꿔 돌려준다(시한 CLAIM_MS). */
export function takeOps(agent, now = Date.now()) {
  reapOps(now);
  const key = lower(agent);
  const out = [];
  for (const op of _ops.values()) {
    if (op.where !== 'edge' || op.state !== 'pending' || op.agent.toLowerCase() !== key) continue;
    op.state = 'running'; op.claimedAt = now; op.deadline = now + CLAIM_MS;
    out.push({ id: op.id, kind: op.kind, jobId: op.jobId, vcenterId: op.vcenterId, spec: op.spec, by: op.by });
    if (out.length >= 20) break;
  }
  return out;
}

/** 엣지가 '아직 하는 중' 이라고 알린 작업의 시한을 늘린다. */
export function noteInflight(agent, ids, now = Date.now()) {
  const key = lower(agent);
  for (const id of ids || []) {
    const op = _ops.get(id);
    if (op && op.where === 'edge' && op.state === 'running' && op.agent.toLowerCase() === key) op.deadline = now + CLAIM_MS;
  }
}

/** 엣지 회신. 이 엣지에 배정된 작업이 아니면 false(남의 결과 위조 차단). 시한이 지나 닫힌 작업의 늦은 회신은 결과만 고친다. */
export function ackOp(agent, id, result, now = Date.now()) {
  const op = _ops.get(id);
  if (!op || op.where !== 'edge' || op.agent.toLowerCase() !== lower(agent)) return false;
  if (op.state === 'done') { if (op.result?.expired) finishOp(op, result, now, { late: true }); return true; }
  finishOp(op, result, now);
  return true;
}

/** 시한 지난 작업 닫기 — 대기 PENDING_TTL_MS · 인출 뒤 CLAIM_MS(보고마다 연장). */
export function reapOps(now = Date.now()) {
  for (const op of _ops.values()) {
    if (op.where !== 'edge' || op.state === 'done') continue;
    if (op.state === 'pending' && now - op.createdAt > PENDING_TTL_MS) {
      finishOp(op, { ok: false, detail: `담당 엣지(${op.agent})가 ${Math.round(PENDING_TTL_MS / 60_000)}분 동안 가져가지 않았습니다 — 엣지가 꺼졌거나 이 기능을 모르는 이전 버전이거나 중앙과 통신하지 못합니다` }, now);
      op.result.expired = true;
    } else if (op.state === 'running' && now > op.deadline) {
      finishOp(op, { ok: false, detail: `담당 엣지(${op.agent})가 ${Math.round(CLAIM_MS / 60_000)}분 넘게 진행을 알리지 않았습니다 — 결과 미확인(엣지 재시작·통신 장애일 수 있습니다 — vCenter 에서 확인하세요)` }, now);
      op.result.expired = true;
    }
  }
}

/** 화면용 작업 목록 — 진행 중(메모리) + 끝난 기록(영속). allowed(vcenterId Set)가 있으면 그 안만. */
export function listOpsView({ allowed = null, limit = 50 } = {}) {
  reapOps();
  const seen = new Set();
  const out = [];
  const inScope = (vc) => !allowed || (vc && allowed.has(String(vc)));
  for (const op of [..._ops.values()].sort((a, b) => b.createdAt - a.createdAt)) {
    if (!inScope(op.vcenterId)) continue;
    seen.add(op.id);
    out.push({ id: op.id, kind: op.kind, label: op.label, jobId: op.jobId, vcenterId: op.vcenterId, vmName: op.vmName, where: op.where, agent: op.agent, state: op.state,
      createdAt: op.createdAt, doneAt: op.doneAt || null, by: op.by, ...(op.result ? { ok: op.result.ok, detail: op.result.detail, ...(op.result.newName ? { newName: op.result.newName } : {}) } : {}),
      ...(op.spec?.ref ? { ref: t(op.spec.ref, 120) } : {}),   // 버튼 잠금은 그 사본만(web vmCloneView.busyOp)
      ...(op.spec?.newName ? { target: op.spec.newName } : op.spec?.name ? { target: op.spec.name } : {}) });
  }
  for (const r of listStoredOps().reverse()) {
    if (seen.has(r.id) || !inScope(r.vcenterId)) continue;
    out.push({ id: r.id, kind: r.kind, label: OP_LABEL[r.kind] || r.kind, jobId: r.jobId || '', vcenterId: r.vcenterId || '', vmName: r.vmName || '', where: r.agent ? 'edge' : 'local', agent: r.agent || '', state: 'done',
      createdAt: r.at - (r.ms || 0), doneAt: r.at, by: r.by || '', ok: r.ok, detail: r.detail, ...(r.target ? { target: r.target } : {}) });
  }
  return out.sort((a, b) => (b.doneAt || b.createdAt) - (a.doneAt || a.createdAt)).slice(0, limit);
}

/** 이 잡에 진행 중(대기·인출)인 같은 종류 작업이 있나 — 중복 클릭 방지. */
export function pendingOpFor(jobId, kind, ref = '') {
  for (const op of _ops.values()) {
    if (op.state !== 'done' && op.jobId === jobId && op.kind === kind && (!ref || op.spec?.ref === ref)) return op;
  }
  return null;
}

// ── 엣지 동기화 응답 ──────────────────────────────────────────────────────────

/** 위임 잡 정의(엣지가 받는 모양) — 실행 상태는 싣지 않는다. */
export function delegatedDef(j) {
  return { id: j.id, vcenterId: j.vcenterId, vmId: j.vmId, vmName: j.vmName, dest: j.dest, schedule: j.schedule, keep: j.keep, quiesce: !!j.quiesce, enabled: j.enabled !== false, verifyAfter: !!j.verifyAfter };
}

/**
 * 엣지 동기화 응답(순수에 가깝다 — jobs·targets 를 인자로). 이 엣지가 담당인 vCenter 와 그 잡 정의(데모 잡 제외).
 * @returns {{vcenters:string[], jobs:object[]}}
 */
export function syncPayloadFor(agent, jobs, targets) {
  const key = lower(agent);
  const vcenters = [];
  for (const [id, tg] of targets) if (tg.where === 'edge' && tg.agent.toLowerCase() === key) vcenters.push(id);
  const owned = new Set(vcenters);
  return { vcenters, jobs: (jobs || []).filter((j) => owned.has(String(j.vcenterId)) && j.demo !== true).map(delegatedDef) };
}

/** 테스트 전용. */
export function _resetDispatchForTest() { _ops.clear(); _edges.clear(); }
export function _opsForTest() { return _ops; }
