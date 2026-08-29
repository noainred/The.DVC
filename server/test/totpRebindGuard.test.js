import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 확정 버그 회귀 방지(2026-08-30) — OTP '대리 등록'을 통한 권한 상승.
//
// 배경: beginTotpEnroll 은 QR 발급을 위해 평문 시크릿을 반환한다. adminOnly 만 걸린 관리자
// 라우트에서 이를 호출하면, 일반 admin 이 수퍼관리자/설정소유자의 OTP 시크릿을 손에 넣고
// confirmTotpEnroll 로 활성 시크릿을 교체할 수 있었다. 대상이 OTP 전용 계정이면 confirm 이
// passwordHash 까지 지우므로 기존 소유자는 로그인 수단을 잃고, 호출자만 그 계정으로 로그인할 수
// 있게 된다(= 계정 탈취 → admin→설정소유자 권한 상승). disableTotp 는 u.superuser 를 이미
// 막고 있었는데 '등록' 경로만 열려 있어 그 보호가 우회됐다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'totp-rebind-test-'));
process.env.CONFIG_DIR = TMP;
delete process.env.OTP_ROLE_ENFORCE;

const auth = await import('../src/auth/auth.js');
const totp = await import('../src/auth/totp.js');
const sec = await import('../src/security/securitySettings.js');

test('수퍼관리자 OTP: 다른 admin 의 대리 등록은 begin·confirm 모두 거부', () => {
  auth.createUser({ username: 'rb-admin', name: 'rb admin', role: 'admin', password: 'pw-rb-123456' });

  const b = auth.beginTotpEnroll(auth.SUPER_USERNAME, '', { actor: 'rb-admin' });
  assert.equal(b.ok, false, '대리 등록 시작이 거부돼야 함');
  assert.match(b.reason, /본인만/);
  assert.equal(b.secret, undefined, '거부 시 평문 시크릿이 절대 반환되지 않아야 함');

  // confirm 도 같은 경계를 다시 검사해야 한다 — begin 만 막으면 이전에 남은 pending
  // 시크릿으로 confirm 만 호출해 우회할 수 있다.
  const self = auth.beginTotpEnroll(auth.SUPER_USERNAME, '', { actor: auth.SUPER_USERNAME });
  assert.ok(self.ok, self.reason); // 본인 등록으로 pending 을 만들어 둔 상태
  const hijack = auth.confirmTotpEnroll(auth.SUPER_USERNAME, totp.generateToken(self.secret), { actor: 'rb-admin' });
  assert.equal(hijack.ok, false, 'pending 이 있어도 타인 confirm 은 거부');
  assert.match(hijack.reason, /본인만/);
});

test('수퍼관리자 본인은 재등록 가능(폰 교체 경로가 막히면 안 됨)', () => {
  const b = auth.beginTotpEnroll(auth.SUPER_USERNAME, '', { actor: auth.SUPER_USERNAME });
  assert.ok(b.ok, b.reason);
  assert.ok(b.secret, '본인 등록은 시크릿을 받아야 함');
  const c = auth.confirmTotpEnroll(auth.SUPER_USERNAME, totp.generateToken(b.secret), { actor: auth.SUPER_USERNAME });
  assert.ok(c.ok, c.reason);
  assert.equal(auth.getUser(auth.SUPER_USERNAME).totpEnabled, true);
});

test('설정소유자 계정도 대리 등록 거부(설정 소유 경계 = admin 보다 상위)', () => {
  auth.createUser({ username: 'rb-owner', name: 'rb owner', role: 'admin', password: 'pw-own-123456' });
  sec.saveSessionSecurity({ settingsOwners: [auth.SUPER_USERNAME, 'rb-owner'] });

  const b = auth.beginTotpEnroll('rb-owner', '', { actor: 'rb-admin' });
  assert.equal(b.ok, false);
  assert.match(b.reason, /본인만/);
  assert.equal(b.secret, undefined);

  // 본인은 가능.
  assert.ok(auth.beginTotpEnroll('rb-owner', '', { actor: 'rb-owner' }).ok);
});

test('일반 계정의 대리 등록은 계속 허용(OTP 전용 계정은 자력 등록이 불가하므로 설계된 기능)', () => {
  auth.createUser({ username: 'rb-plain', name: 'rb plain', role: 'viewer', password: 'pw-pln-123456' });
  const b = auth.beginTotpEnroll('rb-plain', '', { actor: 'rb-admin' });
  assert.ok(b.ok, b.reason);
  assert.ok(b.secret, '일반 계정은 관리자가 QR 을 대신 발급할 수 있어야 함');
  const c = auth.confirmTotpEnroll('rb-plain', totp.generateToken(b.secret), { actor: 'rb-admin' });
  assert.ok(c.ok, c.reason);
});

