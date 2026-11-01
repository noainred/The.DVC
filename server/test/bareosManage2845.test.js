/**
 * test/bareosManage2845.test.js — v2.845 법인별 Bareos 설정 · 중앙 계정 통합(bareos/manage/* · routes/api/bareosManage.js).
 *  ① 조회 정규화: 비밀번호 칸은 결과에 없다 · 멱등(엣지가 거른 값을 중앙이 다시 걸러도 같다) · 스캔 결과 정제
 *  ② 입력 판정(planManage): 이름 · Media Type 겹침 · 시스템 경로 · 동시 작업 범위 · 패키지/포탈 콘솔 · 없는 Profile · 매핑 스토리지 · 마지막 스토리지
 *  ③ 화면 미리 보기 본문 = 서버 본문(웹 bareosCorpText.js 와 글자까지) · 비밀번호 판정 같음
 *  ④ 쓰기 엔진(applyManage — 가짜 SSH): 표지 파일만 · 비밀은 명령 문자열에 없음 · 검사 실패/접속 실패면 되돌림 · SD 재시작은 실행 중 작업 0 일 때만 · 삭제 전제
 *  ⑤ SSH 출처: 배포 등록부는 Director 가 그 엣지 노드일 때만(다른 서버에 엣지 비밀번호를 쓰지 않는다)
 *  ⑥ 엣지 회신 정제 · 원장 다시 묶기(rebindJobs) · 재등록(Director 에 없는 것만 · 같은 원장 행)
 *  ⑦ 라우트: admin · 전체 범위 · 쓰기 범위 · 데모 계정 · OTP(입력 판정 뒤) · 감사에 비밀 없음 · 생성 비밀번호는 응답에 한 번 · 일괄은 법인마다 다른 비밀번호
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosmanage-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const SECRET = generateSecret();
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [
  { username: 'adm', role: 'admin', totpEnabled: true, totpSecret: SECRET },
  { username: 'noot', role: 'admin' },
] }));

const A = await import('../src/bareos/autoSetup.js');
const M = await import('../src/bareos/manage/apply.js');
const SP = await import('../src/bareos/manage/showParse.js');
const SV = await import('../src/bareos/manage/service.js');
const S = await import('../src/bareos/settings.js');
const REG = await import('../src/bareos/registry.js');
const svc = await import('../src/bareos/service.js');
const { VALUE, sanitizeEdgeResult } = await import('../src/bareos/edgeResult.js');
const { RESULT_MS, relayLimits } = await import('../src/bareos/edgeOps.js');
const W = await import('../../web/src/views/tools/bareosCorpText.js');
const { fakeServer } = await import('./_fakeBareosSsh.js');

const SSH_PW = 'ssh-Secret-123';
const SD_PW = 'sd-Secret-XYZ987';
const ACC_PW = 'Acc-Pass-0123456789';
const DIR = S.addDirector({ name: '한국 본사', host: '10.20.30.40', port: 9101, consoleName: 'portal' }).director.id;

after(() => { A._setDepsForTest(); svc._setSessionFactoryForTest(null); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

/* ───────── 가짜 서버(autoSetup 가짜 + 이 기능 명령) ───────── */
function manageServer(o = {}) {
  const srv = fakeServer({ env: 'D S C U', ...o });
  const base = srv.ssh;
  const st = srv.st;
  Object.assign(st, { all: [], run: o.run ?? '0', run2: o.run2 ?? null, sdTestCode: o.sdTestCode ?? 0, sdTestOut: o.sdTestOut ?? 'ok', loginOk: o.loginOk ?? true, volFiles: o.volFiles ?? '0', volKind: o.volKind ?? 'N',
    refs: o.refs ?? '', devRefs: o.devRefs ?? '', archUsed: o.archUsed ?? '', se: o.se ?? 'SE=off', writeOk: o.writeOk ?? true, entries: o.entries ?? '0', sdRestarts: 0, made: [], removedDirs: [], seDeleted: [], pathKind: o.pathKind ?? 'NONE', bconf: [] });
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  srv.ssh = (creds, fn, opts) => base(creds, (api) => fn({
    ...api,
    writeFile: async (p, c, mode) => { if (p.endsWith('bconsole.conf')) st.bconf.push(String(c)); return api.writeFile(p, c, mode); },
    exec: async (c) => {
      st.all.push(c);
      if (c.startsWith("o=$(printf 'llist jobs jobstatus=R")) return ok(`RUN=${st.run}\n`);
      if (c.startsWith("r=$(o=$(printf 'llist jobs jobstatus=R")) {   // 재시작 직전 같은 셸에서 다시 확인(F4)
        const r2 = st.run2 ?? st.run;
        if (r2 !== '0') return ok(`RUN=${r2}\n`);
        st.sdRestarts += 1; return ok('RUN=0\nRESTART=0\n');
      }
      if (c.includes('echo "N=$(find')) return ok(st.volKind === 'N' ? `N=${st.volFiles}\n` : `${st.volKind}\n`);
      if (c.startsWith('grep -rliE') && c.includes('Archive')) return ok(st.archUsed);
      if (c.startsWith('grep -rliE') && c.includes(')device[')) return ok(st.devRefs);
      if (c.startsWith('grep -rliE')) return ok(st.refs);
      if (c.startsWith('semanage fcontext -d')) { st.seDeleted.push(c); return ok(); }
      if (c.startsWith("sed -n 's/^[[:space:]]*Password")) return ok(`${SD_PW}\n`);
      if (c.startsWith("sed -n 's/^[[:space:]]*Name")) return ok('bareos-dir\n');
      if (c.includes('bareos-sd -t')) return { code: st.sdTestCode, stdout: st.sdTestOut, stderr: '' };
      if (c.startsWith('systemctl restart bareos-sd')) { st.sdRestarts += 1; return ok(); }
      if (c.includes('bconsole -c ')) return st.loginOk ? ok('Connecting to Director localhost:9101\nVersion: 25.0.4 (01 Jan 2026)\n') : { code: 1, stdout: 'Authorization failed.', stderr: '' };
      if (c.startsWith('if [ -L ')) return ok(`${st.pathKind}\n${st.pathKind === 'DIR' ? `ENTRIES=${st.entries}\n` : ''}CANON\n`);
      if (c.startsWith('install -d -o bareos')) { st.made.push(c.split(' ').at(-1)); return ok(); }
      if (c.startsWith('if command -v getenforce')) return ok(`${st.se}\n`);
      if (c.startsWith('runuser -u bareos -- sh -c')) return st.writeOk ? ok() : { code: 1, stdout: 'touch: Permission denied', stderr: '' };
      if (c.startsWith('[ -d ') && c.includes('rmdir')) { st.removedDirs.push(c); return ok(); }
      return api.exec(c);
    },
  }), opts);
  if (o.install !== false) A._setDepsForTest({ ssh: srv.ssh, sleep: async () => {} });
  return srv;
}
/** 서버마다 따로(일괄 작업 — 법인마다 다른 서버 · 파일시스템). */
function manageServers(hosts) {
  const by = Object.fromEntries(hosts.map((h) => [h, manageServer({ install: false })]));
  A._setDepsForTest({ ssh: (creds, fn, opts) => by[creds.host].ssh(creds, fn, opts), sleep: async () => {} });
  return by;
}
const SSH = { host: '10.20.30.40', username: 'root', password: SSH_PW };
const CP = (n) => `/etc/bareos/bareos-dir.d/console/${n}.conf`;
const noSecretIn = (st, secrets) => { for (const c of st.all) for (const s of secrets) assert.ok(!c.includes(s), `원격 명령에 비밀이 실렸다: ${c.slice(0, 120)}`); };

