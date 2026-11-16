/**
 * v3.18.0 — 서버 집중 모니터링 **접속 자동 준비**(수집 계정 · 공개키를 엣지의 root 키로 · 고르면 디스크 점검 설치까지).
 * 사용자: "집중 모니터링을 하려면 SSH 로그인 정보를 추가해야 하는데, 지금 엣지에서 root 로 ssh 접근이 되니까 자동으로 설치하는 기능 만들어줘"
 * 시안 ⑲(docs/design/focus-mon/README.md §22) · '진행해' = 컨펌 15항목 괄호 값.
 *
 *  ① 공개키 줄 · 준비 파일 문법 · 명령 값 · 표지 해석
 *  ② 준비 파일을 **실제로 셸로** 돌린다 — 가짜 sshd · getent · useradd · runuser 로(CI 에서도) sshd 정책 판단 · 계정 · 키 쓰기 · 심링크 · 줄바꿈 · 같은 키
 *  ③ 준비 실행(prepOnce) — 권한 · 주소 제한 · 올린 파일 · 연결 시험 · 디스크 점검 함께(같은 키만) · 시한 산수 · 시한 넘으면 정리
 *  ④ 준비 계정 — 'focus-mon-prep' 을 직접 켠 키만(‘설치’ 키 · 예전 키 아님)
 *  ⑤ 중앙 — 접수(root · 같은 주소 · 엣지 보고) · 엣지 배달(caps 'prep' · 준비 계정 보고 · 함께면 'install' 도) · 결과 정제 · 반영(키 로그인 칸 · 설치)
 *  ⑥ 라우트 — 문(어느 문이 막았는지) · 503 · 데모 · 감사
 *  ⑦ 엣지 워커 · 웹 글 1:1
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'focusmonprep3180-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.SETTINGS_OWNERS = 'own,sown';
process.env.CENTRAL_TOKEN = 'ctok-prep-3180';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-prep-3180-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
delete process.env.CENTRAL_URL;
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify({ users: [
  { username: 'own', role: 'admin' }, { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } }, { username: 'adm', role: 'admin' }, { username: 'op', role: 'operator' },
] }));

const PR = await import('../src/focusmon/audit/prep.js');
const I = await import('../src/focusmon/audit/install.js');
const B = await import('../src/focusmon/audit/bundle.js');
const C = await import('../src/focusmon/audit/installCred.js');
const SET = await import('../src/focusmon/audit/settings.js');
const A = await import('../src/focusmon/audit/service.js');
const FS = await import('../src/focusmon/store.js');
const W = await import('../../web/src/views/tools/focusMonPrepText.js');
const { READY_TIMEOUT_MS } = await import('../src/focusmon/collector.js');
const F = await import('./_sshKeyFixtures.js');
const VAULT = await import('../src/security/secretVault.js');
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const KS = await import('../src/bmusage/onboard/keyStore.js');
const BM = await import('../src/bmstor/registry.js');

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMAk2Lxi5YNyB4sH7jV4nJGJiWlU4HAy6+YojtTxQLC3 dvc-focusmon@node1';
const BLOB = PUB.split(' ')[1];

/* ── ① ── */
test('① 공개키 줄 · 준비 파일 문법 · 명령 값 · 표지 해석', () => {
  const k = PR.keyLineFor(PUB);
  assert.equal(k.line, `restrict ${PUB}`); assert.equal(k.blob, BLOB);
  assert.equal(PR.keyLineFor(PUB, { from: '10.48.0.5' }).line, `restrict,from="10.48.0.5" ${PUB}`);
  assert.equal(PR.keyLineFor(PUB, { from: 'fe80::1' }).line.startsWith('restrict,from="fe80::1" '), true);
  for (const bad of ['10.0.0.1" command="id', '10.0.0.256', '010.0.0.1', '*', '10.0.0.1,10.0.0.2', 'host.example']) assert.equal(PR.keyLineFor(PUB, { from: bad }), null, `주소 ${bad}`);
  for (const bad of ['', 'ssh-dss AAAAB3NzaC1kc3MAAACBAP7 x', `${PUB}'; id`, `ssh-ed25519 ${BLOB} a b`, `ssh-ed25519 ${BLOB} co'mment`, 'ssh-ed25519 AAAA$(id)AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']) assert.equal(PR.keyLineFor(bad), null, `공개키 ${bad}`);
  assert.equal(PR.keyLineFor('ssh-ed25519 ' + BLOB).line, `restrict ssh-ed25519 ${BLOB} dvc-focusmon`, '주석이 없으면 dvc-focusmon');
  assert.throws(() => PR.prepScript({ line: "restrict x'y", blob: 'AAAA' }), /규칙/);
  assert.throws(() => PR.prepScript({ line: 'restrict x', blob: 'AA$(id)' }), /규칙/);
  const s = PR.prepScript(k);
  const f = path.join(DIR, 'p.sh'); fs.writeFileSync(f, s);
  for (const sh of ['dash', 'bash']) { if (spawnSync('sh', ['-c', `command -v ${sh}`]).status === 0) assert.equal(spawnSync(sh, ['-n', f]).status, 0, `${sh} 문법`); }
  assert.ok(s.includes(`KEYLINE='${k.line}'`) && s.includes(`BLOB='${BLOB}'`), '공개키 줄은 파일 안에(명령에 넣지 않는다)');
  assert.match(s, /"\$SSHD" -T -C "user=\$A,host=localhost,addr=127\.0\.0\.1"/, 'sshd 설정은 읽기만(-T)');
  assert.doesNotMatch(s, /sshd_config|systemctl|service sshd|>\s*\/etc\/ssh/, 'sshd 설정 · 서비스를 바꾸지 않는다');
  assert.match(s, /"\$RU" -u "\$A" -- \/bin\/sh -c "\$W"/, '공개키는 그 계정 권한으로 쓴다');
  assert.match(s, /chage -M 99999 -E -1 -I -1 "\$A"/, '만든 계정 기본 = 만료 없음');
  assert.doesNotMatch(PR.prepScript(k, { age: 'default' }), /chage -M/, '서버 기본값이면 만료를 바꾸지 않는다');
  assert.match(s, /usermod -p '\*' "\$A"/, '비밀번호 칸은 *(잠금 표시 ! 가 아니다 — UsePAM no 에서도 키 로그인)');
  // 명령 값
  assert.equal(PR.prepCommand({ sudo: true, file: '.dvc-fm-prep.0123456789abcdef.sh', acct: 'dvcmon' }), 'sudo -n /bin/sh "$HOME/.dvc-fm-prep.0123456789abcdef.sh" dvcmon; echo "##DP rc $?"; rm -f "$HOME/.dvc-fm-prep.0123456789abcdef.sh"');
  assert.throws(() => PR.prepCommand({ sudo: true, file: '../x.sh', acct: 'dvcmon' }));
  assert.throws(() => PR.prepCommand({ sudo: true, file: '.dvc-fm-prep.0123456789abcdef.sh', acct: 'x;id' }));
  assert.throws(() => PR.prepCleanupCommand('.dvc-da-install.0123456789abcdef.sh'), '준비 파일 이름 규칙만');
  // 표지
  const p = PR.parsePrepOut('##DP step sshd\n##DP step acct\n##DP created\n##DP step key\n##DP added\n##DP warn home-perm\n##DP warn evil\n##DP ok\n##DP rc 0\nnoise');
  assert.deepEqual([p.ok, p.created, p.added, p.rc, p.warn], [true, true, true, 0, ['home-perm']]);
  assert.equal(PR.parsePrepOut('##DP fail nope').fail, 'other'); assert.equal(PR.parsePrepOut('##DP fail sshd-allow').fail, 'sshd-allow');
  assert.deepEqual(PR.parsePrivOut('##DI priv sudo\n##DP from 10.48.0.5'), { priv: 'sudo', from: '10.48.0.5' });
  assert.deepEqual(PR.parsePrivOut('##DI priv root\n##DP from 10.0.0.1"x'), { priv: 'root', from: null }, '출발 주소는 규칙을 지난 것만');
  assert.equal(PR.parsePrivOut('').priv, 'no');
  const po = spawnSync('sh', ['-c', PR.PREP_PRIV_COMMAND], { encoding: 'utf8', env: { ...process.env, SSH_CONNECTION: '10.1.2.3 51515 10.9.9.9 22' } }).stdout;
  assert.match(po, /^##DI priv (root|sudo|tty|no)$/m); assert.match(po, /^##DP from 10\.1\.2\.3$/m);
});

/* ── ② 준비 파일을 셸로(가짜 sshd · getent · useradd · runuser) ── */
function sandbox({ sshdT, passwd = '', sshdRc = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(DIR, 'sb-'));
  const bin = path.join(root, 'bin'); const homes = path.join(root, 'home'); fs.mkdirSync(bin); fs.mkdirSync(homes);
  const pw = path.join(root, 'passwd'); fs.writeFileSync(pw, passwd.replace(/@HOME@/g, homes));
  const log = path.join(root, 'log'); fs.writeFileSync(log, '');
  const T = path.join(root, 'sshdT'); fs.writeFileSync(T, sshdT ?? 'pubkeyauthentication yes\nauthorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2\nusepam yes\n');
  const w = (n, body) => { fs.writeFileSync(path.join(bin, n), `#!/bin/sh\n${body}\n`); fs.chmodSync(path.join(bin, n), 0o755); };
  w('sshd', `echo "sshd $*" >> '${log}'; cat '${T}'; exit ${sshdRc}`);
  w('getent', `grep "^$2:" '${pw}' || exit 2`);
  w('useradd', `for a; do n="$a"; done; echo "useradd $*" >> '${log}'; mkdir -p '${homes}'/"$n"; echo "$n:x:1500:1500::${homes}/$n:/bin/bash" >> '${pw}'`);
  w('usermod', `echo "usermod $*" >> '${log}'`);
  w('chage', `echo "chage $*" >> '${log}'`);
  w('runuser', `echo "runuser $1 $2" >> '${log}'; shift 3; exec "$@"`); // -u A -- /bin/sh -c W arg0 D LINE BLOB → 지금 계정으로 W 를 돌린다
  w('id', 'echo 0');
  return { root, bin, homes, pw, log, T };
}
/** 준비 파일을 가짜 bin 으로 — PATH 줄만 바꾼다(그 밖은 받은 그대로). */
function runPrep(sb, acct, { age = 'never', from = null, args } = {}) {
  const s = PR.prepScript(PR.keyLineFor(PUB, { from }), { age }).replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH', `PATH=${sb.bin}:/usr/bin:/bin; export PATH`);
  const f = path.join(sb.root, 'prep.sh'); fs.writeFileSync(f, s);
  const r = spawnSync('sh', [f, ...(args || [acct])], { encoding: 'utf8' });
  return { rc: r.status, out: r.stdout, p: PR.parsePrepOut(r.stdout), log: fs.readFileSync(sb.log, 'utf8') };
}
test('② 준비 파일을 실제로 돌린다 — sshd 정책 · 계정 · 키 쓰기 · 심링크 · 줄바꿈 · 같은 키', () => {
  // 새 계정
  let sb = sandbox();
  let r = runPrep(sb, 'dvcmon');
  assert.equal(r.rc, 0, r.out); assert.equal(r.p.ok, true); assert.equal(r.p.created, true); assert.equal(r.p.added, true);
  assert.match(r.log, /sshd -T -C user=dvcmon,host=localhost,addr=127\.0\.0\.1/); assert.match(r.log, /useradd -m -s \/bin\/(bash|sh) dvcmon/);
  assert.match(r.log, /usermod -p \* dvcmon/); assert.match(r.log, /chage -M 99999 -E -1 -I -1 dvcmon/); assert.match(r.log, /runuser -u dvcmon/);
  const ak = path.join(sb.homes, 'dvcmon', '.ssh', 'authorized_keys');
  assert.equal(fs.readFileSync(ak, 'utf8'), `restrict ${PUB}\n`);
  assert.equal(fs.statSync(path.dirname(ak)).mode & 0o777, 0o700); assert.equal(fs.statSync(ak).mode & 0o777, 0o600);
  // 다시 — 같은 키 · 계정 있음
  r = runPrep(sb, 'dvcmon');
  assert.equal(r.p.ok, true); assert.equal(r.p.exists, true); assert.equal(r.p.have, true); assert.equal(r.p.added, false);
  assert.equal(fs.readFileSync(ak, 'utf8').split('\n').filter(Boolean).length, 1, '같은 키를 두 번 넣지 않는다');
  // 줄바꿈 없는 기존 파일 · 다른 줄은 그대로
  fs.writeFileSync(ak, 'ssh-rsa AAAAB3OTHER other@host');
  r = runPrep(sb, 'dvcmon');
  assert.equal(fs.readFileSync(ak, 'utf8'), `ssh-rsa AAAAB3OTHER other@host\nrestrict ${PUB}\n`, '앞 줄과 붙지 않는다');
  // 만료 서버 기본값
  sb = sandbox(); r = runPrep(sb, 'svcmon', { age: 'default' });
  assert.equal(r.p.ok, true); assert.doesNotMatch(r.log, /chage/);
  // 주소 제한
  sb = sandbox(); r = runPrep(sb, 'dvcmon', { from: '10.48.0.5' });
  assert.equal(fs.readFileSync(path.join(sb.homes, 'dvcmon', '.ssh', 'authorized_keys'), 'utf8'), `restrict,from="10.48.0.5" ${PUB}\n`);
  // sshd 정책 — 막혀 있으면 아무것도 바꾸지 않는다(계정을 만들지 않는다)
  const base = 'pubkeyauthentication yes\nauthorizedkeysfile .ssh/authorized_keys\n';
  const cases = [
    ['allowusers someone\nallowusers dvc*@10.0.0.1\n', 'sshd-allow'], ['denyusers dvc*\n', 'sshd-deny'], ['denyusers dvcmon@10.0.0.1\n', 'sshd-deny'], ['denyusers !x\n', 'sshd-deny'],
    ['allowgroups wheel\n', 'sshd-groups'], ['denygroups nobody\n', 'sshd-groups'],
  ];
  for (const [extra, code] of cases) {
    sb = sandbox({ sshdT: base + extra }); r = runPrep(sb, 'dvcmon');
    assert.equal(r.p.fail, code, extra); assert.equal(r.rc, 71); assert.doesNotMatch(r.log, /useradd|runuser/, `${code} — 아무것도 바꾸지 않는다`);
  }
  sb = sandbox({ sshdT: `${base}allowusers dvc*\nallowusers admin\n` }); assert.equal(runPrep(sb, 'dvcmon').p.ok, true, 'AllowUsers 패턴이 맞으면 한다');
  // 패턴이 작업 폴더의 파일 이름으로 펼쳐지지 않는다(set -f) — 'dvc*' 가 파일 'dvcfile' 로 바뀌면 맞는 계정을 막는다
  sb = sandbox({ sshdT: `${base}allowusers dvc*\n` });
  { const cwd = fs.mkdtempSync(path.join(sb.root, 'cwd-')); fs.writeFileSync(path.join(cwd, 'dvcfile'), '');
    const s2 = PR.prepScript(PR.keyLineFor(PUB)).replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH', `PATH=${sb.bin}:/usr/bin:/bin; export PATH`);
    const f2 = path.join(sb.root, 'p2.sh'); fs.writeFileSync(f2, s2);
    const rr = spawnSync('sh', [f2, 'dvcmon'], { encoding: 'utf8', cwd }); assert.equal(PR.parsePrepOut(rr.stdout).ok, true, rr.stdout); }
  sb = sandbox({ sshdT: 'pubkeyauthentication no\nauthorizedkeysfile .ssh/authorized_keys\n' }); assert.equal(runPrep(sb, 'dvcmon').p.fail, 'sshd-pubkey');
  sb = sandbox({ sshdT: 'pubkeyauthentication yes\nauthorizedkeysfile /etc/ssh/keys/%u\n' }); assert.equal(runPrep(sb, 'dvcmon').p.fail, 'sshd-akfile');
  sb = sandbox({ sshdT: 'pubkeyauthentication yes\nauthorizedkeysfile %h/.ssh/authorized_keys\n' }); assert.equal(runPrep(sb, 'dvcmon').p.ok, true, '%h/.ssh/authorized_keys 도 기본 위치');
  sb = sandbox({ sshdT: '', sshdRc: 1 }); assert.equal(runPrep(sb, 'dvcmon').p.fail, 'sshd-unread', 'sshd -T 를 못 읽으면 멈춘다');
  // 있는 계정 — uid 0 · nologin · 홈 없음
  sb = sandbox({ passwd: 'toor:x:0:0::@HOME@/toor:/bin/bash\n' }); assert.equal(runPrep(sb, 'toor').p.fail, 'acct-root');
  sb = sandbox({ passwd: 'svc:x:900:900::@HOME@/svc:/sbin/nologin\n' }); r = runPrep(sb, 'svc'); assert.equal(r.p.fail, 'acct-shell'); assert.doesNotMatch(r.log, /runuser|usermod/);
  sb = sandbox({ passwd: 'gone:x:901:901::@HOME@/gone:/bin/bash\n' }); assert.equal(runPrep(sb, 'gone').p.fail, 'acct-home');
  sb = sandbox({ passwd: 'odd:x:902:902::@HOME@/o d:/bin/bash\n' }); assert.equal(runPrep(sb, 'odd').p.fail, 'acct-home', '홈 경로 글자 규칙');
  // 있는 계정은 바꾸지 않는다(usermod · chage 없음)
  sb = sandbox({ passwd: 'mon:x:903:903::@HOME@/mon:/bin/bash\n' }); fs.mkdirSync(path.join(sb.homes, 'mon'));
  r = runPrep(sb, 'mon'); assert.equal(r.p.ok, true); assert.equal(r.p.exists, true); assert.doesNotMatch(r.log, /usermod|chage|useradd/);
  // 심링크 — .ssh · authorized_keys 둘 다 거절 · 가리킨 파일은 그대로
  sb = sandbox({ passwd: 'sym:x:904:904::@HOME@/sym:/bin/bash\n' }); fs.mkdirSync(path.join(sb.homes, 'sym'));
  const victim = path.join(sb.root, 'victim'); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, 'authorized_keys'), 'ORIG\n');
  fs.symlinkSync(victim, path.join(sb.homes, 'sym', '.ssh'));
  assert.equal(runPrep(sb, 'sym').p.fail, 'key-symlink'); assert.equal(fs.readFileSync(path.join(victim, 'authorized_keys'), 'utf8'), 'ORIG\n');
  fs.unlinkSync(path.join(sb.homes, 'sym', '.ssh')); fs.mkdirSync(path.join(sb.homes, 'sym', '.ssh')); fs.symlinkSync(path.join(victim, 'authorized_keys'), path.join(sb.homes, 'sym', '.ssh', 'authorized_keys'));
  assert.equal(runPrep(sb, 'sym').p.fail, 'key-symlink'); assert.equal(fs.readFileSync(path.join(victim, 'authorized_keys'), 'utf8'), 'ORIG\n');
  // 인자 · root · 계정 이름
  sb = sandbox();
  for (const args of [['x;id'], ['a', 'b'], [], ['-x'], ['1abc'], [`a${'b'.repeat(40)}`]]) assert.equal(runPrep(sb, null, { args }).p.fail, 'args', JSON.stringify(args));
  assert.equal(runPrep(sb, 'root').p.fail, 'acct-root');
  // root 가 아니면(가짜 id 를 빼고 실제 id — CI 계정이 root 일 수 있어 그때는 건너뛴다)
  if (process.getuid && process.getuid() !== 0) {
    const s = PR.prepScript(PR.keyLineFor(PUB)); const f = path.join(sb.root, 'real.sh'); fs.writeFileSync(f, s);
    const rr = spawnSync('sh', [f, 'dvcmon'], { encoding: 'utf8' }); assert.equal(rr.status, 77); assert.match(rr.stdout, /##DP fail not-root/);
  }
});

