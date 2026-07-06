import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterScanResults } from '../src/search/deepSearch.js';

const scan = [
  { ip: '10.93.126.48', hostname: 'idrac-a', openPorts: [443, 623], services: ['https', 'ipmi'], lastSeen: 2000 },
  { ip: '10.93.126.49', hostname: 'sw-core', openPorts: [22, 443], services: ['ssh'], lastSeen: 2000 },
  { ip: '203.0.113.9', hostname: 'edge-fw', openPorts: [443], services: ['https'], lastSeen: 2000 },
];
const hist = { '10.93.126.48': { firstSeen: 1000, lastSeen: 2000 } };

test('filterScanResults: IP 접두 매칭', () => {
  const r = filterScanResults(scan, { ip: '10.93.126' }, hist);
  assert.equal(r.length, 2);
  assert.equal(r[0].firstSeen, 1000); // 이력 병합
});

test('filterScanResults: 서브넷(CIDR) 매칭', () => {
  const r = filterScanResults(scan, { subnet: '203.0.113.0/24' }, hist);
  assert.equal(r.length, 1);
  assert.equal(r[0].ip, '203.0.113.9');
});

test('filterScanResults: 검색어(q)로 호스트명/서비스 매칭', () => {
  assert.equal(filterScanResults(scan, { q: 'idrac' }, hist).length, 1);
  assert.equal(filterScanResults(scan, { q: 'ssh' }, hist).length, 1);
});

test('filterScanResults: IP성 조건 없으면 빈 배열(스캔 전체 안 쏟음)', () => {
  assert.equal(filterScanResults(scan, {}, hist).length, 0);
  assert.equal(filterScanResults(scan, { guestOS: 'linux' }, hist).length, 0);
});
