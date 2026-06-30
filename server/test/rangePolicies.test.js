import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam-rp-'));
process.env.CONFIG_DIR = tmp;

let rp;
before(async () => { rp = await import('../src/ipam/rangePolicies.js'); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const ipNum = (s) => { const p = s.split('.').map(Number); return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]; };

test('specToRange: CIDR /24는 net/bcast 제외 [.1,.254], size 254', () => {
  const r = rp.specToRange('10.0.0.0/24');
  assert.equal(r.lo, ipNum('10.0.0.1'));
  assert.equal(r.hi, ipNum('10.0.0.254'));
  assert.equal(r.size, 254);
});

test('specToRange: 범위·단축형·단일 IP', () => {
  assert.deepEqual(rp.specToRange('10.0.0.1-10.0.0.50'), { lo: ipNum('10.0.0.1'), hi: ipNum('10.0.0.50'), size: 50 });
  assert.deepEqual(rp.specToRange('10.0.0.1-50'), { lo: ipNum('10.0.0.1'), hi: ipNum('10.0.0.50'), size: 50 });
  assert.deepEqual(rp.specToRange('10.0.0.5'), { lo: ipNum('10.0.0.5'), hi: ipNum('10.0.0.5'), size: 1 });
  // /31·/32는 전체 포함
  assert.equal(rp.specToRange('10.0.0.0/32').size, 1);
  assert.equal(rp.specToRange('10.0.0.0/31').size, 2);
});

test('specToRange: 무효 spec은 null', () => {
  assert.equal(rp.specToRange('10.0.0.0/33'), null);
  assert.equal(rp.specToRange('10.0.0.50-10.0.0.1'), null);
  assert.equal(rp.specToRange('not-ip'), null);
  assert.equal(rp.specToRange(''), null);
});

test('setPolicy: 생성→id·specLo/Hi/Size·rev 증가, 수정 시 생성필드 보존', () => {
  const r0 = rp.policiesRev();
  const c = rp.setPolicy({ spec: '10.1.0.0/24', status: 'dhcp', owner: 'NetOps', priority: 50 }, { username: 'op' });
  assert.equal(c.ok, true);
  assert.ok(c.policy.id);
  assert.equal(c.policy.specSize, 254);
  assert.equal(c.policy.status, 'dhcp');
  assert.equal(c.policy.createdBy, 'op');
  assert.ok(rp.policiesRev() > r0);
  const created = c.policy.createdAt;
  const u = rp.setPolicy({ id: c.policy.id, owner: 'SecTeam' }, { username: 'op2' });
  assert.equal(u.policy.owner, 'SecTeam');
  assert.equal(u.policy.status, 'dhcp');         // 미지정 필드 보존
  assert.equal(u.policy.createdAt, created);     // 생성시각 보존
  assert.equal(u.policy.createdBy, 'op');
  rp.deletePolicy(c.policy.id);
});

test('setPolicy: ignored는 IGNORE_CAP(1024) 초과 대역 거부', () => {
  const big = rp.setPolicy({ spec: '10.2.0.0/16', status: 'ignored' }, { username: 'op' });
  assert.equal(big.ok, false);
  const ok = rp.setPolicy({ spec: '10.2.0.0/24', status: 'ignored' }, { username: 'op' });
  assert.equal(ok.ok, true);
  rp.deletePolicy(ok.policy.id);
});

test('setPolicy: priority clamp(0..1000), 기본 100', () => {
  const a = rp.setPolicy({ spec: '10.3.0.0/24', priority: -5 }, {});
  assert.equal(a.policy.priority, 0);
  const b = rp.setPolicy({ spec: '10.3.1.0/24', priority: 9999 }, {});
  assert.equal(b.policy.priority, 1000);
  const c = rp.setPolicy({ spec: '10.3.2.0/24' }, {});
  assert.equal(c.policy.priority, 100);
  [a, b, c].forEach((x) => rp.deletePolicy(x.policy.id));
});

test('findPolicy: 범위 내/밖 매칭', () => {
  const p = rp.setPolicy({ spec: '10.4.0.0/24', status: 'reserved' }, {});
  assert.equal(rp.findPolicy(ipNum('10.4.0.10'))?.id, p.policy.id);
  assert.equal(rp.findPolicy(ipNum('10.4.1.10')), null);
  rp.deletePolicy(p.policy.id);
});

test('findPolicy: specificity — /24(dhcp)+/26(reserved) 겹침 시 좁은 /26 우선', () => {
  const wide = rp.setPolicy({ spec: '10.5.0.0/24', status: 'dhcp' }, {});
  const narrow = rp.setPolicy({ spec: '10.5.0.0/26', status: 'reserved' }, {});
  assert.equal(rp.findPolicy(ipNum('10.5.0.10'))?.status, 'reserved'); // /26 안
  assert.equal(rp.findPolicy(ipNum('10.5.0.200'))?.status, 'dhcp');    // /26 밖, /24 안
  [wide, narrow].forEach((x) => rp.deletePolicy(x.policy.id));
});

test('findPolicy: priority tiebreak(같은 폭) + enabled=false 제외', () => {
  const lo = rp.setPolicy({ spec: '10.6.0.0/24', status: 'dhcp', priority: 10 }, {});
  const hi = rp.setPolicy({ spec: '10.6.0.0/24', status: 'reserved', priority: 900 }, {});
  assert.equal(rp.findPolicy(ipNum('10.6.0.10'))?.status, 'reserved'); // priority 높은 것
  rp.setPolicy({ id: hi.policy.id, enabled: false }, {});
  assert.equal(rp.findPolicy(ipNum('10.6.0.10'))?.status, 'dhcp');     // 비활성 제외 → 남은 것
  [lo, hi].forEach((x) => rp.deletePolicy(x.policy.id));
});

test('findPolicy: claimedVcenterId 스코프', () => {
  const jp = rp.setPolicy({ spec: '10.7.0.0/24', status: 'reserved', claimedVcenterId: 'vc-jp' }, {});
  assert.equal(rp.findPolicy(ipNum('10.7.0.10'), 'vc-jp')?.id, jp.policy.id); // 해당 vCenter
  assert.equal(rp.findPolicy(ipNum('10.7.0.10'), 'vc-us'), null);             // 다른 vCenter
  assert.equal(rp.findPolicy(ipNum('10.7.0.10'), ''), null);                  // 전역 뷰 → 스코프 정책 누수 없음
  rp.deletePolicy(jp.policy.id);
});

test('policiesSummary: 합계·상태·커버 IP', () => {
  const a = rp.setPolicy({ spec: '10.8.0.0/24', status: 'dhcp' }, {});
  const b = rp.setPolicy({ spec: '10.8.1.0/25', status: 'reserved' }, {});
  const s = rp.policiesSummary();
  assert.ok(s.total >= 2);
  assert.ok(s.coverageIps >= 254 + 126);
  assert.ok(s.byStatus.dhcp >= 1 && s.byStatus.reserved >= 1);
  [a, b].forEach((x) => rp.deletePolicy(x.policy.id));
});
