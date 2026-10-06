/**
 * v2.708 데모(mock) 엣지 그룹 — mock/demo/edge.js 와 배선(collector/puller · central/edgePull · linkcheck · relaytopo/relaycheck ·
 * health/network · security/certMonitor · insights/graph).
 * 고정하는 것: ① 합성 값의 결정성 ② mock 이 아니면 아무것도 하지 않는다(입력 그대로·null) ③ 시드는 비어 있을 때만
 * ④ 데모 엣지는 접속하지 않는다(pullFromEdge 가 fetch 를 부르지 않는다 · puller 가 데모 항목을 건너뛴다).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo2708-edge-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'mock';

const edge = await import('../src/mock/demo/edge.js');
const seedMod = await import('../src/mock/demo/edgeSeed.js');
const { setDataSource } = await import('../src/runtime-settings.js');
const reg = await import('../src/collector/registry.js');
const { judge, summaryText } = await import('../src/linkcheck/phases.js');
const { certExpiryStatus } = await import('../src/security/certMonitor.js');
const { pullFromEdge } = await import('../src/central/edgePull.js');
const { buildCommMap } = await import('../src/commmap/build.js');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000; // 정시 −30분 고정 기준(CLAUDE.md 규약)
const SNAP = {
  vcenters: [
    { id: 'vc-ap-northeast', name: 'vcenter-ap-northeast-01', status: 'connected', location: { region: '아시아' } },
    { id: 'vc-eu-central', name: 'vcenter-eu-central-01', status: 'connected', location: { region: '유럽' } },
    { id: 'vc-us-west', name: 'vcenter-us-west-01', status: 'connected', location: { region: '북미' } },
  ],
  hosts: [{ id: 'h1', vcenterId: 'vc-ap-northeast' }, { id: 'h2', vcenterId: 'vc-eu-central' }, { id: 'h3', vcenterId: 'vc-us-west' }],
  vms: [{ id: 'v1', vcenterId: 'vc-ap-northeast' }],
  datastores: [],
};

test('① 합성 값은 결정적이다(같은 입력 = 같은 출력)', () => {
  const link = { id: 'edge->central-pull|mock-Edge-Shanghai|central', kind: 'edge->central-pull', from: 'mock-Edge-Shanghai', to: 'central', scheme: 'https', auth: 'central-token' };
  const a = edge.demoLinkResult(link, { ts: NOW, judge, summaryText });
  const b = edge.demoLinkResult(link, { ts: NOW, judge, summaryText });
  assert.deepEqual(a.verdict, b.verdict);
  assert.deepEqual(a.steps, b.steps);
  assert.equal(typeof a.verdict.ok, 'boolean', 'judge 가 판정한다(판정 복제 금지)');
  const c1 = edge.demoTokenReport({ id: 'mock-Edge-Seoul', name: 'mock-Edge-Seoul', token: 'tok-a' }, { now: NOW });
  const c2 = edge.demoTokenReport({ id: 'mock-Edge-Seoul', name: 'mock-Edge-Seoul', token: 'tok-a' }, { now: NOW });
  assert.deepEqual(c1, c2);
  assert.equal(edge.demoEdgeToken(edge.DEMO_EDGES[0]), edge.demoEdgeToken(edge.DEMO_EDGES[0]));
  assert.notEqual(edge.demoEdgeToken(edge.DEMO_EDGES[0]), edge.demoEdgeToken(edge.DEMO_EDGES[1]), '엣지마다 다른 토큰(같으면 토큰 점검이 중복 결함)');
  // 엣지 id 와 이름은 같다(다르면 '아는 엣지' 목록에 두 줄)
  for (const e of edge.DEMO_EDGES) { assert.equal(e.id, e.name); assert.match(e.id, /^mock-/); }
});

test('② mock 모드 — vCenter 위임 표시·통신 지도 입력이 채워진다', () => {
  setDataSource('mock');
  const deco = edge.demoDecorateVcenters(SNAP.vcenters);
  const seoul = deco.find((v) => v.id === 'vc-ap-northeast');
  assert.equal(seoul.collectSource, 'site'); assert.equal(seoul.collectedBy, 'mock-Edge-Seoul');
  assert.equal(deco.find((v) => v.id === 'vc-us-west').collectSource, undefined, '데모 엣지가 맡지 않는 vCenter 는 중앙 직접');
  const collectors = edge.DEMO_EDGES.map((e) => ({ id: e.id, name: e.name, url: edge.demoEdgeUrl(e), enabled: true }));
  const map = buildCommMap({ now: NOW, collectors, status: {}, snapVcenters: deco, vcenters: [], pullIntervalMs: 60_000, siteStaleMs: 300_000 });
  assert.equal(map.edges.length, 5);
  assert.equal(map.edges.find((x) => x.id === 'mock-Edge-Seoul').resources.vcenter.total, 1);
  assert.equal(map.counts.unassigned, 0);
  // 네트워크 점검 합성: 위임 vCenter 는 '중앙 직접 도달 불가 · 수집 정상'
  const probes = edge.demoNetworkProbes(SNAP, [{ id: 'nsx-1', name: 'nsx', host: 'https://nsx.corp.local', region: '아시아' }], null, { now: NOW });
  assert.equal(probes.find((p) => p.id === 'vc-ap-northeast').alive, false);
  assert.equal(probes.find((p) => p.id === 'vc-us-west').alive, true);
  assert.equal(probes.find((p) => p.id === 'nsx-1').host, 'nsx.corp.local');
  // 범위 계정: 허용 vCenter 만
  assert.deepEqual(edge.demoNetworkProbes(SNAP, [], new Set(['vc-us-west']), { now: NOW }).map((p) => p.id), ['vc-us-west']);
  assert.ok(edge.demoVcAgentPairs(SNAP.vcenters).some(([vc, ag]) => vc === 'vc-ap-northeast' && ag === 'mock-Edge-Seoul'));
});

test('③ mock 이 아니면 아무것도 하지 않는다(입력 그대로·null·빈 목록)', async () => {
  setDataSource('live');
  try {
    assert.equal(edge.demoDecorateVcenters(SNAP.vcenters), SNAP.vcenters, '원본 배열 그대로');
    const inp = { vcenters: [{ id: 'x' }], pairs: [], collectors: [] };
    assert.deepEqual(edge.demoLinkInputs(inp), { vcenters: inp.vcenters, pairs: inp.pairs });
    assert.equal(edge.demoNetworkProbes(SNAP, []), null);
    assert.deepEqual(edge.demoVcAgentPairs(SNAP.vcenters), []);
    assert.equal(edge.demoCertItems(certExpiryStatus, { vcenters: SNAP.vcenters }), null);
    assert.equal(edge.demoRelayCheck({ host: 'edge-seoul.demo.invalid', port: 4000, kind: 'edge-portal' }), null);
    assert.equal(edge.demoInspectNode({ main: {}, services: [] }, { dc: 'mock-Edge-Seoul', edge: {}, irs: {} }, 'edge'), null);
    assert.deepEqual(edge.demoSiteVcenters(SNAP.vcenters), []);
    assert.deepEqual(edge.demoInventoryRows(SNAP), []);
    assert.deepEqual(edge.demoDirUsageTargets(), []);
    assert.deepEqual(edge.demoAgentNames(), []);
    assert.equal(await seedMod.demoEdgeTick({ now: NOW, snap: SNAP }), null);
    assert.equal(await edge.demoEdgePullBody({ id: 'mock-Edge-Seoul' }, '/api/collector/edge-log'), null);
    const r = await seedMod.ensureEdgeSeed({ force: true });
    assert.equal(r.reason, 'not-mock');
    assert.equal(reg.loadCollectors().length, 0, 'live 에서는 등록부를 건드리지 않는다');
  } finally { setDataSource('mock'); }
});

test('④ 등록부 시드는 비어 있을 때만 — 실 항목이 있으면 시드하지 않는다', async () => {
  setDataSource('mock');
  const added = reg.addCollector({ id: 'real-edge', name: 'real-edge', url: 'https://10.1.2.3:4000', token: 'x'.repeat(32) });
  assert.equal(added.ok, true);
  seedMod._resetEdgeSeedForTest();
  const r = await seedMod.ensureEdgeSeed({ force: true });
  assert.equal(r.reason, 'not-empty');
  assert.deepEqual(reg.loadCollectors().map((c) => c.id), ['real-edge']);
  reg.removeCollector('real-edge');
  seedMod._resetEdgeSeedForTest();
  const r2 = await seedMod.ensureEdgeSeed({ force: true });
  assert.equal(r2.seeded, 5);
  const list = reg.loadCollectors();
  assert.ok(list.every((c) => edge.isDemoCollector(c)), '시드 항목은 전부 데모(mock- · .demo.invalid)');
  assert.ok(list.every((c) => /\.demo\.invalid:4000$/.test(c.url)));
  seedMod._resetEdgeSeedForTest();
  assert.equal((await seedMod.ensureEdgeSeed({ force: true })).reason, 'not-empty', '두 번째 시드는 하지 않는다');
});

test('⑤ 데모 엣지는 접속하지 않는다 — pullFromEdge 가 fetch 를 부르지 않고 합성 응답', async () => {
  setDataSource('mock');
  let called = 0;
  const fetchImpl = async () => { called++; throw new Error('접속하면 안 된다'); };
  const log = await pullFromEdge('mock-Edge-Seoul', '/api/collector/edge-log?limit=50', { fetchImpl });
  assert.equal(called, 0);
  assert.equal(log.ok, true);
  assert.equal(log.body.logs.items.length, 50);
  assert.equal(log.body.node.agent, 'mock-Edge-Seoul');
  const tok = await pullFromEdge('mock-Edge-Seoul', '/api/collector/token-check', { fetchImpl });
  assert.equal(called, 0); assert.equal(tok.ok, true);
  const other = await pullFromEdge('mock-Edge-Seoul', '/api/collector/bm-usage', { fetchImpl });
  assert.equal(called, 0); assert.equal(other.ok, false); assert.equal(other.kind, 'disabled');
  // 토큰 자기보고의 수집 토큰 지문은 중앙 등록값과 같다(같아야 토큰 점검이 '일치' 로 판정한다)
  const { tokenFingerprintParts } = await import('../src/util/tokenFingerprint.js');
  const col = reg.findCollectorByName('mock-Edge-Seoul');
  assert.equal(tok.body.tokens.collector.short, tokenFingerprintParts(col.token).short);
});

test('⑥ 통신 점검·인증서·HAProxy 점검 합성은 판정 모듈을 거친다', async () => {
  setDataSource('mock');
  const tgt = { id: 'set:storage|a', kind: 'set:storage', name: 'a', host: 'a.demo.invalid', port: 443, scheme: 'https' };
  const r = edge.demoSettingsResult(tgt, { ts: NOW, judge, summaryText });
  assert.equal(r.verdict.ok, true); assert.equal(r.link.id, tgt.id);
  setDataSource('mock');
  const certs = edge.demoCertItems(certExpiryStatus, { now: NOW, vcenters: SNAP.vcenters, nsxManagers: [{ id: 'n1', name: 'n1', host: 'https://n1.corp.local' }] });
  assert.equal(certs.length, 4);
  for (const c of certs) assert.equal(c.status, certExpiryStatus(c.validTo, { now: NOW }).status);
  const fail = edge.demoRelayCheck({ key: 'edge-shanghai.demo.invalid:4066', host: 'edge-shanghai.demo.invalid', port: 4066, kind: 'irs-vcenter' }, { now: NOW });
  assert.equal(fail.ok, false); assert.equal(fail.phase, 'refused');
  const ok = edge.demoRelayCheck({ key: 'edge-seoul.demo.invalid:4000', host: 'edge-seoul.demo.invalid', port: 4000, kind: 'edge-portal' }, { now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(edge.demoRelayCheck({ host: '10.0.0.1', port: 4000, kind: 'edge-portal' }), null, '데모 호스트가 아니면 실제 점검');
});

test('⑦ puller·통신 점검 폴러는 데모 항목을 건너뛴다(소스 검사) · 순수 합성 모듈은 도메인 모듈을 불러오지 않는다', () => {
  const pure = fs.readFileSync(new URL('../src/mock/demo/edge.js', import.meta.url), 'utf8');
  assert.doesNotMatch(pure, /import\(/, 'edge.js 에 동적 import 금지(순환 — 시드·틱은 edgeSeed.js)');
  assert.deepEqual([...pure.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort(), ['../../util/tokenFingerprint.js', './flags.js']);
  const src = fs.readFileSync(new URL('../src/collector/puller.js', import.meta.url), 'utf8');
  assert.match(src, /!isDemoCollector\(c\)\)/, '주기 pull 대상에서 데모 항목 제외');
  assert.match(src, /!isDemoCollector\(x\)/, '즉시 당김에서 데모 항목 제외');
  const lp = fs.readFileSync(new URL('../src/linkcheck/poller.js', import.meta.url), 'utf8');
  assert.match(lp, /demo\s*\?\s*mine\.map\(\(l\) => demoLinkResult/, 'mock 이면 runLink 대신 합성');
});
