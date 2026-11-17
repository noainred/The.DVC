/**
 * 전체 점검 88회차 — 인증 · 권한 · 관리 라우트(server/src/auth · routes/admin · security).
 *
 * 1차에서 고친 유형(결정 78 ① 등록부 · 19회차 A-4 users.json — **읽기 오류 ≠ 손상**)이 형제 설정 파일 넷에 그대로 남아 있었다:
 *   F1 security/securitySettings.js(security-session.json — 설정 소유자 · 로그인 정책 · 단일 세션 · 총 상한)
 *   F2 security/emergencyStop.js(emergency-stop.json — 2인 승인 긴급중단)
 *   F3 auth/ad.js(auth.json — AD 설정 · 정책 카운터)
 *   F4 security/credentialStore.js(credentials.json — 통합 계정 봉인 비밀)
 * 넷 다 읽기 오류(EIO)를 파싱 손상과 같은 catch 로 받아 **원본을 .corrupt 로 옮기고** 기본값으로 돌았다 — 디스크가 돌아와도 · 재시작해도
 * 원본이 옆으로 치워져 있어 설정이 영구히 사라졌다. 이제 원본을 그대로 두고 · 30초 뒤 다시 읽고 · 그동안 쓰기는 거절한다(손상은 예전 그대로).
 *
 * 읽기 오류는 fs.readFileSync 를 그 파일에서만 EIO 로 던지게 바꿔 재현한다(테스트가 root 로 돌면 chmod 000 은 읽힌다 — decideRegistry3189 와 같은 방식).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('audit88-');
process.env.CONFIG_DIR = DIR;
process.env.AUTH_SECRET = 'audit88-secret-0123456789abcdef0123456789abcdef';

const jfr = await import('../src/util/jsonFileRead.js');
const sec = await import('../src/security/securitySettings.js');
const es = await import('../src/security/emergencyStop.js');
const ad = await import('../src/auth/ad.js');
const cs = await import('../src/security/credentialStore.js');

/** 그 파일의 readFileSync 만 EIO 로 던진다. 돌려준 함수로 되돌린다. */
function eioOn(file) {
  const orig = fs.readFileSync;
  fs.readFileSync = function patched(p, ...a) {
    if (path.resolve(String(p)) === path.resolve(file)) { const e = new Error(`EIO: i/o error, read '${file}'`); e.code = 'EIO'; throw e; }
    return orig.call(this, p, ...a);
  };
  return () => { fs.readFileSync = orig; };
}
const corruptCopies = (base) => fs.readdirSync(DIR).filter((f) => f.startsWith(`${base}.corrupt.`));
// 기준 시각은 실제 시각에서 정시 경계로 떨어뜨려 고정(docs/rules/common.md) — 재읽기 간격(30초)만 이 시계로 넘긴다.
const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
let clock = T0;
jfr._setJsonFileLoadClockForTest(() => clock);
after(() => jfr._setJsonFileLoadClockForTest());

test('F1 security-session.json 읽기 오류 — 원본을 옮기지 않고 · 마지막 값 유지 · 저장 거절 · 회복 뒤 원래 값', () => {
  const file = path.join(DIR, 'security-session.json');
  const stored = { idleLogoutEnabled: true, idleLogoutMin: 10, settingsOwners: ['alice', 'bob'], loginPolicy: 'otp_only', singleSession: true, sessionMaxHours: 8 };
  fs.writeFileSync(file, JSON.stringify(stored));
  sec._resetSessionSecurityReadForTest();
  assert.deepEqual(sec.loadConfiguredSecurity().settingsOwners, ['alice', 'bob']);
  const undo = eioOn(file);
  try {
    clock += 1;
    const r = sec.loadConfiguredSecurity();
    assert.deepEqual(r.settingsOwners, ['alice', 'bob'], '읽기 오류 동안 소유자 목록이 기본값(noainred)으로 바뀌면 안 된다');
    assert.equal(r.loginPolicy, 'otp_only');
    assert.equal(r.singleSession, true);
    assert.equal(r.sessionMaxHours, 8);
    assert.equal(r.idleLogoutMin, 10);
    assert.equal(sec.sessionSecurityReadError()?.code, 'EIO');
    assert.throws(() => sec.saveSessionSecurity({ idleLogoutMin: 15 }), (e) => e.status === 503 && e.code === 'settings-unreadable');
  } finally { undo(); }
  assert.ok(fs.existsSync(file), '원본이 그대로 있어야 한다');
  assert.equal(corruptCopies('security-session.json').length, 0, '읽기 오류를 손상으로 보존(옮김)하면 안 된다');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), stored, '거절한 저장이 원본을 덮으면 안 된다');
  clock += 31_000;   // 재읽기 간격이 지나면 다시 읽는다
  assert.deepEqual(sec.loadConfiguredSecurity().settingsOwners, ['alice', 'bob']);
  assert.equal(sec.sessionSecurityReadError(), null);
  // 손상은 예전 그대로 — 보존본으로 옮기고 기본값(손상 시 약해짐은 사용자 결정 대기)
  fs.writeFileSync(file, '{not json');
  clock += 1;
  assert.deepEqual(sec.loadConfiguredSecurity().settingsOwners, ['noainred']);
  assert.equal(corruptCopies('security-session.json').length, 1);
  assert.equal(sec.sessionSecurityReadError(), null);
});

