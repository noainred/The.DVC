import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIpamInsights } from '../src/ipam/insights.js';

// 호스트명이 IP면 ledger가 IP 행으로 잡는다(베어메탈/스캔 경로와 동일). 이를 이용해
// 동일 /24에 여러 IP를 만들고 인사이트 계산을 검증한다.
// 디스크에 저장된 스캔 데이터가 섞일 수 있어, 실서비스에 없을 법한 격리 서브넷(10.99.99.x)으로
// 검증한다(다른 서브넷 개수에 의존하지 않게).
const snap = {
  generatedAt: Date.now(),
  vcenters: [{ id: 'vc1', name: 'SEOUL' }],
  vms: [],
  hosts: [
    { name: '10.99.99.1', vcenterId: 'vc1' },
    { name: '10.99.99.2', vcenterId: 'vc1' },
    { name: '10.99.99.3', vcenterId: 'vc1' },
  ],
};

test('buildIpamInsights: 정확히 30개 기능을 반환', () => {
  const r = buildIpamInsights(snap, '');
  assert.equal(Array.isArray(r.features), true);
  assert.equal(r.features.length, 30);
  for (const f of r.features) {
    assert.ok(f.n >= 1 && f.n <= 30);
    assert.ok(f.key && f.title && f.tool);
  }
});

test('buildIpamInsights: 격리 /24 서브넷 집계가 정확', () => {
  const r = buildIpamInsights(snap, '');
  const s = r.subnets.find((x) => x.base === '10.99.99');
  assert.ok(s, '10.99.99 서브넷이 계산되어야 함');
  assert.equal(s.used, 3);                 // .1 .2 .3
  assert.equal(s.gateway, '10.99.99.1');   // .1 존재 → 게이트웨이
  assert.equal(s.nextFree, '10.99.99.4');
  assert.equal(s.total, 254);
  assert.equal(s.free, 251);
});

test('buildIpamInsights: totals가 subnets와 일관됨', () => {
  const r = buildIpamInsights(snap, '');
  assert.ok(r.totals);
  assert.equal(r.totals.subnets, r.subnets.length);
  assert.equal(r.totals.capacity, r.subnets.length * 254);
  assert.ok(r.totals.ips >= 3);
});
