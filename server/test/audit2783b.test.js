// v2.783(점검 Q2 P-B3 — 데이터 손실): '유령 키 정리' 가 살아 있는 서버의 법인 귀속·분류 태그를 지우지 않는다.
//   ① 화면 요약(summary.ghostKeys)과 prune 미리보기·실제 삭제가 **같은 판정**(fleetGhostReport)을 쓴다 — 같은 단위(고유 키 수).
//   ② 원격 수집 서버(전력 신선도와 무관 — 인벤토리 기준)의 키는 live 다.
//   ③ 출처를 못 읽으면(iDRAC 등록부 손상·OME 미수신·수집 서버 미수신/비활성·호스트 목록 모르는 vCenter·엣지 보류/만료) 지우지 않는다.
//   ④ 실제 삭제는 미리 본 키 목록 ∩ 지금도 유령 만. 목록 없는 요청은 400.
// 수정 전(77278f7): 원격 키가 prune live 에 없고(삭제됨), 등록부 손상·OME 미수신을 확인하지 않았고, body 없이 전부 지웠다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2783b-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_DIR = DIR;
process.env.AUTH_ENABLED = 'false';
process.env.CENTRAL_TOKEN = 'test-central-token-2783b'; // 중앙 역할 — 엣지 push 출처도 판정에 들어간다
process.env.CENTRAL_FLEET_TTL_MS = '400';                 // 엣지 보고 만료를 테스트 시간 안에 재현

const express = (await import('express')).default;
const { store } = await import('../src/store.js');
const { insightsRouter } = await import('../src/routes/insights.js');
const { getFleetInventory, fleetGhostReport, fleetKeySources } = await import('../src/insights/fleetInventory.js');
const { setRemoteHost, clearCollectorHosts, setCollectorStatus, clearCollectorStatus } = await import('../src/collector/state.js');
const { setCollectorServers, clearCollectorServers } = await import('../src/collector/remoteInventory.js');
const { setOmeDevices, clearOmeExcept } = await import('../src/idrac/omeCache.js');
const { setEdgeFleet, holdEdgeFleet, resetEdgeFleet, UNREADABLE_HOLD_MS } = await import('../src/central/fleet.js');

const SNAP = {
  generatedAt: 'g1',
  vcenters: [{ id: 'vc1', name: 'VC1', status: 'connected' }],
  hosts: [{ id: 'vc1:h1', name: 'esx01', vcenterId: 'vc1', serviceTag: 'ESX001' }],
};
store.snapshot = SNAP;

const writeCfg = (f, o) => fs.writeFileSync(path.join(DIR, f), typeof o === 'string' ? o : JSON.stringify(o));
const readCfg = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const rmCfg = (f) => { try { fs.unlinkSync(path.join(DIR, f)); } catch { /* */ } };
const setStores = (tags, assign) => { writeCfg('fleet-tags.json', { tags }); writeCfg('fleet-assign.json', { assign }); };

