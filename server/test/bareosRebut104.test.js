/**
 * 전체 점검 104회차 — 101회차(Bareos 3차) 반증 + 101회차가 남긴 결정 구현(사용자 '결정 필요한 것은 권장 사항으로 진행').
 *  D1  같은 주소:포트(+ 같은 담당)를 가리키는 다른 Director 등록으로 'Director 하나에 vCenter 하나'(52회차 D1)를 우회 — 새 묶음 거부 · 옛 짝은 그대로(grandfather)
 *  D2  일일 요약 메일 — 잘린 조회(읽은 행 있음)는 법인 전체 '모름' 이 아니라 읽은 행은 세고 진행 중 VM 만 '모름'(현황판 corpCounts 와 같은 판정)
 *  R1  0단계 다시 하기 · 재설치 사전 점검 — 설정을 못 읽으면 함께 쓰는 vCenter 를 '없음' 으로 세어 확인 없이 지웠다(loadSettings 는 던지지 않는다)
 *  R2  새 설치 작업에 서버 이름(serverIds)을 남기지 않아 전부 되돌리기의 같은 서버 판정이 호스트 이름 등록을 놓쳤다
 *  R3  같은 서버 판정의 오탐 — 담당 엣지가 다른 법인의 같은 사설 주소 Director 때문에 되돌리기가 막히고 남의 법인 vCenter 확인을 물었다
 *  R4  101 F2 보정이 범위 계정의 '지금 조회' 로 다른 법인 Director 의 주기 대조를 앞당겼다(10분 → 1분)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'br104-'));
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
const SSH_HOST = '10.0.0.1'; const HOST_ADDR = '10.20.0.14'; const LAN = '192.168.1.10';
const target = (o = {}) => ({ vcenterId: 'vc1', vcenterName: '법인1', vcHost: 'vc1.corp', agent: 'edge1', targetId: 't1', sshHost: SSH_HOST, sshPort: 22, sshUser: 'root', hasPassword: true, director: null, mode: 'install', can: true, why: '', ...o });
const PRE = ['@@id', '0', '@@os', 'ID=rocky', 'VERSION_ID=9.4', 'PRETTY=Rocky 9.4', 'ARCH=x86_64', '@@tools', 'systemd-run=1', 'dnf=1', 'rpm=1', 'ss=1', '@@selinux', 'Enforcing', '@@pkgs', '@@etc', 'none',
  '@@svc', '@@ports', '@@python', '3.9.18', '@@pyvmomi', 'none', '@@bpp', '@@disk', 'PATH=/var/lib', 'AVAIL_KB=900000000', 'SIZE_KB=1800000000', 'MOUNT=/', 'EXISTS=0', '@@varlib', '900000000',
  '@@clock', '0.000120 seconds fast of NTP time', '@@addr', HOST_ADDR, 'edge1.corp', LAN, '@@runner', 'inactive', '@@running', 'none', '@@catalog', 'none', '@@volumes', '@@end'].join('\n');
const readOut = (state, errs = {}) => `${state}\n\n@@log\nok\n\n@@err\n${Object.entries(errs).map(([f, t]) => `@@file ${f}\n${t}\n`).join('')}@@unit\ninactive\n`;
function fake({ fail0 = false } = {}) {
  const R = { writes: new Map(), launches: 0, rollbackLaunches: 0, fail0 };
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
          if (R.fail0 && start === 0) return { code: 0, stdout: readOut('begin install 1\n0 start 1\n0 fail 2', { [`${rd}/err.0`]: 'cmd=초기화\ncode=1\n---\n시험 실패' }) };
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
const dirRec = (o) => ({ name: o.name, host: o.host, port: o.port ?? 9101, consoleName: o.consoleName || 'portal', password: 'x'.repeat(24), agent: o.agent ?? '' });

/* ───────── D1: 같은 Director 를 가리키는 다른 등록 ───────── */
test('D1: sameDirectorEndpoint — 같은 주소(정확 · 짧은 이름 한쪽) · 같은 포트 · 같은 담당 · 대칭', () => {
  const E = S.sameDirectorEndpoint;
  const cases = [
    [{ host: '10.20.0.14', port: 9101, agent: 'edge1' }, { host: '10.20.0.14', port: 9101, agent: 'edge1' }, true, '같은 주소 · 포트 · 담당'],
    [{ host: 'bareos.kr.corp', agent: '' }, { host: 'BAREOS', agent: '' }, true, '짧은 이름 한쪽 · 포트 기본 9101'],
    [{ host: 'bareos.kr.corp' }, { host: 'bareos.pl.corp' }, false, '둘 다 긴 이름이면 다른 서버'],
    [{ host: '10.20.0.14', port: 9101 }, { host: '10.20.0.14', port: 9102 }, false, '포트가 다르면 다른 Director'],
    [{ host: LAN, agent: 'edge-kr' }, { host: LAN, agent: 'edge-pl' }, false, '담당 엣지가 다르면 그 법인 망의 주소 — 단정하지 않는다'],
    [{ host: LAN, agent: 'edge-kr' }, { host: LAN, agent: '' }, false, '엣지 대행 · 중앙 직접은 다른 망'],
    [{ host: 'localhost', agent: 'edge1' }, { host: '127.0.0.1', agent: 'edge1' }, true, '루프백끼리 같은 담당'],
    [{ host: 'localhost', agent: 'edge1' }, { host: '127.0.0.1', agent: 'edge2' }, false],
    [{ host: 'localhost', agent: 'edge1' }, { host: 'edge1', agent: 'edge1' }, false, '루프백과 이름은 단정하지 않는다'],
    [{ host: '', agent: '' }, { host: '', agent: '' }, false, '주소 없음'],
  ];
  for (const [a, b, want, why] of cases) {
    assert.equal(E(a, b), want, why || JSON.stringify([a, b]));
    assert.equal(E(b, a), want, `대칭 — ${why || ''}`);
  }
});