/* ───────── ① 조회 정규화 ───────── */
test('① show storages · consoles 의 비밀번호 칸은 결과에 없다 · 정규화는 멱등 · 스캔 결과 정제', () => {
  const raw = {
    storages: { File: { name: 'File', address: 'bareos.corp', password: 'sd-secret', device: ['FileStorage'], mediatype: ['File'], maximumconcurrentjobs: 10, port: 9103 } },
    consoles: { admin: { name: 'admin', password: 'console-secret', profile: ['webui-admin'], tlsenable: false, usepamauthentication: true } },
    profiles: { 'webui-admin': { name: 'webui-admin', commandacl: ['!configure', '*all*'] } },
  };
  const st = SP.normShowStorages(raw); const co = SP.normShowConsoles(raw); const pr = SP.normShowProfiles(raw);
  assert.ok(!JSON.stringify([st, co, pr]).includes('secret'), '비밀번호 값이 결과에 없다');
  assert.ok(!JSON.stringify([st, co]).toLowerCase().includes('password'), '비밀번호 칸 이름도 없다');
  assert.deepEqual(st[0], { name: 'File', address: 'bareos.corp', port: 9103, device: ['FileStorage'], mediaType: ['File'], maxConcurrentJobs: 10, description: '' });
  assert.equal(co[0].pam, true); assert.equal(co[0].tlsEnable, false);
  // 멱등 — 엣지가 정규화한 값을 중앙이 다시 정규화해도 같다(maxConcurrentJobs · pam 이 null 로 바뀌던 결함 고정)
  for (const k of ['storages', 'consoles', 'profiles']) {
    const once = SP.CONFIG_NORMALIZE[k](raw);
    assert.deepEqual(SP.CONFIG_NORMALIZE[k](once), once, `${k} 멱등`);
  }
  const res = SP.normConfigResult({ results: { storages: { ok: true, value: raw }, consoles: { ok: false, code: 'denied', message: 'x' }, bogus: { ok: true, value: 1 } }, version: '25.0.4' });
  assert.deepEqual(Object.keys(res.results).sort(), ['consoles', 'storages']);
  assert.ok(!JSON.stringify(res).includes('secret'));
  const sc = SP.normScanResult({ complete: true, devices: [{ file: 'a.conf', portal: true, name: 'A', archiveDevice: 'rel/path', count: '10' }], files: [{ type: 'job', name: 'x', portal: true }, { type: 'console', name: 'ops', portal: true }],
    disks: [{ path: '/v', files: 3, usedBytes: -1, availBytes: 10, sizeBytes: 20, mount: '/' }], pathCheck: { kind: 'evil', canonical: 'yes', parent: '/mnt', selinux: 'Enforcing' } });
  assert.equal(sc.devices[0].archiveDevice, '', '상대 경로는 버린다');
  assert.equal(sc.devices[0].count, 10);
  assert.deepEqual(sc.files.map((f) => f.type), ['console'], '모르는 종류는 버린다');
  assert.equal(sc.disks[0].usedBytes, null, '음수는 null(0 이 아니다)');
  assert.equal(sc.pathCheck.kind, 'unknown'); assert.equal(sc.pathCheck.canonical, false);
  assert.deepEqual(SP.normScanResult(sc), sc, '스캔 정제도 멱등');
});

/* ───────── ② 입력 판정 ───────── */
test('② planManage 판정', () => {
  const known = {
    config: { storages: [{ name: 'File', mediaType: ['File'], address: 'bareos.corp' }, { name: 'Nas', mediaType: ['NasMedia'] }], consoles: [{ name: 'portal' }, { name: 'bareos-mon' }, { name: 'ops' }], profiles: [{ name: 'webui-admin' }, { name: 'webui-readonly' }] },
    portalConsole: 'portal', address: 'bareos.corp', mappedStorages: ['File'],
  };
  const bad = (a, i, re) => assert.throws(() => M.planManage(a, i, known), (e) => e.code !== undefined && re.test(e.message), `${a} ${JSON.stringify(i)}`);
  const p = M.planManage('storage.add', { name: 'Arch', path: '/mnt/nas01/bareos', count: 8 }, known);
  assert.deepEqual([p.device, p.mediaType, p.count, p.address], ['ArchStorage', 'Arch', 8, 'bareos.corp']);
  bad('storage.add', { name: 'bad name', path: '/mnt/x/y' }, /영문/);
  bad('storage.add', { name: 'nas', path: '/mnt/x/y' }, /이미 있습니다/);
  bad('storage.add', { name: 'Arch2', mediaType: 'nasmedia', path: '/mnt/x/y' }, /Media Type/);
  bad('storage.add', { name: 'Arch3', path: '/etc/bareos' }, /시스템 경로/);
  bad('storage.add', { name: 'Arch4', path: '/mnt/x/../y' }, /\.\./);
  bad('storage.add', { name: 'Arch5', path: '/mnt/x/y', count: 51 }, /1~50/);
  bad('storage.add', { name: 'Arch6', path: '/mnt/x/y', description: 'a"b' }, /큰따옴표/);
  assert.throws(() => M.planManage('storage.add', { name: 'Arch7', path: '/mnt/x/y' }, { ...known, address: '' }), /SD 주소/);
  bad('storage.delete', { name: 'File' }, /매핑/);
  assert.throws(() => M.planManage('storage.delete', { name: 'Only' }, { config: { storages: [{ name: 'Only' }] } }), /마지막/);
  bad('console.add', { name: 'bareos-mon', profile: 'webui-admin' }, /패키지 콘솔/);
  bad('console.password', { name: 'Portal' }, /전용 콘솔/);
  bad('console.add', { name: 'ops', profile: 'webui-admin' }, /이미 있습니다/);
  bad('console.add', { name: 'new1', profile: 'nope' }, /Profile 이 없습니다/);
  bad('console.password', { name: 'ghost' }, /없습니다/);
  assert.deepEqual(M.planManage('console.add', { name: 'new1', profile: 'webui-readonly' }, known), { action: 'console.add', name: 'new1', profile: 'webui-readonly' });
  bad('pools.edit', {}, /바꿀/);
  bad('pools.edit', { pools: { fullDays: 0, incrDays: 3, maxVolumeGB: 50 } }, /보존/);
  assert.deepEqual(M.planManage('scan', {}, {}), { action: 'scan' });
  assert.deepEqual(M.planManage('scan', { path: '/mnt/nas/b' }, {}), { action: 'scan', path: '/mnt/nas/b' });
  bad('scan', { path: '/mnt/$(id)' }, /절대 경로/);
  bad('nope', {}, /알 수 없는/);
});

