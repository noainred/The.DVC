import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNvidiaSmiCsv } from '../src/gpu/guestops.js';

test('parseNvidiaSmiCsv: 단일 GPU 파싱', () => {
  const r = parseNvidiaSmiCsv('75, 40, 8192, 16384, Disabled');
  assert.equal(r.count, 1);
  assert.equal(r.utilPct, 75);
  assert.equal(r.gpus[0].memUsedMB, 8192);
  assert.equal(r.gpus[0].memTotalMB, 16384);
  assert.equal(r.memUsedPct, 50);
  assert.equal(r.gpus[0].mig, 'disabled');
});

test('parseNvidiaSmiCsv: 다중 GPU 평균 + MIG 카운트', () => {
  const r = parseNvidiaSmiCsv('80, 50, 4096, 8192, Enabled\n40, 10, 1024, 8192, Disabled');
  assert.equal(r.count, 2);
  assert.equal(r.utilPct, 60);            // (80+40)/2
  assert.equal(r.migEnabled, 1);
});

test('parseNvidiaSmiCsv: 헤더/빈 줄/비숫자 라인 무시', () => {
  const r = parseNvidiaSmiCsv('utilization.gpu, memory\n\n90, 30, 2048, 4096');
  assert.equal(r.count, 1);
  assert.equal(r.utilPct, 90);
});

test('parseNvidiaSmiCsv: 빈 입력 → null', () => {
  assert.equal(parseNvidiaSmiCsv(''), null);
  assert.equal(parseNvidiaSmiCsv('   '), null);
  assert.equal(parseNvidiaSmiCsv('not,a,number'), null);
});
