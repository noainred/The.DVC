/**
 * test/bareosInstallBugs2846.test.js — v2.846 Bareos 완전 설치 버그 점검 확정분(반증 판정 hunt/R.md).
 *  C-1 전부 되돌리기의 잠금 실패 · 예외 → 'rollback-failed'(설치 실패가 아니다) · 그 작업의 '다시' 거부(첫 시작 잠금 실패의 정상 재시도는 허용) ·
 *      중앙 재시작 뒤 이어 하기는 러너를 다시 띄우지 않고 상태만 읽는다
 *  C-2 되돌리기 폴링: SSH 인증 실패면 즉시 멈춤(자동 재시도 금지 · 다시 되돌리기는 '고쳤음') · 그 밖 오류는 늘려 가며
 *  C-3 완전 설치가 Director id · SSH 주소 · 서버 주소(hostAddr)를 함께 쥔다(4단계가 새로 등록한 Director 도) — 단건 API 는 그대로
 *  D-2 러너 0단계의 실행 중 작업 판정(실제 bash) — 못 읽으면 멈춤 · 화면 동의(RUNNING_UNKNOWN_OK — 그 회차만)로만 진행 · 사전 점검도 같은 판정
 *  D-4 전부 되돌리기 M4 를 재설치(기존 Director)에도 · D-7 원장을 못 읽으면 거부(503)
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi2846-'));
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

/* ───────── C-1 ───────── */

test('C-1 ⓐ 끝난 재설치의 전부 되돌리기가 잠금에 걸리면 rollback-failed(busy) — 설치 실패가 아니고 그 작업의 다시 하기는 거부', async () => {
  reset();
  const R = fake(); const { t } = existingDirTarget();
  const j = await doneJob(R, t, REINSTALL_BODY);
  assert.equal(j.mode, 'reinstall'); assert.equal(j.startStep, 0);
  assert.ok(L.claimSetup('dir_other', SSH_HOST), '같은 서버의 다른 작업(법인별 설정 · 자동 설정)이 잠금을 쥔다');
  const r = J.rollbackAllInstall(j.id, { ack: true, by: 'admin' });
  assert.equal(r.status, 'rollback-failed', '잠금 실패 = 되돌리기 실패(예전: failed — 그 다시 하기가 0단계 초기화부터 돌았다)');
  assert.equal(r.rollback.cause, 'busy');
  assert.equal(r.failure, null, '설치 실패 기록을 만들지 않는다');
  assert.equal(R.rollbackLaunches, 0, '아무것도 바꾸지 않았다');
  await assert.rejects(() => J.retryInstall(j.id, { body: {}, by: 'admin' }), (e) => e.code === 'conflict' && /되돌리기를 시도한 작업/.test(e.message));
  L.releaseSetupLock('dir_other', SSH_HOST);
  // 다시 되돌리기 — 잠금이 풀리면 끝까지
  J.rollbackAllInstall(j.id, { ack: true, by: 'admin' });
  assert.ok(await J._settleForTest());
  const after = J.installJob(j.id);
  assert.equal(after.status, 'rolledback', JSON.stringify(after.rollback));
  assert.equal(R.rollbackLaunches, 1);
  assert.equal(R.envs.filter((e) => /RUN_MODE='install'/.test(e) && /START_STEP='0'/.test(e)).length, 1, '0단계(초기화)는 처음 한 번만 돌았다');
});

test('C-1 ⓐ-2 첫 시작의 잠금 실패(아무 단계도 안 돈 작업)는 정상적으로 다시 할 수 있다 — 거부 범위를 넓히지 않았다', async () => {
  reset();
  const R = fake(); deps(R);
  assert.ok(L.claimSetup('dir_other', HOST_ADDR), '러너가 읽을 서버 주소(hostAddr)를 다른 작업이 쥔다 — 시작 검사는 SSH 주소만 보므로 작업은 만들어진다');
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: {}, by: 'admin' });
  assert.ok(await J._settleForTest());
  let j = J.installJob(j0.id);
  assert.equal(j.status, 'failed'); assert.equal(j.failure.cause.key, 'busy'); assert.equal(j.failure.step, null);
  L.releaseSetupLock('dir_other', HOST_ADDR);
  const r = await J.retryInstall(j0.id, { body: {}, by: 'admin' });
  assert.equal(r.attempts.at(-1).fromStep, 1);
  assert.ok(await J._settleForTest());
  j = J.installJob(j0.id);
  assert.equal(j.status, 'done', JSON.stringify(j.failure));
});

