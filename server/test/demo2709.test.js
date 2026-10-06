/**
 * v2.709 데모(mock) 2차 — Isilon OneFS 영역 원문 · 서버 분석 '미지원 서버'.
 * 고정: ① 영역 결과가 실제 수집기와 같은 모양(엔드포인트 단위 results + 영역 단위 summary, 비활성 영역은 skipped)
 * ② 결정적(같은 장비 = 같은 결과) ③ 미지원 서버 시드는 mock 이고 저장소가 비었을 때만 ④ mock 이 아니면 아무것도 하지 않는다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo2709-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'mock';

const storage = await import('../src/mock/demo/storage.js');
const cat = await import('../src/storage/onefsCatalog.js');
const idrac = await import('../src/mock/demo/idrac.js');
const unsup = await import('../src/central/unsupportedServers.js');
const { setDataSource } = await import('../src/runtime-settings.js');

const DEV = { id: 'mock-st-ps-sel-01', type: 'isilon', name: 'PS-SEL-01' };
const SNAP = { vcenters: [{ id: 'vc-ap-northeast' }, { id: 'vc-eu-central' }] };

test('① 영역 결과는 수집기와 같은 모양이고 전 영역을 덮는다', () => {
  const on = cat.enabledAreas(); const off = cat.ONEFS_AREAS.filter((a) => a.enabled === false);
  const r = storage.demoIsilonAreas(DEV, on, off);
  const eps = on.reduce((n, a) => n + a.endpoints.length, 0);
  assert.equal(r.results.length, eps);
  assert.equal(r.endpoints, eps);
  assert.equal(r.summary.length, on.length + off.length);
  for (const s of r.summary.filter((x) => x.skipped)) assert.ok(s.error, '비활성 영역은 사유를 싣는다');
  const ok = r.results.filter((x) => x.ok);
  assert.ok(ok.length > 0 && ok.every((x) => x.data && x.data.demo === true), '원문은 데모 표지를 싣는다');
  const bad = r.results.filter((x) => !x.ok);
  assert.ok(bad.length > 0 && bad.every((x) => /404/.test(x.error)), '일부 실패 경로가 보인다');
  for (const s of r.summary.filter((x) => !x.skipped)) {
    const mine = r.results.filter((x) => x.area === s.area);
    assert.equal(s.ok + s.failed, mine.length);
  }
});

test('② 결정적', () => {
  const a = storage.demoIsilonAreas(DEV, cat.enabledAreas());
  const b = storage.demoIsilonAreas(DEV, cat.enabledAreas());
  assert.deepEqual(a.summary, b.summary);
});

test('③ 미지원 서버 시드 — 비었을 때만 1회, 실제 결과가 있으면 건드리지 않는다', async () => {
  idrac._resetIdracDemoForTest(); unsup._resetUnsupportedForTest();
  // 법인 할당 전에는 시드하지 않는다(vCenter id 를 법인 칸에 지어 넣지 않는다)
  assert.equal((await idrac.ensureUnsupportedDemo(SNAP)).skipped, 'no-corp-yet');
  const dcs = await import('../src/datacenter/store.js');
  dcs.ensureDatacenter({ id: 'dc-t1', name: 'T1' });
  dcs.setVcenterDatacenterMany(SNAP.vcenters.map((v) => ({ vcenterId: v.id, datacenterId: 'dc-t1' })));
  const r = await idrac.ensureUnsupportedDemo(SNAP);
  assert.ok(r.added > 0);
  const list = unsup.listUnsupportedServers();
  assert.equal(list.total, r.added);
  assert.ok(list.rows.some((x) => x.vendor === 'hpe' && x.noCreds), 'iLO 계정 없음 경로가 보인다');
  assert.ok(list.rows.every((x) => x.vendor !== 'dell'), '미지원 목록에 Dell 은 없다');
  assert.ok(list.rows.every((x) => x.datacenterId === 'dc-t1'), '법인 칸은 할당된 DataCenter 다');
  // 다시 불러도 늘지 않는다
  idrac._resetIdracDemoForTest();
  const again = await idrac.ensureUnsupportedDemo(SNAP);
  assert.equal(again.skipped, 'exists');
  assert.equal(unsup.listUnsupportedServers().total, r.added);
});

test('④ mock 이 아니면 시드하지 않는다', async () => {
  setDataSource('live');
  try {
    idrac._resetIdracDemoForTest();
    const r = await idrac.ensureUnsupportedDemo(SNAP);
    assert.ok(r.skipped);
  } finally { setDataSource('mock'); }
});

test('⑤ 데모 법인 할당 — mock vCenter 만, 엣지 DataCenter 우선, 기존 할당은 그대로', async () => {
  const dcs = await import('../src/datacenter/store.js');
  const { demoCorps } = await import('../src/mock/demo/pdu.js');
  const { generateSnapshot } = await import('../src/mock/generator.js');
  const snap = generateSnapshot();
  const vcs = snap.vcenters.slice(0, 3);
  // 사람이 만든 법인·할당 하나 + 사람이 등록한 vCenter 하나
  dcs.ensureDatacenter({ id: 'human-dc', name: 'Human DC' });
  dcs.setVcenterDatacenterMany([{ vcenterId: vcs[0].id, datacenterId: 'human-dc' }]);
  const real = { id: 'vc-real-01', name: 'vcenter-real-01', location: { city: 'Nowhere' } };
  await demoCorps({ vcenters: [...vcs, real] });
  const a = dcs.getDatacenterAssign();
  assert.equal(a[vcs[0].id], 'human-dc', '기존 할당은 바꾸지 않는다');
  assert.ok(a[vcs[1].id] && a[vcs[2].id], 'mock vCenter 는 할당된다');
  assert.equal(a[real.id], undefined, '사람이 등록한 vCenter 는 할당하지 않는다');
});
