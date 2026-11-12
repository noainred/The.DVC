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

test('P2 · P3 — 색인에 없는 물리 행: 사용자 매칭 > vCenter 할당 > 이름 맞춤 · 원격 수집 행도 수집 서버를 본다', async () => {
  const { makeCorpOf, buildDcIndex, agentOfRow } = await import('../src/insights/hwExport/corp.js');
  const index = buildDcIndex([{ id: 'e1', remote: true, collectorId: 'pl-edge', serviceTag: 'E1', datacenterId: 'pl' }], () => '');
  const mk = (manual) => makeCorpOf({ index, dcOfVc: (v) => ({ 'vc-x': 'nj' }[v] || ''), dcName: (i) => i, vcName: (v) => v,
    agentDc: (a) => ({ 'pl-edge': 'pl', 'name-edge': 'tx' }[a] || ''), agentManualDc: (a) => (manual[a] || '') });
  const corpOf = mk({ 'pl-edge': 'pl' });
  // P2: 원격 전력 행 — serverId 가 host 로 대체(구버전 엣지) · 태그 없음 → 예전 '미지정', 이제 수집 서버 매칭
  assert.deepEqual(corpOf({ serverId: 'remote:pl-edge:10.1.1.9', serviceTag: '' }, 'bm'), { id: 'pl', name: 'pl', src: 'agent' });
  // P3: 엣지 보고 행 · vCenter(nj) 가 붙어 있어도 사용자 매칭(pl)이 먼저
  assert.deepEqual(corpOf({ serverId: 'edge:pl-edge:Q', source: 'edge', serviceTag: 'Q', remoteAgent: 'pl-edge', vcenterId: 'vc-x' }, 'bm'), { id: 'pl', name: 'pl', src: 'agent' });
  // 이름 맞춤(사용자 매칭 아님)은 예전처럼 vCenter 뒤
  assert.equal(corpOf({ serverId: 'edge:name-edge:Q', source: 'edge', serviceTag: 'Q2', remoteAgent: 'name-edge', vcenterId: 'vc-x' }, 'bm').id, 'nj');
  assert.equal(corpOf({ serverId: 'edge:name-edge:Q', source: 'edge', serviceTag: 'Q3', remoteAgent: 'name-edge' }, 'bm').id, 'tx');
  // 색인 적중이 가장 먼저(서버 분석과 같은 판정)
  assert.equal(mk({ 'pl-edge': 'other' })({ serverId: 'remote:pl-edge:e1', serviceTag: 'E1' }, 'bm').id, 'pl');
  // 가상화 호스트는 늘 자기 vCenter
  assert.equal(corpOf({ name: 'esx', vcenterId: 'vc-x', serverId: 'remote:pl-edge:z' }, 'vh').id, 'nj');
  // 매칭 · 이름 모두 없으면 미지정 + 수집 서버 링크 근거
  const u = mk({})({ serverId: 'remote:zz:10.0.0.1', serviceTag: '' }, 'bm');
  assert.equal(u.id, ''); assert.equal(u.whyCode, 'collector'); assert.match(u.why, /수집 서버 ‘zz’/);
  assert.equal(agentOfRow({ serverId: 'remote:a-b:x:y' }), 'a-b');
  assert.equal(agentOfRow({ remoteAgent: 'e1', serverId: 'remote:z:1' }), 'e1');
  // 라우트가 사용자 매칭을 따로 넘긴다
  const src = fs.readFileSync(new URL('../src/routes/insights.js', import.meta.url), 'utf8');
  assert.match(src, /agentDc, agentManualDc \}\);/);
});
