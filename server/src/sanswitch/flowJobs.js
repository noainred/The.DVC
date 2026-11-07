/**
 * sanswitch/flowJobs.js — Flow Vision 플로우 작업(v2.933 SAN·CVP 설계 C-②) — 실행 등록부 · 포탈 플로우 기록 · 15분 카운터 주기.
 *
 * 틀은 SAN 연결 테스트 대행(testRuns.js)과 같다:
 *   · 중앙이 직접 수집하는 스위치는 중앙이 SSH 로 바로 실행하고, 엣지 위임 스위치는 큐에 두면 엣지가 `/api/central/sanswitch-config` pull 때
 *     `flowNow` 로 가져가 **자기 등록부의 자격증명으로** 현지에서 실행하고 `/api/central/sanswitch-flow-result` 로 회신한다(대상 엣지만 회신 가능).
 *   · 엣지는 중앙이 보낸 명령 글자를 쓰지 않는다 — 동작 · 플로우 정의만 받아 flowCmd.js 로 **다시 검사하고 직접 만든다**.
 *   · 큐 항목에는 비밀이 없다(장치 id · 동작 · 플로우 정의). 결과는 아는 필드만 · 크기 제한.
 *   · pickup 10분 · 회신 5분 안에 없으면 실패로 닫고 사유를 남긴다(TTL 30분 · 동시 10).
 * 포탈 플로우 기록(san-flows.json — 비밀 없음): 만든 플로우 · 상태 · 최근 두 번의 카운터(델타용) · 스위치별 권한 점검 결과. 원자적 쓰기 + 손상 보존.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { withSsh } from '../proxy/sshExec.js';
import { withDeadline } from '../util/deadline.js';
import { CMD_TIMEOUT_MS } from './collectors/fosSsh.js';
import { buildFlowCommands, flowOutputIssue, parseFlowShow, parseFlowList, OUT_MAX, FLOW_NAME_RE } from './flowCmd.js';
import { isMockMode } from '../mock/demo/flags.js';
import { isSanDemoId } from '../mock/demo/sanswitch.js';
import { demoTargetKBps } from '../mock/demo/storpath.js';

const TTL_MS = 30 * 60_000;
const MAX_ACTIVE = 10;
export const EDGE_PICKUP_MS = 10 * 60_000;
export const EDGE_RESULT_MS = 5 * 60_000;
export const SHOW_EVERY_MS = Math.max(5 * 60_000, Number(process.env.SAN_FLOW_SHOW_MS) || 15 * 60_000);
const _jobs = new Map();

/* ── 포탈 플로우 기록 ───────────────────────────────────────────────────────────── */
const FILE = () => path.join(config.configDir, 'san-flows.json');
let _reg = null;
function load() {
  if (_reg) return _reg;
  let raw = null;
  try { if (fs.existsSync(FILE())) raw = JSON.parse(fs.readFileSync(FILE(), 'utf8')); }
  catch (e) { preserveCorrupt(FILE(), e?.message); raw = null; }
  const ok = raw && typeof raw === 'object' && !Array.isArray(raw);
  _reg = { flows: ok && Array.isArray(raw.flows) ? raw.flows.filter((f) => f && typeof f === 'object' && FLOW_NAME_RE.test(String(f.name || ''))).slice(0, 4096) : [],
    checks: ok && raw.checks && typeof raw.checks === 'object' && !Array.isArray(raw.checks) ? raw.checks : {} };
  return _reg;
}
function save() { atomicWriteFileSync(FILE(), JSON.stringify(_reg, null, 1)); }
export function listFlows({ includeDeleted = false } = {}) { return load().flows.filter((f) => includeDeleted || f.state !== 'deleted').map((f) => ({ ...f })); }
export function flowChecks() { return { ...load().checks }; }
export function _resetFlowsForTest() { _reg = null; for (const j of _jobs.values()) if (j.timer) clearTimeout(j.timer); _jobs.clear(); }

/* ── 실행 ───────────────────────────────────────────────────────────────────────── */
const trace = (j, msg, level = 'info') => { if (j.trace.length < 300) j.trace.push({ t: Date.now() - j.startedAt, msg: String(msg).slice(0, 1000), level }); };

