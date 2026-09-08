import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-ext-'));
process.env.CONFIG_DIR = tmp;
process.env.AUTH_SECRET = 'test-secret-for-session-extend';

let auth, sec;
before(async () => {
  auth = await import('../src/auth/auth.js');
  sec = await import('../src/security/securitySettings.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const decode = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString());

// ── signToken 의 exp 지정(연장이 기대는 기능) ────────────────────────────────
test('signToken: exp 미지정이면 기존대로 지금+TTL', () => {
  const now = Math.floor(Date.now() / 1000);
  const p = decode(auth.signToken({ sub: 'u' }));
  assert.ok(p.exp > now, '만료가 미래여야 한다');
  assert.equal(p.iat <= now + 1, true);
});

test('signToken: exp 를 명시하면 그 값이 그대로 들어간다(연장의 기반)', () => {
  const want = Math.floor(Date.now() / 1000) + 12345;
  const p = decode(auth.signToken({ sub: 'u' }, { exp: want }));
  assert.equal(p.exp, want);
});

test('signToken: 승계 클레임(sid·tv)이 보존된다 — 빠지면 단일세션/토큰폐기가 무력화', () => {
  const p = decode(auth.signToken({ sub: 'u', src: 'local', tv: 7, sid: 'S1' }, { exp: 9999999999 }));
  assert.equal(p.sid, 'S1');
  assert.equal(p.tv, 7);
  assert.equal(p.src, 'local');
});

test('verifyToken: 지정한 exp 가 지났으면 거부된다', () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  const t = auth.signToken({ sub: 'u' }, { exp: past });
  assert.equal(auth.verifyToken(t), null);
});

// ── 설정 저장 규약 ───────────────────────────────────────────────────────────
test('세션 경고 설정: 기본값(8시간 정책 유지 + 10분 전 경고 + 60분 연장)', () => {
  const s = sec.loadConfiguredSecurity();
  assert.equal(s.sessionWarnEnabled, true);
  assert.equal(s.sessionWarnMin, 10);
  assert.equal(s.sessionExtendMin, 60);
  assert.equal(s.sessionMaxHours, 0, '기본은 무제한(사용자 요구: 확인하면 계속 연장)');
});

test('세션 경고 설정: 범위 밖 값은 clamp, 0(무제한)은 하한으로 올리지 않는다', () => {
  sec.saveSessionSecurity({ sessionWarnMin: 999, sessionExtendMin: 1, sessionMaxHours: 0 });
  const s = sec.loadConfiguredSecurity();
  assert.equal(s.sessionWarnMin, 120, '상한 120분');
  assert.equal(s.sessionExtendMin, 5, '하한 5분');
  assert.equal(s.sessionMaxHours, 0, '0 은 무제한 — clamp 하한(0)으로 살아남아야 한다');
});

test('세션 경고 설정: 총 상한을 지정하면 보존된다', () => {
  sec.saveSessionSecurity({ sessionMaxHours: 12 });
  assert.equal(sec.loadConfiguredSecurity().sessionMaxHours, 12);
  sec.saveSessionSecurity({ sessionMaxHours: 0 }); // 되돌리기
  assert.equal(sec.loadConfiguredSecurity().sessionMaxHours, 0);
});

test('세션 경고 설정: 끄기/켜기', () => {
  sec.saveSessionSecurity({ sessionWarnEnabled: false });
  assert.equal(sec.loadConfiguredSecurity().sessionWarnEnabled, false);
  sec.saveSessionSecurity({ sessionWarnEnabled: true });
  assert.equal(sec.loadConfiguredSecurity().sessionWarnEnabled, true);
});

test('세션 경고 설정 저장이 기존 항목(유휴 로그아웃·소유자)을 지우지 않는다', () => {
  sec.saveSessionSecurity({ idleLogoutMin: 45, settingsOwners: ['noainred', 'admin'] });
  sec.saveSessionSecurity({ sessionWarnMin: 15 });
  const s = sec.loadConfiguredSecurity();
  assert.equal(s.idleLogoutMin, 45);
  assert.deepEqual(s.settingsOwners, ['noainred', 'admin']);
  assert.equal(s.sessionWarnMin, 15);
});

// ── 연장 계산 규약(라우트가 쓰는 산식을 순수하게 고정) ────────────────────────
// 라우트는 Express 의존이라 여기서는 산식만 고정한다: '기존 만료 + M분', 상한이 있으면 iat+상한.
test('연장 산식: 지금 기준이 아니라 기존 만료 기준으로 늘린다', () => {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 600;          // 만료 10분 전(경고 창 안)
  const extendSec = 3600;
  const next = exp + extendSec;
  assert.equal(next - now, 4200, '10분 남은 시점에 1시간 연장 = 총 70분 (지금 기준이면 60분으로 줄어든다)');
});

test('연장 산식: 총 상한이 있으면 iat+상한 을 넘지 않는다(capped)', () => {
  const iat = 1_000_000;
  const exp = iat + 8 * 3600;     // 8시간 토큰
  const maxH = 8;                 // 총 상한 8시간 = 연장 불가
  const hardLimit = iat + maxH * 3600;
  const next = Math.min(exp + 3600, hardLimit);
  assert.equal(next, hardLimit);
  assert.equal(next, exp, '상한이 토큰 수명과 같으면 실질 연장 0');
});
