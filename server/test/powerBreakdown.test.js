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

test('전력분석: 명시 지정 vcenterId가 이름/태그 매칭보다 우선', () => {
  const measured = [
    // 이름은 esxi-a(vc1)와 일치하지만, 명시 지정 vc2가 우선되어야 함
    { serverName: 'esxi-a', host: 'esxi-a', hostNames: ['esxi-a'], vcenterId: 'vc2', watts: 200, model: 'R640' },
    // ESXi 호스트가 아니지만 명시 지정으로 vc1에 귀속
    { serverName: 'MINWINPC', host: 'minwinpc', hostNames: ['minwinpc'], vcenterId: 'vc1', watts: 300 },
    // 존재하지 않는 vCenter 지정 → 무시하고 매칭 폴백(여기선 미매핑)
    { serverName: 'ghost', host: 'ghost', vcenterId: 'vcX', watts: 50 },
  ];
  const r = computePowerBreakdown(snap, measured);
  assert.equal(r.byVcenter.find((x) => x.vcId === 'vc2').watts, 200);
  assert.equal(r.byVcenter.find((x) => x.vcId === 'vc1').watts, 300);
  assert.ok(r.byVcenter.find((x) => x.vcId === '(미매핑)').watts === 50);
  assert.equal(r.mappedServers, 2);
});

test('전력분석: DataCenter 2단 분류(1차 DC → 2차 vCenter/Baremetal)', () => {
  // vc1은 DataCenter corpA에 할당. 미매핑 서버는 datacenterId/원격라벨로 corpA 베어메탈로 귀속.
  const measured = [
    { serverName: 'esxi-a', host: 'esxi-a', hostNames: ['esxi-a'], watts: 400 }, // vc1(→corpA) 매핑
    { serverName: 'bm1', host: 'bm1', hostNames: ['bm1'], watts: 300, datacenterId: 'corpA' }, // 명시 datacenterId → corpA baremetal
    { serverName: 'bm2', host: 'bm2', hostNames: ['bm2'], watts: 200, source: 'remote', datacenterLabel: 'CorpA', collectorId: 'corpa-agent' }, // 원격 라벨 → corpA baremetal
    { serverName: 'orphan', host: 'orphan', watts: 50 }, // 법인 미지정
  ];
  const r = computePowerBreakdown(snap, measured, {
    assign: { vc1: 'corpA' },
    datacenters: [{ id: 'corpA', name: '법인 A' }],
  });
  const corpA = r.byDatacenter.find((d) => d.datacenterId === 'corpA');
  assert.ok(corpA, 'corpA DataCenter 그룹 존재');
  assert.equal(corpA.datacenterName, '법인 A');
  assert.equal(corpA.servers, 3);
  assert.equal(corpA.watts, 900); // 400 + 300 + 200
  const vcChild = corpA.children.find((c) => c.type === 'vcenter');
  const bmChild = corpA.children.find((c) => c.type === 'baremetal');
  assert.equal(vcChild.vcenterId, 'vc1');
  assert.equal(vcChild.watts, 400);
  assert.equal(bmChild.name, 'Baremetal');
  assert.equal(bmChild.watts, 500); // 300 + 200 (명시 + 원격라벨 모두 baremetal)
  assert.equal(bmChild.servers, 2);
  // 법인 미지정은 별도 그룹(datacenterId 빈값), 맨 뒤로 정렬.
  const nodc = r.byDatacenter.find((d) => !d.datacenterId);
  assert.ok(nodc && nodc.watts === 50);
  assert.equal(r.byDatacenter[r.byDatacenter.length - 1].datacenterId, '', '미지정 법인이 맨 뒤');
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
