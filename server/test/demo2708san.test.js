/**
 * v2.708 데모(mock) SAN 스위치 그룹 — mock/demo/sanswitch.js 와 배선(sanswitch/poller·perfPoller·registry·store·routes).
 * 고정하는 것: ① 배치·CLI 출력이 결정적이고 실제 파서(buildSnapshot)·월간 점검(checkDevice)을 통과한다
 * ② 문제 포트(광량·장애·비활성)·조닝(이니시에이터↔타깃)·FC4 역할이 실제로 읽힌다 ③ mock 이 아니면 아무것도 하지 않는다
 * ④ 시드는 비어 있을 때만(mock-san- 접두) ⑤ live 폴러·수동 수집은 데모 장비를 건너뛴다 ⑥ 포트 사용량 백필이 합계 카드를 채운다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo2708-san-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'mock';

const demo = await import('../src/mock/demo/sanswitch.js');
const { setDataSource } = await import('../src/runtime-settings.js');
const { generateSnapshot } = await import('../src/mock/generator.js');
const fos = await import('../src/sanswitch/collectors/fosSsh.js');
const { checkDevice } = await import('../src/sanswitch/healthCheck.js');
const { sumArrayTraffic } = await import('../src/sanswitch/trafficTotal.js');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000; // 정시 −30분 — 경계에서 떨어뜨린 고정 기준(CLAUDE.md 규약)
const SNAP = generateSnapshot();

test('① 배치·출력은 결정적이고 법인마다 6/8/10대(팹 A/B 같은 수)', () => {
  const a = demo.planSanDemo(SNAP);
  const b = demo.planSanDemo(SNAP);
  assert.deepEqual(demo.sanDemoDevices(a, { now: NOW }), demo.sanDemoDevices(b, { now: NOW }));
  assert.equal(demo.sanDemoOutputs(a[3], NOW).out.porterrshow, demo.sanDemoOutputs(b[3], NOW).out.porterrshow);
  const byVc = new Map();
  for (const l of a) {
    if (!byVc.has(l.vcId)) byVc.set(l.vcId, { A: 0, B: 0 });
    byVc.get(l.vcId)[l.fabric]++;
    assert.ok(l.id.startsWith(demo.SAN_DEMO_PREFIX));
    assert.ok([48, 64, 96, 128].includes(l.P), `포트 수 ${l.P}`);
  }
  assert.equal(byVc.size, SNAP.vcenters.length, '법인(vCenter)마다');
  for (const [, c] of byVc) { assert.equal(c.A, c.B, '팹 A/B 쌍'); assert.ok([6, 8, 10].includes(c.A + c.B)); }
  const devs = demo.sanDemoDevices(a, { dcOf: (id) => `dc-${id}` });
  assert.equal(new Set(devs.map((d) => d.host)).size, devs.length, '관리 주소 중복 없음');
  assert.ok(devs.every((d) => d.datacenterId.startsWith('dc-') && d.type === 'brocade' && d.collectMethod === 'ssh'));
});

test('② 실제 파서·월간 점검을 통과한다 — 문제 포트·조닝·FC4 역할', () => {
  demo._resetSanDemoForTest();
  const L = demo.planSanDemo(SNAP);
  const devs = demo.sanDemoDevices(L);
  const verdict = { ok: 0, warn: 0, bad: 0 };
  let rxBad = 0; let faulty = 0; let disabled = 0; let rateSeen = false;
  for (let i = 0; i < devs.length; i++) {
    const s = demo.buildSanDemoSnapshot(devs[i], L[i], fos.buildSnapshot, NOW);
    assert.equal(s.ok, true);
    assert.equal(s.extra.demo, true);
    assert.ok(s.ports.online > 0 && s.ports.online < s.ports.licensed, `${s.name} 사용 ${s.ports.online}/${s.ports.licensed}`);
    assert.ok(s.ports.usedPct >= 30 && s.ports.usedPct <= 80, `사용률 ${s.ports.usedPct}`);
    for (const k of Object.keys(s.sections)) assert.equal(s.sections[k], 'ok', `${s.name} 섹션 ${k}`);
    assert.ok(s.zoning.available && s.zoning.zoneCount > 0, '조닝');
    const roles = new Set(Object.values(s.nsRoles));
    assert.ok(roles.has('initiator'), 'nsshow 이니시에이터');
    if (L[i].core) assert.ok(roles.has('target'), '코어는 어레이(타깃)를 가진다');
    const r = checkDevice(s, {});
    verdict[r.overall]++;
    assert.ok(r.items.every((x) => x.status !== 'unknown' || x.key === 'portErrors'), `${s.name} 확인 불가 항목 없음`);
    rxBad += s.ports.list.filter((p) => p.state === 'online' && p.rxPowerDbm != null && p.rxPowerDbm <= -12).length;
    faulty += s.ports.faulty; disabled += s.ports.disabled;
    if (s.ports.list.some((p) => p.inFps != null && p.inFps > 0)) rateSeen = true;
    // 링크 없는 포트는 광량 null(-inf) — 0 dBm 으로 오독하지 않는다
    assert.ok(s.ports.list.filter((p) => p.state === 'offline' && p.rxPowerDbm != null).length === 0);
  }
  assert.ok(verdict.ok > 0 && verdict.warn > 0 && verdict.bad > 0, `판정 분포 ${JSON.stringify(verdict)}`);
  assert.ok(rxBad > 0 && faulty > 0 && disabled > 0, `문제 포트 rx ${rxBad} 장애 ${faulty} 비활성 ${disabled}`);
  assert.ok(rateSeen, '첫 스냅샷부터 처리량(f/s)이 있다(직전 카운터로 한 번 조립)');
});

test('③ 포트 사용량은 결정적이고 어레이 합계 카드(sumArrayTraffic)가 값을 낸다', () => {
  const L = demo.planSanDemo(SNAP);
  const core = L.find((l) => l.core);
  assert.deepEqual(demo.sanDemoPortBps(core, NOW), demo.sanDemoPortBps(core, NOW));
  const v = Object.values(demo.sanDemoPortBps(core, NOW));
  assert.ok(v.length > 0 && v.every((x) => Number.isInteger(x) && x >= 0));
  const times = demo.sanDemoBackfillTimes(NOW);
  assert.ok(times.length > 150 && times[0] < NOW - 6 * 24 * HOUR && times.at(-1) < NOW);
  assert.deepEqual([...times].sort((x, y) => x - y), times, '오름차순');
  // 어레이 포트의 attached 이름은 '::' 벤더 표기 — storageKey/endpointKind 가 어레이로 분류한다
  const arrNames = core.ports.filter((p) => p.kind === 'array').map((p) => p.symb);
  assert.ok(arrNames.length >= 8 && arrNames.every((n) => n.includes('::')));
  const agg = { buckets: [NOW], series: [{ key: arrNames[0].split('::').slice(0, 2).join('::'), group: '', sum: [1e8], deviceIds: [core.id], partial: [] }] };
  const t = sumArrayTraffic(agg, { isArray: () => true, carryMs: 600_000 });
  assert.ok(t.now != null || t.total?.length, '합계가 계산된다');
});

test('④ mock 이 아니면 ensureSanDemo 는 아무것도 하지 않는다 · 시드는 비어 있을 때만', async () => {
  setDataSource('live');
  demo._resetSanDemoForTest();
  let called = 0;
  const registry = { listDevices: () => [], seedDemoDevices: () => { called++; return 1; } };
  assert.equal(demo.ensureSanDemo({ snapshot: SNAP, registry }), null, 'live 는 null');
  assert.equal(called, 0);
  assert.equal(demo.sanDemoStatus(), null);
  setDataSource('mock');
  demo._resetSanDemoForTest();
  const r = await demo.ensureSanDemo({ snapshot: SNAP, registry: { listDevices: () => [{ id: 'sw-real' }], seedDemoDevices: () => { called++; return 1; } } });
  assert.equal(r.seeded, 0, '등록부가 비어 있지 않으면 시드하지 않는다');
  assert.equal(called, 0);
  demo._resetSanDemoForTest();
  const w = await demo.ensureSanDemo({ snapshot: { vcenters: [] }, registry: { listDevices: () => [], seedDemoDevices: () => 1 } });
  assert.equal(w.waiting, true, '메인 스냅샷 전이면 기다린다(다음 호출 재시도)');
});

test('⑤ 실제 등록부·스토어·perfDb 로 시드 → 백필 → 조회', async () => {
  setDataSource('mock');
  demo._resetSanDemoForTest();
  const reg = await import('../src/sanswitch/registry.js');
  const store = await import('../src/sanswitch/store.js');
  const pdb = await import('../src/sanswitch/perfDb.js');
  const hh = await import('../src/sanswitch/healthHistory.js');
  const hc = await import('../src/sanswitch/healthCheck.js');
  // 데모 접두가 아닌 항목은 시드 함수가 받지 않는다
  assert.equal(reg.seedDemoDevices([{ id: 'sw-x', name: 'x' }]), 0);
  const actsLog = [];
  const r = await demo.ensureSanDemo({
    snapshot: SNAP, registry: { listDevices: reg.listDevices, seedDemoDevices: reg.seedDemoDevices },
    putSnapshot: store.putSnapshot, recordActivity: (e) => actsLog.push(e), buildSnapshot: fos.buildSnapshot,
    importSamples: pdb.importSamples, recordRun: hh.recordRun, checkDevice: hc.checkDevice, checkPorts: hc.checkPorts, retentionDays: 90, now: NOW,
  });
  assert.ok(r.seeded > 50, `시드 ${r.seeded}대`);
  assert.equal(reg.listDevices().length, r.seeded);
  assert.ok(reg.listDevices().every((d) => d.id.startsWith('mock-san-') && d.hasPassword));
  assert.equal(store.localSnapshots().length, r.seeded, '스냅샷 즉시 생성');
  assert.equal(actsLog.length, r.seeded, '작업 로그 1회분');
  // 다시 불러도 시드하지 않는다
  assert.equal((await demo.ensureSanDemo({ snapshot: SNAP, registry: { listDevices: reg.listDevices, seedDemoDevices: reg.seedDemoDevices } })).seeded, r.seeded);
  // 점검 이력 — 주 1회 6회(과거 시각 기록), 최신이 먼저
  const runs = await hh.listRuns(reg.listDevices()[0].id, 10);
  assert.equal(runs.runs.length, 6, '최근 6주 점검 이력');
  assert.ok(runs.runs[0].at > runs.runs[5].at && runs.runs[0].at < NOW, '과거 시각으로 기록');
  await demo.sanDemoBackfillDone();
  assert.equal(demo.sanDemoStatus().backfill, 'done');
  const ids = reg.listDevices().map((d) => d.id);
  const last = await pdb.latestSampleTs(ids);
  assert.equal(last.size, ids.length, '전 장비 표본');
  const agg = await pdb.storageSeriesMulti(ids.slice(0, 10), { hours: 24 });
  const arrays = agg.series.filter((s) => pdb.endpointKind(s.key) === 'array');
  assert.ok(arrays.length > 0, '어레이 시리즈');
  assert.ok(arrays.every((s) => s.avgTotal > 0));
});

test('⑥ live 폴러·수동 수집은 데모 장비를 건너뛴다(접속하지 않는다)', async () => {
  const poller = await import('../src/sanswitch/poller.js');
  const perf = await import('../src/sanswitch/perfPoller.js');
  setDataSource('live');
  try {
    const r = await poller.pollSanSwitchOnce({ manual: true });
    assert.equal(r.total, 0, 'live 는 mock-san- 장비를 수집 대상에서 뺀다');
    const p = await perf.pollPerfOnce({ force: true });
    assert.equal(p.total, 0);
    const reg = await import('../src/sanswitch/registry.js');
    await assert.rejects(() => poller.collectDeviceNow(reg.listDevices()[0].id), /live 모드에서 수집하지 않습니다/);
    assert.equal(perf.sanSwitchPerfStatus().enabled, false, 'live 는 저장 설정(꺼짐) 그대로');
    assert.equal(await poller.ensureSanSwitchDemo(), null);
  } finally { setDataSource('mock'); }
  assert.equal(perf.sanSwitchPerfStatus().enabled, true, 'mock 은 켜진 것처럼');
  const m = await poller.pollSanSwitchOnce({ manual: true });
  assert.ok(m.collected > 50 && m.failed === 0, `mock 수집 ${m.collected}/${m.failed}`);
});
