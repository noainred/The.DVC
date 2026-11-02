/**
 * bareos/install/demo.js — 완전 설치 데모(mock 모드 + 실제 Director 미등록일 때만 · v2.844). 장비·엣지·SSH 에 닿지 않는다(docs/rules/demo.md).
 *
 * 화면 전체 흐름(대상 → 사전 점검 → 계획 → 실행 → 실패 → 고쳐서 다시 → 마무리)을 시간에 따라 진행하는 합성 작업으로 보여 준다.
 * 판정은 **실제 코드**(judgePrecheck · classifyFailure · normPlan)를 지난다 — 데모만의 판정을 따로 두지 않는다.
 * 첫 회차는 pyVmomi 사본 때문에 2단계에서 실패한다(플러그인 경로 '옮기기' 를 켜고 다시 하면 끝까지 간다 — 실제 규칙 pyvmomi-shadow).
 */
import { store } from '../../store.js';
import { STEPS, planSummary, normPlan, LAST_STEP } from './plan.js';
import { judgePrecheck } from './precheck.js';
import { classifyFailure } from './causes.js';

const STEP_MS = 4_000;
const DEMO_BUNDLE = Object.freeze({
  version: '25.20261101.4', size: 186_079_765, ok: true, reason: '', sha256: 'd'.repeat(64),
  contents: { version: '25.20261101.4', builtAt: '2026-11-01T10:40:00Z', bareosVersion: '25.1.2~pre73.3e32b07ea', postgresqlVersion: '13.23', install: ['bareos', 'bareos-webui', 'postgresql-server'],
    // v2.851: 판 태그가 있어야 사전 점검 'OS 판 ↔ 번들 패키지 판' 이 비교한다(데모 서버 9.4 와 같은 판 → ok)
    packages: [{ name: 'bareos-director', version: '25.1.2~pre73.3e32b07ea', release: '1.el9', arch: 'x86_64' }, { name: 'openssl-libs', version: '3.0.7', release: '28.el9_4', arch: 'x86_64' }], keys: ['RPM-GPG-KEY-bareos-experimental'],
    pyvmomi: { versions: ['8.0.3.0.1', '8.0.2.0.1', '8.0.1.0.2'], default: '8.0.3.0.1', python: '3.9' }, vddk: ['bareos-vadp-dumper-25.1.2~pre73.3e32b07ea', 'bareos-vmware-vix-disklib-9.0.0.0_24742305'] },   // CI 번들 빌드 실측값(2026-11-01 run 4)
});
const _jobs = new Map();
let _seq = 0;
let _fetched = true;
export function _resetForTest() { _jobs.clear(); _seq = 0; _fetched = true; }

