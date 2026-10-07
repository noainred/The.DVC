/**
 * v2.708 데모(mock) iDRAC·베어메탈 그룹 — mock/demo/idrac.js · mock/demo/baremetal.js 와 배선
 * (idrac/poller.js mock 분기 · seed.js 서비스태그 · bmusage 판정 지점 · partfault 스위치).
 * 고정하는 것: ① 합성 값의 결정성·정직 규칙(텔레메트리 없는 서버는 cpu null · 디스크 busy 는 iDRAC 경로에 없음)
 * ② mock 이 아니면 아무것도 하지 않는다 ③ 시드는 비어 있을(mock 항목뿐일) 때만 ④ 서비스태그 충돌 보정은 mock- 항목만.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo2708-idrac-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'mock';

const demo = await import('../src/mock/demo/idrac.js');
const bm = await import('../src/mock/demo/baremetal.js');
const { setDataSource } = await import('../src/runtime-settings.js');
const reg = await import('../src/idrac/registry.js');
const { extractIdracParts } = await import('../src/partfault/extract/idrac.js');
const { summarizeSensors } = await import('../src/idrac/sensorDetail.js');
const { bmUsageEnabled } = await import('../src/bmusage/settings.js');
const { partFaultEnabled } = await import('../src/partfault/settings.js');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000; // 정시 −30분 고정 기준(CLAUDE.md 규약)

const SNAP = {
  vcenters: ['vc-a', 'vc-b', 'vc-c', 'vc-d', 'vc-e', 'vc-f'].map((id) => ({ id, name: id })),
  hosts: [{ id: 'vc-a:esxi-a-01', vcenterId: 'vc-a', name: 'esxi-a-01', vendor: 'Dell Inc.', model: 'PowerEdge R740', cpuSockets: 2, cpuCores: 32, memTotalMB: 524288, cpuModel: 'Intel(R) Xeon(R) Gold 6230', gpus: [{ model: 'NVIDIA T4' }] }],
};

test('① 합성 값 — 결정적이고 실장비 모양·정직 규칙을 지킨다', () => {
  const server = { id: 'mock-idrac-vc-a-esxi-a-01', name: 'esxi-a-01', vcenterId: 'vc-a', serviceTag: demo.mockServiceTag('vc-a|esxi-a-01'), hostNames: ['esxi-a-01'] };
  const p = demo.demoServerProfile(server, { host: SNAP.hosts[0] });
  assert.deepEqual(p, demo.demoServerProfile(server, { host: SNAP.hosts[0] }), '같은 입력 = 같은 프로필');
  assert.deepEqual(p.gpus, ['NVIDIA T4'], 'ESXi 호스트의 GPU 를 그대로 받친다');
  const r1 = demo.demoSensorReadingAt(p, NOW); const r2 = demo.demoSensorReadingAt(p, NOW);
  assert.deepEqual(r1, r2, '같은 시각 = 같은 판독');
  const inlet = r1.temps.find((t) => /Inlet/.test(t.name)).celsius;
  assert.ok(inlet > 14 && inlet < 33, `흡기 ${inlet}`);
  assert.ok(r1.temps.some((t) => /^GPU1 Temp$/.test(t.name)), 'GPU 온도 센서');
  // Datacenter 가 아니면 텔레메트리 CPU 는 없다(null) — 지어내지 않는다. Sensors 컬렉션에는 CPU Usage 센서가 있다.
  const pe = { ...p, license: 'enterprise' };
  assert.equal(demo.demoSensorReadingAt(pe, NOW).cpuUsagePct, null);
  const coll = demo.demoSensorCollection(pe, NOW);
  assert.ok(summarizeSensors(coll.sensors).sensorCpuUsagePct != null, '컬렉션 CPU 사용률 센서');
  const th = demo.demoThermalDetail(r1);
  assert.ok(th.length >= 8 && th.every((s) => s.state === 'ok'), 'Thermal 상세 — 임계값 기반 정상');
  // 인벤토리 — 파트 장애 추출이 읽는 모양
  const inv = demo.demoInventory(server, p, NOW);
  assert.deepEqual(inv, demo.demoInventory(server, p, NOW));
  const ex = extractIdracParts(server, inv);
  assert.equal(ex.reachable, true);
  assert.deepEqual(ex.failedKinds, []);
  assert.ok(ex.parts.length > 20, `파트 ${ex.parts.length}개`);
  assert.equal(inv.gpus.length, 1);
});

test('① 장애 계획 — 일부 서버만, 하나는 시간에 따라 열렸다 닫힌다', () => {
  const ids = Array.from({ length: 300 }, (_, i) => `mock-idrac-x-${i}`);
  const plans = ids.map((id) => demo.demoFaultPlan(id, NOW));
  const bad = plans.filter((p) => p.disk || p.psu || p.dimm || p.fan).length;
  assert.ok(bad > 10 && bad < 120, `장애 서버 ${bad}/300`);
  const flip = ids.find((id) => demo.demoFaultPlan(id, NOW).fan || demo.demoFaultPlan(id, NOW + 6 * HOUR).fan);
  assert.ok(flip, '팬 장애가 오락가락하는 서버가 있다');
  assert.notDeepEqual(demo.demoFaultPlan(flip, NOW).fan, demo.demoFaultPlan(flip, NOW + 6 * HOUR).fan);
});

test('① 서비스태그 — 7자 · 500개 고유(seed.js 초판의 충돌 재발 방지)', () => {
  const tags = Array.from({ length: 500 }, (_, i) => demo.mockServiceTag(`vc-${i % 11}|esxi-${i}`));
  assert.ok(tags.every((t) => /^M[0-9A-Z]{6}$/.test(t)), tags[0]);
  assert.equal(new Set(tags).size, 500);
});

test('① 베어메탈 사양·사용률 행 — 결정적, ESXi 이름과 겹치지 않고, OS 경로 전용 값은 비운다', () => {
  const specs = bm.demoBareMetalSpecs(SNAP);
  assert.ok(specs.length >= 10 && specs.length <= 20, `${specs.length}대`);
  assert.ok(specs.every((s) => s.id.startsWith('mock-bmsrv-') && !/^esxi/.test(s.name)));
  assert.ok(specs.some((s) => !s.vcenterId), '법인 귀속 없는 서버도 있다');
  assert.ok(specs.some((s) => s.gpus.length), 'GPU 서버');
  assert.deepEqual(bm.demoBareMetalSpecs(SNAP), specs);
  const tg = { key: specs[0].serviceTag, serverId: specs[0].id, name: specs[0].name, vcenterId: specs[0].vcenterId };
  const row = bm.demoBmUsageRow(tg, NOW);
  assert.deepEqual(row, bm.demoBmUsageRow(tg, NOW));
  assert.equal(row.src, 'idrac+demo'); // v2.719 R1-03: 데모 행 표지
  assert.ok(row.cpu_pct >= 0 && row.cpu_pct <= 100 && row.mem_pct > 0);
  assert.equal(row.disk_busy_pct, null, '디스크 busy 는 iDRAC 경로에 없다 — 지어내지 않는다');
  assert.equal(row.disk_used_pct, null);
});

test('② mock 이 아니면 아무것도 하지 않는다(판정 지점·폴 틱·시드)', async () => {
  assert.equal(setDataSource('live').ok, true);
  try {
    bm._resetBareMetalDemoForTest(); demo._resetIdracDemoForTest();
    assert.equal(await demo.mockIdracDemoTick(SNAP, { now: NOW }), null);
    assert.equal((await bm.ensureBareMetalSeed(SNAP)).skipped, 'not-mock');
    assert.equal((await bm.repairMockServiceTags()).skipped, 'not-mock');
    assert.equal(reg.loadRegistry().length, 0, 'live 에서는 시드하지 않는다');
    const saved = { enabled: false, corps: {} };
    assert.equal(bm.demoBmSettings(saved, SNAP.vcenters), saved, '설정을 덮지 않는다');
    assert.equal(bmUsageEnabled(), false, '사용률 수집은 저장값(꺼짐) 그대로');
    assert.equal(partFaultEnabled().enabled, false, '파트 장애는 저장값(꺼짐) 그대로');
    assert.deepEqual([...await demo.demoPowerNow(SNAP, NOW)], []);
  } finally { setDataSource('mock'); }
  // mock 이면 판정 지점만 켜진 것처럼(설정 파일은 바꾸지 않는다)
  assert.equal(bmUsageEnabled(), true);
  assert.equal(partFaultEnabled().source, 'demo');
  const ds = bm.demoBmSettings({ enabled: false, corps: {} }, SNAP.vcenters);
  assert.equal(ds.enabled, true); assert.equal(ds.corps['vc-a'], true); assert.equal(ds.demo, true);
  assert.equal(fs.existsSync(path.join(TMP, 'bmusage-settings.json')), false, '설정 파일을 만들지 않는다');
});

test('③ 베어메탈 시드 — mock 항목뿐일 때만 · 실등록이 있으면 하지 않는다 · 서비스태그 충돌은 mock- 만 보정', async () => {
  bm._resetBareMetalDemoForTest();
  // 실등록이 있으면 시드하지 않는다
  assert.equal(reg.addServer({ id: 'real-1', name: 'real-1', host: '10.9.9.9', username: 'root', password: 'x', serviceTag: 'DUP0001' }).ok, true);
  assert.equal((await bm.ensureBareMetalSeed(SNAP)).skipped, 'real-entries');
  // mock- 두 항목이 실등록과 같은 태그를 공유 — mock- 만 고친다
  for (const n of ['a', 'b']) reg.addServer({ id: `mock-idrac-vc-a-${n}`, name: n, host: `10.9.9.${n === 'a' ? 1 : 2}`, username: 'root', password: 'mock', vcenterId: 'vc-a', serviceTag: 'DUP0001' });
  const r = await bm.repairMockServiceTags();
  assert.equal(r.fixed, 2);
  const after = reg.loadRegistry();
  assert.equal(after.find((s) => s.id === 'real-1').serviceTag, 'DUP0001', '실등록 태그는 그대로');
  const mt = after.filter((s) => s.id.startsWith('mock-')).map((s) => s.serviceTag);
  assert.equal(new Set(mt).size, 2); assert.ok(!mt.includes('DUP0001'));
  // 실등록을 지우면(mock 항목뿐) 시드한다 — 한 번만
  reg.removeServer('real-1');
  bm._resetBareMetalDemoForTest();
  const s1 = await bm.ensureBareMetalSeed(SNAP);
  assert.ok(s1.added >= 10, JSON.stringify(s1));
  bm._resetBareMetalDemoForTest();
  assert.equal((await bm.ensureBareMetalSeed(SNAP)).skipped, 'exists');
  assert.equal(reg.loadRegistry().filter((s) => s.id.startsWith('mock-bmsrv-')).length, s1.added);
});

test('③ mock 폴 틱 — 센서·센서 상세·인벤토리를 실제 저장소에 채운다(장비 접속 없음)', async () => {
  demo._resetIdracDemoForTest();
  const out = await demo.mockIdracDemoTick(SNAP, { now: Date.now() });
  assert.ok(out.servers >= 10 && out.demo === true, JSON.stringify(out));
  const { getSensorSeries } = await import('../src/idrac/sensorStore.js');
  const { getInventory } = await import('../src/idrac/invCache.js');
  const { localSensorDetail } = await import('../src/idrac/sensorDetailCache.js');
  const id = reg.loadRegistry().find((s) => s.id.startsWith('mock-bmsrv-')).id;
  const ser = getSensorSeries(id);
  assert.ok(ser.count > 200, `24시간 백필 + 현재 표본 ${ser.count}`);
  assert.ok(Object.keys(ser.latest.temps).some((n) => /Inlet/.test(n)));
  assert.equal(getInventory(id).reachable, true);
  assert.ok(localSensorDetail(id).list.length >= 10);
  const pw = await demo.demoPowerNow(SNAP, Date.now());
  assert.ok(pw.get(id) > 300, `전력 ${pw.get(id)}`);
});

test('④ live 폴러는 mock- 항목을 건너뛴다(소스 고정)', () => {
  const src = fs.readFileSync(new URL('../src/idrac/poller.js', import.meta.url), 'utf8');
  assert.match(src, /!String\(s\.id\)\.startsWith\('mock-'\)/);
  assert.match(src, /if \(isMockMode\(\)\) \{[\s\S]{0,1500}mockIdracDemoTick[\s\S]{0,400}return;/);
});