/**
 * 데모 스위치(mock-san-) — 접속하지 않고 그럴듯한 출력을 만든다(가상값). 카운터는 시각에 따라 늘어난다(한 주마다 0 으로 — 리셋 모습).
 *   속도는 데모 ESXi 경로 실측(demoTargetKBps)에 ±3% · 다섯에 하나는 +8% 를 더한다 — 교차검증 칸 · 5% 경고가 데모에서도 보이게.
 *   Rx = 스위치가 그 포트에서 받은 것(호스트 쓰기) · Tx = 보낸 것(호스트 읽기).
 */
function demoOutput(cmd, deviceId, cmds = [], now = Date.now()) {
  if (cmd === 'flow --show') {
    const names = listFlows().filter((f) => f.deviceId === deviceId).map((f) => f.name);
    return `Flow Name           | Feature   | SrcDev | DstDev | IngrPort\n${['sys_mon_all_fports', ...names].map((n) => `${n} | mon+ | * | * | *`).join('\n')}\n`;
  }
  let m = /^flow --create (\S+)/.exec(cmd);
  if (m) return `Flow ${m[1]} created and activated for monitor feature.`;
  m = /^flow --delete (\S+)/.exec(cmd);
  if (m) return `Flow ${m[1]} deleted.`;
  m = /^flow --show (\S+)/.exec(cmd);
  if (m) {
    // 만들기 작업 안의 첫 show 는 기록이 아직 없다 — 같은 작업의 create 명령에서 초기자 · 타깃을 읽는다.
    const rec = listFlows().find((f) => f.deviceId === deviceId && f.name === m[1]);
    const cm = rec ? null : cmds.map((c) => /^flow --create (\S+) .*-srcdev (\S+) -dstdev (\S+)/.exec(c)).find((x) => x && x[1] === m[1]);
    const k = demoTargetKBps(rec?.srcdev || cm?.[2] || m[1], rec?.dstdev || cm?.[3] || '');
    const noise = (((k.h >>> 5) % 61) - 30) / 1000 + (k.h % 5 === 0 ? 0.08 : 0);
    const rx = Math.round(k.wKBps * 1024 * (1 + noise)); const tx = Math.round(k.rKBps * 1024 * (1 + noise));
    const t = (now % (7 * 86_400_000)) / 1000;   // 밀리초까지 — 데모에서 몇 초 간격으로 두 번 읽어도 속도가 튀지 않게
    return `Name          : ${m[1]}   Features: mon(Activated)\n`
      + '| Rx Frames Count | Tx Frames Count | Rx Bytes Count | Tx Bytes Count | Rx Throughput(Bps) | Tx Throughput(Bps) |\n'
      + '|-----------------|-----------------|----------------|----------------|--------------------|--------------------|\n'
      + `| ${Math.round(t * rx / 2048)} | ${Math.round(t * tx / 2048)} | ${Math.round(t * rx)} | ${Math.round(t * tx)} | ${rx} | ${tx} |\n`;
  }
  return '';
}

/**
 * 명령 실행(이 노드에서) — 장비의 SSH 자격증명 · 명령마다 시한 · 출력 상한. 오류 문구는 flowOutputIssue 로 분류한다.
 * @returns {Promise<{ ok:boolean, outputs:Array<{cmd, ok, out, issue?}>, reason?:string }>}
 */
