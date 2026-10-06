/**
 * v2.711 데모(mock) 4차 점검 — 400px 전수 · 서브탭·IP관리 70 경로 조사에서 찾은 것.
 * 고정:
 *  ① 백업 스냅샷 이벤트 데모 — 최근 8일만 · 켜진 VM 의 일부만 · 미보호 판정이 그 이벤트를 보호 근거로 읽는다 · 결정적
 *  ② 목 생성기 사용률 — 라이트사이징 '유휴'·'과소' 가 실제로 나온다(예전 공식은 CPU 15~75% · MEM 25~80% 라 0건)
 *  ③ RMA 점검 상태 데모 — 데모 엣지 스케줄이 비었을 때만 등록 · 결과는 알림 없이 반영 · 기존 스케줄은 건드리지 않는다
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo2711-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'mock';

const DAY = 86_400_000;

test('① 백업 스냅샷 데모 — 최근 8일 · 일부 VM · 미보호 판정이 보호 근거로 읽는다', async () => {
  const { demoBackupEvents, demoBackedUp } = await import('../src/mock/demo/backup.js');
  const { computeUnprotected, isBackupEvent } = await import('../src/reports/unprotected.js');
  const now = Date.UTC(2026, 9, 7, 3, 30);   // 고정 기준 시각(정시 경계에서 떨어뜨림)
  const vms = Array.from({ length: 50 }, (_, i) => ({ id: `vc1:vm-${i}`, name: `vm-${i}`, vcenterId: 'vc1', powerState: i % 10 === 0 ? 'POWERED_OFF' : 'POWERED_ON' }));
  const ev = demoBackupEvents('vc1', vms, now - 91 * DAY, now);
  assert.ok(ev.length > 0);
  assert.ok(ev.every((e) => e.ts >= now - 9 * DAY && e.ts <= now), '91일 첫 수집이어도 최근 8일만');
  assert.ok(ev.every((e) => isBackupEvent(e)), '백업 패턴(계정·문구)에 맞는다');
  const backed = new Set(ev.map((e) => e.entity));
  assert.ok(backed.size > 0 && backed.size < vms.length, '일부 VM 만 백업된다');
  for (const vm of vms) if (vm.powerState === 'POWERED_OFF') assert.equal(backed.has(vm.name), false, '꺼진 VM 은 백업 이벤트가 없다');
  assert.deepEqual(demoBackupEvents('vc1', vms, now - 91 * DAY, now), ev, '결정적');
  // 창 밖이면 아무것도 없다(다음 폴이 같은 이벤트를 다시 만들지 않게)
  assert.equal(demoBackupEvents('vc1', vms, now + 1, now + 60_000).filter((e) => e.ts <= now).length, 0);
  const r = computeUnprotected(vms, ev, { lookbackDays: 7, coveredVcenterIds: new Set(['vc1']) });
  const prot = r.protected || r.protectedVms || [];
  const protCount = Array.isArray(prot) ? prot.length : Number(r.counts?.protected ?? r.summary?.protected);
  assert.ok(protCount > 0, `보호 확인 VM 이 생긴다: ${JSON.stringify(Object.keys(r))}`);
  assert.equal(vms.filter(demoBackedUp).length > 0, true);
});

test('② 목 생성기 — 라이트사이징 유휴·과소가 나온다', async () => {
  const { generateSnapshot } = await import('../src/mock/generator.js');
  const { computeRightsizing } = await import('../src/reports/rightsizing.js');
  const snap = generateSnapshot();
  const r = computeRightsizing(snap.vms, () => null);
  assert.ok(r.idle.length > 0, '유휴 VM 이 있다');
  assert.ok(r.undersized.length > 0, '과소(증설 검토) VM 이 있다');
  for (const v of snap.vms) {
    if (v.powerState !== 'POWERED_ON') continue;
    assert.ok(v.cpuUsagePct >= 0 && v.cpuUsagePct <= 100 && v.memUsagePct >= 0 && v.memUsagePct <= 100, '0~100 범위');
  }
});

test('③ RMA 점검 상태 데모 — 빈 스케줄에만 등록, 결과는 알림 없이', async () => {
  const { demoRmaTestResults } = await import('../src/mock/demo/edgeSeed.js');
  const sch = await import('../src/rma/schedules.js');
  const tr = await import('../src/rma/testResults.js');
  // 사람이 만든 스케줄이 있는 엣지는 건드리지 않는다
  sch.upsertScheduleItem('mock-Edge-Seoul', { name: '사람 점검', test: 'ntp', args: { maxOffsetMs: 100 }, intervalSec: 60 });
  const cols = [{ id: 'mock-Edge-Seoul', name: 'mock-Edge-Seoul' }, { id: 'mock-Edge-Shanghai', name: 'mock-Edge-Shanghai' }];
  const r = await demoRmaTestResults(cols, { now: Date.now() });
  assert.ok(r.results > 0);
  assert.deepEqual(sch.scheduleFor('mock-Edge-Seoul').tests.map((t) => t.name), ['사람 점검'], '기존 스케줄은 그대로');
  assert.equal(sch.scheduleFor('mock-Edge-Shanghai').tests.length, 4, '빈 스케줄에는 데모 4개');
  const rows = tr.latestResults({ agent: 'mock-Edge-Shanghai' });
  assert.equal(rows.length, 4);
  assert.ok(rows.some((x) => x.status === 'bad'), '고RTT 데모 엣지는 TCP 점검이 실패로 보인다');
  assert.ok(rows.every((x) => x.alerted === false), '알림 상태로 넘어가지 않는다');
  // 다시 불러도 스케줄이 늘지 않는다
  await demoRmaTestResults(cols, { now: Date.now() });
  assert.equal(sch.scheduleFor('mock-Edge-Shanghai').tests.length, 4);
});
