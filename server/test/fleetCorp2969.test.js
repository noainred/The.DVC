// v2.969 통합 서버 인벤토리 — 법인(DataCenter) 기준(사용자 요청 2026-11-11). 사용자 결정 '서버 분석처럼 수집한 Agent 이름에 따라 분류 — Agent 자동 판정만':
//   수동 법인 지정은 두지 않는다(첫 판의 /fleet/dc-assign · fleetDcAssign.js 는 걷어냈다). 판정은 insights/hwExport/corp.js 하나(서버 분석 색인 재사용).
//   서버 분석의 상태 보드 · 법인별 서버 정보(/admin/idrac)도 Agent 스캔 대역 법인(scanDatacenterId)을 싣는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeCorpOf, buildDcIndex } from '../src/insights/hwExport/corp.js';
import { enrichFleetCorp, hwCorpRoster } from '../src/routes/insights.js';
import { stripComments } from './_stripComments.js';

const ASSIGN = { 'vc-az': 'AZ', 'vc-nj': 'NJ' };
const dcOfVc = (vc) => ASSIGN[vc] || '';
// 서버 분석 목록 모양: 엣지 서버는 수집 서버의 법인이 datacenterId 로 채워져 있다(remoteServersResolved) · 스캔 대역 Agent 법인도(withScanDatacenter)
const analysis = [
  { id: 'r1', serviceTag: 'T1', datacenterId: 'NJ', dcSource: 'scan-agent' },
  { id: 'e1', remote: true, collectorId: 'pl', serviceTag: 'E1', datacenterId: 'AZ' },
  { id: 'e2', remote: true, collectorId: 'zz-edge', serviceTag: 'E2', datacenterId: '' },   // 수집 서버 라벨이 DataCenter 와 맞지 않음
  { id: 'amb', serviceTag: 'AMB', dcSource: 'scan-ambiguous' },
  { id: 'out', serviceTag: 'OUT' },
];
const index = buildDcIndex(analysis, dcOfVc);
const corpOf = makeCorpOf({ index, dcOfVc, dcName: (id) => ({ AZ: 'AZ', NJ: 'NJ' }[id] || ''), vcName: () => '', agentDc: (a) => (a === 'edge-nj' ? 'NJ' : '') });

