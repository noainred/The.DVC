import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.294 회귀 방지 — Demo/Guest(내장 데모 계정) 중복 접속 설정.
// '설정 › 세션 보안'의 demoSession(null=전역 따름 | 'allow' 중복 허용 | 'single' 중복 차단)이
// 전역 singleSession 과 독립적으로 데모 계정에만 적용되는지, 그리고 sid 발급(로그인)과
// 검사(resolveTokenUser)가 같은 판정 함수(singleSessionRequired)를 타 비대칭이 없는지 고정한다.
// 격리 CONFIG_DIR — auth/securitySettings/sessions 모두 import 시점 CONFIG_DIR 을 쓴다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-session-test-'));
process.env.CONFIG_DIR = TMP;
process.env.AUTH_SECRET = 'test-secret-demo-session';
delete process.env.OTP_ROLE_ENFORCE;

const auth = await import('../src/auth/auth.js');
const sessions = await import('../src/auth/sessions.js');
const sec = await import('../src/security/securitySettings.js');

// 로그인 라우트와 동일한 규칙으로 토큰 발급 — sid 발급 여부를 singleSessionRequired 로 판정
// (routes/auth.js 와 같은 판정 함수를 쓰는 것이 이 테스트의 핵심 전제: 발급/검사 쌍).
function loginLikeRoute(username) {
  const u = auth.getUser(username);
  const sid = sec.singleSessionRequired(!!u.demo) ? sessions.newSessionId() : null;
  const token = auth.signToken({ sub: username, role: u.role, name: u.name || username, src: 'local', tv: u.tokenVersion || 0, ...(sid ? { sid } : {}) });
  if (sid) sessions.setActiveSession(username, sid, { at: Date.now(), ip: '127.0.0.1' });
  return { token, sid };
}

// 데모 계정은 loadUsers 가 자동 시드(ensureDemoUser — demo:true). 일반 계정은 비교군.
auth.createUser({ username: 'ds-normal', name: 'n', role: 'viewer', password: 'pw-ds-123456' });
const DEMO = auth.DEMO_USERNAME;
assert.ok(auth.getUser(DEMO)?.demo, '데모 계정이 demo:true 로 시드되는 전제');

test("demoSession 미설정(기본): 데모도 전역 설정을 따른다(하위호환 — v2.293 이전과 동일)", () => {
  sec.saveSessionSecurity({ singleSession: false, demoSession: null });
  const a = loginLikeRoute(DEMO);
  const b = loginLikeRoute(DEMO);
  assert.equal(a.sid, null, '전역 OFF + 미설정 → 데모도 sid 미발급');
  assert.ok(auth.resolveTokenUser(a.token) && auth.resolveTokenUser(b.token), '중복 세션 허용');

  sec.saveSessionSecurity({ singleSession: true });
  const c = loginLikeRoute(DEMO);
  const d = loginLikeRoute(DEMO); // 최신 로그인이 활성 sid 를 덮어씀
  assert.ok(!auth.resolveTokenUser(c.token), '전역 ON + 미설정 → 이전 데모 세션 무효(전역 따름)');
  assert.ok(auth.resolveTokenUser(d.token), '최신 데모 세션만 유효');
});

test("'allow'(중복 허용): 전역 단일 세션이 켜져 있어도 데모는 예외 — 여러 세션 동시 유효", () => {
  sec.saveSessionSecurity({ singleSession: true, demoSession: 'allow' });
  const a = loginLikeRoute(DEMO);
  const b = loginLikeRoute(DEMO);
  assert.equal(a.sid, null, "allow 면 sid 자체를 발급하지 않는다(검사도 안 하므로 쌍 유지)");
  assert.ok(auth.resolveTokenUser(a.token), '첫 데모 세션 유효');
  assert.ok(auth.resolveTokenUser(b.token), '둘째 데모 세션도 유효(중복 허용)');
  // 일반 계정은 여전히 전역 단일 세션 적용 — 데모 예외가 남에게 새지 않는다.
  const n1 = loginLikeRoute('ds-normal');
  const n2 = loginLikeRoute('ds-normal');
  assert.ok(!auth.resolveTokenUser(n1.token), '일반 계정 이전 세션은 무효(전역 ON)');
  assert.ok(auth.resolveTokenUser(n2.token), '일반 계정 최신 세션만 유효');
});

test("'single'(중복 차단): 전역이 꺼져 있어도 데모만 단일 세션 — 새 로그인이 이전 데모 세션 무효화", () => {
  sec.saveSessionSecurity({ singleSession: false, demoSession: 'single' });
  const a = loginLikeRoute(DEMO);
  assert.ok(a.sid, "single 이면 전역 OFF 여도 데모 로그인에 sid 를 발급한다");
  assert.ok(auth.resolveTokenUser(a.token), '첫 데모 세션 유효');
  const b = loginLikeRoute(DEMO);
  assert.ok(!auth.resolveTokenUser(a.token), '새 데모 로그인이 이전 세션을 무효화');
  assert.ok(auth.resolveTokenUser(b.token), '최신 데모 세션 유효');
  // 일반 계정은 전역 OFF 그대로 — 데모 전용 잠금이 남에게 새지 않는다.
  const n1 = loginLikeRoute('ds-normal');
  const n2 = loginLikeRoute('ds-normal');
  assert.equal(n1.sid, null);
  assert.ok(auth.resolveTokenUser(n1.token) && auth.resolveTokenUser(n2.token), '일반 계정은 중복 허용 유지');
});

test('저장 정규화: 무효값·null 은 전역 따름으로, 유효값만 반영 + 다른 저장이 값을 안 건드림', () => {
  sec.saveSessionSecurity({ demoSession: 'single' });
  assert.equal(sec.loadConfiguredSecurity().demoSession, 'single');
  sec.saveSessionSecurity({ idleLogoutMin: 20 }); // demoSession 미전달 → 기존 유지
  assert.equal(sec.loadConfiguredSecurity().demoSession, 'single', '무관한 저장이 값을 바꾸지 않는다');
  sec.saveSessionSecurity({ demoSession: 'bogus' }); // 무효값 → 명시 리셋(전역 따름)
  assert.equal(sec.loadConfiguredSecurity().demoSession, null);
});