test('trusted:true(콘솔 복구 도구 tools/otp-enroll.js)만 신뢰 경로 — 인자 누락은 거부(fail-closed)', () => {
  // 수퍼관리자 폰 분실 시 유일한 복구 수단이므로 명시된 신뢰 경로는 막히면 안 된다.
  const b = auth.beginTotpEnroll(auth.SUPER_USERNAME, '', { trusted: true });
  assert.ok(b.ok, b.reason);
  assert.ok(b.secret);
  const c = auth.confirmTotpEnroll(auth.SUPER_USERNAME, totp.generateToken(b.secret), { trusted: true });
  assert.ok(c.ok, c.reason);

  // 반대로 actor·trusted 를 **둘 다 빠뜨리면** 보호 계정은 거부돼야 한다 — 새 라우트가 인자
  // 전달을 잊었을 때 조용히 보호가 사라지는(fail-open) 것을 막는다.
  const bare = auth.beginTotpEnroll(auth.SUPER_USERNAME, '');
  assert.equal(bare.ok, false, '인자 누락 시 보호 계정은 fail-closed 여야 함');
  assert.equal(bare.secret, undefined);
});

// --- 재감사(2026-08-30)에서 실행 재현된 우회 경로들 — 전부 막혀 있어야 한다 ---

test('우회 차단: 대소문자 변형 계정으로 본인 위장 불가(정확일치 비교)', () => {
  // getUser/createUser 는 대소문자를 구분하므로 'NOAINRED' 는 'noainred' 와 **별개 계정**이다.
  // 가드가 소문자 정규화로 '본인'을 판정하면 그 변형 계정을 만들어 위장할 수 있었다(실측 재현).
  const mk = auth.createUser({ username: 'NOAINRED', name: 'fake super', role: 'admin', password: 'pw-fake-123456' });
  assert.ok(mk.ok, `전제: 대소문자 변형 계정이 생성됨 — ${mk.reason || ''}`);

  const b = auth.beginTotpEnroll(auth.SUPER_USERNAME, '', { actor: 'NOAINRED' });
  assert.equal(b.ok, false, '변형 계정이 수퍼관리자 OTP 를 등록할 수 있으면 계정 탈취');
  assert.equal(b.secret, undefined, '거부 시 평문 시크릿 유출 금지');
});

test('우회 차단: disableTotp 는 actor 만으로는 보호 계정을 해제하지 못한다(force 는 콘솔 전용)', () => {
  // force 는 콘솔 도구 전용 신뢰 플래그다. 라우트가 req.body 를 통째로 넘기던 동안에는
  // {"force":true} 주입으로 수퍼관리자 OTP 해제 → 임시비번 로그인 → 자력 등록 → 탈취가 됐다.
  // 라우트는 이제 password 만 전달한다(routes/admin/users.js). 여기서는 함수 계약을 고정한다.
  const denied = auth.disableTotp(auth.SUPER_USERNAME, { password: 'temp-pw-123456', actor: 'rb-admin' });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /수퍼관리자/);
  assert.equal(auth.getUser(auth.SUPER_USERNAME).totpEnabled, true, '거부 시 OTP 등록 상태 불변');

  // 설정소유자도 거부(수퍼관리자 플래그가 아니라 owners 경계로 막힌다).
  sec.saveSessionSecurity({ settingsOwners: [auth.SUPER_USERNAME, 'rb-owner'] });
  const d2 = auth.disableTotp('rb-owner', { password: 'temp-pw-123456', actor: 'rb-admin' });
  assert.equal(d2.ok, false);
  assert.match(d2.reason, /본인만/);
});

test('우회 차단: setLocalPassword·clearLoginCredentials 로 보호 계정 탈취 불가', () => {
  sec.saveSessionSecurity({ settingsOwners: [auth.SUPER_USERNAME, 'rb-owner'] });

  // 비밀번호를 호출자가 아는 값으로 심으면 그 계정으로 로그인할 수 있다 → OTP 경로와 같은 탈취.
  const p = auth.setLocalPassword('rb-owner', 'atk-set-123456', { actor: 'rb-admin' });
  assert.equal(p.ok, false);
  assert.match(p.reason, /본인만/);

  // OTP·비번을 모두 지운 뒤 비번을 심는 2단 우회도 첫 단계에서 막혀야 한다.
  const c = auth.clearLoginCredentials('rb-owner', { actor: 'rb-admin' });
  assert.equal(c.ok, false);
  assert.match(c.reason, /본인만/);

  // 본인·시스템 신뢰 경로는 정상 동작(중앙→엣지 비번 일괄 교체가 막히면 안 된다).
  assert.ok(auth.setLocalPassword('rb-owner', 'own-set-123456', { actor: 'rb-owner' }).ok);
  assert.ok(auth.setLocalPassword('rb-owner', 'sys-set-123456', { trusted: true }).ok);
});

test('일반 계정의 비밀번호·자격증명 변경은 종전대로 허용(동작 보존)', () => {
  auth.createUser({ username: 'rb-plain2', name: 'rb plain2', role: 'viewer', password: 'pw-pl2-123456' });
  assert.ok(auth.setLocalPassword('rb-plain2', 'new-pw-123456', { actor: 'rb-admin' }).ok);
  assert.ok(auth.clearLoginCredentials('rb-plain2', { actor: 'rb-admin' }).ok);
});

// --- 3차 재감사(2026-08-30)에서 재현된 '신원(이름) 우회' — 자격증명만 막아서는 부족했다 ---

