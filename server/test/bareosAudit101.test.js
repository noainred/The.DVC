/**
 * 전체 점검 101회차 — Bareos 3차(최근 바뀐 코드 중심: v3.18.6 결정 D1 · D2 · N4 · N8 · S1 · #8 · #9 · 설치 · 관리).
 *  F1  같은 서버를 가리키는 Director 등록이 둘이면 재설치(초기화) · 전부 되돌리기가 다른 등록의 vCenter 잡 설정도 지운다 —
 *      함께 쓰는 vCenter 확인(N4) · 대상 수 · M4 · 0단계 다시 하기가 그 서버의 Director 를 모두 센다(install/targets.js sameServerDirector)
 *  F3  잘린 조회(55회차 #9 partial)의 진행 중 VM — 법인 상세의 행 결과 칩 · 오래됨 표시 · 폴더 줄 집계가 KPI · 필터 · CSV 와 달리 옛 결과를 그대로 셌다
 *  I1  Backup Detail · Summary '다음 예정' — Director 조회 실패 법인(53회차 S1)도 Director 스케줄 회차를 원장으로 낸다
 *  F2  범위 계정의 수동 조회가 주기 대조 차례를 차지하면 대조에서 뺀 Director(52회차 D2 · 범위 밖)는 다음 차례(10틱 뒤)까지 밀렸다 — 다음 틱에 대조
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ba101-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.once('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 종료 중 */ } }); });
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const J = await import('../src/bareos/install/job.js');
const T = await import('../src/bareos/install/targets.js');
const { normContents } = await import('../src/bareos/install/bundleDoc.js');
const S = await import('../src/bareos/settings.js');
const { _resetForTest: resetRegistry } = await import('../src/bareos/registry.js');
const SRC = (p) => stripComments(fs.readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8'));

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
const readOut = (state, unit = 'inactive') => `${state}\n\n@@log\nok\n\n@@err\n@@unit\n${unit}\n`;
function fake() {
  const R = { writes: new Map(), launches: 0, rollbackLaunches: 0 };
  R.ssh = async (_creds, fn) => {
    const api = {
      exec: async (cmd) => {
        if (cmd.includes('echo @@id')) return { code: 0, stdout: PRE };
        if (cmd === 'id -u') return { code: 0, stdout: '0\n' };
        if (cmd.startsWith('systemctl is-active portal-bareos-install')) return { code: 0, stdout: 'inactive\n' };
        if (cmd.includes('.part | cut')) return { code: 0, stdout: `${SHA}\n` };
        if (cmd.includes('sha256sum')) return { code: 0, stdout: '' };
        if (cmd.includes('systemd-run')) {
          R.launches += 1;
          const rd = /\/bin\/bash (\S+)\/runner\.sh/.exec(cmd)[1];
          if (/RUN_MODE='rollback-all'/.test(R.writes.get(`${rd}/plan.env`) || '')) R.rollbackLaunches += 1;
          return { code: 0, stdout: '' };
        }
        if (cmd.includes('echo @@log')) {
          const rd = /cat (\S+)\/state/.exec(cmd)[1];
          const env = R.writes.get(`${rd}/plan.env`) || '';
          if (/RUN_MODE='rollback-all'/.test(env)) return { code: 0, stdout: readOut('begin rollback-all 1\n3 ok 1\nall rolledback 2') };
          const start = Number(/START_STEP='(\d)'/.exec(env)?.[1] || 1);
          const lines = []; for (let n = start; n <= 3; n++) lines.push(`${n} start ${n}`, `${n} ok ${n}`);
          return { code: 0, stdout: readOut(`begin install 1\n${lines.join('\n')}\nall done 9`) };
        }
        return { code: 0, stdout: '' };
      },
      writeFile: async (p, c) => { R.writes.set(p, String(c)); },
      putFile: async (_l, _r, o) => { o?.onProgress?.(1, 1); },
    };
    return { ok: true, ...(await fn(api)) };
  };
  return R;
}
function deps(R, t) {
  J._setDepsForTest({
    ssh: R.ssh, sleep: async () => {}, targets: () => [t], creds: () => ({ host: SSH_HOST, port: 22, username: 'root', password: PASS }), pickBundle: async () => BUNDLE,
    setupDirector: async (body, ctx) => { ctx.save({ consoleName: body.consoleName, password: 'p'.repeat(32) }); return { files: [{}] }; },
    setupFdPlugin: async () => ({ action: 'added', added: ['Plugin Names'] }),
    onDirector: async () => ({ version: '25.1.2' }),
  });
}
function reset() {
  J._resetForTest(); S._resetForTest(); resetRegistry();
  for (const f of fs.readdirSync(tmp)) { const p = path.join(tmp, f); if (fs.statSync(p).isFile() && f !== 'b.tar.gz') fs.rmSync(p); }
}
const REINSTALL_BODY = { reset: { ack: true, catalog: true, volumes: false } };
const writeJobs = (jobs) => { fs.writeFileSync(path.join(tmp, 'bareos-jobs.json'), JSON.stringify({ jobs, retired: [] })); resetRegistry(); };

test('F1: sameServerDirector — 같은 서버의 등록만(정확한 주소 · 짧은 이름 한쪽 · 루프백은 담당 엣지)', () => {
  const mine = T.sameServerDirector({ sshHost: '10.0.0.1', agent: 'edge1', ids: ['10.20.0.14', 'edge1.corp'] });
  assert.equal(mine({ host: '10.20.0.14' }), true);
  assert.equal(mine({ host: 'EDGE1.corp.' }), true, '대소문자 · 끝 점');
  assert.equal(mine({ host: 'edge1' }), true, '등록이 짧은 이름');
  assert.equal(mine({ host: 'edge1.other.corp' }), false, '둘 다 긴 이름이면 첫 마디만 같아도 다른 서버');
  assert.equal(mine({ host: '10.20.0.15' }), false);
  assert.equal(mine({ host: 'localhost', agent: 'edge1' }), true, '루프백 = 담당 엣지 서버');
  assert.equal(mine({ host: '127.0.0.1', agent: 'edge2' }), false);
  assert.equal(mine({ host: '' }), false);
  const shortSrv = T.sameServerDirector({ sshHost: 'edge1', ids: [] });
  assert.equal(shortSrv({ host: 'edge1.corp' }), true, '서버 쪽이 짧은 이름');
});

test('F1: 재설치 — 같은 서버를 가리키는 다른 Director 등록의 vCenter 도 함께 지워짐 확인 · 대상 수에 든다 · 확인 없으면 시작 거부', async () => {
  reset();
  const R = fake();
  const dA = S.addDirector({ name: '법인1 Bareos', host: HOST_ADDR, port: 9101, consoleName: 'portal', password: 'x'.repeat(24), agent: 'edge1' }).director;
  const dB = S.addDirector({ name: '법인1 둘째 서비스', host: HOST_ADDR, port: 9101, consoleName: 'portal-b', password: 'y'.repeat(24), agent: 'edge1' }).director;
  S.saveSettings({ sites: [{ vcenterId: 'vc1', directorId: dA.id }, { vcenterId: 'vc-b', directorId: dB.id }] });   // D1 은 Director id 가 달라 막지 않는다
  writeJobs([{ id: 'bj1', directorId: dA.id, vcenterId: 'vc1', vmName: 'a1', bareosJob: 'portal-a1' },
    { id: 'bj2', directorId: dB.id, vcenterId: 'vc-b', vmName: 'b1', bareosJob: 'portal-b1' }, { id: 'bj3', directorId: dB.id, vcenterId: 'vc-b', vmName: 'b2', bareosJob: 'portal-b2' }]);
  const t = target({ mode: 'reinstall', director: { id: dA.id, name: dA.name, host: dA.host, agent: 'edge1' } });
  deps(R, t);
  const pre = await J.runPrecheck({ vcenterId: 'vc1', body: REINSTALL_BODY });
  assert.deepEqual(pre.sharedVcenters, [{ vcenterId: 'vc-b', targets: 2 }], '같은 서버의 다른 등록에 묶인 vCenter');
  assert.equal(pre.ledgerTargets, 3, '지워지는 잡 설정 수 = 그 서버의 대상 전부');
  await assert.rejects(J.startInstall({ vcenterId: 'vc1', body: REINSTALL_BODY, by: 'admin' }), (e) => e.code === 'precheck' && /vc-b/.test(e.message));
  assert.equal(R.launches, 0, '러너를 띄우지 않았다');
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: { ...REINSTALL_BODY, sharedAck: { vcenterIds: ['vc-b'] } }, by: 'admin' });
  assert.equal(j0.status, 'running', '확인하면 시작한다');
  assert.ok(await J._settleForTest());
});