test('C-1 ⓑ 되돌리기 중 예외(접속 실패)도 rollback-failed — failed 로 적지 않는다', async () => {
  reset();
  const R = fake();
  const j = await doneJob(R);
  R.failSsh = () => new Error('connect ETIMEDOUT 10.0.0.1:22');
  const r = J.rollbackAllInstall(j.id, { ack: true, by: 'admin' });
  assert.equal(r.status, 'rolling-back');
  assert.ok(await J._settleForTest());
  const after = J.installJob(j.id);
  assert.equal(after.status, 'rollback-failed', JSON.stringify(after.failure));
  assert.equal(after.failure, null);
  assert.match(after.rollback.message, /ETIMEDOUT/);
  assert.equal(after.attempts.at(-1).result, 'rollback-failed');
});

test('C-1 ⓒ 중앙 재시작 뒤 되돌리기 이어 하기 — 러너를 다시 띄우지 않고 상태만 읽어 끝까지(포탈 등록 정리)', async () => {
  reset();
  const R = fake();
  const j = await doneJob(R);
  // 되돌리기 러너가 도는 중에 중앙이 재시작한 모양(기록 = rolling-back · 원격 유닛 = active)
  const file = path.join(tmp, 'bareos-install-jobs.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const x = rec.jobs.find((y) => y.id === j.id);
  x.status = 'rolling-back'; x.phase = 'remote'; x.rollback = { at: Date.now(), by: 'admin' };
  x.attempts.push({ n: x.attempts.length + 1, at: Date.now(), by: 'admin', fromStep: null, rollbackAll: true });
  fs.writeFileSync(file, JSON.stringify(rec));
  J._resetForTest();
  R.unitActive = true;
  let n = 0;
  R.readImpl = () => { n += 1; return n < 3 ? readOut('begin rollback-all 1\n3 ok 1', 'active') : readOut('begin rollback-all 1\n3 ok 1\nall rolledback 2', 'inactive'); };
  const launchesBefore = R.launches; const cmdsBefore = R.cmds.length;
  J.resumeInstallJobs();
  assert.ok(await J._settleForTest());
  const after = J.installJob(j.id);
  assert.equal(after.status, 'rolledback', `${after.status} ${JSON.stringify(after.failure || after.rollback)}`);
  assert.equal(R.launches, launchesBefore, '러너를 다시 띄우지 않았다');
  assert.ok(!R.cmds.slice(cmdsBefore).some((c) => c.startsWith('systemctl is-active portal-bareos-install') || c.includes('systemd-run')), '띄우기 전 검사 · 띄우기 명령을 보내지 않았다');
  assert.ok(R.cmds.slice(cmdsBefore).some((c) => c.includes('echo @@log')), '상태는 읽었다');
});

/* ───────── C-2 ───────── */

test('C-2 되돌리기 폴링이 SSH 인증 실패를 만나면 즉시 rollback-failed(ssh-auth) — 다시 로그인하지 않는다 · 다시 되돌리기는 고쳤음 필요', async () => {
  reset();
  const R = fake();
  const j = await doneJob(R);
  let authFails = 0; let sleeps = 0;
  R.failSsh = (r) => (r.rollbackLaunches > 0 ? (authFails += 1, authErr()) : null);
  // 예전 코드는 인증 실패를 삼키고 4시간 동안 다시 읽었다 — 시험이 끝나도록 40번째 대기에서 끊는다
  J._setDepsForTest({ ssh: R.ssh, sleep: async () => { sleeps += 1; if (sleeps > 40) throw new Error('시험 상한 — 인증 실패 뒤에도 계속 다시 읽음'); }, targets: () => [target()], creds: () => ({ host: SSH_HOST, port: 22, username: 'root', password: PASS }), pickBundle: async () => BUNDLE });
  J.rollbackAllInstall(j.id, { ack: true, by: 'admin' });
  assert.ok(await J._settleForTest());
  const after = J.installJob(j.id);
  assert.equal(authFails, 1, `인증 실패 뒤 다시 로그인하지 않는다(시도 ${authFails}회)`);
  assert.equal(after.status, 'rollback-failed');
  assert.equal(after.rollback.cause, 'ssh-auth');
  assert.ok(!JSON.stringify(after).includes(PASS));
  assert.throws(() => J.rollbackAllInstall(j.id, { ack: true, by: 'admin' }), (e) => e.code === 'invalid' && /고쳤음/.test(e.message));
  R.failSsh = null; deps(R);
  J.rollbackAllInstall(j.id, { ack: true, sshFixed: true, by: 'admin' });
  assert.ok(await J._settleForTest());
  assert.equal(J.installJob(j.id).status, 'rolledback');
});

test('C-2 그 밖의 읽기 오류는 대기를 늘려 가며 다시 읽는다(8초 고정 아님)', async () => {
  reset();
  const R = fake();
  const j = await doneJob(R);
  let errs = 0; const waits = [];
  R.failSsh = (r) => (r.rollbackLaunches > 0 && errs < 3 && r.sessions > 0 ? (errs += 1, new Error('read ECONNRESET')) : null);
  // 띄우기 세션은 통과시키고(rollbackLaunches 가 아직 0) 그 뒤 읽기 3번을 실패시킨다
  J._setDepsForTest({ ssh: R.ssh, sleep: async (ms) => { waits.push(ms); }, targets: () => [target()], creds: () => ({ host: SSH_HOST, port: 22, username: 'root', password: PASS }), pickBundle: async () => BUNDLE });
  J.rollbackAllInstall(j.id, { ack: true, by: 'admin' });
  assert.ok(await J._settleForTest());
  assert.equal(J.installJob(j.id).status, 'rolledback');
  assert.deepEqual(waits.slice(0, 4), [J.POLL_MS, J.POLL_MS * 2, J.POLL_MS * 4, 60_000]);
});

/* ───────── C-3 ───────── */

test('C-3 setupLocks 그룹 — Director 여럿 · 주소 여럿을 한 소유 키로 · 단건 API 는 그대로 막힌다', () => {
  L._resetForTest();
  assert.ok(L.claimSetupGroup('install:bi_x', { dirIds: ['dir_1', ''], hosts: [SSH_HOST, HOST_ADDR.toUpperCase()] }));
  assert.equal(L.isSetupBusy('dir_1'), true);
  assert.equal(L.claimSetup('dir_1', '10.9.9.9'), false, '자동 설정 · 법인별 설정 — 같은 Director');
  assert.equal(L.claimSetup('dir_2', HOST_ADDR), false, '다른 Director 라도 같은 서버 주소(hostAddr)');
  assert.equal(L.claimSetup('dir_2', SSH_HOST), false, '같은 SSH 주소');
  assert.ok(L.setupBusyReason('dir_2', HOST_ADDR)); assert.ok(L.setupBusyReason('dir_1'));
  assert.equal(L.claimSetupGroup('install:bi_y', { dirIds: ['dir_3'], hosts: [HOST_ADDR] }), false, '다른 설치도 같은 주소면 못 잡는다');
  assert.equal(L.isSetupBusy('dir_3'), false, '실패한 그룹 잡기는 아무것도 잡지 않는다');
  assert.ok(L.addSetupGroupDirector('install:bi_x', 'dir_new'));
  assert.equal(L.isSetupBusy('dir_new'), true);
  // 남이 단건으로 푸는 것은 그룹 주소를 지우지 않는다
  L.releaseSetupLock('dir_9', HOST_ADDR);
  assert.ok(L.setupBusyReason('dir_2', HOST_ADDR));
  L.releaseSetupGroup('install:bi_x');
  for (const d of ['dir_1', 'dir_new']) assert.equal(L.isSetupBusy(d), false);
  assert.equal(L.setupBusyReason('dir_2', HOST_ADDR), '');
  // 단건 API 는 예전 그대로
  assert.ok(L.claimSetup('dir_a', 'h1')); assert.equal(L.claimSetup('dir_b', 'H1'), false); L.releaseSetupLock('dir_a', 'h1'); assert.ok(L.claimSetup('dir_b', 'h1')); L.releaseSetupLock('dir_b', 'h1');
});

test('C-3 새 설치 — 4단계가 등록한 Director 와 서버 주소를 작업이 끝날 때까지 쥔다', async () => {
  reset();
  const R = fake(); const seen = [];
  deps(R, target(), {
    setupFdPlugin: async (b) => {
      seen.push({ dir: L.isSetupBusy(b.directorId), addr: !!L.setupBusyReason('dir_zz', HOST_ADDR), ssh: !!L.setupBusyReason('dir_zz', SSH_HOST), dirAuto: !!L.setupBusyReason(b.directorId, '10.9.9.9') });
      return { action: 'added', added: [] };
    },
  });
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: {}, by: 'admin' });
  assert.ok(await J._settleForTest());
  const j = J.installJob(j0.id);
  assert.equal(j.status, 'done', JSON.stringify(j.failure));
  assert.deepEqual(seen, [{ dir: true, addr: true, ssh: true, dirAuto: true }], '5단계 도중: 새 Director · 서버 주소 · SSH 주소 모두 잡혀 있다');
  assert.equal(L.isSetupBusy(j.directorId), false, '끝나면 푼다');
  assert.equal(L.setupBusyReason('dir_zz', HOST_ADDR), '');
});

