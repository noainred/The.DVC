import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relfile-'));
process.env.CONFIG_DIR = tmp;

let mod, currentVersion;
before(async () => {
  mod = await import('../src/util/releaseFile.js');
  ({ currentVersion } = await import('../src/config.js'));
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('writeReleaseFile: CONFIG_DIR에 버전 릴리스 파일 기록(redhat-release 방식)', () => {
  const p = mod.writeReleaseFile(new Date('2026-07-14T00:00:00Z'));
  assert.ok(p, '파일 경로 반환');
  assert.equal(path.basename(p), 'vmware-portal-release');
  const txt = fs.readFileSync(p, 'utf8');
  const v = currentVersion();
  // 첫 줄: 사람이 읽는 한 줄(제품명 + release + 버전 + 역할)
  assert.match(txt.split('\n')[0], /^VMware Global Monitoring Portal release .+ \(.+\)$/);
  // 파싱용 메타 라인
  assert.ok(txt.includes(`VERSION=${v}`), 'VERSION 명시');
  assert.ok(/ROLE=(central|edge|central\+edge|standalone)/.test(txt), 'ROLE 명시');
  assert.ok(txt.includes('WRITTEN_AT=2026-07-14T00:00:00.000Z'), '기록 시각');
  // 0644(외부에서 읽어도 무방)
  const mode = fs.statSync(p).mode & 0o777;
  assert.equal(mode, 0o644);
});
