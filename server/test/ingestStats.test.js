import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordIngest, getIngestStats, resetIngestStats } from '../src/central/ingestStats.js';

beforeEach(() => resetIngestStats());

test('recordIngest/getIngestStats: 에이전트별 집계 + 와이어바이트 내림차순', () => {
  recordIngest('gm2-agent', '/inventory', { wireBytes: 5_000_000, summary: { vcenterId: 'GM2', hosts: 30, vms: 281 } });
  recordIngest('gm2-agent', '/inventory', { wireBytes: 5_000_000, summary: { vcenterId: 'GM2', hosts: 30, vms: 281 } });
  recordIngest('wa-agent', '/inventory', { wireBytes: 200_000, summary: { vcenterId: 'WA', hosts: 61, vms: 452 } });

  const s = getIngestStats();
  assert.equal(s.agents, 2);
  assert.equal(s.rows[0].agent, 'gm2-agent', '트래픽 큰 에이전트가 맨 위');
  assert.equal(s.rows[0].pushes, 2);
  assert.equal(s.rows[0].wireBytes, 10_000_000);
  assert.equal(s.rows[0].avgBytes, 5_000_000);
  assert.equal(s.rows[0].last.vms, 281);
  assert.equal(s.rows[0].last.hosts, 30);
  // WA는 호스트가 더 많아도(61) 트래픽은 작음 → 트래픽이 호스트 수에 비례하지 않음을 검증.
  const wa = s.rows.find((r) => r.agent === 'wa-agent');
  assert.equal(wa.wireBytes, 200_000);
  assert.ok(s.rows[0].wireBytes > wa.wireBytes * 10);
  assert.equal(s.totalBytes, 10_200_000);
});

test('엔드포인트별 분해 + unknown 폴백', () => {
  recordIngest('', '/ping', { wireBytes: 100 });
  recordIngest('a1', '/inventory', { wireBytes: 1000 });
  recordIngest('a1', '/gpu-guest', { wireBytes: 500 });
  const s = getIngestStats();
  const a1 = s.rows.find((r) => r.agent === 'a1');
  assert.equal(a1.byEndpoint.length, 2);
  assert.ok(s.rows.find((r) => r.agent === '(unknown)'));
});

test('resetIngestStats: 초기화', () => {
  recordIngest('x', '/inventory', { wireBytes: 1 });
  assert.equal(getIngestStats().agents, 1);
  resetIngestStats();
  assert.equal(getIngestStats().agents, 0);
});
