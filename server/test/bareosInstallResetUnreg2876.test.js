/**
 * test/bareosInstallResetUnreg2876.test.js — v2.876 '포탈 미등록 Bareos 를 지우고 설치'(2026-11-04 사용자 화면 — 사전 점검 '이미 설치된 Bareos ✗' 에서 막다른 길).
 *  ① resetTarget(순수): 새 설치 대상 + resetExisting === true 만 재설치로 바꾼다 · 이 서버(SSH 주소 · 러너가 읽은 서버 주소)가 다른 Director 로 등록돼 있으면 거부
 *  ② 중앙 흐름(가짜 SSH · 상태 읽기는 실제 bash): 표지 없이 시작하면 사전 점검 ✗ 로 막힘 → 표지 + 확인 체크면 0단계(초기화)부터 · 4단계가 Director 를 새로 등록
 *  ③ 확인 체크 없이 · 다른 법인 Director 가 이 서버 주소로 등록돼 있으면 시작하지 않는다(사전 점검 SSH 전 · 뒤 둘 다)
 *  ④ 데모: 여섯째 대상이 미등록 Bareos — 같은 규칙(실제 resetTarget · judgePrecheck)
 *  ⑤~⑨ 반증 1인 확정분(재현 → 고침): D 설정을 못 읽으면 거부 · A 호스트 이름 · 다른 NIC · 루프백 · C 다른 vCenter 작업 기록 · B 0단계 다시 하기 · E 러너 띄우기 직전
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi2876-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';

const J = await import('../src/bareos/install/job.js');
const { resetTarget } = await import('../src/bareos/install/targets.js');
const { normContents } = await import('../src/bareos/install/bundleDoc.js');
const { loadSettings, addDirector, _resetForTest: resetSettings } = await import('../src/bareos/settings.js');
const demo = await import('../src/bareos/install/demo.js');
const { store } = await import('../src/store.js');

const PASS = 'S3cret-pass!x';
const SHA = 'a'.repeat(64);
const V = '25.20261101.4';
const contents = normContents({ format: 'portal-bareos-bundle', v: 1, version: V, el: '9', arch: 'x86_64', bareosVersion: '25.1.2', postgresqlVersion: '13.23', install: ['bareos', 'postgresql-server'], packages: [], keys: ['K'], pyvmomi: { versions: ['8.0.3.0.1'], default: '8.0.3.0.1' } }, V).contents;
const tarPath = path.join(tmp, 'b.tar.gz'); fs.writeFileSync(tarPath, 'x');
const BUNDLE = { ok: true, version: V, sha256: SHA, size: 1, tarPath, contents };
const target = (o = {}) => ({ vcenterId: 'vc1', vcenterName: '법인1', vcHost: 'vc1.corp', agent: 'edge1', targetId: 't1', sshHost: '10.0.0.1', sshPort: 22, sshUser: 'root', hasPassword: true, director: null, mode: 'install', can: true, why: '', ...o });

// 사람이 직접 설치한 Bareos 가 남은 서버(패키지 · /etc/bareos · Director 꺼짐 · 카탈로그 있음)
const PRE = ['@@id', '0', '@@os', 'ID=rocky', 'VERSION_ID=9.4', 'PRETTY=Rocky 9.4', 'ARCH=x86_64', '@@tools', 'systemd-run=1', 'dnf=1', 'rpm=1', 'ss=1', '@@selinux', 'Enforcing',
  '@@pkgs', 'bareos-director 25.1.2', 'bareos-storage 25.1.2', 'bareos-filedaemon 25.1.2', '@@etc', '41',
  '@@svc', '@@ports', '@@python', '3.9.18', '@@pyvmomi', 'none', '@@bpp', '@@disk', 'PATH=/var/lib', 'AVAIL_KB=900000000', 'SIZE_KB=1800000000', 'MOUNT=/', 'EXISTS=0', '@@varlib', '900000000',
  '@@clock', '0.000120 seconds fast of NTP time', '@@addr', '10.20.0.14', 'edge1.corp', '@@addrs', '10.20.0.14', '192.168.50.7', 'fe80::1', 'bad;rm', '@@runner', 'inactive', '@@running', 'inactive', '@@catalog', '123456', '@@volumes', '@@end'].join('\n');

function fakeRemote() {
  const R = { writes: new Map(), runs: 0, cmds: [], stateLog: new Map() };
  R.root = fs.mkdtempSync(path.join(tmp, 'remote-'));
  R.bin = path.join(R.root, 'bin'); fs.mkdirSync(R.bin);
  fs.writeFileSync(path.join(R.bin, 'systemctl'), '#!/bin/bash\necho inactive\n', { mode: 0o755 });
  R.ssh = async (creds, fn) => {
    const api = {
      exec: async (cmd) => {
        R.cmds.push(cmd);
        if (cmd.includes('echo @@id')) return { code: 0, stdout: PRE };
        if (cmd === 'id -u') return { code: 0, stdout: '0\n' };
        if (cmd.startsWith('systemctl is-active portal-bareos-install')) return { code: 0, stdout: 'inactive\n' };
        if (cmd.includes('.part | cut')) return { code: 0, stdout: `${SHA}\n` };
        if (cmd.includes('systemd-run')) { R.runs += 1; return { code: 0, stdout: '' }; }
        if (cmd.includes('echo @@log')) {
          const rd = /cat (\S+)\/state/.exec(cmd)[1];
          const env = R.writes.get(`${rd}/plan.env`) || '';
          const local = path.join(R.root, rd);
          fs.mkdirSync(local, { recursive: true });
          for (const f of fs.readdirSync(local)) fs.rmSync(path.join(local, f));
          const start = Number(/START_STEP='(\d)'/.exec(env)?.[1] ?? 1);
          const lines = []; for (let n = start; n <= 3; n++) lines.push(`${n} start ${n}`, `${n} ok ${n}`);
          const state = `${R.stateLog.get(rd) || ''}begin install 1\n${lines.join('\n')}\nall done 9\n`;
          R.stateLog.set(rd, state);
          fs.writeFileSync(path.join(local, 'state'), state); fs.writeFileSync(path.join(local, 'run.log'), 'ok\n');
          const out = spawnSync('bash', ['-c', cmd.split(rd).join(local)], { encoding: 'utf8', env: { ...process.env, PATH: `${R.bin}:${process.env.PATH}` } });
          return { code: 0, stdout: out.stdout };
        }
        return { code: 0, stdout: '' };
      },
      writeFile: async (p, c) => { R.writes.set(p, String(c)); },
      putFile: async (local, remote, o) => { R.onPut?.(); o?.onProgress?.(1, 1); },
    };
    return { ok: true, ...(await fn(api)) };
  };
  return R;
}

function deps(R, t = target()) {
  const calls = { director: [] };
  J._setDepsForTest({
    ssh: R.ssh, sleep: async () => {}, targets: () => [t], creds: () => ({ host: '10.0.0.1', port: 22, username: 'root', password: PASS }), pickBundle: async () => BUNDLE,
    setupDirector: async (body, ctx) => { calls.director.push({ body, ctx }); ctx.save({ consoleName: body.consoleName, password: 'p'.repeat(32) }); return { files: [{}, {}] }; },
    setupFdPlugin: async () => ({ action: 'added', added: ['Plugin Names'] }),
    onDirector: async () => ({ version: '25.1.2' }),
  });
  return calls;
}
function reset() { J._resetForTest(); resetSettings(); for (const f of fs.readdirSync(tmp)) if (f.endsWith('.json')) fs.rmSync(path.join(tmp, f)); }
const RESET_OK = { resetExisting: true, reset: { ack: true, catalog: true, volumes: false } };

test('① resetTarget — 새 설치 + 표지만 재설치로 · 다른 Director 로 등록된 서버는 거부', () => {
  const t = target();
  assert.equal(resetTarget(t, {}, { directors: [] }), t, '표지 없으면 그대로');
  assert.equal(resetTarget(t, { resetExisting: 'true' }, { directors: [] }), t, '표지는 true(불리언)일 때만');
  assert.equal(resetTarget(null, { resetExisting: true }, { directors: [] }), null);
  const r = resetTarget(t, { resetExisting: true }, { directors: [] });
  assert.equal(r.mode, 'reinstall'); assert.equal(r.resetUnregistered, true); assert.equal(r.director, null);
  assert.equal(t.mode, 'install', '원래 행을 바꾸지 않는다');
  const re = target({ mode: 'reinstall', director: { id: 'd1', name: 'D1', host: '10.0.0.1' } });
  assert.equal(resetTarget(re, { resetExisting: true }, { directors: [{ id: 'd1', name: 'D1', host: '10.0.0.1' }] }), re, '이미 재설치 대상이면 그대로(기존 규칙)');
  assert.throws(() => resetTarget(t, { resetExisting: true }, { directors: [{ id: 'dX', name: '다른 법인 Bareos', host: ' 10.0.0.1 ' }] }), (e) => e.code === 'invalid' && /다른 법인 Bareos/.test(e.message), 'SSH 주소');
  assert.throws(() => resetTarget(target({ sshHost: 'Edge1.Corp' }), { resetExisting: true }, { directors: [{ id: 'dX', name: 'X', host: 'edge1.corp' }] }), /등록돼 있습니다/, '대소문자 무시');
  const ids = { ids: ['10.20.0.14', 'edge1.corp', '192.168.50.7', 'fe80::1'] };
  const D = (host, o = {}) => ({ directors: [{ id: 'dX', name: 'X', host, ...o }] });
  assert.throws(() => resetTarget(t, { resetExisting: true }, D('10.20.0.14'), ids), /등록돼 있습니다/, '러너가 읽은 서버 주소');
  assert.equal(resetTarget(t, { resetExisting: true }, D('10.9.9.9'), ids).mode, 'reinstall', '다른 서버의 Director 는 상관없다');
  // 반증 A: 같은 서버를 다른 이름 · 다른 NIC · IPv6 로 등록
  assert.throws(() => resetTarget(t, { resetExisting: true }, D('EDGE1.corp.'), ids), /등록돼 있습니다/, '호스트 이름(끝 점 · 대소문자)');
  assert.throws(() => resetTarget(t, { resetExisting: true }, D('edge1'), ids), /등록돼 있습니다/, '짧은 이름');
  assert.throws(() => resetTarget(t, { resetExisting: true }, D('10.20.0.14.'), ids), /등록돼 있습니다/, '주소 끝 점(짧은 이름 대조가 없는 IP)');
  assert.throws(() => resetTarget(t, { resetExisting: true }, D('edge1.other.corp'), ids), /등록돼 있습니다/, '짧은 이름이 같으면 거부하는 쪽');
  assert.throws(() => resetTarget(t, { resetExisting: true }, D('192.168.50.7'), ids), /등록돼 있습니다/, '다른 NIC');
  assert.throws(() => resetTarget(t, { resetExisting: true }, D('FE80::1'), ids), /등록돼 있습니다/, 'IPv6');
  // 루프백: 이름만으로는 어느 서버인지 모른다 — 담당 엣지로 대조
  const lo = { ids: ['localhost.localdomain', '127.0.0.1', '::1'] };
  assert.equal(resetTarget(t, { resetExisting: true }, D('localhost'), lo).mode, 'reinstall', '중앙 직접 Director(localhost)는 이 엣지가 아니다');
  assert.equal(resetTarget(t, { resetExisting: true }, D('127.0.0.1', { agent: 'edge9' }), lo).mode, 'reinstall', '다른 엣지의 localhost');
  assert.throws(() => resetTarget(t, { resetExisting: true }, D('localhost', { agent: 'EDGE1' }), lo), /등록돼 있습니다/, '이 엣지가 붙는 localhost Director = 이 서버');
  // 반증 C: 다른 vCenter 의 작업 기록(전부 되돌림 아닌 것)
  const job = (o) => ({ id: 'bi_other1', vcenterId: 'vc2', vcenterName: '법인2', sshHost: '10.0.0.9', hostAddr: '10.20.0.14', status: 'failed', ...o });
  assert.throws(() => resetTarget(t, { resetExisting: true }, { directors: [] }, { ...ids, jobs: [job()] }), (e) => e.code === 'invalid' && /법인2/.test(e.message));
  assert.equal(resetTarget(t, { resetExisting: true }, { directors: [] }, { ...ids, jobs: [job({ status: 'rolledback' })] }).mode, 'reinstall', '전부 되돌린 작업은 상관없다');
  assert.equal(resetTarget(t, { resetExisting: true }, { directors: [] }, { ...ids, jobs: [job({ vcenterId: 'vc1' })] }).mode, 'reinstall', '이 법인 자신의 작업은 상관없다');
  assert.equal(resetTarget(t, { resetExisting: true }, { directors: [] }, { ...ids, jobs: [job({ hostAddr: '10.7.7.7' })] }).mode, 'reinstall', '다른 서버의 작업은 상관없다');
});

test('② 표지 없이는 사전 점검 ✗ · 표지 + 확인이면 0단계부터 · 4단계가 Director 를 새로 등록', async () => {
  reset();
  const R = fakeRemote(); const calls = deps(R);
  const p0 = await J.runPrecheck({ vcenterId: 'vc1', body: {} });
  assert.equal(p0.mode, 'install'); assert.equal(p0.blocked, true);
  assert.equal(p0.items.find((i) => i.key === 'bareos').status, 'bad');
  assert.match(p0.items.find((i) => i.key === 'bareos').action, /초기화 후 재설치로 진행/, '조치 문구가 이 화면의 단추를 가리킨다');
  assert.equal(p0.resetUnregistered, undefined);
  await assert.rejects(() => J.startInstall({ vcenterId: 'vc1', body: {}, by: 'admin' }), (e) => e.code === 'precheck', '표지 없이 덮어쓰지 않는다');
  assert.equal(R.runs, 0);

  const p1 = await J.runPrecheck({ vcenterId: 'vc1', body: RESET_OK });
  assert.equal(p1.mode, 'reinstall'); assert.equal(p1.resetUnregistered, true); assert.equal(p1.blocked, false, JSON.stringify(p1.items.filter((i) => i.status === 'bad')));
  assert.equal(p1.items.find((i) => i.key === 'bareos').status, 'warn');

  const j0 = await J.startInstall({ vcenterId: 'vc1', body: RESET_OK, by: 'admin' });
  assert.equal(j0.mode, 'reinstall'); assert.equal(j0.resetUnregistered, true); assert.equal(j0.startStep ?? j0.attempts[0].fromStep, 0);
  assert.equal(j0.existingDirector, false); assert.equal(j0.directorId, '');
  assert.ok(j0.stepsMeta.some((s) => s.n === 0), '0단계(초기화)가 붙는다');
  assert.ok(await J._settleForTest());
  const j = J.installJob(j0.id);
  assert.equal(j.status, 'done', JSON.stringify(j.failure));
  assert.equal(j.steps[0].status, 'ok');
  const env = R.writes.get(`/var/lib/portal-bareos-install/run/${j0.id}/plan.env`);
  assert.match(env, /^START_STEP='0'$/m); assert.match(env, /^RESET='1'$/m); assert.match(env, /^RESET_DB='1'$/m); assert.match(env, /^RESET_VOLUMES='0'$/m);
  assert.equal(calls.director.length, 1);
  assert.equal(calls.director[0].ctx.dir.id, 'dir_pending_install', '기존 Director 가 없으니 새로');
  assert.equal(j.createdDirector, true);
  const d = loadSettings().directors.find((x) => x.id === j.directorId);
  assert.ok(d); assert.equal(d.host, '10.20.0.14'); assert.equal(d.agent, 'edge1');
});

test('③ 확인 체크 없음 · 다른 법인 Director 가 이 서버로 등록돼 있으면 시작하지 않는다', async () => {
  reset();
  let R = fakeRemote(); deps(R);
  await assert.rejects(() => J.startInstall({ vcenterId: 'vc1', body: { resetExisting: true, reset: { ack: false } }, by: 'admin' }), /확인/);
  assert.equal(R.runs, 0);

  // SSH 주소로 등록된 다른 법인 Director — 사전 점검 SSH 전에 거부
  reset();
  R = fakeRemote(); deps(R);
  addDirector({ name: '법인2 Bareos', host: '10.0.0.1', port: 9101, consoleName: 'admin', password: 'x'.repeat(16) });
  await assert.rejects(() => J.runPrecheck({ vcenterId: 'vc1', body: RESET_OK }), (e) => e.code === 'invalid' && /법인2 Bareos/.test(e.message));
  assert.equal(R.cmds.length, 0, 'SSH 에 붙지 않는다');
  await assert.rejects(() => J.startInstall({ vcenterId: 'vc1', body: RESET_OK, by: 'admin' }), (e) => e.code === 'invalid');
  assert.equal(R.runs, 0);

  // 러너가 읽은 서버 주소로 등록된 다른 법인 Director — 사전 점검 뒤에 거부
  reset();
  R = fakeRemote(); deps(R);
  addDirector({ name: '법인3 Bareos', host: '10.20.0.14', port: 9101, consoleName: 'admin', password: 'x'.repeat(16) });
  await assert.rejects(() => J.runPrecheck({ vcenterId: 'vc1', body: RESET_OK }), (e) => e.code === 'invalid' && /법인3 Bareos/.test(e.message));
  await assert.rejects(() => J.startInstall({ vcenterId: 'vc1', body: RESET_OK, by: 'admin' }), (e) => e.code === 'invalid');
  assert.equal(R.runs, 0, '러너를 띄우지 않는다');
  assert.equal(J.listInstallJobs().length, 0);
});

test('④ 데모 — 여섯째 대상(미등록 Bareos)도 같은 규칙', () => {
  demo._resetForTest();
  const prev = store.snapshot;
  store.snapshot = { ...prev, vcenters: Array.from({ length: 6 }, (_, i) => ({ id: `vc${i + 1}`, name: `법인${i + 1}` })) };
  try {
    const t6 = demo.overview().targets[5];
    assert.equal(t6.mode, 'install'); assert.equal(t6.can, true);
    const p0 = demo.precheck(t6.vcenterId, {});
    assert.equal(p0.blocked, true); assert.equal(p0.items.find((i) => i.key === 'bareos').status, 'bad');
    assert.equal(demo.start(t6.vcenterId, { reset: { ack: true } }).ok, false, '표지 없이 시작하지 않는다');
    const p1 = demo.precheck(t6.vcenterId, RESET_OK);
    assert.equal(p1.mode, 'reinstall'); assert.equal(p1.resetUnregistered, true); assert.equal(p1.blocked, false);
    const s = demo.start(t6.vcenterId, RESET_OK, 'admin');
    assert.equal(s.ok, true); assert.equal(s.job.mode, 'reinstall'); assert.equal(s.job.startStep, 0); assert.equal(s.job.existingDirector, false); assert.equal(s.job.resetUnregistered, true);
    // 첫째(새 설치 · Bareos 없음)는 표지가 와도 재설치로 바꾸되 데모 Director 와 주소가 겹치지 않는다 · 둘째(재설치 대상)의 서버를 첫째에서 지우게 하지 않는다
    const t2 = demo.overview().targets[1];
    assert.equal(t2.mode, 'reinstall');
    assert.equal(demo.precheck(t2.vcenterId, RESET_OK).resetUnregistered, undefined, '이미 재설치 대상은 그대로');
  } finally { store.snapshot = prev; }
});

test('⑤ 반증 D — Director 등록부(bareos.json)를 못 읽으면 지우지 않는다(빈 목록으로 보지 않는다)', async () => {
  reset();
  const R = fakeRemote(); deps(R);
  fs.writeFileSync(path.join(tmp, 'bareos.json'), '{ 손상');
  resetSettings();
  await assert.rejects(() => J.runPrecheck({ vcenterId: 'vc1', body: RESET_OK }), (e) => e.code === 'unavailable');
  await assert.rejects(() => J.startInstall({ vcenterId: 'vc1', body: RESET_OK, by: 'admin' }), (e) => e.code === 'unavailable');
  assert.equal(R.cmds.length, 0); assert.equal(R.runs, 0);
  for (const f of fs.readdirSync(tmp)) if (f.startsWith('bareos.json')) fs.rmSync(path.join(tmp, f));
  resetSettings();
});

test('⑥ 반증 A — 사전 점검이 읽은 호스트 이름 · 모든 주소로 대조한다(이상한 줄은 버림)', async () => {
  reset();
  const R = fakeRemote(); deps(R);
  addDirector({ name: '법인4 Bareos', host: 'edge1.corp', port: 9101, consoleName: 'admin', password: 'x'.repeat(16) });
  await assert.rejects(() => J.runPrecheck({ vcenterId: 'vc1', body: RESET_OK }), /법인4 Bareos/);
  reset(); deps(R);
  addDirector({ name: '법인5 Bareos', host: '192.168.50.7', port: 9101, consoleName: 'admin', password: 'x'.repeat(16) });
  await assert.rejects(() => J.startInstall({ vcenterId: 'vc1', body: RESET_OK, by: 'admin' }), /법인5 Bareos/);
  assert.equal(R.runs, 0);
  reset(); deps(R);
  const p = await J.runPrecheck({ vcenterId: 'vc1', body: RESET_OK });
  assert.deepEqual(p.hostIds, ['10.20.0.14', 'edge1.corp', '10.20.0.14', '192.168.50.7', 'fe80::1'], '주소 칸은 주소 글자만');
});

test('⑦ 반증 C — 같은 서버에 다른 vCenter 의 작업 기록(되돌리지 않은 것)이 있으면 시작하지 않는다', async () => {
  reset();
  const R = fakeRemote(); deps(R);
  fs.writeFileSync(path.join(tmp, 'bareos-install-jobs.json'), JSON.stringify({ jobs: [{ id: 'bi_other1', vcenterId: 'vc2', vcenterName: '법인2', sshHost: '10.0.0.1', hostAddr: '10.20.0.14', status: 'failed', mode: 'install', steps: {}, attempts: [] }] }));
  J._resetForTest(); deps(R);
  await assert.rejects(() => J.startInstall({ vcenterId: 'vc1', body: RESET_OK, by: 'admin' }), /법인2/);
  assert.equal(R.runs, 0);
});

test('⑧ 반증 B — 0단계 다시 하기도 같은 판정(그사이 이 서버가 Director 로 등록되면 거부)', async () => {
  reset();
  const R = fakeRemote(); deps(R);
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: RESET_OK, by: 'admin' });
  assert.ok(await J._settleForTest());
  // 0단계 실패로 만든다(기록만 — 러너가 0단계에서 멈춘 모양)
  const rec = JSON.parse(fs.readFileSync(path.join(tmp, 'bareos-install-jobs.json'), 'utf8'));
  const x = rec.jobs.find((y) => y.id === j0.id);
  Object.assign(x, { status: 'failed', failure: { step: 0, message: 'boom', cause: { key: 'unknown' } }, currentStep: 0, directorId: '', createdDirector: false, createdSite: false });
  fs.writeFileSync(path.join(tmp, 'bareos-install-jobs.json'), JSON.stringify(rec));
  for (const f of fs.readdirSync(tmp)) if (f === 'bareos.json') fs.rmSync(path.join(tmp, f));
  J._resetForTest(); resetSettings(); deps(R);
  addDirector({ name: '법인6 Bareos', host: '10.20.0.14', port: 9101, consoleName: 'admin', password: 'x'.repeat(16) });
  const runs = R.runs;
  await assert.rejects(() => J.retryInstall(j0.id, { body: {}, by: 'admin' }), /법인6 Bareos/);
  assert.equal(R.runs, runs, '러너를 다시 띄우지 않는다');
});

test('⑨ 반증 E — 업로드 중에 이 서버가 Director 로 등록되면 0단계를 띄우지 않는다', async () => {
  reset();
  const R = fakeRemote(); deps(R);
  R.onPut = () => { addDirector({ name: '법인7 Bareos', host: '10.20.0.14', port: 9101, consoleName: 'admin', password: 'x'.repeat(16) }); R.onPut = null; };
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: RESET_OK, by: 'admin' });
  assert.ok(await J._settleForTest());
  const j = J.installJob(j0.id);
  assert.equal(R.runs, 0, '러너를 띄우지 않았다');
  assert.equal(j.status, 'failed'); assert.match(JSON.stringify(j.failure), /법인7 Bareos/);
});