/* ───────── ③ 화면 = 서버 ───────── */
test('③ 미리 보기 본문 · 비밀번호 판정이 웹과 글자까지 같다', () => {
  const c = { name: 'ops-kr', password: '<pw>', profile: 'webui-readonly' };
  assert.equal(W.consoleText(c), M.consoleText(c));
  const d = { device: 'NasStorage', mediaType: 'Nas', archiveDevice: '/mnt/nas01/bareos', count: 8, description: 'NAS' };
  assert.equal(W.sdDeviceText(d), M.sdDeviceText(d));
  assert.equal(W.sdDeviceText({ ...d, description: '' }), M.sdDeviceText({ ...d, description: '' }));
  const s = { name: 'Nas', address: 'bareos.corp', sdPassword: '<sd>', device: 'NasStorage', mediaType: 'Nas', count: 8, description: '' };
  assert.equal(W.dirStorageText(s), M.dirStorageText(s));
  assert.equal(W.dirStorageText({ ...s, description: 'x' }), M.dirStorageText({ ...s, description: 'x' }));
  assert.equal(W.MARKER, A.MARKER);
  for (const pw of ['', 'short', 'a'.repeat(12), 'has space 12345', 'quote"123456789', 'back\\slash12345', 'ok-Pass_123456', M.newAccountPassword()]) assert.equal(W.passwordIssue(pw), M.passwordIssue(pw), JSON.stringify(pw));
  assert.match(M.newAccountPassword(), /^[A-Za-z0-9_-]{24}$/);
  assert.match(M.consoleText(c), /TLS Enable = No/, 'WebUI(php)는 TLS-PSK 를 못 쓴다 — 패키지 예시와 같다');
});

/* ───────── ④ 쓰기 엔진 ───────── */
test('④-1 계정 추가: 새 표지 파일 · 검사 · reload · 새 비밀번호로 접속 확인 · 비밀은 명령에 없음', async () => {
  const srv = manageServer();
  const r = await M.applyManage(M.planManage('console.add', { name: 'ops-kr', profile: 'webui-readonly' }, {}), SSH, { accountPassword: ACC_PW });
  assert.equal(r.ok, true);
  assert.deepEqual(r.files, [{ path: CP('ops-kr'), action: 'created' }]);
  const f = srv.F.get(CP('ops-kr'));
  assert.equal(f.content.split('\n')[0], A.MARKER);
  assert.match(f.content, /Password = "Acc-Pass-0123456789"/);
  assert.equal(f.mode, '0640'); assert.equal(f.owner, 'bareos');
  assert.equal(srv.st.reloads, 1);
  assert.ok(srv.st.all.some((c) => c.includes('bconsole -c ')), '새 계정으로 접속 확인');
  assert.match(srv.st.bconf[0], /\n {2}DirPort = 9101\n/, 'bconsole Director 리소스 키워드는 DirPort(번들 bconsole 바이너리 실측 — 반증 E1)');
  assert.ok(!/\n {2}Port =/.test(srv.st.bconf[0]));
  await M.applyManage(M.planManage('console.add', { name: 'ops-kr2', profile: 'webui-readonly' }, {}), SSH, { accountPassword: ACC_PW }, { dirPort: 19101 });
  assert.match(srv.st.bconf[1], /DirPort = 19101/, 'Director 포트를 따른다');
  noSecretIn(srv.st, [SSH_PW, ACC_PW]);
  assert.equal(srv.st.sdRestarts, 0, '계정은 SD 를 다시 띄우지 않는다');
});

test('④-2 계정: 접속 확인 실패 → 파일 지우고 다시 reload · 남의 파일은 바꾸지 않음 · 검사 출력의 비밀번호 가림', async () => {
  let srv = manageServer({ loginOk: false });
  await assert.rejects(M.applyManage(M.planManage('console.add', { name: 'ops-kr', profile: 'webui-readonly' }, {}), SSH, { accountPassword: ACC_PW }),
    (e) => e.code === 'console-login' && /되돌렸습니다/.test(e.message) && /다시 읽혔습니다/.test(e.message));
  assert.equal(srv.F.has(CP('ops-kr')), false);
  assert.equal(srv.st.reloads, 2);
  srv = manageServer({ files: { [CP('admin')]: 'Console {\n  Name = admin\n  Password = "human"\n}\n' } });
  await assert.rejects(M.applyManage(M.planManage('console.password', { name: 'admin' }, {}), SSH, { accountPassword: ACC_PW }), (e) => e.code === 'conflict' && /사람이 만든/.test(e.message));
  await assert.rejects(M.applyManage(M.planManage('console.delete', { name: 'admin' }, {}), SSH, {}), (e) => e.code === 'conflict');
  assert.match(srv.F.get(CP('admin')).content, /human/, '남의 파일 그대로');
  assert.equal(srv.st.reloads, 0);
  srv = manageServer({ testCode: 1, testOut: `Config error: Password = "${ACC_PW}" line 3\nother Password = "zzz"` });
  await assert.rejects(M.applyManage(M.planManage('console.add', { name: 'x1', profile: 'p' }, {}), SSH, { accountPassword: ACC_PW }), (e) => {
    assert.equal(e.code, 'config-test');
    assert.ok(!e.message.includes(ACC_PW) && !e.message.includes('zzz'), e.message);
    return true;
  });
  assert.equal(srv.F.has(CP('x1')), false, '검사 실패 → 새 파일 삭제');
  assert.equal(srv.st.reloads, 0, '검사 실패면 reload 하지 않는다');
});

test('④-3 비밀번호 변경 · 삭제: 포탈 파일의 Profile 을 그대로 · 지우면 reload', async () => {
  const old = M.consoleText({ name: 'ops-kr', password: 'old-Pass-123456', profile: 'webui-admin' });
  const srv = manageServer({ files: { [CP('ops-kr')]: old } });
  const r = await M.applyManage(M.planManage('console.password', { name: 'ops-kr' }, {}), SSH, { accountPassword: ACC_PW });
  assert.deepEqual(r.files, [{ path: CP('ops-kr'), action: 'updated' }]);
  assert.match(srv.F.get(CP('ops-kr')).content, /Profile = "webui-admin"[\s\S]*TLS Enable = No/);
  assert.ok(!srv.F.get(CP('ops-kr')).content.includes('old-Pass'));
  await assert.rejects(M.applyManage(M.planManage('console.password', { name: 'ops-kr' }, {}), SSH, { accountPassword: 'short' }), (e) => e.code === 'invalid');
  const d = await M.applyManage(M.planManage('console.delete', { name: 'ops-kr' }, {}), SSH, {});
  assert.deepEqual(d.files, [{ path: CP('ops-kr'), action: 'deleted' }]);
  assert.equal(srv.F.has(CP('ops-kr')), false);
});