test('F1: 다른 서버의 등록은 함께 쓰는 vCenter 가 아니다', async () => {
  reset();
  const R = fake();
  const dA = S.addDirector({ name: '법인1 Bareos', host: HOST_ADDR, port: 9101, consoleName: 'portal', password: 'x'.repeat(24), agent: 'edge1' }).director;
  const dP = S.addDirector({ name: '폴란드', host: '10.30.0.9', port: 9101, consoleName: 'portal', password: 'z'.repeat(24), agent: 'edge-pl' }).director;
  S.saveSettings({ sites: [{ vcenterId: 'vc1', directorId: dA.id }, { vcenterId: 'vc-pl', directorId: dP.id }] });
  writeJobs([{ id: 'bp', directorId: dP.id, vcenterId: 'vc-pl', vmName: 'p1', bareosJob: 'portal-p1' }]);
  deps(R, target({ mode: 'reinstall', director: { id: dA.id, name: dA.name, host: dA.host, agent: 'edge1' } }));
  const pre = await J.runPrecheck({ vcenterId: 'vc1', body: REINSTALL_BODY });
  assert.deepEqual(pre.sharedVcenters, []);
  assert.equal(pre.ledgerTargets, 0);
});

test('F1: 전부 되돌리기(M4) — 같은 서버를 가리키는 다른 Director 등록에 백업 대상이 있으면 거부', async () => {
  reset();
  const R = fake();
  const dA = S.addDirector({ name: '법인1 Bareos', host: HOST_ADDR, port: 9101, consoleName: 'portal', password: 'x'.repeat(24), agent: 'edge1' }).director;
  deps(R, target({ mode: 'reinstall', director: { id: dA.id, name: dA.name, host: dA.host, agent: 'edge1' } }));
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: REINSTALL_BODY, by: 'admin' });
  assert.ok(await J._settleForTest());
  assert.equal(J.installJob(j0.id).status, 'done');
  // 설치 뒤 둘째 서비스를 같은 서버의 새 등록으로 묶고 대상을 만들었다
  const dB = S.addDirector({ name: '법인1 둘째 서비스', host: 'edge1', port: 9101, consoleName: 'portal-b', password: 'y'.repeat(24), agent: 'edge1' }).director;
  writeJobs([{ id: 'bj2', directorId: dB.id, vcenterId: 'vc-b', vmName: 'b1', bareosJob: 'portal-b1' }]);
  assert.throws(() => J.rollbackAllInstall(j0.id, { ack: true, by: 'admin' }), (e) => e.code === 'conflict' && /같은 서버/.test(e.message) && /1개/.test(e.message));
  assert.equal(R.rollbackLaunches, 0);
  assert.equal(J.installJob(j0.id).status, 'done', '상태를 바꾸지 않았다');
  // 대상이 없으면 예전대로 되돌린다
  writeJobs([]);
  J.rollbackAllInstall(j0.id, { ack: true, by: 'admin' });
  assert.ok(await J._settleForTest());
  assert.equal(R.rollbackLaunches, 1);
});