test('판정 — 수집한 Agent 의 법인(서버 분석 색인) → vCenter 할당 → 보고한 에이전트, 출처(src)를 싣는다 · 수동 지정은 없다', () => {
  assert.deepEqual(corpOf({ serverId: 'r1', serviceTag: 'T1', vcenterId: 'vc-az' }, 'bm'), { id: 'NJ', name: 'NJ', src: 'scan' }, 'Agent 스캔 법인이 vCenter 할당보다 먼저');
  assert.deepEqual(corpOf({ serverId: 'remote:pl:e1', serviceTag: 'E1' }, 'bm'), { id: 'AZ', name: 'AZ', src: 'scan' }, '엣지 서버는 그 수집 서버의 법인');
  assert.equal(corpOf({ serverId: 'x', serviceTag: 'Q', vcenterId: 'vc-az' }, 'bm').src, 'vcenter');
  assert.deepEqual(corpOf({ serverId: 'edge:edge-nj:Q', source: 'edge', serviceTag: 'Q', remoteAgent: 'edge-nj' }, 'bm'), { id: 'NJ', name: 'NJ', src: 'agent' });
  assert.equal(corpOf({ name: 'esx', vcenterId: 'vc-nj', tagKey: 't1', serviceTag: 'T1' }, 'vh').id, 'NJ', '가상화 호스트는 자기 vCenter 의 법인');
  const src = stripComments(fs.readFileSync(new URL('../src/insights/hwExport/corp.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /manual/, '수동 지정 판정이 남아 있지 않다');
  assert.equal(fs.existsSync(new URL('../src/insights/fleetDcAssign.js', import.meta.url)), false);
});

test('미지정 — 왜 모르는지(why)를 아는 사실로만: 수집 서버 법인 이름 불일치 · 대역 겹침 · 대역 밖 · 엣지 에이전트 · OME · 수동 물리 분류', () => {
  const why = (row, k = 'bm') => { const c = corpOf(row, k); assert.equal(c.id, ''); return c.why; };
  assert.match(why({ serverId: 'remote:zz-edge:e2', serviceTag: 'E2' }), /수집 서버 ‘zz-edge’ 의 법인 이름이 DataCenter 목록과 맞지 않습니다/);
  assert.match(why({ serverId: 'amb', serviceTag: 'AMB' }), /스캔 대역이 서로 다른 법인으로 겹칩니다/);
  assert.match(why({ serverId: 'out', serviceTag: 'OUT' }), /Agent 로 스캔한 대역 밖이고 vCenter 할당도 없습니다/);
  assert.match(why({ serverId: 'edge:x:Q', source: 'edge', serviceTag: 'Q', remoteAgent: 'edge-xx' }), /보고한 에이전트 ‘edge-xx’ 의 법인 이름/);
  assert.match(why({ serverId: 'ome:1', source: 'ome', serviceTag: 'NOPE' }), /OME 로만 수집/);
  assert.match(why({ serverId: 'host:vc-x:esx9', serviceTag: '' }), /수동으로 물리 분류한 ESXi 호스트/);
  assert.match(why({ serverId: 'unknown-id', serviceTag: 'none' }), /수집한 Agent 의 법인을 알 수 없습니다/);
});

test('화면 응답 — 행마다 corpId · corpName · corpSource(미지정이면 corpWhy), 법인 목록 · 법인 미지정 수 · 원본 불변', () => {
  const full = {
    bareMetal: [{ serverId: 'r1', name: 'bm1', serviceTag: 'T1' }, { serverId: 'out', name: 'bm2', serviceTag: 'OUT' }],
    virtualizationHosts: [{ name: 'esx', vcenterId: 'vc-az' }],
    summary: { bareMetal: 2, bareMetalUnassigned: 2 },
  };
  const before = JSON.stringify(full);
  const out = enrichFleetCorp(full, { corpOf, dcOrder: ['NJ', 'AZ'], datacenters: [{ id: 'NJ', name: 'NJ' }, { id: 'AZ', name: 'AZ' }] });
  assert.equal(JSON.stringify(full), before, '캐시에 있는 원본은 바꾸지 않는다');
  assert.deepEqual(out.bareMetal.map((b) => [b.corpId, b.corpName, b.corpSource, b.corpWhy]), [['NJ', 'NJ', 'scan', undefined], ['', '', '', 'Agent 로 스캔한 대역 밖이고 vCenter 할당도 없습니다']]);
  assert.deepEqual(out.corps.map((c) => [c.id, c.bm, c.vh]), [['NJ', 1, 0], ['AZ', 0, 1], ['__none__', 1, 0]]);
  assert.equal(out.summary.bareMetalNoCorp, 1);
  assert.equal(out.summary.bareMetalUnassigned, 2, 'vCenter 미지정 수는 그대로(다른 화면이 읽는다)');
  assert.deepEqual(hwCorpRoster(full, { corpOf, dcOrder: ['NJ', 'AZ'] }), out.corps, '하드웨어 내보내기 창과 같은 목록');
});

test('라우트 — /fleet 은 법인 판정을 덧붙이고(법인 설정 서명 · 1분 칸이 캐시 키) · 수동 지정 라우트는 없다 · /admin/idrac 은 scanDatacenterId 를 따로 싣는다', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/routes/insights.js', import.meta.url), 'utf8'));
  const fleet = src.slice(src.indexOf("insightsRouter.get('/fleet',"), src.indexOf("insightsRouter.put('/fleet/tag'"));
  assert.match(fleet, /const key = `\$\{key0\}\|dc:\$\{hwDcSignature\(\)\}\|t:\$\{Math\.floor\(Date\.now\(\) \/ 60_000\)\}`/);
  assert.match(fleet, /enrichFleetCorp\(raw, hwCorpContext\(snap\)\)/);
  assert.match(fleet, /if \(scopedVcenterIds\(req\.user, snap\)\)/, '전체 범위 전용은 그대로');
  assert.doesNotMatch(src, /dc-assign|fleetDcAssign/);
  const idrac = stripComments(fs.readFileSync(new URL('../src/routes/admin/idracCore.js', import.meta.url), 'utf8'));
  const list = idrac.slice(idrac.indexOf("adminRouter.get('/idrac',"), idrac.indexOf("adminRouter.post('/idrac',"));
  assert.match(list, /withScanDatacenter\(s, idx, asg\)/);
  assert.match(list, /scanDatacenterId: r\.datacenterId/, '등록부 값(datacenterId)은 덮지 않는다 — 교체 스캔의 지울 범위');
  assert.match(list, /String\(s\.datacenterId \|\| ''\)\.trim\(\)\) return s;/);
  assert.match(list, /scopeIdracServers\(req, local\.map\(withDc\)\.concat\(remote\.map\(withDc\)\)\)/);
});
