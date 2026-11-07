/**
 * sanswitch/flowJobs.js — Flow Vision 플로우 작업(v2.935 SAN·CVP 설계 C-②) — 실행 등록부 · 포탈 플로우 기록 · 카운터 주기.
 *
 * 틀은 SAN 연결 테스트 대행(testRuns.js)과 같다:
 *   · 중앙이 직접 수집하는 스위치는 중앙이 SSH 로 바로 실행하고, 엣지 위임 스위치는 큐에 두면 엣지가 `/api/central/sanswitch-config` pull 때
 *     `flowNow` 로 가져가 **자기 등록부의 자격증명으로** 현지에서 실행하고 `/api/central/sanswitch-flow-result` 로 회신한다(대상 엣지만 회신 가능).
 *   · 엣지는 중앙이 보낸 명령 글자를 쓰지 않는다 — 동작 · 플로우 정의만 받아 flowCmd.js 로 **다시 검사하고 직접 만든다**.
 *   · 큐 항목에는 비밀이 없다(장치 id · 동작 · 플로우 정의 · 남은 시한). 결과는 아는 필드만 · 크기 제한.
 *
 * v2.935 반증 1인 확정분(되돌리지 말 것):
 *   H-2 카운터 주기는 꺼진 스위치 · 인증 실패로 멈춘 스위치(sanAuthGuard — 폴러와 같은 정지 기록)에 로그인하지 않는다. 인증 실패는 정지 기록에 남긴다.
 *   M-1 live 모드에서 데모 장비(mock-san-)에 접속하지 않는다(폴러와 같은 규칙).
 *   M-2 만들기 전에 기록을 'pending' 으로 먼저 쓴다 · 결과를 모르면 'failed' 가 아니라 'unknown' · 시한 뒤 늦은 회신도 반영 · 엣지는 남은 시한(ttlMs)이
 *       지난 작업을 실행하지 않는다 · 재시작 때 남은 pending 은 unknown · 장비에 있는데 기록이 없는 dvc_ 플로우는 '기록 없음' 으로 보여 주고 지울 수 있다.
 *   M-3 'already exists' 는 같은 작업의 show 출력에 초기자 · 타깃 WWN 이 둘 다 보일 때만 활성, 아니면 'conflict'.
 *   M-4 카운터를 못 읽은 시도는 lastAt(성공 시각)을 움직이지 않는다(lastTryAt 따로).
 *   M-6 주기 작업은 사용자 작업 상한과 따로 세고, 오래전에 읽은 스위치부터 · 건너뛴 사유를 남긴다.
 *   L-7 지운 이름을 다시 쓰면 새 기록 · L-9 지운 기록은 30일 뒤 정리 · 다시 읽을 때 최신 4096개.
 *   L-11 중앙 직접 실행은 같은 스위치를 수집 중이면 기다린다(세션 겹침 방지).
 * 포탈 플로우 기록(san-flows.json — 비밀 없음): 만든 플로우 · 상태 · 최근 두 번의 카운터(델타용) · 스위치별 권한 점검 결과. 원자적 쓰기 + 손상 보존.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, clampIntervalMs } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { withSsh } from '../proxy/sshExec.js';
import { withDeadline } from '../util/deadline.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { CMD_TIMEOUT_MS } from './collectors/fosSsh.js';
import { buildFlowCommands, flowOutputIssue, parseFlowShow, parseFlowList, OUT_MAX, FLOW_NAME_RE, FLOW_PREFIX } from './flowCmd.js';
import { sanAuthGuard, isSanAuthError, isDeviceCollecting } from './poller.js';
import { isMockMode } from '../mock/demo/flags.js';
import { isSanDemoId } from '../mock/demo/sanswitch.js';
import { demoTargetKBps } from '../mock/demo/storpath.js';

const JOB_KEEP_MS = 60 * 60_000;
const MAX_USER_ACTIVE = 10;       // 사람이 누른 작업(점검 · 만들기 · 지우기 · 카운터 읽기)
const MAX_PERIODIC = 64;          // 주기 카운터 작업(대기 포함 — 사용자 상한을 막지 않게 따로 센다)
/**
 * 엣지 작업 시한 — 시작부터 결과까지. 산수: 엣지 설정 pull 주기(기본 5분) + 같은 호스트 수집 · 테스트 잠금 대기 + 세션 시한(최대 4분 — flowSessionMs)
 *   + 회신 재시도 → 20분. 넘으면 'unknown'(결과 모름)으로 닫고, 늦게 온 회신도 반영한다(반증 M-2 · L-10).
 */
