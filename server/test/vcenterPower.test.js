import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-power-'));
process.env.CONFIG_DIR = tmp;

let service, registry, dbMod, ps;
before(async () => {
  service = await import('../src/idrac/service.js');
  registry = await import('../src/idrac/registry.js');
  dbMod = await import('../src/idrac/db.js');
  ps = await import('../src/idrac/powerSettings.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('allMeasuredPower: vCenter 호스트 전력 합산 + iDRAC 중복 제거', async () => {
  // iDRAC 1대 등록(esxi-a 호스트에 매핑) + 전력 샘플.
  registry.importServers([{ id: 'idrac-a', name: 'idrac-a', host: '10.0.0.1', username: 'root', password: 'x', hostNames: ['esxi-a'] }], 'replace');
  const db = await dbMod.getDb();
  db.insert('idrac-a', 300, Date.now());

  const hosts = [
    { name: 'esxi-a', vcenterId: 'OC2', powerWatts: 999 }, // iDRAC이 이미 잡음 → vCenter 중복 제외(iDRAC 300 우선)
    { name: 'esxi-b', vcenterId: 'OC2', powerWatts: 250 }, // iDRAC 없음 → vCenter 소스로 추가
    { name: 'esxi-c', vcenterId: 'WA', powerWatts: 0 },    // 0W → 제외(센서 미보고)
  ];
  ps.savePowerSettings({ includeVcenterPower: true });
  const measured = await service.allMeasuredPower({ hosts });

  const idrac = measured.filter((m) => m.source === 'idrac');
  const vc = measured.filter((m) => m.source === 'vcenter');
  assert.equal(idrac.length, 1, 'iDRAC 1대');
  assert.equal(idrac[0].watts, 300);
  assert.equal(vc.length, 1, 'vCenter는 esxi-b만(esxi-a 중복 제외, esxi-c 0W 제외)');
  assert.equal(vc[0].serverName, 'esxi-b');
  assert.equal(vc[0].watts, 250);
  assert.equal(vc[0].vcenterId, 'OC2');
  // 총합 = iDRAC 300 + vCenter 250 = 550 (999 중복분 미포함)
  assert.equal(measured.reduce((a, m) => a + m.watts, 0), 550);
});

test('includeVcenterPower=false면 vCenter 소스 제외', async () => {
  registry.importServers([], 'replace');
  ps.savePowerSettings({ includeVcenterPower: false });
  const measured = await service.allMeasuredPower({ hosts: [{ name: 'h1', vcenterId: 'OC2', powerWatts: 100 }] });
  assert.equal(measured.filter((m) => m.source === 'vcenter').length, 0);
  // 기본(설정 미지정/true)로 복구 시 다시 포함.
  ps.savePowerSettings({ includeVcenterPower: true });
  const m2 = await service.allMeasuredPower({ hosts: [{ name: 'h1', vcenterId: 'OC2', powerWatts: 100 }] });
  assert.equal(m2.filter((m) => m.source === 'vcenter').length, 1);
});

test('measuredPowerBreakdown: bySource.vcenter 집계', async () => {
  registry.importServers([], 'replace');
  ps.savePowerSettings({ includeVcenterPower: true });
  const b = await service.measuredPowerBreakdown({ hosts: [
    { name: 'h1', vcenterId: 'OC2', powerWatts: 120 },
    { name: 'h2', vcenterId: 'WA', powerWatts: 80 },
  ] });
  assert.equal(b.bySource.vcenter, 2);
});

test('insertMany: 트랜잭션 배치 적재 + 시계열 조회', async () => {
  const db = await dbMod.getDb();
  const ts = Date.now();
  const n = db.insertMany([
    { serverId: 'vc:oc2:esxi-x', watts: 200, ts },
    { serverId: 'vc:oc2:esxi-y', watts: 150, ts },
  ]);
  assert.equal(n, 2);
  const stats = db.statsSince(ts - 1000);
  assert.ok(stats.get('vc:oc2:esxi-x'));
  assert.equal(stats.get('vc:oc2:esxi-x').avg, 200);
});
