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
import { listJobs, registryLoadError } from '../registry.js';
import { loadSettings, addDirector, updateDirector, directorById, saveSettings, jobDirectorId, deleteDirector } from '../settings.js';
import { setupDirector, setupFdPlugin, newConsolePassword, VMWARE_POOL_FULL, VMWARE_SCHEDULE } from '../autoSetup.js';
import { onDirector } from '../service.js';
import { isResourceName } from '../names.js';
import { noteSetupStart, noteSetupEnd } from '../inflight.js';
import { setupBusyReason, claimSetupGroup, setupGroupBusyReason, addSetupGroupDirector, releaseSetupGroup, _resetForTest as _resetLocks } from '../setupLocks.js';
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
/** 원격 단계 전체 시한 — 러너 유닛도 같은 상한(RuntimeMaxSec)으로 끝난다(반증 M6 — 끝나지 않는 폴링이 그 법인의 새 설치를 영원히 막았다). */
export const REMOTE_MAX_MS = 4 * 3600_000;
const runDirOf = (id) => `${RUN_DIR}/${id}`;

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
export function _resetForTest() { _jobs = null; for (const t of _timers.values()) clearTimeout(t); _timers.clear(); _active.clear(); _resetLocks(); }

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
  // v2.846 C-1: 되돌리기 실패('rollback-failed')도 이 기능이 설치한 서버다(예전에는 잠금에 걸린 되돌리기가 'failed' 로 남아 여기 들어 있었다)
  for (const j of load()) if (j.hostAddr && ['done', 'failed', 'stopped', 'running', 'rollback-failed'].includes(j.status)) m.set(j.vcenterId, j.hostAddr);
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
let _targets = (o) => listInstallTargets(o);
let _creds = (id) => sshCredsFor(id);
let _pick = (v) => pickBundle(v);
/** 시험 주입(server/test/bareosInstallJob2844.test.js — 가짜 SSH 로 업로드 → 러너 → 4~7단계를 끝까지). */
export function _setDepsForTest(d = {}) {
  _ssh = d.ssh || withSsh; _onDirector = d.onDirector || onDirector; _setupDirector = d.setupDirector || setupDirector; _setupFdPlugin = d.setupFdPlugin || setupFdPlugin;
  _sleep = d.sleep || ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
  _targets = d.targets || ((o) => listInstallTargets(o)); _creds = d.creds || ((id) => sshCredsFor(id)); _pick = d.pickBundle || ((v) => pickBundle(v));
}
/** 시험용 — 돌고 있는 작업이 끝날 때까지 기다린다. */
export async function _settleForTest(ms = 5000) { const t0 = Date.now(); while (_active.size && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5)); return _active.size === 0; }
const credsOf = (j) => {
  const c = _creds(j.targetId);
  if (!c) throw fail('invalid', '배포 등록부에서 이 엣지의 SSH 대상을 찾지 못했습니다(지워졌거나 바뀜).');
  // 반증 M5: 배포 등록부에서 주소를 바꾸면 다시·되돌리기·INI 가 다른 서버로 갔다 — 작업을 시작한 서버와 같을 때만
  if (String(c.host || '').toLowerCase() !== String(j.sshHost || '').toLowerCase() || (Number(c.port) || 22) !== (Number(j.sshPort) || 22)) {
    throw fail('invalid', `배포 등록부의 SSH 주소가 작업 시작 때(${j.sshHost}:${j.sshPort || 22})와 다릅니다 — 이 작업은 다른 서버에 보내지 않습니다.`);
  }
  return c;
};
export { credsOf as _credsOfForTest };
/**
 * v2.846(Bareos 버그 점검 S-1 · C-3 — 재현): 마무리(FD 지문 읽기 · FD INI)는 다시 · 되돌리기와 같은 규칙으로 — 그 법인의 **가장 새 작업**이고
 * 배포 등록부 SSH 주소가 작업 시작 때와 같을 때만(M5). 예전에는 `sshCredsFor` 를 바로 써서, 등록부 주소를 바꾸면 사람이 입력한 vCenter INI 가 다른 서버로 갔다.
 * @returns {{ j, c }} c = SSH 자격(비밀 포함 — 내부 전용)
 */
