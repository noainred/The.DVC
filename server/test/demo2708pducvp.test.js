/**
 * v2.708 데모(mock) PDU·CVP 그룹 — mock/demo/pdu.js · mock/demo/cvp.js 와 배선(pdu/poller · cvp/poller · 등록부 시드).
 * 고정하는 것: ① 합성 값의 결정성·정직 규칙(실패 스냅샷 수치 없음·누적 kWh 단조 증가·처리량 합성)
 * ② 시드는 비어 있을 때만 ③ mock 이면 폴러가 합성 결과를 DB 에 적재하고 장애 판정이 열린 장애를 갖는다
 * ④ mock 이 아니면 데모가 아무것도 하지 않고 live 폴러는 mock- 항목에 접속하지 않는다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo2708-pducvp-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'mock';

const pduDemo = await import('../src/mock/demo/pdu.js');
const cvpDemo = await import('../src/mock/demo/cvp.js');
const { setDataSource } = await import('../src/runtime-settings.js');
const pduReg = await import('../src/pdu/registry.js');
const pduPoller = await import('../src/pdu/poller.js');
const pduDb = await import('../src/pdu/db.js');
const { summarize } = await import('../src/pdu/types.js');
const cvpReg = await import('../src/cvp/registry.js');
const cvpPoller = await import('../src/cvp/poller.js');
const cvpDb = await import('../src/cvp/db.js');
const P = await import('../src/cvp/parse.js');
const { runCvpFaultScan } = await import('../src/cvp/faultScan.js');
const { observeDevice } = await import('../src/cvp/faults.js');

const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000; // 정시 −30분(경계에서 떨어뜨린 고정 기준)
const CORPS = [{ id: 'dc-seoul', name: 'Seoul 법인', code: 'SEO' }, { id: 'dc-ashburn', name: 'Ashburn 법인', code: 'ASH' }, { id: 'dc-frankfurt', name: 'Frankfurt 법인', code: 'FRA' }];

test('① PDU 합성 스냅샷 — 결정적, 법인당 4~8대, 실패 스냅샷은 수치 없음, kWh 단조 증가', () => {
  const devs = CORPS.flatMap(pduDemo.demoPduDevicesFor);
  for (const c of CORPS) { const n = devs.filter((d) => d.datacenterId === c.id).length; assert.ok(n >= 4 && n <= 8, `${c.id} ${n}대`); }
  assert.ok(devs.every((d) => d.id.startsWith('mock-pdu-')), 'id 는 mock- 접두');
  for (const d of devs) assert.equal(pduReg.deviceInputIssue(d), null, `${d.name} 등록 검증 통과`);
  const a = devs.map((d) => pduDemo.demoPduSnapshot(d, NOW));
  assert.deepEqual(a, devs.map((d) => pduDemo.demoPduSnapshot(d, NOW)), '같은 입력 = 같은 출력');
  assert.ok(a.every((s) => s.demo === true));
  for (const s of a.filter((x) => x.ok)) {
    assert.ok(s.units.length >= 1 && s.sensors.length >= 1);
    const later = pduDemo.demoPduSnapshot({ id: s.id }, NOW + 3_600_000);
    if (later.ok) assert.ok(later.units[0].energyKwh > s.units[0].energyKwh, '누적 kWh 는 시간에 증가');
    assert.ok(summarize(s).powerW > 0);
  }
  // 실패 장비는 값을 지어내지 않는다 — 전 장비 중 실패가 있으면 수치가 비어 있어야 한다.
  const many = Array.from({ length: 400 }, (_, i) => pduDemo.demoPduSnapshot({ id: `mock-pdu-x-${i}` }, NOW));
  const failed = many.filter((s) => !s.ok);
  assert.ok(failed.length >= 1, '실패 장비가 섞인다');
  for (const f of failed) { assert.equal(f.units.length, 0); assert.equal(summarize(f).powerW, null, '실패 = 전력 null(0 W 거짓 금지)'); }
  const bt = pduDemo.backfillTimes(NOW);
  assert.ok(bt[0] <= NOW - 29 * 86_400_000 && bt.at(-1) < NOW, '30일 백필 · 미래 없음');
});

test('② PDU 시드는 비어 있을 때만 · mock 폴러는 합성 결과를 적재한다', async () => {
  const devs = CORPS.flatMap(pduDemo.demoPduDevicesFor);
  assert.equal(pduReg.seedDemoDevices(devs).ok, true);
  assert.equal(pduReg.seedDemoDevices(devs).ok, false, '두 번째 시드는 거부(비어 있을 때만)');
  assert.equal(pduReg.listDevices().length, devs.length);
  const n = await pduDb.recordSnapshots(pduDemo.backfillTimes(NOW).slice(-6).map((t) => pduDemo.demoPduSnapshot(devs[0], t)));
  assert.equal(n, 6);
  const r = await pduPoller.pollOnce();
  assert.equal(r.ok, true);
  assert.equal(r.collected + r.failed, devs.length, '전 장비를 합성 수집(접속 0)');
  assert.ok(r.collected >= devs.length - 2);
  const ps = await pduDb.powerSeries([devs[0].id], { hours: 24 });
  assert.ok(ps.series.length === 1 && ps.buckets.length >= 2, '추이 시계열이 있다');
  assert.equal(pduPoller.pduPollerStatus().demo, true);
});

test('③ CVP 합성 장비 — 결정적·법인 = CVP DataCenter·장애/스트리밍 아님/버전 갈림이 섞인다', async () => {
  const servers = cvpDemo.demoCvpServers(CORPS);
  assert.ok(servers.length >= 2 && servers.length <= 3);
  assert.ok(servers.every((s) => s.id.startsWith('mock-cvp-') && CORPS.some((c) => c.id === s.datacenterId)));
  let total = 0; const versions = new Set(); let notStreaming = 0; let anyFault = 0;
  for (const srv of servers) {
    const specs = cvpDemo.demoSwitchSpecs(srv);
    assert.deepEqual(specs, cvpDemo.demoSwitchSpecs(srv), '결정적');
    total += specs.length;
    const r = await cvpDemo.demoCvpCollect(srv, { now: NOW });
    assert.equal(r.ok, true); assert.equal(r.demo, true); assert.equal(r.inventoryComplete, true);
    for (const d of r.devices) {
      versions.add(d.eosVersion);
      if (d.streaming === false) { notStreaming++; assert.equal(d.ports, null, '스트리밍 아님 = 포트 못 읽음(null)'); continue; }
      const ob = observeDevice({ agent: '', cvpId: srv.id, key: d.key, collectedAt: NOW, telemetry: d.telemetry, partsList: d.parts, partsAt: d.partsAt, bgpPeers: d.bgp, portsRead: true, ports: d.ports }, { now: NOW });
      if (ob.observed.some((o) => o.state === 'fault' || o.state === 'warn')) anyFault++;
      assert.ok(d.ports.every((p) => p.oper !== 'up' || (p.inUtil >= 0 && p.inUtil <= 100)), '사용률 0~100');
    }
    assert.ok(r.events.list.length >= 10 && P.partsSummary(r.devices.find((x) => x.parts)?.parts));
  }
  assert.ok(total >= 40 && total <= 80, `스위치 ${total}대`);
  assert.ok(versions.size >= 3, 'EOS 버전 갈림');
  assert.ok(notStreaming >= 1, '스트리밍 아님 장비');
  assert.ok(anyFault >= 3, `장애·주의 장비 ${anyFault}대`);
});

test('④ CVP 시드는 비어 있을 때만 · mock 폴러 → DB → 장애 판정이 열린 장애를 갖는다', async () => {
  const servers = cvpDemo.demoCvpServers(CORPS);
  assert.equal(cvpReg.seedDemoServers(servers).ok, true);
  assert.equal(cvpReg.seedDemoServers(servers).ok, false, '두 번째 시드는 거부');
  // 과거 백필 — 3일 전·1일 전 상태로 판정을 돌려 '열림 → 해소' 이력이 남는다(현재 수집보다 먼저 돌아야 한다).
  const h = await cvpDemo._backfillForTest(servers, Date.now());
  assert.ok(h.samples > 1000 && h.devSamples > 1000, JSON.stringify(h));
  assert.ok(h.scans[0].opened > 0 && h.scans[1].closed > 0, `이력 판정 ${JSON.stringify(h.scans)}`);
  const r = await cvpPoller.pollCvpOnce({ trigger: 'test' });   // 설정은 꺼짐(기본)이지만 mock 이면 켜진 것처럼 돈다
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.collected, servers.length);
  const { rows } = await cvpDb.listDeviceRows();
  assert.ok(rows.length >= 40, `장비 행 ${rows.length}`);
  await runCvpFaultScan({ reason: 'test', notify: false });
  const open = await cvpDb.listOpenFaults();
  assert.ok(open.rows.length >= 3, `열린 장애 ${open.rows.length}`);
  const ev = await cvpDb.recentFaultEvents({ sinceMs: 7 * 86_400_000 });
  assert.ok(ev.rows.some((e) => e.event === 'close'), '해소 이력이 있다');
  const usage = await cvpDb.portUsage({ limit: 5 });
  assert.ok(usage.counts.measured > 0, '포트 사용량(처리량 합성 값)이 측정분으로 잡힌다');
  assert.equal(cvpPoller.cvpPollerStatus().enabled, true);
});

test('⑤ mock 이 아니면 데모는 아무것도 하지 않고 live 폴러는 mock- 항목에 접속하지 않는다', async () => {
  setDataSource('live');
  try {
    assert.equal((await pduDemo.ensurePduDemo()).reason, 'not-mock');
    assert.equal((await cvpDemo.ensureCvpDemo()).reason, 'not-mock');
    assert.deepEqual(await pduDemo.demoCorps({ vcenters: [{ id: 'vc-x', name: 'x' }] }), []);
    const id = pduReg.listDevices()[0].id;
    const one = await pduPoller.collectDeviceNow(id);
    assert.equal(one.skipped, true, 'live 는 mock- PDU 에 SSH 를 열지 않는다');
    const r = await cvpPoller.pollCvpOnce({ manual: true, trigger: 'test' });
    assert.equal(r.total, 0, 'live 는 mock- CVP 를 대상에서 뺀다');
    assert.equal(cvpPoller.cvpPollerStatus().demo, undefined);
  } finally { setDataSource('mock'); }
});
