import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateGuestOs } from '../src/inventory/guestOsAgg.js';

// v2.328 — Guest OS별 VM 수 + 할당 코어(vCPU) + vCenter별 분해 집계(순수 함수) 산술 고정.
const osFamily = (os = '') => (/win/i.test(os) ? 'Windows' : /ubuntu|linux|cent|rhel|debian/i.test(os) ? 'Linux' : '기타');
const VMS = [
  { vcenterId: 'vc-a', guestOS: 'Windows Server 2019', powerState: 'POWERED_ON', cpuCount: 4, memMB: 8192, storageGB: 100 },
  { vcenterId: 'vc-a', guestOS: 'Windows Server 2019', powerState: 'POWERED_OFF', cpuCount: 2, memMB: 4096, storageGB: 50 },
  { vcenterId: 'vc-a', guestOS: 'Ubuntu 22.04', powerState: 'POWERED_ON', cpuCount: 8, memMB: 16384, storageGB: 200 },
  { vcenterId: 'vc-b', guestOS: 'Ubuntu 22.04', powerState: 'POWERED_ON', cpuCount: 1, memMB: 1024, storageGB: 20 },
  { vcenterId: 'vc-b', guestOS: '', powerState: 'SUSPENDED', cpuCount: 0, memMB: 0, storageGB: 0 }, // 미상·코어0
];
const vcMeta = new Map([['vc-a', { name: 'AZ', region: '북미' }], ['vc-b', { name: 'GM1', region: '북미' }]]);

test('aggregateGuestOs — 전체 OS별 VM 수·할당 vCPU·on/off', () => {
  const r = aggregateGuestOs(VMS, osFamily, vcMeta);
  assert.equal(r.total, 5);
  assert.equal(r.totalVcpu, 15);              // 4+2+8+1+0
  assert.equal(r.distinctOs, 3);              // Win2019 · Ubuntu22 · 미상
  const win = r.items.find((i) => i.os === 'Windows Server 2019');
  assert.equal(win.total, 2); assert.equal(win.on, 1); assert.equal(win.off, 1); assert.equal(win.vcpu, 6);
  const ubu = r.items.find((i) => i.os === 'Ubuntu 22.04');
  assert.equal(ubu.total, 2); assert.equal(ubu.vcpu, 9);
  const unknown = r.items.find((i) => i.os === '미상');
  assert.equal(unknown.total, 1); assert.equal(unknown.vcpu, 0);
  // 계열 집계
  const fam = Object.fromEntries(r.families.map((f) => [f.family, f]));
  assert.equal(fam.Windows.total, 2); assert.equal(fam.Windows.vcpu, 6);
  assert.equal(fam.Linux.total, 2); assert.equal(fam.Linux.vcpu, 9);
  assert.equal(fam['기타'].total, 1);
});

test('aggregateGuestOs — vCenter별 분해(VM 수·vCPU·OS 목록) + 이름 매핑', () => {
  const r = aggregateGuestOs(VMS, osFamily, vcMeta);
  assert.equal(r.byVcenter.length, 2);
  const a = r.byVcenter.find((v) => v.id === 'vc-a');
  assert.equal(a.name, 'AZ'); assert.equal(a.region, '북미');
  assert.equal(a.total, 3); assert.equal(a.vcpu, 14); // 4+2+8
  // vc-a 는 Windows(2)·Ubuntu(1) — count desc 정렬
  assert.deepEqual(a.os.map((o) => o.os), ['Windows Server 2019', 'Ubuntu 22.04']);
  assert.equal(a.os[0].count, 2); assert.equal(a.os[0].vcpu, 6);
  const b = r.byVcenter.find((v) => v.id === 'vc-b');
  assert.equal(b.total, 2); assert.equal(b.vcpu, 1);
  // byVcenter 는 total desc — vc-a(3) 가 먼저
  assert.equal(r.byVcenter[0].id, 'vc-a');
});

test('aggregateGuestOs — 빈 목록·메타 없음 안전', () => {
  const r = aggregateGuestOs([], osFamily);
  assert.equal(r.total, 0); assert.equal(r.totalVcpu, 0);
  assert.deepEqual(r.items, []); assert.deepEqual(r.byVcenter, []);
  // 메타 없으면 id 를 이름으로 폴백
  const r2 = aggregateGuestOs([{ vcenterId: 'vc-x', guestOS: 'Linux', powerState: 'POWERED_ON', cpuCount: 2 }], osFamily);
  assert.equal(r2.byVcenter[0].name, 'vc-x');
});
