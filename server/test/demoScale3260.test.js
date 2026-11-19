/**
 * v3.26.0 — 데모(mock) 시연 규모(사용자 요청 2026-11-19 "30개 · 물리 서버 1,200대 중 650대 가상화 · 나머지 베어메탈 ·
 * 스토리지·네트워크·모니터링 전부"). 선택: 기본 데모를 교체 · 데이터센터 30곳(vCenter 20 + vCenter 없는 10) · VM 약 6,000대.
 *
 * 고정하는 것
 *  ① 생성기: vCenter 20 · ESXi 650 · VM 5,500~6,500 · 베어메탈 전용 법인 10곳 · 호스트 수는 17의 배수가 아니다(첫 호스트 VM 이 전부 템플릿이 된다)
 *  ② 베어메탈 사양 550대 = 사이트 표 310 + 베어메탈 전용 240 · id·이름·서비스태그 고유 · ESXi 와 겹치지 않음 · v2.708 id 유지
 *  ③ 물리 서버 합 = 650 + 550 = 1,200
 *  ④ 법인 30곳 전부에 스토리지 · 법인 코드 고유 · CVP 6대 · Monitoring 대상이 vCenter 20곳 전부 + 베어메탈 전용 법인을 덮는다
 *  ⑤ 보충(top-up): 데모 장비뿐일 때만 없는 id 를 덧붙이고, 사람이 등록한 장비가 있으면 아무것도 하지 않는다(등록부 5종 + iDRAC)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-scale-2915-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
delete process.env.MOCK_SCALE;

const gen = await import('../src/mock/generator.js');
const idracDemo = await import('../src/mock/demo/idrac.js');
const bm = await import('../src/mock/demo/baremetal.js');
const storageDemo = await import('../src/mock/demo/storage.js');
const { withCodes } = await import('../src/mock/demo/pdu.js');
const { demoCvpServers } = await import('../src/mock/demo/cvp.js');
const { demoSvcmonTargets } = await import('../src/mock/demo/svcmon.js');

const SNAP = gen.generateSnapshot();

test('① 생성기 — vCenter 20 · ESXi 650 · VM 약 6,000 · 베어메탈 전용 법인 10곳', () => {
  assert.equal(SNAP.vcenters.length, 20);
  assert.equal(SNAP.hosts.length, 650);
  assert.ok(SNAP.vms.length >= 5_500 && SNAP.vms.length <= 6_500, `VM ${SNAP.vms.length}대`);
  assert.equal(gen.BM_ONLY_SITES.length, 10);
  assert.equal(new Set(gen.BM_ONLY_SITES.map((s) => s.slug)).size, 10);
  // 앞 11개 id 는 v2.914 까지와 같다(데모 모듈·이미 시드된 설치본이 묶여 있다)
  const ids = SNAP.vcenters.map((v) => v.id);
  for (const id of ['vc-us-east', 'vc-us-west', 'vc-br-sao', 'vc-eu-central', 'vc-eu-west', 'vc-me-uae', 'vc-ap-northeast', 'vc-ap-southeast', 'vc-ap-south', 'vc-cn-east', 'vc-cn-north']) {
    assert.ok(ids.includes(id), id);
  }
  // 호스트 수가 17의 배수면 첫 호스트의 VM 이 전부 템플릿(idx % 17 === 0)이 된다 — GPU VM 0대 호스트가 생긴다.
  const per = new Map();
  for (const h of SNAP.hosts) per.set(h.vcenterId, (per.get(h.vcenterId) || 0) + 1);
  for (const [vc, n] of per) assert.notEqual(n % 17, 0, `${vc} 호스트 ${n}대`);
  // VM IP 둘째 옥텟 = 위도 반올림(mkIp) — 사이트끼리 겹치면 법인 사이에 같은 IP 가 생긴다(처음 넣은 런던 51.51 이 바르샤바 52 와 겹쳤다)
  const oct = SNAP.vcenters.map((v) => Math.abs(Math.round(v.location.lat)) % 250);
  assert.equal(new Set(oct).size, oct.length, `IP 대역 옥텟 겹침: ${oct.join(',')}`);
  // 모든 vCenter 이름·id 는 목 vCenter 로 인식된다(엣지 push 봉인 v2.257 · 빈 인벤토리 판정 v2.560)
  assert.ok(SNAP.vcenters.every((v) => gen.isMockVcenter(v)));
});

test('② 베어메탈 550대 — 고유하고 ESXi 와 겹치지 않으며 v2.708 의 id 를 유지한다', () => {
  const specs = idracDemo.demoBareMetalSpecs(SNAP);
  assert.equal(specs.length, 550);
  assert.equal(new Set(specs.map((s) => s.id)).size, 550, 'id 고유');
  assert.equal(new Set(specs.map((s) => s.name)).size, 550, '이름 고유');
  assert.equal(new Set(specs.map((s) => s.serviceTag)).size, 550, '서비스태그 고유');
  const esx = new Set(SNAP.hosts.map((h) => h.name));
  const esxTags = new Set(SNAP.hosts.map((h) => h.serviceTag));
  assert.equal(specs.filter((s) => esx.has(s.name) || esxTags.has(s.serviceTag)).length, 0, 'ESXi 호스트와 이름·태그가 겹치지 않는다');
  const dcOnly = specs.filter((s) => s.datacenterId);
  assert.equal(dcOnly.length, 240, 'vCenter 없는 법인 240대');
  assert.ok(dcOnly.every((s) => !s.vcenterId && /^dc-[a-z]+$/.test(s.datacenterId)));
  assert.equal(new Set(dcOnly.map((s) => s.datacenterId)).size, 10);
  // v2.708 이 시드한 id(이미 시드된 데모 설치본) — 모든 vCenter 의 db01 · 앞 4곳 gpu01 · 앞 2곳 법인 귀속 없는 app01
  const byId = new Map(specs.map((s) => [s.id, s]));
  SNAP.vcenters.forEach((vc, i) => {
    assert.ok(byId.has(`mock-bmsrv-${vc.id}-db01`), `${vc.id} db01`);
    assert.equal(byId.has(`mock-bmsrv-${vc.id}-gpu01`), i < 4);
    const app = byId.get(`mock-bmsrv-${vc.id}-app01`);
    if (i < 2) assert.equal(app.vcenterId, '', '앞 2곳 app01 은 법인 귀속 없음');
  });
  assert.ok(specs.some((s) => s.gpus.length >= 8), 'GPU 8장 학습 서버(XE9680)');
  assert.deepEqual(idracDemo.demoBareMetalSpecs(SNAP), specs, '결정적');
});

test('③ 물리 서버 합 = ESXi 650 + 베어메탈 550 = 1,200대', () => {
  assert.equal(SNAP.hosts.length + idracDemo.demoBareMetalSpecs(SNAP).length, 1_200);
});

test('④ 법인 30곳 전부에 스토리지 · 법인 코드 고유 · CVP 6대 · Monitoring 이 전 사이트를 덮는다', () => {
  const devs = storageDemo.demoStorageDevices();
  const where = new Set(devs.map((d) => d.datacenterId));
  for (const vc of SNAP.vcenters) assert.ok(where.has(vc.id), `${vc.id} 스토리지`);
  for (const s of gen.BM_ONLY_SITES) assert.ok(where.has(`dc-${s.slug}`), `dc-${s.slug} 스토리지`);
  const corps = [...SNAP.vcenters.map((v) => ({ id: `dc-${v.location.city.toLowerCase()}`, name: `${v.location.city} 법인` })),
    ...gen.BM_ONLY_SITES.map((s) => ({ id: `dc-${s.slug}`, name: `${s.city} 법인` }))];
  assert.equal(corps.length, 30);
  const coded = withCodes(corps);
  assert.equal(new Set(coded.map((c) => c.code)).size, 30, `코드 고유: ${coded.map((c) => c.code).join(',')}`);
  assert.ok(coded.every((c) => /^[A-Z0-9]{3}$/.test(c.code)));
  assert.equal(demoCvpServers(coded).length, 6);
  assert.equal(demoCvpServers(coded.slice(0, 11)).length, 3, '법인 11곳이면 예전처럼 3대');
  const t = demoSvcmonTargets(SNAP);
  for (const vc of SNAP.vcenters) assert.ok(t.some((x) => x.name === `${vc.name} (vCenter)`), `${vc.name} 점검 대상`);
  for (const s of gen.BM_ONLY_SITES) assert.ok(t.some((x) => x.path.endsWith(s.city)), `${s.city} 점검 대상`);
});

test('⑤ 보충 — 데모 장비뿐일 때만 없는 id 를 덧붙이고, 사람이 등록한 장비가 있으면 아무것도 하지 않는다', async () => {
  const st = await import('../src/storage/registry.js');
  const all = storageDemo.demoStorageDevices();
  assert.equal(st.seedDevicesIfEmpty(all.slice(0, 17)).seeded, 17);
  assert.equal(st.topUpDemoDevices(all).added, all.length - 17);
  assert.equal(st.topUpDemoDevices(all).added, 0, '두 번째는 덧붙일 것이 없다');
  for (const d of st.listDevices()) st.deleteDevice(d.id);
  const real = st.saveDevice({ type: 'unity480', name: 'REAL-01', host: '10.9.9.9', username: 'admin', password: 'x' });
  assert.equal(st.topUpDemoDevices(all).reason, 'real-entries');
  assert.equal(st.listDevices().length, 1, '사람이 등록한 장비만 남는다');
  st.deleteDevice(real.id);

  const bmReg = await import('../src/bmstor/registry.js');
  const bms = storageDemo.demoBmServers();
  assert.equal(bmReg.seedBmServersIfEmpty(bms.slice(0, 11)).seeded, 11);
  assert.equal(bmReg.topUpDemoBmServers(bms).added, bms.length - 11);

  const pdu = await import('../src/pdu/registry.js');
  const pduDevs = [1, 2, 3].map((i) => ({ id: `mock-pdu-x-${i}`, name: `PDU-X-${i}`, host: `10.0.0.${i}`, username: 'apc', password: 'mock', datacenterId: 'dc-x' }));
  assert.equal(pdu.seedDemoDevices(pduDevs.slice(0, 1)).ok, true);
  assert.equal(pdu.topUpDemoDevices(pduDevs).count, 2);
  assert.equal(pdu.listDevices().length, 3);

  const cvp = await import('../src/cvp/registry.js');
  const cvpList = demoCvpServers(withCodes(Array.from({ length: 30 }, (_, i) => ({ id: `dc-${i}`, name: `C${i} 법인` }))));
  assert.equal(cvp.seedDemoServers(cvpList.slice(0, 3)).ok, true);
  const up = cvp.topUpDemoServers(cvpList);
  assert.deepEqual(up.added, cvpList.slice(3).map((x) => x.id));

  const san = await import('../src/sanswitch/registry.js');
  const sanDevs = [1, 2].map((i) => ({ id: `mock-san-x-${i}`, name: `X-SAN-${i}`, host: `10.0.1.${i}`, username: 'admin', password: 'mock' }));
  assert.equal(san.seedDemoDevices(sanDevs.slice(0, 1)), 1);
  assert.deepEqual(san.topUpDemoDevices(sanDevs), ['mock-san-x-2']);
  assert.deepEqual(san.topUpDemoDevices(sanDevs), [], '이미 있으면 덧붙이지 않는다');
});

test('⑤ iDRAC 베어메탈 보충 — v2.914 이전 규모(17대)면 빠진 것만, 절반 이상이면 그대로, 실등록이 있으면 하지 않는다', async () => {
  const reg = await import('../src/idrac/registry.js');
  const specs = idracDemo.demoBareMetalSpecs(SNAP);
  // 예전 규모 흉내 — v2.708 이 시드한 17대(모든 vCenter 의 db01 중 일부 등)
  const legacy = specs.filter((s) => /-(db|gpu|app)01$/.test(s.id) && s.homeVc).slice(0, 17);
  const r0 = reg.importServers(legacy.map((s) => ({ id: s.id, name: s.name, host: s.host, username: 'root', password: 'mock', vcenterId: s.vcenterId, serviceTag: s.serviceTag, hostNames: [s.name] })), 'merge');
  assert.equal(r0.added, 17);
  bm._resetBareMetalDemoForTest();
  const r1 = await bm.ensureBareMetalSeed(SNAP);
  assert.equal(r1.added, 550 - 17);
  const list = reg.loadRegistry();
  assert.equal(list.filter((s) => s.id.startsWith('mock-bmsrv-')).length, 550);
  assert.equal(list.find((s) => s.id === 'mock-bmsrv-dc-ulsan-mesdb01')?.datacenterId, 'dc-ulsan', 'vCenter 없는 법인 귀속');
  bm._resetBareMetalDemoForTest();
  assert.equal((await bm.ensureBareMetalSeed(SNAP)).skipped, 'exists', '이미 규모가 맞으면 다시 하지 않는다');
  // 사람이 등록한 서버가 있으면 아무것도 하지 않는다
  reg.deleteServers({ all: true });
  assert.equal(reg.addServer({ id: 'real-1', name: 'real-1', host: '10.9.9.9', username: 'root', password: 'x' }).ok, true);
  bm._resetBareMetalDemoForTest();
  assert.equal((await bm.ensureBareMetalSeed(SNAP)).skipped, 'real-entries');
  assert.equal(reg.loadRegistry().length, 1);
});
