import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pullagent-'));

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
