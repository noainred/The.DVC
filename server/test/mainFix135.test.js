/**
 * 135회차 결정 D-d(메인 구현 — 권장안): 자격증명 암호화 키를 쓸 수 없는 상태를 서비스 점검 한 행으로 보인다.
 *
 * 예전: `security/secretVault.js secretsKeyMissing()` 을 읽는 곳이 0곳이었다 — 키를 못 쓰는 동안 비밀 저장이 거절되고 저장된 자격증명이 빈 값으로 열리는데
 *   (134회차부터는 기동 순간의 읽기 오류 한 번으로도 재시작까지) 콘솔 경고 한 줄이 유일한 단서였다(CLAUDE.md '무음 실패 금지').
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

process.env.CONFIG_DIR = tmpDir('mainfix135-');
process.env.DATA_SOURCE = 'mock';

const here = path.dirname(fileURLToPath(import.meta.url));
const { secretsKeyRow, getServiceCheck } = await import('../src/health/services.js');

test('secretsKeyRow — 키를 쓸 수 있으면 정상, 쓸 수 없으면 주의 + 사유 + 영향 + 풀리는 길', () => {
  const ok = secretsKeyRow(null, 1000);
  assert.deepEqual({ status: ok.status, at: ok.at }, { status: 'ok', at: 1000 });
  const why = '자격증명 암호화 키를 쓸 수 없습니다(키 파일을 읽지 못함 EACCES) — 새 키를 만들지 않습니다(기존 암호문 보호). SECRETS_KEY env 또는 CONFIG_DIR/secrets-key 를 되돌리고 재시작하세요.';
  const bad = secretsKeyRow(why, 2000);
  assert.equal(bad.status, 'warn');
  assert.ok(bad.detail.startsWith(why), '사유는 secretVault 가 만든 문장 그대로');
  assert.match(bad.detail, /저장은 거절되고/);
  assert.match(bad.detail, /재시작해야 풀립니다/);
  assert.ok(!/`/.test(bad.detail), '문구에 백틱 없음');
  // 길이 상한(사유가 길어도 행이 폭주하지 않는다)
  assert.ok(secretsKeyRow('가'.repeat(5000), 1).detail.length < 700);
});

test('서비스 점검에 secrets-key 행이 있고(평소 정상) 판정은 secretsKeyMissing 하나다', () => {
  const r = getServiceCheck({ isAdmin: true });
  const row = (r.checks || []).find((c) => c.key === 'secrets-key');
  assert.ok(row, '행이 있다');
  assert.equal(row.label, '자격증명 암호화 키');
  assert.equal(row.status, 'ok');
  const src = fs.readFileSync(path.join(here, '../src/health/services.js'), 'utf8');
  assert.match(src, /wrap\('secrets-key', '자격증명 암호화 키', \(\) => secretsKeyRow\(\)\)/);
  assert.match(src, /export function secretsKeyRow\(why = secretsKeyMissing\(\)/);
});

test('사용 기록 집계 503 본문 계약(소스) — code 와 error 를 함께 싣고 읽기 오류 문구를 가른다', () => {
  const src = fs.readFileSync(path.join(here, '../src/routes/admin/usage.js'), 'utf8');
  assert.match(src, /error: 'settingsUnreadable', code: 'settingsUnreadable', reason/);
  assert.match(src, /le\?\.readError\s*\?\s*`사용 기록 설정\(usage-settings\.json\)을 읽지 못해 집계를 내지 않았습니다/);
});