test('F1 처음부터 읽기 오류(마지막 값 없음)면 기본값이지만 원본은 옮기지 않고 저장도 거절', () => {
  const file = path.join(DIR, 'security-session.json');
  fs.writeFileSync(file, JSON.stringify({ settingsOwners: ['carol'], loginPolicy: 'otp_only' }));
  sec._resetSessionSecurityReadForTest();
  const undo = eioOn(file);
  try {
    clock += 1;
    assert.deepEqual(sec.loadConfiguredSecurity().settingsOwners, ['noainred']);
    assert.throws(() => sec.saveSessionSecurity({ settingsOwners: ['mallory'] }), (e) => e.status === 503);
  } finally { undo(); }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).settingsOwners, ['carol']);
  clock += 31_000;
  assert.deepEqual(sec.loadConfiguredSecurity().settingsOwners, ['carol'], '회복 뒤 원래 소유자가 돌아와야 한다');
});

test('F2 emergency-stop.json 읽기 오류 — 2인 승인 긴급중단이 영구히 풀리지 않는다(원본 유지 · 재읽기 뒤 다시 적용)', () => {
  const file = path.join(DIR, 'emergency-stop.json');
  fs.writeFileSync(file, JSON.stringify({ active: true, by: ['a1', 'a2'], at: T0 }));
  es._resetEmergencyStopForTest();
  const undo = eioOn(file);
  try {
    clock += 1;
    assert.equal(es.isStopped(), false);   // 읽기 오류 동안의 값은 예전과 같은 비활성(fail-closed 는 결정 필요)
    assert.equal(es.getEmergencyStatus().readError?.code, 'EIO', '읽기 오류를 상태에 밝힌다');
  } finally { undo(); }
  assert.ok(fs.existsSync(file));
  assert.equal(corruptCopies('emergency-stop.json').length, 0);
  clock += 31_000;
  assert.equal(es.isStopped(), true, '읽히는 순간 저장된 긴급중단이 다시 적용돼야 한다');
  assert.equal(es.getEmergencyStatus().readError, undefined);
  // 재시작(모듈 상태 초기화)에도 원본이 남아 있다
  es._resetEmergencyStopForTest();
  assert.equal(es.isStopped(), true);
  es.setEmergencyStop(false, ['a1', 'a2']);
  assert.equal(es.isStopped(), false);
});

test('F2 손상은 예전 그대로 — 보존본 + 비활성', () => {
  const file = path.join(DIR, 'emergency-stop.json');
  fs.writeFileSync(file, '{broken');
  es._resetEmergencyStopForTest();
  clock += 1;
  assert.equal(es.isStopped(), false);
  assert.equal(corruptCopies('emergency-stop.json').length, 1);
});

test('F3 auth.json 읽기 오류 — AD 설정 · 정책 카운터를 옮기지 않고 저장 거절', () => {
  const file = path.join(DIR, 'auth.json');
  const saved = { enabled: true, url: 'ldaps://dc01.corp.local:636', domain: 'corp.local', baseDN: 'DC=corp,DC=local', adminGroup: 'Portal-Admins', policyEpoch: 7 };
  fs.writeFileSync(file, JSON.stringify({ ad: saved }));
  ad._resetAdConfigReadForTest();
  ad.invalidateAdPolicyCache();
  const before = ad.loadAdConfig();
  assert.equal(before.enabled, true);
  assert.equal(before.policyEpoch, 7);
  const undo = eioOn(file);
  try {
    clock += 1;
    const c = ad.loadAdConfig();
    assert.equal(c.enabled, true, '읽기 오류 동안 마지막 값을 쓴다(AD 세션이 끊기지 않게)');
    assert.equal(c.policyEpoch, 7, '정책 카운터가 0 으로 돌아가면 안 된다');
    assert.equal(ad.adConfigReadError()?.code, 'EIO');
    assert.throws(() => ad.saveAdConfig({ adminGroup: 'Other' }), (e) => e.status === 503 && e.code === 'ad-config-unreadable');
  } finally { undo(); }
  assert.equal(corruptCopies('auth.json').length, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ad.policyEpoch, 7);
  clock += 31_000;
  assert.equal(ad.loadAdConfig().policyEpoch, 7);
  assert.equal(ad.adConfigReadError(), null);
  // 손상은 예전 그대로(보존 + env 기본값)
  fs.writeFileSync(file, '{x');
  clock += 1;
  assert.equal(ad.loadAdConfig().policyEpoch, 0);
  assert.equal(corruptCopies('auth.json').length, 1);
});

