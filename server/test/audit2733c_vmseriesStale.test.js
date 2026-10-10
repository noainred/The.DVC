/**
 * v2.733 점검 3회차 그룹 c — C1-03(v2.732 회귀): VM 실시간 스파이크 설정의 staleTargets 가 **인벤토리를 아직(또는 지금) 못 읽은
 * vCenter** 의 선택 호스트·VM 전부를 '목록에 없음' 으로 냈다.
 *
 * 재현(검증 C1v): 실제 `store.publishSkeleton`(재시작 직후 골격 — vCenter 는 있고 호스트·VM 0)에 `vmSeriesStaleOf` 를 돌리면
 * 선택 호스트 2 + VM 200 이 전부 칩으로 떴다. 문구가 '정리하라' 로 읽혀 ✕ + 저장하면 수집 대상에서 빠진다.
 * 골격 창뿐 아니라 lastGood 없는 접속 실패(최소 unreachable 항목)·직전 캐시 없는 점검중·비활성·첫 수집 대기(site 포함)도 같다.
 *
 * 규칙: 그 vCenter 의 **수집 상태**로 판정한다 — 골격(initial)·pending·disabled 는 인벤토리가 없다. unreachable·maintenance 는
 * 마지막 정상값을 이월할 때만(그 vCenter 의 호스트·VM 이 스냅샷에 있을 때만) 판정하고, 없으면 판정하지 않는다.
 * 판정하지 않은 vCenter 는 staleUnknown 으로 따로 싣는다. 연결된(connected) vCenter 가 정말 비어 있으면 그대로 판정한다.
 *
 * ⚠ 실제 함수·실제 api 라우터로 값을 본다(소스 grep 아님). CONFIG_DIR 은 config.js 가 import 시점에 굳히므로 맨 위에서 고정한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'a2733c-vs-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* 정리 실패는 결과와 무관 */ } });

const hostIds = (vc, n) => Array.from({ length: n }, (_, i) => `${vc}:host-${i + 1}`);
const vmIds = (vc, n) => Array.from({ length: n }, (_, i) => `${vc}:vm-${i + 1}`);

test('C1-03 골격 스냅샷(재시작 직후) — 선택 호스트·VM 을 목록에 없음으로 내지 않고 staleUnknown 으로 싣는다', async () => {
  const { store } = await import('../src/store.js');
  const { vmSeriesStaleOf } = await import('../src/routes/api/vmSeries.js');
  // 실제 골격 — 등록부: 직접 1 · site 1 · 비활성 1
  const ok = store.publishSkeleton([
    { id: 'vc-d', name: 'D' }, { id: 'vc-s', name: 'S', collectMode: 'site' }, { id: 'vc-x', name: 'X', enabled: false },
  ], 'live');
  assert.equal(ok, true, '픽스처: 골격 게시');
  const snap = store.get();
  assert.equal(snap.initial, true);
  assert.equal(snap.hosts.length, 0);

  const targets = {
    'vc-d': { clusters: [], folders: [], hosts: hostIds('vc-d', 2), vms: vmIds('vc-d', 200) },
    'vc-s': { clusters: [], folders: [], hosts: [], vms: vmIds('vc-s', 3) },
    'vc-x': { clusters: [], folders: [], hosts: hostIds('vc-x', 1), vms: [] },
    'vc-all': { all: true },                      // 등록부에 없는 vCenter — 판정한다(사라진 vCenter)
  };
  const r = vmSeriesStaleOf(targets, snap);
  assert.deepEqual(r.staleIds, ['vc-all'], `골격에서 선택 대상 전부가 칩으로 떴다: ${r.staleIds.length}개`);
  assert.deepEqual(Object.keys(r.staleTargets), ['vc-all']);
  assert.deepEqual(r.staleUnknown['vc-d'], { reason: 'pending', hosts: 2, vms: 200 });
  assert.deepEqual(r.staleUnknown['vc-s'], { reason: 'pending', hosts: 0, vms: 3 });
  assert.deepEqual(r.staleUnknown['vc-x'], { reason: 'disabled', hosts: 1, vms: 0 });
  assert.equal(r.staleUnknown['vc-all'], undefined, '사라진 vCenter 는 판정한다');
});