function targets(now = Date.now()) {
  const vcs = (store.get()?.vcenters || []).slice(0, 6);
  const kinds = ['install', 'reinstall', 'no-edge', 'offline', 'no-pass', 'install'];
  return vcs.map((v, i) => {
    const k = kinds[i % kinds.length];
    const agent = k === 'no-edge' ? '' : `edge-demo-${i + 1}`;
    const row = {
      vcenterId: v.id, vcenterName: v.name || v.id, vcHost: String(v.host || `vc-${i + 1}.demo`).replace(/^https?:\/\//, ''), agent,
      edgeAt: agent ? now - (k === 'offline' ? 2 * 86_400_000 : 40_000 + i * 9_000) : null, edgeAgeMs: agent ? (k === 'offline' ? 2 * 86_400_000 : 40_000 + i * 9_000) : null,
      targetId: agent ? `demo-target-${i + 1}` : '', sshHost: agent ? `10.${20 + i}.0.14` : '', sshPort: 22, sshUser: agent ? 'root' : '',
      hasPassword: k !== 'no-pass', director: k === 'reinstall' ? { id: 'dir_demo_existing', name: `${v.name || v.id} Bareos`, host: `10.${20 + i}.0.14`, agent } : null,
      mode: k === 'reinstall' ? 'reinstall' : 'install', can: ['install', 'reinstall'].includes(k), why: '', demo: true,
    };
    if (k === 'no-edge') row.why = '엣지 노드 없음 — 이 vCenter 의 인벤토리를 올리는 엣지가 없습니다.';
    if (k === 'offline') row.why = '엣지 응답 없음(마지막 수신 2880분 전).';
    if (k === 'no-pass') row.why = '배포 등록부에 SSH 비밀번호가 저장돼 있지 않습니다(키만 저장된 대상은 아직 지원하지 않습니다).';
    const j = [..._jobs.values()].reverse().find((x) => x.vcenterId === v.id);
    row.lastJob = j ? { id: j.id, status: view(j).status, mode: j.mode, updatedAt: Date.now(), currentStep: view(j).currentStep } : null;
    return row;
  });
}

export function overview() {
  return { ok: true, demo: true, targets: targets(), bundles: _fetched ? [DEMO_BUNDLE] : [], fetch: null, bundleBaseUrl: 'https://github.com/noainred/The.DVC/releases/download/bareos-bundle',
    jobs: [..._jobs.values()].reverse().map((j) => ({ id: j.id, vcenterId: j.vcenterId, vcenterName: j.vcenterName, mode: j.mode, status: view(j).status, by: j.by, createdAt: j.createdAt, updatedAt: Date.now() })),
    steps: STEPS, otpOff: true };
}
export function fetchBundle() { _fetched = true; return { ok: true, started: true, demo: true }; }

function facts(t, mode) {
  return {
    complete: true, uid: 0, os: { id: 'rocky', versionId: '9.4', pretty: 'Rocky Linux 9.4 (Blue Onyx)', arch: 'x86_64' },
    tools: { 'systemd-run': true, dnf: true, rpm: true, ss: true, python3: true, chronyc: false }, selinux: 'Enforcing',
    pkgs: mode === 'reinstall' ? [{ name: 'bareos-director', version: '22.1.2' }, { name: 'bareos-storage', version: '22.1.2' }, { name: 'bareos-filedaemon', version: '22.1.2' }] : [],
    etcFiles: mode === 'reinstall' ? 41 : null, services: {}, portsInUse: mode === 'reinstall' ? [9101, 9102, 9103] : [],
    python: '3.9.18', pyvmomi: null, pluginPathCopies: mode === 'reinstall' ? [] : ['/usr/lib64/bareos/plugins/pyVmomi'],
    disk: { path: '/var/lib', availKb: 412 * 1024 * 1024, sizeKb: 1800 * 1024 * 1024, mount: '/', exists: false }, varLibAvailKb: 412 * 1024 * 1024,
    clockOffsetSec: null, hostAddr: t.sshHost, hostname: `${t.agent}.demo`, runnerActive: false, runnerState: [],
    runningJobs: mode === 'reinstall' ? 0 : null, catalogBytes: mode === 'reinstall' ? 1_932_735_283 : null,
    volumes: mode === 'reinstall' ? [{ path: '/var/lib/bareos/storage', files: 96, bytes: 2.3 * 1024 ** 4, lastAt: Date.now() - 30 * 3600_000 }] : [],
  };
}

export function precheck(vcenterId, body = {}) {
  const t = targets().find((x) => x.vcenterId === vcenterId);
  if (!t) return { ok: false, reason: 'vCenter 를 찾을 수 없습니다.' };
  if (!t.can) return { ok: false, reason: t.why };
  let plan = null;
  try { plan = normPlan({ ...body, reset: body.reset || { ack: true } }, { contents: DEMO_BUNDLE.contents, mode: t.mode, corpName: t.vcenterName }); } catch { plan = null; }
  const j = judgePrecheck(facts(t, t.mode), { mode: t.mode, bundle: DEMO_BUNDLE.contents, plan });
  return { ok: true, demo: true, at: Date.now(), ms: 6100, target: t, mode: t.mode, ...j, ledgerTargets: t.mode === 'reinstall' ? 12 : 0, bundle: { version: DEMO_BUNDLE.version, contents: DEMO_BUNDLE.contents, size: DEMO_BUNDLE.size } };
}

export function start(vcenterId, body = {}, by = '') {
  const t = targets().find((x) => x.vcenterId === vcenterId);
  if (!t || !t.can) return { ok: false, reason: t?.why || 'vCenter 를 찾을 수 없습니다.' };
  let plan;
  try { plan = normPlan(body, { contents: DEMO_BUNDLE.contents, mode: t.mode, corpName: t.vcenterName }); } catch (e) { return { ok: false, code: 'invalid', reason: e.message }; }
  const id = `bi_demo${String(++_seq).padStart(6, '0')}`;
  const first = t.mode === 'reinstall' ? 0 : 1;
  const j = { id, vcenterId, vcenterName: t.vcenterName, vcHost: t.vcHost, agent: t.agent, sshHost: t.sshHost, hostAddr: t.sshHost, mode: t.mode, plan, by, createdAt: Date.now(), startStep: first,
    bundle: { version: DEMO_BUNDLE.version, size: DEMO_BUNDLE.size, bareosVersion: DEMO_BUNDLE.contents.bareosVersion }, attempts: [{ n: 1, at: Date.now(), by, fromStep: first, plan: planSummary(plan) }], stopAt: null, rollbackAt: null };
  _jobs.set(id, j);
  return { ok: true, demo: true, job: view(j) };
}

/** 시간으로 진행을 계산한다(순수 — 기록은 회차·계획뿐). */
function view(j, now = Date.now()) {
  const a = j.attempts[j.attempts.length - 1];
  const steps = {};
  for (const s of STEPS) if (s.n >= j.startStep) steps[s.n] = { status: 'pending' };
  // 앞 회차에서 끝난 단계
  for (const s of STEPS) if (s.n >= j.startStep && s.n < a.fromStep) steps[s.n] = { status: 'ok', at: a.at - 60_000, endedAt: a.at - 30_000, msg: '이전 회차에서 끝남(다시 하지 않음)' };
  // 데모 실패: 사본 옮기기를 끈 채면 pyVmomi 판 불일치(매 회차) · 켠 채 첫 회차면 dnf 잠금(다른 패키지 작업 — 그대로 다시 하면 통과)
  const shadow = !j.plan.pyvmomiFix && j.mode === 'install';
  const failAt = shadow || (j.mode === 'install' && j.attempts.length === 1) ? 2 : null;
  let status = 'running'; let currentStep = a.fromStep; let failure = null;
  let t = a.at + (a.fromStep <= 1 ? 1500 : 0);
  for (let n = a.fromStep; n <= LAST_STEP; n++) {
    const end = t + STEP_MS;
    if (j.stopAt && j.stopAt <= t) { status = 'stopped'; currentStep = n; steps[n] = { status: 'stopped', at: t }; break; }
    if (now < end) { steps[n] = { status: 'running', at: t }; currentStep = n; break; }
    if (n === failAt) {
      steps[n] = { status: 'failed', at: t, endedAt: end };
      if (shadow) {
        const output = 'pip show pyvmomi → Version: 8.0.3.0.1 (/usr/local/lib/python3.9/site-packages)\nPYTHONPATH=/usr/lib64/bareos/plugins python3 -c "import pyVmomi"\nException: Python 3.10 or newer is required (found 3.9)';
        failure = { step: n, at: end, cmd: 'pyVmomi 확인', code: 1, message: '플러그인이 실제로 불러오는 판이 9.1.1 입니다(고른 판 8.0.3.0.1).', output, cause: classifyFailure({ step: n, cause: 'pyvmomi-shadow', output }), rolledBack: true, rollbackFailed: false };
      } else {
        // v2.851: 실제 사례(2026-11-02 — 번들 el9_8 ↔ 서버 el9_4 · openssl-devel 고정)의 출력 모양으로 — 원인 판정은 실제 코드
        const output = ['Package policycoreutils-python-utils-3.6-2.1.el9.noarch is already installed.', 'Package tar-2:1.34-6.el9_4.1.x86_64 is already installed.', 'Package openssl-1:3.0.7-28.el9_4.x86_64 is already installed.', 'Error: ',
          ' Problem: cannot install both openssl-libs-1:3.5.8-2.el9_8.x86_64 from portal-bareos-local and openssl-libs-1:3.0.7-28.el9_4.x86_64 from @System',
          '  - package openssl-1:3.5.8-2.el9_8.x86_64 from portal-bareos-local requires libcrypto.so.3(OPENSSL_3.4.0)(64bit), but none of the providers can be installed',
          '  - package openssl-1:3.5.8-2.el9_8.x86_64 from portal-bareos-local requires openssl-libs(x86-64) = 1:3.5.8-2.el9_8, but none of the providers can be installed',
          '  - package openssl-devel-1:3.0.7-28.el9_4.x86_64 from @System requires openssl-libs(x86-64) = 1:3.0.7-28.el9_4, but none of the providers can be installed',
          '  - cannot install the best candidate for the job'].join('\n');
        failure = { step: n, at: end, cmd: 'dnf install(번들 저장소만 · …)', code: 1, message: '', output, cause: classifyFailure({ step: n, output }), rolledBack: true, rollbackFailed: false };
      }
      status = 'failed'; currentStep = n; break;
    }
    steps[n] = { status: 'ok', at: t, endedAt: end, msg: DEMO_MSG[n] || '' };
    t = end;
    if (n === LAST_STEP) { status = 'done'; currentStep = null; }
  }
  if (j.rollbackAt) status = now - j.rollbackAt > 8_000 ? 'rolledback' : 'rolling-back';
  const upSent = Math.min(j.bundle.size, Math.max(0, Math.round(((now - a.at) / (STEP_MS + 1500)) * j.bundle.size)));
  return {
    id: j.id, demo: true, vcenterId: j.vcenterId, vcenterName: j.vcenterName, vcHost: j.vcHost, agent: j.agent, sshHost: j.sshHost, hostAddr: j.hostAddr, mode: j.mode,
    plan: j.plan, planText: planSummary(j.plan), bundle: j.bundle, by: j.by, createdAt: j.createdAt, updatedAt: now, status, currentStep,
    phase: status === 'running' ? (currentStep != null && currentStep <= 3 ? 'remote' : 'central') : 'idle', steps, failure, attempts: j.attempts, startStep: j.startStep,
    upload: a.fromStep <= 1 ? { sent: upSent, total: j.bundle.size, at: a.at, ...(upSent >= j.bundle.size ? { doneAt: a.at + STEP_MS } : {}) } : { sent: j.bundle.size, total: j.bundle.size, reused: true },
    log: demoLog(steps), directorId: status === 'done' ? 'dir_demo_new' : '', existingDirector: j.mode === 'reinstall',
    stepsMeta: STEPS.filter((s) => s.n >= j.startStep).map((s) => ({ n: s.n, label: s.label, remote: s.remote })),
    ...(j.rollbackAt ? { rollback: { at: j.rollbackAt, ...(status === 'rolledback' ? { doneAt: j.rollbackAt + 8_000, notes: ['매핑 삭제', 'Director 등록 삭제'] } : {}) } } : {}),
  };
}
const DEMO_MSG = { 0: '설정 보관 · 패키지 3개 제거 · 카탈로그 DB 삭제(데모)', 1: '번들 sha256 일치 · 로컬 저장소', 2: 'RPM 설치 · pyVmomi 8.0.3.0.1 · 카탈로그 DB', 3: '볼륨 · PortalFileStorage · 서비스 · WebUI', 4: 'Director 리소스 9개 · 포탈 등록(담당 엣지)', 5: '플러그인 줄 추가', 6: '엣지 경유 접속 성공 · 25.1.2~pre73', 7: '매핑 저장' };
function demoLog(steps) {
  const out = [];
  for (const [n, s] of Object.entries(steps)) {
    if (s.status === 'pending') continue;
    out.push(`${new Date(s.at || Date.now()).toLocaleTimeString('ko-KR', { hour12: false })} [${n}] ${STEPS.find((x) => x.n === Number(n))?.label} ${s.status === 'running' ? '진행 중' : s.status === 'ok' ? '끝' : s.status === 'failed' ? '실패 — 이 단계가 넣은 것을 되돌림' : s.status}`);
  }
  return out.slice(-40);
}

export function job(id) { const j = _jobs.get(id); return j ? view(j) : null; }
export function retry(id, body = {}, by = '') {
  const j = _jobs.get(id); if (!j) return null;
  const v = view(j);
  if (!['failed', 'stopped'].includes(v.status)) return v;
  const from = v.failure?.step ?? v.currentStep ?? j.startStep;
  const before = planSummary(j.plan);
  if (body.fix === 'pyvmomi-fix') j.plan = { ...j.plan, pyvmomiFix: true };
  if (body.plan?.pyvmomi && DEMO_BUNDLE.contents.pyvmomi.versions.includes(body.plan.pyvmomi)) j.plan = { ...j.plan, pyvmomi: body.plan.pyvmomi };
  j.stopAt = null;
  j.attempts.push({ n: j.attempts.length + 1, at: Date.now(), by, fromStep: from, fix: body.fix || '', change: planSummary(j.plan) !== before ? `${before} → ${planSummary(j.plan)}` : '', plan: planSummary(j.plan) });
  j.attempts[j.attempts.length - 2].result = 'failed';
  return view(j);
}
export function stop(id) { const j = _jobs.get(id); if (!j) return null; j.stopAt = Date.now(); return view(j); }
export function rollback(id, body = {}) { const j = _jobs.get(id); if (!j) return null; if (body.ack !== true) return { ...view(j), error: '확인 표시가 필요합니다.' }; j.rollbackAt = Date.now(); return view(j); }
export function thumbprint() { return { ok: true, demo: true, vcserver: 'vc-demo.vcenter.demo', thumbprint: 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01' }; }
export function fdIni(id, b = {}) {
  if (!b.vcuser || !b.vcpass) return { ok: false, reason: 'vCenter 계정과 비밀번호를 입력하세요.' };
  return { ok: true, demo: true, path: '/etc/bareos/vmware/vc-demo.ini', action: 'created', plugin: 'installed' };
}