/* ── ③ 준비 실행(prepOnce) ── */
const KEYS = { keyInfo: () => ({ usable: true, publicKey: PUB, fingerprint: 'SHA256:focusfp' }), privateKeyForConnect: () => 'FOCUS-PEM' };
const T = { id: 'fm-pppppppp01', name: 'kr-db-01', host: '10.1.0.1', port: 22, username: 'dvcmon' };
const credPrep = (keyId = 'K1') => (t, o) => (o.feature === C.PREP_FEATURE
  ? { state: 'ok', src: 'server', acct: 'root', key: 'kr-root', keyId, ...(o.withAuth ? { auth: { username: 'root', privateKey: 'ROOT-PEM', passphrase: '', fingerprint: 'SHA256:rootfp' } } : {}) }
  : { state: 'ok', src: 'server', acct: 'root', key: 'kr-root', keyId: 'K1', ...(o.withAuth ? { auth: { username: 'root', privateKey: 'ROOT-PEM', passphrase: '', fingerprint: 'SHA256:rootfp' } } : {}) });
function fakeConn({ priv = 'root', from = '10.48.0.5', out = '##DP step sshd\n##DP step acct\n##DP created\n##DP step key\n##DP added\n##DP ok\n##DP rc 0', execThrow = null } = {}) {
  const log = { conns: [], execs: [], writes: [] };
  const connect = async (o, fn) => {
    log.conns.push({ username: o.username, key: String(o.privateKey).slice(0, 8) });
    return fn({
      exec: async (cmd, ms) => {
        log.execs.push([cmd, ms]);
        if (cmd === PR.PREP_PRIV_COMMAND) return { stdout: `##DI priv ${priv}\n${from ? `##DP from ${from}\n` : ''}`, code: 0 };
        if (cmd.includes('.dvc-fm-prep.') && cmd.includes('/bin/sh') && execThrow) throw execThrow;
        if (cmd.includes('.dvc-fm-prep.') && cmd.includes('/bin/sh')) return { stdout: out, code: 0 };
        return { stdout: '', code: 0 };
      },
      writeFile: async (p, c, m) => { log.writes.push({ p, c, m }); },
    });
  };
  return { connect, log };
}
test('③ 준비 실행 — 권한 · 주소 제한 · 올린 파일 · 연결 시험 · 디스크 점검 함께 · 시한', async () => {
  I._resetInstallForTest();
  const okTest = async (t, o) => { assert.equal(o.keys, KEYS, '연결 시험은 집중 모니터링 키로'); return { ok: true, kind: 'ok', hello: { isLinux: true }, ms: 5 }; };
  // sudo 비밀번호 — 아무것도 올리지 않는다
  let f = fakeConn({ priv: 'no' });
  let r = await PR.prepOnce(T, { keys: KEYS, connect: f.connect, credOf: credPrep(), test: okTest });
  assert.equal(r.prep.code, 'sudo-password'); assert.equal(f.log.writes.length, 0); assert.equal(r.login, null);
  f = fakeConn({ priv: 'tty' }); assert.equal((await PR.prepOnce(T, { keys: KEYS, connect: f.connect, credOf: credPrep(), test: okTest })).prep.code, 'sudo-tty');
  // 주소 제한을 골랐는데 출발 주소를 모른다 — 올리지 않는다
  f = fakeConn({ from: null });
  r = await PR.prepOnce(T, { keys: KEYS, connect: f.connect, credOf: credPrep(), test: okTest, expect: { from: true } });
  assert.equal(r.prep.code, 'from-unknown'); assert.equal(f.log.writes.length, 0);
  // 성공 — 파일 0600 · 이름 · 안의 공개키 · 주소 제한 · 명령 값 · 연결 시험
  f = fakeConn({ priv: 'sudo' });
  r = await PR.prepOnce(T, { keys: KEYS, connect: f.connect, credOf: credPrep(), test: okTest, expect: { from: true } });
  assert.equal(r.ok, true, JSON.stringify(r.prep)); assert.equal(r.prep.code, 'ok'); assert.equal(r.prep.step, 7); assert.equal(r.prep.created, true); assert.equal(r.login.kind, 'ok');
  assert.equal(r.auditSkip, 'off');
  assert.equal(f.log.conns[0].username, 'root'); assert.equal(f.log.conns[0].key, 'ROOT-PEM', '준비는 준비 계정의 키로');
  assert.equal(f.log.writes.length, 1); assert.match(f.log.writes[0].p, PR.PREP_FILE_RE); assert.equal(f.log.writes[0].m, 0o600);
  assert.ok(f.log.writes[0].c.includes(`KEYLINE='restrict,from="10.48.0.5" ${PUB}'`), '대상 서버가 본 노드 주소로 제한');
  const ex = f.log.execs.find(([c]) => c.includes('/bin/sh "$HOME/'));
  assert.match(ex[0], /^sudo -n \/bin\/sh "\$HOME\/\.dvc-fm-prep\.[0-9a-f]{16}\.sh" dvcmon; echo "##DP rc \$\?"; rm -f "\$HOME\/\.dvc-fm-prep\.[0-9a-f]{16}\.sh"$/);
  assert.equal(ex[1], PR.PREP_EXEC_MS);
  // 키 로그인 실패 — 'login'(넣었지만)
  f = fakeConn();
  r = await PR.prepOnce(T, { keys: KEYS, connect: f.connect, credOf: credPrep(), test: async () => ({ ok: false, kind: 'auth' }) });
  assert.equal(r.prep.code, 'login'); assert.equal(r.ok, false); assert.equal(r.prep.added, true);
  // 준비 파일이 멈춤
  f = fakeConn({ out: '##DP step sshd\n##DP fail sshd-allow\n##DP rc 71' });
  r = await PR.prepOnce(T, { keys: KEYS, connect: f.connect, credOf: credPrep(), test: okTest });
  assert.equal(r.prep.code, 'script'); assert.equal(r.prep.fail, 'sshd-allow'); assert.equal(r.prep.step, 3); assert.equal(r.login, null, '멈추면 연결 시험도 하지 않는다');
  // 수집 계정 root · 이름 규칙
  assert.equal((await PR.prepOnce({ ...T, username: 'root' }, { keys: KEYS, connect: f.connect, credOf: credPrep(), test: okTest })).prep.code, 'acct-root');
  assert.equal((await PR.prepOnce({ ...T, username: 'x;id' }, { keys: KEYS, connect: f.connect, credOf: credPrep(), test: okTest })).prep.code, 'bad-acct');
  // 노드 키가 없으면
  assert.equal((await PR.prepOnce(T, { keys: { keyInfo: () => ({ usable: false }) }, connect: f.connect, credOf: credPrep(), test: okTest })).prep.code, 'no-key');
  // 준비 계정 — 'focus-mon-prep' 기능으로 묻는다
  const seen = [];
  await PR.prepOnce(T, { keys: KEYS, connect: f.connect, credOf: (t, o) => { seen.push(o.feature); return { state: 'feature' }; }, test: okTest });
  assert.deepEqual(seen, [C.PREP_FEATURE]);
  // 디스크 점검 함께 — 같은 키만 · 키 로그인이 된 뒤에만
  f = fakeConn();
  r = await PR.prepOnce(T, { keys: KEYS, connect: f.connect, credOf: credPrep('K2'), test: okTest, expect: { audit: true, dir: '' } });
  assert.equal(r.auditSkip, 'key', '설치 계정이 다른 키면 준비만'); assert.equal(r.install, null);
  r = await PR.prepOnce(T, { keys: KEYS, connect: f.connect, credOf: credPrep(), test: async () => ({ ok: false, kind: 'auth' }), expect: { audit: true, dir: '' } });
  assert.equal(r.auditSkip, 'login');
  r = await PR.prepOnce(T, { keys: KEYS, connect: f.connect, credOf: (t, o) => (o.feature === C.PREP_FEATURE ? credPrep()(t, o) : { state: 'feature' }), test: okTest, expect: { audit: true, dir: '' } });
  assert.equal(r.auditSkip, 'cred');
  // 같은 키 — 설치까지(설치 실행은 install.installOnce — 그 결과를 그대로 싣는다)
  const fi = fakeConn();
  const conn2 = async (o, fn) => fi.connect(o, (api) => fn({ ...api, exec: async (cmd, ms) => (cmd.includes('.dvc-da-install.') && cmd.includes('/bin/sh') ? { stdout: '##DI step dir\n##DI step files\n##DI step sudoers\n##DI ok\n##DI rc 0' } : cmd === I.PRIV_COMMAND ? { stdout: '##DI priv root' } : api.exec(cmd, ms)) }));
  r = await PR.prepOnce(T, { keys: KEYS, connect: conn2, credOf: credPrep(), test: okTest, expect: { audit: true, dir: '', program: B.programSha() } });
  assert.equal(r.auditSkip, null); assert.ok(r.install, '설치 결과를 싣는다'); assert.ok(['ok', 'check'].includes(r.install.code), JSON.stringify(r.install));
  // 데모 — 장비에 닿지 않는다
  r = await PR.prepOnce({ ...T, id: 'fm-d0000002', demo: true }, { keys: KEYS, connect: () => { throw new Error('닿으면 안 됨'); }, credOf: () => { throw new Error('닿으면 안 됨'); }, expect: { audit: true, dir: '' } });
  assert.equal(r.ok, true); assert.equal(r.login.kind, 'ok'); assert.ok(r.install && r.install.code === 'ok' && r.ready.length > 3, '데모 설치 길도 준비 줄을 낸다');
  // 시한 산수 · 준비 exec 가 넘치면 올린 파일만 지우고 timeout
  assert.ok(READY_TIMEOUT_MS + PR.PREP_PRIV_MS + PR.PREP_UPLOAD_MS + PR.PREP_EXEC_MS + PR.PREP_CLEANUP_MS + PR.PREP_MARGIN_MS <= PR.PREP_TIMEOUT_MS, '접속 + 권한 + 올림 + 준비 + 정리 + 여유 ≤ 서버당 시한');
  f = fakeConn({ execThrow: new Error('SSH exec 타임아웃(60s): x') });
  r = await PR.prepOnce(T, { keys: KEYS, connect: f.connect, credOf: credPrep(), test: okTest });
  assert.equal(r.prep.code, 'timeout');
  const file = /"\$HOME\/(\.dvc-fm-prep\.[0-9a-f]{16}\.sh)"/.exec(f.log.execs.find(([c]) => c.includes('/bin/sh "$HOME/'))[0])[1];
  assert.ok(f.log.execs.some(([c, ms]) => c === `rm -f "$HOME/${file}"` && ms === PR.PREP_CLEANUP_MS), '올린 파일만 지운다');
  // 같은 키 연속 거부 기억은 설치와 같다
  I._resetInstallForTest();
  const deny = async () => { const e = new Error('All configured authentication methods failed'); e.level = 'client-authentication'; throw e; };
  for (let i = 0; i < I.AUTH_STOP_AFTER; i += 1) assert.equal((await PR.prepOnce({ ...T, id: `fm-pppppppp1${i}` }, { keys: KEYS, connect: deny, credOf: credPrep(), test: okTest })).prep.code, 'auth');
  assert.equal((await PR.prepOnce(T, { keys: KEYS, connect: deny, credOf: credPrep(), test: okTest })).prep.code, 'key-stopped');
  assert.equal(I.keyStopped('SHA256:rootfp', Date.now()), true, '설치 쪽도 같은 키를 멈춘다');
  I._resetInstallForTest();
});

/* ── ④ 준비 계정 ── */
test('④ 준비 계정 — ‘접속 준비’ 를 직접 켠 키만(‘설치’ 키 · 기능 목록 없는 예전 키는 아님)', () => {
  const kPrep = KS.addKey({ name: 'pl-root-prep', privateKey: F.ed25519Key().pem, folderCorp: 'vcP', features: ['focus-mon-prep'] }, { by: 'own' }).key;
  const kInst = KS.addKey({ name: 'pl-root-inst', privateKey: F.ed25519Key().pem, folderCorp: 'vcP', features: ['disk-audit-install'] }, { by: 'own' }).key;
  const kOld = KS.addKey({ name: 'pl-root-old', privateKey: F.ed25519Key().pem }, { by: 'own' }).key;
  const t = (host) => ({ id: 'fm-pppppppp40', name: 'pl-db', host, port: 22, username: 'dvcmon' });
  BM.saveBmServer({ name: 'pl-a', host: '10.48.1.1', port: 22, username: 'root', mounts: ['/'], vcenterId: 'vcP', keyRef: kPrep.id, bindApproved: true });
  BM.saveBmServer({ name: 'pl-b', host: '10.48.1.2', port: 22, username: 'root', mounts: ['/'], vcenterId: 'vcP', keyRef: kInst.id, bindApproved: true });
  BM.saveBmServer({ name: 'pl-c', host: '10.48.1.3', port: 22, username: 'root', mounts: ['/'], vcenterId: 'vcP', keyRef: kOld.id, bindApproved: true });
  assert.equal(C.installCredFor(t('10.48.1.1'), { feature: C.PREP_FEATURE }).state, 'ok');
  assert.equal(C.installCredFor(t('10.48.1.1')).state, 'feature', '‘접속 준비’ 키는 설치에 쓰지 않는다');
  assert.equal(C.installCredFor(t('10.48.1.2'), { feature: C.PREP_FEATURE }).state, 'feature', '‘설치’ 키는 접속 준비에 쓰지 않는다');
  assert.equal(C.installCredFor(t('10.48.1.3'), { feature: C.PREP_FEATURE }).state, 'feature', '예전 키 아님');
  assert.equal(C.installCredFor(t('10.48.1.1'), { feature: 'bm-usage' }).state, 'error', '아는 기능만');
  const okc = C.installCredFor(t('10.48.1.1'), { feature: C.PREP_FEATURE, withAuth: true });
  assert.ok(okc.auth?.privateKey && okc.keyId === kPrep.id);
  assert.equal(JSON.stringify(C.credView(okc)).includes('PRIVATE'), false);
  // 공통 계정 — 그 법인 · 켠 키
  KS.saveAccount({ name: 'pl-root-common', kind: 'os', corp: 'vcP', username: 'root', keyRef: kPrep.id }, { by: 'own' });
  assert.equal(C.installCredFor(t('10.48.9.9'), { feature: C.PREP_FEATURE, corpVcs: ['vcP'] }).state, 'ok');
  assert.equal(C.installCredFor(t('10.48.9.9'), { feature: C.PREP_FEATURE, corpVcs: ['vcQ'] }).state, 'noentry');
  assert.equal(C.installCredFor(t('10.48.9.9'), { feature: C.PREP_FEATURE, edge: true }).state, 'noentry', '엣지도 법인 목록이 있어야');
});

/* ── ⑤ 중앙 ── */
test('⑤ 중앙 — 접수 · 엣지 배달(caps · 준비 계정 보고) · 결과 정제 · 반영(키 로그인 칸 · 설치)', async () => {
  A._resetForTest(); SET._resetForTest(); SET.saveInstallDir('', { by: 'own' });
  const te = { id: 'fm-pppppppp51', name: 'pl-db-51', host: '10.48.5.1', port: 22, username: 'dvcmon', agent: 'edge-pl' };
  const mine = new Map([[te.id, te]]);
  assert.equal(A.requestPrep({ ...te, username: 'root' }, { by: 'own' }).code, 'acct-root');
  assert.equal(A.requestPrep(te, { by: 'own' }).code, 'cred-edge-unknown', '엣지가 준비 계정을 알려 오기 전에는 받지 않는다');
  // 3.17.x 엣지 — 설치 계정만 알려 온다(credPrep 없음)
  A.handleEdgeAudit('edge-pl', mine, { caps: ['install'], cred: { [te.id]: { state: 'ok', acct: 'x' } } }, Date.now());
  assert.equal(A.requestPrep(te, { by: 'own' }).code, 'cred-edge-unknown', '옛 엣지 — 준비 계정 모름');
  A.handleEdgeAudit('edge-pl', mine, { caps: ['install', 'prep'], cred: { [te.id]: { state: 'ok', acct: 'pl-ops', key: 'pl-inst' } }, credPrep: { [te.id]: { state: 'ok', acct: 'root', key: 'pl-root', privateKey: 'LEAK' } } }, Date.now());
  assert.equal(A.credOfTarget(te, { feature: C.PREP_FEATURE }).acct, 'root'); assert.equal(JSON.stringify(A.credOfTarget(te, { feature: C.PREP_FEATURE })).includes('LEAK'), false);
  assert.equal(A.credOfTarget(te).key, 'pl-inst', '설치 계정은 따로');
  const r = A.requestPrep(te, { by: 'own', withAudit: true, from: true, age: 'default' });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.via, 'edge'); assert.equal(r.audit, true);
  assert.equal(A.requestPrep(te, { by: 'own' }).code, 'busy');
  // 배달 — 이번 본문에 caps 'prep' 이 있어야 · 함께면 'install' 도
  assert.equal(A.handleEdgeAudit('edge-pl', mine, { caps: ['install'], cred: {}, credPrep: {} }, Date.now() + 500).jobs.length, 0, '‘prep’ 을 모르는 엣지(3.17.x)에는 보내지 않는다');
  assert.equal(A.handleEdgeAudit('edge-pl', mine, { caps: ['prep'], cred: {}, credPrep: {} }, Date.now() + 600).jobs.length, 0, '디스크 점검 함께면 ‘install’ 도 알아야');
  const out = A.handleEdgeAudit('edge-pl', mine, { caps: ['install', 'prep'], cred: { [te.id]: { state: 'ok' } }, credPrep: { [te.id]: { state: 'ok' } } }, Date.now() + 1000);
  const job = out.jobs.find((j) => j.mode === 'prep');
  assert.ok(job); assert.deepEqual([job.expect.from, job.expect.age, job.expect.audit, job.expect.dir], [true, 'default', true, '']);
  assert.equal(job.expect.corpVcs.length, 0, '엣지 서버에는 법인 목록을 싣지 않는다(엣지 스냅샷으로)');
  // 결과 정제 — 아는 칸만
  const c = A.cleanEdgeResult({ mode: 'prep', ok: true, kind: 'done', prep: { code: 'evil', fail: 'nope', step: 99, acct: 'ro ot<x>', warn: ['home-perm', 'x'], created: 'yes', extra: 1 }, login: { ok: true, kind: 'weird', hello: { isLinux: true, kernel: 'L', junk: 1 }, error: 'e'.repeat(500) }, auditSkip: 'evil', ready: [] });
  assert.deepEqual([c.prep.code, c.prep.fail, c.prep.step, c.prep.acct, c.prep.created, c.prep.extra, c.prep.warn], ['unreachable', 'other', 0, '', false, undefined, ['home-perm']]);
  assert.equal(c.login.kind, 'unreachable'); assert.equal(c.login.hello.junk, undefined); assert.ok(c.login.error.length < 260); assert.equal(c.auditSkip, null);
  // 반영 — 마지막 준비 · 키 로그인 칸 · 디스크 점검(설치와 같은 재판정)
  const P0 = B.pathsFor('');
  const ready = ['##DR 1', '##DR py 3.6.8', `##DR file ${P0.program} ${B.programSha()} 0:0:644`, `##DR file ${P0.wrapper} ${B.wrapperSha('')} 0:0:755`, ...B.dirsToCheck(P0).all.map((d) => `##DR dir ${d} 0:0:755`), '##DR sudo ok', '##DR end'];
  A.handleEdgeAudit('edge-pl', mine, { caps: ['install', 'prep'], results: [{ runId: r.runId, result: { mode: 'prep', ok: true, kind: 'done', dir: '', ready,
    prep: { code: 'ok', step: 7, acct: 'root', key: 'pl-root', src: 'corp', created: true, added: true }, login: { ok: true, kind: 'ok', hello: { isLinux: true, rhelMajor: '7.8' }, ms: 9 },
    install: { code: 'ok', step: 7, acct: 'root' } } }] }, Date.now() + 3000);
  await new Promise((res) => setTimeout(res, 50));
  const rec = A.readinessOf(te.id);
  assert.equal(rec.lastPrep.code, 'ok'); assert.equal(rec.lastPrep.created, true); assert.equal(rec.lastPrep.audit, 'done'); assert.equal(rec.lastPrep.from, true); assert.equal(rec.lastPrep.age, 'default');
  assert.equal(rec.lastInstall.code, 'ok'); assert.equal(rec.state, 'ready');
  assert.equal(FS.testOf(te.id).result.kind, 'ok', '연결 시험 결과가 키 로그인 칸으로'); assert.equal(FS.testOf(te.id).result.via, 'edge');
  // 디스크 점검을 고르지 않은 준비 작업에 설치 결과 · 준비 줄이 실려 와도 반영하지 않는다(엣지가 작업에 없던 일을 말함)
  const tq = { id: 'fm-pppppppp54', name: 'pl-db-54', host: '10.48.5.4', port: 22, username: 'dvcmon', agent: 'edge-pl' };
  const mine2 = new Map([[tq.id, tq]]);
  A.handleEdgeAudit('edge-pl', mine2, { caps: ['install', 'prep'], cred: { [tq.id]: { state: 'ok' } }, credPrep: { [tq.id]: { state: 'ok' } } }, Date.now() + 4000);
  const rq = A.requestPrep(tq, { by: 'own' }); assert.equal(rq.ok, true); assert.equal(rq.audit, false);
  A.handleEdgeAudit('edge-pl', mine2, { caps: ['install', 'prep'], results: [{ runId: rq.runId, result: { mode: 'prep', ok: true, kind: 'done', dir: '', ready, prep: { code: 'ok', step: 7 }, login: { ok: true, kind: 'ok' }, install: { code: 'ok', step: 7 } } }] }, Date.now() + 5000);
  await new Promise((res) => setTimeout(res, 50));
  const rq2 = A.readinessOf(tq.id);
  assert.equal(rq2.lastPrep.audit, 'off'); assert.equal(rq2.lastInstall, undefined, '고르지 않은 설치는 반영하지 않는다'); assert.equal(rq2.state, undefined, '준비 줄도');
  // 같은 주소에 다른 수집 계정 — 준비는 하되 디스크 점검은 함께 하지 않는다
  const t2 = { id: 'fm-pppppppp52', name: 'a', host: '10.1.5.2', port: 22, username: 'dvcmon', demo: true };
  const t3 = { id: 'fm-pppppppp53', name: 'b', host: '10.1.5.2', port: 22, username: 'other', demo: true };
  const r2 = A.requestPrep(t2, { by: 'own', withAudit: true, peers: [t2, t3], keys: KEYS }); // 중앙 직접 대상 — 라우트처럼 키 저장소를 같이 준다
  assert.equal(r2.ok, true); assert.equal(r2.audit, false); assert.equal(r2.auditWhy, 'host-shared');
  assert.equal(A.requestPrep(t3, { by: 'own', peers: [t2, t3] }).code, 'host-busy', '같은 주소 준비 · 설치는 겹치지 않는다');
  assert.equal(A.requestInstall(t3, { by: 'own', peers: [t2, t3] }).code, 'host-shared');
});

