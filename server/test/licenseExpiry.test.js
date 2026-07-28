import { test } from 'node:test';
import assert from 'node:assert/strict';
import { licenseFamilyOf, licenseExpiryStatus } from '../src/util/licenseExpiry.js';

test('licenseFamilyOf: 제품군 분류(VCF/VVF는 vSphere보다 우선)', () => {
  assert.equal(licenseFamilyOf('VMware Cloud Foundation 5 vSphere'), 'VCF');
  assert.equal(licenseFamilyOf('vSphere Foundation (VVF)'), 'VVF');
  assert.equal(licenseFamilyOf('NSX Data Center Advanced'), 'NSX');
  assert.equal(licenseFamilyOf('Horizon Apps Standard'), 'Horizon');
  assert.equal(licenseFamilyOf('vSAN Enterprise'), 'vSAN');
  assert.equal(licenseFamilyOf('vCenter Server 8 Standard VMware VirtualCenter Server'), 'vCenter');
  assert.equal(licenseFamilyOf('vSphere 8 Enterprise Plus VMware ESX Server'), 'ESXi(vSphere)');
  assert.equal(licenseFamilyOf('뭔지 모를 제품'), '기타');
});

test('licenseExpiryStatus: 만료/임박(90일)/정상/영구 분류', () => {
  const now = Date.parse('2026-07-28T00:00:00Z');
  const day = 86400000;
  assert.deepEqual(licenseExpiryStatus(now - 10 * day, { now }), { status: 'expired', daysLeft: -10 });
  assert.deepEqual(licenseExpiryStatus(now + 30 * day, { now }), { status: 'expiring', daysLeft: 30 });
  assert.deepEqual(licenseExpiryStatus(now + 90 * day, { now }), { status: 'expiring', daysLeft: 90 });
  assert.deepEqual(licenseExpiryStatus(now + 91 * day, { now }), { status: 'ok', daysLeft: 91 });
  assert.deepEqual(licenseExpiryStatus(null, { now }), { status: 'perpetual', daysLeft: null });
  // NSX is_expired=true인데 만료 시각이 없는 경우도 '만료'로 분류(오탐 방지).
  assert.deepEqual(licenseExpiryStatus(null, { now, forcedExpired: true }), { status: 'expired', daysLeft: null });
});
