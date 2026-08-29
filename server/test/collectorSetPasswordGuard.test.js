import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 확정 버그 회귀 방지(2026-08-30, 6차 재감사) — 중앙→엣지 비밀번호 심기로 보호 계정 탈취.
//
// 배경: `POST /api/admin/collectors/set-password` 는 adminOnly 뿐이었고, `username` 이 요청
// 본문으로 완전히 제어된다. 서버가 저장된 엣지 토큰을 **대신 붙여** 푸시하므로 호출자는
// COLLECTOR_TOKEN 을 몰라도 된다. 그리고 엣지측(`routes/collector.js`)이
// `setLocalPassword(u, pw, { trusted: true })` 를 써서 `credentialGuardDenied` 를 **첫 줄에서
// 무조건 통과**시켰다 → 비소유자 중앙 admin 이 전 엣지의 `noainred`(수퍼관리자) 비번을 심고,
// 그 비번으로 로그인해 자력 OTP 등록(→ requireEnrolled 통과) → 백업 다운로드로 AUTH_SECRET·
// 전 계정 TOTP 시크릿 획득 → 임의 계정 토큰 위조까지 이어졌다(재감사 실행 재현).
//
// 수정은 두 겹이다: ① 엣지가 trusted 를 쓰지 않아 보호 계정을 거부(근본), ② 중앙 라우트에
// requireSettingsOwner(다층). ①이 핵심이라 함수 계약으로 고정한다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-setpw-'));
process.env.CONFIG_DIR = tmp;

const auth = await import('../src/auth/auth.js');
const sec = await import('../src/security/securitySettings.js');

test('시스템 경로(actor·trusted 없음)는 보호 계정 비밀번호를 심을 수 없다', () => {
  sec.saveSessionSecurity({ settingsOwners: [auth.SUPER_USERNAME, 'cs-owner'] });
  auth.createUser({ username: 'cs-owner', name: 'cs owner', role: 'admin', password: 'pw-cso-123456' }, { trusted: true });

  // 수퍼관리자 — 엣지에서 이 계정은 비번·OTP 없이 시드되는 것이 기본이라 가장 위험한 표적이다.
  const su = auth.setLocalPassword(auth.SUPER_USERNAME, 'planted-123456');
  assert.equal(su.ok, false, 'trusted 없이 수퍼관리자 비번이 심어지면 그 계정으로 로그인 가능');
  assert.match(su.reason, /본인만/);
  assert.ok(!auth.authenticateLocal(auth.SUPER_USERNAME, 'planted-123456'), '심어진 비번으로 로그인되면 안 된다');

  // 설정소유자도 동일.
  const ow = auth.setLocalPassword('cs-owner', 'planted-123456');
  assert.equal(ow.ok, false);
  assert.match(ow.reason, /본인만/);
});

test('시스템 경로로 일반 계정 비밀번호 교체는 종전대로 동작(문서화된 용도 보존)', () => {
  // 이 라우트의 문서화된 용도 = 엣지 기본 admin 계정 비번 일괄 교체. 그것이 막히면 기능 회귀다.
  sec.saveSessionSecurity({ settingsOwners: [auth.SUPER_USERNAME, 'cs-owner'] });
  auth.createUser({ username: 'cs-edgeadmin', name: 'edge admin', role: 'admin', password: 'pw-old-123456' }, { trusted: true });

  const r = auth.setLocalPassword('cs-edgeadmin', 'rotated-123456');
  assert.ok(r.ok, `일반(비소유자) 계정 비번 교체가 막히면 기능 회귀 — ${r.reason || ''}`);
  assert.ok(auth.authenticateLocal('cs-edgeadmin', 'rotated-123456'), '교체된 비번으로 로그인돼야 함');
});

test('로컬 콘솔 도구(trusted:true)는 여전히 수퍼관리자까지 복구 가능', () => {
  // 폰 분실 복구의 유일한 경로 — 로컬 셸 접근이 곧 신뢰 경계이므로 이건 열려 있어야 한다.
  assert.ok(auth.setLocalPassword(auth.SUPER_USERNAME, 'console-123456', { trusted: true }).ok);
});

// --- 라우트 게이트 부착(정적) — 대안이 없어 소스로 확인. 양성 단정만 사용한다. ---
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (...p) => fs.readFileSync(path.join(here, '..', 'src', ...p), 'utf8');

test('엣지 set-password 는 trusted 를 넘기지 않는다', () => {
  const s = src('routes', 'collector.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(s, /setLocalPassword\(username,\s*req\.body\?\.password\)/,
    '엣지는 actor·trusted 없이 호출해야 한다(보호 계정만 거부, 일반 계정은 허용)');
  assert.doesNotMatch(s, /setLocalPassword\([^)]*trusted:\s*true/,
    'trusted 는 로컬 콘솔 전용 — 원격 경로에 붙으면 보호 계정 경계가 전면 무효화된다');
});

test('중앙 set-password·중앙토큰 라우트에 requireSettingsOwner 가 붙어 있다', () => {
  assert.match(src('routes', 'admin', 'collectorsDc.js'),
    /post\('\/collectors\/set-password',[^)]*requireSettingsOwner/);
  const ci = src('routes', 'admin', 'centralIpam.js');
  assert.match(ci, /get\('\/central-token',[^)]*requireSettingsOwner/, '토큰 평문 조회는 소유자 전용');
  assert.match(ci, /post\('\/central-token\/generate',[^)]*requireSettingsOwner/);
  assert.match(ci, /put\('\/central-token',[^)]*requireSettingsOwner/);
});
