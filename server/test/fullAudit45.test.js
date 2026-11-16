/**
 * 전체 점검 45회차(44회차 수정 반증) 회귀 고정.
 *  F1 인벤토리를 비운 vCenter(수집 꺼짐 · 장기 장애 · 점검 중)의 GPU 할당률 알림이 '해소' 로 기록되던 것 → 보류
 *  F2 계층이 상한으로 잘리면 gpualloc 전부 보류(GPU 호스트가 통째로 잘린 법인 포함)
 *  F5 vSGA 만 있는 법인(할당형 GPU 0장)은 헬스체크 '확인 불가' 가 아니다
 *  F6 Horizon 2쪽 이후 404 는 '이 버전에 없는 경로(no-endpoint)' 가 아니다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fa45-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'false';
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const { store } = await import('../src/store.js');
const alerts = await import('../src/alerts.js');

const CFG = { cooldownMin: 60, rules: { gpuAllocPct: { enabled: true, threshold: 90 } } };
async function runWith(snap) {
  const orig = store.get;
  store.get = () => snap;
  try { await alerts._refreshStateForTest(CFG, false); } finally { store.get = orig; }
  return alerts.alertStatus();
}
const resolvedKeys = (st) => new Set(st.recent.filter((r) => r.severity === 'resolved').map((r) => r.key));
const vg = (profile) => ({ type: 'vgpu', count: 1, vgpu: 1, passthrough: 0, profile });
const fullSnap = (status = 'connected') => ({
  vcenters: [{ id: 'vc1', status }],
  hosts: [{ id: 'vc1:h1', vcenterId: 'vc1', name: 'esx1', cluster: 'CL', vcDatacenter: 'DC', connectionState: 'CONNECTED', gpus: [{ model: 'NVIDIA L4', memGB: 24, mode: 'vgpu', vms: ['vm-1', 'vm-2'] }] }],
  vms: ['vm-1', 'vm-2'].map((id) => ({ id: `vc1:${id}`, name: id, host: 'esx1', vcenterId: 'vc1', powerState: 'POWERED_ON', gpu: vg('nvidia_l4-12q') })),
  datastores: [], alarms: [],
});

test('45회차 F1: 인벤토리를 비운 vCenter 의 GPU 할당률 알림은 해소가 아니라 보류 — 다시 연결돼 정말 없으면 그때 해소', async () => {
  alerts._resetAlertStateForTest();
  let st = await runWith(fullSnap());
  assert.ok(st.firing.some((f) => f.key === 'gpualloc:vc1'), '100% 할당 → 발생');
  for (const status of ['disabled', 'unreachable', 'maintenance']) {
    st = await runWith({ vcenters: [{ id: 'vc1', status }], hosts: [], vms: [], datastores: [], alarms: [] });
    assert.ok(!resolvedKeys(st).has('gpualloc:vc1'), `${status}: 못 읽은 것을 해소로 기록하면 안 된다`);
    assert.ok(st.firing.some((f) => f.key === 'gpualloc:vc1'));
  }
  st = await runWith({ vcenters: [{ id: 'vc1', status: 'connected' }], hosts: [], vms: [], datastores: [], alarms: [] });
  assert.ok(resolvedKeys(st).has('gpualloc:vc1'), '보류가 해소를 영원히 막지는 않는다');
});

test('45회차 F2: 계층이 상한으로 잘리면 gpualloc 키 전부를 보류한다(소스)', () => {
  const s = stripComments(fs.readFileSync(new URL('../src/alerts.js', import.meta.url), 'utf8'));
  assert.match(s, /if \(tree\.truncated\) heldPrefixes\.add\('gpualloc:'\);/);
  assert.match(s, /const UNREAD_VC_KEY_RE = \/\^\(alarm\|host\|ds\|gpualloc\):\/;/);
});

test('45회차 F5: vSGA 만 있는 법인은 헬스체크 확인 불가가 아니다(할당형 GPU 0장 = 해당 없음)', async () => {
  const { computeHealthReport } = await import('../src/reports/healthReport.js');
  const snap = { vcenters: [{ id: 'vc1', status: 'connected' }],
    hosts: [{ id: 'vc1:h1', vcenterId: 'vc1', name: 'esx1', cluster: 'CL', vcDatacenter: 'DC', connectionState: 'CONNECTED', gpus: [{ model: 'NVIDIA A40', memGB: 48, mode: 'vsga', vms: [] }] }],
    vms: [], datastores: [], alarms: [] };
  const s = computeHealthReport(snap, { now: Date.now() }).sections.find((x) => x.key === 'gpuAlloc');
  assert.ok(s, 'GPU 호스트가 있는 법인이라 절은 싣는다');
  assert.equal(s.unknown, 0);
  assert.notEqual(s.status, 'unknown');
});

test('45회차 F6: Horizon 2쪽 이후 404 는 no-endpoint(경로 없음)로 분류하지 않는다', async () => {
  const { collectServerSessions } = await import('../src/horizon/sessionCollect.js');
  const orig = globalThis.fetch;
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/rest/login')) return json({ access_token: 't' });
    if (u.endsWith('/rest/logout')) return json({});
    const p = Number(new URL(u).searchParams.get('page'));
    if (p === 2) return json({ error_message: 'x' }, 404);
    return json([{ id: 'a', user_name: 'a', session_state: 'CONNECTED' }, { id: 'b', user_name: 'b', session_state: 'CONNECTED' }], 200, { HAS_MORE_RECORDS: 'true' });
  };
  try {
    const r = await collectServerSessions({ id: 'hz45', name: 'HZ', host: 'https://hz.example.com', username: 'u', password: 'p', domain: 'CORP', timeoutMs: 5_000 }, { pageSize: 2, maxPages: 5, catalog: false });
    assert.equal(r.ok, false);
    assert.notEqual(r.kind, 'no-endpoint', '1쪽은 이미 성공했다 — 경로가 없다는 판정 · 6시간 쉼은 거짓');
    assert.equal(r.kind, 'http');
  } finally { globalThis.fetch = orig; }
});
