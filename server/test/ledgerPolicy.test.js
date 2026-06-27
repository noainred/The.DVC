import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam-lp-'));
process.env.CONFIG_DIR = tmp;

let rp, ov, ledger;
before(async () => {
  rp = await import('../src/ipam/rangePolicies.js');
  ov = await import('../src/ipam/overrides.js');
  ledger = await import('../src/ipam/ledger.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const snapWith = (gen, ips) => ({
  generatedAt: gen, vcenters: [{ id: 'vc1', name: 'SEOUL' }, { id: 'vc2', name: 'TOKYO' }],
  vms: ips.map(([ip, vc], i) => ({ name: `vm${i}`, vcenterId: vc || 'vc1', ipAddress: ip, powerState: 'POWERED_ON', guestOS: 'CentOS 7' })),
  hosts: [],
});
const row = (snap, ip, vc) => ledger.buildIpamRows(snap, vc).rows.find((r) => r.ip === ip);

test('정책 dhcp 행: mgmtStatus=dhcp, appliedBy=range-policy, managed', () => {
  const p = rp.setPolicy({ spec: '10.20.0.0/24', status: 'dhcp', owner: 'NetOps', label: 'DHCP풀' }, { username: 'op' });
  const r = row(snapWith('p1', [['10.20.0.10']]), '10.20.0.10');
  assert.equal(r.mgmtStatus, 'dhcp');
  assert.equal(r.appliedBy, 'range-policy');
  assert.equal(r.owner_, 'NetOps');
  assert.equal(r.managed, true);
  assert.equal(r.rangePolicySpec, '10.20.0.0/24');
  rp.deletePolicy(p.policy.id);
});

test('폭포식: 정책 dhcp + override owner만 → status=dhcp 보충 + owner=override', () => {
  const p = rp.setPolicy({ spec: '10.21.0.0/24', status: 'dhcp' }, { username: 'op' });
  ov.setOverride('10.21.0.5', { owner: '담당자A' }, { username: 'op' }); // status 미지정
  const r = row(snapWith('p2', [['10.21.0.5']]), '10.21.0.5');
  assert.equal(r.mgmtStatus, 'dhcp');     // 정책 보충
  assert.equal(r.owner_, '담당자A');       // override 우선
  assert.equal(r.appliedBy, 'override');
  ov.clearOverride('10.21.0.5'); rp.deletePolicy(p.policy.id);
});

test('override.status가 정책보다 우선', () => {
  const p = rp.setPolicy({ spec: '10.22.0.0/24', status: 'dhcp' }, { username: 'op' });
  ov.setOverride('10.22.0.5', { status: 'reserved' }, { username: 'op' });
  const r = row(snapWith('p3', [['10.22.0.5']]), '10.22.0.5');
  assert.equal(r.mgmtStatus, 'reserved');
  ov.clearOverride('10.22.0.5'); rp.deletePolicy(p.policy.id);
});

test('override.status=ignored가 정책보다 우선 → 행 제거', () => {
  const p = rp.setPolicy({ spec: '10.23.0.0/24', status: 'dhcp' }, { username: 'op' });
  ov.setOverride('10.23.0.5', { status: 'ignored' }, { username: 'op' });
  assert.equal(row(snapWith('p4', [['10.23.0.5']]), '10.23.0.5'), undefined);
  ov.clearOverride('10.23.0.5'); rp.deletePolicy(p.policy.id);
});

test('정책 ignored: 대역 자동발견 행 제거, 단 override 있는 IP는 유지', () => {
  const p = rp.setPolicy({ spec: '10.24.0.0/24', status: 'ignored' }, { username: 'op' });
  ov.setOverride('10.24.0.9', { owner: '유지대상' }, { username: 'op' }); // owner만(비-ignored)
  const snap = snapWith('p5', [['10.24.0.5'], ['10.24.0.9']]);
  assert.equal(row(snap, '10.24.0.5'), undefined);     // 정책 ignored로 제거
  const kept = row(snap, '10.24.0.9');
  assert.ok(kept, 'override 있는 IP는 ignored 대역에서도 유지');
  assert.notEqual(kept.mgmtStatus, 'ignored');         // ignored를 표시상태로 쓰지 않음
  assert.equal(kept.owner_, '유지대상');
  ov.clearOverride('10.24.0.9'); rp.deletePolicy(p.policy.id);
});

test('정책 ignored는 override 행에 어떤 필드도 누설하지 않음(완전 숨김)', () => {
  // ignored /24 + 그 안 IP에 owner만 override → 정책의 label/owner/id가 절대 새지 않아야 함
  const p = rp.setPolicy({ spec: '10.30.0.0/24', status: 'ignored', label: 'SECRET-LAN', owner: 'HiddenTeam' }, { username: 'op' });
  ov.setOverride('10.30.0.7', { owner: '담당' }, { username: 'op' });
  const r = row(snapWith('p11', [['10.30.0.7']]), '10.30.0.7');
  assert.ok(r, 'override 있는 IP는 유지');
  assert.equal(r.appliedBy, 'override');
  assert.equal(r.rangePolicyId, undefined);     // 정책 id 누설 금지
  assert.equal(r.rangePolicySpec, undefined);   // 정책 spec 누설 금지
  assert.notEqual(r.label, 'SECRET-LAN');       // 정책 label 누설 금지
  assert.equal(r.owner_, '담당');                // override owner만
  ov.clearOverride('10.30.0.7'); rp.deletePolicy(p.policy.id);
});

test('reconcile/conflict는 정책 적용돼도 불변', () => {
  const p = rp.setPolicy({ spec: '10.25.0.0/24', status: 'reserved' }, { username: 'op' });
  // 교차 vCenter 충돌 IP
  const snap = snapWith('p6', [['10.25.0.7', 'vc1'], ['10.25.0.7', 'vc2'], ['10.25.0.8', 'vc1']]);
  const conflict = ledger.buildIpamRows(snap).rows.filter((r) => r.ip === '10.25.0.7');
  assert.ok(conflict.every((r) => r.reconcile === 'conflict')); // 정책 reserved여도 conflict 유지
  assert.equal(row(snap, '10.25.0.8').reconcile, 'vcenter');
  rp.deletePolicy(p.policy.id);
});

test('정책은 행을 생성하지 않음(빈 대역에 정책만 추가해도 rows 불변)', () => {
  const snap = snapWith('p7', [['10.26.0.1']]);
  const before = ledger.buildIpamRows(snap).rows.length;
  const p = rp.setPolicy({ spec: '10.26.99.0/24', status: 'reserved' }, { username: 'op' });
  const after = ledger.buildIpamRows(snap).rows.length;
  assert.equal(after, before); // 오버레이만, 행 미생성
  rp.deletePolicy(p.policy.id);
});

test('캐시 무효화: 정책 변경 후 buildIpamRows가 새 결과 반영', () => {
  const snap = snapWith('p8', [['10.27.0.10']]);
  assert.ok(!row(snap, '10.27.0.10').mgmtStatus);
  const p = rp.setPolicy({ spec: '10.27.0.0/24', status: 'deprecated' }, { username: 'op' });
  assert.equal(row(snap, '10.27.0.10').mgmtStatus, 'deprecated'); // policiesRev로 캐시 무효화
  rp.deletePolicy(p.policy.id);
  assert.ok(!row(snap, '10.27.0.10').mgmtStatus); // 삭제 후 원복
});

test('스코프: vCenter 귀속 정책은 그 vCenter 뷰에서만', () => {
  const p = rp.setPolicy({ spec: '10.28.0.0/24', status: 'reserved', claimedVcenterId: 'vc1' }, { username: 'op' });
  const snap = snapWith('p9', [['10.28.0.10', 'vc1']]);
  assert.equal(row(snap, '10.28.0.10', 'vc1').mgmtStatus, 'reserved'); // 해당 vCenter 스코프
  assert.ok(!row(snap, '10.28.0.10', '').mgmtStatus);                  // 전역 뷰 → 누수 없음
  rp.deletePolicy(p.policy.id);
});

test('subnet sheet: 빈 셀도 정책 커버리지 표시 + sheet.policies', () => {
  const p = rp.setPolicy({ spec: '10.29.0.0/24', status: 'reserved', label: '예약대역' }, { username: 'op' });
  const snap = snapWith('p10', [['10.29.0.1']]);
  const sheet = ledger.buildSubnetSheets(snap, { onlyBase: '10.29.0' })[0];
  assert.ok(sheet.policies.length >= 1);
  const empty = sheet.rows.find((r) => r.last === 100); // 미사용 셀
  assert.equal(empty.appliedBy, 'range-policy');
  assert.equal(empty.mgmtStatus, 'reserved');
  rp.deletePolicy(p.policy.id);
});
