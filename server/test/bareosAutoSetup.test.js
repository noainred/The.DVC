/**
 * test/bareosAutoSetup.test.js — Bareos 자동 설정(v2.821, bareos/autoSetup.js + 라우트).
 *  ① 본문: Director 리소스 5개는 화면의 '사전 준비' 블록(web bareosText.js directorPrepBlock)과 글자까지 같다(판정·문구 한 벌)
 *  ② Director 흐름: 쓰기 전에 전부 살핀다(남의 파일·심링크 → 아무것도 안 씀) · 포탈이 만든 파일만 덮어쓴다 · 0640 bareos 소유
 *     · `bareos-dir -t` 실패 → 새 파일 삭제 + 바꾼 파일 원복 + reload 없음 · 새 콘솔로 실제 접속 성공해야만 설정 저장
 *  ③ 비밀: SSH·콘솔·vCenter 비밀번호는 원격 명령 문자열·응답·감사에 없다(SFTP 로만) · 검사 출력의 콘솔 비밀번호는 가린다
 *  ④ FD INI: 0600 bareos 소유 · 지문 정규화 · 줄바꿈 든 값 거부 · 남의 파일 덮어쓰지 않음 · 지문 읽기(IP 는 SNI 없음)
 *  ⑤ 라우트: admin·전체 범위·데모 거부 · OTP 미등록 403 · 입력 오류는 OTP 를 쓰기 전에 400(같은 코드로 다음 요청 성공) · 틀린 OTP 403 · 감사
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosauto-'));
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
const S = await import('../src/bareos/settings.js');
// v2.823 법인별 Director — 자동 설정은 Director 하나를 대상으로 한다(그 Director 항목에 콘솔을 저장한다)
const DIR = S.addDirector({ name: '한국 본사', host: '10.20.30.40', port: 9101 }).director.id;
const { directorPrepBlock } = await import('../../web/src/views/tools/bareosText.js');

const SSH_PW = 'ssh-Secret-123';

const { fakeServer, fakeConsole } = await import('./_fakeBareosSsh.js');

const DIR_BODY = { directorId: DIR, host: '10.20.30.40', username: 'root', password: SSH_PW, restoreClient: 'kr-fd', restoreStorage: 'kr-sd', restorePool: 'VMwareKR' };
const consolePwOf = (F) => /Password = "([^"]+)"/.exec(F.get('/etc/bareos/bareos-dir.d/console/portal.conf')?.content || '')?.[1];

after(() => { A._setDepsForTest(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('① Director 리소스 본문 = 화면 사전 준비 블록(같은 입력 · 글자까지)', () => {
  const defaults = { fileSet: 'PortalVmwareGeneric', jobDefs: 'PortalVmwareDefaults', restoreJob: 'PortalVmwareRestore', pluginName: 'python3' };
  const server = A.directorResources({ defaults, consoleName: 'portal', consolePassword: '<생성한 비밀번호>', restoreClient: 'kr-fd', restoreStorage: 'File', restorePool: 'VMwarePool' }).map((r) => r.text).join('\n');
  assert.equal(server, directorPrepBlock({ defaults, consoleName: 'portal', anyClient: 'kr-fd', anyStorage: 'File', anyPool: 'VMwarePool' }));
  assert.match(server, /Type = Restore[\s\S]*Storage = File/, '복원 잡에 Storage(Bareos 기본 RestoreFiles 와 같은 모양)');
  const other = { fileSet: 'FsX', jobDefs: 'JdX', restoreJob: 'RjX', pluginName: 'python' };
  assert.equal(A.directorResources({ defaults: other, consoleName: 'pc2', consolePassword: '<생성한 비밀번호>', restoreClient: 'c1', restoreStorage: 's1', restorePool: 'p1' }).map((r) => r.text).join('\n'),
    directorPrepBlock({ defaults: other, consoleName: 'pc2', anyClient: 'c1', anyStorage: 's1', anyPool: 'p1' }));
  assert.match(A.MARKER, /^# [\x20-\x7e]+$/, '표지는 ASCII(FD INI 첫 줄 — C 로캘 Python 이 읽는다)');
  const B = A.BUDGET;
  assert.ok(B.sshReadyMs + B.testMs + B.reloadMs + B.roundTrips * B.roundTripMs < B.sessionMs, '단계 상한의 합 < 세션 시한(끊긴 세션에서 되돌리기가 돌지 않게)');
  assert.match(A.newConsolePassword(), /^[A-Za-z0-9_-]{32}$/);
});

test('② Director 정상: 5개 생성(0640·bareos·표지) → 검사 → reload → 새 콘솔 접속 성공 → 설정 저장 · 비밀은 명령·응답에 없음', async () => {
  const srv = fakeServer();
  const con = fakeConsole();
  A._setDepsForTest({ ssh: srv.ssh, openConsole: con.open, sleep: async () => {} });
  const r = await A.setupDirector(DIR_BODY);
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map((f) => f.action), ['created', 'created', 'created', 'created', 'created']);
  for (const p of ['fileset/PortalVmwareGeneric', 'jobdefs/PortalVmwareDefaults', 'job/PortalVmwareRestore', 'console/portal', 'profile/portal']) {
    const f = srv.F.get(`/etc/bareos/bareos-dir.d/${p}.conf`);
    assert.ok(f, p);
    assert.equal(f.mode, '0640'); assert.equal(f.owner, 'bareos');
    assert.equal(f.content.split('\n')[0], A.MARKER);
  }
  assert.match(srv.F.get('/etc/bareos/bareos-dir.d/job/PortalVmwareRestore.conf').content, /Client = kr-fd\n {2}Storage = kr-sd\n {2}Pool = VMwareKR/);
  assert.equal(srv.st.reloads, 1);
  assert.ok(srv.st.writes.every((w) => w.mode === 0o600 && w.p.startsWith('/tmp/portal-bareos.')), '임시 파일은 0600');
  const pw = consolePwOf(srv.F);
  assert.equal(con.seen[0].password, pw);
  assert.equal(con.seen[0].name, 'portal');
  assert.equal(con.seen[0].host, '10.20.30.40');
  assert.equal(con.seen[0].port, 9101);
  const saved = S.directorById(DIR);
  assert.equal(saved.consoleName, 'portal'); assert.equal(saved.password, pw); assert.equal(saved.host, '10.20.30.40');
  const all = srv.st.cmds.join('\n');
  assert.ok(!all.includes(pw) && !all.includes(SSH_PW), '비밀번호는 명령 문자열에 없다');
  const body = JSON.stringify(r);
  assert.ok(!body.includes(pw) && !body.includes(SSH_PW), '응답에 비밀번호 없음');
  assert.equal(r.director.hasPassword, true);
  assert.equal(r.directorId, DIR);
  assert.equal(srv.st.creds.password, SSH_PW);
  assert.ok(![...srv.F.keys()].some((k) => k.startsWith('/tmp/')), '임시 디렉터리는 지운다');
});

test('② 다시 실행: 포탈이 만든 파일은 덮어쓴다(updated/unchanged) · 남의 파일·심링크가 하나라도 있으면 아무것도 쓰지 않는다', async () => {
  const prev = fakeServer();
  A._setDepsForTest({ ssh: prev.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  await A.setupDirector(DIR_BODY);
  const again = fakeServer({ files: Object.fromEntries([...prev.F.entries()]) });
  A._setDepsForTest({ ssh: again.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  const r = await A.setupDirector(DIR_BODY);
  assert.deepEqual(r.files.map((f) => f.action), ['unchanged', 'unchanged', 'unchanged', 'updated', 'unchanged']);

  const foreign = fakeServer({ files: { '/etc/bareos/bareos-dir.d/jobdefs/PortalVmwareDefaults.conf': 'JobDefs {\n  Name = "PortalVmwareDefaults"\n}\n' } });
  A._setDepsForTest({ ssh: foreign.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  await assert.rejects(A.setupDirector(DIR_BODY), (e) => e.code === 'conflict' && /포탈이 만든 것이 아닙니다/.test(e.message) && e.paths.length === 1);
  assert.equal(foreign.st.writes.length, 0);
  assert.equal(foreign.F.size, 1);
  assert.ok(!foreign.st.cmds.some((c) => c.startsWith('install -o')));

  const link = fakeServer({ files: { '/etc/bareos/bareos-dir.d/console/portal.conf': { link: true } } });
  A._setDepsForTest({ ssh: link.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  await assert.rejects(A.setupDirector(DIR_BODY), (e) => e.code === 'conflict' && /일반 파일이 아닙니다/.test(e.message));
  assert.equal(link.st.writes.length, 0);
});

test('② bareos-dir -t 실패 → 새 파일 삭제 · 바꾼 파일 원복 · reload 없음 · 설정 그대로 · 출력의 콘솔 비밀번호 가림', async () => {
  const before = JSON.stringify(S.directorById(DIR));
  const oldProfile = `${A.MARKER}\nProfile {\n  Name = "portal"\n}\n`;
  const srv = fakeServer({ files: { '/etc/bareos/bareos-dir.d/profile/portal.conf': oldProfile }, testCode: 1 });
  let leaked = '';
  srv.st.testOut = 'Config error: x';
  const origExec = srv.ssh;
  // 검사 출력에 콘솔 파일 줄이 그대로 실리는 경우를 흉내 낸다(비밀번호가 출력에 섞인다).
  srv.ssh = (creds, fn) => origExec(creds, (api) => fn({ ...api, exec: async (c) => { const r = await api.exec(c); if (c.includes('bareos-dir -t')) { leaked = consolePwOf(srv.F); return { ...r, stdout: `Config error: line 3 Password = "${leaked}"` }; } return r; } }));
  const con = fakeConsole();
  A._setDepsForTest({ ssh: srv.ssh, openConsole: con.open, sleep: async () => {} });
  await assert.rejects(A.setupDirector(DIR_BODY), (e) => {
    assert.equal(e.code, 'config-test');
    assert.ok(leaked && !e.message.includes(leaked), '콘솔 비밀번호는 가린다');
    assert.match(e.message, /\*\*\*\*/);
    return true;
  });
  assert.equal(srv.st.reloads, 0);
  assert.equal(con.seen.length, 0);
  assert.deepEqual([...srv.F.keys()], ['/etc/bareos/bareos-dir.d/profile/portal.conf']);
  assert.equal(srv.F.get('/etc/bareos/bareos-dir.d/profile/portal.conf').content, oldProfile);
  assert.equal(JSON.stringify(S.directorById(DIR)), before);
});

