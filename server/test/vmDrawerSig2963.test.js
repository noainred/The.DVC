/**
 * test/vmDrawerSig2963.test.js — v2.963 VM 드로어 신호(시안 docs/design/vm-perf §9 '남긴 것'): 목록 없이 연 드로어가 `/vms/lookup?id&signals=1` 로
 *   신호를 받는다. 판정은 `/vms?signals=1` 과 **같은 vmSignalsOf + 같은 문맥** — 두 응답이 같은 VM 에 같은 신호를 준다(대조).
 *   signals 가 없으면 응답 모양은 예전 그대로({vm}) · 범위 밖 id 는 null(존재 은닉 — 예전 그대로) · 원본 스냅샷 객체에 signals 를 쓰지 않는다.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vmdrawersig2963-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

// 기준 시각은 정시 경계로(docs/rules/common.md) — 스냅샷 나이 판정이 실행 시각에 흔들리지 않게 '30일 전' 으로 넉넉히 둔다.
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const base = { vcenterId: 'vc-a', host: 'h1', cluster: 'C1', cpuCount: 2, memMB: 4096 };
const VMS = [
  { ...base, id: 'vc-a:hot', name: 'hot-01', powerState: 'POWERED_ON', cpuUsagePct: 96, memUsagePct: 40, toolsVersionStatus: 'guestToolsCurrent' },
  { ...base, id: 'vc-a:old', name: 'old-01', powerState: 'POWERED_ON', cpuUsagePct: 10, memUsagePct: 20, toolsVersionStatus: 'guestToolsNeedUpgrade', snapshotCount: 1, snapshotSizeGB: 2, snapshotOldestTs: NOW - 30 * 24 * HOUR },
  { ...base, id: 'vc-a:quiet', name: 'quiet-01', powerState: 'POWERED_ON', cpuUsagePct: 10, memUsagePct: 20, toolsVersionStatus: 'guestToolsCurrent' },
  { ...base, id: 'vc-a:unk', name: 'unk-01', powerState: 'POWERED_ON', cpuUsagePct: null, memUsagePct: 20, toolsVersionStatus: 'guestToolsCurrent' },
  { ...base, vcenterId: 'vc-b', id: 'vc-b:hot', name: 'hot-b', powerState: 'POWERED_ON', cpuUsagePct: 99, memUsagePct: 99 },
];

let baseUrl; let store;
before(async () => {
  ({ store } = await import('../src/store.js'));
  store.snapshot = {
    ...(store.get() || {}), source: 'live', generatedAt: new Date(NOW).toISOString(),
    vcenters: [{ id: 'vc-a', name: 'VC-A', status: 'connected' }, { id: 'vc-b', name: 'VC-B', status: 'connected' }],
    vms: VMS.map((v) => ({ ...v })), hosts: [], datastores: [], networks: [], alarms: [],
  };
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    let scope = null; try { scope = req.get('x-scope') ? JSON.parse(req.get('x-scope')) : null; } catch { scope = null; }
    req.user = { username: 'adm', role: 'admin', scope }; next();
  });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  baseUrl = `http://127.0.0.1:${srv.address().port}`;
});

const get = async (p, headers = {}) => {
  const r = await fetch(`${baseUrl}${p}`, { headers });
  return { status: r.status, j: await r.json() };
};
const lookup = (id, extra = '') => get(`/api/vms/lookup?id=${encodeURIComponent(id)}${extra}`);

test('lookup?signals=1 — 신호 · 기준 일수를 싣고, /vms?signals=1 과 같은 VM 에 같은 신호(판정 한 벌)', async () => {
  const list = await get('/api/vms?vcenterId=vc-a&signals=1&limit=50');
  assert.equal(list.status, 200);
  const byId = new Map(list.j.items.map((v) => [v.id, v.signals]));
  for (const v of VMS.filter((x) => x.vcenterId === 'vc-a')) {
    const r = await lookup(v.id, '&signals=1');
    assert.equal(r.status, 200);
    assert.equal(r.j.vm.id, v.id);
    assert.deepEqual(r.j.vm.signals, byId.get(v.id), `${v.id}: lookup ${JSON.stringify(r.j.vm.signals)} ≠ list ${JSON.stringify(byId.get(v.id))}`);
    assert.equal(r.j.snapAgeDays, list.j.signalCounts.snapAgeDays);
  }
  assert.deepEqual((await lookup('vc-a:hot', '&signals=1')).j.vm.signals, ['overload']);
  assert.deepEqual((await lookup('vc-a:old', '&signals=1')).j.vm.signals, ['toolsOld', 'snapOld']);
  assert.deepEqual((await lookup('vc-a:quiet', '&signals=1')).j.vm.signals, []);
  assert.deepEqual((await lookup('vc-a:unk', '&signals=1')).j.vm.signals, ['usageUnknown'], '못 읽은 사용률은 과부하가 아니라 미수집');
  assert.equal((await lookup('vc-a:hot', '&signals=1')).j.snapAgeDays, 7, '기본 설정 기준 일수');
  assert.deepEqual((await lookup('vc-a:hot', '&signals=true')).j.vm.signals, ['overload']);
});

test('signals 가 없으면 응답은 예전 그대로({vm}) · 원본 스냅샷 객체에 signals 를 쓰지 않는다', async () => {
  const r = await lookup('vc-a:hot');
  assert.deepEqual(Object.keys(r.j), ['vm']);
  assert.equal('signals' in r.j.vm, false);
  const r0 = await lookup('vc-a:hot', '&signals=0');
  assert.equal('signals' in r0.j.vm, false);
  await lookup('vc-a:hot', '&signals=1');
  assert.equal('signals' in store.get().vms.find((v) => v.id === 'vc-a:hot'), false, '원본을 바꾸면 다른 응답 · 캐시에 신호가 샌다');
});

test('범위 밖 id 는 signals=1 이어도 null(존재 은닉 — 신호로 새지 않는다) · 없는 id 는 null', async () => {
  const sc = JSON.stringify({ vcenters: ['vc-a'] });
  const out = await get(`/api/vms/lookup?id=${encodeURIComponent('vc-b:hot')}&signals=1`, { 'x-scope': sc });
  assert.equal(out.status, 200);
  assert.deepEqual(out.j, { vm: null });
  const inside = await get(`/api/vms/lookup?id=${encodeURIComponent('vc-a:hot')}&signals=1`, { 'x-scope': sc });
  assert.deepEqual(inside.j.vm.signals, ['overload']);
  assert.deepEqual((await lookup('vc-a:nope', '&signals=1')).j, { vm: null });
});
