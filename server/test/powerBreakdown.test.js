import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrk-'));
const { computePowerBreakdown } = await import('../src/insights/powerBreakdown.js');

const snap = {
  vcenters: [{ id: 'vc1', location: { region: 'KR' } }, { id: 'vc2', location: { region: 'EU' } }],
  hosts: [
    { name: 'esxi-a', vcenterId: 'vc1', model: 'PowerEdge R740', serviceTag: 'ABC1234' },
    { name: 'esxi-b', vcenterId: 'vc2', model: 'PowerEdge R750', serviceTag: 'XYZ9999' },
  ],
};

test('전력분석: 이름 매핑 + 서비스태그 매핑 + 미매핑을 모두 집계', () => {
  const measured = [
    { serverName: 'esxi-a', host: 'esxi-a', hostNames: ['esxi-a'], watts: 400, model: 'PowerEdge R740' }, // 이름 일치
    { serverName: 'srv-b', host: 'srv-b', hostNames: ['srv-b'], serviceTag: 'XYZ9999', watts: 600, model: 'PowerEdge R750' }, // 서비스태그 일치
    { serverName: 'LESASBPDPS93', host: 'lesasbpdps93', hostNames: ['lesasbpdps93'], watts: 500, model: 'PowerEdge R640' }, // 미매핑
  ];
  const r = computePowerBreakdown(snap, measured);
  assert.equal(r.totalServers, 3);
  assert.equal(r.mappedServers, 2);
  assert.equal(r.unmappedServers, 1);
  assert.equal(r.totals.watts, 1500);
  assert.equal(r.unmappedWatts, 500);

  const vc1 = r.byVcenter.find((x) => x.vcId === 'vc1');
  const vc2 = r.byVcenter.find((x) => x.vcId === 'vc2');
  assert.equal(vc1.watts, 400);
  assert.equal(vc2.watts, 600); // 서비스태그로 vc2에 귀속
  assert.ok(r.byVcenter.find((x) => x.vcId === '(미매핑)').watts === 500);
});

test('전력분석: 모델별 집계(ESXi 매핑 없이도 모델 그룹)', () => {
  const measured = [
    { serverName: 's1', host: 'x1', watts: 300, model: 'PowerEdge R640' },
    { serverName: 's2', host: 'x2', watts: 350, model: 'PowerEdge R640' },
    { serverName: 's3', host: 'x3', watts: 700, model: 'PowerEdge R750' },
    { serverName: 's4', host: 'x4', watts: 100 }, // 모델 미상
  ];
  const r = computePowerBreakdown(snap, measured);
  const r640 = r.byModel.find((x) => x.model === 'PowerEdge R640');
  assert.equal(r640.servers, 2);
  assert.equal(r640.watts, 650);
  assert.ok(r.byModel.find((x) => x.model === '(모델 미상)').watts === 100);
});

test('전력분석: vcenterId 범위 지정 시 해당 법인만', () => {
  const measured = [
    { serverName: 'esxi-a', host: 'esxi-a', hostNames: ['esxi-a'], watts: 400 },
    { serverName: 'srv-b', host: 'srv-b', serviceTag: 'XYZ9999', watts: 600 },
  ];
  const r = computePowerBreakdown(snap, measured, { vcenterId: 'vc1' });
  assert.equal(r.totalServers, 1);
  assert.equal(r.totals.watts, 400);
});
