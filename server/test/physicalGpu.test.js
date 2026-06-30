import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpu-'));
const store = await import('../src/gpu/physicalStore.js');
const reg = await import('../src/gpu/physicalRegistry.js');

test('물리 GPU 저장소: set/get/prune', () => {
  store.setPhysicalGpu('a', { id: 'a', name: 'A', count: 2, utilPct: 30 });
  store.setPhysicalGpu('b', { id: 'b', name: 'B', count: 4, utilPct: 0 });
  assert.equal(store.getPhysicalGpu('a').count, 2);
  assert.equal(store.physicalGpuCounts().gpus, 6);
  store.prunePhysicalGpu(new Set(['a']));
  assert.equal(store.getPhysicalGpu('b'), null);
  assert.equal(store.physicalGpuCounts().servers, 1);
});

test('물리 GPU 등록부: 추가/수정/삭제 + 비번 redact', () => {
  const r = reg.addPhysical({ name: 'node1', host: '10.0.0.5', username: 'root', password: 'pw' });
  assert.ok(r.ok);
  const list = reg.listPhysical();
  assert.equal(list.length, 1);
  assert.equal(list[0].hasPassword, true);
  assert.ok(!('password' in list[0])); // 비번 미노출

  reg.updatePhysical(r.id, { name: 'node1-renamed', password: '' }); // 빈 비번 = 유지
  assert.equal(reg.getPhysicalRaw(r.id).name, 'node1-renamed');
  assert.equal(reg.getPhysicalRaw(r.id).password, 'pw');

  assert.ok(reg.removePhysical(r.id).ok);
  assert.equal(reg.listPhysical().length, 0);
});

test('물리 GPU 등록부: host/username 누락 거부', () => {
  assert.equal(reg.addPhysical({ host: '', username: 'x' }).ok, false);
  assert.equal(reg.addPhysical({ host: '1.2.3.4' }).ok, false);
});
