/**
 * bareos/install/job.js — Bareos 완전 설치 작업(v2.844): 시작 · 진행 읽기 · 4~7단계 · 다시 시도 · 중단 · 전부 되돌리기.
 *
 * 흐름(사용자 원칙 '백업은 법인 로컬, 통합 로그는 중앙'):
 *  ① 중앙이 배포 등록부의 SSH root 로 엣지 노드에 번들·러너·plan.env 를 올리고 systemd-run 으로 러너를 **그 서버 안에서** 띄운다(0~3단계).
 *     화면을 닫거나 중앙이 재시작해도 러너는 계속 돈다 — 중앙은 짧은 SSH 로 상태 파일만 읽는다(기동 때 이어 읽기 — resumeInstallJobs).
 *  ② 러너가 끝나면 중앙이 4~7단계를 한다: 4 Director 리소스·포탈 등록(autoSetup.setupDirector — 콘솔 확인은 서버 안 bconsole) ·
 *     5 FD 플러그인(setupFdPlugin) · 6 엣지 경유 probe(onDirector — 담당 = 그 엣지) · 7 매핑 저장.
 *  ③ 실패하면 **그 단계만** 되돌리고(러너 journal · autoSetup 자체 되돌리기) 원인 판정(causes.js)과 고치는 방법을 기록한다.
 *     다시 시도 = 실패한 단계부터(계획 값을 바꿀 수 있다 — '포탈에서 고치기'). 전부 되돌리기는 따로(확인 필요).
 * 규칙:
 *  - 비밀(SSH·콘솔 비밀번호)은 작업 기록·로그·감사에 싣지 않는다(출력은 scrubOutput — 같은 글자가 있는 줄을 뺀다).
 *  - 같은 vCenter·같은 서버의 작업은 하나만(진행 중 409) · 중앙 단계·업로드 중에는 업그레이드 자동 적용이 기다린다(inflight).
 *  - 자격증명 실패(SSH)는 자동으로 다시 시도하지 않는다(계정 잠금 — 루트 규칙).
 *  - 작업 기록: CONFIG_DIR/bareos-install-jobs.json(0600 · 원자적 쓰기 · 최근 40건) — 비밀 없음.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';
import { withSsh, isSshAuthError } from '../../proxy/sshExec.js';
import { remoteTmpDir } from '../../agent/deploy.js';
import { listJobs } from '../registry.js';
import { loadSettings, addDirector, updateDirector, directorById, saveSettings, jobDirectorId, deleteDirector } from '../settings.js';
import { setupDirector, setupFdPlugin, newConsolePassword, VMWARE_POOL_FULL, VMWARE_SCHEDULE } from '../autoSetup.js';
import { onDirector } from '../service.js';
import { isResourceName } from '../names.js';
import { noteSetupStart, noteSetupEnd } from '../inflight.js';
import { pickBundle } from './bundle.js';
import { normPlan, planEnv, planSummary, STEPS, REMOTE_ROOT, RUN_DIR, BUNDLES_DIR, UNIT, FD_CLIENT, DIR_STORAGE, LAST_REMOTE_STEP, LAST_STEP } from './plan.js';
import { precheckScript, parsePrecheck, judgePrecheck } from './precheck.js';
import { parseErrFile, classifyFailure, scrubOutput } from './causes.js';
import { listInstallTargets, sshCredsFor } from './targets.js';
import { tarName } from './bundleDoc.js';

const FILE = () => path.join(config.configDir, 'bareos-install-jobs.json');
const RUNNER_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runner.sh');
const MAX_KEEP = 40;
export const POLL_MS = 8_000;
const POLL_MAX_MS = 60_000;
const UPLOAD_SESSION_MS = 2 * 3600_000;
const SHORT_SESSION_MS = 120_000;
const PROBE_MS = 6 * 60_000;

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/* ───────── 기록 ───────── */
let _jobs = null;
function load() {
  if (_jobs) return _jobs;
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      _jobs = Array.isArray(raw?.jobs) ? raw.jobs.filter((j) => j && /^bi_[a-z0-9]{6,40}$/.test(String(j.id))) : [];
    } else _jobs = [];
  } catch { try { preserveCorrupt(FILE(), 'bareos-install'); } catch { /* */ } _jobs = []; }
  return _jobs;
}
function persist() {
  const list = load().slice(-MAX_KEEP);
  _jobs = list;
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  atomicWriteFileSync(FILE(), JSON.stringify({ v: 1, jobs: list }, null, 1), { mode: 0o600 });
}
const getJob = (id) => load().find((j) => j.id === id) || null;
export function _resetForTest() { _jobs = null; for (const t of _timers.values()) clearTimeout(t); _timers.clear(); _active.clear(); }

