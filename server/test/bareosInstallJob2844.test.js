/**
 * test/bareosInstallJob2844.test.js — v2.844 완전 설치 **중앙 흐름**(install/job.js)을 가짜 SSH 로 끝까지 돌린다.
 *  ① 성공: 사전 점검(시작 직전) → 번들 업로드(sha 대조) → 러너 시작 → 상태 읽기 → 4 Director 등록(담당 = 엣지 · 주소 = 서버가 읽은 주소) → 5 → 6 엣지 경유 probe → 7 매핑
 *     · 작업 기록에 비밀번호가 없다 · plan.env 에 비밀이 없다
 *  ② 2단계 실패: 원인 판정(dnf-conflict) · 출력의 비밀 줄 빼기 · 그 단계부터 다시(2회차 · START_STEP=2) → 완료
 *  ③ 같은 법인 동시 시작 409 · ④ SSH 인증 실패는 '고쳤음' 없이 다시 하지 않는다 · ⑤ 전부 되돌리기: 이 작업이 만든 매핑·Director 등록 삭제 + 러너 rollback-all
 *  ⑥ 상태 읽기는 **실제 bash 로 readCmd 를 돌린 출력**을 parseRead 로(반증 H1 — 가짜 출력이 err 파일 없는 모양을 흉내 내지 못해 놓쳤다)
 *  ⑦ 반증 고친 것: 앞 회차 'all done' 무시(begin) · 더 새 작업이 있으면 다시·되돌리기 거부 · 배포 등록부 주소가 바뀌면 거부 · 업로드 중 중단이면 러너를 띄우지 않음
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi2844j-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';

const J = await import('../src/bareos/install/job.js');
const { normContents } = await import('../src/bareos/install/bundleDoc.js');
const { loadSettings, _resetForTest: resetSettings } = await import('../src/bareos/settings.js');

const PASS = 'S3cret-pass!x';
const SHA = 'a'.repeat(64);
const V = '25.20261101.4';
const contents = normContents({ format: 'portal-bareos-bundle', v: 1, version: V, el: '9', arch: 'x86_64', bareosVersion: '25.1.2', postgresqlVersion: '13.23', install: ['bareos', 'postgresql-server'], packages: [], keys: ['K'], pyvmomi: { versions: ['8.0.3.0.1'], default: '8.0.3.0.1' } }, V).contents;
const tarPath = path.join(tmp, 'b.tar.gz'); fs.writeFileSync(tarPath, 'x');
const BUNDLE = { ok: true, version: V, sha256: SHA, size: 1, tarPath, contents };
const target = (o = {}) => ({ vcenterId: 'vc1', vcenterName: '법인1', vcHost: 'vc1.corp', agent: 'edge1', targetId: 't1', sshHost: '10.0.0.1', sshPort: 22, sshUser: 'root', hasPassword: true, director: null, mode: 'install', can: true, why: '', ...o });

const PRE = ['@@id', '0', '@@os', 'ID=rocky', 'VERSION_ID=9.4', 'PRETTY=Rocky 9.4', 'ARCH=x86_64', '@@tools', 'systemd-run=1', 'dnf=1', 'rpm=1', 'ss=1', '@@selinux', 'Enforcing', '@@pkgs', '@@etc', 'none',
  '@@svc', '@@ports', '@@python', '3.9.18', '@@pyvmomi', 'none', '@@bpp', '@@disk', 'PATH=/var/lib', 'AVAIL_KB=900000000', 'SIZE_KB=1800000000', 'MOUNT=/', 'EXISTS=0', '@@varlib', '900000000',
  '@@clock', '0.000120 seconds fast of NTP time', '@@addr', '10.20.0.14', 'edge1.corp', '@@runner', 'inactive', '@@running', 'none', '@@catalog', 'none', '@@volumes', '@@end'].join('\n');

/** 가짜 엣지 노드. scenario: 'ok' | 'fail2' | 'auth' */
function fakeRemote() {
  const R = { scenario: 'ok', writes: new Map(), runs: 0, puts: 0, cmds: [], rollbackRuns: 0, stateLog: new Map() };
  R.root = fs.mkdtempSync(path.join(tmp, 'remote-'));
  R.bin = path.join(R.root, 'bin'); fs.mkdirSync(R.bin);
  fs.writeFileSync(path.join(R.bin, 'systemctl'), '#!/bin/bash\necho inactive\n', { mode: 0o755 });
  R.ssh = async (creds, fn) => {
    if (R.scenario === 'auth' && R.runs > 0) throw Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' });
    const api = {
      exec: async (cmd) => {
        R.cmds.push(cmd);
        if (cmd.includes('echo @@id')) return { code: 0, stdout: PRE };
        if (cmd === 'id -u') return { code: 0, stdout: '0\n' };
        if (cmd.startsWith('systemctl is-active portal-bareos-install')) return { code: 0, stdout: 'inactive\n' };
        if (cmd.includes('.part | cut')) return { code: 0, stdout: `${SHA}\n` };
        if (cmd.includes('sha256sum')) return { code: 0, stdout: '' };
        if (cmd.includes('systemd-run')) {
          R.runs += 1;
          const rd = /\/bin\/bash (\S+)\/runner\.sh (\S+)/.exec(cmd);
          assert.ok(rd && rd[1] === rd[2], '러너에 자기 실행 디렉터리를 인자로 준다');
          assert.match(cmd, /RuntimeMaxSec=\d+/);
          if (/RUN_MODE='rollback-all'/.test(R.writes.get(`${rd[1]}/plan.env`) || '')) R.rollbackRuns += 1;
          return { code: 0, stdout: '' };
        }
        if (cmd.includes('echo @@log')) {
          // 원격 실행 디렉터리를 임시 폴더로 바꿔 **실제 bash** 로 돌린다(systemctl 은 대역 — inactive)
          const rd = /cat (\S+)\/state/.exec(cmd)[1];
          const env = R.writes.get(`${rd}/plan.env`) || '';
          const local = path.join(R.root, rd);
          fs.mkdirSync(local, { recursive: true });
          for (const f of fs.readdirSync(local)) fs.rmSync(path.join(local, f));
          const prev = R.stateLog.get(rd) || '';
          let state; let log = 'ok\n';
          if (/RUN_MODE='rollback-all'/.test(env)) state = `${prev}begin rollback-all 1\n3 ok 1\nall rolledback 2\n`;
          else if (R.scenario === 'fail2') {
            state = `${prev}begin install 1\n1 start 1\n1 ok 2\n2 start 3\n2 fail 4\n2 rolledback 5\n`; log = `l1\nsecret ${PASS} here\n`;
            fs.writeFileSync(path.join(local, 'err.2'), `cmd=dnf install(번들 저장소만)\ncode=1\ncause=\n---\n Problem: conflicting requests\n token ${PASS}\n SDPassword = "sd-pw-xyz"\n`);
          } else {
            const start = Number(/START_STEP='(\d)'/.exec(env)?.[1] || 1);
            const lines = []; for (let n = start; n <= 3; n++) lines.push(`${n} start ${n}`, `${n} ok ${n}`);
            state = `${prev}begin install 1\n${lines.join('\n')}\nall done 9\n`;
          }
          R.stateLog.set(rd, state);
          fs.writeFileSync(path.join(local, 'state'), state); fs.writeFileSync(path.join(local, 'run.log'), log);
          const out = spawnSync('bash', ['-c', cmd.split(rd).join(local)], { encoding: 'utf8', env: { ...process.env, PATH: `${R.bin}:${process.env.PATH}` } });
          return { code: 0, stdout: out.stdout };
        }
        return { code: 0, stdout: '' };
      },
      writeFile: async (p, c) => { R.writes.set(p, String(c)); },
      putFile: async (local, remote, o) => { R.puts += 1; o?.onProgress?.(1, 1); },
    };
    return { ok: true, ...(await fn(api)) };
  };
  return R;
}

