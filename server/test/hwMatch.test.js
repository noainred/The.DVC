import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hardwareDimMatch } from '../src/idrac/hwMatch.js';

const inv = {
  system: { model: 'PowerEdge R750' },
  cpu: { model: 'Intel(R) Xeon(R) Gold 6346 CPU @ 3.10GHz', count: 2 },
  memory: { totalGiB: 768 },
  gpus: [{ model: 'NVIDIA A40' }, { model: 'NVIDIA A40' }, { name: 'NVIDIA L40S' }],
};

test('model 매칭', () => {
  assert.equal(hardwareDimMatch(inv, 'model', 'PowerEdge R750').match, true);
  assert.equal(hardwareDimMatch(inv, 'model', 'PowerEdge R740').match, false);
});

test('cpu 매칭 — 집계 키(모델 ×count)와 동일 규칙', () => {
  assert.equal(hardwareDimMatch(inv, 'cpu', 'Intel(R) Xeon(R) Gold 6346 CPU @ 3.10GHz ×2').match, true);
  assert.equal(hardwareDimMatch(inv, 'cpu', 'Intel(R) Xeon(R) Gold 6346 CPU @ 3.10GHz').match, false); // count 없으면 불일치
});

test('memory 매칭 — "N GiB"', () => {
  assert.equal(hardwareDimMatch(inv, 'memory', '768 GiB').match, true);
  assert.equal(hardwareDimMatch(inv, 'memory', '512 GiB').match, false);
});

test('gpu 매칭 — 일치 카드 수 반환(model 또는 name)', () => {
  const a40 = hardwareDimMatch(inv, 'gpu', 'NVIDIA A40');
  assert.equal(a40.match, true);
  assert.equal(a40.gpuCount, 2);
  const l40 = hardwareDimMatch(inv, 'gpu', 'NVIDIA L40S');
  assert.equal(l40.match, true);
  assert.equal(l40.gpuCount, 1);
  assert.equal(hardwareDimMatch(inv, 'gpu', 'NVIDIA H100').match, false);
});

test('인벤토리 없거나 알 수 없는 dim은 미일치', () => {
  assert.equal(hardwareDimMatch(null, 'model', 'x').match, false);
  assert.equal(hardwareDimMatch(inv, 'nope', 'x').match, false);
});