/** 화면용(비밀 없음 — 기록 자체에 비밀이 없다). */
export function publicJob(j) {
  if (!j) return null;
  return { ...j, stepsMeta: STEPS.filter((s) => s.n !== 0 || j.mode === 'reinstall').map((s) => ({ n: s.n, label: s.label, remote: s.remote })) };
}
export function listInstallJobs() { return load().slice().reverse().map(publicJob); }
export function installJob(id) { return publicJob(getJob(id)); }
/** vCenter 의 마지막 작업. */
export const lastJobFor = (vcenterId) => load().slice().reverse().find((j) => j.vcenterId === vcenterId) || null;
/** 이 기능이 설치한 서버 주소(대상 표의 '엣지 위 Director' 판정). */
export function knownHostAddrs() {
  const m = new Map();
  for (const j of load()) if (j.hostAddr && ['done', 'failed', 'stopped', 'running'].includes(j.status)) m.set(j.vcenterId, j.hostAddr);
  return m;
}
const ACTIVE = new Set(['running', 'rolling-back']);
const isActive = (j) => ACTIVE.has(j.status);

function touch(j, patch = {}) { Object.assign(j, patch, { updatedAt: Date.now() }); persist(); }
function setStep(j, n, patch) {
  j.steps = j.steps || {};
  j.steps[n] = { ...(j.steps[n] || {}), ...patch };
  touch(j);
}

/* ───────── SSH ───────── */
let _ssh = withSsh;
let _onDirector = onDirector;
let _setupDirector = setupDirector;
let _setupFdPlugin = setupFdPlugin;
let _sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
/** 시험 주입. */
export function _setDepsForTest(d = {}) {
  _ssh = d.ssh || withSsh; _onDirector = d.onDirector || onDirector; _setupDirector = d.setupDirector || setupDirector; _setupFdPlugin = d.setupFdPlugin || setupFdPlugin;
  _sleep = d.sleep || ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
}
const credsOf = (j) => { const c = sshCredsFor(j.targetId); if (!c) throw fail('invalid', '배포 등록부에서 이 엣지의 SSH 대상을 찾지 못했습니다(지워졌거나 바뀜).'); return c; };
const runSsh = (creds, fn, ms) => _ssh(creds, fn, { signal: AbortSignal.timeout(ms) });
const secretsOf = (creds) => [creds?.password, creds?.passphrase].filter(Boolean);

/* ───────── 사전 점검(읽기만) ───────── */
export async function runPrecheck({ vcenterId, body = {} }) {
  const t = listInstallTargets({ knownHostAddrs: knownHostAddrs() }).find((x) => x.vcenterId === vcenterId);
  if (!t) throw fail('not-found', 'vCenter 를 찾을 수 없습니다.');
  if (!t.can) throw fail('invalid', t.why);
  const bundle = await pickBundle();
  let plan = null;
  try { plan = bundle ? normPlan({ ...body, reset: body.reset || { ack: true } }, { contents: bundle.contents, mode: t.mode, corpName: t.vcenterName }) : null; } catch { plan = null; }
  const creds = sshCredsFor(t.targetId);
  const t0 = Date.now();
  let out;
  try {
    out = await runSsh(creds, async (api) => ({ text: String((await api.exec(precheckScript(plan?.volumeDir), 90_000))?.stdout || '') }), SHORT_SESSION_MS);
  } catch (e) {
    const auth = isSshAuthError(e);
    throw fail(auth ? 'ssh-auth' : 'remote', auth ? '저장된 SSH 계정으로 로그인하지 못했습니다 — 배포 등록부의 비밀번호를 확인하세요(자동으로 다시 시도하지 않습니다).' : `엣지 노드에 접속하지 못했습니다: ${scrubOutput(String(e?.message || e), secretsOf(creds)).slice(0, 200)}`);
  }
  const facts = parsePrecheck(out.text);
  const judged = judgePrecheck(facts, { mode: t.mode, bundle: bundle?.contents || null, plan });
  const ledger = t.director ? listJobs().filter((x) => !x.demo && x.vcenterId === vcenterId).length : 0;
  return { at: Date.now(), ms: Date.now() - t0, target: t, mode: t.mode, ...judged, ledgerTargets: ledger, bundle: bundle ? { version: bundle.version, contents: bundle.contents, size: bundle.size } : null };
}