function deps(R, t = target(), extra = {}) {
  const calls = { director: [], fd: [], probe: [] };
  J._setDepsForTest({
    ssh: R.ssh, sleep: async () => {}, targets: () => [t], creds: () => ({ host: '10.0.0.1', port: 22, username: 'root', password: PASS }), pickBundle: async () => BUNDLE,
    setupDirector: async (body, ctx) => {
      calls.director.push({ body, ctx });
      assert.equal(body.password, PASS); assert.equal(typeof ctx.verifyConsole, 'function');
      ctx.save({ consoleName: body.consoleName, password: 'p'.repeat(32) });
      return { files: [{}, {}, {}] };
    },
    setupFdPlugin: async (b) => { calls.fd.push(b); return { action: 'added', added: ['Plugin Names'] }; },
    onDirector: async (id, kind) => { calls.probe.push([id, kind]); return { version: '25.1.2' }; },
    ...extra,
  });
  return calls;
}
function reset() { J._resetForTest(); resetSettings(); for (const f of fs.readdirSync(tmp)) if (f.endsWith('.json')) fs.rmSync(path.join(tmp, f)); }

test('① 성공 — 업로드 → 러너 → 4~7단계 · 담당 = 엣지 · 비밀 없음', async () => {
  reset();
  const R = fakeRemote(); const calls = deps(R);
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: {}, by: 'admin' });
  assert.equal(j0.status, 'running');
  assert.ok(await J._settleForTest());
  const j = J.installJob(j0.id);
  assert.equal(j.status, 'done', JSON.stringify(j.failure));
  for (const n of [1, 2, 3, 4, 5, 6, 7]) assert.equal(j.steps[n].status, 'ok', `${n}단계`);
  assert.equal(R.puts, 1, '번들은 한 번 올린다');
  assert.equal(calls.probe[0][1], 'probe');
  const s = loadSettings();
  const d = s.directors.find((x) => x.id === j.directorId);
  assert.ok(d); assert.equal(d.agent, 'edge1'); assert.equal(d.host, '10.20.0.14', 'Director 주소 = 서버가 읽은 주소(엣지가 붙는 곳)');
  assert.equal(j.createdDirector, true); assert.equal(j.createdSite, true);
  const site = s.sites.find((x) => x.vcenterId === 'vc1');
  assert.equal(site.storage, 'PortalFile'); assert.equal(site.client, 'bareos-fd'); assert.match(site.configFile, /^\/etc\/bareos\/vmware\/.*\.ini$/);
  const env = R.writes.get(`/var/lib/portal-bareos-install/run/${j0.id}/plan.env`);
  assert.ok(!env.includes(PASS)); assert.match(env, /^HOST_ADDR='10\.20\.0\.14'$/m); assert.match(env, new RegExp(`^JOB_ID='${j0.id}'$`, 'm'));
  const rec = fs.readFileSync(path.join(tmp, 'bareos-install-jobs.json'), 'utf8');
  assert.ok(!rec.includes(PASS) && !rec.includes('p'.repeat(32)), '작업 기록에 비밀이 없다');
});