test('D1: 같은 주소:포트에 콘솔 이름만 다른 등록으로 둘째 vCenter 를 묶는 저장은 거부 · 옛 짝은 그대로 · 다른 포트 · 다른 담당은 막지 않는다', () => {
  reset();
  const dA = S.addDirector(dirRec({ name: '법인1 Bareos', host: HOST_ADDR, agent: 'edge1' })).director;
  const dB = S.addDirector(dirRec({ name: '법인1 우회', host: HOST_ADDR, consoleName: 'portal-b', agent: 'edge1' })).director;
  const dPort = S.addDirector(dirRec({ name: '다른 포트', host: HOST_ADDR, port: 9102, consoleName: 'portal-c', agent: 'edge1' })).director;
  const dPl = S.addDirector(dirRec({ name: '폴란드', host: HOST_ADDR, consoleName: 'portal-pl', agent: 'edge-pl' })).director;
  S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: dA.id }] });
  assert.throws(() => S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: dA.id }, { vcenterId: 'vc-b', directorId: dB.id }] }),
    (e) => e.code === 'invalid' && /법인1 우회/.test(e.message) && /법인1 Bareos/.test(e.message) && /‘vc-b’/.test(e.message) && /같은 Director/.test(e.message));
  // 다른 포트(다른 Director 데몬) · 다른 담당(다른 법인 망의 같은 사설 주소)은 막지 않는다
  S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: dA.id }, { vcenterId: 'vc-c', directorId: dPort.id }, { vcenterId: 'vc-pl', directorId: dPl.id }] });
  assert.equal(S.loadSettings().sites.length, 3);
  // 옛 짝(이미 저장된 — grandfather): 그대로 저장 · 같은 묶음 안에서 옮기기는 되고, 새 vCenter 를 더하는 것은 거부
  S._seedLegacySitesForTest([{ vcenterId: 'vc-a', directorId: dA.id }, { vcenterId: 'vc-b', directorId: dB.id }]);
  const legacy = S.loadSettings().sites.map((x) => ({ vcenterId: x.vcenterId, directorId: x.directorId }));
  S.saveSettings({ sites: legacy });
  S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: dA.id }, { vcenterId: 'vc-b', directorId: dA.id }] });
  assert.throws(() => S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: dA.id }, { vcenterId: 'vc-b', directorId: dA.id }, { vcenterId: 'vc-x', directorId: dB.id }] }), /‘vc-x’/);
  // 설정 화면이 받는 같은 Director 표(판정 하나)
  const peers = S.directorEndpointPeers(S.loadSettings().directors);
  assert.deepEqual(peers.get(dA.id), [dB.id]);
  assert.deepEqual(peers.get(dB.id), [dA.id]);
  assert.equal(peers.has(dPort.id), false);
  assert.equal(peers.has(dPl.id), false);
});