test('C-3 재설치 — 원격 단계 동안 기존 Director 를 쥔다(Director 저장 · 삭제 · 자동 설정이 409)', async () => {
  reset();
  const R = fake(); const { d, t } = existingDirTarget();
  const seen = [];
  R.readImpl = (r, rd) => { seen.push({ dir: L.isSetupBusy(d.id), addr: !!L.setupBusyReason('dir_zz', HOST_ADDR) }); return defaultRead(r, rd); };
  deps(R, t);
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: REINSTALL_BODY, by: 'admin' });
  assert.ok(await J._settleForTest());
  assert.equal(J.installJob(j0.id).status, 'done');
  assert.ok(seen.length > 0);
  assert.ok(seen.every((x) => x.dir && x.addr), JSON.stringify(seen));
  assert.equal(L.isSetupBusy(d.id), false);
});

/* ───────── D-4 · D-7 ───────── */

test('D-4 재설치(기존 Director) 작업도 그 Director 에 백업 대상이 있으면 전부 되돌리기를 거부', async () => {
  reset();
  const R = fake(); const { d, t } = existingDirTarget();
  const j = await doneJob(R, t, REINSTALL_BODY);
  assert.equal(j.existingDirector, true); assert.equal(j.createdDirector, false); assert.equal(j.directorId, d.id);
  fs.writeFileSync(path.join(tmp, 'bareos-jobs.json'), JSON.stringify({ jobs: [{ id: 'bj1', directorId: d.id, vcenterId: 'vc1', vmName: 'vm1', bareosJob: 'portal-vm1' }], retired: [] }));
  resetRegistry();
  assert.throws(() => J.rollbackAllInstall(j.id, { ack: true, by: 'admin' }), (e) => e.code === 'conflict' && /재설치의 Director/.test(e.message) && /1개/.test(e.message));
  assert.equal(J.installJob(j.id).status, 'done', '상태를 바꾸지 않았다');
  assert.equal(R.rollbackLaunches, 0);
});