/* ───────── 시작 ───────── */
export async function startInstall({ vcenterId, body = {}, by = '' }) {
  const t = listInstallTargets({ knownHostAddrs: knownHostAddrs() }).find((x) => x.vcenterId === vcenterId);
  if (!t) throw fail('not-found', 'vCenter 를 찾을 수 없습니다.');
  if (!t.can) throw fail('invalid', t.why);
  const busy = load().find((j) => isActive(j) && (j.vcenterId === vcenterId || (j.sshHost && j.sshHost === t.sshHost)));
  if (busy) throw fail('conflict', `이 법인(또는 같은 서버)의 완전 설치가 진행 중입니다(${busy.id}) — 끝난 뒤 다시 하세요.`);
  const bundle = await pickBundle(String(body.bundleVersion || ''));
  if (!bundle) throw fail('invalid', '서명·해시가 맞는 번들이 없습니다 — 먼저 번들을 받으세요.');
  const plan = normPlan(body, { contents: bundle.contents, mode: t.mode, corpName: t.vcenterName });
  // 시작 직전 다시 점검(화면 결과는 그 순간의 상태 — 그사이 바뀌었으면 시작하지 않는다)
  const pre = await runPrecheck({ vcenterId, body });
  if (pre.blocked) throw fail('precheck', `사전 점검에 ✗ 항목이 있어 시작하지 않았습니다: ${pre.items.filter((i) => i.status === 'bad').map((i) => i.label).join(', ')}`, { precheck: pre });
  if (!pre.hostAddr) throw fail('precheck', '서버 주소를 읽지 못해 시작하지 않았습니다.');
  const resetVolumeDirs = plan.reset?.volumes ? (pre.volumes || []).filter((v) => !v.missing).map((v) => v.path) : [];
  const id = `bi_${crypto.randomBytes(6).toString('hex')}`;
  const firstStep = plan.mode === 'reinstall' ? 0 : 1;
  const j = {
    id, vcenterId, vcenterName: t.vcenterName, vcHost: t.vcHost, agent: t.agent, targetId: t.targetId, sshHost: t.sshHost, sshPort: t.sshPort,
    hostAddr: pre.hostAddr, mode: plan.mode, plan, planText: planSummary(plan), resetVolumeDirs,
    bundle: { version: bundle.version, sha256: bundle.sha256, size: bundle.size, bareosVersion: bundle.contents.bareosVersion },
    install: bundle.contents.install,
    directorId: t.director?.id || '', existingDirector: !!t.director, createdDirector: false, createdSite: false,
    by, createdAt: Date.now(), updatedAt: Date.now(), status: 'running', phase: 'upload',
    steps: Object.fromEntries(STEPS.filter((s) => s.n >= firstStep).map((s) => [s.n, { status: 'pending' }])),
    attempts: [{ n: 1, at: Date.now(), by, fromStep: firstStep, plan: planSummary(plan) }],
    failure: null, upload: null, log: [], startStep: firstStep,
  };
  load().push(j);
  persist();
  kick(j.id, { fromStep: firstStep, fresh: true });
  return publicJob(j);
}

/* ───────── 실행 루프 ───────── */
const _active = new Set();    // 지금 이 프로세스가 돌리는 작업 id
const _timers = new Map();
const _stopReq = new Set();

function kick(id, opts) {
  if (_active.has(id)) return;
  _active.add(id);
  drive(id, opts).catch((e) => {
    const j = getJob(id);
    if (j && isActive(j)) recordFailure(j, j.currentStep ?? null, { message: String(e?.message || e), sshAuth: isSshAuthError(e) });
  }).finally(() => { _active.delete(id); noteSetupEnd(`install:${id}`); });
}

async function drive(id, { fromStep, fresh = false, resendBundle = false, mode = 'install', resume = false }) {
  const j = getJob(id);
  if (!j) return;
  const creds = credsOf(j);
  if (mode === 'rollback-all') { noteSetupStart(`install:${id}`, `완전 설치 되돌리기 ${j.vcenterName}`); return driveRollbackAll(j, creds); }
  if (fromStep <= LAST_REMOTE_STEP) {
    if (!resume) {
      noteSetupStart(`install:${id}`, `완전 설치 ${j.vcenterName}`);
      touch(j, { phase: 'upload', currentStep: fromStep });
      await uploadAndStart(j, creds, { fromStep, fresh, resendBundle });
      noteSetupEnd(`install:${id}`);   // 러너가 서버 안에서 돈다 — 중앙 재시작이 끊지 않는다(이어 읽기)
    }
    touch(j, { phase: 'remote' });
    const r = await pollRemote(j, creds);
    if (!r.ok) return;
    noteSetupStart(`install:${id}`, `완전 설치 ${j.vcenterName}`);
  }
  touch(j, { phase: 'central' });
  for (let n = Math.max(fromStep, LAST_REMOTE_STEP + 1); n <= LAST_STEP; n++) {
    if (_stopReq.has(j.id)) { _stopReq.delete(j.id); setStep(j, n, { status: 'stopped', at: Date.now() }); touch(j, { status: 'stopped', phase: 'idle', currentStep: n }); return; }
    touch(j, { currentStep: n });
    setStep(j, n, { status: 'running', at: Date.now(), endedAt: null, msg: '' });
    try {
      const msg = await centralStep(j, creds, n);
      setStep(j, n, { status: 'ok', endedAt: Date.now(), msg: String(msg || '').slice(0, 300) });
    } catch (e) {
      recordFailure(j, n, { message: String(e?.message || e), code: e?.code, sshAuth: isSshAuthError(e) }, creds);
      return;
    }
  }
  await cleanupRemote(j, creds).catch(() => {});
  touch(j, { status: 'done', phase: 'idle', doneAt: Date.now(), currentStep: null });
  const a = j.attempts[j.attempts.length - 1]; if (a) { a.endedAt = Date.now(); a.result = 'done'; persist(); }
}