/* ── ⑥ 라우트 ── */
test('⑥ 라우트 — 문(어느 문이 막았는지) · 503 · 데모 · 감사', async () => {
  A._resetForTest(); SET._resetForTest(); SET.saveInstallDir('', { by: 'own' });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const svc = await import('../src/focusmon/service.js');
  const { auditEntriesWithAction } = await import('../src/audit.js');
  const users = { own: { username: 'own', role: 'admin', scope: null }, adm: { username: 'adm', role: 'admin', scope: null }, op: { username: 'op', role: 'operator', scope: null },
    sown: { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } }, demo: { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true }, demoOwn: { username: 'own', role: 'admin', scope: null, demoGuest: true } };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'own']; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, { who = 'own', body } = {}) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': who }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    const g = await call('GET', '/api/tools/focus-mon/prep');
    assert.equal(g.status, 200); assert.ok(g.body.rows.length > 0); assert.ok(g.body.rows[0].cred && g.body.rows[0].credInstall && 'login' in g.body.rows[0] && 'keyFp' in g.body.rows[0]);
    assert.equal(JSON.stringify(g.body).includes('PRIVATE KEY'), false);
    assert.equal((await call('GET', '/api/tools/focus-mon/prep', { who: 'op' })).status, 403);
    assert.equal((await call('GET', '/api/tools/focus-mon/prep', { who: 'sown' })).status, 403, '전체 범위만');
    const body = { ids: ['fm-d0000000'] };
    for (const who of ['op', 'adm', 'sown', 'demo', 'demoOwn']) assert.equal((await call('POST', '/api/tools/focus-mon/prep', { who, body })).status, 403, who);
    assert.equal((await call('POST', '/api/tools/focus-mon/prep', { who: 'adm', body })).body.requiredOwner, true, '소유자 등급 문');
    assert.match(String((await call('POST', '/api/tools/focus-mon/prep', { who: 'demoOwn', body })).body.reason), /데모 계정/, '데모 차단 문');
    assert.equal((await call('POST', '/api/tools/focus-mon/prep', { body: { ids: [] } })).status, 400);
    // 데모 대상 — 장비에 닿지 않는다
    const ins = await call('POST', '/api/tools/focus-mon/prep', { body: { ids: ['fm-d0000000', 'fm-nope0000'], withAudit: true, age: 'evil', from: 'yes' } });
    assert.equal(ins.status, 200); assert.equal(ins.body.results.find((x) => x.id === 'fm-nope0000').code, 'not-found');
    assert.ok(ins.body.results.find((x) => x.id === 'fm-d0000000').ok, JSON.stringify(ins.body.results));
    const e = auditEntriesWithAction('focus-mon.prep');
    assert.ok(e.length >= 1); assert.match(e[e.length - 1].detail, /디스크 점검 함께 · 주소 제한 끔 · 만든 계정 만료 없음/, '정해 둔 값만(문자열 · 모르는 값은 기본)');
    await new Promise((res) => setTimeout(res, 150));
    const rec = A.readinessOf('fm-d0000000');
    assert.equal(rec?.lastPrep?.code, 'ok', JSON.stringify(rec)); assert.equal(rec.lastPrep.audit, 'done');
    // 데모 계정 — 준비한 계정 이름을 싣지 않는다
    const gd = await call('GET', '/api/tools/focus-mon/prep', { who: 'demo' });
    assert.equal(gd.status, 200); const dr = gd.body.rows.find((x) => x.id === 'fm-d0000000');
    assert.equal(dr.lastPrep.by, ''); assert.ok(gd.body.rows.every((x) => x.demo), '데모 계정은 데모 대상만');
    // 설치 디렉터리 설정 손상 — 디스크 점검을 함께 할 때만 503
    fs.writeFileSync(path.join(DIR, SET.SETTINGS_FILE), '{ broken'); SET._resetForTest();
    assert.equal((await call('POST', '/api/tools/focus-mon/prep', { body: { ids: ['fm-d0000001'], withAudit: true } })).status, 503);
    const noAud = await call('POST', '/api/tools/focus-mon/prep', { body: { ids: ['fm-d0000001'] } });
    assert.equal(noAud.status, 200); assert.ok(noAud.body.results[0].ok, '접속 준비만이면 그대로');
    for (const f of fs.readdirSync(DIR)) if (f.startsWith(SET.SETTINGS_FILE)) fs.rmSync(path.join(DIR, f));
    SET._resetForTest();
  } finally { svc.stopFocusMon(); srv.close(); }
});

