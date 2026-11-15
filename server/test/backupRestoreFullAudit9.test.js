/**
 * backupRestoreFullAudit9.test.js — 전체 소스 점검 9회차(V-20): 백업 복원은 OTP 를 묻지 않으므로 '소유자 + 본인 OTP' 로만 바꾸는 보안 설정을
 *   **약하게 되돌리지 않는다**(v2.842 F1 의 bareosSetupOtp 만 막혀 있었다 — server/CLAUDE.md '새 OTP 로 끄는 설정은 RESTORE_EXCLUDE 또는 reconcileForApply').
 *  ① loginPolicy 강도 순 · ② 설정 소유자는 지금 목록 안만 · ③ 유휴 로그아웃 · 단일 세션은 켜기만 · ④ 유휴 분 · 세션 상한은 더 짧은 쪽
 *  ⑤ 자격증명 저장 방식(secrets-policy.json · 신뢰 사본)은 지금이 암호화면 평문 백업으로 되돌리지 않는다 · ⑥ 적용 경로(reconcileForApply) 경고
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restorefa9-'));
process.env.CONFIG_DIR = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const R = await import('../src/backup/stagedRestore.js');
const J = (o) => JSON.stringify(o);

test('① loginPolicy — 백업이 더 약하면 지금 값 · 더 강하면 백업 값', () => {
  const cases = [
    ['password_only', 'otp_only', 'otp_only'], ['otp_or_password', null, null], ['password_only', null, null],
    ['otp_only', 'password_only', 'otp_only'], [null, 'otp_or_password', null], [null, 'otp_only', 'otp_only'],
  ];
  for (const [b, c, want] of cases) {
    const r = R.reconcileSecuritySessionText(J({ loginPolicy: b }), J({ loginPolicy: c }));
    assert.equal(JSON.parse(r.text).loginPolicy ?? null, want, `${b} ← ${c}`);
  }
  // 지금 파일이 없거나 손상이면 기본(레거시 — null)과 견준다
  assert.equal(JSON.parse(R.reconcileSecuritySessionText(J({ loginPolicy: 'password_only' }), null).text).loginPolicy, null);
  assert.equal(JSON.parse(R.reconcileSecuritySessionText(J({ loginPolicy: 'password_only' }), '{ bad').text).loginPolicy, null);
  assert.deepEqual(R.reconcileSecuritySessionText(J({ loginPolicy: 'password_only' }), J({ loginPolicy: 'otp_only' })).kept, ['loginPolicy']);
});

test('② 설정 소유자 — 지금 목록에 있는 계정만(지운 소유자를 되살리지 않는다) · 새 서버는 백업 그대로', () => {
  const r = R.reconcileSecuritySessionText(J({ settingsOwners: ['noainred', 'kim', 'lee'] }), J({ settingsOwners: ['noainred', 'lee'] }));
  assert.deepEqual(JSON.parse(r.text).settingsOwners, ['noainred', 'lee']);
  const r2 = R.reconcileSecuritySessionText(J({ settingsOwners: ['noainred', 'kim'] }), J({ idleLogoutMin: 30 }));
  assert.deepEqual(JSON.parse(r2.text).settingsOwners, ['noainred'], '지금 저장값이 없으면 기본(noainred)과 견준다');
  const fresh = R.reconcileSecuritySessionText(J({ settingsOwners: ['noainred', 'kim'] }), null);
  assert.deepEqual(JSON.parse(fresh.text).settingsOwners, ['noainred', 'kim'], '재해 복구 새 서버 — 소유자 복구 경로');
});

test('③ ④ 켜기만 · 더 짧은 쪽', () => {
  const r = R.reconcileSecuritySessionText(J({ idleLogoutEnabled: false, singleSession: false, idleLogoutMin: 600, sessionMaxHours: 0 }),
    J({ idleLogoutEnabled: true, singleSession: true, idleLogoutMin: 15, sessionMaxHours: 12 }));
  const o = JSON.parse(r.text);
  assert.equal(o.idleLogoutEnabled, true); assert.equal(o.singleSession, true); assert.equal(o.idleLogoutMin, 15); assert.equal(o.sessionMaxHours, 12);
  assert.deepEqual(r.kept.sort(), ['idleLogoutEnabled', 'idleLogoutMin', 'sessionMaxHours', 'singleSession']);
  // 백업이 더 강하면 백업 그대로(복원은 강하게는 한다)
  const s = J({ idleLogoutEnabled: true, singleSession: true, idleLogoutMin: 10, sessionMaxHours: 4 });
  assert.equal(R.reconcileSecuritySessionText(s, J({ idleLogoutEnabled: false, singleSession: false, idleLogoutMin: 60, sessionMaxHours: 0 })).text, s);
  // 지금 파일 없음 = 기본(유휴 로그아웃 켬 · 30분)
  assert.equal(JSON.parse(R.reconcileSecuritySessionText(J({ idleLogoutEnabled: false }), null).text).idleLogoutEnabled, true);
});

test('⑤ 자격증명 저장 방식 — 지금 암호화면 평문 백업으로 되돌리지 않는다 · 지금 파일이 없으면 백업 그대로', () => {
  const enc = J({ mode: 'encrypted', level: 2 }); const plain = J({ mode: 'plain', level: 2 });
  assert.equal(R.reconcileSecretsPolicyText(plain, enc).text, enc);
  assert.equal(R.reconcileSecretsPolicyText(plain, enc).keptCurrent, true);
  assert.equal(R.reconcileSecretsPolicyText(enc, plain).text, enc, '강하게는 한다');
  assert.equal(R.reconcileSecretsPolicyText(plain, null).text, plain, '재해 복구 새 서버');
  assert.equal(R.reconcileSecretsPolicyText('{ bad', enc).text, enc, '깨진 백업도 지금 암호화 유지');
});

test('⑥ 적용 경로 — reconcileForApply 가 지금 파일을 읽어 맞추고 경고한다', () => {
  fs.writeFileSync(path.join(tmp, 'security-session.json'), J({ loginPolicy: 'otp_only', settingsOwners: ['noainred'] }));
  const a = R.reconcileForApply('security-session.json', J({ loginPolicy: 'password_only', settingsOwners: ['noainred', 'evil'] }), tmp);
  assert.equal(JSON.parse(a.content).loginPolicy, 'otp_only'); assert.deepEqual(JSON.parse(a.content).settingsOwners, ['noainred']);
  assert.match(a.warning.reason, /약하게 되돌리지 않습니다/); assert.deepEqual(a.info.securityKept.sort(), ['loginPolicy', 'settingsOwners']);
  for (const f of ['secrets-policy.json', 'secrets-policy.trusted.json']) {
    fs.writeFileSync(path.join(tmp, f), J({ mode: 'encrypted', level: 2 }));
    const b = R.reconcileForApply(f, J({ mode: 'plain', level: 2 }), tmp);
    assert.equal(JSON.parse(b.content).mode, 'encrypted', f); assert.equal(b.info.secretsPolicyKept, true);
  }
});
