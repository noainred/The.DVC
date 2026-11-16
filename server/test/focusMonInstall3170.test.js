/**
 * test/focusMonInstall3170.test.js — v3.17.0 디스크 점검 프로그램 **자동 설치 · 설치 디렉터리 지정**(사용자 "디스크 점검하는 프로그램을 자동으로 설치하는 기능 추가" ·
 * "설치 디렉터리를 사전에 사용자가 지정하는 기능 추가" · 시안 ⑱ · docs/design/focus-mon/README.md §21 · '진행해' = 컨펌 기본값).
 *
 *  ① 디렉터리 판정 하나(서버 · 웹 같은 입력 대조) · 기본 경로는 예전 상수와 바이트까지 같다(이미 설치한 서버의 판본이 바뀌지 않게)
 *  ② 지정 디렉터리의 경로 · 실행 파일 · 준비 확인 · 설치 파일(문법 dash · bash · 위쪽 폴더 검사 · 네트워크 FS · noexec · 옛 파일은 판본이 같을 때만)
 *  ③ 설치 명령 — 값은 수집 계정 이름 · 난수 파일 이름뿐 · 권한 확인 상수 · 표지 해석
 *  ④ 설치 계정 해석(실제 키 저장소 · 서버 등록부) — 직접 켠 키만 · 같은 주소 둘 · 비밀번호 · 공통 계정 하나 · 여럿(고르기) · 비밀은 withAuth 에만
 *  ⑤ 설치 실행(가짜 접속) — sudo 비밀번호 · tty · root · 표지 · 판본 · 같은 키 연속 거부 · 준비 확인
 *  ⑥ 중앙 — 설치 접수 · 엣지 배달(설치 계정을 알려 온 엣지만) · 결과 정제 · 설치 위치 기억 · 후보 밖 위치 거부 · 준비 확인 후보
 *  ⑦ 설정 손상(재시작 뒤 보존본만이어도) · 라우트 문(관리자 · 설정 소유자 등급 · 데모 · OTP) · 503
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'focusmoninstall3170-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.SETTINGS_OWNERS = 'own,sown';
process.env.CENTRAL_TOKEN = 'ctok-install-3170';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-install-3170-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
delete process.env.CENTRAL_URL;
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify({ users: [
  { username: 'own', role: 'admin' }, { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } }, { username: 'adm', role: 'admin' }, { username: 'op', role: 'operator' },
] }));

const B = await import('../src/focusmon/audit/bundle.js');
const P = await import('../src/focusmon/audit/parse.js');
const I = await import('../src/focusmon/audit/install.js');
const C = await import('../src/focusmon/audit/installCred.js');
const SET = await import('../src/focusmon/audit/settings.js');
const A = await import('../src/focusmon/audit/service.js');
const R = await import('../src/focusmon/audit/runner.js');
const W = await import('../../web/src/views/tools/focusMonAuditInstallText.js');
const F = await import('./_sshKeyFixtures.js');
const VAULT = await import('../src/security/secretVault.js');
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const KS = await import('../src/bmusage/onboard/keyStore.js');
const BM = await import('../src/bmstor/registry.js');

/* ── ① ── */
test('① 디렉터리 판정 — 서버 · 웹 같은 규칙 · 기본 경로는 예전 상수와 바이트까지 같다', () => {
  const cases = ['', '/opt/dvc/disk-audit', '/app/tools/dvc', '/opt', 'opt/dvc', '/opt/dvc/', '/opt//dvc', '/opt/./dvc', '/opt/../etc', '/opt/-x/y', '/opt/dvc; rm -rf /', '/opt/d vc', '/opt/한글',
    '/tmp/dvc', '/var/tmp/a', '/home/u/x', '/root/x', '/run/x', '/dev/shm/x', '/proc/x', '/sys/x', '/boot/x', '/mnt/x', '/media/x', '/tmpx/dvc', `/${'a'.repeat(130)}`, '/a/b/c/d/e/f/g/h/i', '/a/b/c/d/e/f/g/h', null, 5, '/opt/$HOME/x', '/opt/`id`/x'];
  for (const c of cases) assert.equal(W.dirIssue(c), B.dirIssue(c), `웹 · 서버 판정이 다르다: ${JSON.stringify(c)}`);
  assert.equal(B.dirIssue('/opt/dvc/disk-audit'), null); assert.equal(B.dirIssue('/tmpx/dvc'), null, '접두가 글자로만 겹치면 막지 않는다');
  for (const bad of ['/tmp/dvc', '/opt', '/opt/dvc; rm -rf /', '/opt/../etc', '/opt/-x/y', '/opt/$HOME/x']) assert.ok(B.dirIssue(bad), bad);
  assert.deepEqual([...W.DIR_DENY], [...B.DIR_DENY]); assert.deepEqual(Object.keys(W.DIR_ISSUE_TEXT).sort(), Object.keys(B.DIR_ISSUE_TEXT).sort());
  // 기본 경로 = 예전 상수(v3.11.0 에 설치한 서버의 판본이 바뀌지 않는다)
  assert.equal(B.wrapperSha(''), 'da12cce07aaa85f28cde3fe0a43d6656be494f221446da3c44468bd5d71fd4d0', '기본 경로 실행 파일 판본이 바뀌면 전 서버가 ‘판본 다름’ 이 된다');
  assert.equal(B.wrapperTextFor(B.pathsFor('')), B.WRAPPER_TEXT); assert.equal(B.readyCommandFor(B.pathsFor('')), B.READY_COMMAND); assert.equal(B.runCommandFor(B.pathsFor('')), B.RUN_COMMAND);
  assert.equal(B.RUN_COMMAND, 'sudo -n /usr/local/sbin/dvc-disk-audit');
  assert.equal(B.pathsFor('/opt/../etc'), null, '규칙 밖 디렉터리로는 경로를 만들지 않는다'); assert.equal(B.wrapperSha('/tmp/x'), null);
});