/** 세션 시한 — 명령 수 × 명령 시한 + 15초, 4분 상한(엣지 회신 시한 5분 안에 끝나게 · 넘으면 세션을 실제로 끊는다). */
export const flowSessionMs = (n) => Math.min(4 * 60_000, Math.max(1, Number(n) || 1) * CMD_TIMEOUT_MS + 15_000);
export async function runFlowCommands(device, cmds, { onTrace = null } = {}) {
  const outputs = [];
  if (isMockMode() && isSanDemoId(device?.id)) {
    for (const cmd of cmds) { const out = demoOutput(cmd, device.id, cmds); const issue = flowOutputIssue(out); outputs.push({ cmd, ok: !issue, out, ...(issue ? { issue } : {}) }); }
    return { ok: outputs.every((o) => o.ok), outputs, demo: true };
  }
  try {
    await withDeadline(flowSessionMs(cmds.length), (signal) => withSsh({ host: device.host, port: Number(device.sshPort) || 22, username: device.username, password: device.password || '', signal, trace: onTrace, verbose: false }, async (sh) => {
      for (const cmd of cmds) {
        onTrace?.(`실행: ${cmd}`);
        const r = await sh.exec(cmd, CMD_TIMEOUT_MS);
        const out = `${String(r.stdout || '')}${r.stderr ? `\n${String(r.stderr)}` : ''}`.slice(0, OUT_MAX);
        const issue = flowOutputIssue(out);
        outputs.push({ cmd, ok: !issue, out, ...(issue ? { issue } : {}) });
        if (issue && /^flow --create/.test(cmd) && issue.kind !== 'exists') break;   // 만들기가 실패하면 뒤의 만들기를 하지 않는다
      }
    }), 'SAN 플로우 세션 시한');
  } catch (e) {
    return { ok: false, outputs, reason: String(e?.message || e).slice(0, 500) };
  }
  return { ok: outputs.length > 0 && outputs.every((o) => o.ok), outputs };
}

/** 결과를 포탈 플로우 기록에 반영한다(중앙). */
function applyResult(job, res) {
  const reg = load();
  const now = Date.now();
  const outs = Array.isArray(res?.outputs) ? res.outputs : [];
  if (job.action === 'check') {
    const o = outs[0];
    const issue = o ? (o.issue || flowOutputIssue(o.out)) : { kind: 'error', text: res?.reason || '출력 없음' };
    const list = o && !issue ? parseFlowList(o.out) : null;
    // others — 사람이 만든 플로우 이름(보여 주기만 · 50개) · sys_ 로 시작하는 장비 기본 플로우도 그대로 둔다.
    reg.checks[job.deviceId] = { at: now, ok: !issue && !!o, kind: issue?.kind || null, text: issue?.text || null, total: list?.total ?? null, portal: list?.portal ?? null,
      others: list ? list.names.filter((n) => !n.startsWith('dvc_')).slice(0, 50) : [], by: job.user || '' };
  } else {
    for (const f of job.flows) {
      const created = outs.find((o) => o.cmd.startsWith(`flow --create ${f.name} `));
      const shown = outs.find((o) => o.cmd === `flow --show ${f.name}`);
      const deleted = outs.find((o) => o.cmd === `flow --delete ${f.name}`);
      let rec = reg.flows.find((x) => x.deviceId === job.deviceId && x.name === f.name);
      if (job.action === 'create') {
        const ok = created && (created.ok || created.issue?.kind === 'exists');
        if (!rec) { rec = { deviceId: job.deviceId, name: f.name, createdAt: now }; reg.flows.push(rec); }
        Object.assign(rec, { hostId: f.hostId || null, hostName: f.hostName || '', hba: f.hba || '', srcdev: f.srcdev, dstdev: f.dstdev, ingrport: f.ingrport,
          targetName: f.targetName || '', createdBy: job.user || '', state: ok ? 'active' : 'failed', lastError: ok ? null : (created?.issue?.text || res?.reason || '만들지 못했습니다') });
      }
      if (job.action === 'delete' && rec) { if (deleted?.ok || deleted?.issue?.kind === 'missing') { rec.state = 'deleted'; rec.deletedAt = now; rec.deletedBy = job.user || ''; rec.lastError = null; } else rec.lastError = deleted?.issue?.text || res?.reason || '지우지 못했습니다'; }
      if (shown && rec && rec.state !== 'deleted') {
        const p = parseFlowShow(shown.out);
        if (p.counters) { if (rec.counters) { rec.prevCounters = rec.counters; rec.prevAt = rec.lastAt; } rec.counters = p.counters; rec.lastAt = now; rec.active = p.active; rec.lastError = null; }
        else { rec.lastError = shown.issue?.text || '카운터 형식을 알아보지 못했습니다(원문은 작업 기록에)'; rec.lastAt = now; }
      }
    }
  }
  try { save(); } catch (e) { console.warn(`[san-flow] 플로우 기록 저장 실패: ${e.message}`); }
}