/* ── ⑦ 엣지 워커 · 웹 글 ── */
test('⑦ 엣지 워커(caps · 준비 계정 보고 · 준비 줄) · SSH 공용 접속 기능 · 웹 글 1:1', async () => {
  const Wk = await import('../src/agent/focusMonWorker.js');
  const src = fs.readFileSync(new URL('../src/agent/focusMonWorker.js', import.meta.url), 'utf8');
  assert.deepEqual([...Wk.EDGE_AUDIT_CAPS], ['install', 'prep']); assert.match(src, /caps: \[\.\.\.EDGE_AUDIT_CAPS\]/);
  assert.match(src, /exec: prepExec\(\{ edge: true, edgeVcs \}\)/, '엣지 준비는 엣지 스냅샷 법인으로');
  assert.match(src, /: j\.mode === 'prep'\n\s+\? prepRunner\.submit\(/, '준비 작업은 준비 줄로(점검 실행 줄이 아니다)');
  assert.match(src, /from: ex\.from === true, age: ex\.age === 'default' \? 'default' : 'never', audit: ex\.audit === true/, '중앙이 보낸 준비 값은 참거짓 · 정해 둔 값만');
  Wk._setKnownForTest([{ id: 'fm-pppppppp71', name: 'x', host: '10.48.7.1', port: 22 }]);
  const feats = [];
  const rep = Wk.credReport(Date.now(), (t, o) => { feats.push(o.feature || 'install'); return { state: 'ok', acct: 'root', key: 'k', auth: { privateKey: 'SECRET' } }; });
  assert.ok(rep['fm-pppppppp71']); assert.deepEqual(feats, ['install', C.PREP_FEATURE]);
  const pr = Wk.credPrepReport(); assert.deepEqual(pr['fm-pppppppp71'], { state: 'ok', src: null, acct: 'root', key: 'k' }); assert.equal(JSON.stringify(pr).includes('SECRET'), false);
  assert.equal(Wk.credPrepReport(), null, '한 번 싣고 비운다');
  // SSH 공용 접속 기능 · 이름표
  assert.ok(KS.KEY_FEATURES.includes('focus-mon-prep'));
  const SVC = await import('../src/sshaccess/service.js'); const PL = await import('../src/bmusage/onboard/placement.js');
  assert.equal(SVC.FEATURE_CATALOG.find((x) => x.id === 'focus-mon-prep')?.label, PL.FEATURE_LABEL['focus-mon-prep']);
  assert.equal(SVC.FEATURE_CATALOG.find((x) => x.id === 'disk-audit-install')?.label, PL.FEATURE_LABEL['disk-audit-install']);
  // 웹 글 1:1
  for (const s of PR.PREP_CODES) assert.ok(W.PREP_CODE_TEXT[s], `웹 글: ${s}`);
  for (const s of PR.PREP_FAILS) assert.ok(W.PREP_FAIL_TEXT[s], `웹 글: ${s}`);
  for (const s of C.CRED_STATES) assert.ok(W.PREP_CRED_TEXT[s], `웹 글: ${s}`);
  for (const s of PR.AUDIT_SKIPS) assert.ok(W.AUDIT_SKIP_TEXT[s], `웹 글: ${s}`);
  assert.equal(W.PREP_STEP_LABELS.length, PR.PREP_STEPS.length);
  const H = await import('../src/focusmon/hello.js'); const T2 = await import('../../web/src/views/tools/focusMonText.js');
  for (const k of H.LOGIN_KINDS) assert.ok(T2.TEST_TEXT[k], `시험 글: ${k}`);
});