/* ── ② ── */
test('② 지정 디렉터리 — 경로 · 실행 파일(PROG 줄만 다름) · 준비 확인 · 설치 파일', () => {
  const p = B.pathsFor('/opt/dvc/disk-audit');
  assert.deepEqual({ ...p }, { dir: '/opt/dvc/disk-audit', program: '/opt/dvc/disk-audit/rhel_disk_audit.py', wrapper: '/opt/dvc/disk-audit/dvc-disk-audit' });
  const w = B.wrapperTextFor(p);
  const diff = w.split('\n').filter((l, i) => l !== B.WRAPPER_TEXT.split('\n')[i]);
  assert.deepEqual(diff, ['PROG=/opt/dvc/disk-audit/rhel_disk_audit.py'], '실행 파일은 프로그램 경로 한 줄만 다르다');
  assert.notEqual(B.wrapperSha(p.dir), B.wrapperSha(''));
  assert.deepEqual(B.dirsToCheck(p), { all: ['/opt/dvc/disk-audit', '/opt/dvc', '/opt'], need: ['/opt/dvc/disk-audit'] });
  const rc = B.readyCommandFor(p);
  assert.match(rc, /for d in \/opt\/dvc\/disk-audit \/opt\/dvc \/opt; do/); assert.match(rc, /sudo -n -l \/opt\/dvc\/disk-audit\/dvc-disk-audit /);
  assert.equal(B.runCommandFor(p), 'sudo -n /opt/dvc/disk-audit/dvc-disk-audit');
  // 설치 파일 — 문법(dash · bash) · 위쪽부터 폴더 검사 · 네트워크 FS · noexec · 옛 위치는 판본이 같을 때만
  const s = B.installScript({ dir: p.dir, oldDirs: [''] });
  const f = path.join(DIR, 'i.sh'); fs.writeFileSync(f, s);
  for (const sh of ['dash', 'bash']) { const has = spawnSync('sh', ['-c', `command -v ${sh}`]).status === 0; if (has) assert.equal(spawnSync(sh, ['-n', f]).status, 0, `${sh} 문법`); }
  assert.match(s, /for d in \/opt \/opt\/dvc \/opt\/dvc\/disk-audit; do\n {2}if \[ -L "\$d" \]; then echo '##DI fail dir-symlink'/, '위쪽부터 심링크 · 소유자 · 쓰기 검사');
  assert.match(s, /stat -f -c '%T' \/opt\/dvc\/disk-audit/); assert.match(s, /nfs\|nfs\/\*\|nfs4/); assert.match(s, /\*,noexec,\*\) \{ echo '##DI fail dir-noexec'/);
  assert.ok(s.includes(`old_rm /usr/local/libexec/dvc/rhel_disk_audit.py ${B.programSha()}`) && s.includes(`old_rm /usr/local/sbin/dvc-disk-audit ${B.wrapperSha('')}`), '옛 파일은 그 위치의 포탈 판본과 같을 때만 지운다');
  assert.ok(s.includes(`${B.wrapperSha(p.dir)}  $T/dvc-disk-audit`), '싣은 실행 파일 판본을 설치 전에 다시 확인');
  assert.match(s, /NOPASSWD: \/opt\/dvc\/disk-audit\/dvc-disk-audit \\"\\""/);
  for (const code of B.INSTALL_FAILS) assert.ok(s.includes(`'##DI fail ${code}'`) || B.installScript({ dir: '' }).includes(`'##DI fail ${code}'`), `설치 파일이 내는 까닭 ${code}`);
  assert.throws(() => B.installScript({ dir: '/tmp/x' }), /규칙/);
  assert.equal(B.installScript({ dir: p.dir, oldDirs: [p.dir, '/tmp/x'] }).includes('old_rm'), false, '같은 위치 · 규칙 밖 옛 위치는 정리하지 않는다');
  // 인자 거절은 실제로 돌려서
  assert.equal(spawnSync('sh', [f, 'x;id'], { encoding: 'utf8' }).status, 64);
  assert.match(spawnSync('sh', [f, 'a', 'b'], { encoding: 'utf8' }).stdout, /##DI fail args/, '인자는 하나만');
  // 준비 판정은 그 디렉터리의 폴더로
  const lines = ['##DR 1', '##DR py 3.6.8', `##DR file ${p.program} ${B.programSha()} 0:0:644`, `##DR file ${p.wrapper} ${B.wrapperSha(p.dir)} 0:0:755`,
    '##DR dir /opt/dvc/disk-audit 0:0:755', '##DR dir /opt/dvc 0:0:775', '##DR dir /opt 0:0:755', '##DR sudo ok', '##DR end'];
  const want = { programPath: p.program, wrapperPath: p.wrapper, programSha: B.programSha(), wrapperSha: B.wrapperSha(p.dir), dirs: B.dirsToCheck(p) };
  assert.equal(P.readyState(P.parseReady(lines), want).state, 'owner', '위쪽 폴더를 그룹이 쓸 수 있으면 실행하지 않는다');
  assert.equal(P.readyState(P.parseReady(lines.map((l) => l.replace('0:0:775', '0:0:755'))), want).state, 'ready');
});

/* ── ③ ── */
test('③ 설치 명령 · 권한 확인 · 표지 해석', () => {
  const cmd = I.installCommand({ sudo: true, file: '.dvc-da-install.0123456789abcdef.sh', acct: 'dvcmon' });
  assert.equal(cmd, 'sudo -n /bin/sh "$HOME/.dvc-da-install.0123456789abcdef.sh" dvcmon; echo "##DI rc $?"; rm -f "$HOME/.dvc-da-install.0123456789abcdef.sh"');
  assert.ok(!I.installCommand({ sudo: false, file: '.dvc-da-install.0123456789abcdef.sh', acct: 'root2' }).startsWith('sudo'));
  for (const bad of [{ file: '../x.sh', acct: 'a' }, { file: '.dvc-da-install.0123456789abcdef.sh', acct: 'a;id' }, { file: '.dvc-da-install.0123456789abcdef.sh', acct: '-x' }]) assert.throws(() => I.installCommand({ sudo: true, ...bad }));
  assert.ok(!/\$\{/.test(I.PRIV_COMMAND), '권한 확인은 상수');
  const po = spawnSync('sh', ['-c', I.PRIV_COMMAND], { encoding: 'utf8' }).stdout; assert.match(po, /^##DI priv (root|sudo|tty|no)$/m);
  const x = I.parseInstallOut('##DI step dir\n##DI step files\nhello ##DI fail dir-owner\n##DI fail dir-writable\n##DI fail visudo\n##DI rc 73\n##DI nopy');
  assert.deepEqual(x.steps, ['dir', 'files']); assert.equal(x.fail, 'dir-writable', '첫 실패 표지(줄 맨 앞만)'); assert.equal(x.rc, 73); assert.equal(x.ok, false); assert.equal(x.nopy, true);
  assert.equal(I.parseInstallOut('##DI fail evil-thing').fail, 'other', '모르는 까닭은 other');
  assert.equal(I.parseInstallOut('##DI step dir\n##DI ok\n##DI old-rm /a\n##DI old-keep /b\n##DI rc 0').ok, true);
});

/* ── ④ ── */
test('④ 설치 계정 — 직접 켠 키만 · 같은 주소 둘 · 비밀번호 · 공통 계정 하나 · 여럿 · 비밀은 withAuth 에만', () => {
  const kOn = KS.addKey({ name: 'kr-install', privateKey: F.ed25519Key().pem, folderCorp: 'vcA', features: ['bm-usage', 'disk-audit-install'] }, { by: 'own' }).key;
  const kOff = KS.addKey({ name: 'kr-collect', privateKey: F.ed25519Key().pem, folderCorp: 'vcA', features: ['bm-usage'] }, { by: 'own' }).key;
  const kLegacy = KS.addKey({ name: 'legacy-root', privateKey: F.ed25519Key().pem }, { by: 'own' }).key;
  assert.ok(kOn && kOff && kLegacy);
  const t = (host, port = 22) => ({ id: 'fm-aaaaaaaa01', name: 'kr-db-01', host, port, username: 'dvcmon' });
  assert.equal(BM.saveBmServer({ name: 'kr-db-01', host: '10.1.0.1', port: 22, username: 'dvcadmin', mounts: ['/'], vcenterId: 'vcA', keyRef: kOn.id, bindApproved: true }).ok, true);
  const ok = C.installCredFor(t('10.1.0.1'), { withAuth: true });
  assert.equal(ok.state, 'ok'); assert.equal(ok.src, 'server'); assert.equal(ok.acct, 'dvcadmin'); assert.ok(ok.auth?.privateKey, 'withAuth 일 때만 비밀');
  const v = C.credView(C.installCredFor(t('10.1.0.1')));
  assert.equal(JSON.stringify(v).includes('PRIVATE'), false); assert.equal(v.auth, undefined);
  assert.equal(C.installCredFor(t('10.1.0.1', 2222)).state, 'noentry', '포트가 다르면 같은 서버가 아니다');
  BM.saveBmServer({ name: 'kr-db-02', host: '10.1.0.2', port: 22, username: 'root', mounts: ['/'], vcenterId: 'vcA', keyRef: kLegacy.id, bindApproved: true });
  assert.equal(C.installCredFor(t('10.1.0.2')).state, 'feature', '기능 목록이 없는 예전 키는 root 설치에 쓰지 않는다');
  BM.saveBmServer({ name: 'kr-db-03', host: '10.1.0.3', port: 22, username: 'mon', mounts: ['/'], vcenterId: 'vcA', keyRef: kOff.id, bindApproved: true });
  assert.equal(C.installCredFor(t('10.1.0.3')).state, 'feature');
  BM.saveBmServer({ name: 'kr-db-04', host: '10.1.0.4', port: 22, username: 'mon', mounts: ['/'], vcenterId: 'vcA', password: 'pw-x' });
  assert.equal(C.installCredFor(t('10.1.0.4')).state, 'password', '비밀번호 접속은 쓰지 않는다');
  BM.saveBmServer({ name: 'kr-db-05a', host: '10.1.0.5', port: 22, username: 'mon', mounts: ['/'], vcenterId: 'vcA', keyRef: kOn.id, bindApproved: true });
  BM.saveBmServer({ name: 'kr-db-05b', host: '10.1.0.5', port: 22, username: 'mon', mounts: ['/'], vcenterId: 'vcB', keyRef: kOn.id, bindApproved: true });
  assert.equal(C.installCredFor(t('10.1.0.5')).state, 'dup', '같은 주소 · 포트 서버가 둘이면 잇지 않는다');
  // 공통 계정 — 법인 vCenter 와 맞는 것 · 설치 켠 키
  assert.equal(C.installCredFor(t('10.9.9.9'), { corpVcs: ['vcA'] }).state, 'noentry');
  const a1 = KS.saveAccount({ name: 'kr-common', kind: 'os', corp: 'vcA', username: 'dvcadmin', keyRef: kOff.id }, { by: 'own' });
  assert.ok(a1.ok, JSON.stringify(a1));
  assert.equal(C.installCredFor(t('10.9.9.9'), { corpVcs: ['vcA'] }).state, 'feature', '공통 계정은 있는데 키에 설치가 꺼짐');
  const a2 = KS.saveAccount({ name: 'kr-installer', kind: 'os', corp: 'vcA', username: 'instadm', keyRef: kOn.id }, { by: 'own' });
  const c2 = C.installCredFor(t('10.9.9.9'), { corpVcs: ['vcA'] });
  assert.equal(c2.state, 'ok'); assert.equal(c2.src, 'corp'); assert.equal(c2.acct, 'instadm');
  assert.equal(C.installCredFor(t('10.9.9.9'), { corpVcs: ['vcB'] }).state, 'noentry', '다른 법인 계정은 쓰지 않는다');
  const kOn2 = KS.addKey({ name: 'kr-install-2', privateKey: F.ed25519Key().pem, folderCorp: 'vcA', features: ['disk-audit-install'] }, { by: 'own' }).key;
  const a3 = KS.saveAccount({ name: 'kr-installer-2', kind: 'os', corp: 'vcA', username: 'inst2', keyRef: kOn2.id }, { by: 'own' });
  const amb = C.installCredFor(t('10.9.9.9'), { corpVcs: ['vcA'] });
  assert.equal(amb.state, 'ambig'); assert.equal(amb.choices.length, 2);
  const pickId = (a3.account || a3).id;
  assert.equal(C.installCredFor(t('10.9.9.9'), { corpVcs: ['vcA'], pick: pickId }).acct, 'inst2', '고른 계정');
  assert.equal(C.installCredFor(t('10.9.9.9'), { corpVcs: ['vcA'], pick: 'nope' }).state, 'ambig', '후보가 아닌 고르기는 무시');
  assert.equal(C.installCredFor(t('10.9.9.9'), { edge: true }).state, 'ambig', '엣지는 법인이 정해진 계정 전부');
  void a2;
});

/* ── ⑤ ── */
function fakeConnect({ priv = 'sudo', out = '##DI step dir\n##DI step files\n##DI step sudoers\n##DI ok\n##DI rc 0', authFail = false, dir = '', readyState = 'ok' } = {}) {
  const log = { conns: [], execs: [], writes: [] };
  const P0 = B.pathsFor(dir);
  const ready = ['##DR 1', '##DR py 3.6.8', `##DR file ${P0.program} ${B.programSha()} 0:0:644`, `##DR file ${P0.wrapper} ${B.wrapperSha(dir)} 0:0:755`,
    ...B.dirsToCheck(P0).all.map((d) => `##DR dir ${d} 0:0:755`), readyState === 'ok' ? '##DR sudo ok' : '##DR sudo no', '##DR end'].join('\n');
  const connect = async (o, fn) => {
    log.conns.push({ username: o.username, key: String(o.privateKey).slice(0, 12) });
    if (authFail && o.username !== 'dvcmon') { const e = new Error('All configured authentication methods failed'); e.level = 'client-authentication'; throw e; }
    return fn({
      exec: async (cmd) => { log.execs.push(cmd); if (cmd === I.PRIV_COMMAND) return { stdout: `##DI priv ${priv}\n`, code: 0 }; if (cmd.includes('##DR 1')) return { stdout: ready, code: 0 }; return { stdout: out, code: 0 }; },
      writeFile: async (p, c, m) => { log.writes.push({ p, len: c.length, m, hasDir: c.includes(dir || '/usr/local/sbin/dvc-disk-audit') }); },
    });
  };
  return { connect, log };
}
const T = { id: 'fm-aaaaaaaa01', name: 'kr-db-01', host: '10.1.0.1', port: 22, username: 'dvcmon' };
const KEYS = { keyInfo: () => ({ fingerprint: 'SHA256:focuskeyfp' }), privateKeyForConnect: () => 'FOCUS-PEM' };
const credOk = () => ({ state: 'ok', src: 'server', acct: 'dvcadmin', key: 'kr-install', auth: { username: 'dvcadmin', privateKey: 'INSTALL-PEM', passphrase: '', fingerprint: 'SHA256:installfp' } });

test('⑤ 설치 실행 — sudo 비밀번호 · tty · root · 표지 · 판본 · 같은 키 연속 거부 · 준비 확인', async () => {
  I._resetInstallForTest();
  let f = fakeConnect({ priv: 'no' });
  let r = await I.installOnce(T, { keys: KEYS, connect: f.connect, credOf: credOk, expect: { dir: '' } });
  assert.equal(r.install.code, 'sudo-password'); assert.equal(f.log.writes.length, 0, '아무것도 올리지 않는다'); assert.equal(f.log.execs.length, 1);
  f = fakeConnect({ priv: 'tty' });
  assert.equal((await I.installOnce(T, { keys: KEYS, connect: f.connect, credOf: credOk, expect: { dir: '' } })).install.code, 'sudo-tty');
  // 성공 — 지정 디렉터리 · 올린 파일 0600 · 명령 값 · 지우기 · 수집 계정으로 준비 확인
  f = fakeConnect({ priv: 'sudo', dir: '/opt/dvc/disk-audit' });
  r = await I.installOnce(T, { keys: KEYS, connect: f.connect, credOf: credOk, expect: { dir: '/opt/dvc/disk-audit', oldDirs: [''], program: B.programSha() } });
  assert.equal(r.install.code, 'ok', JSON.stringify(r.install)); assert.equal(r.ok, true); assert.equal(r.dir, '/opt/dvc/disk-audit'); assert.ok(r.ready.length > 5);
  assert.equal(f.log.writes.length, 1); assert.match(f.log.writes[0].p, I.FILE_RE); assert.equal(f.log.writes[0].m, 0o600); assert.ok(f.log.writes[0].hasDir, '설치 파일 안에 디렉터리');
  const ic = f.log.execs.find((c) => c.includes('/bin/sh "$HOME/'));
  assert.ok(ic.startsWith('sudo -n /bin/sh') && ic.includes(' dvcmon; ') && ic.includes('rm -f "$HOME/.dvc-da-install.'), ic);
  assert.ok(!ic.includes('/opt/dvc'), '디렉터리는 명령이 아니라 파일 안에');
  assert.deepEqual(f.log.conns.map((c) => c.username), ['dvcadmin', 'dvcmon'], '설치 계정 → 수집 계정(준비 확인)');
  assert.equal(f.log.conns[1].key, 'FOCUS-PEM', '준비 확인은 집중 모니터링 키로');
  // root 계정 — sudo 없이
  f = fakeConnect({ priv: 'root' });
  await I.installOnce(T, { keys: KEYS, connect: f.connect, credOf: credOk, expect: { dir: '' } });
  assert.ok(f.log.execs.some((c) => c.startsWith('/bin/sh "$HOME/')));
  // 설치 파일이 멈춤
  f = fakeConnect({ out: '##DI step dir\n##DI fail dir-writable\n##DI rc 73' });
  r = await I.installOnce(T, { keys: KEYS, connect: f.connect, credOf: credOk, expect: { dir: '' } });
  assert.equal(r.install.code, 'script'); assert.equal(r.install.fail, 'dir-writable'); assert.equal(r.install.rc, 73); assert.equal(r.install.step, 3); assert.equal(r.ok, false);
  // 판본 · 디렉터리 · 계정 — 접속 전에
  f = fakeConnect();
  assert.equal((await I.installOnce(T, { keys: KEYS, connect: f.connect, credOf: credOk, expect: { dir: '', program: 'f'.repeat(64) } })).install.code, 'version');
  assert.equal((await I.installOnce(T, { keys: KEYS, connect: f.connect, credOf: credOk, expect: { dir: '/tmp/x' } })).install.code, 'bad-dir');
  assert.equal((await I.installOnce({ ...T, username: 'a;b' }, { keys: KEYS, connect: f.connect, credOf: credOk, expect: { dir: '' } })).install.code, 'bad-acct');
  assert.equal((await I.installOnce(T, { keys: KEYS, connect: f.connect, credOf: () => ({ state: 'feature' }), expect: { dir: '' } })).install.code, 'cred');
  assert.equal(f.log.conns.length, 0, '접속하지 않았다');
  // 같은 키가 연속 3번 거부되면 그 키로는 접속하지 않는다
  I._resetInstallForTest();
  f = fakeConnect({ authFail: true });
  for (let i = 0; i < 3; i++) assert.equal((await I.installOnce(T, { keys: KEYS, connect: f.connect, credOf: credOk, expect: { dir: '' } })).install.code, 'auth');
  const n = f.log.conns.length;
  assert.equal((await I.installOnce(T, { keys: KEYS, connect: f.connect, credOf: credOk, expect: { dir: '' } })).install.code, 'key-stopped');
  assert.equal(f.log.conns.length, n, '네 번째는 접속하지 않는다');
  // 수집 계정 준비 확인이 안 되면 '설치함 — 확인 못 함'
  I._resetInstallForTest();
  const g = fakeConnect();
  const conn2 = async (o, fn) => { if (o.username === 'dvcmon') { const e = new Error('denied'); e.level = 'client-authentication'; throw e; } return g.connect(o, fn); };
  r = await I.installOnce({ ...T, id: 'fm-aaaaaaaa77' }, { keys: KEYS, connect: conn2, credOf: credOk, expect: { dir: '' } });
  assert.equal(r.install.code, 'check'); assert.equal(r.ok, true);
});

/* ── ⑥ ── */
test('⑥ 중앙 — 접수 · 엣지 배달 · 결과 정제 · 설치 위치 기억 · 후보 밖 위치 거부 · 준비 확인 후보', async () => {
  A._resetForTest(); SET._resetForTest();
  assert.equal(SET.saveInstallDir('/opt/dvc/disk-audit', { by: 'own' }).ok, true);
  const te = { id: 'fm-eeeeeeee01', name: 'pl-db-01', host: '10.48.0.1', port: 22, username: 'dvcmon', agent: 'edge-pl' };
  // 엣지가 설치 계정을 알려 오기 전에는 접수하지 않는다(옛 엣지 — 모르는 작업을 점검 실행으로 읽는다)
  assert.equal(A.requestInstall(te, { by: 'own' }).code, 'cred-edge-unknown');
  const mine = new Map([[te.id, te]]);
  const first = A.handleEdgeAudit('edge-pl', mine, { cred: { [te.id]: { state: 'ok', src: 'corp', acct: 'pl-ops', key: 'pl-common', privateKey: 'LEAK' }, 'fm-zzzzzzzz99': { state: 'ok' } } }, Date.now());
  assert.ok(Array.isArray(first.known) && first.known[0].id === te.id && first.known[0].host === te.host, '맡은 서버 목록을 보낸다(이름 · 주소 · 포트)');
  assert.equal(JSON.stringify(first.known).includes('username'), false);
  assert.equal(A.credOfTarget(te).acct, 'pl-ops'); assert.equal(JSON.stringify(A.credOfTarget(te)).includes('LEAK'), false, '아는 칸만');
  assert.equal(A.credOfTarget({ ...te, id: 'fm-zzzzzzzz99' }).state, 'edge-unknown', '맡지 않은 대상의 보고는 받지 않는다');
  const r = A.requestInstall(te, { by: 'own' });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.via, 'edge');
  assert.equal(A.requestInstall(te, { by: 'own' }).code, 'busy', '한 서버에 작업 하나');
  const out = A.handleEdgeAudit('edge-pl', mine, { cred: { [te.id]: { state: 'ok', acct: 'pl-ops' } } }, Date.now() + 1000);
  const job = out.jobs.find((j) => j.mode === 'install');
  assert.ok(job); assert.equal(job.expect.dir, '/opt/dvc/disk-audit'); assert.deepEqual(job.expect.cands, ['/opt/dvc/disk-audit']); assert.equal(job.expect.wrappers['/opt/dvc/disk-audit'], B.wrapperSha('/opt/dvc/disk-audit'));
  assert.equal(out.known, undefined, '맡은 서버 목록은 60초에 한 번');
  // 결과 정제 — 아는 칸만 · 이름 규칙 · 까닭 이름
  const c = A.cleanEdgeResult({ mode: 'install', ok: true, kind: 'done', dir: '/opt/dvc/disk-audit', ready: [], install: { code: 'ok', step: 7, acct: 'pl ops<script>', key: 'pl-common', src: 'corp', priv: 'sudo', fail: 'nope', extra: 'x' } });
  assert.equal(c.install.acct, '', '이름 규칙 밖은 비운다'); assert.equal(c.install.fail, 'other'); assert.equal(c.install.extra, undefined);
  assert.equal(A.cleanEdgeResult({ mode: 'install', dir: '/tmp/x', install: { code: 'evil' } }).install.code, 'unreachable');
  assert.equal(A.cleanEdgeResult({ mode: 'run', dir: '/opt/../etc' }).dir, null);
  // 반영 — 설치 위치 기억 · 마지막 설치
  const P0 = B.pathsFor('/opt/dvc/disk-audit');
  const ready = ['##DR 1', '##DR py 3.6.8', `##DR file ${P0.program} ${B.programSha()} 0:0:644`, `##DR file ${P0.wrapper} ${B.wrapperSha(P0.dir)} 0:0:755`, ...B.dirsToCheck(P0).all.map((d) => `##DR dir ${d} 0:0:755`), '##DR sudo ok', '##DR end'];
  A.handleEdgeAudit('edge-pl', mine, { results: [{ runId: r.runId, result: { mode: 'install', ok: true, kind: 'done', dir: P0.dir, ready, install: { code: 'ok', step: 7, acct: 'pl-ops', key: 'pl-common', src: 'corp' } } }] }, Date.now() + 3000);
  await new Promise((res) => setTimeout(res, 50));
  const rec = A.readinessOf(te.id);
  assert.equal(rec.state, 'ready'); assert.equal(rec.dir, '/opt/dvc/disk-audit'); assert.equal(rec.lastInstall.code, 'ok'); assert.equal(rec.lastInstall.acct, 'pl-ops');
  // 점검 · 준비 확인 후보 = 기억한 곳 → 지금 설정 → 기본 경로
  SET.saveInstallDir('/app/tools/dvc', { by: 'own' });
  assert.deepEqual(A.dirCandidates(rec), ['/opt/dvc/disk-audit', '/app/tools/dvc', '']);
  const ck = A.requestAudit(te, { mode: 'check', by: 'own', now: Date.now() + 120_000 });
  assert.equal(ck.ok, true, JSON.stringify(ck));
  // 결과가 후보 밖 위치를 말하면 반영하지 않는다
  A.handleEdgeAudit('edge-pl', mine, { results: [{ runId: ck.runId, result: { mode: 'check', ok: true, kind: 'done', dir: '/srv/other/x', ready } }] }, Date.now() + 130_000);
  await new Promise((res) => setTimeout(res, 50));
  const rec2 = A.readinessOf(te.id);
  assert.equal(rec2.dir, '/opt/dvc/disk-audit', '설치 위치를 바꾸지 않는다'); assert.equal(rec2.lastError.kind, 'bad-output');
  SET.saveInstallDir('', { by: 'own' });
});

test('⑥-2 실행기 — 준비 확인은 후보 디렉터리를 차례로 · 파일이 있는 첫 곳 · 그곳의 실행 명령', async () => {
  const dirs = ['/opt/dvc/disk-audit', ''];
  const f = fakeConnect({ dir: '' });
  const execs = [];
  const conn = async (o, fn) => f.connect(o, (api) => fn({ ...api, exec: async (cmd, ms) => { execs.push(cmd); if (cmd.includes('##DR 1') && cmd.includes('/opt/dvc/disk-audit')) return { stdout: ['##DR 1', '##DR py 3.6.8', '##DR file /opt/dvc/disk-audit/rhel_disk_audit.py - -', '##DR file /opt/dvc/disk-audit/dvc-disk-audit - -', '##DR sudo no', '##DR end'].join('\n') }; return api.exec(cmd, ms); },
    execStream: async (cmd) => { execs.push(cmd); return { code: 0, stderr: '' }; } }));
  const r = await R.auditOnce(T, { mode: 'run', keys: KEYS, connect: conn, expect: { cands: dirs, program: B.programSha() } });
  assert.equal(r.dir, '', '지정 디렉터리에 없으면 기본 경로에서 찾는다');
  assert.ok(execs.includes('sudo -n /usr/local/sbin/dvc-disk-audit'), '찾은 곳의 실행 명령');
  assert.deepEqual(R.candidateDirs({ cands: ['/opt/dvc/disk-audit', '/opt/../etc', '/opt/dvc/disk-audit', '', '/x/y'] }), ['/opt/dvc/disk-audit'], '셋까지만 보고 · 규칙 밖 · 겹침은 뺀다');
  assert.deepEqual(R.candidateDirs({ cands: ['/opt/../etc'] }), [''], '남는 것이 없으면 기본 경로');
  assert.deepEqual(R.candidateDirs(null), [''], '옛 중앙 작업 — 기본 경로');
});

/* ── ⑦ ── */
test('⑦ 설정 손상 · 라우트 문(관리자 · 설정 소유자 등급 · 데모 · OTP) · 503', async () => {
  SET._resetForTest(); SET.saveInstallDir('', { by: 'own' });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const svc = await import('../src/focusmon/service.js');
  const { auditEntriesWithAction } = await import('../src/audit.js');
  const users = { own: { username: 'own', role: 'admin', scope: null }, adm: { username: 'adm', role: 'admin', scope: null }, op: { username: 'op', role: 'operator', scope: null },
    sown: { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } }, demo: { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true } };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'own']; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, { who = 'own', body } = {}) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': who }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    const g = await call('GET', '/api/tools/focus-mon/audit');
    assert.equal(g.status, 200); assert.ok(g.body.install); assert.equal(g.body.install.settings.dir, '');
    assert.ok(g.body.install.cred && Object.keys(g.body.install.cred).length > 0, '서버마다 설치 계정 상태');
    assert.equal(JSON.stringify(g.body.install).includes('PRIVATE KEY'), false);
    for (const who of ['op', 'adm', 'sown', 'demo']) {
      assert.equal((await call('PUT', '/api/tools/focus-mon/audit/install-dir', { who, body: { dir: '/opt/dvc/x' } })).status, 403, `디렉터리 저장 ${who}`);
      assert.equal((await call('POST', '/api/tools/focus-mon/audit/install', { who, body: { ids: ['fm-d0000000'] } })).status, 403, `설치 ${who}`);
    }
    assert.equal((await call('PUT', '/api/tools/focus-mon/audit/install-dir', { body: { dir: '/tmp/x' } })).body.code, 'denied');
    const ok = await call('PUT', '/api/tools/focus-mon/audit/install-dir', { body: { dir: '/opt/dvc/disk-audit' } });
    assert.equal(ok.status, 200); assert.ok(auditEntriesWithAction('focus-mon.audit.install-dir').length >= 1, JSON.stringify(auditEntriesWithAction('focus-mon.audit.install-dir')).slice(0, 300));
    const sh = await fetch(`${base}/api/tools/focus-mon/audit/install.sh`, { headers: { 'x-test-user': 'own' } });
    assert.match(await sh.text(), /디렉터리 \/opt\/dvc\/disk-audit/, '손으로 받는 설치 파일도 지금 디렉터리');
    // 데모 대상 설치(장비에 닿지 않는다)
    const ins = await call('POST', '/api/tools/focus-mon/audit/install', { body: { ids: ['fm-d0000000', 'fm-d0000003', 'fm-nope0000'] } });
    assert.equal(ins.status, 200); assert.equal(ins.body.results.find((x) => x.id === 'fm-nope0000').code, 'not-found');
    assert.ok(ins.body.results.find((x) => x.id === 'fm-d0000000').ok, JSON.stringify(ins.body.results));
    assert.ok(auditEntriesWithAction('focus-mon.audit.install').length >= 1);
    // 설정 손상 → 503 · 재시작(보존본만)해도 503 · 저장 거절
    fs.writeFileSync(path.join(DIR, SET.SETTINGS_FILE), '{ broken'); SET._resetForTest();
    assert.equal((await call('POST', '/api/tools/focus-mon/audit/install', { body: { ids: ['fm-d0000001'] } })).status, 503);
    SET._resetForTest();
    assert.ok(!fs.existsSync(path.join(DIR, SET.SETTINGS_FILE)));
    assert.equal(SET.installDir(), null, '재시작 뒤에도 모름 — 기본 경로로 지어내지 않는다');
    assert.equal((await call('PUT', '/api/tools/focus-mon/audit/install-dir', { body: { dir: '' } })).status, 503);
    assert.equal((await fetch(`${base}/api/tools/focus-mon/audit/install.sh`, { headers: { 'x-test-user': 'own' } })).status, 503);
    for (const f of fs.readdirSync(DIR)) if (f.startsWith(SET.SETTINGS_FILE)) fs.rmSync(path.join(DIR, f));
    SET._resetForTest();
  } finally { svc.stopFocusMon(); srv.close(); }
});