test('D-7 백업 대상 원장을 못 읽으면 전부 되돌리기를 거부(대상 0 으로 보지 않음 · 503)', async () => {
  reset();
  const R = fake();
  const j = await doneJob(R);
  fs.writeFileSync(path.join(tmp, 'bareos-jobs.json'), '{ 손상');
  resetRegistry();
  assert.throws(() => J.rollbackAllInstall(j.id, { ack: true, by: 'admin' }), (e) => e.code === 'unavailable' && /원장/.test(e.message));
  assert.equal(J.installJob(j.id).status, 'done');
  const route = fs.readFileSync(path.join(HERE, '../src/routes/api/bareosInstall.js'), 'utf8');
  assert.match(route, /code === 'unavailable' \? 503/, '라우트는 unavailable 을 503 으로');
});

/* ───────── D-2 (중앙 · planEnv) ───────── */

test('D-2 planEnv — RUNNING_UNKNOWN_OK 는 재설치 + 불리언 true 일 때만 1', () => {
  const plan = PL.normPlan({ reset: { ack: true } }, { contents, mode: 'reinstall', corpName: '법인1' });
  const base = { jobId: 'bi_abcdef01', bundle: { version: V, sha256: SHA }, install: ['bareos'], plan, startStep: 0, hostAddr: HOST_ADDR };
  assert.match(PL.planEnv({ ...base, runningUnknownOk: true }), /^RUNNING_UNKNOWN_OK='1'$/m);
  assert.match(PL.planEnv({ ...base, runningUnknownOk: 'true' }), /^RUNNING_UNKNOWN_OK='0'$/m);
  assert.match(PL.planEnv(base), /^RUNNING_UNKNOWN_OK='0'$/m);
  const inst = PL.normPlan({}, { contents, mode: 'install' });
  assert.match(PL.planEnv({ ...base, plan: inst, startStep: 1, runningUnknownOk: true }), /^RUNNING_UNKNOWN_OK='0'$/m, '새 설치에는 0단계가 없다');
});

