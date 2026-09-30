// powerTotal2664.test.js — v2.664 전체 소비 전력 합산 · Overview 카드 · Unity 전원 수집.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'power2664-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'mock';

const { buildPowerTotal, cvpDevicePower, NET_STALE_MS } = await import('../src/power/total.js');
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;

test('① CVP 장비 전력 — PSU 입력 합, 입력이 없으면 출력(basis 표시), 못 읽으면 null', () => {
  assert.deepEqual(cvpDevicePower({ partsList: [{ kind: 'psu', power: { inW: 210.4 } }, { kind: 'psu', power: { inW: 190 } }, { kind: 'fan' }] }), { watts: 400, basis: 'input', psus: 2, read: 2 });
  assert.equal(cvpDevicePower({ partsList: [{ kind: 'psu', power: { outW: 150 } }] }).basis, 'output');
  assert.equal(cvpDevicePower({ partsList: [{ kind: 'psu', state: 'ok' }] }).watts, null, '값 없는 PSU 를 0 W 로 세지 않는다');
  assert.equal(cvpDevicePower({ partsList: null }).watts, null);
  assert.equal(cvpDevicePower({ partsList: [{ kind: 'psu', power: { inW: -5 } }] }).watts, null, '음수는 버린다');
});

test('② 합산 — vCenter 추정 제외 · 미측정/낡음/경로 없음을 따로 센다 · 법인별', () => {
  const r = buildPowerTotal({
    now: NOW,
    servers: [
      { serverId: 's1', serverName: 'a', watts: 500, source: 'idrac', datacenterId: 'HG' },
      { serverId: 's2', serverName: 'b', watts: 300, source: 'remote', vcenterId: 'vc1' },
      { serverId: 'vc:x', serverName: 'c', watts: 999, source: 'vcenter' },
      { serverId: 's3', serverName: 'd', watts: null, source: 'idrac' },
    ],
    network: [
      { cvpId: 'c', key: 'n1', hostname: 'sw1', partsAt: NOW - 60_000, partsList: [{ kind: 'psu', power: { inW: 200 } }], corp: { corpId: 'HG' } },
      { cvpId: 'c', key: 'n2', hostname: 'sw2', partsAt: NOW - NET_STALE_MS - 1, partsList: [{ kind: 'psu', power: { inW: 200 } }], corp: { corpId: 'HG' } },
      { cvpId: 'c', key: 'n3', hostname: 'sw3', partsAt: NOW, partsList: [], corp: { corpId: 'NJ' } },
    ],
    storage: [
      { id: 'u1', name: 'unity', type: 'unity480', collectMethod: 'ssh', datacenterId: 'NJ', snap: { extra: { power: { watts: 660, at: NOW } } } },
      { id: 'u2', name: 'unity2', type: 'unity480', collectMethod: 'ssh', snap: { extra: {} } },
      { id: 'i1', name: 'isilon', type: 'isilon', snap: { ok: true } },
      { id: 'off', type: 'isilon', enabled: false },
    ],
    dcOfVc: (vc) => (vc === 'vc1' ? 'NJ' : ''),
  });
  assert.equal(r.servers.watts, 800); assert.equal(r.servers.measured, 2); assert.equal(r.servers.excludedVcenter, 1);
  assert.equal(r.network.watts, 200); assert.equal(r.network.stale, 1); assert.equal(r.network.unread, 1); assert.equal(r.network.devices, 3);
  assert.equal(r.storage.watts, 660); assert.equal(r.storage.unread, 1, 'Unity SSH 인데 못 읽음'); assert.equal(r.storage.unsupported, 1, 'Isilon 은 수집 경로 없음'); assert.equal(r.storage.devices, 3, '비활성 제외');
  assert.equal(r.totalWatts, 1660);
  const hg = r.byCorp.find((c) => c.corpId === 'HG'); const nj = r.byCorp.find((c) => c.corpId === 'NJ');
  assert.deepEqual([hg.servers, hg.network, hg.total], [500, 200, 700]);
  assert.deepEqual([nj.servers, nj.storage, nj.total], [300, 660, 960]);
  assert.equal(r.byCorp[0].corpId, 'NJ', '법인은 합계 큰 순');
});

test('③ 스토리지 용량 합 — 전체 용량을 읽은 장비만 · 사용률은 사용량을 읽은 장비끼리', async () => {
  const { storageCapacityTotals } = await import('../src/routes/api/overviewCards.js');
  const r = storageCapacityTotals([
    { snap: { ok: true, capacity: { totalBytes: 100, usedBytes: 40 } } },
    { snap: { ok: true, capacity: { totalBytes: 100, usedBytes: null } } },
    { snap: { ok: false, capacity: { totalBytes: 0 } } },
    { snap: null },
    { enabled: false, snap: { ok: true, capacity: { totalBytes: 999 } } },
  ]);
  assert.deepEqual(r, { devices: 4, read: 2, unread: 2, totalBytes: 200, usedBytes: 40, usedPct: 40 });
  assert.equal(storageCapacityTotals([]).totalBytes, null, '0 TB 가 아니라 모름');
});

test('④ 라우트 — /overview/cards 8카드 · /tools/power-total 200', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json()); app.use('/api', api);
  const srv = app.listen(0); await new Promise((ok) => srv.once('listening', ok));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  try {
    const c = await (await fetch(`${base}/overview/cards`)).json();
    for (const k of ['datacenters', 'farms', 'physical', 'virtual', 'gpus', 'storage', 'network', 'power']) assert.ok(c[k], k);
    assert.equal(typeof c.virtual.count, 'number');
    const p = await fetch(`${base}/tools/power-total`);
    assert.equal(p.status, 200);
    const j = await p.json();
    assert.ok('totalWatts' in j && Array.isArray(j.byCorp));
  } finally { srv.close(); }
});

test('⑤ Unity 전원 — spinfo 픽스처에서 입력 전력 합을 읽는다(0 을 지어내지 않는다)', async () => {
  const { parseSpinfo } = await import('../src/storage/collectors/svcDiag.js');
  const txt = fs.readFileSync(new URL('./fixtures/spinfo-sample.txt', import.meta.url), 'utf8');
  const p = parseSpinfo(txt).power;
  assert.ok(p.totalWatts > 0 && p.readWatts >= 1, JSON.stringify(p));
  assert.equal(parseSpinfo('nothing').power.totalWatts, null);
});