export function finishContext(id) {
  const j = getJob(String(id || ''));
  if (!j) throw fail('not-found', '작업을 찾을 수 없습니다.');
  if (j.status !== 'done') throw fail('conflict', '설치가 끝난 뒤에 할 수 있습니다.');
  requireLatest(j);
  const c = credsOf(j);
  if (!c?.password) throw fail('invalid', '배포 등록부의 SSH 비밀번호가 없습니다.');
  return { j, c };
}
/** 그 법인·같은 서버의 가장 새 작업(다시·되돌리기는 이것만 — 반증 H2). */
const latestFor = (j) => load().slice().reverse().find((x) => x.vcenterId === j.vcenterId || (x.sshHost && j.sshHost && x.sshHost === j.sshHost)) || null;
function requireLatest(j) {
  const l = latestFor(j);
  if (l && l.id !== j.id) throw fail('conflict', `이 법인(또는 같은 서버)에 더 새 작업(${l.id})이 있어 이 작업은 다시 하거나 되돌릴 수 없습니다 — 새 작업에서 하세요.`);
}
const _starting = new Set();
const runSsh = (creds, fn, ms) => _ssh(creds, fn, { signal: AbortSignal.timeout(ms) });
const secretsOf = (creds) => [creds?.password, creds?.passphrase].filter(Boolean);

/* ───────── 사전 점검(읽기만) ───────── */
export async function runPrecheck({ vcenterId, body = {} }) {
  const t = _targets({ knownHostAddrs: knownHostAddrs() }).find((x) => x.vcenterId === vcenterId);
  if (!t) throw fail('not-found', 'vCenter 를 찾을 수 없습니다.');
  if (!t.can) throw fail('invalid', t.why);
  const bundle = await _pick('');
  let plan = null;
  try { plan = bundle ? normPlan({ ...body, reset: body.reset || { ack: true } }, { contents: bundle.contents, mode: t.mode, corpName: t.vcenterName }) : null; } catch { plan = null; }
  const creds = _creds(t.targetId);
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
  const t = _targets({ knownHostAddrs: knownHostAddrs() }).find((x) => x.vcenterId === vcenterId);
  if (!t) throw fail('not-found', 'vCenter 를 찾을 수 없습니다.');
  if (!t.can) throw fail('invalid', t.why);
  const lockWhy = setupBusyReason('', t.sshHost) || (t.director?.id ? setupBusyReason(t.director.id) : '');
  if (lockWhy) throw fail('conflict', lockWhy);
  const busy = load().find((j) => isActive(j) && (j.vcenterId === vcenterId || (j.sshHost && j.sshHost === t.sshHost)));
  if (busy) throw fail('conflict', `이 법인(또는 같은 서버)의 완전 설치가 진행 중입니다(${busy.id}) — 끝난 뒤 다시 하세요.`);
  // 반증 L1: 점검(await) 중에 같은 요청이 또 오면 둘 다 통과했다 — 시작 준비 중 표시
  const keys = [`vc:${vcenterId}`, `host:${String(t.sshHost).toLowerCase()}`];
  if (keys.some((k) => _starting.has(k))) throw fail('conflict', '이 법인(또는 같은 서버)의 완전 설치를 시작하는 중입니다.');
  keys.forEach((k) => _starting.add(k));
  try { return await startInner(t, vcenterId, body, by); } finally { keys.forEach((k) => _starting.delete(k)); }
}
async function startInner(t, vcenterId, body, by) {
  const bundle = await _pick(String(body.bundleVersion || ''));
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
    // v2.846 D-2: '확인했음 — 실행 중 작업 확인 없이 진행' 동의는 그 회차(시도 행)에만 — 계획(plan)에 넣지 않아 다시 하기로 이어지지 않는다
    attempts: [{ n: 1, at: Date.now(), by, fromStep: firstStep, plan: planSummary(plan), ...(plan.mode === 'reinstall' && body.runningUnknownOk === true ? { runningUnknownOk: true } : {}) }],
    failure: null, upload: null, log: [], startStep: firstStep,
  };
  load().push(j);
  persist();
  kick(j.id, { fromStep: firstStep });
  return publicJob(j);
}

/* ───────── 실행 루프 ───────── */
const _active = new Set();    // 지금 이 프로세스가 돌리는 작업 id
const _timers = new Map();
const _stopReq = new Set();