test('④-4 스토리지 추가: 실행 중 작업 0 일 때만 · SD 비밀번호는 서버 안에서 읽어 파일에만 · 장치 Count = MCJ · 검사 실패면 되돌리고 만든 디렉터리도', async () => {
  const known = { config: { storages: [{ name: 'File', mediaType: ['File'], address: 'bareos.corp' }] }, address: 'bareos.corp' };
  const plan = M.planManage('storage.add', { name: 'Nas', path: '/mnt/nas01/bareos', count: 6 }, known);
  for (const run of ['2', 'unknown']) {
    const srv = manageServer({ run });
    await assert.rejects(M.applyManage(plan, SSH, {}), (e) => e.code === 'conflict' && /아무것도 바꾸지 않았습니다/.test(e.message));
    assert.equal(srv.st.made.length, 0); assert.equal([...srv.F.keys()].filter((k) => k.startsWith('/etc/bareos')).length, 0); assert.equal(srv.st.sdRestarts, 0);
  }
  let srv = manageServer();
  const r = await M.applyManage(plan, SSH, {});
  assert.deepEqual(r.files.map((f) => f.action), ['created', 'created']);
  assert.equal(r.restarted, true); assert.equal(srv.st.sdRestarts, 1); assert.equal(srv.st.reloads, 1);
  const dev = srv.F.get('/etc/bareos/bareos-sd.d/device/NasStorage.conf').content;
  const sto = srv.F.get('/etc/bareos/bareos-dir.d/storage/Nas.conf').content;
  assert.match(dev, /Archive Device = \/mnt\/nas01\/bareos[\s\S]*Count = 6/);
  assert.match(sto, new RegExp(`Password = "${SD_PW}"[\\s\\S]*Maximum Concurrent Jobs = 6`));
  assert.deepEqual(srv.st.made, ['/mnt/nas01/bareos']);
  noSecretIn(srv.st, [SSH_PW, SD_PW]);
  assert.ok(srv.st.all.findIndex((c) => c.includes('bareos-sd -t')) < srv.st.all.findIndex((c) => c.includes('systemctl restart bareos-sd')), '검사 → 재시작 순서');
  srv = manageServer({ sdTestCode: 1, sdTestOut: `Error: Password = "${SD_PW}"` });
  await assert.rejects(M.applyManage(plan, SSH, {}), (e) => e.code === 'config-test' && !e.message.includes(SD_PW) && /되돌렸습니다/.test(e.message));
  assert.equal(srv.F.has('/etc/bareos/bareos-sd.d/device/NasStorage.conf'), false);
  assert.equal(srv.F.has('/etc/bareos/bareos-dir.d/storage/Nas.conf'), false);
  assert.equal(srv.st.sdRestarts, 0, '검사 실패면 재시작하지 않는다');
  assert.ok(srv.st.removedDirs.some((c) => c.includes('rmdir /mnt/nas01/bareos')), '이번에 만든 디렉터리는 지운다(비었을 때만 — rmdir)');
  // F4(반증 — 재현): 쓰기 전 확인 뒤 · 재시작 직전에 실행 중 작업이 생기면 재시작하지 않고 되돌린다
  srv = manageServer({ run2: '1' });
  await assert.rejects(M.applyManage(plan, SSH, {}), (e) => e.code === 'conflict' && /SD 를 다시 띄우지 않았습니다/.test(e.message) && /되돌렸습니다/.test(e.message));
  assert.equal(srv.st.sdRestarts, 0);
  assert.equal(srv.F.has('/etc/bareos/bareos-dir.d/storage/Nas.conf'), false);
  assert.equal(srv.st.reloads, 0, 'reload 전이라 다시 읽히지 않는다');
  // F5(반증 — 재현): 쓰기 시험 실패(파일을 놓기 전)여도 만든 디렉터리 · 넣은 SELinux 규칙을 되돌린다
  srv = manageServer({ writeOk: false, se: 'SE=added' });
  await assert.rejects(M.applyManage(plan, SSH, {}), (e) => e.code === 'remote' && /쓰지 못했습니다/.test(e.message));
  assert.ok(srv.st.removedDirs.some((c) => c.includes('rmdir /mnt/nas01/bareos')));
  assert.equal(srv.st.seDeleted.length, 1, '이번에 넣은 SELinux 규칙 지움');
  srv = manageServer({ writeOk: false, se: 'SE=had' });
  await assert.rejects(M.applyManage(plan, SSH, {}));
  assert.equal(srv.st.seDeleted.length, 0, '원래 있던 규칙은 지우지 않는다');
  // F2(반증 — 재현): 이미 있는 비어 있지 않은 디렉터리 · 데이터 경로는 받지 않는다(재라벨하지 않는다)
  srv = manageServer({ pathKind: 'DIR', entries: '1' });
  await assert.rejects(M.applyManage(plan, SSH, {}), (e) => e.code === 'invalid' && /이미 파일/.test(e.message));
  assert.ok(!srv.st.all.some((c) => c.startsWith('if command -v getenforce')), 'SELinux 명령을 돌리지 않았다');
  srv = manageServer({ pathKind: 'DIR', entries: '0' });
  assert.equal((await M.applyManage(plan, SSH, {})).ok, true, '빈 디렉터리는 받는다');
  assert.equal(srv.st.made.length, 0, '이미 있던 디렉터리는 만들지 않았다');
  for (const bad of ['/var/lib/pgsql/bk', '/var/log/bareos', '/var/lib/bareos', '/var/spool/x']) assert.throws(() => M.planManage('storage.add', { name: 'Z1', path: bad }, known), /데이터 경로/, bad);
  assert.equal(M.dataDirIssue('/var/lib/bareos/storage2'), '', 'Bareos 저장 경로 아래는 된다');
  // F6(반증 — 재현): 다른 SD 장치가 같은 경로를 쓰면 거부
  srv = manageServer({ archUsed: '/etc/bareos/bareos-sd.d/device/FileStorage.conf\n' });
  await assert.rejects(M.applyManage(plan, SSH, {}), (e) => e.code === 'conflict' && /FileStorage\.conf/.test(e.message));
  assert.equal(srv.st.made.length, 0);
});

