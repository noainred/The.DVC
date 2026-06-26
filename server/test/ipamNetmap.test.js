import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNetmap, osCategory, netmapBases } from '../src/ipam/netmap.js';

const snap = {
  generatedAt: Date.now(),
  vcenters: [{ id: 'vc1', name: 'SEOUL' }],
  vms: [],
  hosts: [
    { name: '10.55.55.10', vcenterId: 'vc1', version: '8.0' },     // ESXi
    { name: '10.55.55.20', vcenterId: 'vc1', version: '7.0' },
  ],
};

test('osCategory: osName 우선 분류', () => {
  assert.equal(osCategory('Microsoft Windows Server 2022').key, 'Windows');
  assert.equal(osCategory('CentOS Linux 7').key, 'Linux');
  assert.equal(osCategory('VMware ESXi 8.0').key, 'ESXi');
});

test('osCategory: osName 없으면 서비스로 추정(guessed)', () => {
  assert.deepEqual(osCategory('', ['RDP', 'SMB']), { key: 'Windows', guessed: true });
  assert.deepEqual(osCategory('', ['SSH']), { key: 'Linux', guessed: true });
  assert.equal(osCategory('', []).key, 'Unknown');
});

test('buildNetmap: /24 격자 254셀 + base 자동 선택 + 버킷', () => {
  const r = buildNetmap(snap, { base: '10.55.55', days: 30, buckets: 12 });
  assert.equal(r.base, '10.55.55');
  assert.equal(r.cidr, '10.55.55.0/24');
  assert.equal(r.cells.length, 254);
  assert.equal(r.buckets.length, 12);
  // .10 셀은 ESXi
  const c10 = r.cells.find((c) => c.ip === '10.55.55.10');
  assert.ok(c10);
  assert.equal(c10.osKey, 'ESXi');
  assert.equal(c10.present, true);
  // states 길이 = 버킷 수
  assert.equal(c10.states.length, 12);
});

test('buildNetmap: base 미지정 시 사용 가능한 base 중 첫 번째 자동 선택', () => {
  const r = buildNetmap(snap, { days: 7 });
  assert.equal(r.base, '10.55.55');     // 호스트가 있는 유일한 /24
  assert.ok(r.bases.includes('10.55.55'));
});

test('netmapBases: 대장 IP에서 /24 추출', () => {
  const bases = netmapBases(snap, '');
  assert.ok(bases.includes('10.55.55'));
});