test('C1-03 병합 스냅샷 — 수집 상태별: 인벤토리를 이월하면 판정, 없으면 판정 안 함 · 연결된 빈 vCenter 는 판정', async () => {
  const { vmSeriesStaleOf } = await import('../src/routes/api/vmSeries.js');
  const snap = {
    generatedAt: new Date().toISOString(), source: 'live',
    vcenters: [
      { id: 'vc-ok', status: 'connected' },
      { id: 'vc-u', status: 'unreachable', error: 'timeout' },                         // lastGood 없음 → 최소 항목
      { id: 'vc-l', status: 'unreachable', stale: true, staleSince: Date.now() - 60_000 }, // lastGood 이월
      { id: 'vc-m', status: 'maintenance', maintenance: true },                        // 직전 캐시 있음
      { id: 'vc-m0', status: 'maintenance', maintenance: true },                       // 직전 캐시 없음
      { id: 'vc-p', status: 'pending', collectSource: 'site' },
      { id: 'vc-empty', status: 'connected' },                                          // 정말 빈 vCenter
    ],
    hosts: [
      { id: 'vc-ok:host-1', vcenterId: 'vc-ok' }, { id: 'vc-l:host-1', vcenterId: 'vc-l' }, { id: 'vc-m:host-1', vcenterId: 'vc-m' },
    ],
    vms: [{ id: 'vc-ok:vm-1', vcenterId: 'vc-ok' }, { id: 'vc-l:vm-1', vcenterId: 'vc-l' }, { id: 'vc-m:vm-1', vcenterId: 'vc-m' }],
    datastores: [], networks: [], alarms: [],
  };
  const T = (vc) => ({ clusters: [], folders: [], hosts: [`${vc}:host-1`, `${vc}:host-old`], vms: [`${vc}:vm-1`, `${vc}:vm-old`] });
  const targets = Object.fromEntries(['vc-ok', 'vc-u', 'vc-l', 'vc-m', 'vc-m0', 'vc-p', 'vc-empty', 'vc-gone'].map((v) => [v, T(v)]));
  targets['vc-u-all'] = { all: true };
  const r = vmSeriesStaleOf(targets, snap);

  // 판정한 vCenter — 이월 인벤토리·연결된 빈 vCenter·사라진 vCenter
  assert.deepEqual(r.staleTargets['vc-ok'], { vcenter: false, hosts: ['vc-ok:host-old'], vms: ['vc-ok:vm-old'] });
  assert.deepEqual(r.staleTargets['vc-l'], { vcenter: false, hosts: ['vc-l:host-old'], vms: ['vc-l:vm-old'] }, 'lastGood 이월은 그 값으로 판정');
  assert.deepEqual(r.staleTargets['vc-m'], { vcenter: false, hosts: ['vc-m:host-old'], vms: ['vc-m:vm-old'] }, '점검중 + 캐시는 판정');
  assert.equal(r.staleTargets['vc-empty'].hosts.length, 2, '연결된 vCenter 가 정말 비었으면 판정한다(지어내지 않는다)');
  assert.equal(r.staleTargets['vc-gone'].vcenter, true);
  // 판정하지 않은 vCenter
  for (const v of ['vc-u', 'vc-m0', 'vc-p']) {
    assert.equal(r.staleTargets[v], undefined, `${v} 는 인벤토리가 없어 판정하지 않는다`);
    assert.ok(!r.staleIds.some((id) => id.startsWith(`${v}:`)), `${v} 의 id 가 staleIds 에 섞였다`);
  }
  assert.deepEqual(r.staleUnknown, {
    'vc-u': { reason: 'unreachable', hosts: 2, vms: 2 },
    'vc-m0': { reason: 'maintenance', hosts: 2, vms: 2 },
    'vc-p': { reason: 'pending', hosts: 2, vms: 2 },
  }, '전체(all) 선택은 판정할 id 가 없어 싣지 않는다');
  const { INVENTORY_UNREAD_REASONS } = await import('../src/routes/api/vmSeries.js');
  for (const e of Object.values(r.staleUnknown)) assert.ok(INVENTORY_UNREAD_REASONS.includes(e.reason), `모르는 사유 코드 ${e.reason}`);
});

