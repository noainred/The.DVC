import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setEdgeFleet, getEdgeFleetServers, listEdgeFleet, resetEdgeFleet } from '../src/central/fleet.js';

beforeEach(() => resetEdgeFleet());

test('setEdgeFleet: 엣지 push 전력은 항상 null로 정규화(이중계상 차단)', () => {
  setEdgeFleet('Seoul-DC1', [
    { fleetId: 'st-1', name: 'bm-1', serviceTag: 'ST1', watts: 350, vcenterId: 'vc-kr', source: 'idrac' },
    { fleetId: 'st-2', name: 'bm-2', serviceTag: 'ST2', vcenterId: '', source: 'host' },
  ], 'now');
  const out = getEdgeFleetServers();
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'edge');
  assert.equal(out[0].watts, null);  // 350W를 보냈어도 메타 전용 → null
  assert.equal(out[1].watts, null);
  assert.equal(out[0].remoteAgent, 'Seoul-DC1');
});

test('listEdgeFleet: 에이전트별 보고 요약', () => {
  setEdgeFleet('DC-A', [{ fleetId: 'a1', name: 'a', serviceTag: 'A1' }], 'g');
  setEdgeFleet('DC-B', [{ fleetId: 'b1', name: 'b', serviceTag: 'B1' }, { fleetId: 'b2', name: 'b2', serviceTag: 'B2' }], 'g');
  const ls = listEdgeFleet();
  assert.equal(ls.length, 2);
  assert.equal(ls.find((x) => x.agent === 'DC-B').baremetal, 2);
});