test('D1: 짧은 이름 대조는 사슬로 넓히지 않는다(별 모양) — ‘bareos’ 를 사이에 둔 kr · pl 은 같은 Director 가 아니다', () => {
  const dirs = [{ id: 'dK', name: 'kr', host: 'bareos.kr.corp' }, { id: 'dS', name: 'short', host: 'bareos' }, { id: 'dP', name: 'pl', host: 'bareos.pl.corp' }];
  const cur = [{ vcenterId: 'vk', directorId: 'dK' }];
  assert.equal(S.directorBindIssue([...cur, { vcenterId: 'vp', directorId: 'dP' }], cur, dirs), '', 'kr 과 pl 은 다른 서버');
  assert.match(S.directorBindIssue([...cur, { vcenterId: 'vs', directorId: 'dS' }], cur, dirs), /‘vs’/, '짧은 이름 등록은 kr 과 같은 Director 일 수 있다 — 거부');
});

test('D1: 웹 bindAllowed(peerSaved) — 서버 directorBindIssue 와 같은 입력에 같은 답', async () => {
  const web = await import('../../web/src/views/tools/bareosText.js');
  const dirs = [{ id: 'dA', name: 'A', host: 'h', agent: 'e' }, { id: 'dB', name: 'B', host: 'h', consoleName: 'b', agent: 'e' }];
  // [이 Director(dB) 에서 켜려는 vCenter, 편집 중 묶인 것(dB), 저장된 것(dB), 저장된 사이트 전체]
  const cases = [
    ['vc-b', [], [{ vcenterId: 'vc-a', directorId: 'dA' }]],
    ['vc-b', [], []],
    ['vc-b', [], [{ vcenterId: 'vc-a', directorId: 'dA' }, { vcenterId: 'vc-b', directorId: 'dB' }]],
    ['vc-c', ['vc-b'], [{ vcenterId: 'vc-a', directorId: 'dA' }, { vcenterId: 'vc-b', directorId: 'dB' }]],
    ['vc-b', [], [{ vcenterId: 'vc-a', directorId: 'dA' }, { vcenterId: 'vc-b', directorId: 'dA' }]],
  ];
  const peers = S.directorEndpointPeers(dirs);
  for (const [vc, boundArr, saved] of cases) {
    const peerIds = new Set(peers.get('dB') || []);
    const savedHere = new Set(saved.filter((x) => x.directorId === 'dB').map((x) => x.vcenterId));
    const peerSaved = new Set(saved.filter((x) => peerIds.has(x.directorId)).map((x) => x.vcenterId));
    const webOk = web.bindAllowed(vc, new Set(boundArr), savedHere, peerSaved);
    const next = [...saved.filter((x) => x.directorId !== 'dB' && x.vcenterId !== vc), ...[...boundArr, vc].map((v) => ({ vcenterId: v, directorId: 'dB' }))];
    const serverOk = S.directorBindIssue(next, saved, dirs) === '';
    assert.equal(webOk, serverOk, JSON.stringify([vc, boundArr, saved]));
  }
  assert.equal(web.bindAllowed('x', new Set(), new Set()), true, '예전 세 인자 호출은 그대로');
  const bs = stripComments(fs.readFileSync(new URL('../../web/src/views/tools/BareosSettings.jsx', import.meta.url), 'utf8'));
  assert.match(bs, /bindAllowed\(v\.id, bound, savedHere, peerSaved\)/);
  const route = SRC('routes/api/bareosBackup.js');
  assert.match(route, /directorEndpointPeers\(st\.directors\)/);
});

