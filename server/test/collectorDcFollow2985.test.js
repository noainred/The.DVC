// v2.985 후속(P5 · P6 — 2026-11-11 사용자 요청 'P1~P7 진행'). v2.972 수집 서버 ↔ 법인 매칭의 남은 것:
//   P5 손으로 고친 datacenters.json 의 대문자 법인 id 도 매칭(대소문자 무시 → 실제 id).
//   P6 엣지 라벨이 기존 법인의 이름과 같거나 이미 매칭된 수집 서버는 법인을 새로 만들지 않는다 · 목 데이터의 'Seoul 법인' / 'Seoul' 중복.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.COLLECTOR_HTTP_ALLOW = '*';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcfollow-'));
process.env.CONFIG_DIR = tmp;
let reg; let dcStore; let an; let colDc;
before(async () => {
  // 손으로 고친 파일 — 대문자 id(addDatacenter 는 소문자만 만든다)
  fs.writeFileSync(path.join(tmp, 'datacenters.json'), JSON.stringify({ datacenters: [{ id: 'PL-WAW', name: 'Poland' }, { id: 'nj', name: 'New Jersey' }], assign: {} }));
  reg = await import('../src/collector/registry.js');
  dcStore = await import('../src/datacenter/store.js');
  an = await import('../src/insights/analysisServers.js');
  colDc = await import('../src/routes/admin/collectorsDc.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('P5 — 대문자 법인 id 도 매칭 저장 · 판정은 실제 id 로', () => {
  assert.equal(reg.addCollector({ id: 'warsaw-edge', name: 'warsaw-edge', url: 'http://10.9.1.5:4000', token: 't', datacenter: 'Warsaw' }, { managed: true }).ok, true);
  const valid = new Set(dcStore.listDatacenters().map((d) => String(d.id)));
  const r = reg.setCollectorDatacenterId('warsaw-edge', 'PL-WAW', valid);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(an.collectorToDatacenterMap().get('warsaw-edge'), 'PL-WAW', '판정은 실제(대문자) id');
  assert.deepEqual(colDc.collectorDcMatch(reg.loadCollectors(), dcStore.listDatacenters())['warsaw-edge'], { id: 'PL-WAW', via: 'manual' });
  assert.equal(an.collectorDcMaps().manual.get('warsaw-edge'), 'PL-WAW');
});

test('P6 — 법인이 정해진 수집 서버(매칭 · 이름 맞춤)는 법인을 새로 만들지 않는다 · 정해지지 않으면 예전처럼 만든다', () => {
  const before = dcStore.listDatacenters().length;
  an.ensureCollectorDatacenter(reg.loadCollectors().find((c) => c.id === 'warsaw-edge'));   // 사용자 매칭 → PL-WAW
  an.ensureCollectorDatacenter({ id: 'pl-edge-2', name: 'pl-edge-2', datacenter: 'Poland' });   // 라벨 = 기존 법인 이름
  an.ensureCollectorDatacenter({ id: 'nj-edge', name: 'nj-edge', datacenter: 'NJ' });            // 라벨 = 기존 법인 id(대소문자 무시)
  assert.equal(dcStore.listDatacenters().length, before, '하나도 늘지 않는다');
  an.ensureCollectorDatacenter({ id: 'tx-edge', name: 'tx-edge', datacenter: 'Texas' });
  assert.ok(dcStore.listDatacenters().some((d) => d.id === 'texas'), '정해지지 않은 라벨은 예전처럼 법인을 만든다');
});

test('P6 — 목 데이터 법인 id: 엣지 라벨이 도시와 같으면 라벨 id(엣지 자동 등록과 같은 법인) · 다르면 dc-<도시>', async () => {
  const { demoCorpId } = await import('../src/mock/demo/pdu.js');
  assert.equal(demoCorpId({ id: 'vc-ap-northeast' }, 'Seoul', { datacenter: 'Seoul' }), 'seoul');
  assert.equal(demoCorpId({ id: 'vc-eu-west' }, 'Dublin', { datacenter: 'Frankfurt' }), 'dc-dublin');
  assert.equal(demoCorpId({ id: 'vc-ap-south' }, 'Mumbai', null), 'dc-mumbai');
});

test('P2 — 원격 수집 행도 수집 서버의 법인을 본다 · 순서는 색인 > vCenter 할당 > 에이전트(반증 D3: 전력 분석과 같게 — P3 순서 변경은 되돌림)', async () => {
  const { makeCorpOf, buildDcIndex, agentOfRow } = await import('../src/insights/hwExport/corp.js');
  const index = buildDcIndex([{ id: 'e1', remote: true, collectorId: 'pl-edge', serviceTag: 'E1', datacenterId: 'pl' }], () => '');
  const corpOf = makeCorpOf({ index, dcOfVc: (v) => ({ 'vc-x': 'nj' }[v] || ''), dcName: (i) => i, vcName: (v) => v,
    agentDc: (a) => ({ 'pl-edge': 'pl', 'site:a': 'dc-a', site: 'dc-other' }[a] || ''), collectorIds: ['pl-edge', 'site', 'site:a', 'zz'] });
  // P2: 구버전 엣지가 serverId 대신 host 를 보낸 전력 행 · 태그 없음 → 예전 '미지정', 이제 수집 서버의 법인
  assert.deepEqual(corpOf({ serverId: 'remote:pl-edge:10.1.1.9', serviceTag: '' }, 'bm'), { id: 'pl', name: 'pl', src: 'agent' });
  // 반증 D3: vCenter 할당이 있으면 그것이 먼저(전력 분석 resolveDc 와 같다)
  assert.equal(corpOf({ serverId: 'edge:pl-edge:Q', source: 'edge', serviceTag: 'Q', remoteAgent: 'pl-edge', vcenterId: 'vc-x' }, 'bm').id, 'nj');
  assert.equal(corpOf({ serverId: 'remote:pl-edge:e1', serviceTag: 'E1' }, 'bm').id, 'pl', '색인 적중이 가장 먼저');
  assert.equal(corpOf({ name: 'esx', vcenterId: 'vc-x', serverId: 'remote:pl-edge:z' }, 'vh').id, 'nj');
  // 반증 D4: ':' 가 든 수집 서버 id 는 최장 일치 · 행의 collectorId 가 파싱보다 먼저
  assert.equal(agentOfRow({ serverId: 'remote:site:a:10.1.1.9' }, ['site', 'site:a']), 'site:a');
  assert.equal(agentOfRow({ serverId: 'remote:site:a:10.1.1.9', collectorId: 'site:a' }, ['site']), 'site:a');
  assert.equal(agentOfRow({ remoteAgent: 'e1', serverId: 'remote:z:1' }, ['z']), 'e1');
  assert.equal(agentOfRow({ serverId: 'remote:unknown:1' }, ['z']), '', '모르는 수집 서버는 지어내지 않는다');
  assert.equal(corpOf({ serverId: 'remote:site:a:10.1.1.9', serviceTag: '' }, 'bm').id, 'dc-a');
  const u = corpOf({ serverId: 'remote:zz:10.0.0.1', serviceTag: '' }, 'bm');
  assert.equal(u.id, ''); assert.equal(u.whyCode, 'collector'); assert.match(u.why, /수집 서버 ‘zz’/);
});

test('반증 D5 — hwCorpContext 실제 호출: 사용자 매칭 없음 + 이름 맞춤 + vCenter 할당이면 vCenter 가 이긴다 · 원격 행은 수집 서버 법인', async () => {
  const { hwCorpContext } = await import('../src/routes/insights.js');
  assert.equal(reg.addCollector({ id: 'nj-edge', name: 'nj-edge', url: 'http://10.9.4.5:4000', token: 't', datacenter: 'nj' }, { managed: true }).ok, true);
  assert.equal(dcStore.addDatacenter({ id: 'tx', name: 'Texas DC' }).ok, true);
  dcStore.setVcenterDatacenterMany([{ vcenterId: 'vc-pl', datacenterId: 'tx' }]);
  const { corpOf } = hwCorpContext({ vcenters: [{ id: 'vc-pl', name: 'vc-pl' }] });
  assert.equal(corpOf({ serverId: 'edge:nj-edge:Q', source: 'edge', serviceTag: 'QQ', remoteAgent: 'nj-edge', vcenterId: 'vc-pl' }, 'bm').id, 'tx', 'vCenter 할당이 이름 맞춤보다 먼저');
  assert.equal(corpOf({ serverId: 'remote:nj-edge:10.2.2.2', serviceTag: '' }, 'bm').id, 'nj', '원격 행 → 수집 서버 이름 맞춤');
});

test('반증 D1 · D2 — 라벨이 새 법인이면 id · 이름이 다른 법인과 같아도 라벨 법인을 만든다 · 대소문자만 다른 두 id 는 한 규칙으로(정확 일치 먼저)', async () => {
  const { resolvePickedDc } = await import('../src/collector/datacenterMatch.js');
  assert.equal(dcStore.addDatacenter({ id: 'kr-hq', name: 'Seoul' }).ok, true);
  an.ensureCollectorDatacenter({ id: 'seoul', name: 'seoul', datacenter: 'Seoul-DR' });
  assert.ok(dcStore.listDatacenters().some((d) => d.id === 'seoul-dr'), 'D1: 라벨 법인이 생긴다');
  const dcs = [{ id: 'PL-WAW' }, { id: 'pl-waw' }];
  assert.equal(resolvePickedDc('PL-WAW', dcs), 'PL-WAW'); assert.equal(resolvePickedDc('pl-waw', dcs), 'pl-waw'); assert.equal(resolvePickedDc('Pl-Waw', dcs), 'PL-WAW');
  // 등록부는 실제 id 그대로 저장한다(대소문자 보존)
  const valid = new Set(['PL-WAW', 'pl-waw']);
  assert.equal(reg.setCollectorDatacenterId('warsaw-edge', 'pl-waw', valid).collector.datacenterId, 'pl-waw');
  assert.equal(reg.setCollectorDatacenterId('warsaw-edge', 'PL-WAW', valid).collector.datacenterId, 'PL-WAW');
  // IP 관리도 같은 규칙
  const { resolveAgentDatacenters } = await import('../src/ipam/scanDatacenter.js');
  const r = resolveAgentDatacenters({ agents: ['warsaw-edge'], settings: {}, vcenters: [], snapVcenters: [], assign: {},
    collectors: [{ id: 'warsaw-edge', name: 'warsaw-edge', datacenter: 'Warsaw', datacenterId: 'pl-WAW' }], datacenters: [{ id: 'PL-WAW', name: 'Poland' }] });
  assert.equal(r.get('warsaw-edge').datacenterId, 'PL-WAW', '대소문자만 다른 매칭 → 실제 id');
});

test('반증 D5 — 목 데이터: 데모 엣지 자동 등록이 도시 법인과 같은 법인을 하나 더 만들지 않는다', async () => {
  const { demoCorpId } = await import('../src/mock/demo/pdu.js');
  const sites = [['vc-ap-northeast', 'Seoul', 'Seoul'], ['vc-eu-central', 'Frankfurt', 'Frankfurt'], ['vc-eu-west', 'Dublin', 'Frankfurt'], ['vc-us-east', 'Ashburn', 'Ashburn']];
  for (const [vc, city, label] of sites) dcStore.ensureDatacenter({ id: demoCorpId({ id: vc }, city, { datacenter: label }), name: `${city} 법인` });
  const n = dcStore.listDatacenters().length;
  for (const label of ['Seoul', 'Frankfurt', 'Ashburn']) an.ensureCollectorDatacenter({ id: `mock-Edge-${label}`, name: `mock-Edge-${label}`, datacenter: label });
  assert.equal(dcStore.listDatacenters().length, n, '도시 법인과 같은 라벨 법인을 하나 더 만들지 않는다');
});
