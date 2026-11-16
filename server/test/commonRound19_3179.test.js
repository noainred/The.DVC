/**
 * 2차 공통 기능 점검 9회차: 클러스터 RAM 오버커밋 · vCPU:코어 알림이 못 읽은 호스트 용량을 0 으로 더해 거짓 알림을 냈다.
 * 판정은 용량 도구와 같은 store.hostCapacityKnown 하나(코어 · CPU MHz · 메모리 셋 다 수일 때만 읽은 것).
 * (연결 끊긴 호스트의 메모리 · 코어가 null 이면 분모만 줄고 VM 할당은 그대로 → 오버커밋이 부풀었다 — '부분 합' 규약 위반.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts3179-'));
const { evaluate } = await import('../src/alerts.js');

const cfg = { rules: { ramOvercommitPct: { enabled: true, threshold: 120 }, vcpuPerCore: { enabled: true, threshold: 5 } } };
const vms = (n, cpu, memMB) => Array.from({ length: n }, (_, i) => ({ id: `v${i}`, vcenterId: 'vc1', cluster: 'c1', powerState: 'POWERED_ON', cpuCount: cpu, memMB }));
const keys = (out) => out.map((x) => x.key).filter((k) => /^(ramoc|vcpuoc):/.test(k));

test('못 읽은 호스트 용량이 있으면 그 클러스터의 오버커밋을 판정하지 않는다(거짓 알림 없음)', () => {
  // 호스트 2대(각 64GB · 16코어) 중 1대가 연결 끊김(null). VM 할당 100GB · 40 vCPU — 두 대 다 읽으면 78% · 1.25:1 로 정상.
  const snap = { hosts: [
    { vcenterId: 'vc1', cluster: 'c1', cpuCores: 16, cpuTotalMhz: 40000, memTotalMB: 65536 },
    { vcenterId: 'vc1', cluster: 'c1', cpuCores: null, cpuTotalMhz: null, memTotalMB: null, connectionState: 'DISCONNECTED' },
  ], vms: vms(10, 4, 10240) };
  assert.deepEqual(keys(evaluate(snap, cfg)), [], '부분 합으로 오버커밋을 말했다');
});

test('다 읽었으면 예전대로 판정한다', () => {
  const snap = { hosts: [{ vcenterId: 'vc1', cluster: 'c1', cpuCores: 4, cpuTotalMhz: 10000, memTotalMB: 8192 }], vms: vms(10, 4, 10240) };
  assert.deepEqual(keys(evaluate(snap, cfg)).sort(), ['ramoc:vc1:c1', 'vcpuoc:vc1:c1']);
});

test('9회차 보완 — 발생 중인 오버커밋 알림은 호스트 하나가 끊긴 주기에 거짓 해소되지 않는다(보류 키 · 시한은 HELD_MAX_MS)', async () => {
  const alerts = await import('../src/alerts.js');
  const { store } = await import('../src/store.js');
  const full = structuredClone(alerts.loadAlertConfig());
  for (const k of Object.keys(full.rules)) if (full.rules[k] && typeof full.rules[k] === 'object') full.rules[k].enabled = false;
  Object.assign(full.rules, cfg.rules);
  alerts._resetAlertStateForTest();
  const firingKeys = () => alerts.alertStatus().firing.map((f) => f.key).filter((k) => /^(ramoc|vcpuoc):/.test(k)).sort();
  const host = (ok) => ({ vcenterId: 'vc1', cluster: 'c1', cpuCores: ok ? 4 : null, cpuTotalMhz: ok ? 10000 : null, memTotalMB: ok ? 8192 : null });
  const snapOf = (hosts) => ({ vcenters: [], hosts, vms: vms(10, 4, 10240), datastores: [], alarms: [] });
  store.snapshot = snapOf([host(true)]);
  await alerts._refreshStateForTest(full, false);
  assert.deepEqual(firingKeys(), ['ramoc:vc1:c1', 'vcpuoc:vc1:c1']);
  // 같은 클러스터에 용량을 못 읽은 호스트가 생긴 주기 — 판정은 건너뛰되 해소가 아니라 보류다.
  const ev = alerts.evaluate(snapOf([host(true), host(false)]), full);
  assert.ok(ev.held.has('ramoc:vc1:c1') && ev.held.has('vcpuoc:vc1:c1'), '판정을 건너뛴 클러스터는 보류 키');
  store.snapshot = snapOf([host(true), host(false)]);
  await alerts._refreshStateForTest(full, false);
  assert.deepEqual(firingKeys(), ['ramoc:vc1:c1', 'vcpuoc:vc1:c1'], '못 읽은 주기에 해소로 보내면 안 된다');
  assert.ok(!alerts.alertStatus().recent.some((r) => r.severity === 'resolved' && /오버커밋|vCPU:코어/.test(r.title || '')), '거짓 해소 알림 없음');
  alerts._resetAlertStateForTest();
});