test('② 2단계 실패 → 원인 · 비밀 줄 빼기 · 그 단계부터 다시 → 완료', async () => {
  reset();
  const R = fakeRemote(); R.scenario = 'fail2'; deps(R);
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: {}, by: 'admin' });
  assert.ok(await J._settleForTest());
  let j = J.installJob(j0.id);
  assert.equal(j.status, 'failed'); assert.equal(j.failure.step, 2);
  assert.equal(j.failure.cause.key, 'dnf-conflict'); assert.equal(j.failure.rolledBack, true);
  assert.ok(!JSON.stringify(j).includes(PASS), '출력·로그의 비밀 줄은 뺀다');
  assert.ok(!JSON.stringify(j).includes('sd-pw-xyz'), 'Password = 값은 가린다(반증 L4)');
  R.scenario = 'ok';
  await J.retryInstall(j0.id, { body: {}, by: 'admin' });
  assert.ok(await J._settleForTest());
  j = J.installJob(j0.id);
  assert.equal(j.status, 'done', JSON.stringify(j.failure));
  assert.equal(j.attempts.length, 2); assert.equal(j.attempts[1].fromStep, 2);
  assert.match(R.writes.get(`/var/lib/portal-bareos-install/run/${j0.id}/plan.env`), /^START_STEP='2'$/m);
  assert.equal(j.steps[4].status, 'ok', '앞 회차의 all done 이 남아 있어도 이번 회차가 끝난 뒤에야 4단계로(begin)');
});

test('③ 같은 법인 동시 시작은 409', async () => {
  reset();
  const R = fakeRemote(); deps(R, target(), { sleep: () => new Promise((r) => setTimeout(r, 30)) });
  await J.startInstall({ vcenterId: 'vc1', body: {}, by: 'admin' });
  await assert.rejects(() => J.startInstall({ vcenterId: 'vc1', body: {}, by: 'admin' }), (e) => e.code === 'conflict');
  await J._settleForTest();
});

test('④ SSH 인증 실패는 자동 재시도하지 않고 \'고쳤음\' 이 있어야 다시', async () => {
  reset();
  const R = fakeRemote(); R.scenario = 'auth'; deps(R);
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: {}, by: 'admin' });
  assert.ok(await J._settleForTest());
  const j = J.installJob(j0.id);
  assert.equal(j.status, 'failed'); assert.equal(j.failure.cause.key, 'ssh-auth');
  await assert.rejects(() => J.retryInstall(j0.id, { body: {}, by: 'admin' }), /고쳤음/);
});