/* ───────── R1: 0단계 다시 하기 — 설정을 못 읽으면 ───────── */
test('R1: 0단계에서 멈춘 재설치의 다시 하기 — 설정을 못 읽으면 함께 쓰는 vCenter 를 판정하지 않고 거부(러너를 띄우지 않는다)', async () => {
  reset();
  const R = fake({ fail0: true });
  const dA = S.addDirector(dirRec({ name: '법인1 Bareos', host: HOST_ADDR, agent: 'edge1' })).director;
  S.saveSettings({ sites: [{ vcenterId: 'vc1', directorId: dA.id }] });
  deps(R, target({ mode: 'reinstall', director: { id: dA.id, name: dA.name, host: dA.host, agent: 'edge1' } }));
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: REINSTALL_BODY, by: 'admin' });
  assert.ok(await J._settleForTest());
  const failed = J.installJob(j0.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure?.step, 0, '0단계에서 멈췄다');
  const launches = R.launches;
  // 설정 파일이 손상(기동 때 읽기 실패) — loadSettings 는 빈 설정을 준다
  fs.writeFileSync(path.join(tmp, 'bareos.json'), '{broken');
  S._resetForTest();
  assert.ok(S.settingsLoadError(), '설정 읽기 오류');
  await assert.rejects(J.retryInstall(j0.id, { by: 'admin' }), (e) => e.code === 'unavailable' && /설정/.test(e.message));
  assert.equal(R.launches, launches, '0단계(초기화)를 다시 띄우지 않았다');
  assert.equal(J.installJob(j0.id).status, 'failed', '상태를 바꾸지 않았다');
});

/* ───────── R2: 새 설치 작업의 서버 이름 ───────── */
test('R2: 새 설치도 서버 이름(serverIds)을 남긴다 — 전부 되돌리기가 호스트 이름으로 등록된 같은 서버의 Director 대상을 센다', async () => {
  reset();
  const R = fake();
  deps(R, target({ mode: 'install' }));
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: {}, by: 'admin' });
  assert.ok(await J._settleForTest());
  const done = J.installJob(j0.id);
  assert.equal(done.status, 'done');
  assert.ok((done.serverIds || []).includes('edge1.corp'), '러너가 읽은 서버 이름');
  // 설치 뒤 같은 서버를 호스트 이름(짧은 이름)으로 가리키는 등록 + 대상
  const dB = S.addDirector(dirRec({ name: '같은 서버 이름 등록', host: 'edge1', consoleName: 'portal-b', agent: 'edge1' })).director;
  writeJobs([{ id: 'bj2', directorId: dB.id, vcenterId: 'vc-b', vmName: 'b1', bareosJob: 'portal-b1' }]);
  assert.throws(() => J.rollbackAllInstall(j0.id, { ack: true, by: 'admin' }), (e) => e.code === 'conflict' && /같은 서버/.test(e.message));
  assert.equal(R.rollbackLaunches, 0, '이 서버의 Bareos 를 지우지 않았다');
});

