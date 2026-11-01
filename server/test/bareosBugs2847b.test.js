/**
 * test/bareosBugs2847b.test.js — v2.847 Bareos 버그 점검 2회차(반증 판정 hunt2/R.md) 완전 설치 묶음.
 *  S2-2 SSH 인증 실패로 멈춘 설치(failed · stopped)의 전부 되돌리기도 '고쳤음'(sshFixed) 없이는 거부 — 같은 저장 계정으로 곧바로 root 로그인하지 않는다
 *  D2-5 전부 되돌리기 M4 는 directorId 칸이 없는 옛 대상도 센다(jobDirectorId — Director 삭제 라우트와 같은 판정)
 *  C2-2 기동 때(HTTP 전) 이어 읽을 작업의 잠금을 선점 · 이어 읽기가 넘겨받는다 · 잠금을 못 잡으면 failed 로 적지 않고 다시 잡는다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi2847-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';

const J = await import('../src/bareos/install/job.js');
const L = await import('../src/bareos/setupLocks.js');
const PL = await import('../src/bareos/install/plan.js');
const PC = await import('../src/bareos/install/precheck.js');
const { parseErrFile, classifyFailure } = await import('../src/bareos/install/causes.js');
const { normContents } = await import('../src/bareos/install/bundleDoc.js');
const { addDirector, _resetForTest: resetSettings } = await import('../src/bareos/settings.js');
const { _resetForTest: resetRegistry } = await import('../src/bareos/registry.js');

const PASS = 'S3cret-pass!x';
const SHA = 'a'.repeat(64);
const V = '25.20261101.4';
const contents = normContents({ format: 'portal-bareos-bundle', v: 1, version: V, el: '9', arch: 'x86_64', bareosVersion: '25.1.2', postgresqlVersion: '13.23', install: ['bareos', 'postgresql-server'], packages: [], keys: ['K'], pyvmomi: { versions: ['8.0.3.0.1'], default: '8.0.3.0.1' } }, V).contents;
const tarPath = path.join(tmp, 'b.tar.gz'); fs.writeFileSync(tarPath, 'x');
const BUNDLE = { ok: true, version: V, sha256: SHA, size: 1, tarPath, contents };
const SSH_HOST = '10.0.0.1'; const HOST_ADDR = '10.20.0.14';
const target = (o = {}) => ({ vcenterId: 'vc1', vcenterName: '법인1', vcHost: 'vc1.corp', agent: 'edge1', targetId: 't1', sshHost: SSH_HOST, sshPort: 22, sshUser: 'root', hasPassword: true, director: null, mode: 'install', can: true, why: '', ...o });
const PRE = ['@@id', '0', '@@os', 'ID=rocky', 'VERSION_ID=9.4', 'PRETTY=Rocky 9.4', 'ARCH=x86_64', '@@tools', 'systemd-run=1', 'dnf=1', 'rpm=1', 'ss=1', '@@selinux', 'Enforcing', '@@pkgs', '@@etc', 'none',
  '@@svc', '@@ports', '@@python', '3.9.18', '@@pyvmomi', 'none', '@@bpp', '@@disk', 'PATH=/var/lib', 'AVAIL_KB=900000000', 'SIZE_KB=1800000000', 'MOUNT=/', 'EXISTS=0', '@@varlib', '900000000',
  '@@clock', '0.000120 seconds fast of NTP time', '@@addr', HOST_ADDR, 'edge1.corp', '@@runner', 'inactive', '@@running', 'none', '@@catalog', 'none', '@@volumes', '@@end'].join('\n');

/** readCmd 와 같은 모양의 출력(구간 머리는 줄 하나). */
const readOut = (state, unit = 'inactive', errs = {}) => `${state}\n\n@@log\nok\n\n@@err\n${Object.entries(errs).map(([f, t]) => `@@file ${f}\n${t}\n`).join('')}@@unit\n${unit}\n`;
function defaultRead(R, rd) {
  const env = R.writes.get(`${rd}/plan.env`) || '';
  if (/RUN_MODE='rollback-all'/.test(env)) return readOut('begin rollback-all 1\n3 ok 1\nall rolledback 2');
  const start = Number(/START_STEP='(\d)'/.exec(env)?.[1] || 1);
  const lines = []; for (let n = start; n <= 3; n++) lines.push(`${n} start ${n}`, `${n} ok ${n}`);
  return readOut(`begin install 1\n${lines.join('\n')}\nall done 9`);
}
/** 가짜 엣지 노드 — 세션마다 failSsh(R) 가 오류를 주면 던진다 · readImpl 로 상태 출력을 바꾼다. */
function fake() {
  const R = { writes: new Map(), cmds: [], launches: 0, rollbackLaunches: 0, reads: 0, sessions: 0, unitActive: false, readImpl: null, failSsh: null, envs: [] };
  R.ssh = async (_creds, fn) => {
    R.sessions += 1;
    const err = R.failSsh?.(R);
    if (err) throw err;
    const api = {
      exec: async (cmd) => {
        R.cmds.push(cmd);
        if (cmd.includes('echo @@id')) return { code: 0, stdout: R.pre || PRE };
        if (cmd === 'id -u') return { code: 0, stdout: '0\n' };
        if (cmd.startsWith('systemctl is-active portal-bareos-install')) return { code: 0, stdout: R.unitActive ? 'active\n' : 'inactive\n' };
        if (cmd.includes('.part | cut')) return { code: 0, stdout: `${SHA}\n` };
        if (cmd.includes('sha256sum')) return { code: 0, stdout: '' };
        if (cmd.includes('systemd-run')) {
          R.launches += 1;
          const rd = /\/bin\/bash (\S+)\/runner\.sh/.exec(cmd)[1];
          const env = R.writes.get(`${rd}/plan.env`) || '';
          R.envs.push(env);
          if (/RUN_MODE='rollback-all'/.test(env)) R.rollbackLaunches += 1;
          return { code: 0, stdout: '' };
        }
        if (cmd.includes('echo @@log')) { R.reads += 1; const rd = /cat (\S+)\/state/.exec(cmd)[1]; return { code: 0, stdout: (R.readImpl || defaultRead)(R, rd) }; }
        return { code: 0, stdout: '' };
      },
      writeFile: async (p, c) => { R.writes.set(p, String(c)); },
      putFile: async (_l, _r, o) => { o?.onProgress?.(1, 1); },
    };
    return { ok: true, ...(await fn(api)) };
  };
  return R;
}
function deps(R, t = target(), extra = {}) {
  J._setDepsForTest({
    ssh: R.ssh, sleep: async () => {}, targets: () => [t], creds: () => ({ host: SSH_HOST, port: 22, username: 'root', password: PASS }), pickBundle: async () => BUNDLE,
    setupDirector: async (body, ctx) => { ctx.save({ consoleName: body.consoleName, password: 'p'.repeat(32) }); return { files: [{}] }; },
    setupFdPlugin: async () => ({ action: 'added', added: ['Plugin Names'] }),
    onDirector: async () => ({ version: '25.1.2' }),
    ...extra,
  });
}
function reset() {
  J._resetForTest(); resetSettings(); resetRegistry();
  for (const f of fs.readdirSync(tmp)) { const p = path.join(tmp, f); if (fs.statSync(p).isFile() && f !== 'b.tar.gz') fs.rmSync(p); }
}
const authErr = () => Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' });
/** 끝난 설치(또는 재설치) 하나. */
async function doneJob(R, t = target(), body = {}) {
  deps(R, t);
  const j0 = await J.startInstall({ vcenterId: t.vcenterId, body, by: 'admin' });
  assert.ok(await J._settleForTest());
  const j = J.installJob(j0.id);
  assert.equal(j.status, 'done', JSON.stringify(j.failure));
  return j;
}
const existingDirTarget = () => {
  const d = addDirector({ name: '법인1 Bareos', host: HOST_ADDR, port: 9101, consoleName: 'portal', password: 'x'.repeat(24), agent: 'edge1' }).director;
  return { d, t: target({ mode: 'reinstall', director: { id: d.id, name: d.name, host: d.host, agent: 'edge1' } }) };
};
const REINSTALL_BODY = { reset: { ack: true, catalog: true, volumes: false } };


