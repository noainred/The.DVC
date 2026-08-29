import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 확정 버그 회귀 방지(2026-08-30, 4차 재감사) — 소유자 경계를 우회하는 '소유자를 만드는 권능'.
//
// 배경: 중앙이 배포한 admin 계정은 엣지에서 managedAdminOwners() 로 **자동 설정 소유자**가 된다
// (문서화된 의도). 그래서 엣지 사용자 배포 라우트는 사실상 '엣지의 소유자를 만드는 권능'인데
// adminOnly 로만 열려 있었다 → 비소유자 중앙 admin 이 targets:['*'] 로 전 엣지의 소유자가 되어
// 엣지 백업 다운로드(엣지 AUTH_SECRET·TOTP 시크릿)까지 이어졌다(재감사 실행 재현).
// AD 설정 변경도 인증 소스 자체를 바꾸는 권능이라 같은 등급으로 올렸다.
//
// 라우트 미들웨어는 서버 기동 없이 검증하기 어려워, 저장소 관례(정적 검사 테스트 — 예:
// svcmonRouteOrder 의 '정적: transfer.js 에서 …')에 따라 소스에서 게이트 부착을 고정한다.
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (...p) => fs.readFileSync(path.join(here, '..', 'src', ...p), 'utf8');
// 주석 제거 후 검사한다 — 이 저장소는 '과거에 이런 코드였다'를 주석에 인용해 두므로, 원문
// 그대로 검사하면 그 설명 문구가 코드로 오인돼 오탐이 난다(실제로 이 테스트가 그렇게 실패했다).
const code = (...p) => src(...p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('엣지 사용자 배포 3개 변경 라우트에 requireSettingsOwner 가 붙어 있다', () => {
  const s = src('routes', 'admin', 'gpuGuest.js');
  const mustGate = [
    /adminRouter\.post\('\/edge-users\/:agent',\s*adminOnly,\s*requireSettingsOwner/,
    /adminRouter\.post\('\/edge-users-bulk',\s*adminOnly,\s*requireSettingsOwner/,
    /adminRouter\.delete\('\/edge-users\/:agent\/:username',\s*adminOnly,\s*requireSettingsOwner/,
  ];
  for (const re of mustGate) assert.match(s, re, `게이트 누락: ${re}`);
});

test('엣지 사용자 조회(GET)는 종전대로 adminOnly — 과도한 제한 회귀 방지', () => {
  const s = src('routes', 'admin', 'gpuGuest.js');
  assert.match(s, /adminRouter\.get\('\/edge-users\/:agent',\s*adminOnly,\s*\(/,
    '조회까지 소유자 전용으로 올리면 운영 화면이 막힌다');
});

test('AD 설정 변경(PUT)에 requireSettingsOwner 가 붙어 있다(조회·테스트는 admin 유지)', () => {
  const s = src('routes', 'auth.js');
  assert.match(s, /authRouter\.put\('\/ad-config',\s*\.\.\.adminOnly,\s*requireSettingsOwner/);
  assert.match(s, /authRouter\.get\('\/ad-config',\s*\.\.\.adminOnly,\s*\(/, '조회는 admin 유지');
});

test('소유자 판정은 username 만 본다 — 표시이름(name)은 권한 축이 아니다', () => {
  // 표시이름은 PATCH /admin/users/:u 로 아무 admin 이나 바꿀 수 있는 값이라, 권한 판정에 쓰면
  // 그 축으로 소유자 승계가 된다(4차 재감사 실행 재현). 세 판정 지점이 모두 username 만 봐야 한다.
  const shared = code('routes', 'admin', 'shared.js');
  assert.match(shared, /owners\.includes\(u\.username\)\s*\)\s*return next\(\)/,
    'requireSettingsOwner 는 username 만으로 판정해야 한다');
  assert.doesNotMatch(shared, /owners\.includes\(u\.name\)/,
    '표시이름 매칭이 남아 있으면 소유자 승계 우회가 성립한다');

  const authRoutes = code('routes', 'auth.js');
  assert.doesNotMatch(authRoutes, /owners\.includes\((?:user|req\.user)\.name\)/,
    '로그인·/auth/me 의 isSettingsOwner 도 username 만 봐야 한다');

  const authSrc = code('auth', 'auth.js');
  assert.match(authSrc, /function isOwnerName\(username, owners\)/,
    'auth.js 보호 판정도 같은 키(username)여야 한다 — 넓히면 과보호, 좁히면 미보호');
});