export const EDGE_DEADLINE_MS = 20 * 60_000;
export const SHOW_EVERY_MS = clampIntervalMs(Number(process.env.SAN_FLOW_SHOW_MS) || 15 * 60_000, 15 * 60_000, 5 * 60_000);
const DELETED_KEEP_MS = 30 * 86_400_000;
const REC_MAX = 4096;
const POLLER_WAIT_MS = 90_000;
const _jobs = new Map();
const _log = createChangeLogger({ windowMs: 60 * 60_000, maxKeys: 64 });
let _lastCycle = null;

/* ── 포탈 플로우 기록 ───────────────────────────────────────────────────────────── */
const FILE = () => path.join(config.configDir, 'san-flows.json');
let _reg = null;
function load() {
  if (_reg) return _reg;
  let raw = null;
  try { if (fs.existsSync(FILE())) raw = JSON.parse(fs.readFileSync(FILE(), 'utf8')); }
  catch (e) { preserveCorrupt(FILE(), e?.message); raw = null; }
  const ok = raw && typeof raw === 'object' && !Array.isArray(raw);
  _reg = { flows: ok && Array.isArray(raw.flows) ? raw.flows.filter((f) => f && typeof f === 'object' && FLOW_NAME_RE.test(String(f.name || ''))).slice(-REC_MAX) : [],
    checks: ok && raw.checks && typeof raw.checks === 'object' && !Array.isArray(raw.checks) ? raw.checks : {} };
  // 재시작 전에 결과를 기다리던 만들기 — 작업 기록(인메모리)이 사라졌다. 만들어졌을 수 있으므로 '결과 모름'(반증 M-2).
  let fixed = 0;
  for (const f of _reg.flows) if (f.state === 'pending') { f.state = 'unknown'; f.lastError = '포탈이 다시 시작되어 만들기 결과를 받지 못했습니다 — 카운터 읽기 · 권한 점검으로 확인하세요'; fixed += 1; }
  if (fixed) { try { save(); } catch { /* 다음 저장에 */ } }
  return _reg;
}
function save() {
  const cut = Date.now() - DELETED_KEEP_MS;
  _reg.flows = _reg.flows.filter((f) => !(f.state === 'deleted' && Number(f.deletedAt || 0) < cut)).slice(-REC_MAX);   // 반증 L-9
  atomicWriteFileSync(FILE(), JSON.stringify(_reg, null, 1));
}
export function listFlows({ includeDeleted = false } = {}) { return load().flows.filter((f) => includeDeleted || f.state !== 'deleted').map((f) => ({ ...f })); }
export function flowChecks() { return { ...load().checks }; }
export function lastShowCycle() { return _lastCycle ? { ..._lastCycle } : null; }
export function _resetFlowsForTest() { _reg = null; for (const j of _jobs.values()) if (j.timer) clearTimeout(j.timer); _jobs.clear(); _lastCycle = null; }
/** 등록부에서 사라진 스위치의 기록을 정리한다(장비에 명령을 보내지 않는다 — 반증 L-11). */
export function forgetFlow(deviceId, name, user = '') {
  const rec = load().flows.find((f) => f.deviceId === deviceId && f.name === name && f.state !== 'deleted');
  if (!rec) return false;
  Object.assign(rec, { state: 'deleted', deletedAt: Date.now(), deletedBy: user, lastError: null, note: '스위치가 등록부에 없어 기록만 정리했습니다(장비에는 명령을 보내지 않았습니다)' });
  save();
  return true;
}

/* ── 실행 ───────────────────────────────────────────────────────────────────────── */
const trace = (j, msg, level = 'info') => { if (j.trace.length < 300) j.trace.push({ t: Date.now() - j.startedAt, msg: String(msg).slice(0, 1000), level }); };

/**
 * 데모 스위치(mock-san-) — 접속하지 않고 그럴듯한 출력을 만든다(가상값). 카운터는 시각에 따라 늘어난다(한 주마다 0 으로 — 리셋 모습).
 *   속도는 데모 ESXi 경로 실측(demoTargetKBps)에 ±3% · 다섯에 하나는 +8% 를 더한다 — 교차검증 칸 · 5% 경고가 데모에서도 보이게.
 *   Rx = 스위치가 그 포트에서 받은 것(호스트 쓰기) · Tx = 보낸 것(호스트 읽기).
 */