const S = await import('../src/bareos/settings.js');
void crypto; void spawnSync; void HERE; void PL; void PC; void parseErrFile; void classifyFailure;

test('S2-2 SSH 인증 실패로 멈춘 설치의 전부 되돌리기 — 고쳤음 없이는 거부(같은 저장 계정으로 다시 로그인하지 않는다)', async () => {
  reset();
  const R = fake();
  deps(R);
  let authFails = 0;
  // 번들 전송 세션부터 인증 실패(사전 점검 · 시작은 통과) — 엣지 root 비밀번호가 바뀐 모양
  R.failSsh = (r) => (r.sessions > 1 ? (authFails += 1, authErr()) : null);
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: {}, by: 'admin' });
  assert.ok(await J._settleForTest());
  const j = J.installJob(j0.id);
  assert.equal(j.status, 'failed', JSON.stringify(j.failure));
  assert.equal(j.failure.cause.key, 'ssh-auth');
  const before = authFails;
  assert.throws(() => J.rollbackAllInstall(j.id, { ack: true, by: 'admin' }), (e) => e.code === 'invalid' && /고쳤음/.test(e.message));
  assert.equal(authFails, before, '거부했으니 로그인을 시도하지 않았다');
  assert.equal(J.installJob(j.id).status, 'failed', '상태를 바꾸지 않았다');
  // 고쳤음 표시가 있으면 받아들인다
  R.failSsh = null;
  const r = J.rollbackAllInstall(j.id, { ack: true, sshFixed: true, by: 'admin' });
  assert.equal(r.status, 'rolling-back');
  assert.ok(await J._settleForTest());
});