test('④-5 스토리지 편집 · 삭제: 포탈 파일만 · SD 비밀번호는 옛 파일 그대로 · 볼륨 · 참조가 있으면 지우지 않음', async () => {
  const dev = M.sdDeviceText({ device: 'NasStorage', mediaType: 'Nas', archiveDevice: '/mnt/nas01/bareos', count: 10, description: '' });
  const sto = M.dirStorageText({ name: 'Nas', address: 'bareos.corp', sdPassword: 'keep-SD-pw', device: 'NasStorage', mediaType: 'Nas', count: 10, description: '' });
  const files = { '/etc/bareos/bareos-sd.d/device/NasStorage.conf': dev, '/etc/bareos/bareos-dir.d/storage/Nas.conf': sto };
  let srv = manageServer({ files });
  const r = await M.applyManage(M.planManage('storage.edit', { name: 'Nas', count: 4, description: 'NAS 보관' }, {}), SSH, {});
  assert.deepEqual(r.files.map((f) => f.action), ['updated', 'updated']);
  assert.match(srv.F.get('/etc/bareos/bareos-sd.d/device/NasStorage.conf').content, /Count = 4/);
  assert.match(srv.F.get('/etc/bareos/bareos-dir.d/storage/Nas.conf').content, /Password = "keep-SD-pw"[\s\S]*Maximum Concurrent Jobs = 4[\s\S]*Description = "NAS 보관"/);
  assert.ok(!srv.st.all.some((c) => c.startsWith("sed -n 's/^[[:space:]]*Password")), '편집은 SD 비밀번호를 다시 읽지 않는다');
  srv = manageServer({ files: { ...files, '/etc/bareos/bareos-dir.d/storage/Human.conf': 'Storage {\n  Name = Human\n  Device = X\n}\n' } });
  await assert.rejects(M.applyManage(M.planManage('storage.edit', { name: 'Human', count: 2 }, {}), SSH, {}), (e) => e.code === 'conflict' && /사람이 만든/.test(e.message));
  for (const [o, re] of [[{ volFiles: '3' }, /볼륨 파일이 3개/], [{ refs: '/etc/bareos/bareos-dir.d/pool/P.conf\n' }, /쓰는 설정이 있습니다\(P\.conf\)/]]) {
    srv = manageServer({ files, ...o });
    await assert.rejects(M.applyManage(M.planManage('storage.delete', { name: 'Nas' }, {}), SSH, {}), (e) => e.code === 'conflict' && re.test(e.message));
    assert.ok(srv.F.has('/etc/bareos/bareos-dir.d/storage/Nas.conf'), '지우지 않았다');
  }
  srv = manageServer({ files });
  const d = await M.applyManage(M.planManage('storage.delete', { name: 'Nas' }, {}), SSH, {});
  assert.deepEqual(d.files.map((f) => f.action), ['deleted', 'deleted']);
  assert.equal(srv.F.has('/etc/bareos/bareos-sd.d/device/NasStorage.conf'), false);
  assert.equal(srv.st.removedDirs.length, 0, '볼륨 디렉터리는 지우지 않는다(F6 — 원래 있던 · 나눠 쓰는 디렉터리일 수 있다)');
  // F3(반증 — 재현): 주석이 붙은 Archive Device 도 읽어 볼륨 수를 센다 · 못 읽으면 · 심링크면 멈춘다
  const devC = dev.replace('Archive Device = /mnt/nas01/bareos', 'Archive Device = /mnt/nas01/bareos   # moved disk');
  srv = manageServer({ files: { ...files, '/etc/bareos/bareos-sd.d/device/NasStorage.conf': devC }, volFiles: '37' });
  await assert.rejects(M.applyManage(M.planManage('storage.delete', { name: 'Nas' }, {}), SSH, {}), (e) => /볼륨 파일이 37개/.test(e.message));
  const devX = dev.replace('Archive Device = /mnt/nas01/bareos', 'Archive Device = relative/dir');
  srv = manageServer({ files: { ...files, '/etc/bareos/bareos-sd.d/device/NasStorage.conf': devX } });
  await assert.rejects(M.applyManage(M.planManage('storage.delete', { name: 'Nas' }, {}), SSH, {}), (e) => e.code === 'conflict' && /볼륨 경로를 읽지 못했습니다/.test(e.message));
  srv = manageServer({ files, volKind: 'LINK' });
  await assert.rejects(M.applyManage(M.planManage('storage.delete', { name: 'Nas' }, {}), SSH, {}), (e) => e.code === 'conflict' && /심링크/.test(e.message));
  srv = manageServer({ files, devRefs: '/etc/bareos/bareos-dir.d/storage/Other.conf\n' });
  await assert.rejects(M.applyManage(M.planManage('storage.delete', { name: 'Nas' }, {}), SSH, {}), (e) => e.code === 'conflict' && /Other\.conf/.test(e.message));
  assert.ok(srv.F.has('/etc/bareos/bareos-sd.d/device/NasStorage.conf'));
});

test('④-6 포탈 풀 편집: 포탈 파일이 있어야(없으면 아무것도 쓰지 않음) · 바뀐 값만', async () => {
  let srv = manageServer();
  await assert.rejects(M.applyManage(M.planManage('pools.edit', { pools: { fullDays: 60, incrDays: 20, maxVolumeGB: 40 } }, {}), SSH, {}), (e) => e.code === 'conflict');
  assert.equal(srv.st.reloads, 0);
  const res = A.directorResources({ defaults: {}, consoleName: 'x', consolePassword: 'x', restoreClient: 'x', restoreStorage: 'x', restorePool: 'x', pools: { fullDays: 90, incrDays: 30, maxVolumeGB: 50 }, schedule: { fullDay: 'sun', time: '02:00' } });
  const files = Object.fromEntries(res.filter((x) => x.type === 'pool' || x.type === 'schedule').map((x) => [`/etc/bareos/bareos-dir.d/${x.type}/${x.name}.conf`, `${A.MARKER}\n${x.text}\n`]));
  srv = manageServer({ files });
  const r = await M.applyManage(M.planManage('pools.edit', { schedule: { fullDay: 'sat', time: '03:30' } }, {}), SSH, {});
  assert.deepEqual(r.files.map((f) => f.path), ['/etc/bareos/bareos-dir.d/schedule/PortalVmwareNightly.conf'], '스케줄만');
  assert.match(srv.F.get('/etc/bareos/bareos-dir.d/schedule/PortalVmwareNightly.conf').content, /Run = Full sat at 03:30/);
  assert.match(srv.F.get('/etc/bareos/bareos-dir.d/pool/PortalVmwareFull.conf').content, /90 days/, '풀은 그대로');
});

test('④-7 디스크 읽기(scan): 쓰기 없음 · 섹션 파싱 · 경로 점검', async () => {
  const text = ['@@sd', 'FileStorage.conf|0|FileStorage|/var/lib/bareos/storage|10', 'NasStorage.conf|1|NasStorage|/mnt/nas01/bareos|6', '@@files', 'console|ops|1', 'storage|File|0',
    '@@disk', '/var/lib/bareos/storage|12|1024|2048|4096|/var', '/mnt/gone|missing', '@@path', 'KIND=NONE', 'CANON=1', 'PARENT=/mnt', 'DF=100|200|/mnt', 'FS=nfs4', 'SE=Enforcing', '@@end'].join('\n');
  const p = M.parseScan(text);
  assert.equal(p.complete, true);
  assert.deepEqual(p.devices[1], { file: 'NasStorage.conf', portal: true, name: 'NasStorage', archiveDevice: '/mnt/nas01/bareos', count: 6 });
  assert.deepEqual(p.disks[0], { path: '/var/lib/bareos/storage', files: 12, usedBytes: 1024 * 1024, availBytes: 2048 * 1024, sizeBytes: 4096 * 1024, mount: '/var' });
  assert.deepEqual(p.disks[1], { path: '/mnt/gone', missing: true });
  assert.deepEqual(p.pathCheck, { kind: 'none', canonical: true, parent: '/mnt', availBytes: 100 * 1024, sizeBytes: 200 * 1024, mount: '/mnt', fsType: 'nfs4', files: null, selinux: 'Enforcing' });
  assert.equal(M.parseScan('@@sd\n').complete, false, '끝 표지가 없으면 완전하지 않다');
  assert.ok(!M.scanScript().includes('@@path'));
  assert.ok(M.scanScript('/mnt/nas01/bareos').includes('@@path'));
  assert.ok(!M.scanScript('/mnt/$(id)').includes('$(id)'), '판정을 지나지 않은 경로는 명령에 넣지 않는다');
});