test('F1: 0단계 다시 하기도 같은 서버 판정으로 대조한다(소스)', () => {
  const job = SRC('bareos/install/job.js');
  assert.match(job, /fromStep === 0 && j\.mode === 'reinstall' && j\.directorId\)[\s\S]{0,300}sharedOfDirector\(j\.directorId, j\.vcenterId, serverOfJob\(j\)\)/);
  assert.match(job, /sharedOfDirector\(t\.director\.id, vcenterId, \{ sshHost: t\.sshHost, agent: t\.agent, ids: hostIds \}\)/);
});

test('F2: 조회 전용 계정의 수동 조회가 대조 차례를 차지해도 뺀 Director 는 다음 주기 틱에 대조한다', async () => {
  reset();
  const { startFakeDirector } = await import('./_fakeBareosDirector.js');
  const poller = await import('../src/bareos/poller.js');
  const cmds = [];
  const fd = await startFakeDirector({ name: 'portal', password: 'pw-f2', handle: async (cmd) => {
    cmds.push(cmd);
    if (cmd === '.jobs') return { jobs: [{ name: 'portal-f2', enabled: true }] };
    if (cmd.startsWith('list jobs')) return { jobs: [] };
    return { error: [`unknown ${cmd}`] };
  } });
  try {
    const d = S.addDirector({ name: '법인 F2', host: '127.0.0.1', port: fd.port, consoleName: 'portal', password: 'pw-f2', timeoutMs: 5000 }).director;
    S.saveSettings({ sites: [{ vcenterId: 'vc-f2', directorId: d.id }] });
    writeJobs([{ id: 'bf2', directorId: d.id, vcenterId: 'vc-f2', vmName: 'f2', bareosJob: 'portal-f2', enabled: true }]);
    poller._resetPollerForTest();
    poller._setPollBudgetForTest(10_000);
    await poller.pollOnce({ trigger: 'manual', reconcileOnly: new Set() });   // _tick 1 = 주기 대조 차례 — 조회 전용이라 이 Director 는 대조하지 않는다
    assert.equal(cmds.filter((c) => c === '.jobs').length, 0, '조회 전용 수동 조회는 대조하지 않는다(52회차 D2)');
    await poller.pollOnce({ trigger: 'timer' });   // _tick 2 — 주기 차례가 아니지만 밀린 대조를 한다
    assert.equal(cmds.filter((c) => c === '.jobs').length, 1, '다음 주기 틱에 대조했다(10틱 뒤로 밀리지 않는다)');
    // 범위 계정(다른 법인 Director 만 조회 — v2.823 S1)의 수동 조회가 차례를 차지해도 같다
    poller._resetPollerForTest();
    await poller.pollOnce({ trigger: 'manual', directorIds: ['dir_other_corp'] });
    assert.equal(cmds.filter((c) => c === '.jobs').length, 1, '범위 밖 Director 에는 접속하지 않았다');
    await poller.pollOnce({ trigger: 'timer' });
    assert.equal(cmds.filter((c) => c === '.jobs').length, 2, '범위 밖이라 조회하지 않은 Director 도 다음 주기 틱에 대조했다');
    await poller.pollOnce({ trigger: 'timer' });
    assert.equal(cmds.filter((c) => c === '.jobs').length, 2, '대조를 마친 뒤에는 차례가 아닌 틱에 다시 하지 않는다');
  } finally {
    poller._setPollBudgetForTest(null); poller._resetPollerForTest();
    await fd.close?.();
  }
});

