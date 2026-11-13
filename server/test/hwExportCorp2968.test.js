// v2.968 서버 하드웨어 정보 내보내기 — 법인 = 법인(DataCenter). 사용자 신고(2026-11-11): 서버 분석 › 상태 보드는 베어메탈이 법인으로 나뉘는데
//   내보내기 창의 법인 칩은 전부 0대(미지정)였다 — v2.967 이 법인을 vCenter id 로 나눴기 때문(물리 전용 서버는 vCenter 가 없다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildDcIndex, makeCorpOf, VC_PREFIX } from '../src/insights/hwExport/corp.js';
import { selectServers, buildHwModel, makeInvOf, UNASSIGNED } from '../src/insights/hwExport/rows.js';
import { BASIC_KEYS, HW_FIELDS } from '../src/insights/hwExport/catalog.js';
import { hwCorpRoster } from '../src/routes/insights.js';
import { serverInScope } from '../src/insights/analysisScope.js';
import { stripComments } from './_stripComments.js';

// 현장 모양: 법인 AZ 에 vCenter 둘(AZ · AZ-IRS), 법인 OC2 에 vCenter 하나. vc-lab 은 법인 할당 없음.
const ASSIGN = { 'vc-az': 'AZ', 'vc-az-irs': 'AZ', 'vc-oc2': 'OC2' };
const dcOfVc = (vc) => ASSIGN[vc] || '';
const DC_NAME = { AZ: 'AZ', OC2: 'OC2 본사' };
// 서버 분석 목록(analysisServersWithRemote 모양 — datacenterId · mappedVcenterId 가 채워져 있다)
const analysis = [
  { id: 'r1', serviceTag: 'BM1', datacenterId: 'OC2' },                              // 스캔 등록 물리 — 법인 직접
  { id: 'r2', serviceTag: 'BM2', datacenterId: '', vcenterId: '', mappedVcenterId: '' }, // 법인을 모른다
  { id: 'r3', serviceTag: 'BM3', mappedVcenterId: 'vc-az-irs' },                      // 서비스태그로 찾은 vCenter → 법인
  { id: 'e9', remote: true, collectorId: 'pl', serviceTag: 'RM1', datacenterId: 'AZ' },
  { id: 'd1', serviceTag: 'DUP', datacenterId: 'AZ' }, { id: 'd2', serviceTag: 'dup', datacenterId: 'OC2' },
];
const index = buildDcIndex(analysis, dcOfVc);
const idName = (c) => ({ id: c.id, name: c.name });   // v2.969 부터 판정 출처(src)도 싣는다 — 여기서는 법인만 본다
const corpOf = makeCorpOf({ index, dcOfVc, dcName: (id) => DC_NAME[id] || '', vcName: (id) => ({ 'vc-lab': 'vcenter-lab' }[id] || ''), agentDc: (a) => (a === 'edge-oc2' ? 'OC2' : '') });

test('색인 — 서버 분석의 dcOf(datacenterId || assign[vCenter]) 와 같은 값 · 원격은 remote:<수집>:<id> · 겹치는 태그는 뺀다', () => {
  assert.equal(index.byId.get('r1'), 'OC2');
  assert.equal(index.byId.get('r3'), 'AZ');
  assert.equal(index.byId.has('r2'), false);
  assert.equal(index.byId.get('remote:pl:e9'), 'AZ');
  assert.equal(index.byTag.get('bm1'), 'OC2');
  assert.equal(index.byTag.has('dup'), false, '같은 태그가 두 법인이면 태그로는 정하지 않는다');
  assert.equal(index.conflicts, 1);
  // 서버 분석의 법인 필터(serverInScope)와 대조 — 같은 서버가 같은 법인에 든다
  for (const s of analysis.filter((x) => !x.remote && x.serviceTag.toLowerCase() !== 'dup')) {
    const dc = index.byId.get(s.id) || '';
    assert.equal(serverInScope(s, { datacenterId: dc || '__unmapped__' }, ASSIGN), true, `${s.id} → ${dc || '미지정'}`);
  }
});