test('D-2 동의는 그 회차에만 — 시작 동의 · 0단계 running-unknown 실패 → 동의 다시 하기는 1 · 동의 없는 다시 하기는 0', async () => {
  reset();
  const R = fake(); const { t } = existingDirTarget();
  let stop0 = true;
  R.readImpl = (r, rd) => {
    const env = r.writes.get(`${rd}/plan.env`) || '';
    if (stop0 && /START_STEP='0'/.test(env)) return readOut('begin install 1\n0 start 1\n0 fail 2', 'inactive', { [`${rd}/err.0`]: 'cmd=실행 중 작업 확인\ncode=1\ncause=running-unknown\n---\nDirector 는 켜져 있는데 bconsole 로 실행 중 작업을 확인하지 못했습니다' });
    return defaultRead(r, rd);
  };
  deps(R, t);
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: { ...REINSTALL_BODY, runningUnknownOk: true }, by: 'admin' });
  assert.ok(await J._settleForTest());
  assert.match(R.envs.at(-1), /^RUNNING_UNKNOWN_OK='1'$/m, '시작 화면의 동의 → 첫 회차');
  let j = J.installJob(j0.id);
  assert.equal(j.status, 'failed'); assert.equal(j.failure.step, 0); assert.equal(j.failure.cause.key, 'running-unknown');
  assert.ok(j.failure.cause.fixes.some((f) => f.kind === 'portal' && f.action === 'running-unknown-ok'));
  assert.ok(!j.failure.cause.fixes.some((f) => f.kind === 'retry'), "그대로 다시는 또 멈추므로 두지 않는다");
  await J.retryInstall(j0.id, { body: {}, by: 'admin' });
  assert.ok(await J._settleForTest());
  assert.match(R.envs.at(-1), /^RUNNING_UNKNOWN_OK='0'$/m, '동의는 다시 하기로 이어지지 않는다');
  stop0 = false;
  await J.retryInstall(j0.id, { body: { fix: 'running-unknown-ok' }, by: 'admin' });
  assert.ok(await J._settleForTest());
  assert.match(R.envs.at(-1), /^RUNNING_UNKNOWN_OK='1'$/m);
  assert.match(R.envs.at(-1), /^START_STEP='0'$/m);
  j = J.installJob(j0.id);
  assert.equal(j.status, 'done', JSON.stringify(j.failure));
  assert.equal(j.attempts.at(-1).runningUnknownOk, true);
});

/* ───────── D-2 (러너 — 실제 bash) ───────── */