function demoOutput(cmd, deviceId, cmds = [], now = Date.now()) {
  if (cmd === 'flow --show') {
    const names = listFlows().filter((f) => f.deviceId === deviceId && f.state !== 'failed').map((f) => f.name);
    return `Flow Name           | Feature   | SrcDev | DstDev | IngrPort\n${['sys_mon_all_fports', ...names].map((n) => `${n} | mon+ | * | * | *`).join('\n')}\n`;
  }
  let m = /^flow --create (\S+)/.exec(cmd);
  if (m) return `Flow ${m[1]} created and activated for monitor feature.`;
  m = /^flow --delete (\S+)/.exec(cmd);
  if (m) return `Flow ${m[1]} deleted.`;
  m = /^flow --(deactivate|activate) (\S+)/.exec(cmd);
  if (m) return `Flow ${m[2]} ${m[1]}d for monitor feature.`;
  m = /^flow --show (\S+)/.exec(cmd);
  if (m) {
    // 만들기 작업 안의 첫 show — 같은 작업의 create 명령에서 초기자 · 타깃을 읽는다(기록보다 명령이 정확하다).
    const rec = listFlows().find((f) => f.deviceId === deviceId && f.name === m[1]);
    // 같은 작업에서 끄거나 켰으면 그 결과를 따른다(기록은 작업이 끝난 뒤에 바뀐다). 끈 동안 카운터는 끈 시각에 멈춘다.
    const toggled = cmds.find((c) => c.startsWith(`flow --deactivate ${m[1]} `)) ? false : cmds.find((c) => c.startsWith(`flow --activate ${m[1]} `)) ? true : null;
    const on = toggled ?? (rec?.state !== 'inactive');
    const cm = cmds.map((c) => /^flow --create (\S+) .*-srcdev (\S+) -dstdev (\S+)/.exec(c)).find((x) => x && x[1] === m[1]);
    const src = cm?.[2] || rec?.srcdev || ''; const dst = cm?.[3] || rec?.dstdev || '';
    const k = demoTargetKBps(src || m[1], dst);
    const noise = (((k.h >>> 5) % 61) - 30) / 1000 + (k.h % 5 === 0 ? 0.08 : 0);
    const rx = Math.round(k.wKBps * 1024 * (1 + noise)); const tx = Math.round(k.rKBps * 1024 * (1 + noise));
    const frozen = !on && rec?.deactivatedAt ? rec.deactivatedAt : (!on ? now : null);
    const t = ((frozen ?? now) % (7 * 86_400_000)) / 1000;   // 밀리초까지 — 데모에서 몇 초 간격으로 두 번 읽어도 속도가 튀지 않게
    return `Name          : ${m[1]}   Features: mon(${on ? 'Activated' : 'Deactivated'})\n`
      + `SrcDev: ${src || '-'}  DstDev: ${dst || '-'}\n`
      + '| Rx Frames Count | Tx Frames Count | Rx Bytes Count | Tx Bytes Count | Rx Throughput(Bps) | Tx Throughput(Bps) |\n'
      + '|-----------------|-----------------|----------------|----------------|--------------------|--------------------|\n'
      + `| ${Math.round(t * rx / 2048)} | ${Math.round(t * tx / 2048)} | ${Math.round(t * rx)} | ${Math.round(t * tx)} | ${rx} | ${tx} |\n`;
  }
  return '';
}

/** 세션 시한 — 명령 수 × 명령 시한 + 15초, 4분 상한(넘으면 세션을 실제로 끊는다). */
export const flowSessionMs = (n) => Math.min(4 * 60_000, Math.max(1, Number(n) || 1) * CMD_TIMEOUT_MS + 15_000);

/**
 * 명령 실행(이 노드에서) — 장비의 SSH 자격증명 · 세션 시한 · 출력 상한. 오류 문구는 flowOutputIssue 로 분류한다.
 *   live 모드의 데모 장비는 접속하지 않는다(반증 M-1). 인증 실패는 정지 기록에 남기고, 로그인이 되면 정지를 푼다(폴러와 같은 기록 — 반증 H-2).
 *   inFlight = 보냈는데 출력을 못 받은 명령(세션이 끊김 — 장비에 반영됐을 수 있다).
 * @returns {Promise<{ ok:boolean, outputs:Array<{cmd, ok, out, issue?}>, reason?:string, inFlight?:string, authFailed?:boolean, notRun?:boolean }>}
 */