test('행 → 법인 — 물리: 색인(id → 태그) → 행 vCenter 의 법인 → 엣지 에이전트의 법인 · 가상화: vCenter 의 법인 · 할당 없는 vCenter 는 따로 · 없으면 미지정', () => {
  assert.deepEqual(idName(corpOf({ serverId: 'r1', serviceTag: 'BM1', vcenterId: '' }, 'bm')), { id: 'OC2', name: 'OC2 본사' }, 'vCenter 가 없는 물리 전용 서버도 법인으로');
  assert.deepEqual(idName(corpOf({ serverId: 'zzz', serviceTag: 'bm3' }, 'bm')), { id: 'AZ', name: 'AZ' }, '태그는 대소문자 무시');
  assert.equal(corpOf({ serverId: 'remote:pl:e9', serviceTag: '' }, 'bm').id, 'AZ');
  assert.equal(corpOf({ serverId: 'x', serviceTag: 'NOPE', vcenterId: 'vc-oc2' }, 'bm').id, 'OC2', '색인에 없으면 행의 vCenter 로');
  assert.equal(corpOf({ serverId: 'edge:edge-oc2:Q', source: 'edge', serviceTag: 'Q', remoteAgent: 'edge-oc2' }, 'bm').id, 'OC2');
  assert.equal(corpOf({ serverId: 'edge:edge-oc2:r1', source: 'edge', serviceTag: '', remoteAgent: 'nope' }, 'bm').id, '', '엣지 보고 행의 id 는 색인 id 와 다른 것이다');
  assert.deepEqual(idName(corpOf({ name: 'esx1', vcenterId: 'vc-az' }, 'vh')), { id: 'AZ', name: 'AZ' });
  assert.deepEqual(idName(corpOf({ name: 'esx2', vcenterId: 'vc-az-irs' }, 'vh')), { id: 'AZ', name: 'AZ' }, '같은 법인의 두 vCenter 는 한 법인');
  assert.deepEqual(idName(corpOf({ name: 'esx3', vcenterId: 'vc-lab', vcenter: 'x' }, 'vh')), { id: `${VC_PREFIX}vc-lab`, name: 'vcenter-lab' }, '법인 할당이 없는 vCenter 는 vCenter 이름으로 따로');
  assert.deepEqual(idName(corpOf({ serverId: 'r2', serviceTag: 'BM2' }, 'bm')), { id: '', name: '미지정' });
  assert.equal(corpOf({ name: 'esx', serviceTag: 'BM1', vcenterId: 'vc-az' }, 'vh').id, 'AZ', '가상화 호스트는 색인이 아니라 자기 vCenter 의 법인');
});

const fleet = {
  bareMetal: [
    { serverId: 'r1', name: 'bm-oc2-01', serviceTag: 'BM1', source: 'idrac', vcenterId: '', vcenter: '' },
    { serverId: 'r3', name: 'bm-az-01', serviceTag: 'BM3', source: 'idrac', vcenterId: '', vcenter: '' },
    { serverId: 'r2', name: 'bm-unknown', serviceTag: 'BM2', source: 'idrac', vcenterId: '', vcenter: '' },
  ],
  virtualizationHosts: [
    { name: 'esx-az-1', vcenterId: 'vc-az', vcenter: 'AZ', idracBacked: false },
    { name: 'esx-az-2', vcenterId: 'vc-az-irs', vcenter: 'AZ-IRS', idracBacked: false },
    { name: 'esx-lab', vcenterId: 'vc-lab', vcenter: 'vcenter-lab', idracBacked: false },
  ],
};
const invOf = makeInvOf({ getInventory: () => null });