/** 번들(필요하면)·러너·plan.env 를 올리고 러너를 띄운다. */
async function uploadAndStart(j, creds, { fromStep, fresh, resendBundle }) {
  const bundle = await pickBundle(j.bundle.version);
  if (!bundle) throw fail('invalid', `번들 ${j.bundle.version} 을(를) 중앙에서 찾지 못했습니다(지워졌거나 검증 실패) — 번들을 다시 받으세요.`);
  const env = planEnv({ jobId: j.id, bundle: j.bundle, install: j.install, plan: j.plan, startStep: Math.min(fromStep, LAST_REMOTE_STEP), runMode: 'install', hostAddr: j.hostAddr, resetVolumeDirs: j.resetVolumeDirs });
  const runner = fs.readFileSync(RUNNER_SRC, 'utf8');
  const remoteTar = `${BUNDLES_DIR}/${tarName(j.bundle.version)}`;
  await runSsh(creds, async (api) => {
    const idu = await api.exec('id -u');
    if (String(idu?.stdout || '').trim() !== '0') throw fail('invalid', 'root 계정으로 접속해야 합니다(배포 등록부의 SSH 계정).');
    const act = String((await api.exec(`systemctl is-active ${UNIT} 2>/dev/null || true`))?.stdout || '').trim();
    if (act === 'active' || act === 'activating') throw fail('conflict', '이 서버에서 완전 설치 러너가 이미 돌고 있습니다 — 끝난 뒤 다시 하세요.');
    await api.exec(`install -d -m 0700 ${REMOTE_ROOT} ${BUNDLES_DIR} && chmod 0700 ${REMOTE_ROOT}`);
    if (fresh) await api.exec(`if [ -d ${RUN_DIR} ]; then mv ${RUN_DIR} ${RUN_DIR}.$(date +%Y%m%d%H%M%S); fi`);
    await api.exec(`install -d -m 0700 ${RUN_DIR}`);
    // 번들: 같은 sha 가 있으면 다시 보내지 않는다(고RTT 회선에서 수백 MB)
    const have = String((await api.exec(`[ -f ${remoteTar} ] && sha256sum ${remoteTar} | cut -d' ' -f1 || true`, 300_000))?.stdout || '').trim();
    if (resendBundle || have !== j.bundle.sha256) {
      const part = `${remoteTar}.part`;
      touch(j, { upload: { sent: 0, total: j.bundle.size, at: Date.now() } });
      let last = 0;
      await api.putFile(bundle.tarPath, part, {
        mode: 0o600,
        onProgress: (sent, total) => { if (Date.now() - last > 2000) { last = Date.now(); j.upload = { sent, total, at: j.upload?.at || Date.now() }; touch(j); } },
      });
      const got = String((await api.exec(`sha256sum ${part} | cut -d' ' -f1`, 300_000))?.stdout || '').trim();
      if (got !== j.bundle.sha256) { await api.exec(`rm -f ${part}`).catch(() => {}); throw fail('bundle', `전송한 번들의 sha256 이 다릅니다(전송 중 손상) — 다시 시도하세요.`); }
      await api.exec(`mv -f ${part} ${remoteTar}`);
      touch(j, { upload: { sent: j.bundle.size, total: j.bundle.size, at: j.upload?.at || Date.now(), doneAt: Date.now() } });
    } else touch(j, { upload: { sent: j.bundle.size, total: j.bundle.size, reused: true, doneAt: Date.now() } });
    await api.writeFile(`${RUN_DIR}/runner.sh`, runner, 0o700);
    await api.writeFile(`${RUN_DIR}/plan.env`, env, 0o600);
    await api.exec(`rm -f ${RUN_DIR}/stop ${RUN_DIR}/err.${Math.min(fromStep, LAST_REMOTE_STEP)}`);
    const st = await api.exec(`systemd-run --unit=${UNIT} --collect --quiet /bin/bash ${RUN_DIR}/runner.sh 2>&1`);
    if (st?.code !== 0) throw fail('remote', `러너를 띄우지 못했습니다(systemd-run): ${scrubOutput(String(st?.stdout || st?.stderr || ''), secretsOf(creds)).slice(-300)}`);
    return {};
  }, UPLOAD_SESSION_MS);
  for (let n = fromStep; n <= LAST_REMOTE_STEP; n++) if (j.steps[n]) setStep(j, n, { status: 'pending', msg: '' });
}

/** 상태 파일 파싱(순수) — 단계별 마지막 상태. */
export function parseState(text) {
  const steps = {}; let all = null;
  for (const l of String(text || '').split('\n')) {
    const m = /^(\d|all) (start|ok|fail|rolledback|rollback-fail|stopped|done) (\d+)/.exec(l.trim());
    if (!m) continue;
    const at = Number(m[3]) * 1000;
    if (m[1] === 'all') { all = { status: m[2], at }; continue; }
    const n = Number(m[1]);
    const cur = steps[n] || {};
    if (m[2] === 'start') steps[n] = { status: 'running', at, endedAt: null };
    else steps[n] = { ...cur, status: m[2] === 'ok' ? 'ok' : m[2], endedAt: at };
  }
  return { steps, all };
}

const READ_CMD = `cat ${RUN_DIR}/state 2>/dev/null; echo @@log; tail -n 40 ${RUN_DIR}/run.log 2>/dev/null; echo @@err; for f in ${RUN_DIR}/err.?; do [ -f "$f" ] && { echo "@@file $f"; cat "$f"; }; done; echo @@unit; systemctl is-active ${UNIT} 2>/dev/null || true`;

