// v2.632 그룹 F(서버쪽) — WEB2632-03 인사이트 토폴로지 사용률 결측 · WEB2632-04 예측 목록 상한 표지.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTopology } from '../src/insights/topology.js';
import { withForecastCap, FORECAST_LIST_LIMIT } from '../src/routes/api/reports.js';

const snap = {
  vcenters: [{ id: 'vc1', name: 'VC1', status: 'connected' }],
  hosts: [
    { id: 'h1', name: 'esx1', vcenterId: 'vc1', cluster: 'C', connectionState: 'CONNECTED', cpuUsagePct: 42, memUsagePct: 0 },
    { id: 'h2', name: 'esx2', vcenterId: 'vc1', cluster: 'C', connectionState: 'DISCONNECTED', cpuUsagePct: 0, memUsagePct: 0 },
    { id: 'h3', name: 'esx3', vcenterId: 'vc1', cluster: 'C', connectionState: 'NOT_RESPONDING', cpuUsagePct: 10, memUsagePct: 10 },
    { id: 'h4', name: 'esx4', vcenterId: 'vc1', cluster: 'C', connectionState: 'CONNECTED' },
  ],
  vms: [
    { id: 'v1', name: 'vm1', vcenterId: 'vc1', host: 'esx1', powerState: 'POWERED_ON', cpuUsagePct: null, memUsagePct: undefined },
    { id: 'v2', name: 'vm2', vcenterId: 'vc1', host: 'esx1', powerState: 'POWERED_ON', cpuUsagePct: 0, memUsagePct: 25 },
  ],
};
const hostsOf = (t) => Object.fromEntries(t.tree[0].children.flatMap((c) => c.children).map((h) => [h.label, h]));

test('WEB2632-03 끊긴·무응답 호스트의 사용률은 null(0% 아님), 연결 호스트의 0 은 값', () => {
  const h = hostsOf(buildTopology(snap, {}));
  assert.equal(h.esx1.cpuPct, 42);
  assert.equal(h.esx1.memPct, 0);
  assert.equal(h.esx2.cpuPct, null);
  assert.equal(h.esx2.memPct, null);
  assert.equal(h.esx3.cpuPct, null);
  assert.equal(h.esx4.cpuPct, null, '값이 없으면 null');
});

test('WEB2632-03 VM 사용률 결측은 null, 0 은 0', () => {
  const h = hostsOf(buildTopology(snap, { vcenterId: 'vc1' }));
  const vms = Object.fromEntries(h.esx1.children.map((v) => [v.label, v]));
  assert.equal(vms.vm1.cpuPct, null);
  assert.equal(vms.vm1.memPct, null);
  assert.equal(vms.vm2.cpuPct, 0);
  assert.equal(vms.vm2.memPct, 25);
});

test('WEB2632-04 예측 목록이 상한에 닿으면 capped + listLimit, 아니면 false', () => {
  const full = withForecastCap({ datastores: Array.from({ length: FORECAST_LIST_LIMIT }, (_, i) => ({ id: i })), gpu: [] });
  assert.equal(full.listLimit, 100);
  assert.equal(full.datastoresCapped, true);
  assert.equal(full.gpuCapped, false);
  const small = withForecastCap({ datastores: [{ id: 1 }], gpu: [{}] });
  assert.equal(small.datastoresCapped, false);
  assert.equal(withForecastCap(null), null);
});
