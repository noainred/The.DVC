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

// ── v2.689 B4·B5: 연쇄 연장이 총 상한을 밀어내지 않는다(실제 라우트 호출) ───────────
// 기준 시각은 고정값이다(CLAUDE.md — 테스트에서 Date.now() 를 기준 시각으로 쓰지 말 것). Date.now 를 그 시각으로 고정한다.
test('B4: lt(원래 로그인 시각) — 로그인 발급은 lt=iat, 넘기면 그대로 승계', () => {
  const p = decode(auth.signToken({ sub: 'u' }));
  assert.equal(p.lt, p.iat, '로그인 토큰은 lt = iat');
  const q = decode(auth.signToken({ sub: 'u', lt: 1_700_000_000 }, { exp: 9999999999 }));
  assert.equal(q.lt, 1_700_000_000, '연장 토큰은 lt 승계');
});

test('B4: /auth/extend 를 3회 연쇄 호출해도 총 상한은 원래 로그인 시각 + maxH 에서 밀리지 않는다', async () => {
  const express = (await import('express')).default;
  const { authRouter } = await import('../src/routes/auth.js');
  const { config } = await import('../src/config.js');
  assert.equal(config.auth.enabled, true, '이 테스트는 인증이 켜진 상태를 전제한다');
  sec.saveSessionSecurity({ sessionWarnEnabled: true, sessionWarnMin: 120, sessionExtendMin: 60, sessionMaxHours: 3 });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/auth/extend`;
  const realNow = Date.now;
  const T0 = 1_900_000_000; // 고정 로그인 시각(epoch 초)
  const at = (sec2) => { Date.now = () => sec2 * 1000; };
  const ext = async (tok) => {
    const r = await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${tok}` } });
    return { status: r.status, body: await r.json() };
  };
  try {
    at(T0);
    let tok = auth.signToken({ sub: 'ad-user-sess-ext', role: 'viewer', name: 'x' }, { exp: T0 + 3600 });
    // 1회: T0+50분 — 다음 만료 T0+2h(상한 T0+3h 안)
    at(T0 + 50 * 60);
    let r = await ext(tok);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.capped, false);
    tok = r.body.token;
    assert.equal(decode(tok).lt, T0, '연장 토큰이 원래 로그인 시각을 승계');
    // 2회: T0+1h50m — 다음 만료 T0+3h(= 상한, 잘리지 않음)
    at(T0 + 110 * 60);
    r = await ext(tok);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    tok = r.body.token;
    assert.equal(r.body.expiresAt, (T0 + 3 * 3600) * 1000);
    // 3회: T0+2h50m — 다음 만료 T0+4h 는 상한(T0+3h) 밖 → 상한으로 잘린다.
    //   (예전 iat 기준이면 상한이 T0+1h50m+3h 로 밀려 T0+4h 가 그대로 발급됐다.)
    at(T0 + 170 * 60);
    r = await ext(tok);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.capped, true, '상한에 걸렸다고 말해야 한다');
    assert.equal(r.body.expiresAt, (T0 + 3 * 3600) * 1000, '상한이 원래 로그인 시각 + 3h 에 고정');
    assert.equal(decode(r.body.token).lt, T0);
    // 상한을 지난 뒤에는 더 연장되지 않는다.
    at(T0 + 3 * 3600 - 1);
    r = await ext(r.body.token);
    assert.ok(r.status === 200 ? r.body.expiresAt === (T0 + 3 * 3600) * 1000 : r.status === 409, JSON.stringify(r.body));
  } finally {
    Date.now = realNow;
    srv.close();
    sec.saveSessionSecurity({ sessionWarnMin: 10, sessionMaxHours: 0 });
  }
});

test('B4: lt 가 없는 구버전 토큰은 iat 로 폴백한다(연장 토큰부터 lt 승계)', async () => {
  // 산식만 — 라우트 산식과 같은 식: loginAt = lt || iat || now
  const loginAt = (p, now) => Number(p.lt) || Number(p.iat) || now;
  assert.equal(loginAt({ iat: 100 }, 999), 100);
  assert.equal(loginAt({ iat: 100, lt: 50 }, 999), 50);
});

test('B5: /auth/extend 는 requireEnrolled 를 거친다(OTP 등록 전용 세션은 /me·/totp/* 만)', async () => {
  const { authRouter } = await import('../src/routes/auth.js');
  const layer = authRouter.stack.find((l) => l.route?.path === '/extend' && l.route.methods.post);
  assert.ok(layer, '/extend 라우트');
  const names = layer.route.stack.map((s) => s.handle.name);
  assert.ok(names.includes('authMiddleware'), names.join(','));
  assert.ok(names.includes('requireEnrolled'), `requireEnrolled 누락: ${names.join(',')}`);
});
