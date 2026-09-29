// v2.651: 업그레이드 다운로드 실패 사유 — 404 는 '미러에 파일 없음' 을 말하고, 주소의 자격증명·쿼리는 싣지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'upg2651-'));
const { downloadFailReason, safeUrlText, downloadArchive } = await import('../src/upgrade/upgrade.js');

test('사유 문구: 접두 유지 · 404/401·403 구분 · 자격증명 제거', () => {
  const r = downloadFailReason(404, 'http://u:secret@repo.local:8081/raw/vmware-portal-2.650.0.tar.gz?token=abc');
  assert.match(r, /^download HTTP 404 — 패키지 파일이 없습니다/);
  assert.match(r, /repo\.local:8081\/raw\/vmware-portal-2\.650\.0\.tar\.gz/);
  assert.doesNotMatch(r, /secret|token=abc/);
  assert.match(downloadFailReason(403, 'http://x/a.tar.gz'), /거부/);
  assert.equal(downloadFailReason(500, 'http://x/a.tar.gz'), 'download HTTP 500 — http://x/a.tar.gz');
  assert.equal(safeUrlText('not a url?q=1'), 'not a url');
});

test('실제 다운로드 404 → 파일 없음 사유', async () => {
  const srv = http.createServer((_q, r) => { r.statusCode = 404; r.end('nope'); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/vmware-portal-2.650.0.tar.gz`;
    const r = await downloadArchive(url, fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), { sha256: 'x', timeout: 5000 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /패키지 파일이 없습니다/);
    assert.equal(r.status, 404);
  } finally { srv.close(); }
});
