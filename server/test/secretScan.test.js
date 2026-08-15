import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.297 회귀 방지 — 평문 자격증명 점검(secretScan).
// 고정하는 의미론: ① 설정 필드 확정 분류(평문/암호화/빈값 — secretVault 포맷 판정과 일치)
// ② **응답 직렬화에 원문 비밀이 절대 없음**(마스킹 보증 — 점검 도구가 유출 통로가 되면 본말전도)
// ③ portal.env 민감 키 탐지(키 이름·길이만) ④ 로그 패턴 탐지(password=/URL 자격증명, 값 마스킹)
// ⑤ 소스 휴리스틱(하드코딩 리터럴 탐지, 플레이스홀더 제외).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-test-'));
process.env.CONFIG_DIR = TMP;
delete process.env.SECRETS_KEY;

const vault = await import('../src/security/secretVault.js');
const { runSecretScan } = await import('../src/security/secretScan.js');

// 원문 비밀(응답에 절대 나타나면 안 되는 값들)
const PLAIN_PW = 'SuperSecret-평문-9911';
const LOG_PW = 'LoggedPw-777x';
const SRC_PW = 'HardcodedZz-4242';

// 시드: 평문+암호화 혼재 설정, env, 로그, 소스 디렉터리
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({
  vcenters: [
    { name: 'A', password: PLAIN_PW },                                              // 평문
    { name: 'B', password: vault.sealSecret('enc-pw', { mode: 'encrypted', level: 1, algorithm: '' }) }, // 암호화
    { name: 'C', password: '' },                                                    // 빈값
  ],
}));
fs.writeFileSync(path.join(TMP, 'users.json'), JSON.stringify({ users: [{ username: 'u', passwordHash: 'HASH-노출금지-abc' }] }));
fs.writeFileSync(path.join(TMP, 'portal.env'), 'AUTH_SECRET=env-secret-value\nCENTRAL_TOKEN=tok123456\nPORT=4000\n');
fs.writeFileSync(path.join(TMP, 'audit.ndjson'), `{"msg":"login ok"}\n{"msg":"curl https://root:${LOG_PW}@10.0.0.1/api"}\n{"detail":"password=${LOG_PW} used"}\n`);
const SRCDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-src-'));
fs.writeFileSync(path.join(SRCDIR, 'bad.js'), `const conn = { user: 'root', password: '${SRC_PW}' };\nconst ok = { password: '' };\nconst ph = { password: 'example-placeholder' };\n`);

const result = await runSecretScan({ fresh: true, sourceDirs: [SRCDIR] });
const raw = JSON.stringify(result);

test('마스킹 보증 — 응답 직렬화에 원문 비밀(설정/로그/소스/env 값)이 절대 없다', () => {
  for (const secret of [PLAIN_PW, LOG_PW, SRC_PW, 'env-secret-value', 'tok123456', 'HASH-노출금지-abc']) {
    assert.ok(!raw.includes(secret), `응답에 원문 노출: ${secret}`);
  }
});

test('설정 파일 확정 분류 — 평문/암호화/빈값 + passwordHash(users.json) 미탐지', () => {
  const vc = result.configFiles.find((f) => f.file === 'vcenters.json');
  assert.deepEqual({ plain: vc.plain, sealed: vc.sealed, empty: vc.empty }, { plain: 1, sealed: 1, empty: 1 });
  const plainItem = vc.items.find((i) => i.state === 'plain');
  assert.equal(plainItem.field, 'password');
  assert.equal(plainItem.len, PLAIN_PW.length, '위치·길이만 노출');
  // users.json 은 passwordHash 뿐(정확 일치 아님) → 비밀 필드 0 으로 목록에서 제외되거나 카운트 0
  const users = result.configFiles.find((f) => f.file === 'users.json');
  assert.ok(!users || (users.plain === 0 && users.sealed === 0), 'passwordHash 는 대상 아님');
  assert.equal(result.summary.configPlain, 1);
  assert.equal(result.summary.configSealed, 1);
});

test('portal.env — 민감 키 이름·길이만(값 없음), PORT 같은 일반 키 제외', () => {
  assert.ok(result.env, 'env 결과 존재');
  const keys = result.env.keys.map((k) => k.key).sort();
  assert.deepEqual(keys, ['AUTH_SECRET', 'CENTRAL_TOKEN']);
  assert.equal(result.summary.envKeys, 2);
});

test('로그 패턴 — password=/URL 자격증명 탐지 + 프리뷰 마스킹(***)', () => {
  const log = result.logs.find((f) => f.file === 'audit.ndjson');
  assert.ok(log && log.hits.length >= 2, `password=·url-cred 둘 다 탐지되어야 함(실제 ${log?.hits?.length})`);
  for (const h of log.hits) assert.ok(h.preview.includes('***'), '프리뷰는 마스킹 포함');
  const patterns = log.hits.map((h) => h.pattern).sort();
  assert.ok(patterns.includes('password=') && patterns.includes('url-cred'));
});

test('소스 휴리스틱 — 하드코딩 리터럴 탐지, 빈값/플레이스홀더 제외', () => {
  assert.equal(result.source.hits.length, 1, '실제 하드코딩 1건만(빈값·example 제외)');
  const h = result.source.hits[0];
  assert.ok(h.file.endsWith('bad.js'));
  assert.equal(h.line, 1);
  assert.ok(h.preview.includes('***'));
});

test('30초 캐시 + fresh 재스캔 — 같은 객체 반환 후 fresh 로 갱신', async () => {
  const cached = await runSecretScan({ sourceDirs: [SRCDIR] });
  assert.equal(cached.generatedAt, result.generatedAt, '캐시 반환');
  const fresh = await runSecretScan({ fresh: true, sourceDirs: [SRCDIR] });
  assert.ok(fresh.generatedAt >= result.generatedAt, 'fresh 는 재스캔');
});
