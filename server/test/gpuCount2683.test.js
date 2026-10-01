/**
 * v2.683 — Overview 'GPU 카드' 와 서버 분석 › GPU 찾기의 GPU 수량이 달랐다(사용자 신고 455 vs 463).
 * 사용자 결정 "iDRAC 에 등록된 카드만 GPU 카드 수량으로 카운트" → 두 화면이 idrac/gpuCount.js 하나를 쓴다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';
import { idracGpuCounts, INVENTORY_STALE_MS, gpuCountable } from '../src/idrac/gpuCount.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => stripComments(fs.readFileSync(path.join(here, '..', 'src', p), 'utf8'));
const H = 3_600_000;

test('① 합계 = 활성·비-OME 서버의 iDRAC 인벤토리 GPU 전부(오래된·모델 미상 포함, 따로 셈)', () => {
  const now = 1_800_000_000_000;
  const inv = {
    a: { collectedAt: now - H, gpus: [{ model: 'A40' }, { model: 'A40' }] },
    b: { collectedAt: now - INVENTORY_STALE_MS - H, gpus: [{ model: 'T4' }] },
    c: { collectedAt: now - H, gpus: [{ model: '' }, null, 'x'] },
    d: { collectedAt: now - H, gpus: [{ model: 'H100' }] },
    o: { collectedAt: now - H, gpus: [{ model: 'L4' }] },
  };
  const servers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd', enabled: false }, { id: 'e' }, { id: 'o', type: 'ome' }];
  const seen = [];
  const r = idracGpuCounts(servers, (s) => inv[s.id] || null, now, (s, i, g, stale) => seen.push([s.id, g.length, stale]));
  assert.equal(r.gpus, 4);
  assert.equal(r.gpusStale, 1);
  assert.equal(r.gpusUnnamed, 1);
  assert.equal(r.count, 4);
  assert.equal(r.disabled, 1);
  assert.equal(r.ome, 1);
  assert.equal(r.invRead, 2);
  assert.equal(r.invStale, 1);
  assert.equal(r.invMissing, 1);
  assert.deepEqual(seen, [['a', 2, false], ['b', 1, true], ['c', 1, false]]);
  assert.equal(gpuCountable({ type: 'ome' }), false);
  assert.equal(gpuCountable({ enabled: false }), false);
});

test('② 두 화면이 같은 함수를 쓰고, GPU 찾기는 SSH 물리 서버 GPU 를 합계·모델 집계에 넣지 않는다', () => {
  const card = src('routes/api/overviewCards.js');
  assert.match(card, /idracGpuCounts\(/);
  const finder = src('routes/admin/idracCore.js');
  const route = finder.slice(finder.indexOf("'/idrac/gpu-inventory'"), finder.indexOf("'/idrac/parts-inventory'") > 0 ? finder.indexOf("'/idrac/parts-inventory'") : undefined);
  assert.match(route, /idracGpuCounts\(/);
  assert.match(route, /totalGpus: counts\.gpus/);
  const phys = route.slice(route.indexOf('for (const s of physServers)'));
  const loop = phys.slice(0, phys.indexOf('\n  }\n'));
  assert.doesNotMatch(loop, /byModel/, '물리 서버 GPU 를 모델 집계에 더하지 않는다');
  assert.match(route, /physicalGpus: physGpus/);
});
