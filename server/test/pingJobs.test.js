import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueuePing, setPingResults, getPingResults } from '../src/central/pingJobs.js';

test('위임 Ping: up 보고 → up', () => {
  setPingResults('VC1', [{ ip: '10.0.0.5', alive: true, rttMs: 1 }]);
  assert.equal(getPingResults('VC1', ['10.0.0.5'])['10.0.0.5'].state, 'up');
});

test('위임 Ping: 최근 up은 down 보고로 안 덮어쓴다(멀티홈/멀티에이전트)', () => {
  setPingResults('VC2', [{ ip: '10.0.0.9', alive: true, rttMs: 2 }]); // 에이전트A: 닿음
  setPingResults('VC2', [{ ip: '10.0.0.9', alive: false }]);          // 에이전트B: 못 닿음
  // 한 곳이라도 닿았으면 up 유지
  assert.equal(getPingResults('VC2', ['10.0.0.9'])['10.0.0.9'].state, 'up');
});

test('위임 Ping: 처음부터 down이면 down', () => {
  setPingResults('VC3', [{ ip: '10.0.0.7', alive: false }]);
  assert.equal(getPingResults('VC3', ['10.0.0.7'])['10.0.0.7'].state, 'down');
});

test('위임 Ping: 미조회 IP는 pending/unknown', () => {
  enqueuePing('VC4', ['10.0.0.1']);
  assert.equal(getPingResults('VC4', ['10.0.0.1'])['10.0.0.1'].state, 'pending');
  assert.equal(getPingResults('VC4', ['10.0.0.2'])['10.0.0.2'].state, 'unknown');
});
