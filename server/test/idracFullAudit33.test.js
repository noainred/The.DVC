/**
 * 전체 점검 33회차(iDRAC · 파트 장애 · 전력 · 법인 사용률) 회귀.
 *  F1: iDRAC · NSX 연결 테스트도 등록과 같은 SSRF 정적 가드(루프백 등 — 요청을 보내지 않는다).
 *  F2: 시리얼 키 부품을 새 부품으로 교체하면 옛 장애를 '제거됨' 으로 닫는다(모호하면 보류 그대로).
 *  F3 · F4: 물리 코어 대체 합은 장착 소켓을 다 읽었을 때만 · 법인 사용량 용량 판정은 capacityOfInventory 하나.
 *  F5 · F6: 엣지 보고의 omitted · intervalMs 정제.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'idrac-audit33-'));
process.env.CONFIG_DIR = path.join(TMP, 'cfg');
process.env.DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('F1: iDRAC · NSX 연결 테스트는 루프백 등 SSRF 거부 대상에 요청을 보내지 않는다', async () => {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.url); res.writeHead(404); res.end('{}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${srv.address().port}`;
  try {
    const idrac = await import('../src/idrac/registry.js');
    const r1 = await idrac.testServer({ host, username: 'root', password: 'calvin' });
    assert.equal(r1.ok, false);
    assert.match(r1.reason, /^host 거부/);
    const nsx = await import('../src/nsx/registry.js');
    const r2 = await nsx.testConnection({ host: `https://127.0.0.1:${srv.address().port}`, username: 'admin', password: 'x' });
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /^host 거부/);
    for (const h of ['https://169.254.169.254', 'https://0x7f000001']) {
      const r = await idrac.testServer({ host: h, username: 'u', password: 'p' });
      assert.match(r.reason, /^host 거부/, h);
    }
    assert.equal(hits.length, 0, '루프백 서버에 요청이 가지 않는다');
  } finally { srv.close(); }
});

test('F2: 시리얼 키 PSU 교체 → 옛 장애는 제거됨으로 닫힘 · 모호 · 수집 실패 · 못 읽음은 보류', async () => {
  const { extractIdracParts } = await import('../src/partfault/extract/idrac.js');
  const { transition } = await import('../src/partfault/transition.js');
  const server = { id: '10.0.0.5', name: 'srv1', serviceTag: 'ABC1234', agent: '' };
  const coll = { system: 'ok', psus: 'ok', disks: 'ok', storageControllers: 'ok', memoryDimms: 'ok', cpus: 'ok', gpus: 'ok', pcie: 'ok', fans: 'ok' };
  const inv = (psus, c = coll) => ({ reachable: true, collections: c, system: { serviceTag: 'ABC1234', model: 'R750' }, psus, disks: [], memoryDimms: [], cpus: [], gpus: [], pcie: [], storageControllers: [], fans: [] });
  const ps2 = { name: 'PS2 Status', serial: 'PS2SER', health: 'OK', state: 'Enabled' };
  const scan = { deviceOk: { '|10.0.0.5': true }, kindFailed: {}, agentsReported: new Set(['']) };
  const t1 = transition({ open: [], observed: extractIdracParts(server, inv([{ name: 'PS1 Status', serial: 'OLD111', health: 'Critical', state: 'Enabled' }, ps2])).parts, scan, now: 1000 });
  assert.equal(t1.opened.length, 1);
  // 교체(정상 새 부품)
  const t2 = transition({ open: t1.opened, observed: extractIdracParts(server, inv([{ name: 'PS1 Status', serial: 'NEW222', health: 'OK', state: 'Enabled' }, ps2])).parts, scan, now: 2000 });
  assert.deepEqual(t2.closed.map((c) => c.closeReason), ['removed']);
  assert.ok(t2.closed[0].replacedBy?.includes('NEW222'));
  assert.equal(t2.held.length, 0);
  // 새 부품도 고장 — 옛 장애는 닫고 새 장애가 따로 열린다
  const t2b = transition({ open: t1.opened, observed: extractIdracParts(server, inv([{ name: 'PS1 Status', serial: 'NEW222', health: 'Critical', state: 'Enabled' }, ps2])).parts, scan, now: 2000 });
  assert.equal(t2b.closed.length, 1);
  assert.equal(t2b.opened.length, 1);
  // 새 부품 상태를 못 읽음 → 보류(닫지 않는다)
  const t3 = transition({ open: t1.opened, observed: extractIdracParts(server, inv([{ name: 'PS1 Status', serial: 'NEW222', health: '', state: '' }, ps2])).parts, scan, now: 2000 });
  assert.equal(t3.closed.length, 0);
  // 그 종류 컬렉션 실패 → 보류
  const t4 = transition({ open: t1.opened, observed: [], scan: { ...scan, kindFailed: { '|10.0.0.5': ['psu'] } }, now: 2000 });
  assert.equal(t4.closed.length, 0);
  // 이름이 겹침(모호) → 보류
  const t5 = transition({ open: t1.opened, observed: extractIdracParts(server, inv([{ name: 'PS1 Status', serial: 'NEW222', health: 'OK', state: 'Enabled' }, { name: 'PS1 Status', serial: 'NEW333', health: 'OK', state: 'Enabled' }])).parts, scan, now: 2000 });
  assert.equal(t5.closed.length, 0);
  assert.ok(t5.held.length >= 1);
});

test('35회차 R3: 이름이 부품마다 같은 장비에서 고장 부품이 목록에서 빠지면 닫지 않는다(보류)', async () => {
  const { extractIdracParts } = await import('../src/partfault/extract/idrac.js');
  const { transition } = await import('../src/partfault/transition.js');
  const server = { id: '10.0.0.6', name: 'srv2', serviceTag: 'XYZ9999', agent: '' };
  const coll = { system: 'ok', psus: 'ok', disks: 'ok', storageControllers: 'ok', memoryDimms: 'ok', cpus: 'ok', gpus: 'ok', pcie: 'ok', fans: 'ok' };
  const inv = (disks) => ({ reachable: true, collections: coll, system: { serviceTag: 'XYZ9999', model: 'DL380' }, psus: [], disks, memoryDimms: [], cpus: [], gpus: [], pcie: [], storageControllers: [], fans: [] });
  const scan = { deviceOk: { '|10.0.0.6': true }, kindFailed: {}, agentsReported: new Set(['']) };
  const t1 = transition({ open: [], observed: extractIdracParts(server, inv([{ name: 'Drive', serial: 'SA', health: 'Critical', state: 'Enabled' }, { name: 'Drive', serial: 'SB', health: 'OK', state: 'Enabled' }])).parts, scan, now: 1000 });
  assert.equal(t1.opened.length, 1);
  const t2 = transition({ open: t1.opened, observed: extractIdracParts(server, inv([{ name: 'Drive', serial: 'SB', health: 'OK', state: 'Enabled' }])).parts, scan, now: 2000 });
  assert.equal(t2.closed.length, 0, '남은 다른 부품을 교체품으로 보지 않는다');
  assert.equal(t2.held[0]?.holdReason, 'missing');
});

test('35회차 R7: 엣지 bmusage 보고의 truncated · counts 는 0 이상 정수 · 상한', async () => {
  const { sanitizeBmUsageSnap } = await import('../src/central/bmUsageEdgePull.js');
  const now = Date.now();
  const a = sanitizeBmUsageSnap({ truncated: -40, counts: { a: -7, b: 1e308, c: 2.6, byReason: { x: -1, y: 3 } } }, { receivedAt: now });
  assert.equal(a.truncated, 0);
  assert.deepEqual(a.counts, { b: 1e9, c: 3, byReason: { y: 3 } });
  assert.equal(sanitizeBmUsageSnap({ truncated: 1e300 }, { receivedAt: now }).truncated, 1e9);
});

test('F3: 물리 코어 대체 합 — 장착 소켓 전부를 읽었을 때만, 아니면 null', async () => {
  const { capacityOfInventory, aggregatePhysical } = await import('../src/idrac/physicalCapacity.js');
  const two = { cpu: { count: 2 }, memory: { totalGiB: 512 }, cpus: [{ cores: 32, state: 'Enabled' }, { cores: 32, state: 'Enabled' }] };
  assert.equal(capacityOfInventory(two).cores, 64);
  assert.equal(capacityOfInventory({ ...two, cpus: [{ cores: 32, state: 'Enabled' }, { cores: null, state: 'Enabled' }] }).cores, null, '한 소켓 못 읽음');
  assert.equal(capacityOfInventory({ ...two, cpus: [{ cores: 32, state: 'Enabled' }] }).cores, null, '목록에서 빠진 소켓');
  assert.equal(capacityOfInventory({ cpu: {}, cpus: [{ cores: 32, state: 'Enabled' }, { cores: null, state: 'Absent' }] }).cores, 32, '빈 소켓은 분모에서 뺀다');
  if (typeof aggregatePhysical === 'function') {
    const half = { ...two, cpus: [{ cores: 32, state: 'Enabled' }, { cores: null, state: 'Enabled' }] };
    const a = aggregatePhysical([{ id: 'a' }, { id: 'b' }], (s) => (s.id === 'a' ? two : half));
    assert.equal(a.withCores, 1);
    assert.equal(a.cores, 64);
  }
});

test('F4: 법인 사용량 용량 판정(makeCapOf)은 capacityOfInventory 와 같은 코어', async () => {
  const { capacityOfInventory } = await import('../src/idrac/physicalCapacity.js');
  const { makeCapOf } = await import('../src/routes/api/corpUsage.js');
  const inv = { cpu: { count: 2 }, memory: { totalGiB: 512 }, cpus: [{ cores: 32, state: 'Enabled' }, { cores: 32, state: 'Enabled' }] };
  const capOf = makeCapOf({ getInventory: () => inv });
  const c = capOf({ serverId: 's1', serviceTag: '' });
  assert.equal(c.cores, capacityOfInventory(inv).cores);
  assert.equal(c.memGB, 512);
});

test('F5: 엣지 파트 장애 보고의 omitted 는 0 이상 정수 · 상한(못 읽으면 0)', async () => {
  const pe = await import('../src/central/partFaultEdge.js');
  pe._resetForTest(async () => ({ storage: new Set(), sanswitch: new Set() }));
  const got = [];
  for (const omitted of [-7, '1e300', 'Infinity', 3.7]) {
    await pe.putEdgeReport('edge-a', { v: 2, devices: [], omitted });
    got.push(pe.mergeEdgeReports().agents[0].omitted);
  }
  assert.deepEqual(got, [0, 1e9, 0, 4]);
});

test('F6: 엣지 bmusage 보고의 수집 주기는 엣지 설정 범위로 자른다', async () => {
  const { sanitizeBmUsageSnap } = await import('../src/central/bmUsageEdgePull.js');
  const { MAX_INTERVAL_MS, MIN_INTERVAL_MS } = await import('../src/bmusage/settings.js');
  const now = Date.now();
  assert.equal(sanitizeBmUsageSnap({ settings: { intervalMs: 1e13 } }, { receivedAt: now }).settings.intervalMs, MAX_INTERVAL_MS);
  assert.equal(sanitizeBmUsageSnap({ settings: { intervalMs: 5 } }, { receivedAt: now }).settings.intervalMs, MIN_INTERVAL_MS);
  assert.equal(sanitizeBmUsageSnap({ settings: { intervalMs: 300_000 } }, { receivedAt: now }).settings.intervalMs, 300_000);
  assert.equal(sanitizeBmUsageSnap({ settings: { intervalMs: 'x' } }, { receivedAt: now }).settings.intervalMs, null);
});
