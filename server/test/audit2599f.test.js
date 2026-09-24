import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.599 감사 그룹 f — WEB2599-05: 평문 자격증명 점검의 소스 휴리스틱이 코드 상수·화면 라벨·자기 파일을
// '의심' 으로 세던 것(이 저장소 전수 9건 전부 오탐). 진짜 하드코딩은 계속 잡아야 한다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2599f-'));
process.env.CONFIG_DIR = path.join(TMP, 'cfg');
fs.mkdirSync(process.env.CONFIG_DIR);
delete process.env.SECRETS_KEY;
const { runSecretScan, srcValueLooksLikeCode } = await import('../src/security/secretScan.js');

const SRC = path.join(TMP, 'src');
fs.mkdirSync(SRC);
fs.writeFileSync(path.join(SRC, 'codes.js'), [
  "export const K = {",
  "  PROBE_EDGE_NO_TOKEN: 'probe-edge-no-token',",            // 2 열거형 코드
  "  password: 'password_only', otp_or_password: 'otp_or_password',", // 3
  "  otp_or_password: 'OTP+비밀번호(혼용)',",                  // 4 한글 라벨
  "};",
  "const a = { password: 'admin123' };",                     // 6 진짜 — 숫자 섞인 식별자
  "const b = { secret: 'secret_pass' };",                    // 7 ⚠ 남는 한계: 글자뿐이고 키워드 단어를 포함해 코드로 본다(빠진다)
  "const c = { token: 'edge-no-token', password: 'Hunter2Zz' };", // 8 첫 대입은 코드, 둘째는 진짜
  "const d = { password: '비밀번호1234' };",                  // 9 숫자 섞인 한글 값
].join('\n'));

test('WEB2599-05 코드 상수·한글 라벨은 빼고 진짜 값은 잡는다', async () => {
  const r = await runSecretScan({ fresh: true, sourceDirs: [SRC] });
  const lines = r.source.hits.map((h) => h.line).sort((x, y) => x - y);
  assert.ok(!lines.includes(2) && !lines.includes(3) && !lines.includes(4), `코드 상수·라벨이 의심으로 셌다: ${lines}`);
  assert.ok(lines.includes(6), 'admin123 을 놓쳤다');
  assert.ok(lines.includes(8), '같은 줄 둘째 대입의 진짜 값을 놓쳤다');
  assert.ok(lines.includes(9), '숫자 섞인 한글 값을 놓쳤다');
});

test('WEB2599-05 판정 함수 — 키워드와 같은 단어를 포함한 글자만 식별자만 코드로 본다', () => {
  assert.equal(srcValueLooksLikeCode('token', 'probe-edge-no-token'), true);
  assert.equal(srcValueLooksLikeCode('password', 'otp_or_password'), true);
  assert.equal(srcValueLooksLikeCode('password', 'admin123'), false);
  assert.equal(srcValueLooksLikeCode('password', 'hunter_two'), false); // 키워드 단어가 아니다
  assert.equal(srcValueLooksLikeCode('password', 'Hunter2Zz'), false);
  assert.equal(srcValueLooksLikeCode('password', '비밀번호1234'), false);
});

test('WEB2599-05 이 저장소 서버 소스 전수 — 자기 파일·코드 상수가 의심으로 잡히지 않는다', async () => {
  const src = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src');
  const r = await runSecretScan({ fresh: true, sourceDirs: [src] });
  const self = r.source.hits.filter((h) => /secretScan\.js$/.test(h.file));
  assert.equal(self.length, 0);
  // 감사 시점 오탐 9건이 있던 파일들 — 여기서 다시 잡히면 규칙이 되돌아간 것이다.
  const known = /(tokenFindings|tokenScan|opsSettings|securitySettings|secretScan)\.js$/;
  const back = r.source.hits.filter((h) => known.test(h.file));
  assert.equal(back.length, 0, JSON.stringify(back.map((h) => `${h.file}:${h.line}`)));
});
