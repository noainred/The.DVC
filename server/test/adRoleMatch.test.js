/**
 * AD 그룹→역할 매핑 정확화 + OTP 재인증 잠금 회귀 테스트(감사 M1).
 *  - 그룹 매핑: 부분문자열 승격 금지(AD_ADMIN_GROUP=IT 로 "IT-Interns" 멤버가 admin 되면 안 됨),
 *    CN 완전일치·전체 DN 완전일치는 반드시 동작.
 *  - verifyUserOtp: 계정별 실패 카운터로 잠금되고, 성공 시 리셋.
 * CONFIG_DIR을 임시 디렉터리로 돌려 리포지토리 server/config를 오염시키지 않는다.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-adrole-test-'));
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-pw-123';
// 잠금 임계를 낮춰 테스트를 짧게 유지(모듈 로드 시점에 읽으므로 import 전에 설정).
process.env.OTP_MAX_FAILS = '3';
process.env.OTP_LOCKOUT_MS = '60000';

let ad; let auth; let totp; let rl;
before(async () => {
  ad = await import('../src/auth/ad.js');
  auth = await import('../src/auth/auth.js');
  totp = await import('../src/auth/totp.js');
  rl = await import('../src/security/loginRateLimit.js');
});

const DN_INTERNS = 'CN=IT-Interns,OU=Groups,DC=corp,DC=local';
const DN_ADMINS = 'CN=VM-Admins,OU=Groups,DC=corp,DC=local';

/* ------------------------------ 그룹 매핑 정확화 ----------------------------- */

test('AD 그룹: CN 완전일치는 동작하고 부분문자열로는 승격되지 않음', () => {
  // 기존 운영 형태(CN만 설정) — 반드시 동작해야 한다.
  assert.equal(ad.matchesGroupSpec([DN_ADMINS], 'VM-Admins'), true);
  assert.equal(ad.matchesGroupSpec([DN_ADMINS], 'vm-admins'), true, '대소문자 무시');
  // 부분문자열(IT ⊂ IT-Interns)로는 매칭되지 않는다 — 권한 상승 차단.
  assert.equal(ad.matchesGroupSpec([DN_INTERNS], 'IT'), false);
  assert.equal(ad.matchesGroupSpec([DN_INTERNS], 'Admins'), false);
  assert.equal(ad.matchesGroupSpec([DN_ADMINS], 'VM-Admins-Extra'), false);
  assert.equal(ad.matchesGroupSpec([DN_INTERNS], 'IT-Interns'), true);
});

test('AD 그룹: 전체 DN 지정은 DN 완전일치(공백/대소문자 무시), 다른 OU는 불일치', () => {
  assert.equal(ad.matchesGroupSpec([DN_ADMINS], DN_ADMINS), true);
  assert.equal(ad.matchesGroupSpec([DN_ADMINS], 'cn=vm-admins, ou=groups, dc=corp, dc=local'), true);
  // 같은 CN이라도 다른 컨테이너면 거부(동명 그룹 사칭 방지).
  assert.equal(ad.matchesGroupSpec(['CN=VM-Admins,OU=Other,DC=corp,DC=local'], DN_ADMINS), false);
  // 접두/접미 DN 부분문자열도 거부.
  assert.equal(ad.matchesGroupSpec([DN_ADMINS], 'CN=VM-Admins,OU=Groups'), false);
});

test('AD 그룹: 여러 그룹 나열(세미콜론/쉼표)과 이스케이프된 쉼표 그룹명', () => {
  // 세미콜론 나열 — DN과 CN 혼용 가능.
  const spec = `${DN_ADMINS}; Portal-Operators`;
  assert.equal(ad.matchesGroupSpec([DN_INTERNS, DN_ADMINS], spec), true);
  assert.equal(ad.matchesGroupSpec(['CN=Portal-Operators,OU=G,DC=corp,DC=local'], spec), true);
  assert.equal(ad.matchesGroupSpec([DN_INTERNS], spec), false);
  // 쉼표 나열은 DN이 아닌 그룹명 목록에만 적용.
  assert.equal(ad.matchesGroupSpec([DN_ADMINS], 'Foo-Admins, VM-Admins'), true);
  assert.equal(ad.matchesGroupSpec([DN_INTERNS], 'Foo-Admins, VM-Admins'), false);
  // 쉼표를 포함한 그룹명은 이스케이프(`\,`)로 지정.
  assert.equal(ad.matchesGroupSpec(['CN=Admins\\, Global,OU=G,DC=corp,DC=local'], 'Admins\\, Global'), true);
  // 빈 설정은 항상 불일치(그룹 미설정 → defaultRole).
  assert.equal(ad.matchesGroupSpec([DN_ADMINS], ''), false);
  assert.equal(ad.matchesGroupSpec([], 'VM-Admins'), false);
});

test('AD 그룹: memberOf가 평문 그룹명인 디렉터리도 CN 완전일치로 동작', () => {
  assert.equal(ad.matchesGroupSpec(['VM-Admins'], 'VM-Admins'), true);
  assert.equal(ad.matchesGroupSpec(['IT-Interns'], 'IT'), false);
});

