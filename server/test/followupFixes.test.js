import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from '../src/util/atomicWrite.js';
import { snapMemo, snapCacheClear } from '../src/util/snapCache.js';

test('atomicWriteFileSync: 내용이 온전히 기록되고 임시파일이 남지 않음', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-'));
  const f = path.join(dir, 'x.json');
  atomicWriteFileSync(f, JSON.stringify({ a: 1 }), { mode: 0o600 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 1 });
  const leftovers = fs.readdirSync(dir).filter((n) => n.startsWith('.x.json.tmp'));
  assert.equal(leftovers.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('snapMemo: 오래된 key 계산 완료가 더 새로운 key의 in-flight 항목을 덮어쓰지 않음', async () => {
  snapCacheClear('t');
  let resolveOld;
  const oldP = snapMemo('t', 'k1', 60_000, () => new Promise((r) => { resolveOld = () => r('old'); }));
  // k2 계산이 시작되며 store에 k2 in-flight가 들어감
  const newP = snapMemo('t', 'k2', 60_000, async () => 'new');
  await newP;
  // 이제 오래된 k1 계산이 뒤늦게 끝남 → k2 항목을 덮어쓰면 안 됨
  resolveOld();
  await oldP;
  // 후속 k2 요청은 재계산 없이 캐시 히트여야 함
  let recomputed = false;
  const again = await snapMemo('t', 'k2', 60_000, async () => { recomputed = true; return 'new2'; });
  assert.equal(again, 'new');       // 캐시된 k2 값
  assert.equal(recomputed, false);  // 재계산되지 않음(single-flight 유지)
  snapCacheClear('t');
});