const app = express(); app.use(express.json({ limit: '1mb' }));
app.use((req, _r, n) => { req.user = { username: 'adm', role: 'admin', scope: null }; n(); });
app.use('/api/insights', insightsRouter);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); fs.rmSync(DIR, { recursive: true, force: true }); });
const prune = async (body) => {
  const r = await fetch(`${base}/api/insights/fleet/prune`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  return { s: r.status, j: JSON.parse(text), text };
};

// 살아 있는 원격 수집 현장: 수집 서버 c1(등록·수신 완료) — 전력 항목 1대(낡은 ts) + 인벤토리 1대(전력 없음).
function remoteSite() {
  writeCfg('collectors.json', { collectors: [{ id: 'c1', name: 'edge-pl', url: 'https://10.9.0.1:3443', enabled: true }] });
  setRemoteHost('10.0.0.5', { collectorId: 'c1', serverId: 7, serverName: 'bm-oracle-01', serviceTag: 'RMT001', watts: 310, ts: Date.now() - 5 * 3_600_000, vcenterId: '' });
  setCollectorServers('c1', 'PL', [{ id: '8', name: 'bm-nopower', serviceTag: 'RMT002', host: '10.0.0.6' }]);
  setCollectorStatus('c1', { ok: true, hosts: 1 });
}

test('P-B3 ①②④: 원격 수집 서버 키는 보호되고, 화면 수 == 미리보기 수, 진짜 유령만 지운다', async () => {
  remoteSite();
  setStores({ rmt001: 'baremetal', ghost2: 'exclude' }, { rmt001: 'vc1', rmt002: 'vc1', ghost1: 'vc1' });

  const inv = await getFleetInventory(SNAP);
  const rep = fleetGhostReport(SNAP);
  assert.equal(rep.blocked, false, JSON.stringify(rep.unreadable));
  assert.deepEqual(rep.keys, ['ghost1', 'ghost2'], '수정 전: rmt001(전력 낡음)·rmt002(인벤토리만)가 유령으로 셌다');
  assert.equal(inv.summary.ghostKeys, rep.ghostKeys, '화면 숫자와 미리보기 숫자는 같은 판정·같은 단위');
  assert.deepEqual(inv.summary.ghostBlocked, []);
  // 분류(classifyFleet)가 live 로 보는 키는 전부 prune 의 live 에도 있다(새 출처를 한쪽에만 넣으면 여기서 깨진다).
  const live = fleetKeySources(SNAP).live;
  for (const k of inv.liveKeys) assert.ok(live.has(k), `분류 liveKeys 의 '${k}' 가 prune live 에 없다`);

  const dry = await prune({ dryRun: true });
  assert.equal(dry.s, 200);
  assert.equal(dry.j.blocked, false);
  assert.equal(dry.j.ghostKeys, inv.summary.ghostKeys);
  assert.deepEqual(dry.j.keys, ['ghost1', 'ghost2']);
  assert.equal(dry.j.wouldRemoveTags, 1);
  assert.equal(dry.j.wouldRemoveAssign, 1);

  const noKeys = await prune({});
  assert.equal(noKeys.s, 400, '미리 본 키 목록 없는 요청(구버전 화면)은 아무것도 지우지 않는다');
  assert.equal(readCfg('fleet-assign.json').assign.ghost1, 'vc1');

  // 미리 본 목록에 살아 있는 키(rmt001)를 섞어 보내도 지우지 않는다(서버가 다시 판정).
  const done = await prune({ keys: [...dry.j.keys, 'rmt001', 'esx001'] });
  assert.equal(done.s, 200, done.text);
  assert.equal(done.j.removedKeys, 2);
  assert.equal(done.j.removedTags, 1);
  assert.equal(done.j.removedAssign, 1);
  assert.equal(done.j.skipped, 2);
  assert.deepEqual(readCfg('fleet-tags.json').tags, { rmt001: 'baremetal' });
  assert.deepEqual(readCfg('fleet-assign.json').assign, { rmt001: 'vc1', rmt002: 'vc1' });
});

test('P-B3 ③: 등록된 OME 연결의 장비 목록을 이 기동에서 받지 못했으면 정리를 거절(409) — 받은 뒤에는 그 장비 키를 보호', async () => {
  writeCfg('idrac.json', { servers: [{ id: 'ome1', type: 'ome', name: 'OME-KR', host: '10.1.1.1', enabled: true }] });
  setStores({ devtag1: 'baremetal', ghostx: 'exclude' }, {});
  const dry = await prune({ dryRun: true });
  assert.equal(dry.s, 200);
  assert.equal(dry.j.blocked, true, '수정 전: OME 캐시가 비면 그 장비 키가 유령으로 지워졌다');
  assert.ok(dry.j.unreadable.some((u) => u.source === 'ome' && u.id === 'ome1'));
  const inv = await getFleetInventory(SNAP);
  assert.ok(inv.summary.ghostBlocked.includes('ome'), '화면도 같은 판정(정리 불가)을 안다');
  const r = await prune({ keys: dry.j.keys });
  assert.equal(r.s, 409, r.text);
  assert.deepEqual(readCfg('fleet-tags.json').tags, { devtag1: 'baremetal', ghostx: 'exclude' }, '거절이면 파일은 그대로');

  setOmeDevices('ome1', [{ id: 1, serviceTag: 'DEVTAG1', name: 'dev-1' }]);
  const dry2 = await prune({ dryRun: true });
  assert.equal(dry2.j.blocked, false, JSON.stringify(dry2.j.unreadable));
  assert.deepEqual(dry2.j.keys, ['ghostx']);
  const r2 = await prune({ keys: dry2.j.keys });
  assert.equal(r2.s, 200);
  assert.deepEqual(readCfg('fleet-tags.json').tags, { devtag1: 'baremetal' });
  rmCfg('idrac.json'); clearOmeExcept(new Set());
});

test('P-B3 ③: 수집 서버에서 이 기동 뒤 서버 목록을 받지 못했거나 꺼져 있으면 거절', async () => {
  setStores({ ghosty: 'exclude' }, {});
  clearCollectorHosts('c1'); clearCollectorServers('c1'); clearCollectorStatus('c1'); // 재시작 직후와 같다(인메모리 비어 있음)
  let rep = fleetGhostReport(SNAP);
  assert.equal(rep.blocked, true);
  assert.ok(rep.unreadable.some((u) => u.source === 'collector' && u.id === 'c1'));
  assert.equal((await prune({ keys: ['ghosty'] })).s, 409);
  writeCfg('collectors.json', { collectors: [{ id: 'c1', name: 'edge-pl', url: 'https://10.9.0.1:3443', enabled: false }] });
  setCollectorStatus('c1', { ok: true, hosts: 3 }); // 꺼지기 전 상태가 남아 있어도 데이터는 비워졌다
  rep = fleetGhostReport(SNAP);
  assert.ok(rep.unreadable.some((u) => u.source === 'collector' && /비활성/.test(u.reason)));
  rmCfg('collectors.json'); clearCollectorStatus('c1');
  assert.equal(fleetGhostReport(SNAP).blocked, false);
});

test('P-B3 ③: 호스트 목록을 모르는 vCenter(연결 전·실패, 이월 호스트 없음)가 있으면 거절 · 연결된 빈 vCenter 는 읽은 것', () => {
  setStores({ ghosty: 'exclude' }, {});
  const pending = { ...SNAP, vcenters: [...SNAP.vcenters, { id: 'vc2', name: 'VC-PL', status: 'pending' }] };
  assert.ok(fleetGhostReport(pending).unreadable.some((u) => u.source === 'vcenter' && u.id === 'vc2'));
  const carried = { ...pending, vcenters: [...SNAP.vcenters, { id: 'vc2', name: 'VC-PL', status: 'unreachable', stale: true }], hosts: [...SNAP.hosts, { name: 'esx-pl', vcenterId: 'vc2' }] };
  assert.equal(fleetGhostReport(carried).blocked, false, '직전 호스트가 이월된 vCenter 는 키를 안다');
  const emptyConnected = { ...SNAP, vcenters: [...SNAP.vcenters, { id: 'vc3', name: 'VC-EMPTY', status: 'connected' }] };
  assert.equal(fleetGhostReport(emptyConnected).blocked, false);
  assert.ok(fleetGhostReport(null).unreadable.some((u) => u.source === 'snapshot'));
});

test('P-B3 ③: 엣지 보고가 보류 중이거나 만료되면 거절(보류 기억에는 시한)', async () => {
  setStores({ edg001: 'baremetal', ghosty: 'exclude' }, {});
  resetEdgeFleet();
  setEdgeFleet('edge-a', [{ serviceTag: 'EDG001', name: 'e-1' }], null);
  let rep = fleetGhostReport(SNAP);
  assert.equal(rep.blocked, false, JSON.stringify(rep.unreadable));
  assert.deepEqual(rep.keys, ['ghosty'], '살아 있는 엣지 보고의 키는 보호');
  holdEdgeFleet('edge-a', { registryUnreadable: { code: 'parse-error' } });
  rep = fleetGhostReport(SNAP);
  assert.ok(rep.unreadable.some((u) => u.source === 'edge' && u.id === 'edge-a' && /등록부/.test(u.reason)));
  await new Promise((r) => setTimeout(r, 600)); // TTL(400ms) 경과 → 중앙 캐시가 그 엣지를 지운다
  rep = fleetGhostReport(SNAP);
  assert.ok(rep.unreadable.some((u) => u.source === 'edge' && u.id === 'edge-a' && /만료/.test(u.reason)), '수정 전: 만료된 엣지의 키(edg001)가 유령으로 지워졌다');
  assert.ok(rep.keys.includes('edg001'));
  assert.equal((await prune({ keys: rep.keys })).s, 409);
  assert.equal(readCfg('fleet-tags.json').tags.edg001, 'baremetal');
  // 시한이 지나면 더 이상 막지 않는다(사라진 엣지 하나가 정리를 영원히 막지 않게).
  assert.equal(fleetGhostReport(SNAP, { now: Date.now() + UNREADABLE_HOLD_MS + 60_000 }).blocked, false);
});

test('P-B3 ③: iDRAC 등록부 손상이면 503 registryUnreadable — 원문(파일 조각)을 싣지 않고 아무것도 지우지 않는다', async () => {
  setStores({ reg001: 'baremetal' }, { reg001: 'vc1' });
  writeCfg('idrac.json', '{"servers":[{"id":"r1","serviceTag":"REG001","password":"SuperSecret-2783"');
  const dry = await prune({ dryRun: true });
  assert.equal(dry.j.blocked, true);
  assert.ok(dry.j.unreadable.some((u) => u.source === 'idrac-registry'));
  const r = await prune({ keys: ['reg001'] });
  assert.equal(r.s, 503, r.text);
  assert.equal(r.j.registryUnreadable, true);
  assert.ok(!/SuperSecret|assword/.test(r.text), '등록부 원문 조각을 응답에 싣지 않는다');
  assert.deepEqual(readCfg('fleet-assign.json').assign, { reg001: 'vc1' }, '수정 전: 등록부를 [] 로 읽어 등록 서버 귀속을 지웠다');
  assert.deepEqual(readCfg('fleet-tags.json').tags, { reg001: 'baremetal' });
});