/* ───────── ⑤ SSH 출처 ───────── */
test('⑤ SSH 출처: 배포 등록부는 Director 가 그 엣지 노드일 때만', () => {
  const settings = { sites: [{ vcenterId: 'vc-a', directorId: 'd1' }] };
  const inventory = [{ vcenterId: 'vc-a', agent: 'edge-kr' }];
  const t = { id: 't1', agentName: 'edge-kr', host: '10.0.0.5', port: 22, username: 'root', password: 'pw' };
  const src = (d, o = {}) => SV.sshSourceFor(d, { settings, inventory, deployTargets: [t], ...o });
  assert.equal(src({ id: 'd1', host: '10.0.0.5', agent: '' }).source, 'registry', '주소가 같다');
  assert.equal(src({ id: 'd1', host: '10.0.0.9', agent: '' }).source, 'input', '다른 서버에 엣지 비밀번호를 쓰지 않는다');
  assert.equal(src({ id: 'd1', host: '10.0.0.9', agent: '' }).host, '10.0.0.9', '입력 칸에 Director 주소를 미리 채운다');
  assert.equal(src({ id: 'd1', host: 'bareos-kr.corp', agent: '' }, { known: new Map([['vc-a', 'bareos-kr.corp']]) }).source, 'registry', '완전 설치가 그 엣지에 설치한 Director');
  assert.equal(src({ id: 'd1', host: '127.0.0.1', agent: 'edge-kr' }).source, 'registry', '담당 엣지가 루프백으로 붙는 Director');
  // F1(반증 — 재현): 담당 엣지가 다르면 다른 엣지의 등록부 계정을 그 엣지로 보내지 않는다
  assert.equal(src({ id: 'd1', host: '10.0.0.5', agent: 'edge-pl' }).source, 'input');
  assert.equal(src({ id: 'd1', host: 'bareos-kr.corp', agent: 'edge-pl' }, { known: new Map([['vc-a', 'bareos-kr.corp']]) }).source, 'input');
  assert.equal(src({ id: 'd1', host: '10.0.0.5', agent: 'edge-kr' }).source, 'registry', '같은 엣지면 된다');
  const lo = src({ id: 'd1', host: '127.0.0.1', agent: '' });
  assert.equal(lo.source, 'input'); assert.equal(lo.host, '', '루프백은 입력 칸에 채우지 않는다');
  assert.equal(SV.sshSourceFor({ id: 'd1', host: '10.0.0.5', agent: '' }, { settings, inventory, deployTargets: [{ ...t, password: '' }] }).source, 'input', '비밀번호 없는 대상은 쓰지 않는다');
  assert.ok(!JSON.stringify(SV.publicSsh(src({ id: 'd1', host: '10.0.0.5', agent: '' }))).includes('pw"'), '공개용에 비밀번호 · 대상 id 없음');
  assert.equal(SV.publicSsh(src({ id: 'd1', host: '10.0.0.5', agent: '' })).targetId, undefined);
});

/* ───────── ⑥ 엣지 회신 · 원장 · 재등록 ───────── */
test('⑥-1 엣지 회신 정제 · 회신 시한', () => {
  const P1 = '/etc/bareos/bareos-dir.d/console/x.conf';
  const m = sanitizeEdgeResult('setup.manage', { ok: true, value: { files: [{ path: P1, action: 'created', content: 'secret' }, { path: '/etc/x.conf\nforged', action: 'created' }], restarted: true, reloaded: 'yes', extra: 1 } });
  assert.deepEqual(m, { ok: true, value: { files: [{ path: P1, action: 'created' }], restarted: true, reloaded: false } }, '포탈 리소스 파일 모양이 아닌 경로는 버린다(반증 E5)');
  const empty = sanitizeEdgeResult('setup.manage', { ok: true, value: { files: [] } });
  assert.equal(empty.ok, false, '바꾼 파일 목록이 없으면 성공으로 받지 않는다');
  assert.ok(VALUE['setup.scan']);
  const lim = relayLimits();
  for (const k of ['setup.manage', 'setup.scan']) assert.ok(lim.secretPickupMs + RESULT_MS[k] <= 600_000, `${k}: 인출 대기 + 회신 시한 ≤ 포탈 요청 시한`);
  assert.ok(RESULT_MS['setup.manage'] > A.BUDGET.sessionMs, '회신 시한 > SSH 세션 예산');
});

test('⑥-0 knownFor: SD 주소는 주소가 있는 스토리지에서(주소가 빈 File 을 고르지 않는다 — 반증 F9)', () => {
  const cfg = { results: { storages: { ok: true, value: [{ name: 'File', address: '' }, { name: 'Nas', address: 'bareos.corp' }] } } };
  assert.equal(SV.knownFor({ id: 'x', consoleName: 'portal' }, cfg, { sites: [] }).address, 'bareos.corp');
  assert.equal(SV.knownFor({ id: 'x' }, null, { sites: [] }).address, '', '설정을 못 읽으면 빈 값(추가 판정이 막는다)');
});

test('⑥-2 rebindJobs: 같은 원장 행(이력 그대로)에 새 이름 · 매핑 — 한 번의 쓰기', () => {
  const j = REG.addJob({ vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'app-01', dc: 'DC', folder: '/', directorId: DIR, bareosJob: 'pv-old', client: 'c0', storage: 's0', pool: 'p0', schedule: 'S', level: 'Full', createdBy: 'adm' });
  REG.patchJob(j.id, { lastRun: { jobid: 7, status: 'T' }, missingInDirector: true });
  REG.retireName('pv-new', false, DIR);
  const [r] = REG.rebindJobs([{ id: j.id, bareosJob: 'pv-new', client: 'c1', storage: 's1', pool: 'p1' }]);
  assert.equal(r.ok, true);
  const g = REG.getJob(j.id);
  assert.deepEqual([g.bareosJob, g.client, g.storage, g.pool, g.missingInDirector, g.schedule, g.level], ['pv-new', 'c1', 's1', 'p1', false, 'S', 'Full']);
  // v2.846 D-1: 재설치 뒤 새 카탈로그는 jobid 를 1 부터 — jobid 로 비교하는 칸은 새로 시작하고(요약만 beforeRebind) runsEpoch 를 남긴다
  assert.equal(g.lastRun, null); assert.deepEqual(g.finishedRuns, []); assert.deepEqual(g.restores, []);
  assert.equal(g.beforeRebind.lastRun.jobid, 7); assert.ok(g.runsEpoch > 0);
  assert.ok(!REG.retiredNames().some((x) => x.name === 'pv-new' && x.directorId === DIR), '같은 Director 에서 다시 쓴 이름은 지운 잡이 아니다');
  assert.equal(REG.rebindJobs([{ id: 'nope', bareosJob: 'a', client: 'b', storage: 'c', pool: 'd' }])[0].ok, false);
  assert.equal(REG.rebindJobs([{ id: j.id, bareosJob: '', client: 'b', storage: 'c', pool: 'd' }])[0].ok, false);
  REG.deleteJob(j.id, { directorId: DIR });
});