test('F4 credentials.json 읽기 오류 — 봉인 계정을 옮기지 않고 빈 목록을 캐시하지 않으며 쓰기 거절', () => {
  const file = path.join(DIR, 'credentials.json');
  const items = [{ id: 'cred_a', name: 'svc-a', kind: 'password', username: 'svc', password: 'pw-a-123', hosts: ['10.0.0.5'], agents: ['*'] }];
  fs.writeFileSync(file, JSON.stringify({ version: 1, items }));
  cs._resetCredentials();
  const undo = eioOn(file);
  try {
    clock += 1;
    assert.deepEqual(cs.listCredentials(), []);
    assert.equal(cs.credentialsReadError()?.code, 'EIO');
    assert.equal(cs.brokerFetch('cred_a', { agent: 'edge1', host: '10.0.0.5' }).ok, false, '읽기 오류 동안 브로커는 닫힌다');
    assert.throws(() => cs.saveCredential({ name: 'new', kind: 'password', username: 'u1', password: 'pw-new-123', hosts: ['10.0.0.6'], agents: ['*'] }, { actor: 't' }),
      (e) => e.code === 'CREDENTIALS_UNREADABLE');
  } finally { undo(); }
  assert.equal(corruptCopies('credentials.json').length, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items.length, 1, '거절한 저장이 원본을 덮으면 안 된다');
  clock += 31_000;
  const list = cs.listCredentials();
  assert.equal(list.length, 1, '회복 뒤 원래 계정이 보여야 한다(빈 목록을 캐시하지 않았다)');
  assert.equal(cs.brokerFetch('cred_a', { agent: 'edge1', host: '10.0.0.5' }).ok, true);
  // 손상은 예전처럼 보존본으로
  fs.writeFileSync(file, '{oops');
  cs._resetCredentials();
  assert.deepEqual(cs.listCredentials(), []);
  assert.equal(corruptCopies('credentials.json').length, 1);
});

test('F5 관리자 대리 OTP 등록 확정은 비밀번호를 남겼는지 알린다(화면이 OTP 전용이라고 단정하지 않게)', async () => {
  fs.writeFileSync(path.join(DIR, 'security-session.json'), JSON.stringify({ settingsOwners: ['noainred'] }));   // 로그인 정책 미설정(레거시)
  clock += 31_000;
  sec._resetSessionSecurityReadForTest();
  sec.invalidateLoginPolicyCache();
  const A = await import('../src/auth/auth.js');
  const T = await import('../src/auth/totp.js');
  A.loadUsers();
  const enroll = (name) => { const b = A.beginTotpEnroll(name, '', { actor: 'admin' }); assert.equal(b.ok, true, JSON.stringify(b)); return A.confirmTotpEnroll(name, T.generateToken(b.secret), { actor: 'admin' }); };
  assert.equal(A.createUser({ username: 'v88', role: 'viewer', password: 'viewer-pass-88' }, { actor: 'admin' }).ok, true);
  const rv = enroll('v88');
  assert.equal(rv.ok, true);
  assert.equal(rv.passwordKept, true, '레거시 정책의 viewer 는 비밀번호를 남긴다');
  assert.ok(A.authenticateLocal('v88', 'viewer-pass-88'), '실제로 비밀번호 로그인이 계속 된다');
  assert.equal(A.createUser({ username: 'op88', role: 'operator', password: 'operator-pass-88' }, { actor: 'admin' }).ok, true);
  const ro = enroll('op88');
  assert.equal(ro.passwordKept, false, 'OTP 전용 대상(레거시 operator)은 비밀번호를 지운다');
  assert.equal(A.authenticateLocal('op88', 'operator-pass-88'), null);
});