const RUNNER = path.join(HERE, '../src/bareos/install/runner.sh');
const BV = '25.20261101.4';
const SHIMS = {
  dnf: `#!/bin/bash
op=""; pk=()
for a in "$@"; do case "$a" in (install|remove) op="$a";; (-*) ;; (*) pk+=("$a");; esac; done
if [ "$op" = install ]; then
  for p in "\${pk[@]}"; do grep -qx "$p" "$FAKE/rpmdb" 2>/dev/null || echo "$p" >> "$FAKE/rpmdb"; done
  mkdir -p "$P/etc/bareos/bareos-sd.d/director" "$P/etc/bareos/bareos-sd.d/device" "$P/etc/bareos/bareos-dir.d/storage" "$P/etc/bareos/bareos-dir.d/director" "$P/etc/bareos/bareos-fd.d/client"
  [ -f "$P/etc/bareos/bareos-sd.d/director/bareos-dir.conf" ] || printf 'Director {\\n  Name = bareos-dir\\n  Password = "sd-secret-pw"\\n}\\n' > "$P/etc/bareos/bareos-sd.d/director/bareos-dir.conf"
  printf 'Director {\\n  Name = bareos-dir\\n}\\n' > "$P/etc/bareos/bareos-dir.d/director/bareos-dir.conf"
  touch "$FAKE/bareos_user"; echo Complete!; exit 0
fi
if [ "$op" = remove ]; then
  for p in "\${pk[@]}"; do grep -vx "$p" "$FAKE/rpmdb" > "$FAKE/rpmdb.t" 2>/dev/null; mv "$FAKE/rpmdb.t" "$FAKE/rpmdb"; done
  echo removed; exit 0
fi
exit 0`,
  rpm: '#!/bin/bash\nif [ "$1" = -q ]; then rc=0; for a in "$@"; do case "$a" in (-*) ;; (*) grep -qx "$a" "$FAKE/rpmdb" 2>/dev/null || rc=1;; esac; done; exit $rc; fi\ncat "$FAKE/rpmdb" 2>/dev/null; exit 0',
  systemctl: `#!/bin/bash
q=0; args=()
for a in "$@"; do case "$a" in (-q|--quiet|--now) [ "$a" = --now ] && now=1 || q=1;; (*) args+=("$a");; esac; done
cmd="\${args[0]}"; u="\${args[1]:-}"; u="\${u%.service}"; d="$FAKE/svc"; mkdir -p "$d"
case "$cmd" in
  is-enabled) [ -f "$d/$u.en" ] ;;
  is-active) if [ -f "$d/$u.act" ]; then [ $q = 1 ] || echo active; exit 0; else [ $q = 1 ] || echo inactive; exit 3; fi ;;
  enable) touch "$d/$u.en"; [ "\${now:-0}" = 1 ] && touch "$d/$u.act"; exit 0 ;;
  disable) rm -f "$d/$u.en"; [ "\${now:-0}" = 1 ] && rm -f "$d/$u.act"; exit 0 ;;
  start|restart|reload) touch "$d/$u.act"; exit 0 ;;
  stop) rm -f "$d/$u.act"; exit 0 ;;
  list-unit-files) exit 0 ;;
esac
exit 0`,
  su: `#!/bin/bash
c="\${@: -1}"
case "$c" in
  *"datname='bareos'"*) [ -f "$FAKE/pgdb" ] && echo 1; exit 0 ;;
  *create_bareos_database*) touch "$FAKE/pgdb"; exit 0 ;;
  *"dropdb"*) rm -f "$FAKE/pgdb"; exit 0 ;;
  *) exit 0 ;;
esac`,
  'postgresql-setup': '#!/bin/bash\nmkdir -p "$P/var/lib/pgsql/data"; echo 13 > "$P/var/lib/pgsql/data/PG_VERSION"; exit 0',
  runuser: '#!/bin/bash\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
  id: '#!/bin/bash\nif [ "$1" = -u ] && [ "${2:-}" = bareos ]; then [ -f "$FAKE/bareos_user" ] && { echo 990; exit 0; }; exit 1; fi\nexec /usr/bin/id "$@"',
  install: '#!/bin/bash\na=(); while [ $# -gt 0 ]; do case "$1" in (-o|-g) shift 2;; (*) a+=("$1"); shift;; esac; done\nexec /usr/bin/install "${a[@]}"',
  python3: `#!/bin/bash
all="$*"
case "$all" in
  *platlibdir*) echo /usr/lib64/bareos/plugins; exit 0 ;;
  *"-m pip install"*) v="\${all##*pyvmomi==}"; echo "$v" > "$FAKE/pyvmomi"; echo "Successfully installed pyvmomi-$v"; exit 0 ;;
  *"-m pip uninstall"*) rm -f "$FAKE/pyvmomi"; exit 0 ;;
  *"import pyVmomi"*) cat "$FAKE/pyvmomi" 2>/dev/null || { echo "ModuleNotFoundError"; exit 1; }; exit 0 ;;
  *'version("pyvmomi")'*) [ -f "$FAKE/pyvmomi" ] && cat "$FAKE/pyvmomi" && exit 0; exit 1 ;;
esac
exit 0`,
  'bareos-sd': '#!/bin/bash\nexit 0', 'bareos-dir': '#!/bin/bash\nexit 0', 'bareos-fd': '#!/bin/bash\nexit 0',
  ss: '#!/bin/bash\nprintf "State Recv-Q Send-Q Local Peer\\nLISTEN 0 50 *:9101 *:*\\nLISTEN 0 50 *:9102 *:*\\nLISTEN 0 50 *:9103 *:*\\nLISTEN 0 50 *:80 *:*\\n"',
  getenforce: '#!/bin/bash\necho Disabled', curl: '#!/bin/bash\necho -n 200', 'firewall-cmd': '#!/bin/bash\nexit 0',
  semanage: '#!/bin/bash\nexit 0', restorecon: '#!/bin/bash\nexit 0', setsebool: '#!/bin/bash\nexit 0', getsebool: '#!/bin/bash\necho "httpd_can_network_connect --> off"',
};
const BCONSOLE = {
  authFail: '#!/bin/bash\ncat >/dev/null; echo "Connecting to Director localhost:9101"; echo "Director authorization problem."; echo "Most likely the passwords do not agree."; exit 1',
  noBanner: '#!/bin/bash\ncat >/dev/null; echo "bareos-dir Version: 25.1.2~pre73 (01 Nov 2026)"; exit 0',
  zero: '#!/bin/bash\ncat >/dev/null; echo "Connecting to Director localhost:9101"; echo "1000 OK: bareos-dir Version: 25.1.2"; echo "You have messages."; exit 0',
  two: '#!/bin/bash\ncat >/dev/null; echo "Connecting to Director localhost:9101"; echo "1000 OK: bareos-dir"; echo "           jobid: 12"; echo "             job: portal-vm1"; echo "           jobid: 13"; exit 0',
};

