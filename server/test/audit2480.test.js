/**
 * v2.480 3차 감사 후속 회귀 테스트(docs/AUDIT-2026-09-11c.md).
 *  - 코어2 S5: OTP 등록 확정 코드는 같은 30초 창에서 로그인에 재사용되지 않는다(totpLastCounter 기록).
 *  - S8: SMTP host 변경 + 비밀번호 미입력 → 저장 비밀번호 이월 금지.
 *  - 코어2 S2: secretVault 복호 실패 파일은 정책 전환 시 재기록하지 않는다(암호문 소거 방지; 실패값은 '' 유지).
 *  - 코어2 S1: 번들 수신측 sha256 판정(헤더 부재 거부·불일치 거부·일치 통과·UNVERIFIED 예외).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-audit2480-'));
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-pw-123';

let auth; let totp; let mail; let vault; let upg;
before(async () => {
  auth = await import('../src/auth/auth.js');
  totp = await import('../src/auth/totp.js');
  mail = await import('../src/mail/settings.js');
  vault = await import('../src/security/secretVault.js');
  upg = await import('../src/upgrade/upgrade.js');
});

test('코어2 S5: OTP 등록 확정 코드 재사용(replay) 거부', () => {
  auth.createUser({ username: 'a2480-otp', name: 'otp', role: 'viewer', password: 'pw-otp-12345' });
  const b = auth.beginTotpEnroll('a2480-otp');
  const code = totp.generateToken(b.secret);
  const c = auth.confirmTotpEnroll('a2480-otp', code);
  assert.ok(c.ok, JSON.stringify(c));
  const users = JSON.parse(fs.readFileSync(path.join(process.env.CONFIG_DIR, 'users.json'), 'utf8'));
  const u = (users.users || users).find((x) => x.username === 'a2480-otp');
  assert.ok(Number.isInteger(u.totpLastCounter), '등록 확정 카운터가 기록되어야 한다');
  assert.equal(totp.verifyToken(code, b.secret, { minCounter: u.totpLastCounter }), null, '같은 코드는 로그인에서 거부되어야 한다');
});

test('S8: SMTP host 변경 시 비밀번호 이월 금지', () => {
  mail.save({ smtp: { host: 'smtp-a.corp', port: 587, user: 'u', password: 'mail-pw-1' } });
  assert.equal(mail.load().smtp.password, 'mail-pw-1');
  mail.save({ smtp: { host: 'smtp-a.corp', port: 587, user: 'u2' } });
  assert.equal(mail.load().smtp.password, 'mail-pw-1', 'host 불변 편집은 기존 비밀번호 유지');
  mail.save({ smtp: { host: 'smtp-b.corp' } });
  assert.equal(mail.load().smtp.password, '', 'host 변경 시 비밀번호가 새 host 로 이월되면 안 된다');
});

test('코어2 S2: 복호 실패 파일은 정책 전환 시 재기록하지 않는다(암호문 소거 방지)', () => {
  const sealed = vault.sealSecret('pw-secret-1', { mode: 'encrypted', level: 2 });
  assert.equal(vault.openSecret(sealed), 'pw-secret-1');
  const corrupted = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA');
  const before = vault.decryptFailureCount();
  assert.equal(vault.openSecret(corrupted), '', '복호 실패는 빈 값(봉인문을 비밀번호로 쓰면 잘못된 로그인 반복 → 계정 잠금 위험)');
  assert.ok(vault.decryptFailureCount() > before, '실패 횟수가 누적되어야 한다');
  // 정책 전환: 복호 실패가 난 파일은 그대로 두고 오류로 보고한다(예전엔 '' 를 재기록해 암호문 영구 소거).
  const fp = path.join(process.env.CONFIG_DIR, 'vcenters.json');
  const raw = JSON.stringify({ vcenters: [{ id: 'vc-x', host: 'h', username: 'u', password: corrupted }] }, null, 2);
  fs.writeFileSync(fp, raw);
  const r = vault.migrateSecretFiles({ mode: 'plain' });
  assert.equal(fs.readFileSync(fp, 'utf8'), raw, '복호 실패 파일은 바이트 단위로 그대로여야 한다');
  assert.ok(r.errors.some((e) => e.file === 'vcenters.json' && /복호 실패/.test(e.error)), JSON.stringify(r.errors));
});

test('코어2 S1: 번들 수신 sha256 판정', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('not-really-a-tarball');
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.equal(upg.bundleShaIssue(sha, bytes, { allowUnverified: false }), null);
  assert.equal(upg.bundleShaIssue(sha.toUpperCase(), bytes, { allowUnverified: false }), null, '대소문자 무관');
  assert.match(upg.bundleShaIssue('', bytes, { allowUnverified: false }), /검증할 수 없습니다/);
  assert.equal(upg.bundleShaIssue('', bytes, { allowUnverified: true }), null, 'UNVERIFIED 예외');
  assert.match(upg.bundleShaIssue('0'.repeat(64), bytes, { allowUnverified: false }), /불일치/);
  assert.match(upg.bundleShaIssue('zz', bytes, { allowUnverified: false }), /형식/);
});