test('roleFromGroups: 부분문자열 설정으로는 admin 승격 없음(기본 exact), substring opt-out은 구동작', () => {
  const cfg = { adminGroup: 'IT', operatorGroup: 'IT-Interns', viewerGroup: '', defaultRole: 'viewer' };
  // 'IT'는 CN 완전일치가 아니므로 admin 아님 → operator(CN 완전일치)로 매핑.
  assert.equal(ad.roleFromGroups([DN_INTERNS], cfg), 'operator');
  assert.equal(ad.roleFromGroups([DN_ADMINS], { ...cfg, adminGroup: 'VM-Admins' }), 'admin');
  assert.equal(ad.roleFromGroups([DN_INTERNS], { adminGroup: 'Nope', defaultRole: 'viewer' }), 'viewer');
  // 하위호환 opt-out(AD_GROUP_MATCH=substring)에서는 예전처럼 부분문자열로 승격.
  assert.equal(ad.roleFromGroups([DN_INTERNS], { ...cfg, groupMatch: 'substring' }), 'admin');
  // memberOf 단일 문자열(배열 아님)도 허용.
  assert.equal(ad.roleFromGroups(DN_ADMINS, { adminGroup: 'VM-Admins', defaultRole: 'viewer' }), 'admin');
});

test('parseGroupSpec: DN/CN 항목 분류', () => {
  assert.deepEqual(ad.parseGroupSpec('VM-Admins'), [{ dn: null, cn: 'vm-admins' }]);
  assert.deepEqual(ad.parseGroupSpec(DN_ADMINS), [{ dn: 'cn=vm-admins,ou=groups,dc=corp,dc=local', cn: null }]);
  // OU/DC 없이 CN=만 적은 경우는 그룹명으로도 인정(운영 편의).
  assert.deepEqual(ad.parseGroupSpec('CN=VM-Admins'), [{ dn: 'cn=vm-admins', cn: 'vm-admins' }]);
  assert.equal(ad.parseGroupSpec('   ').length, 0);
});

/* --------------------------- OTP 재인증 잠금(M1) --------------------------- */

// 현재 검증 창(±1스텝)의 유효 코드와 겹치지 않는 확실히 틀린 코드.
function wrongCode(secret) {
  const step = Math.floor(Date.now() / 1000 / 30);
  const valid = new Set([step - 1, step, step + 1].map((c) => totp.generateToken(secret, { counter: c })));
  for (let i = 0; i < 2000; i++) {
    const c = String(i).padStart(6, '0');
    if (!valid.has(c)) return c;
  }
  return '000000';
}

function enrollUser(username) {
  assert.equal(auth.createUser({ username, role: 'admin', password: 'password-1' }).ok, true);
  const u = auth.getUser(username);
  u.totpEnabled = true;
  u.totpSecret = totp.generateSecret();
  return u;
}

test('verifyUserOtp: 반복 실패 시 계정별 잠금 + 메시지/retryAfterSec 포함', () => {
  const name = 'otp.lock';
  const u = enrollUser(name);
  const bad = wrongCode(u.totpSecret);
  // OTP_MAX_FAILS=3 — 2회까지는 일반 실패.
  for (let i = 0; i < 2; i++) {
    const r = auth.verifyUserOtp(name, bad);
    assert.equal(r.ok, false);
    assert.equal(r.locked, undefined, `${i + 1}회 실패는 아직 잠금 아님`);
    assert.match(r.reason, /일치하지/);
  }
  // 3회째에서 잠금.
  const locked = auth.verifyUserOtp(name, bad);
  assert.equal(locked.ok, false);
  assert.equal(locked.locked, true);
  assert.ok(locked.retryAfterSec > 0, 'retryAfterSec 포함');
  assert.match(locked.reason, /초 후 다시 시도/);

  // 잠금 중에는 '정답 코드'도 거부되고 동일 형식으로 응답.
  const blocked = auth.verifyUserOtp(name, totp.generateToken(u.totpSecret));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.locked, true);
  assert.ok(blocked.retryAfterSec > 0);
  assert.match(blocked.reason, /초 후 다시 시도/);

  // 키 공간 분리 — OTP 잠금이 같은 계정의 로그인 잠금으로 번지지 않는다.
  assert.equal(rl.checkLoginAllowed('10.1.1.1', name).blocked, false);
});

test('verifyUserOtp: 성공 시 실패 카운터 리셋', () => {
  const name = 'otp.reset';
  const u = enrollUser(name);
  const bad = wrongCode(u.totpSecret);
  assert.equal(auth.verifyUserOtp(name, bad).ok, false);
  assert.equal(auth.verifyUserOtp(name, bad).ok, false); // 임계(3) 직전
  assert.equal(auth.verifyUserOtp(name, totp.generateToken(u.totpSecret)).ok, true, '정답 코드는 성공');
  // 리셋됐으므로 다시 2회 실패까지 잠기지 않는다(리셋 없으면 첫 실패에서 잠김).
  for (let i = 0; i < 2; i++) {
    const r = auth.verifyUserOtp(name, bad);
    assert.equal(r.ok, false);
    assert.equal(r.locked, undefined, `리셋 후 ${i + 1}회 실패는 잠금 아님`);
  }
});

test('verifyUserOtp: 미등록/미존재 계정 응답은 기존과 동일', () => {
  assert.equal(auth.verifyUserOtp('no.such.user', '123456').reason, '사용자를 찾을 수 없습니다.');
  assert.equal(auth.createUser({ username: 'otp.noenroll', role: 'viewer', password: 'password-1' }).ok, true);
  const r = auth.verifyUserOtp('otp.noenroll', '123456');
  assert.equal(r.ok, false);
  assert.equal(r.needEnroll, true);
});
