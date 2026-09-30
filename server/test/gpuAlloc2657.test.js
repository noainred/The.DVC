// v2.657 — GPU 할당률 분모(명목 용량) · 배너의 '무엇을 못 읽었나' 집계.
// 사용자 캡처: A40 1장(vCenter 보고 45GB)에 24Q×2 가 '48 GB / 45 GB (107%)' 호박색 '초과' 로 보였다 —
// vGPU 프로파일은 명목 단위(24Q = 24GB)라 카드 최대 구성이다. 분모를 모델 명목 용량(48GB)으로 바꿨다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHostGpu } from '../src/gpu/hostGpu.js';
import { inferGpuMemGB } from '../src/gpu/gpuModelMem.js';
import { missingZero, addMissing } from '../src/routes/api/hardwareGpu.js';

const vm = (id, profile) => ({ id, name: id, powerState: 'POWERED_ON', gpu: { type: 'vgpu', profile, count: 1, vgpu: 1 } });

test('① A40 vGPU(보고 45GB) 24Q×2 = 48/48 → 100%, 보고 용량은 그대로 capacityGB', () => {
  const host = { gpus: [{ model: 'NVIDIA A40', memGB: 45, mode: 'vgpu' }] };
  const s = summarizeHostGpu(host, [vm('a', 'grid_a40-24q'), vm('b', 'grid_a40-24q')], new Map());
  assert.equal(s.allocGB, 48); assert.equal(s.capacityGB, 45);
  assert.equal(s.allocCapacityGB, 48); assert.equal(s.allocCapacityBasis, 'nominal');
  assert.equal(s.allocPct, 100);
});

test('② A40 ×2(90GB 보고) 24Q×4 → 96/96 = 100%, 24Q×2 → 50%', () => {
  const host = { gpus: [{ model: 'NVIDIA A40', memGB: 45, mode: 'vgpu' }, { model: 'NVIDIA A40', memGB: 45, mode: 'vgpu' }] };
  assert.equal(summarizeHostGpu(host, ['a', 'b', 'c', 'd'].map((x) => vm(x, 'grid_a40-24q')), new Map()).allocPct, 100);
  assert.equal(summarizeHostGpu(host, ['a', 'b'].map((x) => vm(x, 'grid_a40-24q')), new Map()).allocPct, 50);
});

test('③ 모델을 모르면 보고 용량이 분모(명목을 지어내지 않는다)', () => {
  const host = { gpus: [{ model: 'Unknown GPU', memGB: 16, mode: 'vgpu' }] };
  const s = summarizeHostGpu(host, [vm('a', 'grid_x-8q')], new Map());
  assert.equal(s.allocCapacityGB, 16); assert.equal(s.allocCapacityBasis, 'reported'); assert.equal(s.allocPct, 50);
  assert.equal(inferGpuMemGB('Unknown GPU'), 0);
});

test('④ 배너 missing — 사용률·메모리 사용·온도·할당·전부를 호스트 대수로', () => {
  const m = missingZero();
  addMissing(m, { utilPct: null, memUsedMB: null, memUsedPct: null, tempC: null, allocUnknown: 0 });
  addMissing(m, { utilPct: 40, memUsedMB: null, memUsedPct: null, tempC: 55, allocUnknown: 1 });
  assert.deepEqual(m, { util: 1, mem: 2, temp: 1, alloc: 1, all: 1 });
});