export async function runFlowCommands(device, cmds, { onTrace = null } = {}) {
  const outputs = [];
  if (isSanDemoId(device?.id)) {
    if (!isMockMode()) return { ok: false, outputs, reason: '데모(mock) 장비는 live 모드에서 접속하지 않습니다(가상 주소) — 지우거나 데모 모드에서 보세요', notRun: true };
    for (const cmd of cmds) { const out = demoOutput(cmd, device.id, cmds); const issue = flowOutputIssue(out); outputs.push({ cmd, ok: !issue, out, ...(issue ? { issue } : {}) }); }
    return { ok: outputs.every((o) => o.ok), outputs, demo: true };
  }
  let inFlight = null; let loggedIn = false;
  try {
    await withDeadline(flowSessionMs(cmds.length), (signal) => withSsh({ host: device.host, port: Number(device.sshPort) || 22, username: device.username, password: device.password || '', signal, trace: onTrace, verbose: false }, async (sh) => {
      loggedIn = true;
      for (const cmd of cmds) {
        onTrace?.(`실행: ${cmd}`);
        inFlight = cmd;
        const r = await sh.exec(cmd, CMD_TIMEOUT_MS);
        inFlight = null;
        const out = `${String(r.stdout || '')}${r.stderr ? `\n${String(r.stderr)}` : ''}`.slice(0, OUT_MAX);
        const issue = flowOutputIssue(out);
        outputs.push({ cmd, ok: !issue, out, ...(issue ? { issue } : {}) });
        if (issue && /^flow --create/.test(cmd) && issue.kind !== 'exists') break;   // 만들기가 실패하면 뒤의 만들기를 하지 않는다
      }
    }), 'SAN 플로우 세션 시한');
  } catch (e) {
    const reason = String(e?.message || e).slice(0, 500);
    const authFailed = !loggedIn && isSanAuthError(e);
    if (authFailed) { try { sanAuthGuard.markAuthStopped(device.id, device, reason); } catch { /* 기록 실패는 사유로만 */ } }
    return { ok: false, outputs, reason, ...(inFlight ? { inFlight } : {}), ...(authFailed ? { authFailed: true } : {}) };
  }
  if (loggedIn) { try { sanAuthGuard.clearAuthStop(device.id); } catch { /* */ } }
  return { ok: outputs.length > 0 && outputs.every((o) => o.ok), outputs };
}

/**
 * 다시 켜짐(포탈 '다시 켜기' · 장비에서 켠 것 · 결과 모름에서 켜진 것으로 확인 — 판정 코어 하나, v2.940 반증 M-2): 카운터 기준을 새로 잡는다.
 *   직전 카운터를 남기면 켠 뒤 첫 델타가 꺼져 있던 시간까지 나눠 속도를 낮게 말한다.
 */
function markActivated(rec) { Object.assign(rec, { state: 'active', deactivatedAt: null, prevCounters: null, prevAt: null, counters: null }); }