/** 러너 상태를 한 번 읽는다. */
async function readRemote(creds) {
  const r = await runSsh(creds, async (api) => ({ text: String((await api.exec(READ_CMD, 60_000))?.stdout || '') }), SHORT_SESSION_MS);
  const t = r.text;
  const [stateText, rest = ''] = t.split('\n@@log\n');
  const [logText, rest2 = ''] = rest.split('\n@@err\n');
  const [errText, unitText = ''] = rest2.split('\n@@unit\n');
  const errs = {};
  for (const part of errText.split('@@file ').slice(1)) { const nl = part.indexOf('\n'); const name = part.slice(0, nl); const n = Number(/err\.(\d)$/.exec(name)?.[1]); if (Number.isInteger(n)) errs[n] = part.slice(nl + 1); }
  return { ...parseState(stateText), log: logText.split('\n').filter(Boolean).slice(-40), errs, unit: unitText.trim().split('\n')[0] || '' };
}

/** 러너가 끝날 때까지 읽는다. @returns {{ ok }} ok = 0~3 단계 모두 끝(중앙 단계로) */
async function pollRemote(j, creds) {
  let wait = POLL_MS; let fails = 0; let idleSeen = 0;
  for (;;) {
    if (!getJob(j.id) || !isActive(j)) return { ok: false };
    let r;
    try { r = await readRemote(creds); fails = 0; wait = POLL_MS; } catch (e) {
      fails += 1; wait = Math.min(POLL_MAX_MS, wait * 2);
      touch(j, { pollError: { at: Date.now(), count: fails, message: isSshAuthError(e) ? '저장된 SSH 계정으로 로그인하지 못했습니다' : scrubOutput(String(e?.message || e), secretsOf(creds)).slice(0, 200) } });
      if (isSshAuthError(e)) { recordFailure(j, j.currentStep, { message: String(e?.message || e), sshAuth: true }, creds); return { ok: false }; }
      await _sleep(wait); continue;
    }
    const patch = { pollError: null, lastPollAt: Date.now(), log: r.log.map((l) => scrubOutput(l, secretsOf(creds))) };
    for (const [n, s] of Object.entries(r.steps)) if (j.steps[n]) j.steps[n] = { ...j.steps[n], ...s };
    touch(j, patch);
    const failed = Object.entries(r.steps).find(([, s]) => ['fail', 'rolledback', 'rollback-fail'].includes(s.status));
    if (r.all?.status === 'done') return { ok: true };
    if (failed && r.unit !== 'active' && r.unit !== 'activating') {
      const n = Number(failed[0]);
      const e = parseErrFile(r.errs[n] || '');
      recordFailure(j, n, { ...e, output: scrubOutput(e.output, secretsOf(creds)), rolledBack: failed[1].status === 'rolledback', rollbackFailed: failed[1].status === 'rollback-fail' }, creds);
      return { ok: false };
    }
    const stopped = Object.entries(r.steps).find(([, s]) => s.status === 'stopped');
    if (stopped && r.unit !== 'active') { touch(j, { status: 'stopped', phase: 'idle', currentStep: Number(stopped[0]) }); return { ok: false }; }
    const running = Object.entries(r.steps).find(([, s]) => s.status === 'running');
    if (running) touch(j, { currentStep: Number(running[0]) });
    if (r.unit !== 'active' && r.unit !== 'activating' && !r.all) {
      // 끝 표시 없이 러너가 사라졌다 — 몇 번 더 보고(상태 파일 쓰기 직후일 수 있다) 실패로
      idleSeen += 1;
      if (idleSeen >= 3) { recordFailure(j, j.currentStep, { cause: 'runner-died', output: r.log.join('\n'), message: '러너가 끝 표시 없이 끝났습니다.' }, creds); return { ok: false }; }
    } else idleSeen = 0;
    await _sleep(wait);
  }
}

function recordFailure(j, step, e, creds = null) {
  const c = classifyFailure({ ...e, step });
  const output = scrubOutput(e.output || e.message || '', secretsOf(creds));
  const failure = { step, at: Date.now(), cmd: e.cmd || '', code: e.code ?? null, message: scrubOutput(String(e.message || ''), secretsOf(creds)).slice(0, 600),
    output, cause: c, rolledBack: e.rolledBack ?? (step != null && step >= 4 ? true : null), rollbackFailed: !!e.rollbackFailed };
  if (step != null && j.steps[step]) j.steps[step] = { ...j.steps[step], status: 'failed', endedAt: Date.now() };
  const a = j.attempts[j.attempts.length - 1]; if (a) { a.endedAt = Date.now(); a.result = 'failed'; a.failedStep = step; a.cause = c.title; }
  touch(j, { status: 'failed', phase: 'idle', failure, currentStep: step });
}

/* ───────── 중앙 단계(4~7) ───────── */
function sshBody(creds) { return { host: creds.host, sshPort: creds.port, username: creds.username, password: creds.password || '' }; }

