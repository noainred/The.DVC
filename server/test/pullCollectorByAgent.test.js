import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

process.env.CONFIG_DIR = tmpDir('pullagent-');

let addCollector, pullCollectorByAgent;
before(async () => {
  ({ addCollector } = await import('../src/collector/registry.js'));
  ({ pullCollectorByAgent } = await import('../src/collector/puller.js'));
});

test('pullCollectorByAgent: 매칭 수집 서버 없거나 빈 이름이면 false(당김 시도 없음)', async () => {
  assert.equal(await pullCollectorByAgent(''), false, '빈 이름 → false');
  assert.equal(await pullCollectorByAgent('no-such-agent'), false, '미등록 이름 → false');
});

test('pullCollectorByAgent: 매칭되지만 URL 없으면 false', async () => {
  addCollector({ id: 'nourl', name: 'nourl', url: '', token: 't', enabled: true });
  assert.equal(await pullCollectorByAgent('NoUrl'), false, 'URL 없는 수집 서버 → 당김 대상 아님');
});