/** 재설치 전 서버 — 옛 bareos 패키지 · /etc/bareos · 카탈로그 DB · (켜진) Director. */
function runnerEnv({ bconsole = 'authFail', dirActive = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bi2846r-'));
  const P = path.join(base, 'root'); const FAKE = path.join(base, 'fake'); const BIN = path.join(base, 'bin');
  for (const d of [P, FAKE, BIN]) fs.mkdirSync(d, { recursive: true });
  for (const [n, s] of Object.entries(SHIMS)) fs.writeFileSync(path.join(BIN, n), s, { mode: 0o755 });
  if (bconsole) fs.writeFileSync(path.join(BIN, 'bconsole'), BCONSOLE[bconsole], { mode: 0o755 });
  fs.writeFileSync(path.join(FAKE, 'rpmdb'), ['glibc', 'python3', 'bareos-director', 'bareos-storage'].join('\n') + '\n');
  fs.mkdirSync(path.join(FAKE, 'svc'), { recursive: true });
  if (dirActive) for (const u of ['bareos-dir', 'bareos-sd', 'bareos-fd']) fs.writeFileSync(path.join(FAKE, 'svc', `${u}.act`), '');
  fs.mkdirSync(path.join(P, 'etc/bareos/bareos-dir.d'), { recursive: true });
  fs.writeFileSync(path.join(P, 'etc/bareos/bareos-dir.d/keep.conf'), 'x');
  fs.mkdirSync(path.join(P, 'var/lib/pgsql/data'), { recursive: true }); fs.writeFileSync(path.join(P, 'var/lib/pgsql/data/PG_VERSION'), '13');
  fs.writeFileSync(path.join(FAKE, 'pgdb'), '');
  const W = path.join(P, 'var/lib/portal-bareos-install');
  const src = path.join(base, 'bsrc/bareos-bundle');
  for (const d of ['rpms/repodata', 'wheels', 'keys']) fs.mkdirSync(path.join(src, d), { recursive: true });
  fs.writeFileSync(path.join(src, 'keys/RPM-GPG-KEY-bareos-x'), 'key');
  fs.writeFileSync(path.join(src, 'wheels/pyvmomi-8.0.3.0.1-py3-none-any.whl'), 'w');
  fs.mkdirSync(path.join(W, 'bundles'), { recursive: true }); fs.mkdirSync(path.join(W, 'run'), { recursive: true });
  const tarP = path.join(W, 'bundles', `bareos-bundle-${BV}.tar.gz`);
  assert.equal(spawnSync('tar', ['czf', tarP, '-C', path.dirname(src), 'bareos-bundle']).status, 0);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(tarP)).digest('hex');
  return { base, P, FAKE, BIN, W, R: path.join(W, 'run'), sha };
}
function writePlan(e, o = {}) {
  const v = { JOB_ID: 'bi_test01', RUN_MODE: 'install', START_STEP: '0', BV, TAR_SHA256: e.sha, INSTALL_PKGS: 'bareos bareos-webui postgresql-server', PYVMOMI: '8.0.3.0.1', PYVMOMI_FIX: '0',
    VOLUME_DIR: '/var/lib/bareos/storage', HOST_ADDR: HOST_ADDR, SD_DEVICE: 'PortalFileStorage', SD_MEDIA: 'PortalFile', DIR_STORAGE: 'PortalFile', SD_COUNT: '10', WEBUI: '1',
    RESET: '1', RESET_DB: '1', RESET_VOLUMES: '0', RESET_VOLUME_DIRS: '', ...o };
  fs.writeFileSync(path.join(e.R, 'plan.env'), Object.entries(v).map(([k, x]) => `${k}='${x}'`).join('\n') + '\n');
}
function runRunner(e) {
  const r = spawnSync('bash', [RUNNER], { env: { ...process.env, PATH: `${e.BIN}:${process.env.PATH}`, PORTAL_TEST_ROOT: e.P, P: e.P, FAKE: e.FAKE, WAIT_PORT_SEC: '2' }, encoding: 'utf8', timeout: 60_000 });
  const read = (f) => (fs.existsSync(path.join(e.R, f)) ? fs.readFileSync(path.join(e.R, f), 'utf8') : '');
  return { ...r, state: read('state'), log: read('run.log'), err0: read('err.0') };
}
const has = (st, n, s) => new RegExp(`^${n} ${s} `, 'm').test(st);
/** 0단계가 아무것도 지우지 않았나. */
function untouched(e) {
  return fs.existsSync(path.join(e.FAKE, 'svc', 'bareos-dir.act')) && fs.existsSync(path.join(e.FAKE, 'pgdb')) && fs.existsSync(path.join(e.P, 'etc/bareos/bareos-dir.d/keep.conf'))
    && fs.readFileSync(path.join(e.FAKE, 'rpmdb'), 'utf8').includes('bareos-director');
}

test('D-2 러너(실제 bash) — Director 켜짐 + bconsole 인증 실패면 실행 중 작업을 0 으로 보지 않고 멈춘다(아무것도 지우지 않음)', () => {
  const e = runnerEnv({ bconsole: 'authFail' }); writePlan(e);
  const r = runRunner(e);
  assert.notEqual(r.status, 0);
  assert.ok(has(r.state, 0, 'fail'), r.state + r.log);
  assert.ok(!has(r.state, 1, 'start'), '1단계로 가지 않는다');
  assert.ok(untouched(e), 'Director · 카탈로그 DB · /etc/bareos · 패키지가 그대로');
  const err = parseErrFile(r.err0);
  assert.equal(err.cause, 'running-unknown');
  const c = classifyFailure({ step: 0, ...err });
  assert.equal(c.key, 'running-unknown');
  assert.ok(c.fixes.some((f) => f.action === 'running-unknown-ok'));
  fs.rmSync(e.base, { recursive: true, force: true });
});