/** 서버 안 bconsole 로 새 콘솔 접속 확인(autoSetup ctx.verifyConsole). */
function localConsoleCheck(creds) {
  return async ({ consoleName, password, directorPort }) => {
    if (!isResourceName(consoleName)) throw fail('invalid', '콘솔 이름이 올바르지 않습니다.');
    const r = await runSsh(creds, async (api) => {
      const tmp = await remoteTmpDir(api.exec, 'portal-bareos');
      try {
        const dn = String((await api.exec("sed -n 's/^[[:space:]]*Name[[:space:]]*=[[:space:]]*\"\\{0,1\\}\\([A-Za-z0-9._-]*\\).*/\\1/p' /etc/bareos/bareos-dir.d/director/*.conf 2>/dev/null | head -n 1"))?.stdout || '').trim() || 'bareos-dir';
        if (!isResourceName(dn)) throw fail('invalid', 'Director 이름을 읽지 못했습니다.');
        const conf = `Director {\n  Name = ${dn}\n  Address = localhost\n  Port = ${Number(directorPort) || 9101}\n  Password = "unused-${crypto.randomBytes(8).toString('hex')}"\n}\nConsole {\n  Name = "${consoleName}"\n  Password = "${password}"\n  Director = ${dn}\n}\n`;
        await api.writeFile(`${tmp}/bconsole.conf`, conf, 0o600);
        const x = await api.exec(`printf 'version\\n' | timeout 30 bconsole -c ${tmp}/bconsole.conf 2>&1`, 45_000);
        return { code: x?.code, out: String(x?.stdout || '') };
      } finally { await api.exec(`rm -rf ${tmp}`).catch(() => {}); }
    }, SHORT_SESSION_MS);
    if (r.code !== 0 || !/Version/.test(r.out)) throw fail('console-login', `서버 안 bconsole 로 새 콘솔 ‘${consoleName}’ 접속 실패: ${scrubOutput(r.out, [password, ...secretsOf(creds)]).slice(-300)}`);
    return { version: (/Version:?\s*([0-9][^\s(]*)/.exec(r.out) || [])[1] || '' };
  };
}

async function centralStep(j, creds, n) {
  const b = sshBody(creds);
  if (n === 4) {
    const cur = loadSettings();
    const existing = j.directorId ? directorById(j.directorId, cur) : null;
    const dir = existing || { id: 'dir_pending_install', name: j.plan.directorName, timeoutMs: 15_000, tlsMax: 'TLSv1.3' };
    const body = { ...b, directorPort: 9101, consoleName: j.plan.consoleName, restoreClient: FD_CLIENT, restoreStorage: DIR_STORAGE, restorePool: VMWARE_POOL_FULL, pools: j.plan.pools, schedule: j.plan.schedule };
    const consolePassword = newConsolePassword();
    const r = await _setupDirector(body, {
      dir, cur: { directors: cur.directors.filter((d) => d.id !== dir.id), defaults: cur.defaults }, consolePassword,
      verifyConsole: localConsoleCheck(creds), clearAuthStop: () => {},
      // 포탈 등록: 주소 = 러너가 읽은 서버 주소(엣지가 붙는 곳) · 담당 = 그 엣지(중앙은 9101 에 붙지 않는다)
      save: ({ consoleName, password }) => {
        const v = { name: j.plan.directorName, host: j.hostAddr, port: 9101, consoleName, password, agent: j.agent };
        if (existing) return updateDirector(existing.id, v);
        const a = addDirector(v);
        touch(j, { directorId: a.director.id, createdDirector: true });
        return a;
      },
    });
    return `Director 리소스 ${r.files?.length ?? 0}개 · 포탈 등록(담당 ${j.agent})`;
  }
  if (n === 5) {
    if (!j.directorId) throw fail('invalid', '4단계에서 등록한 Director 가 없습니다 — 4단계부터 다시 하세요.');
    const r = await _setupFdPlugin({ ...b, directorId: j.directorId }, { dir: directorById(j.directorId) });
    return r.action === 'unchanged' ? '이미 켜져 있음' : `플러그인 줄 추가(${(r.added || []).join(', ')})`;
  }
  if (n === 6) {
    const ac = AbortSignal.timeout(PROBE_MS);
    let pr;
    try { pr = await _onDirector(j.directorId, 'probe', {}, { trigger: 'manual', signal: ac }); } catch (e) { throw fail(e?.code || 'probe', `엣지 ‘${j.agent}’ 경유 연결 실패: ${String(e?.message || e).slice(0, 300)}`); }
    return `엣지 경유 접속 성공${pr?.version ? ` · ${pr.version}` : ''}`;
  }
  if (n === 7) {
    const cur = loadSettings();
    const ini = `/etc/bareos/vmware/${String(j.vcHost || j.vcenterId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}.ini`;
    const site = { vcenterId: j.vcenterId, directorId: j.directorId, vcserver: j.vcHost, client: FD_CLIENT, storage: DIR_STORAGE, pool: VMWARE_POOL_FULL, schedule: j.plan.schedule ? VMWARE_SCHEDULE : '', configFile: ini };
    const had = cur.sites.some((s) => s.vcenterId === j.vcenterId);
    const sites = [...cur.sites.filter((s) => s.vcenterId !== j.vcenterId), site];
    const jobDirs = new Map();
    for (const x of listJobs()) { if (x.demo) continue; const set = jobDirs.get(x.vcenterId) || new Set(); set.add(jobDirectorId(x, cur)); jobDirs.set(x.vcenterId, set); }
    saveSettings({ sites }, { jobDirs });
    if (!had) touch(j, { createdSite: true });
    return `${j.vcenterName} ↔ ${FD_CLIENT} · ${DIR_STORAGE} · ${VMWARE_POOL_FULL} · INI ${ini}`;
  }
  throw fail('invalid', `알 수 없는 단계 ${n}`);
}

/** 끝난 뒤 엣지에 남긴 번들·풀어 둔 묶음·로컬 저장소 파일을 지운다(journal 은 전부 되돌리기를 위해 남긴다). */
async function cleanupRemote(j, creds) {
  await runSsh(creds, async (api) => {
    await api.exec(`rm -rf ${BUNDLES_DIR} ${REMOTE_ROOT}/bundle; f=/etc/yum.repos.d/portal-bareos-local.repo; [ -f "$f" ] && head -n 1 "$f" | grep -q 'managed-by: vmware-portal' && rm -f "$f"; true`);
    return {};
  }, SHORT_SESSION_MS);
}

/* ───────── 다시 시도 · 중단 · 전부 되돌리기 ───────── */

/**
 * 실패·중단한 작업을 그 단계부터 다시. body.plan(바꿀 값) · body.fix('pyvmomi-fix' | 'resend-bundle') · body.fromStep(선택 — 실패 단계보다 앞만).
 */
export async function retryInstall(id, { body = {}, by = '' } = {}) {
  const j = getJob(id);
  if (!j) throw fail('not-found', '작업을 찾을 수 없습니다.');
  if (!['failed', 'stopped'].includes(j.status)) throw fail('conflict', `지금 상태(${j.status})에서는 다시 할 수 없습니다.`);
  if (j.failure?.cause?.key === 'ssh-auth' && body.sshFixed !== true) throw fail('invalid', 'SSH 로그인 실패는 배포 등록부의 계정을 고친 뒤 \'고쳤음\' 을 표시하고 다시 하세요(계정 잠금을 막으려고 확인합니다).');
  const failedStep = j.failure?.step ?? j.currentStep ?? j.startStep;
  let fromStep = Number.isInteger(body.fromStep) ? body.fromStep : failedStep;
  if (!Number.isInteger(fromStep) || fromStep < j.startStep || fromStep > LAST_STEP) fromStep = failedStep;
  if (fromStep > failedStep) throw fail('invalid', '실패한 단계보다 뒤에서 시작할 수 없습니다.');
  const bundle = await pickBundle(j.bundle.version);
  if (!bundle) throw fail('invalid', `번들 ${j.bundle.version} 이 중앙에 없습니다 — 번들을 다시 받으세요.`);
  const before = planSummary(j.plan);
  const nextBody = { ...j.plan, ...(body.plan && typeof body.plan === 'object' ? body.plan : {}), reset: j.plan.reset ? { ...j.plan.reset, ack: true, confirmName: j.vcenterName } : undefined };
  if (body.fix === 'pyvmomi-fix') nextBody.pyvmomiFix = true;
  const plan = normPlan(nextBody, { contents: bundle.contents, mode: j.mode, corpName: j.vcenterName });
  // 초기화 범위는 다시 하기에서 넓히지 않는다(처음 확인받은 범위)
  if (j.plan.reset) plan.reset = { ...j.plan.reset };
  const change = planSummary(plan) !== before ? `${before} → ${planSummary(plan)}` : '';
  j.plan = plan; j.planText = planSummary(plan);
  for (let n = fromStep; n <= LAST_STEP; n++) if (j.steps[n]) j.steps[n] = { status: 'pending' };
  j.attempts.push({ n: j.attempts.length + 1, at: Date.now(), by, fromStep, change, fix: body.fix || '', plan: planSummary(plan) });
  touch(j, { status: 'running', phase: fromStep <= LAST_REMOTE_STEP ? 'upload' : 'central', failure: null, currentStep: fromStep });
  kick(j.id, { fromStep, resendBundle: body.fix === 'resend-bundle' });
  return publicJob(j);
}

/** 중단 요청 — 지금 단계가 끝나면 멈춘다(러너: stop 파일 · 중앙: 단계 사이). */
export async function stopInstall(id) {
  const j = getJob(id);
  if (!j) throw fail('not-found', '작업을 찾을 수 없습니다.');
  if (!isActive(j)) throw fail('conflict', '진행 중인 작업이 아닙니다.');
  _stopReq.add(j.id);
  if (j.phase === 'remote' || j.phase === 'upload') {
    const creds = credsOf(j);
    await runSsh(creds, async (api) => { await api.exec(`[ -d ${RUN_DIR} ] && touch ${RUN_DIR}/stop; true`); return {}; }, SHORT_SESSION_MS);
  }
  touch(j, { stopRequestedAt: Date.now() });
  return publicJob(j);
}

/**
 * 전부 되돌리기 — 이 작업이 설치한 것을 지운다(러너 journal 역순) + 포탈에 새로 만든 매핑·Director 등록을 지운다.
 * 초기화(재설치)였다면 지운 옛 설치는 되살리지 못한다(보관한 /etc/bareos tar 는 남긴다 — 응답이 밝힌다).
 */
export function rollbackAllInstall(id, { ack = false, by = '' } = {}) {
  const j = getJob(id);
  if (!j) throw fail('not-found', '작업을 찾을 수 없습니다.');
  if (ack !== true) throw fail('invalid', '지울 목록을 확인했다는 표시가 필요합니다.');
  if (isActive(j)) throw fail('conflict', '진행 중에는 되돌릴 수 없습니다 — 먼저 중단하세요.');
  if (j.status === 'rolledback') throw fail('conflict', '이미 되돌렸습니다.');
  j.attempts.push({ n: j.attempts.length + 1, at: Date.now(), by, fromStep: null, rollbackAll: true });
  touch(j, { status: 'rolling-back', phase: 'remote', rollback: { at: Date.now(), by } });
  kick(j.id, { mode: 'rollback-all' });
  return publicJob(j);
}

async function driveRollbackAll(j, creds) {
  const notes = [];
  // 포탈 쪽 — 이 작업이 새로 만든 것만
  try {
    if (j.createdSite) {
      const cur = loadSettings();
      const jobDirs = new Map();
      for (const x of listJobs()) { if (x.demo) continue; const set = jobDirs.get(x.vcenterId) || new Set(); set.add(jobDirectorId(x, cur)); jobDirs.set(x.vcenterId, set); }
      saveSettings({ sites: cur.sites.filter((s) => s.vcenterId !== j.vcenterId) }, { jobDirs });
      notes.push('매핑 삭제');
    }
    if (j.createdDirector && j.directorId) { deleteDirector(j.directorId, { inUseByJobs: listJobs().filter((x) => !x.demo && x.directorId === j.directorId).length }); notes.push('Director 등록 삭제'); }
    else if (j.existingDirector) notes.push('기존 Director 등록은 남김 — 재설치 전 설치는 초기화로 지워져 접속되지 않습니다(설정 › 법인별 Director 에서 정리)');
  } catch (e) { notes.push(`포탈 쪽 일부 남음: ${String(e?.message || e).slice(0, 200)}`); }
  const env = planEnv({ jobId: j.id, bundle: j.bundle, install: j.install, plan: j.plan, startStep: 1, runMode: 'rollback-all', hostAddr: j.hostAddr });
  const runner = fs.readFileSync(RUNNER_SRC, 'utf8');
  await runSsh(creds, async (api) => {
    const act = String((await api.exec(`systemctl is-active ${UNIT} 2>/dev/null || true`))?.stdout || '').trim();
    if (act === 'active') throw fail('conflict', '러너가 아직 돌고 있습니다.');
    await api.exec(`install -d -m 0700 ${RUN_DIR}`);
    await api.writeFile(`${RUN_DIR}/runner.sh`, runner, 0o700);
    await api.writeFile(`${RUN_DIR}/plan.env`, env, 0o600);
    // 중앙 단계(4·5)가 만든 Director·FD 파일은 /etc/bareos 째로(2단계 etcnew) 지운다 — 설치 전 /etc/bareos 가 없었을 때
    const st = await api.exec(`rm -f ${RUN_DIR}/stop; systemd-run --unit=${UNIT} --collect --quiet /bin/bash ${RUN_DIR}/runner.sh 2>&1`);
    if (st?.code !== 0) throw fail('remote', '러너를 띄우지 못했습니다(systemd-run).');
    return {};
  }, SHORT_SESSION_MS);
  for (let i = 0; i < 400; i++) {
    await _sleep(POLL_MS);
    let r; try { r = await readRemote(creds); } catch { continue; }
    touch(j, { log: r.log.map((l) => scrubOutput(l, secretsOf(creds))), lastPollAt: Date.now() });
    if (r.all?.status === 'rolledback') { touch(j, { status: 'rolledback', phase: 'idle', rollback: { ...j.rollback, doneAt: Date.now(), notes } }); return; }
    if (r.all?.status === 'rollback-fail' || (r.unit !== 'active' && r.unit !== 'activating' && i > 3)) {
      touch(j, { status: 'rollback-failed', phase: 'idle', rollback: { ...j.rollback, doneAt: Date.now(), notes, left: r.log.slice(-15) } });
      return;
    }
  }
  touch(j, { status: 'rollback-failed', phase: 'idle', rollback: { ...j.rollback, notes, left: ['시한 안에 끝나지 않았습니다'] } });
}

/** 기동 때 진행 중이던 작업을 이어 읽는다(러너는 서버 안에서 계속 돈다). 업로드·중앙 단계 중이던 것은 '끊김' 으로 실패 처리(다시 시도 가능). */
export function resumeInstallJobs() {
  for (const j of load()) {
    if (!isActive(j)) continue;
    if (j.status === 'rolling-back') { kick(j.id, { mode: 'rollback-all' }); continue; }
    if (j.phase === 'remote') { kick(j.id, { fromStep: Number.isInteger(j.currentStep) ? Math.min(j.currentStep, LAST_REMOTE_STEP) : j.startStep, resume: true }); continue; }
    recordFailure(j, j.currentStep ?? null, { cause: 'runner-died', message: `포탈이 재시작해 ${j.phase === 'upload' ? '번들 전송' : '중앙 단계'}가 끊겼습니다 — 그 단계부터 다시 하세요.` });
  }
}