test('⑤ 전부 되돌리기 — 이 작업이 만든 매핑·Director 등록 삭제 + 러너 rollback-all', async () => {
  reset();
  const R = fakeRemote(); deps(R);
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: {}, by: 'admin' });
  assert.ok(await J._settleForTest());
  assert.throws(() => J.rollbackAllInstall(j0.id, { ack: false }), /확인/);
  J.rollbackAllInstall(j0.id, { ack: true, by: 'admin' });
  assert.ok(await J._settleForTest());
  const j = J.installJob(j0.id);
  assert.equal(j.status, 'rolledback', JSON.stringify(j.rollback));
  assert.equal(R.rollbackRuns, 1);
  const s = loadSettings();
  assert.equal(s.sites.some((x) => x.vcenterId === 'vc1'), false);
  assert.equal(s.directors.length, 0);
});

test('⑥ parseRead — 실제 bash 출력(err 파일 없음 · 있음)에서 유닛 상태를 읽는다', () => {
  const R = fakeRemote();
  const rd = '/var/lib/portal-bareos-install/run/bi_abcdef01';
  const local = path.join(R.root, rd); fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, 'state'), '1 start 1\n1 ok 2\n2 start 3\n');
  fs.writeFileSync(path.join(local, 'run.log'), 'a\nb\n');
  fs.writeFileSync(path.join(R.bin, 'systemctl'), '#!/bin/bash\necho active\n', { mode: 0o755 });
  const runIt = () => J.parseRead(spawnSync('bash', ['-c', J.readCmd(rd).split(rd).join(local)], { encoding: 'utf8', env: { ...process.env, PATH: `${R.bin}:${process.env.PATH}` } }).stdout);
  let r = runIt();
  assert.equal(r.unit, 'active', 'err 파일이 없어도 유닛 상태를 읽는다(반증 H1)');
  assert.equal(r.steps[2].status, 'running'); assert.deepEqual(r.log, ['a', 'b']); assert.deepEqual(r.errs, {});
  fs.writeFileSync(path.join(local, 'err.2'), 'cmd=x\ncode=1\ncause=\n---\nboom');
  r = runIt();
  assert.equal(r.unit, 'active'); assert.match(r.errs[2], /boom/);
});

test('⑦ 반증 고친 것 — 더 새 작업 · 주소 바뀜 · 업로드 중 중단', async () => {
  reset();
  const R = fakeRemote(); R.scenario = 'fail2'; deps(R);
  const a = await J.startInstall({ vcenterId: 'vc1', body: {}, by: 'admin' });
  assert.ok(await J._settleForTest());
  R.scenario = 'ok';
  // 다른 법인이 같은 서버를 쓰는 새 작업(대상 표를 바꿔 같은 SSH 주소로)
  deps(R, target({ vcenterId: 'vc2', vcenterName: '법인2' }));
  const b = await J.startInstall({ vcenterId: 'vc2', body: {}, by: 'admin' });
  assert.ok(await J._settleForTest());
  await assert.rejects(() => J.retryInstall(a.id, { body: {}, by: 'admin' }), /더 새 작업/);
  assert.throws(() => J.rollbackAllInstall(a.id, { ack: true }), /더 새 작업/);
  // 주소 바뀜
  J._setDepsForTest({ ssh: R.ssh, sleep: async () => {}, targets: () => [target({ vcenterId: 'vc2' })], creds: () => ({ host: '10.9.9.9', port: 22, username: 'root', password: PASS }), pickBundle: async () => BUNDLE });
  assert.throws(() => J.rollbackAllInstall(b.id, { ack: true }), /SSH 주소가 작업 시작 때/);
  // 업로드 중 중단 → 러너를 띄우지 않는다
  reset();
  const R2 = fakeRemote(); let stopNow = null;
  deps(R2);
  const orig = R2.ssh;
  R2.ssh = async (c, fn, o) => orig(c, async (api) => fn({ ...api, putFile: async (...x) => { await stopNow?.(); return api.putFile(...x); } }), o);
  deps(R2);
  const runsBefore = R2.runs;
  const c = await J.startInstall({ vcenterId: 'vc1', body: {}, by: 'admin' });
  stopNow = () => J.stopInstall(c.id).catch(() => {});
  assert.ok(await J._settleForTest());
  const jc = J.installJob(c.id);
  assert.equal(jc.status, 'stopped', JSON.stringify(jc.failure));
  assert.equal(R2.runs, runsBefore, '러너를 띄우지 않았다');
});
