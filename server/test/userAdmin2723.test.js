/**
 * userAdmin2723.test.js — CLI 계정 관리 메뉴(v2.723) 회귀.
 *
 * 고정하는 것:
 *  ① 메뉴가 보여 주는 '이 계정은 무엇으로 로그인하는가'(userAdminText.loginStateOf)가 서버의 실제 로그인 판정
 *     (auth.authenticateLocal)과 같다 — 역할 3 × 비밀번호 유무 × OTP 유무 × 계정별 방식 4 = 48 조합을 실제로 로그인해 대조한다.
 *  ② 계정별 로그인 방식 파일 쓰기는 다른 줄·주석을 지우지 않고 그 사용자 줄만 바꾸며, 지우면 그 줄만 사라진다. 0600.
 *  ③ 메뉴를 파이프 입력으로 돌려 계정을 만들고 비밀번호 로그인으로 지정하면 — 그 계정이 실제로 비밀번호로 로그인하고
 *     OTP 등록 강제(mustEnrollOtp)가 붙지 않는다. 지정하지 않은 관리자는 강제가 붙는다.
 *  ④ users.json 이 아직 없을 때 다시 읽기가 시드 비밀번호 파일을 다른 값으로 덮어쓰지 않는다(v2.723 자체 검증에서 발견).
 *  ⑤ 상자·표의 한글 폭 — 모든 줄의 표시 폭이 같다(오른쪽 테두리가 밀리지 않는다).
 * 자식 프로세스인 이유: config.js 싱글턴이라 이 프로세스에서 CONFIG_DIR 을 다시 못 가리킨다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boxLines, tableLines, dispWidth, loginStateOf } from '../src/tools/userAdminText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const TOOL = path.join(SRC, 'tools/user-admin.js');

function child(code, dir, extraEnv = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', LOGIN_POLICY_USERS: '', OTP_ROLE_ENFORCE: '', ...extraEnv },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  return JSON.parse(line.slice(2));
}

test('① 메뉴의 로그인 판정 = 서버의 실제 로그인 판정(48 조합)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uadm-'));
  const cases = [];
  for (const role of ['viewer', 'operator', 'admin']) for (const pw of [true, false]) for (const otp of [true, false]) for (const pol of [null, 'password_only', 'otp_only', 'otp_or_password']) cases.push({ role, pw, otp, pol });
  const out = child(`
    const fs = await import('node:fs'); const path = await import('node:path');
    const auth = await import(${JSON.stringify(path.join(SRC, 'auth/auth.js'))});
    const totp = await import(${JSON.stringify(path.join(SRC, 'auth/totp.js'))});
    const sec = await import(${JSON.stringify(path.join(SRC, 'security/securitySettings.js'))});
    const cases = ${JSON.stringify(cases)};
    const res = [];
    auth.loadUsers();
    let i = 0;
    for (const c of cases) {
      const name = 'u' + (i++);
      const r = auth.createUser({ username: name, role: c.role, password: c.pw ? 'Passw0rd-123' : undefined }, { trusted: true });
      if (!r.ok) throw new Error(r.reason);
      let secret = null;
      if (c.otp) {
        const b = auth.beginTotpEnroll(name, '', { trusted: true });
        secret = b.secret;
        // 등록 확정은 OTP 전용 정책에서 비밀번호를 지우므로, 확정 전에 방식을 정하고 확정 뒤 비밀번호를 다시 넣는다(조합을 만들기 위해).
        sec.setFileLoginPolicy(name, 'otp_or_password');
        const cf = auth.confirmTotpEnroll(name, totp.generateToken(secret), { trusted: true });
        if (!cf.ok) throw new Error(cf.reason);
        if (c.pw) auth.setLocalPassword(name, 'Passw0rd-123', { trusted: true });
      }
      sec.setFileLoginPolicy(name, c.pol);
      const u = auth.listUsers().find((x) => x.username === name);
      const pwLogin = auth.authenticateLocal(name, 'Passw0rd-123');
      // OTP 재사용 방지 카운터를 피하려고 다음 주기 코드를 쓴다(창 1 안).
      const otpLogin = secret ? auth.authenticateLocal(name, totp.generateToken(secret, { counter: Math.floor(Date.now() / 30000) + 1 })) : null;
      res.push({ c, u: { role: u.role, hasPassword: u.hasPassword, totpEnabled: u.totpEnabled },
        pw: !!pwLogin, pwEnroll: !!pwLogin?.mustEnrollOtp, otp: !!otpLogin });
    }
    console.log('@@' + JSON.stringify(res));
  `, dir);
  assert.equal(out.length, 48);
  let checked = 0;
  for (const r of out) {
    const st = loginStateOf(r.u, { override: r.c.pol, overrideSource: r.c.pol ? 'file' : null, globalPolicy: null, enforce: true });
    const label = JSON.stringify(r.c);
    assert.equal(r.u.hasPassword, r.c.pw, `조합 준비 ${label}`);
    assert.equal(r.u.totpEnabled, r.c.otp, `조합 준비 ${label}`);
    const wantPw = st.state === 'enroll' || st.methods.includes('비밀번호');
    const wantOtp = st.methods.includes('OTP') && st.state === 'ok';
    assert.equal(r.pw, wantPw, `비밀번호 로그인 ${label} — 메뉴: ${st.methods}`);
    assert.equal(r.otp, wantOtp, `OTP 로그인 ${label} — 메뉴: ${st.methods}`);
    assert.equal(r.pwEnroll, st.state === 'enroll', `OTP 등록 강제 ${label}`);
    checked++;
  }
  assert.equal(checked, 48);
});

test('② 계정별 방식 파일은 그 사용자 줄만 바꾼다 · 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uadm-'));
  fs.writeFileSync(path.join(dir, 'login-policy-users.txt'), '# 운영자 메모\nalice=otp\nbob=password # 서비스 계정\nalice=both\n');
  const out = child(`
    const fs = await import('node:fs'); const path = await import('node:path');
    const sec = await import(${JSON.stringify(path.join(SRC, 'security/securitySettings.js'))});
    const f = path.join(process.env.CONFIG_DIR, 'login-policy-users.txt');
    const o = {};
    o.before = sec.loginPolicyOverrideOf('alice');
    o.set = sec.setFileLoginPolicy('alice', 'password');
    o.after1 = fs.readFileSync(f, 'utf8');
    o.applied = sec.userLoginPolicy('alice');
    o.del = sec.setFileLoginPolicy('bob', null);
    o.after2 = fs.readFileSync(f, 'utf8');
    o.bad = sec.setFileLoginPolicy('alice', 'nope');
    o.badUser = sec.setFileLoginPolicy('a b', 'otp');
    o.mode = (fs.statSync(f).mode & 0o777).toString(8);
    o.env = sec.loginPolicyOverrideOf('carol');
    console.log('@@' + JSON.stringify(o));
  `, dir, { LOGIN_POLICY_USERS: 'carol=password' });
  assert.equal(out.before.file, 'otp_or_password', '파일 안 같은 사용자 줄은 나중 줄이 이긴다(적용 규칙과 같다)');
  assert.equal(out.set.ok, true);
  assert.equal(out.after1, '# 운영자 메모\nalice=password_only\nbob=password # 서비스 계정\n', '같은 사용자 줄은 하나로 합치고 다른 줄·주석은 그대로');
  assert.equal(out.applied, 'password_only', '쓰자마자 캐시를 비워 적용한다');
  assert.equal(out.after2, '# 운영자 메모\nalice=password_only\n');
  assert.equal(out.bad.ok, false);
  assert.equal(out.badUser.ok, false);
  assert.equal(out.mode, '600');
  assert.deepEqual(out.env, { file: null, env: 'password_only', effective: 'password_only' });
});

test('③ 메뉴로 만든 관리자를 비밀번호 로그인으로 지정하면 실제로 비밀번호로 들어간다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uadm-'));
  // 2=생성: park / 이름 기본 / 역할 3(admin) / 비번 y / 두 번 / 방식 1(비밀번호) / 만들기 y / 관리자 경고 y
  // 2=생성: choi / 이름 / 역할 3 / 비번 y / 두 번 / 방식 Enter(기본) / y   → 0=종료
  const input = '2\npark\n\n3\ny\nPassw0rd-park\nPassw0rd-park\n1\ny\ny\n2\nchoi\n\n3\ny\nPassw0rd-choi\nPassw0rd-choi\n\ny\n0\n';
  const r = spawnSync(process.execPath, [TOOL], { input, encoding: 'utf8', timeout: 60_000, cwd: path.resolve(SRC, '..'),
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', LOGIN_POLICY_USERS: '', OTP_ROLE_ENFORCE: '', USER_ADMIN_CAN_RESTART: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /계정 'park' 을\(를\) 만들었습니다/);
  assert.match(r.stdout, /재시작: sudo systemctl restart vmware-portal/, '계정을 바꾸면 재시작을 안내한다');
  assert.doesNotMatch(r.stdout, /Passw0rd-park/, '비밀번호를 화면에 찍지 않는다');
  const out = child(`
    const auth = await import(${JSON.stringify(path.join(SRC, 'auth/auth.js'))});
    const park = auth.authenticateLocal('park', 'Passw0rd-park');
    const choi = auth.authenticateLocal('choi', 'Passw0rd-choi');
    console.log('@@' + JSON.stringify({ park, choi }));
  `, dir);
  assert.equal(out.park?.role, 'admin');
  assert.equal(out.park.mustEnrollOtp, false, '비밀번호 로그인으로 지정한 관리자는 OTP 등록 강제가 없다');
  assert.equal(out.choi?.mustEnrollOtp, true, '지정하지 않은 관리자는 기존 규칙대로 OTP 등록 강제');
  assert.match(fs.readFileSync(path.join(dir, 'login-policy-users.txt'), 'utf8'), /^park=password_only$/m);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'login-policy-users.txt'), 'utf8'), /choi/);
});

test('④ users.json 이 없을 때 다시 읽기가 시드 비밀번호 파일을 바꾸지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uadm-'));
  const out = child(`
    const fs = await import('node:fs'); const path = await import('node:path');
    const auth = await import(${JSON.stringify(path.join(SRC, 'auth/auth.js'))});
    const f = path.join(process.env.CONFIG_DIR, 'initial-admin-password.txt');
    auth.loadUsers();
    const a = fs.readFileSync(f, 'utf8');
    auth.reloadUsersFromDisk(); auth.reloadUsersFromDisk();
    const b = fs.readFileSync(f, 'utf8');
    console.log('@@' + JSON.stringify({ same: a === b, hasFile: fs.existsSync(path.join(process.env.CONFIG_DIR, 'users.json')) }));
  `, dir);
  assert.equal(out.same, true);
  assert.equal(out.hasFile, false);
});

test('⑤ 한글이 섞여도 상자·표의 모든 줄 폭이 같다', () => {
  const box = boxLines(['계정 관리 (CLI)', 'CONFIG_DIR : /etc/x'], [' 1. 계정 목록', ' 5. 로그인 방식 지정 (비밀번호 / OTP)', 'abc'], { width: 40 });
  assert.equal(new Set(box.map(dispWidth)).size, 1, box.join('\n'));
  const t = tableLines([{ title: '사용자', width: 8 }, { title: '이름', width: 6 }], [['kim', '김철수김철수김'], ['아주긴사용자이름입니다', 'x']]);
  assert.equal(new Set(t.map(dispWidth)).size, 1, t.join('\n'));
  assert.equal(dispWidth('가a'), 3);
});

test('⑥ 오프라인 패키지가 계정 메뉴 래퍼를 담고 install/uninstall 이 링크를 다룬다', () => {
  const root = path.resolve(SRC, '../..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  assert.match(read('packaging/offline/build-package.sh'), /cp "\$REPO_ROOT\/user-admin\.sh" "\$APP\/user-admin\.sh"/);
  assert.match(read('packaging/offline/install.sh'), /-x "\$APP_DST\/user-admin\.sh"/);
  assert.match(read('packaging/offline/install.sh'), /\/usr\/local\/bin\/vmware-portal-users/);
  assert.match(read('packaging/offline/uninstall.sh'), /"\$PREFIX\/app\/user-admin\.sh"/, '이 설치본을 가리킬 때만 링크를 지운다');
  const sh = read('user-admin.sh');
  assert.match(sh, /sudo -u "\$RUN_USER"/, 'root 로 실행하면 서비스 계정으로 강등');
  assert.match(sh, /rc -eq 10/, '도구가 재시작을 고르면 래퍼가 재시작');
  assert.ok((fs.statSync(path.join(root, 'user-admin.sh')).mode & 0o111) !== 0, '실행 권한');
});