test('D-2 러너 — bconsole 이 없거나 접속 문구가 없어도 확인 불가(멈춤)', () => {
  for (const b of [null, 'noBanner']) {
    const e = runnerEnv({ bconsole: b }); writePlan(e);
    const r = runRunner(e);
    assert.ok(has(r.state, 0, 'fail'), `${b}: ${r.state}${r.log}`);
    assert.equal(parseErrFile(r.err0).cause, 'running-unknown', String(b));
    assert.ok(untouched(e), String(b));
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});

test('D-2 러너 — 화면 동의(RUNNING_UNKNOWN_OK=1)가 있으면 그 회차는 진행', () => {
  const e = runnerEnv({ bconsole: 'authFail' }); writePlan(e, { RUNNING_UNKNOWN_OK: '1' });
  const r = runRunner(e);
  assert.ok(has(r.state, 0, 'ok'), r.state + r.log);
  assert.match(r.log, /동의로 진행/);
  assert.ok(!fs.existsSync(path.join(e.FAKE, 'svc', 'bareos-dir.act')) || has(r.state, 3, 'ok'), '초기화가 돌았다');
  fs.rmSync(e.base, { recursive: true, force: true });
});

test('D-2 러너 — 접속이 확인된 0개는 진행 · 실행 중 2개는 멈춤 · Director 꺼짐은 진행(실행 중 작업 없음)', () => {
  let e = runnerEnv({ bconsole: 'zero' }); writePlan(e);
  let r = runRunner(e);
  assert.ok(has(r.state, 0, 'ok'), r.state + r.log); assert.match(r.log, /0개\(bconsole 접속 확인\)/);
  fs.rmSync(e.base, { recursive: true, force: true });
  e = runnerEnv({ bconsole: 'two' }); writePlan(e);
  r = runRunner(e);
  assert.ok(has(r.state, 0, 'fail'), r.state + r.log);
  const err = parseErrFile(r.err0);
  assert.equal(err.cause, 'running-jobs'); assert.match(err.output, /2개/);
  assert.ok(untouched(e));
  fs.rmSync(e.base, { recursive: true, force: true });
  e = runnerEnv({ bconsole: 'authFail', dirActive: false }); writePlan(e);
  r = runRunner(e);
  assert.ok(has(r.state, 0, 'ok'), `Director 꺼짐 — 0단계가 스스로 끈 뒤의 다시 하기도 이 경로: ${r.state}${r.log}`);
  assert.match(r.log, /Director 꺼짐/);
  fs.rmSync(e.base, { recursive: true, force: true });
});

test('D-2 사전 점검 @@running(실제 bash) — 러너와 같은 판정 · 확인 불가 조치 문구는 화면 동의와 같은 글자', () => {
  const line = PC.precheckScript().split('\n').find((l) => l.startsWith('echo @@running'));
  const run = (o) => {
    const e = runnerEnv(o);
    const out = spawnSync('bash', ['-c', line], { env: { ...process.env, PATH: `${e.BIN}:${process.env.PATH}`, FAKE: e.FAKE }, encoding: 'utf8' }).stdout;
    fs.rmSync(e.base, { recursive: true, force: true });
    return out.split('\n')[1];
  };
  assert.equal(run({ bconsole: 'authFail' }), 'none');
  assert.equal(run({ bconsole: 'noBanner' }), 'none');
  assert.equal(run({ bconsole: 'zero' }), '0');
  assert.equal(run({ bconsole: 'two' }), '2');
  assert.equal(run({ bconsole: 'authFail', dirActive: false }), 'inactive');
  const PRE2 = (running) => PRE.replace('@@running\nnone', `@@running\n${running}`).replace('@@pkgs', '@@pkgs\nbareos-director 22.1.2');
  const item = (r) => r.items.find((i) => i.key === 'running');
  const off = PC.judgePrecheck(PC.parsePrecheck(PRE2('inactive')), { mode: 'reinstall', bundle: contents });
  assert.equal(item(off).status, 'ok'); assert.match(item(off).detail, /Director 꺼짐/);
  const unk = PC.judgePrecheck(PC.parsePrecheck(PRE2('none')), { mode: 'reinstall', bundle: contents });
  assert.equal(item(unk).status, 'unknown'); assert.equal(unk.blocked, false, '막지는 않는다(러너가 멈추고 화면이 동의를 받는다)');
  assert.ok(item(unk).action.includes(PC.RUNNING_UNKNOWN_OK_LABEL));
  const web = fs.readFileSync(path.join(HERE, '../../web/src/views/tools/bareosInstallText.js'), 'utf8');
  assert.ok(web.includes(`RUNNING_UNKNOWN_OK_LABEL = '${PC.RUNNING_UNKNOWN_OK_LABEL}'`), '화면 동의 문구와 같은 글자');
});