/* ───────── R3: 같은 서버 판정의 오탐 ───────── */
test('R3: 담당 엣지가 다른 법인의 같은 사설 주소 Director 는 같은 서버가 아니다(되돌리기 · 함께 지워짐 확인에 들지 않는다) · 같은 담당 · 중앙 직접은 그대로 센다', async () => {
  const mine = T.sameServerDirector({ sshHost: SSH_HOST, agent: 'edge1', ids: [HOST_ADDR, LAN] });
  assert.equal(mine({ host: LAN, agent: 'edge-pl' }), false, '다른 법인 엣지의 망');
  assert.equal(mine({ host: LAN, agent: 'edge1' }), true);
  assert.equal(mine({ host: LAN, agent: '' }), true, '중앙 직접은 단정할 수 없어 센다(지우는 쪽에서는 보수적으로)');
  assert.equal(T.sameServerDirector({ sshHost: SSH_HOST, ids: [LAN] })({ host: LAN, agent: 'edge-pl' }), true, '서버 쪽 담당을 모르면 센다');
  reset();
  const R = fake();
  const dA = S.addDirector(dirRec({ name: '법인1 Bareos', host: HOST_ADDR, agent: 'edge1' })).director;
  const dP = S.addDirector(dirRec({ name: '폴란드', host: LAN, agent: 'edge-pl' })).director;
  S.saveSettings({ sites: [{ vcenterId: 'vc1', directorId: dA.id }, { vcenterId: 'vc-pl', directorId: dP.id }] });
  writeJobs([{ id: 'bp', directorId: dP.id, vcenterId: 'vc-pl', vmName: 'p1', bareosJob: 'portal-p1' }]);
  deps(R, target({ mode: 'reinstall', director: { id: dA.id, name: dA.name, host: dA.host, agent: 'edge1' } }));
  const pre = await J.runPrecheck({ vcenterId: 'vc1', body: REINSTALL_BODY });
  assert.deepEqual(pre.sharedVcenters, [], '폴란드 vCenter 를 함께 지워짐으로 묻지 않는다');
  assert.equal(pre.ledgerTargets, 0);
  const j0 = await J.startInstall({ vcenterId: 'vc1', body: REINSTALL_BODY, by: 'admin' });
  assert.ok(await J._settleForTest());
  assert.equal(J.installJob(j0.id).status, 'done');
  J.rollbackAllInstall(j0.id, { ack: true, by: 'admin' });   // 폴란드 대상 때문에 막히지 않는다
  assert.ok(await J._settleForTest());
  assert.equal(R.rollbackLaunches, 1);
});

/* ───────── R4: 주기 대조 차례 ───────── */
test('R4: 범위 계정의 지금 조회는 다른 법인 Director 의 주기 대조를 앞당기지 않는다(주기 틱만 센다) · 101 F2(밀리지 않음)는 그대로', async () => {
  reset();
  const { startFakeDirector } = await import('./_fakeBareosDirector.js');
  const poller = await import('../src/bareos/poller.js');
  const cmds = [];
  const fd = await startFakeDirector({ name: 'portal', password: 'pw-r4', handle: async (cmd) => {
    cmds.push(cmd);
    if (cmd === '.jobs') return { jobs: [{ name: 'portal-r4', enabled: true }] };
    if (cmd.startsWith('list jobs')) return { jobs: [] };
    return { error: [`unknown ${cmd}`] };
  } });
  try {
    const d = S.addDirector({ name: '다른 법인', host: '127.0.0.1', port: fd.port, consoleName: 'portal', password: 'pw-r4', timeoutMs: 5000 }).director;
    S.saveSettings({ sites: [{ vcenterId: 'vc-r4', directorId: d.id }] });
    writeJobs([{ id: 'br4', directorId: d.id, vcenterId: 'vc-r4', vmName: 'r4', bareosJob: 'portal-r4', enabled: true }]);
    poller._resetPollerForTest();
    poller._setPollBudgetForTest(10_000);
    const reconciles = () => cmds.filter((c) => c === '.jobs').length;
    // 주기 틱 3번 — 그 사이마다 범위 계정(자기 법인 Director 만)이 '지금 조회' 를 9번 누른다
    for (let cycle = 0; cycle < 3; cycle++) {
      await poller.pollOnce({ trigger: 'timer' });
      for (let k = 0; k < 9; k++) await poller.pollOnce({ trigger: 'manual', directorIds: ['dir_own_corp'] });
    }
    assert.equal(reconciles(), 1, '주기 틱 3번(대조 차례는 첫 틱뿐) — 다른 사람의 수동 조회 횟수로 대조가 늘지 않는다');
    // 101 F2: 조회 전용 계정의 수동 조회가 있어도 첫 주기 틱의 대조는 그대로
    poller._resetPollerForTest();
    await poller.pollOnce({ trigger: 'manual', reconcileOnly: new Set() });
    await poller.pollOnce({ trigger: 'timer' });
    assert.equal(reconciles(), 2, '주기 대조 차례를 수동 조회가 차지하지 않는다');
  } finally {
    poller._setPollBudgetForTest(null); poller._resetPollerForTest();
    await fd.close?.();
  }
});