test('⑧ SSH 공용 접속 기능 목록 · 웹 글 1:1', () => {
  assert.ok(KS.KEY_FEATURES.includes('disk-audit-install'));
  for (const s of C.CRED_STATES) assert.ok(W.CRED_TEXT[s], `웹 글: ${s}`);
  for (const s of I.INSTALL_CODES) assert.ok(W.INSTALL_CODE_TEXT[s], `웹 글: ${s}`);
  for (const s of B.INSTALL_FAILS) assert.ok(W.INSTALL_FAIL_TEXT[s], `웹 글: ${s}`);
  assert.equal(W.STEP_LABELS.length, I.INSTALL_STEPS.length);
});

test('⑨ 엣지 — 설치 작업은 설치 줄로 · 설치 계정 보고는 목록을 받은 뒤 60초에 한 번 · 비밀 없음', async () => {
  const Wk = await import('../src/agent/focusMonWorker.js');
  const src = fs.readFileSync(new URL('../src/agent/focusMonWorker.js', import.meta.url), 'utf8');
  assert.match(src, /const sub = j\.mode === 'install'\n\s+\? installRunner\.submit\(/, '설치 작업은 점검 실행 줄이 아니라 설치 줄로');
  assert.match(src, /exec: installExec\(\{ edge: true \}\)/, '엣지는 자기 법인의 계정(edge 모드)');
  assert.equal(Wk.credReport(Date.now(), () => ({ state: 'ok' })), null, '맡은 서버 목록을 받기 전에는 보고하지 않는다');
  Wk._setKnownForTest([{ id: 'fm-eeeeeeee01', name: 'pl-db-01', host: '10.48.0.1', port: 22 }]);
  const now = Date.now();
  const rep = Wk.credReport(now, () => ({ state: 'ok', src: 'corp', acct: 'pl-ops', key: 'pl-common', auth: { privateKey: 'SECRET-PEM' } }));
  assert.deepEqual(rep['fm-eeeeeeee01'], { state: 'ok', src: 'corp', acct: 'pl-ops', key: 'pl-common' });
  assert.equal(JSON.stringify(rep).includes('SECRET'), false, '보고에 비밀 없음');
  assert.equal(Wk.credReport(now + 1000, () => ({ state: 'ok' })), null, '60초에 한 번');
  assert.ok(Wk.credReport(now + 61_000, () => ({ state: 'ok' })));
  Wk._setKnownForTest([]);
});