test('D2-5 전부 되돌리기 M4 — directorId 칸이 없는 옛 대상(매핑으로 이 Director)도 센다', async () => {
  reset();
  const R = fake(); const { d, t } = existingDirTarget();
  const j = await doneJob(R, t, REINSTALL_BODY);
  // vc1 의 매핑이 이 Director 를 가리키는 상태에서 directorId 없이 남은 v2.823 이전 대상
  const cur = S.loadSettings();
  if (!cur.sites.some((x) => x.vcenterId === 'vc1' && x.directorId === d.id)) S.saveSettings({ sites: [...cur.sites.filter((x) => x.vcenterId !== 'vc1'), { vcenterId: 'vc1', directorId: d.id, vcserver: 'vc1.corp', client: 'c', storage: 'File', pool: 'P', configFile: '/etc/bareos/vmware/vc1.ini' }] });
  assert.equal(S.jobDirectorId({ vcenterId: 'vc1' }, S.loadSettings()), d.id);
  fs.writeFileSync(path.join(tmp, 'bareos-jobs.json'), JSON.stringify({ jobs: [{ id: 'bj-old', vcenterId: 'vc1', vmName: 'vm1', bareosJob: 'portal-vm1' }], retired: [] }));
  resetRegistry();
  assert.throws(() => J.rollbackAllInstall(j.id, { ack: true, by: 'admin' }), (e) => e.code === 'conflict' && /1개/.test(e.message));
  assert.equal(R.rollbackLaunches, 0);
});

/** 기록을 '원격 단계 진행 중' 으로 바꾸고 중앙 재시작 모양(메모리 비움). */
function asRemoteRunning(j, { rolling = false } = {}) {
  const file = path.join(tmp, 'bareos-install-jobs.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const x = rec.jobs.find((y) => y.id === j.id);
  if (rolling) { x.status = 'rolling-back'; x.phase = 'remote'; x.rollback = { at: Date.now(), by: 'admin' }; x.attempts.push({ n: x.attempts.length + 1, at: Date.now(), by: 'admin', fromStep: null, rollbackAll: true }); }
  else { x.status = 'running'; x.phase = 'remote'; x.currentStep = 2; x.remoteStartedAt = Date.now(); }
  fs.writeFileSync(file, JSON.stringify(rec));
  J._resetForTest();
}

test('C2-2 기동 때 선점한 잠금 — 그 사이 같은 Director · 서버의 쓰기는 409 · 이어 읽기가 넘겨받아 끝낸 뒤 푼다', async () => {
  reset();
  const R = fake(); const { d, t } = existingDirTarget();
  const j = await doneJob(R, t, REINSTALL_BODY);
  asRemoteRunning(j);
  L._resetForTest();
  assert.equal(J.reserveInstallResumeLocks(), 1);
  assert.ok(L.setupBusyReason(d.id), 'HTTP 를 열기 전에 Director 잠금을 쥔다');
  assert.equal(L.claimSetup(d.id, SSH_HOST), false, '같은 Director 의 법인별 설정 · 자동 설정이 통과하지 못한다');
  R.unitActive = true;
  let n = 0;
  R.readImpl = (r, rd) => { n += 1; return n < 2 ? readOut('begin install 1\n2 start 1', 'active') : defaultRead(r, rd); };
  J.resumeInstallJobs();
  assert.ok(await J._settleForTest());
  const after = J.installJob(j.id);
  assert.equal(after.status, 'done', JSON.stringify(after.failure));
  assert.equal(L.setupBusyReason(d.id), '', '끝나면 잠금을 푼다');
});

test('C2-2 이어 읽기가 잠금을 못 잡으면 failed(busy) 로 적지 않고 잠시 뒤 다시 잡는다(러너는 서버에서 계속 돈다)', async () => {
  reset();
  const R = fake(); const { d, t } = existingDirTarget();
  const j = await doneJob(R, t, REINSTALL_BODY);
  asRemoteRunning(j, { rolling: true });
  L._resetForTest();
  assert.ok(L.claimSetup(d.id, SSH_HOST), '선점 전에 다른 작업이 잠금을 쥔 경우(예: 선점이 실패)');
  J._setResumeRetryMsForTest(20);
  R.readImpl = () => readOut('begin rollback-all 1\n3 ok 1\nall rolledback 2', 'inactive');   // 되돌리기 러너가 끝난 상태(이어 읽기는 러너를 다시 띄우지 않는다)
  try {
    J.resumeInstallJobs();
    await new Promise((r) => setTimeout(r, 60));
    const mid = J.installJob(j.id);
    assert.equal(mid.status, 'rolling-back', `잠금을 못 잡아도 실패로 적지 않는다(${mid.status} ${JSON.stringify(mid.rollback)})`);
    L.releaseSetupLock(d.id, SSH_HOST);
    const t0 = Date.now();
    while (J.installJob(j.id).status === 'rolling-back' && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
    assert.ok(await J._settleForTest());
    assert.equal(J.installJob(j.id).status, 'rolledback');
  } finally { J._setResumeRetryMsForTest(); }
});