/**
 * 작업이 도는 동안(원격 단계 포함) 쥐는 잠금 키 — v2.846 C-3(재현): 예전에는 SSH 주소 하나만 쥐어 Director id 와 러너가 읽은 서버 주소(hostAddr)로 오는
 * 자동 설정 · Director 저장·삭제가 통과했다. 재설치면 그 Director id · SSH 주소 · 서버 주소를 함께 쥐고, 4단계가 새 Director 를 등록하면 그때 더한다.
 */
const lockKeysOf = (j) => ({ dirIds: [j.directorId], hosts: [j.sshHost, j.hostAddr] });

function kick(id, opts = {}) {
  if (_active.has(id)) return;
  const j0 = getJob(id);
  // v2.845(v2.844 반증 L3): 같은 서버의 자동 설정 · 법인별 설정 변경과 잠금을 나눈다(bareos/setupLocks.js)
  const owner = `install:${id}`;
  if (j0 && !claimSetupGroup(owner, lockKeysOf(j0))) {
    const why = setupGroupBusyReason(lockKeysOf(j0)) || '같은 서버에 다른 작업이 진행 중입니다.';
    // v2.846 C-1(재현): 전부 되돌리기의 잠금 실패를 설치 실패('failed')로 적으면 그 '그대로 다시' 가 0단계(초기화)부터 돌았다 — 되돌리기 실패로 남긴다
    if (j0.status === 'rolling-back') recordRollbackFailed(j0, { cause: 'busy', message: `${why}(아무것도 바꾸지 않았습니다 — 그 작업이 끝난 뒤 다시 되돌리세요)` });
    else if (isActive(j0)) recordFailure(j0, j0.currentStep ?? null, { cause: 'busy', output: why, message: why });
    return;
  }
  _active.add(id);
  drive(id, opts).catch((e) => {
    const j = getJob(id);
    if (!j || !isActive(j)) return;
    const auth = isSshAuthError(e);
    if (j.status === 'rolling-back') recordRollbackFailed(j, { cause: auth ? 'ssh-auth' : (e?.code || 'error'), message: auth ? SSH_AUTH_TEXT : String(e?.message || e) });
    else recordFailure(j, j.currentStep ?? null, { message: String(e?.message || e), sshAuth: auth });
  }).finally(() => { _active.delete(id); noteSetupEnd(owner); releaseSetupGroup(owner); });
}
const SSH_AUTH_TEXT = '저장된 SSH 계정으로 로그인하지 못했습니다 — 배포 등록부의 계정을 고친 뒤 \'고쳤음\' 을 표시하고 다시 되돌리세요(계정 잠금을 막으려고 자동으로 다시 시도하지 않습니다).';