test('법인 목록 — 서버가 있는 법인만 · 설정의 법인 순서 → 할당 없는 vCenter → 미지정 · 대수는 파일과 같은 판정', () => {
  const roster = hwCorpRoster(fleet, { corpOf, dcOrder: ['OC2', 'AZ', 'EMPTY'] });
  assert.deepEqual(roster.map((c) => [c.id, c.name, c.bm, c.vh]), [
    ['OC2', 'OC2 본사', 1, 0], ['AZ', 'AZ', 1, 2], [`${VC_PREFIX}vc-lab`, 'vcenter-lab', 0, 1], [UNASSIGNED, '미지정', 1, 0],
  ]);
  assert.equal(roster.reduce((a, c) => a + c.bm, 0), fleet.bareMetal.length, '물리 서버가 법인에 다 들어간다(예전에는 전부 미지정)');
});

test('대상 고르기 · 모델 — 법인 id 로 고르고, 띠 · 소계 · 법인 열이 법인(DataCenter) 기준 · vCenter 는 따로 고르는 값', async () => {
  const roster = hwCorpRoster(fleet, { corpOf, dcOrder: ['OC2', 'AZ'] });
  const corpRank = new Map(roster.map((c, i) => [c.id === UNASSIGNED ? '' : c.id, i]));
  const all = selectServers(fleet, { kind: 'both', invOf, corpOf, corpRank });
  assert.deepEqual(all.map((c) => [c.corpName, c.name]), [
    ['OC2 본사', 'bm-oc2-01'], ['AZ', 'bm-az-01'], ['AZ', 'esx-az-1'], ['AZ', 'esx-az-2'], ['vcenter-lab', 'esx-lab'], ['미지정', 'bm-unknown'],
  ], '설정의 법인 순서 · 미지정은 맨 뒤');
  assert.deepEqual(selectServers(fleet, { kind: 'bm', corps: new Set(['AZ']), invOf, corpOf }).map((c) => c.name), ['bm-az-01']);
  assert.deepEqual(selectServers(fleet, { kind: 'both', corps: new Set([UNASSIGNED]), invOf, corpOf }).map((c) => c.name), ['bm-unknown']);
  assert.deepEqual(selectServers(fleet, { kind: 'vh', corps: new Set([`${VC_PREFIX}vc-lab`]), invOf, corpOf }).map((c) => c.name), ['esx-lab']);
  const m = await buildHwModel(all, BASIC_KEYS.concat(['id.sum.vcenter']), { admin: true });
  assert.deepEqual(m.corps.map((c) => [c.id, c.count, c.bm, c.vh]), [['OC2', 1, 1, 0], ['AZ', 3, 1, 2], [`${VC_PREFIX}vc-lab`, 1, 0, 1], ['', 1, 1, 0]]);
  const ci = m.summary.cols.findIndex((c) => c.key === 'id.sum.corp'); const vi = m.summary.cols.findIndex((c) => c.key === 'id.sum.vcenter');
  assert.equal(m.summary.cols[ci].label, '법인');
  const esx2 = m.summary.rows.find((r) => r.cells.includes('esx-az-2'));
  assert.deepEqual([esx2.cells[ci], esx2.cells[vi]], ['AZ', 'AZ-IRS'], '법인 칸은 법인, vCenter 칸은 vCenter');
  assert.equal(HW_FIELDS.get('id.sum.vcenter').basic, undefined, 'vCenter 열은 기본 묶음이 아니다(물리 서버만 받으면 거의 빈 열)');
});

test('라우트 — 메타 · 내려받기가 같은 법인 판정(hwCorpContext)을 쓰고, 색인은 서버 분석 목록에서 만든다', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/routes/insights.js', import.meta.url), 'utf8'));
  assert.equal((src.match(/hwCorpRoster\(fleet, cc\)/g) || []).length, 2, '메타 · 내려받기 둘 다');
  assert.match(src, /buildDcIndex\(analysisServersWithRemote\(null\), dcOfVc\)/);
  assert.match(src, /corpOf: cc\.corpOf, corpRank/);
  assert.doesNotMatch(src, /hwCorpRoster\(snap/, 'vCenter 목록으로 법인 칩을 만들지 않는다');
});
