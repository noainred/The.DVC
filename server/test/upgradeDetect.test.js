import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 저장소 server/config를 오염시키지 않도록 import 전에 CONFIG_DIR을 임시 디렉터리로 고정.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-detect-'));
process.env.CONFIG_DIR = tmp;

let upg, config;
before(async () => {
  upg = await import('../src/routes/upgrade.js');
  ({ config } = await import('../src/config.js'));
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('설치 경로 자동 감지: 실행 중인 앱 루트를 근거와 함께 보고한다', () => {
  const r = upg.detectInstallState(config.appRoot);
  assert.equal(r.installDir, path.resolve(config.appRoot));
  assert.ok(r.version, 'package.json에서 버전을 읽는다');
  assert.deepEqual(r.checks.map((c) => c.key), ['package', 'layout', 'writable', 'policy']);
  // 환경 독립 점검 — 앱 루트에서는 항상 통과해야 한다.
  assert.equal(r.checks.find((c) => c.key === 'package').ok, true);
  assert.equal(r.checks.find((c) => c.key === 'layout').ok, true);
  assert.equal(r.checks.find((c) => c.key === 'policy').ok, true);
  // writable은 실행 환경(부모 디렉터리 권한)에 따라 다르므로 값이 아니라 일관성만 단정.
  assert.equal(r.ok, r.checks.every((c) => c.ok));
});

test('설치 경로 자동 감지: 앱 루트가 아닌 디렉터리는 근거와 함께 미통과로 보고한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-app-'));
  try {
    const r = upg.detectInstallState(dir);
    assert.equal(r.ok, false);
    assert.equal(r.version, null);
    assert.equal(r.checks.find((c) => c.key === 'package').ok, false, 'package.json 부재를 보고');
    assert.equal(r.checks.find((c) => c.key === 'layout').ok, false, 'server/src 부재를 보고');
    // os.tmpdir() 하위: 부모 쓰기 가능 + 경로 정책(허용 베이스) 통과 — 실패 사유가 섞이지 않는다.
    assert.equal(r.checks.find((c) => c.key === 'writable').ok, true);
    assert.equal(r.checks.find((c) => c.key === 'policy').ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