function finish(job, res) {
  if (job.status === 'done') return;
  job.result = sanitizeFlowResult(res, job);
  for (const o of job.result.outputs) trace(job, `${o.ok ? '완료' : '실패'}: ${o.cmd}${o.issue ? ` — ${o.issue.text}` : ''}`, o.ok ? 'info' : 'warn');
  if (job.result.reason) trace(job, job.result.reason, 'error');
  job.status = 'done'; job.finishedAt = Date.now();
  if (job.timer) clearTimeout(job.timer);
  applyResult(job, job.result);
}

/** 결과 정제 — 그 작업이 실행했어야 하는 명령만 · 출력 상한 · 아는 필드만(엣지 회신도 이것을 지난다). */
export function sanitizeFlowResult(res, job) {
  const r = res && typeof res === 'object' ? res : {};
  const expected = new Set(job?.cmds || []);
  const outputs = (Array.isArray(r.outputs) ? r.outputs : []).slice(0, 40)
    .filter((o) => o && typeof o === 'object' && typeof o.cmd === 'string' && expected.has(o.cmd))
    .map((o) => { const out = String(o.out ?? '').slice(0, OUT_MAX); const issue = flowOutputIssue(out); return { cmd: o.cmd, ok: !issue && o.ok === true, out, ...(issue ? { issue } : {}) }; });
  return { ok: outputs.length > 0 && outputs.every((o) => o.ok), outputs, ...(r.reason ? { reason: String(r.reason).slice(0, 500) } : {}), ...(r.demo === true ? { demo: true } : {}) };
}

function prune() { const cut = Date.now() - TTL_MS; for (const [id, j] of _jobs) if (j.startedAt < cut && j.status === 'done') _jobs.delete(id); }

/**
 * 작업 등록. device 는 등록부 장치(+password — 중앙 직접 실행에만 쓴다 · 큐 · 응답에는 넣지 않는다).
 * @param {{ device:object, action:'check'|'create'|'show'|'delete', flows?:Array, user?:string }} p
 * @returns {{ id:string, target:string } | { issue:string }}
 */
export function startFlowJob({ device, action, flows = [], user = '' } = {}) {
  prune();
  const built = buildFlowCommands(action, flows);
  if (built.issue) return { issue: built.issue };
  if ([..._jobs.values()].filter((j) => j.status !== 'done').length >= MAX_ACTIVE) return { issue: `진행 중인 플로우 작업이 ${MAX_ACTIVE}개를 넘습니다 — 잠시 뒤 다시 시도하세요` };
  if ([..._jobs.values()].some((j) => j.status !== 'done' && j.deviceId === device.id)) return { issue: '이 스위치에 진행 중인 플로우 작업이 있습니다 — 끝난 뒤 다시 시도하세요' };
  const id = crypto.randomBytes(8).toString('hex');
  const target = String(device.agent || '').trim();
  const job = { id, startedAt: Date.now(), status: 'running', deviceId: device.id, deviceName: device.name || device.id, target, user, action,
    flows: (flows || []).slice(0, 16).map((f) => ({ name: f.name, ingrport: f.ingrport, srcdev: f.srcdev, dstdev: f.dstdev, hostId: f.hostId || null, hostName: f.hostName || '', hba: f.hba || '', targetName: f.targetName || '' })),
    cmds: built.cmds, trace: [], result: null };
  _jobs.set(id, job);
  trace(job, `동작 ${action} · 명령 ${built.cmds.length}개`);
  if (!target || target === String(config.agent?.name || '')) {
    trace(job, '실행 위치: 이 포탈(수집 주체)');
    runFlowCommands(device, built.cmds, { onTrace: (m, lv) => trace(job, m, lv) })
      .then((res) => finish(job, res))
      .catch((e) => finish(job, { ok: false, outputs: [], reason: e.message }));
  } else {
    job.status = 'queued';
    trace(job, `실행 위치: 엣지 "${target}" — 다음 설정 pull 때 가져가 현지에서 실행합니다(이 포탈은 스위치에 직접 접속하지 않습니다)`);
    job.timer = setTimeout(() => {
      if (job.status === 'done') return;
      const reason = job.status === 'queued' ? `엣지 "${target}" 가 ${EDGE_PICKUP_MS / 60_000}분 안에 작업을 가져가지 않았습니다` : `엣지 "${target}" 가 ${EDGE_RESULT_MS / 60_000}분 안에 결과를 보내지 않았습니다`;
      finish(job, { ok: false, outputs: [], reason });
    }, EDGE_PICKUP_MS + EDGE_RESULT_MS);
    job.timer.unref?.();
  }
  return { id, target };
}