/** 카운터 하나를 기록에 반영한다 — 못 읽으면 성공 시각(lastAt)을 움직이지 않는다(반증 M-4). */
function applyShow(rec, shown, now) {
  rec.lastTryAt = now;
  if (shown.issue?.kind === 'missing') {
    if (rec.state === 'unknown' || rec.state === 'pending') { rec.state = 'failed'; rec.lastError = '장비에 없습니다 — 만들어지지 않았습니다'; }
    else { rec.state = 'gone'; rec.lastError = '장비에 이 플로우가 없습니다(장비에서 지워졌을 수 있습니다)'; }
    return;
  }
  const p = parseFlowShow(shown.out);
  if (p.counters) {
    // 활성이 아니던 기록이 켜져 있음을 읽으면(장비에서 켬 · 결과 모름 · 장비에 없음에서 돌아옴) 기준을 새로 잡는다 — 직전 카운터로 델타를 내지 않는다.
    // 비활성 기록은 '켜짐' 을 실제로 읽었을 때만 켠다(활성 여부를 모르면 그대로) · 결과 모름 · 만드는 중 · 장비에 없음은 카운터를 읽은 것으로 활성.
    const intoActive = rec.state !== 'active' && (p.active === true || (p.active == null && rec.state !== 'inactive'));
    if (intoActive) markActivated(rec);
    else if (rec.counters) { rec.prevCounters = rec.counters; rec.prevAt = rec.lastAt; }
    rec.counters = p.counters; rec.lastAt = now; rec.active = p.active; rec.lastError = null;
    rec.rawSample = null;
    // 장비에서 직접 껐으면 따라간다(활성 여부를 읽었을 때만 — 모르면 그대로).
    if (p.active === false && rec.state !== 'inactive') { rec.state = 'inactive'; rec.deactivatedAt = rec.deactivatedAt || now; }
  } else {
    rec.lastError = shown.issue?.text || '카운터 형식을 알아보지 못했습니다(원문 앞부분은 기록에)';
    // v2.940: 출력 형식이 실장비 미확인이라 못 읽은 원문 앞부분을 기록에 남긴다(작업 기록은 1시간 뒤 사라진다 · 화면은 관리 주소를 가려 보여 준다).
    rec.rawSample = String(shown.out || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').slice(0, 400); // eslint-disable-line no-control-regex
  }
}

/** 결과를 포탈 플로우 기록에 반영한다(중앙). 늦은 회신도 같은 함수(반증 M-2). */
function applyResult(job, res, { late = false } = {}) {
  const reg = load();
  const now = Date.now();
  const outs = Array.isArray(res?.outputs) ? res.outputs : [];
  const timedOut = !!res?.timeout;
  if (job.action === 'check') {
    const o = outs[0];
    const issue = o ? (o.issue || flowOutputIssue(o.out)) : { kind: timedOut ? 'timeout' : 'error', text: res?.reason || '출력 없음' };
    const list = o && !issue ? parseFlowList(o.out) : null;
    const mine = new Set(reg.flows.filter((f) => f.deviceId === job.deviceId && f.state !== 'deleted').map((f) => f.name));
    reg.checks[job.deviceId] = { at: now, ok: !issue && !!o, kind: issue?.kind || null, text: issue?.text || null, total: list?.total ?? null, portal: list?.portal ?? null,
      // others — 사람이 만든 플로우(보여 주기만) · orphans — 장비에 있는데 포탈 기록이 없는 dvc_ 플로우(재시작 · 시한으로 기록을 놓친 것 — 지울 수 있다)
      others: list ? list.names.filter((n) => !n.startsWith(FLOW_PREFIX)).slice(0, 50) : [],
      orphans: list ? list.names.filter((n) => n.startsWith(FLOW_PREFIX) && !mine.has(n)).slice(0, 50) : [], by: job.user || '' };
  } else {
    for (const f of job.flows) {
      const created = outs.find((o) => o.cmd.startsWith(`flow --create ${f.name} `));
      const shown = outs.find((o) => o.cmd === `flow --show ${f.name}`);
      const deleted = outs.find((o) => o.cmd === `flow --delete ${f.name}`);
      const rec = reg.flows.find((x) => x.deviceId === job.deviceId && x.name === f.name && x.state !== 'deleted');
      // v2.940 반증 L-1: 시한 뒤에 온 늦은 회신은 그 뒤에 시작한 작업이 이미 반영됐으면 상태를 바꾸지 않는다(끄기 늦은 회신이 그 뒤 켜기를 덮지 않게).
      if (late && rec && Number(rec.lastJobAt || 0) > job.startedAt) continue;
      if (rec) rec.lastJobAt = Math.max(Number(rec.lastJobAt || 0), job.startedAt);
      if (job.action === 'create' && rec) {
        const createCmd = job.cmds.find((c) => c.startsWith(`flow --create ${f.name} `));
        if (created?.ok) { rec.state = 'active'; rec.lastError = null; }
        else if (created?.issue?.kind === 'exists') {
          const out = String(shown?.out || '').toLowerCase();
          if (out.includes(String(f.srcdev).toLowerCase()) && out.includes(String(f.dstdev).toLowerCase())) { rec.state = 'active'; rec.lastError = null; rec.note = '장비에 같은 정의의 플로우가 이미 있었습니다'; }
          else { rec.state = 'conflict'; rec.lastError = '같은 이름의 플로우가 장비에 이미 있습니다 — 정의(초기자 · 타깃)가 같은지 확인하지 못했습니다. 지우고 다시 만드세요'; }
        } else if (created) { rec.state = 'failed'; rec.lastError = created.issue?.text || '만들지 못했습니다'; }
        else if (res?.notRun) { rec.state = 'failed'; rec.lastError = res?.reason || '실행하지 않았습니다'; }
        else if (timedOut || res?.inFlight === createCmd) { rec.state = 'unknown'; rec.lastError = `${res?.reason || '결과를 받지 못했습니다'} — 장비에 만들어졌을 수 있습니다(카운터 읽기 · 권한 점검으로 확인)`; }
        else { rec.state = 'failed'; rec.lastError = res?.reason || '실행하지 못했습니다'; }
        rec.jobId = null;
      }
      if (job.action === 'deactivate' || job.action === 'activate') {
        const tog = outs.find((o) => o.cmd.startsWith(`flow --${job.action} ${f.name} `));
        const togCmd = job.cmds.find((c) => c.startsWith(`flow --${job.action} ${f.name} `));
        if (rec && tog?.ok) {
          if (job.action === 'deactivate') Object.assign(rec, { state: 'inactive', deactivatedAt: now, lastError: null });
          else { markActivated(rec); rec.lastError = null; }
        } else if (rec && tog?.issue?.kind === 'missing') { rec.state = 'gone'; rec.lastError = '장비에 이 플로우가 없습니다(장비에서 지워졌을 수 있습니다)'; }
        // v2.940 반증 L-2: 보냈는데 결과를 모르면(시한 · 세션 끊김) '결과 모름' — 주기 카운터 읽기가 활성 여부를 읽어 바로잡는다(만들기와 같은 규칙).
        else if (rec && !tog && !res?.notRun && (timedOut || res?.inFlight === togCmd)) { rec.state = 'unknown'; rec.lastError = `${job.action === 'deactivate' ? '비활성화' : '다시 켜기'} 결과를 모릅니다(${res?.reason || '결과 없음'}) — 다음 카운터 읽기가 장비 상태를 따라갑니다`; }
        else if (rec) rec.lastError = tog?.issue?.text || res?.reason || '바꾸지 못했습니다';
      }
      if (job.action === 'delete') {
        if (deleted?.ok || deleted?.issue?.kind === 'missing') {
          if (rec) Object.assign(rec, { state: 'deleted', deletedAt: now, deletedBy: job.user || '', lastError: null });
          const ck = reg.checks[job.deviceId];
          if (ck && Array.isArray(ck.orphans)) ck.orphans = ck.orphans.filter((n) => n !== f.name);
        } else if (rec) rec.lastError = deleted?.issue?.text || (timedOut ? '지우기 결과를 모릅니다 — 권한 점검 · 카운터 읽기로 확인하세요' : res?.reason || '지우지 못했습니다');
      }
      if (shown && rec && rec.state !== 'deleted' && rec.state !== 'failed' && rec.state !== 'conflict') applyShow(rec, shown, now);
      else if (job.action === 'show' && rec && !shown) { rec.lastTryAt = now; rec.lastError = res?.reason || '카운터를 읽지 못했습니다'; }
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
  return { ok: outputs.length > 0 && outputs.every((o) => o.ok), outputs, ...(r.reason ? { reason: String(r.reason).slice(0, 500) } : {}),
    ...(typeof r.inFlight === 'string' && expected.has(r.inFlight) ? { inFlight: r.inFlight } : {}),
    ...(r.timeout === true ? { timeout: true } : {}), ...(r.notRun === true ? { notRun: true } : {}), ...(r.authFailed === true ? { authFailed: true } : {}), ...(r.demo === true ? { demo: true } : {}) };
}

function prune() { const cut = Date.now() - JOB_KEEP_MS; for (const [id, j] of _jobs) if (j.startedAt < cut && j.status === 'done') _jobs.delete(id); }
const sameAgent = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** 같은 스위치를 지금 수집 중이면 끝날 때까지(최대 90초) 기다린다 — 중앙 직접 실행 세션이 주기 수집과 겹치지 않게(반증 L-11). */
async function waitPoller(job, deviceId) {
  if (!isDeviceCollecting(deviceId)) return;
  trace(job, '이 스위치를 지금 수집 중입니다 — 끝날 때까지 기다립니다(세션 겹침 방지)');
  const end = Date.now() + POLLER_WAIT_MS;
  while (isDeviceCollecting(deviceId) && Date.now() < end) await new Promise((r) => setTimeout(r, 2_000));
}

/**
 * 작업 등록. device 는 등록부 장치(+password — 중앙 직접 실행에만 쓴다 · 큐 · 응답에는 넣지 않는다).
 * @param {{ device:object, action:'check'|'create'|'show'|'delete', flows?:Array, user?:string, periodic?:boolean, canDelegate?:(agent:string)=>string|null }} p
 *   canDelegate — 엣지 위임 전 확인(구버전 엣지는 flowNow 를 모른다 — 반증 M-7). 거부 사유를 돌려주면 등록하지 않는다.
 * @returns {{ id:string, target:string } | { issue:string }}
 */
export function startFlowJob({ device, action, flows = [], user = '', periodic = false, canDelegate = null } = {}) {
  prune();
  const built = buildFlowCommands(action, flows);
  if (built.issue) return { issue: built.issue };
  if (isSanDemoId(device?.id) && !isMockMode()) return { issue: '데모(mock) 장비는 live 모드에서 접속하지 않습니다 — 지우거나 데모 모드에서 보세요' };
  const active = [..._jobs.values()].filter((j) => j.status !== 'done');
  if (!periodic && active.filter((j) => !j.periodic).length >= MAX_USER_ACTIVE) return { issue: `진행 중인 플로우 작업이 ${MAX_USER_ACTIVE}개를 넘습니다 — 잠시 뒤 다시 시도하세요` };
  if (periodic && active.filter((j) => j.periodic).length >= MAX_PERIODIC) return { issue: 'periodic-full' };
  if (active.some((j) => j.deviceId === device.id)) return { issue: '이 스위치에 진행 중인 플로우 작업이 있습니다 — 끝난 뒤 다시 시도하세요' };
  const target = String(device.agent || '').trim();
  const local = !target || sameAgent(target, config.agent?.name);   // 반증 L-10: 대소문자 무시(다른 곳과 같다)
  if (!local && typeof canDelegate === 'function') { const why = canDelegate(target, action); if (why) return { issue: why }; }
  const id = crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  const job = { id, startedAt: now, status: 'running', deviceId: device.id, deviceName: device.name || device.id, target, user, action, periodic: !!periodic,
    flows: (flows || []).slice(0, 16).map((f) => ({ name: f.name, ingrport: f.ingrport, srcdev: f.srcdev, dstdev: f.dstdev, hostId: f.hostId || null, hostName: f.hostName || '', hba: f.hba || '', targetName: f.targetName || '' })),
    cmds: built.cmds, trace: [], result: null, deadline: now + EDGE_DEADLINE_MS };
  // 반증 M-2: 만들기는 실행 전에 기록을 'pending' 으로 먼저 쓴다(작업이 사라져도 장비 쪽 사실을 놓치지 않게). 지운 이름이면 새 기록(반증 L-7).
  if (action === 'create') {
    const reg = load();
    for (const f of job.flows) {
      reg.flows = reg.flows.filter((x) => !(x.deviceId === device.id && x.name === f.name && (x.state === 'deleted' || x.state === 'failed')));
      reg.flows.push({ deviceId: device.id, name: f.name, hostId: f.hostId, hostName: f.hostName, hba: f.hba, srcdev: f.srcdev, dstdev: f.dstdev, ingrport: f.ingrport,
        targetName: f.targetName, createdAt: now, createdBy: user, state: 'pending', jobId: id, lastError: null });
    }
    try { save(); } catch (e) { return { issue: `플로우 기록을 저장하지 못해 만들지 않습니다: ${e.message}` }; }
  }
  _jobs.set(id, job);
  trace(job, `동작 ${action} · 명령 ${built.cmds.length}개${periodic ? ' · 주기 작업' : ''}`);
  if (local) {
    trace(job, '실행 위치: 이 포탈(수집 주체)');
    (async () => { await waitPoller(job, device.id); return runFlowCommands(device, built.cmds, { onTrace: (m, lv) => trace(job, m, lv) }); })()
      .then((res) => finish(job, res))
      .catch((e) => finish(job, { ok: false, outputs: [], reason: e.message }));
  } else {
    job.status = 'queued';
    trace(job, `실행 위치: 엣지 "${target}" — 다음 설정 pull 때 가져가 현지에서 실행합니다(이 포탈은 스위치에 직접 접속하지 않습니다)`);
    job.timer = setTimeout(() => {
      if (job.status === 'done') return;
      job.timedOut = true;
      const reason = job.status === 'queued' ? `엣지 "${target}" 가 ${EDGE_DEADLINE_MS / 60_000}분 안에 작업을 가져가지 않았습니다(구버전 엣지이거나 연결이 끊겼습니다)`
        : `엣지 "${target}" 의 결과가 ${EDGE_DEADLINE_MS / 60_000}분 안에 오지 않았습니다 — 늦게 오면 그때 반영합니다`;
      finish(job, { ok: false, outputs: [], reason, timeout: true });
    }, EDGE_DEADLINE_MS);
    job.timer.unref?.();
  }
  return { id, target };
}

/**
 * 이 엣지 몫 대기 작업을 꺼낸다(설정 pull 응답) — 비밀 없음(엣지가 자기 등록부 자격증명을 쓴다).
 *   ttlMs = 남은 시한(1분 여유) — 엣지는 이 시간이 지난 작업을 실행하지 않는다(반증 M-2). 응답에 실었다고 엣지가 받았다고 단정하지 않는다(반증 M-7).
 */
export function takeFlowJobsForAgent(agent) {
  prune();
  const out = [];
  const now = Date.now();
  for (const j of _jobs.values()) {
    if (j.status !== 'queued' || !sameAgent(j.target, agent)) continue;
    const ttlMs = j.deadline - now - 60_000;
    if (ttlMs <= 0) continue;
    j.status = 'dispatched'; j.dispatchedAt = now;
    trace(j, `엣지 "${j.target}" 의 설정 pull 응답에 실었습니다 — 엣지가 실행하면 결과가 옵니다(구버전 엣지는 이 작업을 모릅니다)`);
    out.push({ id: j.id, deviceId: j.deviceId, action: j.action, ttlMs, flows: j.flows.map(({ name, ingrport, srcdev, dstdev }) => ({ name, ingrport, srcdev, dstdev })) });
    if (out.length >= 5) break;
  }
  return out;
}

/** 엣지 회신 — 그 작업의 대상 엣지만(남의 결과 위조 차단). 시한으로 닫힌 뒤 온 결과는 한 번 반영한다(반증 M-2). */
export function completeFlowJob(id, agent, result) {
  const j = _jobs.get(String(id));
  if (!j) return { ok: false, reason: '알 수 없는(또는 만료된) 작업 id' };
  if (!sameAgent(j.target, agent)) return { ok: false, reason: '이 작업의 대상 엣지가 아닙니다' };
  if (j.status === 'done') {
    if (!j.timedOut || j.lateApplied) return { ok: true, already: true };
    j.lateApplied = true;
    j.result = sanitizeFlowResult(result, j);
    trace(j, '시한이 지난 뒤 엣지 결과가 왔습니다 — 기록에 반영합니다', 'warn');
    for (const o of j.result.outputs) trace(j, `${o.ok ? '완료' : '실패'}: ${o.cmd}${o.issue ? ` — ${o.issue.text}` : ''}`, o.ok ? 'info' : 'warn');
    applyResult(j, j.result, { late: true });
    return { ok: true, late: true };
  }
  finish(j, result);
  return { ok: true };
}

/** 화면용 — 비밀 · 장치 원본 없음. */
export function getFlowJob(id) {
  prune();
  const j = _jobs.get(String(id));
  if (!j) return null;
  return { id: j.id, status: j.status, action: j.action, deviceId: j.deviceId, deviceName: j.deviceName, target: j.target, user: j.user, periodic: j.periodic, startedAt: j.startedAt,
    elapsedMs: (j.finishedAt || Date.now()) - j.startedAt, cmds: j.cmds, trace: j.trace, result: j.result, ...(j.timedOut ? { timedOut: true } : {}), ...(j.lateApplied ? { lateApplied: true } : {}) };
}
export function recentFlowJobs(limit = 20) {
  prune();
  return [...(_jobs.values())].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit).map((j) => getFlowJob(j.id));
}

/* ── 카운터 주기 ────────────────────────────────────────────────────────────────── */
let _timer = null;
/**
 * 활성(+결과 모름) 포탈 플로우가 있는 스위치마다 `flow --show <name>` 작업 하나 — 가장 오래전에 읽은 스위치부터(반증 M-6).
 *   꺼진 스위치 · 인증 실패로 멈춘 스위치 · live 모드의 데모 장비 · 등록부에 없는 스위치는 건너뛰고 그 사유를 센다(반증 H-2 · M-1 · L-11 — 무음 금지).
 * @param deviceOf (id) → 등록부 장치(+비밀) · opts.canDelegate — startFlowJob 과 같다 · opts.stoppedOf — (id) → 엣지가 올린 인증 정지(없으면 null)
 */
export function scheduleFlowShows(deviceOf, { user = '주기 수집', canDelegate = null, stoppedOf = null } = {}) {
  const byDev = new Map();
  for (const f of listFlows()) if (f.state === 'active' || f.state === 'unknown') { if (!byDev.has(f.deviceId)) byDev.set(f.deviceId, []); byDev.get(f.deviceId).push(f); }
  const lastOf = (flows) => Math.min(...flows.map((f) => Number(f.lastTryAt || f.lastAt || 0)));
  const order = [...byDev.entries()].sort((a, b) => lastOf(a[1]) - lastOf(b[1]));
  const skipped = {}; let started = 0;
  const skip = (k) => { skipped[k] = (skipped[k] || 0) + 1; };
  for (const [devId, flows] of order) {
    const dev = deviceOf(devId);
    if (!dev) { skip('등록부에 없음'); continue; }
    if (dev.enabled === false) { skip('꺼짐'); continue; }
    if (isSanDemoId(dev.id) && !isMockMode()) { skip('데모 장비(live)'); continue; }
    // 정지 기록은 수집하는 노드에 있다 — 이 노드 것(sanAuthGuard) + 엣지가 스냅샷으로 올린 것(stoppedOf — 엣지 위임 스위치).
    let stop = null; try { stop = sanAuthGuard.authStopFor(dev) || (typeof stoppedOf === 'function' ? stoppedOf(dev.id) : null); } catch { stop = null; }
    if (stop) { skip('인증 실패 정지'); continue; }
    const r = startFlowJob({ device: dev, action: 'show', flows: flows.slice(0, 16), user, periodic: true, canDelegate });
    if (!r.issue) started += 1;
    else if (r.issue === 'periodic-full') skip('주기 작업 상한');
    else skip(/진행 중/.test(r.issue) ? '진행 중 작업' : '거부');
  }
  _lastCycle = { at: Date.now(), devices: byDev.size, started, skipped };
  const sig = JSON.stringify(skipped);
  if (Object.keys(skipped).length && _log('skip', sig)) console.warn(`[san-flow] 카운터 주기: ${started}대 시작 · 건너뜀 ${Object.entries(skipped).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  return started;
}
export function startFlowShowTimer(deviceOf, opts = {}) {
  if (_timer) return;
  _timer = setInterval(() => { try { scheduleFlowShows(deviceOf, opts); } catch (e) { console.warn(`[san-flow] 카운터 주기 실패: ${e.message}`); } }, SHOW_EVERY_MS);
  _timer.unref?.();
}