test('F3: 잘린 조회의 진행 중 VM — 행 결과 칩 · 폴더 집계도 모름(서버 corpCounts 와 같은 수)', async () => {
  const V = await import('../src/bareos/vmView.js');
  const web = await import('../../web/src/views/tools/bareosViewText.js');
  const NOW = Date.UTC(2026, 10, 17, 1, 0);
  const old = NOW - 3 * 86_400_000;
  const rows = [
    { id: 'v1', name: 'v1', folder: '/a', method: 'bareos', b: { job: true, on: true, st: 'error', ok: old, run: 'running' } },
    { id: 'v2', name: 'v2', folder: '/a', method: 'bareos', b: { job: true, on: true, st: 'error', ok: old, run: null } },
    { id: 'v3', name: 'v3', folder: '/a', method: 'bareos', b: { job: true, on: true, st: 'ok', ok: NOW - 3600_000, run: 'running' } },
  ];
  assert.equal(web.rowResultKnown(rows[0], { partial: true }), false);
  assert.equal(web.rowResultKnown(rows[1], { partial: true }), true, '끝난 실행은 안다');
  assert.equal(web.rowResultKnown(rows[0], {}), true, '잘리지 않았으면 예전대로');
  assert.equal(web.rowResultKnown(rows[1], { resultsKnown: false }), false);
  const tree = web.buildBareosTree(rows, { now: NOW, partial: true });
  const c = V.corpCounts(rows, { now: NOW, partial: true });
  assert.deepEqual([tree.agg.ok, tree.agg.fail, tree.agg.run], [c.ok, c.fail, c.run], '폴더 집계 = 법인 KPI');
  assert.deepEqual([tree.agg.ok, tree.agg.fail, tree.agg.run], [0, 1, 2]);
  const full = web.buildBareosTree(rows, { now: NOW });
  assert.deepEqual([full.agg.ok, full.agg.fail], [1, 2], '잘리지 않았으면 예전대로');
  const tool = stripComments(fs.readFileSync(new URL('../../web/src/views/tools/BareosDetailTool.jsx', import.meta.url), 'utf8'));
  assert.match(tool, /<RunCell b=\{r\.b\} known=\{rk\} \/>/);
  assert.match(tool, /<RunCell b=\{selRow\.b\} known=\{rowResultKnown\(selRow, fopts\)\} \/>/);
  assert.doesNotMatch(tool, /known && k\.old/, '오래됨 표시도 행 판정으로');
});

test('I1: Director 조회 실패 법인도 Director 스케줄 다음 예정은 원장 잡으로(소스)', () => {
  const v = SRC('routes/api/veeam.js');
  assert.match(v, /const groupNext = bareosGroupNext\(vc\.id, now, ledger\);/);
});
