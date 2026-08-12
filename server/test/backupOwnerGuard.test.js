import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// v2.210 보안 감사(5차) 회귀 방지 —
// 백업 아카이브에는 portal.env(AUTH_SECRET·CENTRAL_TOKEN) · users.json(TOTP 시크릿·비번 해시) ·
// vcenters.json 등 **전 자격증명 사본**이 담긴다. UI 는 '설정' 탭이 소유자 전용이지만 API 가
// adminOnly 였어서, 소유자가 아닌 admin 이 직접 호출해 통째로 인출할 수 있었다.
// AUTH_SECRET 이 새면 임의 계정(수퍼관리자 포함) 토큰을 위조해 OTP 전용 정책과 소유자 경계가
// 동시에 무너지므로, 백업·보안설정 라우트에는 requireSettingsOwner 가 반드시 붙어 있어야 한다.

// v2.285.0 분할 — admin.js + routes/admin/* 를 등록 순서대로 결합해 전 모듈을 계속 검사한다.
import { readAdminSource } from './lib/apiSource.js';
const SRC = readAdminSource();

/** 라우트 선언 한 줄을 찾아 반환(없으면 null). */
function routeLine(re) {
  return SRC.split('\n').find((l) => re.test(l)) || null;
}

const MUST_BE_OWNER = [
  ["GET /backup/status", /adminRouter\.get\('\/backup\/status'/],
  ["PUT /backup/settings", /adminRouter\.put\('\/backup\/settings'/],
  ["POST /backup/now", /adminRouter\.post\('\/backup\/now'/],
  ["GET /backup/download/:name", /adminRouter\.get\('\/backup\/download\/:name'/],
  ["GET /backup/view/:name", /adminRouter\.get\('\/backup\/view\/:name'/],
  ["DELETE /backup/:name", /adminRouter\.delete\('\/backup\/:name'/],
  ["POST /backup/restore/:name", /adminRouter\.post\('\/backup\/restore\/:name'/],
  ["GET /security/session", /adminRouter\.get\('\/security\/session'/],
  ["PUT /security/session", /adminRouter\.put\('\/security\/session'/],
];

for (const [name, re] of MUST_BE_OWNER) {
  test(`소유자 전용 가드: ${name}`, () => {
    const line = routeLine(re);
    assert.ok(line, `${name} 라우트를 찾을 수 없습니다(경로가 바뀌었다면 이 테스트도 갱신하세요).`);
    assert.match(line, /requireSettingsOwner/,
      `${name} 에 requireSettingsOwner 가 빠졌습니다 — 소유자가 아닌 admin 이 자격증명 사본/보안 설정에 접근할 수 있습니다.`);
  });
}

test('백업 인출·복원은 감사 로그를 남긴다', () => {
  const dl = SRC.slice(SRC.indexOf("adminRouter.get('/backup/download/:name'"), SRC.indexOf("adminRouter.get('/backup/view/:name'"));
  assert.match(dl, /logAudit/, '백업 다운로드(자격증명 포함)는 감사 로그가 필요합니다.');
  const rs = SRC.slice(SRC.indexOf("adminRouter.post('/backup/restore/:name'"));
  assert.match(rs.slice(0, 800), /logAudit/, '설정 복원은 감사 로그가 필요합니다.');
});

test('백업 아카이브 화이트리스트: .json/.env 만, 데이터 파일은 제외', async () => {
  const svc = fs.readFileSync(new URL('../src/backup/service.js', import.meta.url), 'utf8');
  assert.match(svc, /ALLOW_EXT\s*=\s*new Set\(\['\.json', '\.env'\]\)/,
    '허용 확장자를 넓히면 .txt(settings-owners·initial-admin-password) 같은 파일까지 백업/복원 대상이 됩니다.');
  // 복원은 basename 으로 CONFIG_DIR 밖 경로 탈출을 막아야 한다.
  assert.match(svc, /path\.basename\(name\)/, '복원 시 경로 탈출 방지(basename)가 필요합니다.');
});

test('업로드 아카이브 복원 라우트는 노출되어 있지 않다(도달 불가 확인)', () => {
  // v2.283/2.285 분할로 routes/ 아래에 api/·admin/ 하위 폴더가 생겨 재귀로 훑는다(검사 범위 유지·강화).
  const routesDir = new URL('../src/routes/', import.meta.url);
  const files = fs.readdirSync(routesDir, { recursive: true }).filter((f) => String(f).endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(routesDir.pathname, String(f)), 'utf8');
    assert.ok(!/parseUploadedArchive/.test(src),
      `${f}: 업로드 아카이브 복원을 노출하려면 소유자 가드 + 아카이브 검증을 먼저 설계하세요(임의 설정 주입 위험).`);
  }
});