async function drive(id, { fromStep, resendBundle = false, mode = 'install', resume = false }) {
  const j = getJob(id);
  if (!j) return;
  const creds = credsOf(j);
  if (mode === 'rollback-all') { noteSetupStart(`install:${id}`, `완전 설치 되돌리기 ${j.vcenterName}`); return driveRollbackAll(j, creds, { resume }); }
  if (fromStep <= LAST_REMOTE_STEP) {
    if (!resume) {
      noteSetupStart(`install:${id}`, `완전 설치 ${j.vcenterName}`);
      touch(j, { phase: 'upload', currentStep: fromStep });
      const up = await uploadAndStart(j, creds, { fromStep, resendBundle });
      noteSetupEnd(`install:${id}`);   // 러너가 서버 안에서 돈다 — 중앙 재시작이 끊지 않는다(이어 읽기)
      if (up?.stopped) { _stopReq.delete(j.id); touch(j, { status: 'stopped', phase: 'idle', currentStep: fromStep }); setStep(j, fromStep, { status: 'stopped', at: Date.now() }); return; }
    }
    touch(j, { phase: 'remote', ...(resume && j.remoteStartedAt ? {} : { remoteStartedAt: Date.now() }) });
    const r = await pollRemote(j, creds);
    if (!r.ok) return;
  }
  noteSetupStart(`install:${id}`, `완전 설치 ${j.vcenterName}`);   // 반증 L3: 4단계부터 다시 할 때도 업그레이드 자동 적용이 기다린다
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
async function uploadAndStart(j, creds, { fromStep, resendBundle }) {
  const RD = runDirOf(j.id);
  const bundle = await _pick(j.bundle.version);
  if (!bundle) throw fail('invalid', `번들 ${j.bundle.version} 을(를) 중앙에서 찾지 못했습니다(지워졌거나 검증 실패) — 번들을 다시 받으세요.`);
  const cur = j.attempts?.[j.attempts.length - 1];
  const env = planEnv({ jobId: j.id, bundle: j.bundle, install: j.install, plan: j.plan, startStep: Math.min(fromStep, LAST_REMOTE_STEP), runMode: 'install', hostAddr: j.hostAddr, resetVolumeDirs: j.resetVolumeDirs,
    runningUnknownOk: cur?.runningUnknownOk === true });
  const runner = fs.readFileSync(RUNNER_SRC, 'utf8');
  const remoteTar = `${BUNDLES_DIR}/${tarName(j.bundle.version)}`;
  const up = await runSsh(creds, async (api) => {
    const idu = await api.exec('id -u');
    if (String(idu?.stdout || '').trim() !== '0') throw fail('invalid', 'root 계정으로 접속해야 합니다(배포 등록부의 SSH 계정).');
    const act = String((await api.exec(`systemctl is-active ${UNIT} 2>/dev/null || true`))?.stdout || '').trim();
    if (act === 'active' || act === 'activating') throw fail('conflict', '이 서버에서 완전 설치 러너가 이미 돌고 있습니다 — 끝난 뒤 다시 하세요.');
    await api.exec(`install -d -m 0700 ${REMOTE_ROOT} ${BUNDLES_DIR} ${RUN_DIR} && chmod 0700 ${REMOTE_ROOT}`);
    await api.exec(`install -d -m 0700 ${RD}`);
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
    await api.writeFile(`${RD}/runner.sh`, runner, 0o700);
    await api.writeFile(`${RD}/plan.env`, env, 0o600);
    // 반증 M1: 업로드 중에 누른 중단 — 러너를 띄우지 않는다(초기화 0단계가 그대로 돌던 길)
    if (_stopReq.has(j.id)) return { stopped: true };
    await api.exec(`rm -f ${RD}/stop ${RD}/err.${Math.min(fromStep, LAST_REMOTE_STEP)}`);
    const st = await api.exec(`systemd-run --unit=${UNIT} --collect --quiet --property=RuntimeMaxSec=${Math.floor(REMOTE_MAX_MS / 1000)} /bin/bash ${RD}/runner.sh ${RD} 2>&1`);
    if (st?.code !== 0) throw fail('remote', `러너를 띄우지 못했습니다(systemd-run): ${scrubOutput(String(st?.stdout || st?.stderr || ''), secretsOf(creds)).slice(-300)}`);
    return {};
  }, UPLOAD_SESSION_MS);
  if (up?.stopped) return { stopped: true };
  for (let n = fromStep; n <= LAST_REMOTE_STEP; n++) if (j.steps[n]) setStep(j, n, { status: 'pending', msg: '' });
  return {};
}

/** 상태 파일 파싱(순수) — 단계별 마지막 상태. */
export function parseState(text) {
  let steps = {}; let all = null;
  for (const l of String(text || '').split('\n')) {
    // 회차 시작 표지 — 앞 회차의 줄(특히 'all done')은 버린다(반증 M3)
    if (/^begin /.test(l.trim())) { steps = {}; all = null; continue; }
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

/**
 * 상태 읽기 명령(작업마다 실행 디렉터리). 구간 머리는 **줄 하나**(@@log · @@err · @@file <경로> · @@unit) — 줄 단위로 나눈다.
 * 반증 H1(재현): 예전에는 '\n@@unit\n' 로 잘랐는데 err 파일이 없으면 @@err 바로 뒤에 @@unit 이 와 앞 줄바꿈이 없어 유닛 상태를 못 읽었다
 * → 정상으로 도는 러너를 세 번째 읽기에 '러너 중단' 으로 기록했다. 시험은 이 명령을 **실제 bash** 로 돌린 출력으로 parseRead 를 본다.
 */
export function readCmd(rd) {
  return `cat ${rd}/state 2>/dev/null; echo; echo @@log; tail -n 40 ${rd}/run.log 2>/dev/null; echo; echo @@err; for f in ${rd}/err.?; do [ -f "$f" ] && { echo "@@file $f"; cat "$f"; echo; }; done; echo @@unit; systemctl is-active ${UNIT} 2>/dev/null || true`;
}
/** 읽기 출력 → { steps, all, log, errs, unit }(순수). */
export function parseRead(text) {
  const sec = { state: [], log: [], err: [], unit: [] };
  let cur = 'state';
  for (const raw of String(text || '').split('\n')) {
    const l = raw.replace(/\r$/, '');
    if (l === '@@log') { cur = 'log'; continue; }
    if (l === '@@err') { cur = 'err'; continue; }
    if (l === '@@unit') { cur = 'unit'; continue; }
    sec[cur].push(l);
  }
  const errs = {};
  let n = null;
  for (const l of sec.err) {
    const m = /^@@file .*\/err\.(\d)$/.exec(l);
    if (m) { n = Number(m[1]); errs[n] = ''; continue; }
    if (n != null) errs[n] += `${l}\n`;
  }
  return { ...parseState(sec.state.join('\n')), log: sec.log.filter(Boolean).slice(-40), errs, unit: (sec.unit.find((x) => x.trim()) || '').trim() };
}

/** 러너 상태를 한 번 읽는다. */
async function readRemote(creds, rd) {
  const r = await runSsh(creds, async (api) => ({ text: String((await api.exec(readCmd(rd), 60_000))?.stdout || '') }), SHORT_SESSION_MS);
  return parseRead(r.text);
}

/** 러너가 끝날 때까지 읽는다. @returns {{ ok }} ok = 0~3 단계 모두 끝(중앙 단계로) */
async function pollRemote(j, creds) {
  let wait = POLL_MS; let fails = 0; let idleSeen = 0;
  const rd = runDirOf(j.id);
  const deadline = (Number(j.remoteStartedAt) || Date.now()) + REMOTE_MAX_MS;
  for (;;) {
    if (!getJob(j.id) || !isActive(j)) return { ok: false };
    if (Date.now() > deadline) {
      recordFailure(j, j.currentStep, { cause: 'runner-timeout', message: `원격 단계가 시한(${REMOTE_MAX_MS / 3600_000}시간) 안에 끝나지 않았거나 엣지 노드에 닿지 못했습니다(러너 유닛도 같은 시한에 끝납니다).` }, creds);
      return { ok: false };
    }
    let r;
    try { r = await readRemote(creds, rd); fails = 0; wait = POLL_MS; } catch (e) {
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
    // 4·5단계는 autoSetup 이 그 단계에서 넣은 것을 되돌린다(사유 문구가 결과를 밝힌다) · 6·7단계는 되돌릴 것이 없다(반증 L6)
    output, cause: c, rolledBack: e.rolledBack ?? (step === 4 || step === 5 ? true : null), rollbackFailed: !!e.rollbackFailed };
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
        const conf = `Director {\n  Name = ${dn}\n  Address = localhost\n  DirPort = ${Number(directorPort) || 9101}\n  Password = "unused-${crypto.randomBytes(8).toString('hex')}"\n}\nConsole {\n  Name = "${consoleName}"\n  Password = "${password}"\n  Director = ${dn}\n}\n`;
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
        addSetupGroupDirector(`install:${j.id}`, a.director.id);   // v2.846 C-3: 새로 등록한 Director 도 작업이 끝날 때까지 쥔다(방금 만든 id — 남이 쥘 수 없다)
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
  // v2.846 C-1(재현): 전부 되돌리기를 시도한 작업의 '다시' 는 0단계(초기화)부터 돌 수 있었다 — 되돌리기 시도가 있었으면 거부(다시 되돌리거나 새 작업으로).
  //   ⚠ 'failure.step 이 없으면 거부' 로 넓히지 말 것 — 첫 시작의 잠금 실패(아무 단계도 안 돈 작업)는 정상적으로 다시 할 수 있어야 한다
  if ((j.attempts || []).some((a) => a.rollbackAll)) throw fail('conflict', '전부 되돌리기를 시도한 작업은 다시 할 수 없습니다 — 다시 되돌리거나, 대상 표에서 새 작업으로 설치하세요.');
  if (!['failed', 'stopped'].includes(j.status)) throw fail('conflict', `지금 상태(${j.status})에서는 다시 할 수 없습니다.`);
  if (j.failure?.cause?.key === 'ssh-auth' && body.sshFixed !== true) throw fail('invalid', 'SSH 로그인 실패는 배포 등록부의 계정을 고친 뒤 \'고쳤음\' 을 표시하고 다시 하세요(계정 잠금을 막으려고 확인합니다).');
  requireLatest(j);
  credsOf(j);   // 주소가 바뀌었으면 여기서 멈춘다(반증 M5)
  // 다시 하기는 **실패(멈춘) 단계부터만**(반증 M3·M5 — 앞 단계부터 다시 돌리면 끝난 단계·초기화를 확인 없이 되풀이했다)
  const fromStep = Number.isInteger(j.failure?.step) ? j.failure.step : (Number.isInteger(j.currentStep) ? j.currentStep : j.startStep);
  if (!Number.isInteger(fromStep) || fromStep < j.startStep || fromStep > LAST_STEP) throw fail('invalid', '다시 시작할 단계를 알 수 없습니다 — 전부 되돌린 뒤 새로 하세요.');
  _stopReq.delete(j.id);
  const bundle = await _pick(j.bundle.version);
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
  // v2.846 D-2: '확인했음 — 실행 중 작업 확인 없이 진행' — 0단계부터 다시 할 때 그 회차에만(fix 'running-unknown-ok' · 불리언 true)
  const unknownOk = fromStep === 0 && j.mode === 'reinstall' && (body.fix === 'running-unknown-ok' || body.runningUnknownOk === true);
  j.attempts.push({ n: j.attempts.length + 1, at: Date.now(), by, fromStep, change, fix: body.fix || '', plan: planSummary(plan), ...(unknownOk ? { runningUnknownOk: true } : {}) });
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
    const rd = runDirOf(j.id);
    await runSsh(creds, async (api) => { await api.exec(`[ -d ${rd} ] && touch ${rd}/stop; true`); return {}; }, SHORT_SESSION_MS);
  }
  touch(j, { stopRequestedAt: Date.now() });
  return publicJob(j);
}

/**
 * 전부 되돌리기 — 이 작업이 설치한 것을 지운다(러너 journal 역순) + 포탈에 새로 만든 매핑·Director 등록을 지운다.
 * 초기화(재설치)였다면 지운 옛 설치는 되살리지 못한다(보관한 /etc/bareos tar 는 남긴다 — 응답이 밝힌다).
 */
export function rollbackAllInstall(id, { ack = false, by = '', sshFixed = false } = {}) {
  const j = getJob(id);
  if (!j) throw fail('not-found', '작업을 찾을 수 없습니다.');
  if (ack !== true) throw fail('invalid', '지울 목록을 확인했다는 표시가 필요합니다.');
  if (isActive(j)) throw fail('conflict', '진행 중에는 되돌릴 수 없습니다 — 먼저 중단하세요.');
  if (j.status === 'rolledback') throw fail('conflict', '이미 되돌렸습니다.');
  // v2.846 C-2: SSH 인증 실패로 멈춘 되돌리기는 계정을 고쳤다는 표시가 있어야 다시(계정 잠금 — 자동 재시도 금지 규칙과 같은 확인)
  if (j.status === 'rollback-failed' && j.rollback?.cause === 'ssh-auth' && sshFixed !== true) throw fail('invalid', 'SSH 로그인 실패는 배포 등록부의 계정을 고친 뒤 \'고쳤음\' 을 표시하고 다시 되돌리세요(계정 잠금을 막으려고 확인합니다).');
  requireLatest(j);
  credsOf(j);
  // v2.846 D-7: 원장을 못 읽으면 대상 수를 0 으로 보지 않는다(M4 가 통과하고 포탈 쪽 정리가 빈 원장으로 판정했다) — 503
  if (registryLoadError()) throw fail('unavailable', '백업 대상 원장을 읽지 못한 상태라 전부 되돌리지 않습니다(대상 수를 0 으로 보지 않습니다 · 손상본 보존 — 서비스 점검에서 확인).');
  // M4 · v2.846 D-4(재현): 재설치(기존 Director 를 다시 등록해 쓰는 작업)도 본다 — 예전에는 이 설치로 새로 만든 Director 만 봐서, 다시 등록해 쓰던 대상의 카탈로그 · 설정을 지웠다
  if (j.directorId && (j.createdDirector || j.existingDirector)) {
    const n = listJobs().filter((x) => !x.demo && x.directorId === j.directorId).length;
    if (n > 0) {
      throw fail('conflict', j.createdDirector
        ? `이 설치로 등록한 Director 에 백업 대상이 ${n}개 있습니다 — 백업 대상을 먼저 지운 뒤 되돌리세요(원격만 지우고 포탈 등록이 남는 상태를 만들지 않습니다).`
        : `이 재설치의 Director(기존 등록 — 다시 등록해 씀)에 백업 대상이 ${n}개 있습니다 — 되돌리면 재설치 뒤의 카탈로그 · 설정 · 패키지가 지워져 그 대상의 백업이 멈춥니다. 백업 대상을 먼저 지운 뒤 되돌리세요.`);
    }
  }
  _stopReq.delete(j.id);
  j.attempts.push({ n: j.attempts.length + 1, at: Date.now(), by, fromStep: null, rollbackAll: true });
  touch(j, { status: 'rolling-back', phase: 'remote', rollback: { at: Date.now(), by } });
  kick(j.id, { mode: 'rollback-all' });
  return publicJob(j);
}

async function driveRollbackAll(j, creds, { resume = false } = {}) {
  const notes = [];
  const rd = runDirOf(j.id);
  const env = planEnv({ jobId: j.id, bundle: j.bundle, install: j.install, plan: j.plan, startStep: 1, runMode: 'rollback-all', hostAddr: j.hostAddr });
  const runner = fs.readFileSync(RUNNER_SRC, 'utf8');
  // 원격을 먼저(반증 M4b — 포탈 등록을 먼저 지우고 원격이 실패하면 어긋났다). 포탈 쪽은 원격이 다 되돌려진 뒤에만.
  // v2.846 C-1 ⓑ(재현): 중앙 재시작 뒤 이어 하기는 러너를 **다시 띄우지 않고 상태만 읽는다** — 예전에는 처음부터 다시 띄우려다 '러너가 아직 돌고 있습니다' 로
  //   'failed' 가 됐고(원격은 끝까지 되돌렸는데 중앙은 포탈 등록을 남겼다) 그 '다시' 가 설치를 다시 돌렸다. 끝났으면 그 결과를, 띄우지 못했으면 '실패' 로 읽어 '다시 되돌리기' 를 보인다.
  if (!resume) await runSsh(creds, async (api) => {
    const act = String((await api.exec(`systemctl is-active ${UNIT} 2>/dev/null || true`))?.stdout || '').trim();
    if (act === 'active' || act === 'activating') throw fail('conflict', '러너가 아직 돌고 있습니다.');
    await api.exec(`install -d -m 0700 ${rd}`);
    await api.writeFile(`${rd}/runner.sh`, runner, 0o700);
    await api.writeFile(`${rd}/plan.env`, env, 0o600);
    // 중앙 단계(4·5)가 만든 Director·FD 파일은 /etc/bareos 째로(2단계 etcnew) 지운다 — 설치 전 /etc/bareos 가 없었을 때
    const st = await api.exec(`rm -f ${rd}/stop; systemd-run --unit=${UNIT} --collect --quiet --property=RuntimeMaxSec=${Math.floor(REMOTE_MAX_MS / 1000)} /bin/bash ${rd}/runner.sh ${rd} 2>&1`);
    if (st?.code !== 0) throw fail('remote', '러너를 띄우지 못했습니다(systemd-run).');
    return {};
  }, SHORT_SESSION_MS);
  const deadline = Date.now() + REMOTE_MAX_MS;   // 러너 유닛도 RuntimeMaxSec 로 끝난다 — 이어 하기도 적어도 몇 번은 읽는다(끝난 결과를 놓치지 않게)
  let remote = null; let idle = 0; let last = []; let wait = POLL_MS; let fails = 0;
  while (Date.now() < deadline) {
    await _sleep(wait);
    let r;
    try { r = await readRemote(creds, rd); fails = 0; wait = POLL_MS; } catch (e) {
      // v2.846 C-2(재현): 예전 'catch { continue }' 는 인증 실패도 삼켜 4시간 동안 8초마다 다시 로그인했다(계정 잠금 · fail2ban) — 인증 실패는 즉시 멈춘다
      if (isSshAuthError(e)) { recordRollbackFailed(j, { cause: 'ssh-auth', message: SSH_AUTH_TEXT, left: (last || []).slice(-15).map((l) => scrubOutput(l, secretsOf(creds))) }); return; }
      fails += 1; wait = Math.min(POLL_MAX_MS, wait * 2);   // 그 밖의 오류는 pollRemote 처럼 늘려 가며 다시 읽는다
      touch(j, { pollError: { at: Date.now(), count: fails, message: scrubOutput(String(e?.message || e), secretsOf(creds)).slice(0, 200) } });
      continue;
    }
    if (j.pollError) touch(j, { pollError: null });
    last = r.log;
    touch(j, { log: r.log.map((l) => scrubOutput(l, secretsOf(creds))), lastPollAt: Date.now() });
    if (r.all?.status === 'rolledback') { remote = 'ok'; break; }
    if (r.all?.status === 'rollback-fail') { remote = 'fail'; break; }
    if (r.unit !== 'active' && r.unit !== 'activating') { idle += 1; if (idle >= 3) { remote = 'fail'; break; } } else idle = 0;
  }
  if (remote !== 'ok') {
    recordRollbackFailed(j, { cause: remote === 'fail' ? 'remote' : 'timeout', message: remote === 'fail' ? '원격 되돌리기가 실패했거나 끝 표시 없이 끝났습니다.' : `원격 되돌리기가 시한(${REMOTE_MAX_MS / 3600_000}시간) 안에 끝나지 않았습니다.`,
      left: (last || []).slice(-15).map((l) => scrubOutput(l, secretsOf(creds))) });
    return;
  }
  try {
    // v2.846 D-7: 포탈 쪽 정리도 원장이 읽힐 때만(빈 원장으로 Director 삭제 판정을 하지 않는다)
    if (registryLoadError()) throw fail('unavailable', '백업 대상 원장을 읽지 못해 포탈 쪽 등록 · 매핑을 남겼습니다');
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
  const a = j.attempts[j.attempts.length - 1]; if (a?.rollbackAll) { a.endedAt = Date.now(); a.result = 'rolledback'; }
  touch(j, { status: 'rolledback', phase: 'idle', pollError: null, rollback: { ...j.rollback, doneAt: Date.now(), notes } });
}

/**
 * 전부 되돌리기 실패 기록(v2.846 C-1) — 설치 실패('failed')로 적지 않는다(그 '다시' 가 0단계 초기화부터 돌았다). 포탈 등록 · 매핑은 남긴다.
 * cause: 'busy'(잠금 — 아무것도 바꾸지 않음) · 'ssh-auth'(다시 되돌리기는 '고쳤음' 필요) · 'remote' · 'timeout' · 그 밖 오류 코드.
 */
function recordRollbackFailed(j, { cause = 'error', message = '', left = null }) {
  const a = j.attempts[j.attempts.length - 1]; if (a?.rollbackAll) { a.endedAt = Date.now(); a.result = 'rollback-failed'; a.cause = cause; }
  const notes = [cause === 'busy' ? '아무것도 바꾸지 않았습니다 — 같은 서버의 다른 작업이 끝난 뒤 다시 되돌리세요' : '포탈 쪽 등록 · 매핑은 남겼습니다(원격 되돌리기가 끝나지 않음 — 남은 것을 확인한 뒤 다시 되돌리세요)'];
  touch(j, { status: 'rollback-failed', phase: 'idle', pollError: null,
    rollback: { ...j.rollback, doneAt: Date.now(), cause: String(cause).slice(0, 40), message: String(message || '').slice(0, 600), notes, ...(left ? { left } : {}) } });
}

/** 기동 때 진행 중이던 작업을 이어 읽는다(러너는 서버 안에서 계속 돈다). 업로드·중앙 단계 중이던 것은 '끊김' 으로 실패 처리(다시 시도 가능). */
export function resumeInstallJobs() {
  for (const j of load()) {
    if (!isActive(j)) continue;
    if (j.status === 'rolling-back') { kick(j.id, { mode: 'rollback-all', resume: true }); continue; }   // v2.846 C-1 ⓑ: 상태만 읽는다(러너를 다시 띄우지 않음)
    if (j.phase === 'remote') { kick(j.id, { fromStep: Number.isInteger(j.currentStep) ? Math.min(j.currentStep, LAST_REMOTE_STEP) : j.startStep, resume: true }); continue; }
    recordFailure(j, j.currentStep ?? null, { cause: 'runner-died', message: `포탈이 재시작해 ${j.phase === 'upload' ? '번들 전송' : '중앙 단계'}가 끊겼습니다 — 그 단계부터 다시 하세요.` });
  }
}
