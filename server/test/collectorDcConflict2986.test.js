// v2.986 수집 서버 법인 ↔ vCenter 할당 법인 불일치(사용자 결정 2026-11-12 '불일치가 생기면 사용자가 매칭을 선택' · '버튼으로 한쪽에 맞추기').
//   판정은 **서버 한 대 단위**(반증 D1 · D2): A = 서버 분석이 그 서버에 쓰는 법인 · B = 그 서버 vCenter(수집 서버 vcenterId → 서버 vcenterId → 태그로 찾은 ESXi)의 할당 법인.
//   버튼 두 개(수집 서버를 B 로 매칭 · vCenter 를 A 에 할당) 어느 쪽이든 서버 분석과 전력 분석이 같은 법인을 보게 되는지 실제 저장소로 확인한다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';
process.env.COLLECTOR_HTTP_ALLOW = '*';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcconf-'));
process.env.CONFIG_DIR = tmp;
let reg; let dcStore; let rinv; let an; let col; let pb;
before(async () => {
  reg = await import('../src/collector/registry.js');
  dcStore = await import('../src/datacenter/store.js');
  rinv = await import('../src/collector/remoteInventory.js');
  an = await import('../src/insights/analysisServers.js');
  col = await import('../src/routes/admin/collectorsDc.js');
  pb = await import('../src/insights/powerBreakdown.js');
  for (const [id, name] of [['pl', 'Poland'], ['nj', 'New Jersey']]) assert.equal(dcStore.addDatacenter({ id, name }).ok, true);
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const matchOf = (cid) => col.collectorDcMatch(reg.loadCollectors(), dcStore.listDatacenters(), col.dcMatchContext())[cid];
const views = (cid, vc, tag = 'T1') => {
  const sa = an.remoteServersResolved().filter((s) => s.collectorId === cid).map((s) => s.datacenterId);
  const { map: collectorDc, manual: collectorDcManual } = an.collectorDcMaps();
  const p = pb.computePowerBreakdown({ vcenters: [{ id: vc }], hosts: [] }, [{ watts: 100, collectorId: cid, serverName: 's1', serverId: 's1', serviceTag: tag, vcenterId: vc, source: 'remote' }],
    { assign: dcStore.getDatacenterAssign(), datacenters: dcStore.listDatacenters(), collectorDc, collectorDcManual });
  return { analysis: sa, power: p.byDatacenter.map((d) => d.datacenterId) };
};

test('반증 D1 — 이미 같은 법인을 보면 경보하지 않는다(이름 맞춤 수집 서버 · 엣지 태그 pl · vCenter 할당 pl)', () => {
  assert.equal(reg.addCollector({ id: 'nj-edge', name: 'nj-edge', url: 'http://10.9.1.5:4000', token: 't', datacenter: 'NJ', vcenterId: 'vc-a' }, { managed: true }).ok, true);
  dcStore.setVcenterDatacenterMany([{ vcenterId: 'vc-a', datacenterId: 'pl' }]);
  rinv.setCollectorServers('nj-edge', 'NJ', [{ id: 's1', name: 's1', serviceTag: 'T1', datacenterId: 'pl' }]);
  assert.deepEqual(views('nj-edge', 'vc-a'), { analysis: ['pl'], power: ['pl'] });
  assert.equal(matchOf('nj-edge').conflicts, undefined, '거짓 경보 없음');
});

test('실제 불일치 → 버튼 어느 쪽이든 서버 분석 = 전력 분석', () => {
  assert.equal(reg.addCollector({ id: 'pl-edge', name: 'pl-edge', url: 'http://10.9.2.5:4000', token: 't', datacenter: 'Warsaw', vcenterId: 'vc-b' }, { managed: true }).ok, true);
  assert.equal(reg.setCollectorDatacenterId('pl-edge', 'pl', new Set(['pl', 'nj'])).ok, true);
  dcStore.setVcenterDatacenterMany([{ vcenterId: 'vc-b', datacenterId: 'nj' }]);
  rinv.setCollectorServers('pl-edge', 'Warsaw', [{ id: 's2', name: 's2', serviceTag: 'T2' }]);   // 다른 수집 서버와 같은 태그면 중복 제거로 빠진다
  assert.deepEqual(views('pl-edge', 'vc-b', 'T2'), { analysis: ['pl'], power: ['nj'] }, '갈려 있다');
  const [c] = matchOf('pl-edge').conflicts;
  assert.deepEqual(c, { vcenterId: 'vc-b', vcenterName: 'vc-b', datacenterId: 'nj', datacenterName: 'New Jersey', serverDatacenterId: 'pl', serverDatacenterName: 'Poland', servers: 1 });
  // ① '수집 서버를 B(nj) 로 매칭'
  assert.equal(reg.setCollectorDatacenterId('pl-edge', c.datacenterId, new Set(['pl', 'nj'])).ok, true);
  assert.deepEqual(views('pl-edge', 'vc-b', 'T2'), { analysis: ['nj'], power: ['nj'] });
  assert.equal(matchOf('pl-edge').conflicts, undefined);
  // 되돌려 다시 갈라 놓고 ② 'vCenter 를 A(pl) 에 할당'
  reg.setCollectorDatacenterId('pl-edge', 'pl', new Set(['pl', 'nj']));
  const [c2] = matchOf('pl-edge').conflicts;
  const r = dcStore.setVcenterDatacenterMany([{ vcenterId: c2.vcenterId, datacenterId: c2.serverDatacenterId }]);
  assert.equal(r.changed, 1);
  assert.deepEqual(views('pl-edge', 'vc-b', 'T2'), { analysis: ['pl'], power: ['pl'] });
  assert.equal(matchOf('pl-edge').conflicts, undefined);
});

test('반증 D2 — 수집 서버 · 서버 vcenterId 가 비어도 서비스태그로 찾은 ESXi 의 vCenter 를 본다 · 묶음 · 상한', () => {
  const servers = [{ datacenterId: 'pl', serviceTag: 'TAG1' }, { datacenterId: 'pl', serviceTag: 'TAG1' }, { datacenterId: 'pl', serviceTag: 'NOPE' }];
  const out = col.dcConflictsOf({ id: 'e' }, { assign: { 'vc-x': 'nj' }, serversOf: () => servers, tagVc: (t) => (t === 'tag1' ? 'vc-x' : ''), datacenters: dcStore.listDatacenters() });
  assert.deepEqual(out.map((x) => [x.vcenterId, x.serverDatacenterId, x.datacenterId, x.servers]), [['vc-x', 'pl', 'nj', 2]]);
  const many = Array.from({ length: 20 }, (_, i) => ({ datacenterId: 'pl', vcenterId: `vc-${i}` }));
  const assign = Object.fromEntries(many.map((s) => [s.vcenterId, 'nj']));
  assert.equal(col.dcConflictsOf({ id: 'e' }, { assign, serversOf: () => many }).length, 8);
  assert.deepEqual(col.dcConflictsOf({ id: 'e' }, { assign }), [], '서버 목록이 없으면 말하지 않는다');
});

test('반증 D3 — 대문자 법인 id 에도 vCenter 할당 저장 · D4 — 할당 라우트는 조회 ∧ 쓰기 전체 범위', () => {
  fs.writeFileSync(path.join(tmp, 'datacenters.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(tmp, 'datacenters.json'), 'utf8')), datacenters: [...dcStore.listDatacenters(), { id: 'PL-WAW', name: 'Warsaw' }] }));
  const r = dcStore.setVcenterDatacenterMany([{ vcenterId: 'vc-u', datacenterId: 'PL-WAW' }]);
  assert.equal(r.changed, 1); assert.equal(dcStore.getDatacenterAssign()['vc-u'], 'PL-WAW');
  assert.equal(dcStore.setVcenterDatacenterMany([{ vcenterId: 'vc-v', datacenterId: 'pl-waw' }]).changed, 1, '대소문자만 다르면 실제 id');
  assert.equal(dcStore.getDatacenterAssign()['vc-v'], 'PL-WAW');
  assert.equal(dcStore.setVcenterDatacenterMany([{ vcenterId: 'vc-w', datacenterId: 'ghost' }]).unknownDatacenter, 1);
  const src = stripComments(fs.readFileSync(new URL('../src/routes/admin/collectorsDc.js', import.meta.url), 'utf8'));
  assert.match(src, /adminRouter\.put\('\/datacenters\/assign', adminOnly, fullReadWriteScopeOnlyWith\(/);
  assert.equal((src.match(/listDatacenters\(\) \|\| \[\], dcMatchContext\(\)\)/g) || []).length, 2, '목록 · 매칭 저장 응답 모두 문맥으로');
  const web = fs.readFileSync(new URL('../../web/src/views/Collectors.jsx', import.meta.url), 'utf8');
  assert.match(web, /if \(!window\.confirm\(ch\.confirm\)\) return;/);
  assert.match(web, /onClick=\{\(\) => assignVcToDc\(c, ch\.toVcenter\)\}/);
  assert.match(web, /disabled=\{dcBusy\.has\(c\.id\)\} onClick=\{\(\) => assignVcToDc/);
  assert.match(web, /const fail = assignFailText\(r\);/);
});