/* ───────── D2: 일일 요약 메일 — 잘린 조회 ───────── */
test('D2: 일일 요약 — 잘린 조회(읽은 행 있음)는 읽은 행의 실패를 세고 진행 중 VM 만 모름 · 현황판 corpCounts 와 같은 수', async () => {
  const D = await import('../src/bareos/digest.js');
  const VV = await import('../src/bareos/vmView.js');
  const NOW = Math.floor(Date.now() / 3600_000) * 3600_000;
  const settings = { directors: [{ id: 'dHi', name: '폴란드' }, { id: 'dErr', name: '미국' }], sites: [] };
  const done = (state, status, h = 2) => ({ jobid: 10, state, status, startedAt: NOW - h * 3600_000 - 600_000, endedAt: NOW - h * 3600_000 });
  const jobs = [
    { id: 'j1', directorId: 'dHi', vcenterId: 'vp', vmName: 'fail1', bareosJob: 'p-f1', lastRun: done('error', 'f') },
    { id: 'j2', directorId: 'dHi', vcenterId: 'vp', vmName: 'ok1', bareosJob: 'p-o1', lastRun: done('ok', 'T') },
    { id: 'j3', directorId: 'dHi', vcenterId: 'vp', vmName: 'run1', bareosJob: 'p-r1', lastRun: { jobid: 11, state: 'running', status: 'R', startedAt: NOW - 600_000 } },
    { id: 'j4', directorId: 'dHi', vcenterId: 'vp', vmName: 'pend1', bareosJob: 'p-p1', lastRun: done('error', 'f'), pending: { state: 'queued' } },
    { id: 'j5', directorId: 'dErr', vcenterId: 'vu', vmName: 'u1', bareosJob: 'u-1', lastRun: done('error', 'f') },
  ];
  const dirStatus = { dHi: { ok: false, code: 'aborted', checked: 3 }, dErr: { ok: false, code: 'aborted', checked: 0 } };
  const d = D.digestData(jobs, settings, dirStatus, NOW);
  const hi = d.rows.find((c) => c.id === 'dHi');
  const err = d.rows.find((c) => c.id === 'dErr');
  assert.equal(hi.known, true, '읽은 행이 있는 잘린 조회는 법인 전체 모름이 아니다');
  assert.equal(hi.partial, true);
  assert.deepEqual([hi.fail, hi.ok, hi.unknown, hi.other], [1, 1, 2, 0], '확정 실패 1 · 성공 1 · 진행 중 2대 모름');
  assert.equal(err.known, false, '읽은 행이 없으면 예전처럼 모름');
  assert.equal(d.total.fail, 1, '제목 합에 잘린 법인의 확정 실패가 든다(예전 0)');
  assert.equal(d.total.partialCorps, 1);
  assert.deepEqual(d.fails.map((f) => f.vmName), ['fail1', 'u1'], '진행 중 VM 의 옛 실패는 실패 목록에 넣지 않는다');
  // 현황판과 같은 판정: 같은 원장 행을 bareosVmView → corpCounts(partial) 로 센 '모름' 수와 같다
  const rows = jobs.filter((j) => j.directorId === 'dHi').map((j) => ({ method: 'bareos', b: VV.bareosVmView(j, 'bareos') }));
  const st = VV.directorState({ mapped: true, configured: true, poll: dirStatus.dHi });
  assert.equal(st.partial, true);
  assert.equal(VV.corpCounts(rows, { now: NOW, partial: true }).unknown, hi.unknown);
  const m = D.renderDigest(d, NOW);
  assert.match(m.subject, /실패 1 /);
  assert.match(m.subject, /일부만 읽은 법인 1\(진행 중 2대 모름\)/);
  assert.match(m.html, /폴란드 \(일부만 읽음 — 상태 조회가 시한에 잘림 · 진행 중 2대 결과 모름\)/);
  assert.doesNotMatch(m.html, /`/);
  // 폴러 상태에서 읽은 행 수(checked)를 넘긴다
  assert.match(SRC('bareos/digest.js'), /checked: Number\(v\?\.checked\) \|\| 0/);
});

/* ───────── I1: 법인별 설정 — 스토리지 삭제 · 편집의 '매핑에 쓰는 스토리지' ───────── */
test('I1: 같은 Director 를 가리키는 다른 등록(옛 짝)의 매핑 · 백업 그룹 스토리지도 매핑 스토리지로 센다(지우지 않는다)', async () => {
  const MS = await import('../src/bareos/manage/service.js');
  const dirs = [{ id: 'dA', name: 'A', host: HOST_ADDR, port: 9101, agent: 'edge1' }, { id: 'dB', name: 'B', host: HOST_ADDR, port: 9101, consoleName: 'b', agent: 'edge1' },
    { id: 'dO', name: '다른 서버', host: '10.9.9.9', port: 9101, agent: 'edge1' }];
  const settings = { directors: dirs, sites: [{ vcenterId: 'va', directorId: 'dA', storage: 'FileA' }, { vcenterId: 'vb', directorId: 'dB', storage: 'FileB' }, { vcenterId: 'vo', directorId: 'dO', storage: 'FileO' }] };
  const groups = [{ vcenterId: 'vb', storage: 'GroupB' }, { vcenterId: 'vo', storage: 'GroupO' }];
  const k = MS.knownFor(dirs[0], { results: { storages: { ok: true, value: [] } } }, settings, groups);
  assert.deepEqual(k.mappedStorages.sort(), ['FileA', 'FileB', 'GroupB']);
});

test('D1: 새 설치 — 4단계가 등록할 Director(러너가 읽은 서버 주소 · 9101 · 담당 엣지)와 같은 Director 를 가리키는 등록에 다른 vCenter 가 묶여 있으면 사전 점검 · 시작에서 거부(7단계까지 가지 않는다)', async () => {
  reset();
  const R = fake();
  const dS = S.addDirector(dirRec({ name: '남은 등록', host: HOST_ADDR, consoleName: 'old', agent: 'edge1' })).director;
  S.saveSettings({ sites: [{ vcenterId: 'vc-s', directorId: dS.id }] });
  deps(R, target({ mode: 'install' }));
  const pre = await J.runPrecheck({ vcenterId: 'vc1', body: {} });
  assert.match(pre.bindIssue || '', /남은 등록/);
  await assert.rejects(J.startInstall({ vcenterId: 'vc1', body: {}, by: 'admin' }), (e) => e.code === 'invalid' && /같은 Director/.test(e.message));
  assert.equal(R.launches, 0);
  // 다른 담당(다른 법인 망)의 같은 주소는 막지 않는다
  S.updateDirector(dS.id, { agent: 'edge-pl' });
  const pre2 = await J.runPrecheck({ vcenterId: 'vc1', body: {} });
  assert.equal(pre2.bindIssue, undefined);
});