test('② 놓는 도중 실패 → 앞서 놓은 파일 되돌림 · 단일 설정 파일·root 아님·bconsole 없음은 쓰기 전에 거부', async () => {
  const srv = fakeServer({ installFail: '/etc/bareos/bareos-dir.d/console/portal.conf' });
  A._setDepsForTest({ ssh: srv.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  await assert.rejects(A.setupDirector(DIR_BODY), (e) => e.code === 'remote' && /되돌렸습니다/.test(e.message));
  assert.equal([...srv.F.keys()].filter((k) => k.startsWith('/etc/')).length, 0);
  assert.equal(srv.st.reloads, 0);

  for (const [o, re] of [[{ env: 'D B C U S' }, /단일 설정 파일/], [{ uid: '1000' }, /root 계정/], [{ env: 'D B U' }, /bconsole/], [{ env: 'B C U' }, /Director 가 없습니다/]]) {
    const s2 = fakeServer(o);
    A._setDepsForTest({ ssh: s2.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
    await assert.rejects(A.setupDirector(DIR_BODY), (e) => e.code === 'invalid' && re.test(e.message));
    assert.equal(s2.st.writes.length, 0);
  }
});

test('② 새 콘솔 접속 실패(2회) → 새 세션으로 되돌리고 다시 reload · 포탈 설정은 그대로', async () => {
  const before = JSON.stringify(S.directorById(DIR));
  const oldConsole = `${A.MARKER}\nConsole {\n  Name = "portal"\n  Password = "old-pw-kept"\n  Profile = "portal"\n}\n`;
  const srv = fakeServer({ files: { '/etc/bareos/bareos-dir.d/console/portal.conf': oldConsole } });
  const con = fakeConsole(() => false);
  A._setDepsForTest({ ssh: srv.ssh, openConsole: con.open, sleep: async () => {} });
  await assert.rejects(A.setupDirector(DIR_BODY), (e) => e.code === 'console-login' && /되돌리고 Director 를 다시 읽혔습니다/.test(e.message) && /포탈 설정은 바꾸지 않았습니다/.test(e.message));
  assert.equal(con.seen.length, 2);
  assert.equal(srv.st.reloads, 2, 'reload → 되돌린 뒤 다시 reload');
  assert.equal(srv.F.get('/etc/bareos/bareos-dir.d/console/portal.conf').content, oldConsole, '같은 이름 콘솔은 옛 비밀번호로 원복(쓰던 연결이 끊기지 않게)');
  assert.deepEqual([...srv.F.keys()].filter((k) => k.startsWith('/etc/')), ['/etc/bareos/bareos-dir.d/console/portal.conf']);
  assert.equal(JSON.stringify(S.directorById(DIR)), before);
});

test('② reload 실패 → 되돌림 · 세션이 시한으로 끊김 → 새 세션으로 되돌리고 다시 reload', async () => {
  const srv = fakeServer();
  const orig = srv.ssh;
  srv.ssh = (creds, fn) => orig(creds, (api) => fn({ ...api, exec: async (c) => (c.startsWith('printf') && !srv.st.failedOnce ? ((srv.st.failedOnce = true), { code: 1, stdout: 'Director not running', stderr: '' }) : api.exec(c)) }));
  A._setDepsForTest({ ssh: srv.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  await assert.rejects(A.setupDirector(DIR_BODY), (e) => e.code === 'remote' && /reload\(bconsole\)가 실패/.test(e.message) && /되돌렸습니다\(Director 를 다시 읽혔습니다\)/.test(e.message));
  assert.equal([...srv.F.keys()].filter((k) => k.startsWith('/etc/')).length, 0);
  assert.equal(srv.st.reloads, 1, 'C2-4(v2.822.3): reload 를 보냈으면 되돌린 뒤 다시 읽힌다(bconsole 이 시한으로 끝나도 Director 는 읽었을 수 있다)');

  // 끊김: 첫 세션은 검사 단계에서 연결이 죽는다(이후 그 세션의 명령은 전부 실패) — 세션 안 되돌리기는 실패, 새 세션이 되돌린다.
  const s2 = fakeServer();
  let session = 0;
  const base = s2.ssh;
  s2.ssh = (creds, fn) => {
    const mine = ++session; let dead = false;
    return base(creds, (api) => fn({ ...api,
      exec: async (c) => { if (dead) throw new Error('No response from server'); if (mine === 1 && c.includes('bareos-dir -t')) { dead = true; throw new Error('SSH 세션 취소(타임아웃)'); } return api.exec(c); },
      writeFile: async (...a) => { if (dead) throw new Error('No response from server'); return api.writeFile(...a); } }));
  };
  A._setDepsForTest({ ssh: s2.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  await assert.rejects(A.setupDirector(DIR_BODY), (e) => /새 세션으로 넣은 파일을 되돌렸습니다/.test(e.message) && !e.message.includes(SSH_PW));
  assert.equal(session, 2);
  assert.equal([...s2.F.keys()].filter((k) => k.startsWith('/etc/')).length, 0);
  assert.equal(s2.st.reloads, 1, '되돌린 뒤 다시 읽힌다');
});

test('v2.822.3 S2-1: 부모 디렉터리가 심링크면(bareos-dir.d 는 bareos 소유) 읽지도 쓰지도 않는다 · S2-5: SSH 비밀번호를 부분 가림으로 드러내지 않는다', async () => {
  const srv = fakeServer();
  srv.st.linkedDirs = ['/etc/bareos/bareos-dir.d/profile'];
  A._setDepsForTest({ ssh: srv.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  await assert.rejects(A.setupDirector(DIR_BODY), (e) => e.code === 'conflict' && /profile\/portal\.conf 가 일반 파일이 아닙니다/.test(e.message));
  assert.equal(srv.st.writes.length, 0, '아무것도 쓰지 않았다');
  // 놓는 순간에 바꿔치기(살펴볼 때는 정상) → install 이 정규 경로 검사로 실패 → 되돌림
  const s2 = fakeServer();
  const base = s2.ssh;
  s2.ssh = (creds, fn) => base(creds, (api) => fn({ ...api, exec: async (c) => { if (c.includes('install -o') && c.includes('/profile/')) s2.st.linkedDirs = ['/etc/bareos/bareos-dir.d/profile']; return api.exec(c); } }));
  A._setDepsForTest({ ssh: s2.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  await assert.rejects(A.setupDirector(DIR_BODY), (e) => e.code === 'remote' && /심링크/.test(e.message));
  assert.equal([...s2.F.keys()].filter((k) => k.startsWith('/etc/')).length, 0, '앞서 놓은 파일도 되돌렸다');
  // S2-5 — SSH 비밀번호가 흔한 낱말(bareos)이면 '****-dir' 처럼 가린 자리가 곧 비밀번호였다
  const s3 = fakeServer({ testCode: 1 });
  s3.st.testOut = 'Config error: /etc/bareos/bareos-dir.d/job/x.conf line 3';
  A._setDepsForTest({ ssh: s3.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  await assert.rejects(A.setupDirector({ ...DIR_BODY, password: 'bareos' }), (e) => {
    assert.equal(e.code, 'config-test');
    assert.doesNotMatch(e.message, /\*\*\*\*-dir|\/etc\/\*\*\*\*/);
    assert.match(e.message, /출력을 싣지 않습니다/);
    return true;
  });
});

test('v2.822.3 C2-5: 새 콘솔 접속 뒤 설정 저장이 실패하면 되돌리고 다시 reload · P2-12: 되돌린 뒤 인증 정지 기록을 지운다', async () => {
  S.updateDirector(DIR, { host: '10.20.30.40', port: 9101, consoleName: 'portal', password: 'pw-before' });
  const before = JSON.stringify(S.directorById(DIR));
  const svc = await import('../src/bareos/service.js');
  const cred = S.directorCred(S.directorById(DIR));
  // 저장 실패를 흉내 낸다 — 콘솔 접속이 성공한 직후 bareos.json 자리를 비어 있지 않은 디렉터리로(원자적 쓰기의 rename 이 실패)
  const file = path.join(tmp, 'bareos.json');
  const keep = fs.readFileSync(file);
  const srv = fakeServer();
  const con = fakeConsole(() => { fs.rmSync(file); fs.mkdirSync(file); fs.writeFileSync(path.join(file, 'x'), ''); return true; });
  A._setDepsForTest({ ssh: srv.ssh, openConsole: con.open, sleep: async () => {} });
  svc.bareosAuthGuard.markAuthStopped(cred.id, cred, 'Authorization failed.');
  try {
    await assert.rejects(A.setupDirector(DIR_BODY), (e) => {
      assert.equal(e.code, 'save');
      assert.match(e.message, /되돌리고 Director 를 다시 읽혔습니다/);
      assert.doesNotMatch(e.message, new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'CONFIG_DIR 경로 원문을 싣지 않는다');
      return true;
    });
  } finally { fs.rmSync(file, { recursive: true }); fs.writeFileSync(file, keep); }
  assert.equal(srv.st.reloads, 2, 'reload → 되돌린 뒤 다시 reload');
  assert.equal([...srv.F.keys()].filter((k) => k.startsWith('/etc/')).length, 0);
  assert.equal(JSON.stringify(S.directorById(DIR)), before, '포탈 설정은 그대로');
  assert.equal(svc.bareosAuthGuard.peekAuthStop(cred), null, 'P2-12: 되돌린 뒤의 인증 정지 기록은 지운다');
});

test('v2.822.3 S2-2: FD INI 자동 설정은 /etc/bareos/ 아래 .ini 에만 쓴다(root 로 아무 절대 경로나 쓰던 것)', async () => {
  for (const bad of ['/etc/cron.d/bareos.ini', '/etc/bareos/vmware/vc-a.conf', '/etc/sudoers.d/x.ini', '/var/lib/bareos/x.ini']) {
    S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: DIR, vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'VMwareKR', configFile: bad }] });
    assert.throws(() => A.planFdIni({ vcenterId: 'vc-a', host: '10.20.30.41', password: SSH_PW, vcuser: 'u', vcpass: 'p', vcthumbprint: '56:f5:97:fe:60:52:17:73:d0:73:a2:ed:47:ce:07:28:2c:e6:fe:9c' }), (e) => e.code === 'invalid' && /\/etc\/bareos\//.test(e.message), bad);
  }
  S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: DIR, vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'VMwareKR', configFile: '/etc/bareos/vmware/vc-a.ini' }] });
});

test('입력 판정: 차단 주소·앞 글자 - ·잘못된 리소스 이름·비밀번호 없음은 원격 접속 전에 거부', async () => {
  const srv = fakeServer();
  A._setDepsForTest({ ssh: srv.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  for (const b of [
    { ...DIR_BODY, host: '169.254.169.254' }, { ...DIR_BODY, host: '-oProxyCommand=x' }, { ...DIR_BODY, host: 'a b' },
    { ...DIR_BODY, password: '' }, { ...DIR_BODY, restoreClient: 'kr fd' }, { ...DIR_BODY, restorePool: '' },
    { ...DIR_BODY, consoleName: '../x' }, { ...DIR_BODY, sshPort: 70000 }, { ...DIR_BODY, username: 'root;id' },
  ]) {
    assert.throws(() => A.planDirector(b), (e) => e.code === 'invalid', JSON.stringify(b));
    await assert.rejects(A.setupDirector(b), (e) => e.code === 'invalid');
  }
  assert.equal(srv.st.cmds.length, 0);
});

test('④ FD INI: 매핑 경로에 0600 bareos · 지문 정규화 · vCenter 비밀번호는 명령에 없음 · 남의 파일 거부 · 줄바꿈 거부', async () => {
  S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: DIR, vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'VMwareKR', configFile: '/etc/bareos/vmware/vc-a.ini' }] });
  const FD = { vcenterId: 'vc-a', host: '10.20.30.41', password: SSH_PW, vcuser: 'svc-backup@vsphere.local', vcpass: 'Vc%Pa ss!', vcthumbprint: '56:f5:97:fe:60:52:17:73:d0:73:a2:ed:47:ce:07:28:2c:e6:fe:9c' };
  const srv = fakeServer();
  A._setDepsForTest({ ssh: srv.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  const r = await A.setupFdIni(FD);
  assert.equal(r.action, 'created'); assert.equal(r.plugin, 'installed'); assert.match(r.note, /%%/);
  // C2-1(v2.822.3): 플러그인은 ConfigParser(보간 켬)로 읽는다 — '%' 는 '%%' 로 적어야 '%' 로 읽힌다
  const f = srv.F.get('/etc/bareos/vmware/vc-a.ini');
  assert.equal(f.mode, '0600'); assert.equal(f.owner, 'bareos');
  assert.equal(f.content, `${A.MARKER}\n[vmware_plugin_options]\nvcserver=vc-a.corp\nvcuser=svc-backup@vsphere.local\nvcpass=Vc%%Pa ss!\nvcthumbprint=56F597FE60521773D073A2ED47CE07282CE6FE9C\n`);
  assert.ok(!srv.st.cmds.join('\n').includes('Vc%Pa') && !JSON.stringify(r).includes('Vc%Pa'));
  // 다시 실행 = 포탈 파일이라 updated
  const again = fakeServer({ files: { '/etc/bareos/vmware/vc-a.ini': f } });
  A._setDepsForTest({ ssh: again.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  assert.equal((await A.setupFdIni(FD)).action, 'updated');
  const foreign = fakeServer({ files: { '/etc/bareos/vmware/vc-a.ini': '[vmware_plugin_options]\nvcpass=hand-made\n' } });
  A._setDepsForTest({ ssh: foreign.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  await assert.rejects(A.setupFdIni(FD), (e) => e.code === 'conflict');
  assert.equal(foreign.F.get('/etc/bareos/vmware/vc-a.ini').content, '[vmware_plugin_options]\nvcpass=hand-made\n');
  for (const bad of [{ vcpass: 'a\nvcuser=root' }, { vcuser: ' x' }, { vcthumbprint: 'abc' }, { vcenterId: 'vc-none' }, { vcpass: '' }]) {
    assert.throws(() => A.planFdIni({ ...FD, ...bad }), (e) => e.code === 'invalid', JSON.stringify(bad));
  }
});

test('④ 지문 읽기: openssl 출력 파싱 · IP 는 SNI 없음 · 못 읽으면 오류(지어내지 않음)', async () => {
  assert.equal(A.parseOpensslFingerprint('sha1 Fingerprint=76:B4:2A:26:1F:F6:AE:DB:E3:3C:5F:CB:0C:84:29:D6:79:7D:9D:C6\n').thumbprint, '76B42A261FF6AEDBE33C5FCB0C8429D6797D9DC6', 'OpenSSL 3 소문자 표기');
  assert.deepEqual(A.parseOpensslFingerprint('SHA1 Fingerprint=56:F5:97:FE:60:52:17:73:D0:73:A2:ED:47:CE:07:28:2C:E6:FE:9C\nsubject=CN = vc\nnotAfter=Jan  1 00:00:00 2030 GMT\n'),
    { thumbprint: '56F597FE60521773D073A2ED47CE07282CE6FE9C', subject: 'CN = vc', notAfter: 'Jan  1 00:00:00 2030 GMT' });
  let srv = fakeServer();
  A._setDepsForTest({ ssh: srv.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  const r = await A.readFdThumbprint({ vcenterId: 'vc-a', host: '10.20.30.41', password: SSH_PW });
  assert.equal(r.thumbprint, '56F597FE60521773D073A2ED47CE07282CE6FE9C');
  assert.match(srv.st.cmds.at(-1), /-connect vc-a\.corp:443 -servername vc-a\.corp </);
  S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: DIR, vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'VMwareKR', configFile: '/etc/bareos/vmware/vc-a.ini' }, { vcenterId: 'vc-b', directorId: DIR, vcserver: '10.1.1.1', client: 'pl-fd', storage: 'pl-sd', pool: 'P', configFile: '/etc/bareos/vmware/vc-b.ini' }] });
  await A.readFdThumbprint({ vcenterId: 'vc-b', host: '10.20.30.41', password: SSH_PW });
  assert.match(srv.st.cmds.at(-1), /-connect 10\.1\.1\.1:443 </);
  srv = fakeServer({ openssl: '' });
  A._setDepsForTest({ ssh: srv.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  await assert.rejects(A.readFdThumbprint({ vcenterId: 'vc-b', host: '10.20.30.41', password: SSH_PW }), (e) => e.code === 'remote');
  S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: DIR, vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'VMwareKR', configFile: '/etc/bareos/vmware/vc-a.ini' }] });
});

/* ───────────────────────── ⑤ 라우트 ───────────────────────── */
let srvHttp, base, store, auditMod;
const USERS = {
  admin: { username: 'adm', role: 'admin', scope: null },
  noot: { username: 'noot', role: 'admin', scope: null },
  op: { username: 'op', role: 'operator', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-a'] } },
  demo: { username: 'thedvcdemp', role: 'admin', demoGuest: true, scope: null },
};
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  ({ store } = await import('../src/store.js'));
  auditMod = await import('../src/audit.js');
  store.snapshot = { generatedAt: Date.now(), source: 'mock', vcenters: [{ id: 'vc-a', name: 'Seoul', host: 'https://vc-a.corp' }], hosts: [], datastores: [], vms: [], alarms: [], networks: [] };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srvHttp = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srvHttp.address().port}/api/tools/bareos-backup/settings/directors/${DIR}/auto-setup`;
});
after(() => { try { srvHttp?.close(); } catch { /* */ } });

async function call(u, p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'x-u': u, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
}

test('⑤ 라우트: 권한·범위·데모·OTP 게이트 · 입력 오류는 OTP 를 쓰지 않는다 · 성공·감사 · 비밀 없음', async () => {
  const srv = fakeServer();
  A._setDepsForTest({ ssh: srv.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  assert.equal((await call('op', '/director', DIR_BODY)).s, 403);
  assert.equal((await call('sadm', '/director', DIR_BODY)).s, 403);
  assert.equal((await call('demo', '/director', DIR_BODY)).s, 403);
  assert.equal((await call('demo', '/fd-thumbprint', { vcenterId: 'vc-a', host: '10.0.0.1', password: 'x' })).s, 403);
  const ne = await call('noot', '/director', DIR_BODY);
  assert.equal(ne.s, 403); assert.equal(ne.j.needEnroll, true);
  assert.equal((await call('admin', '/director', { ...DIR_BODY, otp: '000000' })).s, 403);
  assert.equal(srv.st.cmds.length, 0, '게이트에서 막힌 요청은 원격 접속 0');

  const now = Math.floor(Date.now() / 30_000);
  const t1 = generateToken(SECRET, { counter: now - 1 });
  const bad = await call('admin', '/director', { ...DIR_BODY, restoreClient: 'a b', otp: t1 });
  assert.equal(bad.s, 400);
  const ok = await call('admin', '/director', { ...DIR_BODY, otp: t1 });   // 같은 코드 — 입력 오류가 OTP 를 태우지 않았다
  assert.equal(ok.s, 200, ok.t);
  assert.equal(ok.j.director.consoleName, 'portal');
  const pw = consolePwOf(srv.F);
  assert.ok(!ok.t.includes(pw) && !ok.t.includes(SSH_PW));
  assert.equal((await call('admin', '/director', { ...DIR_BODY, otp: t1 })).s, 403, '쓴 코드는 다시 못 쓴다');

  // 진행 중에는 그 Director 의 접속값 저장 409(끝에 저장하는 Director 연결과 서로 덮지 않게 — v2.823 Director 마다)
  let release; const gate = new Promise((r) => { release = r; });
  const slow = fakeServer();
  A._setDepsForTest({ ssh: async (c, fn) => { await gate; return slow.ssh(c, fn); }, openConsole: fakeConsole().open, sleep: async () => {} });
  const pending = call('admin', '/fd-thumbprint', { vcenterId: 'vc-a', host: '10.20.30.41', password: SSH_PW });
  await new Promise((r) => setTimeout(r, 50));
  const put = await fetch(base.replace('/auto-setup', ''), { method: 'PUT', headers: { 'x-u': 'admin', 'content-type': 'application/json' }, body: JSON.stringify({ timeoutMs: 20000 }) });
  assert.equal(put.status, 409);
  const same = await call('admin', '/preflight', { host: '10.20.30.41', password: SSH_PW });
  assert.equal(same.s, 409, '같은 Director 의 다른 자동 설정은 409');
  release(); assert.equal((await pending).s, 200);
  A._setDepsForTest({ ssh: srv.ssh, openConsole: fakeConsole().open, sleep: async () => {} });

  const tp = await call('admin', '/fd-thumbprint', { vcenterId: 'vc-a', host: '10.20.30.41', password: SSH_PW });
  assert.equal(tp.s, 200, tp.t); assert.equal(tp.j.thumbprint, '56F597FE60521773D073A2ED47CE07282CE6FE9C');
  const fd = await call('admin', '/fd', { vcenterId: 'vc-a', host: '10.20.30.41', password: SSH_PW, vcuser: 'svc', vcpass: 'VcSecret-9', vcthumbprint: tp.j.thumbprint, otp: generateToken(SECRET, { counter: now }) });
  assert.equal(fd.s, 200, fd.t);
  assert.ok(!fd.t.includes('VcSecret-9'));

  const foreign = fakeServer({ files: { '/etc/bareos/bareos-dir.d/fileset/PortalVmwareGeneric.conf': 'FileSet {}\n' } });
  A._setDepsForTest({ ssh: foreign.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  const cf = await call('admin', '/director', { ...DIR_BODY, otp: generateToken(SECRET, { counter: now + 1 }) });
  assert.equal(cf.s, 409); assert.equal(cf.j.code, 'conflict');

  // I2-10(v2.822.3): 검사 출력은 남의 리소스 비밀번호 줄을 그대로 찍을 수 있다(lex.cc) — 응답에는 싣되(관리자) 감사에는 싣지 않는다
  const { setupAuditReason } = await import('../src/routes/api/bareosBackup.js');
  const leakErr = Object.assign(new Error('Director 설정 검사(bareos-dir -t)가 실패했습니다: Config error: client/x.conf line 4: Password = "foreign-secret-77"'), { code: 'config-test' });
  assert.ok(!setupAuditReason(leakErr).includes('foreign-secret-77'), '감사 사유에 원격 출력이 없다');
  assert.match(setupAuditReason(leakErr), /^config-test Director 설정 검사/);
  assert.match(setupAuditReason(Object.assign(new Error('이 주소에는 접속할 수 없습니다'), { code: 'invalid' })), /^invalid 이 주소에는/);

  const logs = JSON.stringify(auditMod.listAudit({ limit: 500 }));
  for (const s of [pw, SSH_PW, 'VcSecret-9']) assert.ok(!logs.includes(s), '감사에 비밀 없음');
});