test('우회 차단: deleteUser + createUser 로 소유자 이름을 선점해 지위 승계 불가', () => {
  // 소유자 지위는 settingsOwners 의 **이름 문자열**로 판정된다. 그래서 계정을 지우고 같은
  // 이름으로 다시 만들면 소유자 지위가 그대로 승계됐다(실행 재현) → 부트스트랩 로그인 →
  // 자력 OTP 등록 → 백업 다운로드로 AUTH_SECRET·전 계정 TOTP 시크릿 획득까지 이어졌다.
  auth.createUser({ username: 'id-owner', name: 'id owner', role: 'admin', password: 'pw-ido-123456' });
  auth.createUser({ username: 'id-attacker', name: 'id attacker', role: 'admin', password: 'pw-ida-123456' });
  sec.saveSessionSecurity({ settingsOwners: [auth.SUPER_USERNAME, 'id-owner'] });

  // 1단계: 비소유자 admin 이 소유자 계정을 삭제 → 거부돼야 한다.
  const del = auth.deleteUser('id-owner', { actor: 'id-attacker' });
  assert.equal(del.ok, false, '비소유자가 소유자 계정을 지울 수 있으면 이름 선점이 가능');
  assert.ok(auth.getUser('id-owner'), '거부 시 계정이 남아 있어야 함');

  // 2단계(1단계가 뚫렸을 때의 방어선): 소유자 이름으로 새 계정 생성도 거부돼야 한다.
  //   normOwners 는 계정 존재 여부를 검사하지 않으므로, 아직 만들지 않은 소유자 이름을
  //   미리 적어둔(사전 프로비저닝) 상태에서 아무 admin 이나 선점하는 경로도 함께 막는다.
  sec.saveSessionSecurity({ settingsOwners: [auth.SUPER_USERNAME, 'id-owner', 'future-owner'] });
  const mk = auth.createUser({ username: 'future-owner', role: 'admin', password: 'pw-fut-123456' }, { actor: 'id-attacker' });
  assert.equal(mk.ok, false, '미생성 소유자 이름 선점이 가능하면 즉시 소유자가 된다');
  assert.equal(auth.getUser('future-owner'), null);
});

test('소유자 본인·다른 소유자·신뢰 경로는 신원 관리 가능(운영성 보존)', () => {
  sec.saveSessionSecurity({ settingsOwners: [auth.SUPER_USERNAME, 'id-owner', 'future-owner'] });

  // 소유자는 사전 프로비저닝된 소유자 계정을 실제로 만들 수 있어야 한다.
  const byOwner = auth.createUser({ username: 'future-owner', role: 'admin', password: 'pw-fut-123456' }, { actor: 'id-owner' });
  assert.ok(byOwner.ok, `소유자의 소유자 계정 생성이 막히면 운영 불가 — ${byOwner.reason || ''}`);

  // 소유자는 다른 소유자 계정을 정리할 수 있다.
  assert.ok(auth.deleteUser('future-owner', { actor: 'id-owner' }).ok);

  // 신뢰 경로(부트스트랩·시스템)도 통과.
  assert.ok(auth.createUser({ username: 'future-owner', role: 'admin', password: 'pw-fut-123456' }, { trusted: true }).ok);
});

test('일반 계정의 생성·삭제는 종전대로 허용(과보호 회귀 방지)', () => {
  sec.saveSessionSecurity({ settingsOwners: [auth.SUPER_USERNAME, 'id-owner'] });
  assert.ok(auth.createUser({ username: 'id-normal', role: 'viewer', password: 'pw-idn-123456' }, { actor: 'id-attacker' }).ok);
  assert.ok(auth.deleteUser('id-normal', { actor: 'id-attacker' }).ok);
});

test('보호 판정은 실제 소유자 판정과 같은 키(정확일치) — 과보호/미보호 둘 다 없다', () => {
  // requireSettingsOwner 는 정확일치(username 또는 name)로 소유자 권한을 준다. 보호 범위도
  // 정확히 그 집합이어야 한다. 이전 버전은 대소문자를 무시해 ① 대소문자만 다른 계정이
  // 실제 소유자가 아닌데도 잠금 면역을 얻고 ② 표시이름이 우연히 겹친 무관한 계정의 정당한
  // 비번 리셋이 막혔다(3차 재감사 지적).
  sec.saveSessionSecurity({ settingsOwners: [auth.SUPER_USERNAME, 'id-owner'] });

  // ① 대소문자 변형 계정은 보호 대상이 아니다 → 다른 admin 이 잠글 수 있어야 한다.
  auth.createUser({ username: 'ID-OWNER', name: 'variant', role: 'viewer', password: 'pw-var-123456' });
  assert.ok(auth.clearLoginCredentials('ID-OWNER', { actor: 'id-attacker' }).ok,
    '실제 소유자가 아닌 변형 계정이 잠금 면역을 얻으면 안 된다');

  // ② 실제 소유자는 정확일치로 보호된다.
  assert.equal(auth.setLocalPassword('id-owner', 'atk-set-123456', { actor: 'id-attacker' }).ok, false);
});
