// v2.971 수집 서버(Agent) ↔ 법인(DataCenter) 사용자 매칭(사용자 요청 2026-11-11 '수집 서버 agent 와 datacenter id 를 사용자가 매칭하는 기능').
//   저장은 collector.datacenterId(엣지 자기등록 라벨 datacenter 와 따로) · 바꾸는 길은 setCollectorDatacenterId 하나 · 판정 순서는
//   사용자 매칭(지금 있는 법인일 때만) → 이름 맞춤. 서버 분석 · 통합 서버 인벤토리 · 하드웨어 내보내기 · 전력 분석이 같은 지도(collectorToDatacenterMap)를 쓴다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';
process.env.COLLECTOR_HTTP_ALLOW = '*';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coldc-'));
process.env.CONFIG_DIR = tmp;

let reg; let dcStore; let analysis; let colDc;
before(async () => {
  reg = await import('../src/collector/registry.js');
  dcStore = await import('../src/datacenter/store.js');
  analysis = await import('../src/insights/analysisServers.js');
  colDc = await import('../src/routes/admin/collectorsDc.js');
  assert.equal(dcStore.addDatacenter({ id: 'pl', name: 'Poland' }).ok, true);
  assert.equal(dcStore.addDatacenter({ id: 'nj', name: 'New Jersey' }).ok, true);
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('저장 — 형식 · 없는 법인 400, 없는 수집 서버 404, 바뀐 것만 changed, 해제는 필드를 지운다 · URL · 토큰 · managed 그대로', () => {
  assert.equal(reg.addCollector({ id: 'warsaw-edge', name: 'warsaw-edge', url: 'http://10.9.1.5:4000', token: 'tok-w', datacenter: 'Warsaw' }, { managed: false }).ok, true);
  const valid = new Set(['pl', 'nj']);
  assert.equal(reg.setCollectorDatacenterId('warsaw-edge', 'PL;rm', valid).status, 400);
  assert.equal(reg.setCollectorDatacenterId('warsaw-edge', 'zz', valid).status, 400, '목록에 없는 법인');
  assert.equal(reg.setCollectorDatacenterId('nope', 'pl', valid).status, 404);
  const r = reg.setCollectorDatacenterId('warsaw-edge', ' PL ', valid);
  assert.equal(r.ok, true); assert.equal(r.changed, true); assert.equal(r.collector.datacenterId, 'pl');
  assert.notEqual(r.collector.token, 'tok-w', '토큰 원문을 응답에 싣지 않는다');
  assert.equal(reg.setCollectorDatacenterId('warsaw-edge', 'pl', valid).changed, false);
  const c = reg.loadCollectors().find((x) => x.id === 'warsaw-edge');
  assert.deepEqual([c.url, c.token, c.managed, c.datacenter, c.datacenterId], ['http://10.9.1.5:4000', 'tok-w', false, 'Warsaw', 'pl'], '이 필드만 바뀐다 — 수동 고정(managed)을 세우지 않는다');
});

test('보존 — 엣지 자기등록 · 관리자 폼 수정은 사용자 매칭을 덮지 않는다', () => {
  const self = reg.upsertCollectorFromAgent({ name: 'warsaw-edge', url: 'http://10.9.1.6:4000', token: 'tok-w2', datacenter: 'Warsaw-B' });
  assert.equal(self.ok, true);
  let c = reg.loadCollectors().find((x) => x.id === 'warsaw-edge');
  assert.deepEqual([c.url, c.datacenter, c.datacenterId], ['http://10.9.1.6:4000', 'Warsaw-B', 'pl'], '자기등록이 URL · 라벨을 갱신해도 매칭은 남는다');
  // 반증 F1: 화면 편집 폼은 목록 행을 통째로(datacenterId 포함) 다시 보낸다 — 다른 탭에서 바꾼 매칭을 되돌리거나 없는 법인을 넣지 못한다.
  const staleRow = { ...reg.listCollectors().find((x) => x.id === 'warsaw-edge'), datacenterId: 'nj', name: 'Warsaw 엣지' };
  assert.equal(reg.updateCollector('warsaw-edge', staleRow, { managed: true }).ok, true);
  c = reg.loadCollectors().find((x) => x.id === 'warsaw-edge');
  assert.equal(c.datacenterId, 'pl', '폼 본문의 datacenterId 는 무시 — 기존 매칭 유지');
  assert.equal(reg.updateCollector('warsaw-edge', { ...staleRow, datacenterId: 'ghost' }, { managed: true }).ok, true);
  assert.equal(reg.loadCollectors().find((x) => x.id === 'warsaw-edge').datacenterId, 'pl', '없는 법인도 이 경로로는 들어가지 않는다');
  assert.equal(reg.addCollector({ id: 'new-one', name: 'new-one', url: 'http://10.9.9.9:4000', token: 't', datacenterId: 'pl' }, { managed: true }).ok, true);
  assert.equal(reg.loadCollectors().find((x) => x.id === 'new-one').datacenterId, undefined, '추가도 매칭을 만들지 않는다 — 전용 경로 하나');
  assert.equal(reg.removeCollector('new-one').ok, true);
});

test('대소문자만 다른 중복 병합에서 매칭을 잃지 않는다(반증 F3)', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/collector/registry.js', import.meta.url), 'utf8'));
  assert.match(src, /for \(const f of \['vcenterId', 'datacenter', 'datacenterId', 'name', 'url', 'token'\]\)/);
});

test('IP 관리 스캔 에이전트 → 법인도 사용자 매칭을 먼저(반증 F2) · IP 관리 자체 수동 설정은 그대로 이긴다', async () => {
  const { resolveAgentDatacenters } = await import('../src/ipam/scanDatacenter.js');
  const dcs = [{ id: 'pl', name: 'Poland' }, { id: 'nj', name: 'New Jersey' }];
  const base = { agents: ['warsaw-edge'], vcenters: [], snapVcenters: [], datacenters: dcs, assign: {} };
  const col = [{ id: 'warsaw-edge', name: 'warsaw-edge', datacenter: 'Warsaw', datacenterId: 'pl' }];
  assert.equal(resolveAgentDatacenters({ ...base, settings: {}, collectors: col }).get('warsaw-edge').datacenterId, 'pl');
  assert.equal(resolveAgentDatacenters({ ...base, settings: {}, collectors: [{ ...col[0], datacenterId: 'gone' }] }).get('warsaw-edge').datacenterId, null, '지워진 법인 매칭은 쓰지 않는다');
  assert.equal(resolveAgentDatacenters({ ...base, settings: { 'warsaw-edge': { datacenterId: 'nj' } }, collectors: col }).get('warsaw-edge').datacenterId, 'nj');
});

test('판정 순서 — 사용자 매칭(지금 있는 법인) → 이름 맞춤, 지워진 법인은 이름 맞춤으로 + stale · 화면 판정(collectorDcMatch)과 같은 결과', () => {
  assert.equal(reg.addCollector({ id: 'nj', name: 'nj', url: 'http://10.9.2.5:4000', token: 't' }, { managed: true }).ok, true);
  assert.equal(reg.addCollector({ id: 'mystery', name: 'mystery', url: 'http://10.9.3.5:4000', token: 't' }, { managed: true }).ok, true);
  let map = analysis.collectorToDatacenterMap();
  assert.deepEqual([map.get('warsaw-edge'), map.get('nj'), map.get('mystery')], ['pl', 'nj', '']);
  let m = colDc.collectorDcMatch(reg.loadCollectors(), dcStore.listDatacenters());
  assert.deepEqual([m['warsaw-edge'], m.nj, m.mystery], [{ id: 'pl', via: 'manual' }, { id: 'nj', via: 'name' }, { id: '', via: '' }]);
  // 사용자 매칭이 이름 맞춤보다 먼저: 'nj' 수집 서버를 pl 로
  assert.equal(reg.setCollectorDatacenterId('nj', 'pl', new Set(['pl', 'nj'])).changed, true);
  assert.equal(analysis.collectorToDatacenterMap().get('nj'), 'pl');
  // 법인이 지워지면 → 이름 맞춤으로 돌아가고 화면은 stale 로 알린다
  assert.equal(dcStore.removeDatacenter('pl').ok !== false, true);
  map = analysis.collectorToDatacenterMap();
  m = colDc.collectorDcMatch(reg.loadCollectors(), dcStore.listDatacenters());
  assert.equal(map.get('nj'), 'nj'); assert.deepEqual(m.nj, { id: 'nj', via: 'name', stale: true, picked: 'pl' });
  assert.equal(map.get('warsaw-edge'), ''); assert.deepEqual(m['warsaw-edge'], { id: '', via: '', stale: true, picked: 'pl' });
  for (const c of reg.loadCollectors()) assert.equal(map.get(c.id), m[c.id].id, `${c.id}: 서버 판정과 화면 판정이 같다`);
});

test('전력 분석 — 사용자 매칭 > 서버에 붙은 법인(엣지 태그) > 수집 서버 지도 > 이름 맞춤', async () => {
  const { computePowerBreakdown } = await import('../src/insights/powerBreakdown.js');
  const snap = { vcenters: [], hosts: [] };
  const dcs = [{ id: 'nj', name: 'NJ' }, { id: 'az', name: 'AZ' }];
  const measured = [
    { serverName: 'a', watts: 100, collectorId: 'nj' },                       // 이름은 nj 와 맞지만 사용자가 az 로 매칭
    { serverName: 'b', watts: 50, collectorId: 'nj', datacenterId: 'nj' },   // 서버에 명시된 법인이 먼저
  ];
  const out = computePowerBreakdown(snap, measured, { datacenters: dcs, collectorDc: new Map([['nj', 'az']]) });
  const w = Object.fromEntries((out.byDatacenter || []).map((d) => [d.datacenterId, d.watts]));
  assert.equal(w.az, 100); assert.equal(w.nj, 50, '사용자 매칭이 아니면(이름 맞춤 지도) 서버에 붙은 법인이 먼저');
  const man = computePowerBreakdown(snap, measured, { datacenters: dcs, collectorDc: new Map([['nj', 'az']]), collectorDcManual: new Map([['nj', 'az']]) });
  assert.deepEqual(man.byDatacenter.map((d) => [d.datacenterId, d.watts]), [['az', 150]], '사용자 매칭은 엣지 태그보다 먼저(1:1:1)');
  const plain = computePowerBreakdown(snap, measured.slice(0, 1), { datacenters: dcs });
  assert.equal(plain.byDatacenter[0].datacenterId, 'nj', '지도가 없으면 예전 이름 맞춤 그대로');
});

test('라우트 · 연결 — PUT 은 관리자 ∧ 전 법인 · 감사 · 캐시 키에 매칭 서명 · 미지정 이유 코드(collector)', async () => {
  const src = stripComments(fs.readFileSync(new URL('../src/routes/admin/collectorsDc.js', import.meta.url), 'utf8'));
  assert.match(src, /adminRouter\.put\('\/collectors\/:id\/datacenter', adminOnly, fullReadWriteScopeOnlyWith\(/, '조회 ∧ 쓰기 전체 범위(반증 F4)');
  assert.match(src, /typeof b\.datacenterId !== 'string'\) return res\.status\(400\)/, '문자열이 아닌 본문은 해제가 아니라 400(반증 F5)');
  assert.match(src, /logAudit\(\{[^}]*'수집 서버 법인 매칭'/);
  assert.match(src, /res\.json\(\{ collectors, dcMatch,/);
  const ins = stripComments(fs.readFileSync(new URL('../src/routes/insights.js', import.meta.url), 'utf8'));
  assert.match(ins, /collectorDcSig\(\)/, '매칭을 바꾸면 /fleet · 전력 분석 캐시가 바로 갈린다');
  assert.match(ins, /\{ map: collectorDc, manual: collectorDcManual \} = collectorDcMaps\(\)/);
  assert.match(ins, /computePowerBreakdown\(scoped, measured, \{[^}]*collectorDc, collectorDcManual \}/);
  const { makeCorpOf, buildDcIndex } = await import('../src/insights/hwExport/corp.js');
  const corpOf = makeCorpOf({ index: buildDcIndex([{ id: 'e2', remote: true, collectorId: 'zz', serviceTag: 'E2', datacenterId: '' }], () => ''), dcOfVc: () => '', dcName: () => '', vcName: () => '', agentDc: () => '' });
  const c = corpOf({ serverId: 'remote:zz:e2', serviceTag: 'E2' }, 'bm');
  assert.equal(c.whyCode, 'collector', '화면이 수집 서버 매칭 링크를 띄울 근거');
  assert.equal(corpOf({ serverId: 'out', serviceTag: 'OUT' }, 'bm').whyCode, undefined);
});

test('원격 서버 — 사용자 매칭이 엣지가 붙인 법인 태그보다 먼저, 매칭이 없으면 엣지 태그 그대로', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/insights/analysisServers.js', import.meta.url), 'utf8'));
  assert.match(src, /datacenterId: manual\.get\(String\(s\.collectorId\)\) \|\| s\.datacenterId \|\| m\.get\(String\(s\.collectorId\)\) \|\| ''/);
  const { manual } = analysis.collectorDcMaps();
  assert.equal(manual.get('mystery'), undefined, '매칭하지 않은 수집 서버는 manual 에 없다');
});

test('등록부를 읽지 못하면 503 — 빈 목록 위에 저장하지 않는다', () => {
  fs.writeFileSync(path.join(tmp, 'collectors.json'), '{broken');
  const r = reg.setCollectorDatacenterId('nj', 'nj', null);
  assert.equal(r.ok, false); assert.equal(r.status, 503); assert.equal(r.code, 'registryUnreadable');
});