/* ── 실제 api 라우터: GET·PUT 이 같은 함수의 staleUnknown 을 싣는다 ── */
const FULL = { username: 'full', role: 'admin', scope: null };
const SADM = { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
const SNAP = {
  generatedAt: new Date().toISOString(), source: 'mock',
  vcenters: [{ id: 'vc-a', name: 'A', status: 'connected' }, { id: 'vc-b', name: 'B', status: 'unreachable', error: 'x' }],
  hosts: [{ id: 'vc-a:host-1', vcenterId: 'vc-a', name: 'esx-a1' }],
  vms: [{ id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'a-vm1', folder: 'F', powerState: 'POWERED_ON' }],
  datastores: [], alarms: [], networks: [],
};
let _app = null;
async function app() {
  if (_app) return _app;
  const { store } = await import('../src/store.js');
  store.snapshot = SNAP;
  const { api } = await import('../src/routes/api.js');
  const a = express();
  a.use(express.json({ limit: '5mb' }));
  a.use((req, _r, n) => { req.user = req.headers['x-u'] === 'sadm' ? SADM : FULL; n(); });
  a.use('/api', api);
  _app = a;
  return a;
}
async function call(user, method, p, body) {
  const a = await app();
  const srv = await new Promise((r) => { const s = a.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api${p}`, {
      method, headers: { 'x-u': user, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
    return { s: res.status, j };
  } finally { srv.close(); }
}

test('C1-03 라우터 — GET·PUT 응답에 staleUnknown, 못 읽은 vCenter 의 선택 대상은 staleIds 에 없다 · 저장은 보존', async () => {
  fs.writeFileSync(path.join(CFG, 'vmseries.json'), JSON.stringify({
    enabled: true, scope: 'selected',
    targets: {
      'vc-a': { clusters: [], folders: [], hosts: ['vc-a:host-1'], vms: ['vc-a:vm-1', 'vc-a:vm-old'] },
      'vc-b': { clusters: [], folders: [], hosts: ['vc-b:host-1'], vms: ['vc-b:vm-1', 'vc-b:vm-2'] },
    },
  }));
  const g = await call('full', 'GET', '/tools/vmseries/settings');
  assert.equal(g.s, 200);
  assert.deepEqual(g.j.staleIds, ['vc-a:vm-old'], `못 읽은 vc-b 의 대상이 목록에 없음으로 섞였다: ${JSON.stringify(g.j.staleIds)}`);
  assert.deepEqual(g.j.staleUnknown, { 'vc-b': { reason: 'unreachable', hosts: 1, vms: 2 } });

  const p = await call('full', 'PUT', '/tools/vmseries/settings', { targets: g.j.settings.targets, scope: 'selected' });
  assert.equal(p.s, 200, JSON.stringify(p.j));
  assert.deepEqual(p.j.staleUnknown, { 'vc-b': { reason: 'unreachable', hosts: 1, vms: 2 } });
  const saved = JSON.parse(fs.readFileSync(path.join(CFG, 'vmseries.json'), 'utf8')).targets;
  assert.deepEqual(saved['vc-b'].vms, ['vc-b:vm-1', 'vc-b:vm-2'], '판정하지 않은 대상은 그대로 보존');

  // 범위 계정 — 범위 밖 vCenter 의 판정 보류도 열거하지 않는다
  const gs = await call('sadm', 'GET', '/tools/vmseries/settings');
  assert.equal(gs.s, 200);
  assert.deepEqual(gs.j.staleUnknown, {});
});
