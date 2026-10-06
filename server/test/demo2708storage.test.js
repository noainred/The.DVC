/**
 * v2.708 데모(mock) 스토리지 그룹 — mock/demo/storage.js 와 배선(storage/poller·bmstor/poller·등록부 시드).
 * 고정하는 것: ① 합성 값의 결정성·타입 다양성·정직 규칙(실패·비정상 노드·VPLEX 용량 없음·전력 일부만)
 * ② mock 이 아니면 아무것도 하지 않는다 ③ 시드는 비어 있을 때만 ④ live 폴러는 mock- 항목을 건너뛴다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo2708-storage-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'mock';

const demo = await import('../src/mock/demo/storage.js');
const { setDataSource } = await import('../src/runtime-settings.js');
const reg = await import('../src/storage/registry.js');
const bmReg = await import('../src/bmstor/registry.js');
const sdb = await import('../src/storage/db.js');
const { capacityPointEligible } = sdb;

const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000; // 정시 −30분(경계에서 떨어뜨린 고정 기준 — CLAUDE.md 규약)

test('① 합성 스냅샷 — 결정적이고 타입마다 다르며 정직 규칙을 지킨다', () => {
  const devs = demo.demoStorageDevices();
  assert.ok(devs.length >= 10 && devs.length <= 20, `장비 수 ${devs.length}`);
  assert.ok(devs.every((d) => d.id.startsWith('mock-')), 'id 는 mock- 접두');
  assert.ok(new Set(devs.map((d) => d.type)).size >= 7, '여러 타입');
  for (const d of devs) assert.equal(reg.deviceInputIssue(d), null, `${d.name} 등록 검증 통과`);
  const a = devs.map((d) => demo.demoStorageSnapshot(d, NOW, NOW));
  const b = devs.map((d) => demo.demoStorageSnapshot(d, NOW, NOW));
  assert.deepEqual(a, b, '같은 입력 = 같은 출력');
  assert.ok(a.every((s) => s.extra.mock === true && s.extra.demo === true), 'MOCK 배지 근거를 싣는다');
  const failed = a.filter((s) => !s.ok);
  assert.equal(failed.length, 1, '최근 수집 실패 1대');
  assert.equal(failed[0].capacity.totalBytes, null, '실패 스냅샷의 수치는 null(0 TB 거짓 금지)');
  assert.ok(a.filter((s) => s.ok && s.nodes.unhealthy > 0).length >= 2, '노드 비정상 장비 2대 이상');
  const virt = a.filter((s) => s.type === 'vplex' || s.type === 'metronode');
  assert.ok(virt.length && virt.every((s) => s.sections.capacity === 'skip' && !capacityPointEligible(s).ok), 'VPLEX 계열은 용량 없음');
  const real = a.filter((s) => s.ok && s.type !== 'vplex' && s.type !== 'metronode');
  assert.ok(real.every((s) => capacityPointEligible(s).ok), '용량 장비는 적재 가능');
  assert.ok(real.filter((s) => s.extra.power?.watts > 0).length >= 8, '전력을 읽은 장비가 여럿');
  assert.equal(real.filter((s) => s.extra.powerProbe).length, 1, '전원 필드 없음 1대');
  // 과거로 갈수록 사용량이 줄어든다(증가 추세) · 실패는 최근 몇 시간만
  const isi = devs.find((d) => d.type === 'isilon');
  const past = demo.demoStorageSnapshot(isi, NOW - 90 * 86_400_000, NOW);
  assert.ok(past.capacity.usedBytes < a[0].capacity.usedBytes, '90일 전 사용량이 더 적다');
  const failDev = devs.find((d) => d.name === failed[0].name);
  assert.equal(demo.demoStorageSnapshot(failDev, NOW - 2 * 86_400_000, NOW).ok, true, '과거에는 수집 성공');
});

test('② mock 이 아니면 아무것도 하지 않는다 · live 폴러는 mock- 장비를 건너뛴다', async () => {
  assert.equal(setDataSource('live').ok, true);
  demo._resetStorageDemoForTest();
  assert.equal(await demo.ensureStorageDemo({ now: NOW }), null);
  assert.equal(reg.listDevices().length, 0, 'live 에서는 시드하지 않는다');
  // 데모 시드 잔재가 남아 있어도 live 수집은 그 장비에 접속하지 않는다.
  assert.equal(reg.seedDevicesIfEmpty(demo.demoStorageDevices()).seeded, 17);
  const { pollStorageOnce } = await import('../src/storage/poller.js');
  const r = await pollStorageOnce();
  assert.deepEqual([r.ok, r.fail], [0, 0], 'mock- 장비를 수집하지 않았다');
  assert.equal(bmReg.seedBmServersIfEmpty(demo.demoBmServers()).seeded, 11);
  const { bmCollectNow } = await import('../src/bmstor/poller.js');
  const b = await bmCollectNow('interval');
  assert.equal(b.servers, 0, 'live bmstor 는 mock- 서버를 수집하지 않는다');
  // 정리 — 다음 테스트는 빈 등록부에서 시작한다
  for (const d of reg.listDevices()) reg.deleteDevice(d.id);
  for (const s of bmReg.listBmServers()) bmReg.removeBmServer(s.id);
});

test('③ 시드는 비어 있을 때만 · mock- 접두가 아닌 항목은 받지 않는다', () => {
  const real = reg.saveDevice({ type: 'unity480', name: 'REAL-01', host: '10.9.9.9', username: 'admin', password: 'x' });
  assert.equal(reg.seedDevicesIfEmpty(demo.demoStorageDevices()).reason, 'not-empty');
  assert.equal(reg.listDevices().length, 1, '실데이터를 덮지 않는다');
  reg.deleteDevice(real.id);
  const r = reg.seedDevicesIfEmpty([{ id: 'st-x', type: 'isilon', name: 'X', host: '10.1.1.1', username: 'root' }]);
  assert.deepEqual([r.seeded, r.skipped], [0, 1]);
});

test('④ mock — 등록부 시드 + 일 롤업·베어메탈 12시간 이력 백필, 두 번째 호출은 다시 쌓지 않는다', async () => {
  assert.equal(setDataSource('mock').ok, true);
  demo._resetStorageDemoForTest();
  const out = await demo.ensureStorageDemo({ now: NOW });
  assert.equal(out.demo, true);
  assert.equal(out.storageSeed.seeded, 17);
  assert.equal(out.bmSeed.seeded, 11);
  const spans = await sdb.dailySpans();
  const isi = spans['mock-st-ps-sel-01'];
  assert.ok(isi && isi.observed >= 390, `일 롤업 ${isi?.observed}일`);
  assert.equal(spans['mock-st-vplex-sel-01'], undefined, 'VPLEX 는 용량 이력이 없다');
  assert.ok(out.bmBackfill.slots >= 700, `베어메탈 이력 ${out.bmBackfill.slots}슬롯`);
  const { bmHistoryRange } = await import('../src/bmstor/historyDb.js');
  const h = await bmHistoryRange(NOW - 7 * 86_400_000, NOW, { kind: 'total' });
  assert.ok(h.rows.length >= 13 && h.rows.every((x) => !x.partial), '7일 합계 행(부분 합 아님)');
  // VMAX/PowerMax 1회 마이그레이션 표지가 섰다 — 다음 기동이 데모 이력을 지우고 '기준 변경' 배지를 띄우지 않게
  const { runCapacityBasisMigration } = await import('../src/storage/capacityBasisMigration.js');
  assert.equal((await runCapacityBasisMigration()).ran, false, '마이그레이션 재실행 없음');
  assert.deepEqual(Object.keys(await sdb.capacityResets()), [], '장비별 기준 변경 기록 없음');
  // 두 번째(재시작 흉내): 이력이 있으면 다시 쌓지 않는다
  demo._resetStorageDemoForTest();
  const again = await demo.ensureStorageDemo({ now: NOW });
  assert.equal(again.storageSeed.reason, 'not-empty');
  assert.equal(again.storageBackfill.devices, 0);
  assert.equal(again.bmBackfill.slots, 0);
  // mock 폴러: 시드된 장비를 합성 수집(실패 1대)
  const { pollStorageOnce } = await import('../src/storage/poller.js');
  const r = await pollStorageOnce();
  assert.deepEqual([r.ok, r.fail], [16, 1]);
  const { bmCollectNow, getBmLatest } = await import('../src/bmstor/poller.js');
  const b = await bmCollectNow('interval');
  assert.equal(b.okCount, 10, '활성 10대 합성 수집');
  assert.ok([...getBmLatest().values()].every((x) => x.ok && x.mounts.length));
});

test('⑤ 데이터스토어 추이 백필 행 — 과거일수록 사용량이 적고 로스터를 건드리지 않는다', () => {
  const snap = {
    vcenters: [{ id: 'vc-a' }, { id: 'vc-b' }],
    vms: [{ vcenterId: 'vc-a', powerState: 'POWERED_ON' }, { vcenterId: 'vc-a', powerState: 'POWERED_OFF' }, { vcenterId: 'vc-b', powerState: 'POWERED_ON' }],
    datastores: [{ id: 'vc-a:ds1', vcenterId: 'vc-a', capacityGB: 10000, usedGB: 7000 }, { id: 'vc-b:ds2', vcenterId: 'vc-b', capacityGB: 4000, usedGB: 1000 }],
  };
  const now = NOW;
  const old = demo.demoVmtrackPerVc(snap, now - 60 * 86_400_000, now, { first: true });
  const recent = demo.demoVmtrackPerVc(snap, now - 86_400_000, now);
  assert.equal(old.length, 2);
  assert.ok(old[0].ds.usedGB < recent[0].ds.usedGB, '60일 전 사용량이 더 적다');
  assert.ok(old.every((v) => v.live.length === 0 && v.ds.live.length === 0), '로스터 미변경');
  assert.equal(old[0].baseline, true);
  assert.deepEqual(demo.demoVmtrackPerVc(snap, now - 86_400_000, now), recent, '결정적');
});
