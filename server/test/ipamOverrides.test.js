import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// override 저장소는 CONFIG_DIR 아래 파일을 쓰므로, 개발 config를 건드리지 않도록
// 임시 디렉터리를 CONFIG_DIR로 지정한 뒤 모듈을 동적 import한다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam-ov-'));
process.env.CONFIG_DIR = tmp;

let ov, ledger;
before(async () => {
  ov = await import('../src/ipam/overrides.js');
  ledger = await import('../src/ipam/ledger.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('setOverride: 부분 업데이트 + rev 증가 + 빈 값이면 삭제', () => {
  const r0 = ov.overridesRev();
  const r = ov.setOverride('10.77.0.5', { status: 'reserved', owner: '인프라팀', deviceType: 'switch' }, { username: 'tester' });
  assert.equal(r.ok, true);
  assert.equal(r.override.status, 'reserved');
  assert.equal(r.override.deviceType, 'switch');
  assert.equal(r.override.updatedBy, 'tester');
  assert.ok(ov.overridesRev() > r0);
  // 부분 업데이트: owner만 바꿔도 기존 status 유지
  const r2 = ov.setOverride('10.77.0.5', { owner: '보안팀' }, { username: 'tester' });
  assert.equal(r2.override.status, 'reserved');
  assert.equal(r2.override.owner, '보안팀');
  // 모든 필드 비우면 삭제
  const r3 = ov.setOverride('10.77.0.5', { status: '', owner: '', deviceType: '' }, { username: 'tester' });
  assert.equal(r3.override, null);
  assert.equal(ov.getOverride('10.77.0.5'), null);
});

test('setOverride: 잘못된 status/deviceType은 무시(빈 값)', () => {
  const r = ov.setOverride('10.77.0.6', { status: 'bogus', deviceType: 'nope', label: 'x' }, {});
  assert.equal(r.override.status, '');
  assert.equal(r.override.deviceType, '');
  assert.equal(r.override.label, 'x');
  ov.clearOverride('10.77.0.6');
});

test('setOverrideBatch: 여러 IP 일괄 적용 + 단일 쓰기', () => {
  const r = ov.setOverrideBatch(['10.77.1.1', '10.77.1.2', '10.77.1.3'], { status: 'reserved' }, { username: 'op' });
  assert.equal(r.ok, true);
  assert.equal(r.changed, 3);
  assert.equal(ov.getOverride('10.77.1.2').status, 'reserved');
  ['10.77.1.1', '10.77.1.2', '10.77.1.3'].forEach((ip) => ov.clearOverride(ip));
});

test('ledger: override 병합 — 라벨/관리상태/디바이스종류 반영, manual 행 추가', () => {
  ov.setOverride('10.88.0.10', { status: 'reserved', label: '코어스위치', deviceType: 'switch', owner: 'NetOps' }, { username: 'op' });
  const snap = {
    generatedAt: 't1',
    vcenters: [{ id: 'vc1', name: 'SEOUL' }],
    vms: [{ name: 'web01', vcenterId: 'vc1', ipAddress: '10.88.0.20', powerState: 'POWERED_ON', guestOS: 'CentOS 7' }],
    hosts: [],
  };
  const { rows } = ledger.buildIpamRows(snap);
  const manual = rows.find((r) => r.ip === '10.88.0.10');
  assert.ok(manual, 'override만 있는 IP가 manual 행으로 추가되어야 함');
  assert.equal(manual.reconcile, 'manual');
  assert.equal(manual.mgmtStatus, 'reserved');
  assert.equal(manual.label, '코어스위치');
  assert.equal(manual.displayName, '코어스위치');
  assert.equal(manual.deviceType, 'switch');
  const vm = rows.find((r) => r.ip === '10.88.0.20');
  assert.equal(vm.reconcile, 'vcenter');
  ov.clearOverride('10.88.0.10');
});

test('ledger: status=ignored 인 IP는 대장에서 숨김', () => {
  ov.setOverride('10.88.0.30', { status: 'ignored' }, { username: 'op' });
  const snap = {
    generatedAt: 't2', vcenters: [{ id: 'vc1', name: 'SEOUL' }],
    vms: [{ name: 'db01', vcenterId: 'vc1', ipAddress: '10.88.0.30', powerState: 'POWERED_ON' }],
    hosts: [],
  };
  const { rows } = ledger.buildIpamRows(snap);
  assert.equal(rows.find((r) => r.ip === '10.88.0.30'), undefined);
  ov.clearOverride('10.88.0.30');
});

test('overrides: 잘못된 IP 키는 거부(오염 차단)', () => {
  assert.equal(ov.setOverride('not-an-ip', { status: 'reserved' }).ok, false);
  assert.equal(ov.setOverride('333.0.0.1', { status: 'reserved' }).ok, false);
  assert.equal(ov.setOverride('__proto__', { status: 'reserved' }).ok, false);
  // batch는 유효 IP만 남기고 무효는 버린다
  const r = ov.setOverrideBatch(['10.5.5.5', 'bad', '999.1.1.1', '10.5.5.6'], { status: 'reserved' }, { username: 'op' });
  assert.equal(r.ok, true);
  assert.equal(r.changed, 2);
  ov.clearOverride('10.5.5.5'); ov.clearOverride('10.5.5.6');
  assert.equal(ov.getOverride('bad'), null);
});

test('ledger: 같은 IP를 둘 이상 vCenter가 주장하면 reconcile=conflict', () => {
  const snap = {
    generatedAt: 'tc', vcenters: [{ id: 'vc1', name: 'SEOUL' }, { id: 'vc2', name: 'TOKYO' }],
    vms: [
      { name: 'a', vcenterId: 'vc1', ipAddress: '10.90.0.7', powerState: 'POWERED_ON' },
      { name: 'b', vcenterId: 'vc2', ipAddress: '10.90.0.7', powerState: 'POWERED_ON' },
      { name: 'c', vcenterId: 'vc1', ipAddress: '10.90.0.8', powerState: 'POWERED_ON' },
    ],
    hosts: [],
  };
  const { rows, conflicts, reconcile } = ledger.buildIpamRows(snap);
  const conflictRows = rows.filter((r) => r.ip === '10.90.0.7');
  assert.ok(conflictRows.length >= 1);
  assert.ok(conflictRows.every((r) => r.reconcile === 'conflict'));
  assert.ok(conflictRows[0].conflictVcenters.includes('vc1') && conflictRows[0].conflictVcenters.includes('vc2'));
  // 단일 vCenter IP는 conflict 아님
  assert.equal(rows.find((r) => r.ip === '10.90.0.8').reconcile, 'vcenter');
  assert.ok(conflicts >= 1);
  assert.equal(reconcile.conflict, conflicts);
});
