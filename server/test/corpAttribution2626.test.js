// v2.626 — '법인별 서버 사용량' 물리 서버가 전부 '서버 없음' 이던 결함의 회귀.
//  ① 법인이 빈 베어메탈을 개요와 같은 귀속(serversByCorp — DataCenter 단일 vCenter 포함)으로 채운다
//  ② 엣지는 자기 로컬 등록 물리 서버를 수집 대상으로 삼는다(예전엔 전부 '위임됨' 으로 빠졌다)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildVcIndex, attributeBareMetal } from '../src/idrac/corpAttribution.js';
import { resolveTargets } from '../src/bmusage/targets.js';
import { stripComments } from './_stripComments.js';

const opts = {
  fleetAssign: {},
  dcVcenters: new Map([['dc-one', ['vc1']], ['dc-two', ['vc2', 'vc3']]]),
  knownVcenters: new Set(['vc1', 'vc2', 'vc3']),
};
const SERVERS = [
  { id: 's1', serviceTag: 'AAA1', datacenterId: 'DC-ONE' },           // ⑤ DataCenter 단일 → vc1
  { id: 's2', serviceTag: 'BBB2', datacenterId: 'dc-two' },           // vCenter 2개 → 추측 안 함
  { id: 's3', serviceTag: 'CCC3', vcenterId: 'vc3' },                  // 명시
  { id: 's4', serviceTag: 'DDD4' },                                    // 근거 없음
];

test('① 색인 — DataCenter 에 vCenter 가 하나면 귀속, 둘 이상이면 추측하지 않는다', () => {
  const ix = buildVcIndex(SERVERS, [], opts);
  assert.equal(ix.byId.get('s1'), 'vc1');
  assert.equal(ix.byTag.get('aaa1'), 'vc1');
  assert.equal(ix.byId.get('s2'), undefined);
  assert.equal(ix.byId.get('s3'), 'vc3');
  assert.equal(ix.byId.get('s4'), undefined);
});

test('① 채우기 — 빈 법인만 채우고, 있는 귀속은 바꾸지 않는다 · 엣지 보고는 서비스태그로만', () => {
  const ix = buildVcIndex(SERVERS, [], opts);
  const { bareMetal, filled } = attributeBareMetal([
    { serverId: 's1', serviceTag: 'AAA1', vcenterId: '' },
    { serverId: 's3', serviceTag: 'CCC3', vcenterId: 'vc2' },            // 기존 귀속 유지
    { serverId: 's1', serviceTag: 'ZZZ9', vcenterId: '', source: 'edge' }, // 엣지 id 는 맞추지 않는다
    { serverId: 'edge:x', serviceTag: 'aaa1', vcenterId: '', source: 'edge' },
    { serverId: 's4', serviceTag: 'DDD4', vcenterId: '' },
  ], ix, new Map([['vc1', 'Seoul']]));
  assert.equal(filled, 2);
  assert.equal(bareMetal[0].vcenterId, 'vc1');
  assert.equal(bareMetal[0].vcenter, 'Seoul');
  assert.equal(bareMetal[0].vcSource, 'corp-rule');
  assert.equal(bareMetal[1].vcenterId, 'vc2');
  assert.equal(bareMetal[2].vcenterId, '');
  assert.equal(bareMetal[3].vcenterId, 'vc1');
  assert.equal(bareMetal[4].vcenterId, '');
});

test('① 같은 서비스태그가 서로 다른 법인이면 그 태그는 색인에서 뺀다', () => {
  const ix = buildVcIndex([{ id: 'a', serviceTag: 'DUP', vcenterId: 'vc1' }, { id: 'b', serviceTag: 'DUP', vcenterId: 'vc2' }], [], opts);
  assert.equal(ix.byTag.get('dup'), undefined);
  assert.equal(ix.conflicts, 1);
});

test('② 엣지는 로컬 등록 물리 서버(remoteAgent 없음)를 수집하고, 남의 엣지 것은 가져가지 않는다', () => {
  const bareMetal = [
    { serverId: 'l1', name: 'local-1', serviceTag: 'L1', vcenterId: 'vc1' },
    { serverId: 'o1', name: 'other-1', serviceTag: 'O1', vcenterId: 'vc1', remoteAgent: 'OTHER' },
    { serverId: 'm1', name: 'mine-1', serviceTag: 'M1', vcenterId: 'vc1', remoteAgent: 'EDGE1' },
  ];
  const registry = bareMetal.map((b) => ({ id: b.serverId, host: `10.0.0.${b.serverId.length}`, username: 'root', password: 'x', serviceTag: b.serviceTag }));
  const s = { corps: { vc1: true }, idracTelemetry: true };
  const edge = resolveTargets({ bareMetal, registry, settings: s, isEdge: true, agentName: 'edge1' });
  assert.deepEqual(edge.targets.map((x) => x.name).sort(), ['local-1', 'mine-1']);
  assert.ok(edge.skipped.some((x) => x.reason === 'edge-delegated'));
  const central = resolveTargets({ bareMetal, registry, settings: s, isEdge: false, agentName: 'C' });
  assert.deepEqual(central.targets.map((x) => x.name), ['local-1']);
});

test('수집 대상과 법인별 사용량이 같은 귀속 함수를 쓴다(소스)', () => {
  for (const f of ['src/bmusage/poller.js', 'src/routes/api/corpUsage.js']) {
    assert.match(stripComments(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')), /attributeBareMetalFromSnap\(/, f);
  }
  const ov = stripComments(fs.readFileSync(new URL('../src/routes/api/overviewNsx.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(ov, /function (allPhysicalServers|corpAttribution)\(/, '개요도 공용 모듈을 쓴다(사본 금지)');
});