test('F6 복원은 AD 정책 카운터를 되돌리지 않는다 — 매핑 변경으로 끝난 AD 세션이 되살아나지 않게', async () => {
  const SR = await import('../src/backup/stagedRestore.js');
  const A = await import('../src/auth/auth.js');
  const file = path.join(DIR, 'auth.json');
  fs.rmSync(file, { force: true });
  clock += 31_000;
  ad._resetAdConfigReadForTest(); ad.invalidateAdPolicyCache();
  ad.saveAdConfig({ enabled: true, url: 'ldaps://dc01.corp.local:636', adminGroup: 'Grp-A' });
  const backupText = fs.readFileSync(file, 'utf8');
  const ep1 = ad.adPolicyState().epoch;
  const nowSec = Math.floor(Date.now() / 1000);
  const tok = A.signToken({ sub: 'kim88', role: 'admin', name: 'kim88', src: 'ad', ep: ep1, sid: 'sid-f6-88' }, { exp: nowSec + 3600 });
  const cfgEnabled = (await import('../src/config.js')).config.auth.enabled;
  if (cfgEnabled) assert.ok(A.resolveTokenUser(tok), '발급 직후에는 유효');
  ad.saveAdConfig({ adminGroup: 'Grp-B' });   // 매핑 변경 → 카운터 2 → 위 토큰 무효
  const curEpoch = JSON.parse(fs.readFileSync(file, 'utf8')).ad.policyEpoch;
  const r = SR.reconcileForApply('auth.json', backupText, DIR);
  const applied = JSON.parse(r.content).ad;
  assert.equal(applied.adminGroup, 'Grp-A', '설정 내용은 백업 판본');
  assert.equal(applied.policyEpoch, curEpoch + 1, '카운터는 max(지금, 백업) + 1');
  assert.ok(r.warning && /다시 로그인/.test(r.warning.reason));
  fs.writeFileSync(file, r.content);
  clock += 31_000;
  ad.invalidateAdPolicyCache();
  assert.notEqual(ad.adPolicyState().epoch, ep1, '복원 뒤 정책 epoch 가 옛 토큰의 ep 와 같으면 안 된다');
  if (cfgEnabled) assert.equal(A.resolveTokenUser(tok), null, '복원 뒤 옛 AD 토큰은 무효');
  // 지금 파일을 읽지 못하면 적용하지 않는다(던진다 — applyStagedRestore 가 failed 로 남긴다)
  const undo = eioOn(file);
  try { assert.throws(() => SR.reconcileForApply('auth.json', backupText, DIR), /읽지 못해/); } finally { undo(); }
  // 깨진 백업 판본은 그대로(로더가 손상 보존)
  assert.equal(SR.reconcileAdConfigText('{x', null).bumped, false);
});

test('F7 복원은 연동 키 폐기 · 삭제를 되돌리지 않는다(백업 이후 폐기한 키가 다시 ok 가 되던 것)', async () => {
  const SR = await import('../src/backup/stagedRestore.js');
  const K = await import('../src/publicapi/keys.js');
  const file = path.join(DIR, 'api-keys.json');
  fs.rmSync(file, { force: true }); K._resetApiKeyCache();
  const a = K.issueApiKey({ name: 'ext-a', groups: ['inventory'] }, 'admin');
  const b = K.issueApiKey({ name: 'ext-b', groups: ['inventory'] }, 'admin');
  const backupText = fs.readFileSync(file, 'utf8');
  K.revokeApiKey(a.key.id, 'admin'); K.deleteApiKey(a.key.id);   // a: 폐기 + 삭제
  K.revokeApiKey(b.key.id, 'admin');                             // b: 폐기만
  const c = K.issueApiKey({ name: 'ext-c', groups: ['inventory'] }, 'admin');   // 백업 이후 발급
  const r = SR.reconcileForApply('api-keys.json', backupText, DIR);
  fs.writeFileSync(file, r.content); K._resetApiKeyCache();
  assert.equal(K.verifyApiKey(a.plaintext).state, 'unknown', '폐기하고 지운 키를 되살리면 안 된다');
  assert.equal(K.verifyApiKey(b.plaintext).state, 'revoked', '폐기한 키는 폐기 그대로');
  assert.equal(K.verifyApiKey(c.plaintext).state, 'ok', '백업 이후 발급한 키는 남긴다');
  assert.ok(r.warning && /되살리지 않았습니다/.test(r.warning.reason));
  // 지금 파일이 없으면(새 서버 재해 복구) 백업 그대로
  assert.equal(SR.reconcileApiKeysText(backupText, null).text, backupText);
  // 지금 파일을 읽지 못하면 적용하지 않는다
  const undo = eioOn(file);
  try { assert.throws(() => SR.reconcileForApply('api-keys.json', backupText, DIR), /읽지 못해/); } finally { undo(); }
});
