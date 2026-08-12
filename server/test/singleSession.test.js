import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 격리 CONFIG_DIR — auth/securitySettings/sessions 모두 import 시점 CONFIG_DIR 을 쓴다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'single-session-test-'));
process.env.CONFIG_DIR = TMP;
process.env.AUTH_SECRET = 'test-secret-single-session';
delete process.env.OTP_ROLE_ENFORCE;

const auth = await import('../src/auth/auth.js');
const sessions = await import('../src/auth/sessions.js');
const sec = await import('../src/security/securitySettings.js');

// 로컬 계정 토큰을 로그인 라우트처럼 발급하는 헬퍼(sid 부착 + 활성 세션 등록).
function loginLikeRoute(username) {
  const u = auth.getUser(username);
  const single = sec.singleSessionEnabled();
  const sid = single ? sessions.newSessionId() : null;
  const token = auth.signToken({ sub: username, role: u.role, name: u.name || username, src: 'local', tv: u.tokenVersion || 0, ...(sid ? { sid } : {}) });
  if (sid) sessions.setActiveSession(username, sid, { at: Date.now(), ip: '127.0.0.1' });
  return { token, sid };
}

auth.createUser({ username: 'ss-user', name: 'ss', role: 'operator', password: 'pw-ss-123456' });

test('단일 세션 OFF(기본): 여러 토큰이 동시에 유효(다중 세션 허용)', () => {
  sec.saveSessionSecurity({ singleSession: false });
  const a = loginLikeRoute('ss-user');
  const b = loginLikeRoute('ss-user');
  assert.equal(a.sid, null, 'OFF 면 sid 를 발급하지 않는다');
  assert.ok(auth.resolveTokenUser(a.token), '첫 토큰 유효');
  assert.ok(auth.resolveTokenUser(b.token), '둘째 토큰도 유효(다중 세션)');
});

test('단일 세션 ON: 최신 로그인이 이전 세션을 무효화(ID 공유 방지)', () => {
  sec.saveSessionSecurity({ singleSession: true });
  const first = loginLikeRoute('ss-user');
  assert.ok(first.sid, 'ON 이면 sid 발급');
  assert.ok(auth.resolveTokenUser(first.token), '첫 로그인 토큰은 처음엔 유효');
  // 같은 계정으로 두 번째(다른 기기) 로그인 → 활성 sid 를 덮어쓴다.
  const second = loginLikeRoute('ss-user');
  assert.notEqual(first.sid, second.sid);
  assert.equal(auth.resolveTokenUser(first.token), null, '이전 세션 토큰은 즉시 무효(로그아웃)');
  assert.ok(auth.resolveTokenUser(second.token), '최신 세션 토큰만 유효');
});

test('단일 세션 ON: sid 없는(기능 활성화 전 발급) 토큰은 무효 → 재로그인 유도', () => {
  sec.saveSessionSecurity({ singleSession: true });
  const u = auth.getUser('ss-user');
  const noSid = auth.signToken({ sub: 'ss-user', role: u.role, name: 'ss', src: 'local', tv: u.tokenVersion || 0 });
  assert.equal(auth.resolveTokenUser(noSid), null, 'sid 없는 토큰은 단일세션 ON 에서 무효');
});

test('OFF 로 되돌리면 sid 검사를 건너뛴다(sid 있는 토큰도 그대로 유효)', () => {
  sec.saveSessionSecurity({ singleSession: true });
  const t = loginLikeRoute('ss-user');
  assert.ok(auth.resolveTokenUser(t.token));
  // 다른 로그인으로 활성 sid 를 덮어써 t 를 '이전 세션' 으로 만든다.
  loginLikeRoute('ss-user');
  assert.equal(auth.resolveTokenUser(t.token), null, 'ON 상태에선 덮어쓰여 무효');
  // 단일세션을 끄면 sid 불일치를 더 이상 따지지 않는다(다중 세션 허용).
  sec.saveSessionSecurity({ singleSession: false });
  assert.ok(auth.resolveTokenUser(t.token), 'OFF 로 바꾸면 이전 sid 토큰도 유효');
});

test('활성 세션 레지스트리는 파일로 영속(재시작 후에도 강제 유지)', () => {
  sec.saveSessionSecurity({ singleSession: true });
  const t = loginLikeRoute('ss-user');
  const sid = t.sid;
  // 인메모리 캐시를 비워 '재시작' 재현 → 파일에서 다시 로드.
  sessions._resetSessions();
  assert.equal(sessions.isActiveSession('ss-user', sid), true, '재시작 후에도 활성 sid 유지');
  assert.equal(sessions.isActiveSession('ss-user', 'deadbeef'), false, '다른 sid 는 불일치');
});