/* ───────── ⑦ 라우트 ───────── */
let srvHttp; let base; let store; let auditMod;
const USERS = {
  admin: { username: 'adm', role: 'admin', scope: null },
  noot: { username: 'noot', role: 'admin', scope: null },
  op: { username: 'op', role: 'operator', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-a'] } },
  wadm: { username: 'adm', role: 'admin', scope: { writeVcenters: ['vc-a'] } },
  demo: { username: 'thedvcdemp', role: 'admin', demoGuest: true, scope: null },
};
const CFG_MAP = () => ({
  'show storages': { storages: { File: { name: 'File', address: 'bareos.corp', password: 'sd-secret', device: ['FileStorage'], mediatype: ['File'], maximumconcurrentjobs: 10 } } },
  'show consoles': { consoles: { portal: { name: 'portal', password: 'p', profile: ['portal'] }, admin: { name: 'admin', password: 'h', profile: ['webui-admin'] } } },
  'show profiles': { profiles: { 'webui-admin': { name: 'webui-admin' }, 'webui-readonly': { name: 'webui-readonly' } } },
  'llist pools': { pools: [] },
  'show schedules': { schedules: {} },
});
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  ({ store } = await import('../src/store.js'));
  auditMod = await import('../src/audit.js');
  store.snapshot = { generatedAt: Date.now(), source: 'mock', vcenters: [{ id: 'vc-a', name: 'Seoul', host: 'https://vc-a.corp' }], hosts: [], datastores: [], vms: [], alarms: [], networks: [] };
  S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: DIR, vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'File', pool: 'VMwareKR', configFile: '/etc/bareos/vmware/vc-a.ini' }] });
  svc._setSessionFactoryForTest(async () => ({ info: { banner: 'OK: bareos-dir Version: 25.0.4 (01 Jan 2026)' }, call: async (cmd) => { const v = CFG_MAP()[cmd]; if (!v) throw Object.assign(new Error('bad'), { code: 'jsonrpc' }); return v; }, close() {} }));
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srvHttp = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srvHttp.address().port}/api/tools/bareos-backup/settings`;
});
after(() => { try { srvHttp?.close(); } catch { /* */ } });
async function req(u, p, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
}
const auditText = () => { try { return fs.readFileSync(path.join(tmp, 'audit.ndjson'), 'utf8'); } catch { return JSON.stringify(auditMod.recentAudit?.(500) || []); } };

test('⑦-1 조회: 권한 · 범위 · 비밀번호 칸 없음 · 데모 계정은 설정 경로 전체가 막힘(READ_DENY)', async () => {
  for (const u of ['op', 'sadm']) assert.equal((await req(u, '/corp')).s, 403, u);
  const l = await req('admin', '/corp');
  assert.equal(l.s, 200);
  assert.equal(l.j.directors[0].ssh.source, 'input');
  const c = await req('admin', `/corp/${DIR}/config?refresh=1`);
  assert.equal(c.s, 200);
  assert.ok(!c.t.includes('sd-secret') && !c.t.toLowerCase().includes('password'), '설정 응답에 비밀번호 없음');
  assert.deepEqual(c.j.mappedStorages, ['File']);
  const a = await req('admin', '/accounts?refresh=1');
  assert.equal(a.s, 200);
  assert.deepEqual(a.j.names, ['admin'], '포탈 전용 콘솔은 통합 목록에서 뺀다');
  const { READ_DENY } = await import('../src/auth/demoGuest.js');
  assert.ok(READ_DENY.some((p) => '/api/tools/bareos-backup/settings/corp'.startsWith(`${p}/`)), '데모 계정 READ_DENY 접두가 덮는다');
});

test('⑦-2 쓰기 문지기: 쓰기 범위 · 데모 · OTP 미등록 · 입력 오류는 OTP 를 쓰지 않는다 · 성공 · 감사에 비밀 없음 · 생성 비밀번호는 응답에 한 번', async () => {
  const srv = manageServer();
  const body = (o = {}) => ({ action: 'console.add', input: { name: 'ops-kr', profile: 'webui-readonly' }, generate: true, ssh: { host: '10.20.30.40', username: 'root', password: SSH_PW }, ...o });
  const w = await req('wadm', `/corp/${DIR}/manage`, body({ otp: '123456' }));
  assert.equal(w.s, 403); assert.equal(w.j.error, 'forbidden', '쓰기 범위 지정 계정은 fullWriteOnly 가 막는다(OTP 단계가 아니라)');
  for (const p of ['/accounts/bulk', `/corp/${DIR}/scan`, `/corp/${DIR}/reregister`]) assert.equal((await req('wadm', p, { action: 'console.add', name: 'x1', directorIds: [DIR], ids: ['x'] })).j?.error, 'forbidden', p);
  const dg = await req('demo', `/corp/${DIR}/manage`, body());
  assert.equal(dg.s, 403); assert.equal(dg.j.demoGuest, true);
  const ne = await req('noot', `/corp/${DIR}/manage`, body());
  assert.equal(ne.s, 403); assert.equal(ne.j.needEnroll, true);
  const code = generateToken(SECRET);
  const bad = await req('admin', `/corp/${DIR}/manage`, body({ input: { name: 'bad name', profile: 'webui-readonly' }, otp: code }));
  assert.equal(bad.s, 400, '입력 오류는 OTP 전에');
  const noSsh = await req('admin', `/corp/${DIR}/manage`, body({ ssh: { host: '10.20.30.40' }, otp: code }));
  assert.equal(noSsh.s, 400); assert.equal(noSsh.j.needSsh, true);
  assert.equal((await req('admin', `/corp/${DIR}/manage`, body({ otp: '000000' }))).s, 403, '틀린 OTP');
  assert.equal(srv.st.all.length, 0, '여기까지 원격에 닿지 않았다');
  const okr = await req('admin', `/corp/${DIR}/manage`, body({ otp: code }));
  assert.equal(okr.s, 200, okr.t);
  assert.match(okr.j.generatedPassword, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(srv.st.creds.password, SSH_PW);
  const gen = okr.j.generatedPassword;
  assert.ok(srv.F.get(CP('ops-kr')).content.includes(gen));
  const au = auditText();
  assert.ok(au.includes('Bareos 법인 설정(WebUI 계정 추가)'), '감사 기록');
  assert.ok(!au.includes(gen) && !au.includes(SSH_PW), '감사에 비밀번호 없음');
  noSecretIn(srv.st, [SSH_PW, gen]);
  // 1회용 OTP — 같은 코드 재사용은 거부(입력 판정은 통과하는 요청으로)
  const again = await req('admin', `/corp/${DIR}/manage`, body({ input: { name: 'ops-kr2', profile: 'webui-readonly' }, otp: code }));
  assert.equal(again.s, 403); assert.equal(again.j.otpRequired, true);
  assert.equal(srv.F.has(CP('ops-kr2')), false);
});

test('⑦-3 일괄: 법인마다 다른 생성 비밀번호 · SSH 없는 법인은 보내지 않음 · 결과 표', async () => {
  const D2 = S.addDirector({ name: '미국 법인', host: '10.30.0.5', port: 9101, consoleName: 'portal' }).director.id;
  const D3 = S.addDirector({ name: '독일 법인', host: '10.40.0.5', port: 9101, consoleName: 'portal' }).director.id;
  const srvs = manageServers(['10.20.30.40', '10.30.0.5']);
  const code = generateToken(SECRET, { counter: Math.floor(Date.now() / 1000 / 30) + 1 });   // ⑦-2 가 이번 창의 코드를 썼다 — 다음 창(허용 오차 안)
  try {
    // F7(반증 — 재현): 보낼 법인이 없으면(모두 SSH 필요) OTP 를 쓰지 않고 400 — 같은 코드로 아래 일괄이 통과해야 한다
    const none = await req('admin', '/accounts/bulk', { action: 'console.add', name: 'audit-ro', profile: 'webui-readonly', directorIds: [D3], generate: true, otp: code });
    assert.equal(none.s, 400); assert.equal(none.j.needSsh, true);
    const r = await req('admin', '/accounts/bulk', { action: 'console.add', name: 'audit-ro', profile: 'webui-readonly', directorIds: [DIR, D2, D3], generate: true, otp: code,
      ssh: { [DIR]: { host: '10.20.30.40', username: 'root', password: SSH_PW }, [D2]: { host: '10.30.0.5', username: 'root', password: SSH_PW } } });
    assert.equal(r.s, 200, r.t);
    const by = Object.fromEntries(r.j.results.map((x) => [x.directorId, x]));
    assert.equal(by[DIR].status, 'done'); assert.equal(by[D2].status, 'done');
    assert.match(by[DIR].generatedPassword, /^[A-Za-z0-9_-]{24}$/);
    assert.notEqual(by[DIR].generatedPassword, by[D2].generatedPassword, '법인마다 다른 비밀번호');
    assert.equal(by[D3].status, 'skipped'); assert.equal(by[D3].needSsh, true); assert.equal(by[D3].generatedPassword, undefined);
    assert.equal(r.j.passwordMode, 'per-corp-generated');
    const au = auditText();
    assert.ok(!au.includes(by[DIR].generatedPassword) && !au.includes(by[D2].generatedPassword), '감사에 비밀번호 없음');
    for (const x of Object.values(srvs)) noSecretIn(x.st, [SSH_PW, by[DIR].generatedPassword, by[D2].generatedPassword]);
    assert.ok(srvs['10.30.0.5'].F.get(CP('audit-ro')).content.includes(by[D2].generatedPassword), '그 법인 파일에는 그 법인 비밀번호');
  } finally { S.deleteDirector(D2); S.deleteDirector(D3); }
});

/* ───────── ⑥-3 재등록(라우트 준비 뒤 — 매핑 · 세션 대역) ───────── */
test('⑥-3 재등록: Director 에 없는 원장 대상만 · 화면 목록을 믿지 않음 · 같은 원장 행(이력 그대로) · 지금 매핑으로 · 라우트', async () => {
  const prevSnap = store.snapshot;
  store.snapshot = { ...prevSnap, vms: [
    { id: 'vc-a:vm-10', vcenterId: 'vc-a', name: 'app-10', powerState: 'POWERED_ON', vcDcPath: 'DC-A', folderPath: '/app' },
    { id: 'vc-a:vm-11', vcenterId: 'vc-a', name: 'app-11', powerState: 'POWERED_ON', vcDcPath: 'DC-A', folderPath: '/app' },
  ] };
  const mk = (vmId, vmName, bareosJob) => REG.addJob({ vcenterId: 'vc-a', vmId, vmName, dc: 'DC-A', folder: '/app', directorId: DIR, bareosJob, client: 'old-fd', storage: 'old-sd', pool: 'old-pool', schedule: '', level: 'Incremental', createdBy: 'adm' });
  const gone = mk('vc-a:vm-10', 'app-10', 'pv-vc-a-vm-10');
  const here = mk('vc-a:vm-11', 'app-11', 'pv-vc-a-vm-11');
  REG.patchJob(gone.id, { lastRun: { jobid: 41, status: 'T' }, enabled: false });
  const sent = [];
  svc._setSessionFactoryForTest(async () => ({
    info: { banner: 'OK: bareos-dir Version: 25.0.4 (01 Jan 2026)' }, close() {},
    call: async (cmd) => {
      sent.push(cmd);
      if (cmd === '.jobs') return { jobs: [{ name: here.bareosJob }] };
      if (cmd.startsWith('configure add job')) return { add: { name: /name=(\S+)/.exec(cmd)[1] } };
      const v = CFG_MAP()[cmd]; if (!v) throw Object.assign(new Error('bad'), { code: 'jsonrpc' }); return v;
    },
  }));
  try {
    const d = S.directorById(DIR);
    assert.deepEqual((await SV.missingTargets(d)).map((m) => m.id), [gone.id]);
    const m = await req('admin', `/corp/${DIR}/missing`);
    assert.deepEqual(m.j.items.map((x) => [x.id, x.enabled]), [[gone.id, false]]);
    assert.equal((await req('demo', `/corp/${DIR}/reregister`, { ids: [gone.id] })).s, 403);
    assert.equal((await req('wadm', `/corp/${DIR}/reregister`, { ids: [gone.id] })).j?.error, 'forbidden');
    const r = await req('admin', `/corp/${DIR}/reregister`, { ids: [gone.id, here.id, 'bj_nope'] });
    assert.equal(r.s, 200, r.t);
    assert.deepEqual(r.j.results.map((x) => [x.id, x.ok]), [[gone.id, true]], 'Director 에 있는 대상 · 원장에 없는 id 는 건드리지 않는다');
    const add = sent.filter((c) => c.startsWith('configure add job'));
    assert.equal(add.length, 1);
    assert.match(add[0], /client=kr-fd storage=File pool=VMwareKR/, '지금 매핑으로');
    assert.ok(!/schedule=/.test(add[0]), '원장 스케줄이 비었으면(그룹 잡) 스케줄 없이');
    const g = REG.getJob(gone.id);
    assert.deepEqual([g.id, g.client, g.storage, g.pool, g.beforeRebind.lastRun.jobid, g.lastRun, g.enabled, g.missingInDirector], [gone.id, 'kr-fd', 'File', 'VMwareKR', 41, null, false, false], '같은 행 · 꺼짐 그대로 · 실행 기록은 새로 시작(D-1)');
    // F8(반증 — 재현): 잡을 만든 사이 원장 행이 사라져 묶지 못하면 그 잡을 끈다(원장 밖 스케줄 잡이 켜진 채 남지 않게)
    REG.deleteJob(here.id, { directorId: DIR });
    const lost = mk('vc-a:vm-11', 'app-11', 'pv-vc-a-vm-11-gone');
    svc._setSessionFactoryForTest(async () => ({
      info: { banner: 'OK: bareos-dir Version: 25.0.4 (01 Jan 2026)' }, close() {},
      call: async (cmd) => {
        sent.push(cmd);
        if (cmd === '.jobs') return { jobs: [] };
        if (cmd.startsWith('configure add job')) { REG.deleteJob(lost.id, { directorId: DIR }); return { add: { name: /name=(\S+)/.exec(cmd)[1] } }; }
        if (cmd.startsWith('disable job=')) return {};
        throw Object.assign(new Error('bad'), { code: 'jsonrpc' });
      },
    }));
    const r2 = await SV.reregisterTargets(S.directorById(DIR), [lost.id]);
    assert.equal(r2.results[0].ok, false);
    assert.match(r2.results[0].reason, /비활성화했습니다/);
    assert.ok(sent.some((c) => c === `disable job=${r2.results[0].name}`), sent.slice(-3).join(' | '));
  } finally {
    REG.deleteJob(gone.id, { directorId: DIR }); REG.deleteJob(here.id, { directorId: DIR });
    store.snapshot = prevSnap;
  }
});