/** 이 엣지 몫 대기 작업을 꺼낸다(설정 pull 응답) — 비밀 없음(엣지가 자기 등록부 자격증명을 쓴다). */
export function takeFlowJobsForAgent(agent) {
  prune();
  const me = String(agent || '').toLowerCase();
  const out = [];
  for (const j of _jobs.values()) {
    if (j.status !== 'queued' || j.target.toLowerCase() !== me) continue;
    j.status = 'dispatched'; j.dispatchedAt = Date.now();
    trace(j, `엣지 "${j.target}" 가 작업을 가져갔습니다 — 결과를 기다립니다`);
    out.push({ id: j.id, deviceId: j.deviceId, action: j.action, flows: j.flows.map(({ name, ingrport, srcdev, dstdev }) => ({ name, ingrport, srcdev, dstdev })) });
    if (out.length >= 5) break;
  }
  return out;
}

/** 엣지 회신 — 그 작업의 대상 엣지만(남의 결과 위조 차단). */
export function completeFlowJob(id, agent, result) {
  const j = _jobs.get(String(id));
  if (!j) return { ok: false, reason: '알 수 없는(또는 만료된) 작업 id' };
  if (j.target.toLowerCase() !== String(agent || '').toLowerCase()) return { ok: false, reason: '이 작업의 대상 엣지가 아닙니다' };
  if (j.status === 'done') return { ok: true, already: true };
  finish(j, result);
  return { ok: true };
}

/** 화면용 — 비밀 · 장치 원본 없음. */
export function getFlowJob(id) {
  prune();
  const j = _jobs.get(String(id));
  if (!j) return null;
  return { id: j.id, status: j.status, action: j.action, deviceId: j.deviceId, deviceName: j.deviceName, target: j.target, user: j.user, startedAt: j.startedAt,
    elapsedMs: (j.finishedAt || Date.now()) - j.startedAt, cmds: j.cmds, trace: j.trace, result: j.result };
}
export function recentFlowJobs(limit = 20) {
  prune();
  return [...(_jobs.values())].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit).map((j) => getFlowJob(j.id));
}

/* ── 15분 카운터 주기 ───────────────────────────────────────────────────────────── */
let _timer = null;
/** 활성 포탈 플로우가 있는 스위치마다 `flow --show <name>` 작업을 하나씩(진행 중 작업이 있으면 건너뜀). deviceOf(id) 는 등록부 장치(+비밀). */
export function scheduleFlowShows(deviceOf, user = '주기 수집') {
  const byDev = new Map();
  for (const f of listFlows()) if (f.state === 'active') { if (!byDev.has(f.deviceId)) byDev.set(f.deviceId, []); byDev.get(f.deviceId).push(f); }
  let started = 0;
  for (const [devId, flows] of byDev) {
    const dev = deviceOf(devId);
    if (!dev) continue;
    const r = startFlowJob({ device: dev, action: 'show', flows: flows.slice(0, 16), user });
    if (!r.issue) started += 1;
  }
  return started;
}
export function startFlowShowTimer(deviceOf) {
  if (_timer) return;
  _timer = setInterval(() => { try { scheduleFlowShows(deviceOf); } catch (e) { console.warn(`[san-flow] 카운터 주기 실패: ${e.message}`); } }, SHOW_EVERY_MS);
  _timer.unref?.();
}
