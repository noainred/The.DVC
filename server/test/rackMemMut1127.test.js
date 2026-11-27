// [7회차 변이 축] 메모리 보관(잘린 문자열이 원문을 붙드는가) · 태그 상한 뒤 over 값의 색인.
//   [d12] maskAbsorb 의 ownStr · [x01] remoteStr 의 새 글 복사 · [m17] 색인에 over 태그.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackMemMut-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const RI = await import(`${S}/collector/remoteInventory.js`);
const R = await import(`${S}/rack/db.js`);
const M = await import(`${S}/rack/material.js`);
after(() => R._closeForTest());
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
const MB = 1 << 20;
// 원문 1MB × 60개에서 200자씩 잘라 낸 조각(SlicedString — 원문을 붙든다)
const parents = (tag) => Array.from({ length: 60 }, (_, i) => `${tag}-${i}-`.padEnd(MB, 'x'));

test('[x01] remoteStr 이 자른 글은 원문을 붙들지 않는다(엣지가 보낸 큰 글)', () => {
  const h0 = heap();
  let ps = parents('rs');
  const kept = ps.map((p) => RI.remoteStr(p, 200));
  ps = null;
  const grown = (heap() - h0) / MB;
  assert.equal(kept.length, 60); assert.equal(kept[0].length, 200);
  assert.ok(grown < 20, `잘린 글 60개가 ${grown.toFixed(1)}MB 를 붙들고 있다`);
});

test('[d12] 가림 재료 기록은 넘겨받은 조각을 새 글로 보관한다(원문을 붙들지 않는다)', async () => {
  await R.openRackDb(); await R.maskState();
  const h0 = heap();
  let ps = parents('ma');
  let cut = ps.map((p) => p.slice(0, 200));
  ps = null;
  await R.maskAbsorb(cut, []);
  cut = null;
  R._flushMaskForTest();
  const grown = (heap() - h0) / MB;
  assert.ok((await R.maskState()).hosts.has(`ma-0-${'x'.repeat(200 - 5)}`));
  assert.ok(grown < 20, `기록 60개가 ${grown.toFixed(1)}MB 를 붙들고 있다`);
});

test('[m17] 태그 기록이 상한(20만)에 닿은 뒤 들어온 태그(메모리에만)도 이 프로세스의 색인에 든다', async () => {
  const db = await R.openRackDb();
  db.exec('BEGIN');
  const ins = db.prepare("INSERT OR IGNORE INTO rack_mask_seen (kind, key, first_seen) VALUES ('t', ?, 1)");
  for (let i = 0; i < 200_000; i += 1) ins.run(`CAPT${String(i).padStart(6, '0')}`);
  db.exec('COMMIT');
  R._dropMaskMemoryForTest(); M._dropIndexForTest();
  const w = console.warn; console.warn = () => {};
  try { await R.maskAbsorb([], ['OVERCAP77']); } finally { console.warn = w; }
  const st = await R.maskState();
  assert.ok(st.tags.size >= 200_000 && st.overTags.has('OVERCAP77'), '전제: 상한 뒤 값은 over 에');
  const ix = await M.materialIndex();
  assert.ok(ix.fleetTagIdx.set.has('overcap77'), '색인에 over 태그가 없다');
});
