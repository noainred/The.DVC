// 랙 실장도 — 2026-11-27 6회차 점검 확정 결함 수정의 회귀(재료 하위 체계는 rackMaterial1127 · 칸 목록은 rackProject1127).
//   D1 펌웨어 판 꼴은 가리지 않는다 · 전원 상태는 열거값만 · 시리얼 칸의 등록 주소 · 화면처럼 문자열로 보낸 추가 시리얼의 URL ·
//   옛 전각 값과의 이름 · 시리얼 비교(D2) · 집계 잠금 문구 · 랙 종류 이름은 전 법인 시리얼로.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackfix-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const registry = await import(`${S}/idrac/registry.js`);
const invCache = await import(`${S}/idrac/invCache.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const P = await import(`${S}/rack/project.js`);
const busy = await import(`${S}/util/exportBusy.js`);
after(() => R._closeForTest());
const routes = new Map();
RT.registerRack({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
async function call(key, { user, params = {}, query = {}, body = {} }) {
  const res = { statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {}, end(b) { this.raw = b; return this; } };
  const req = { user, params, query, body, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0], originalUrl: `/api${key.replace(/^\w+ /, '')}` };
  for (const h of routes.get(key)) { let n = false; await h(req, res, () => { n = true; }); if (!n) break; }
  return res;
}
const U = (name, role, vcenters = []) => ({ username: name, role, scope: { vcenters, regions: [], writeVcenters: [] } });
const ADMIN = U('admin', 'admin'); const OP_ALL = U('op', 'operator'); const OP_A = U('op-a', 'operator', ['vc-a']);
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }, { id: 'vc-b', name: 'b', status: 'ok' }], hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr');
dc.addDatacenter({ id: 'pl', name: 'PL' }); dc.setVcenterDatacenter('vc-b', 'pl');
const op = (body) => call('POST /tools/rack/op', { user: ADMIN, body });
const okOp = async (body) => { const r = await op(body); assert.equal(r.statusCode, 200, `${body.op}: ${JSON.stringify(r.body)}`); return r.body; };
const W = {};

test('준비 — 등록 서버(펌웨어 네 마디 · 전원 상태 자유 글) · 법인 둘', async () => {
  registry.importServers([
    { id: 'fw1', name: 'fw1', host: 'https://bmc-fw1.mgmt.example', username: 'root', password: 'x', serviceTag: 'FWSRV001', vcenterId: 'vc-a' },
    { id: 'fw2', name: 'fw2', host: 'https://bmc-fw2.mgmt.example', username: 'root', password: 'x', serviceTag: 'FWSRV002', vcenterId: 'vc-a' },
  ]);
  invCache.setInventory('fw1', { system: { serviceTag: 'FWSRV001', model: 'PowerEdge R760', hostName: 'h1', health: 'OK', powerState: 'On' }, idrac: { firmwareVersion: '7.00.00.171' }, collectedAt: Date.now() });
  invCache.setInventory('fw2', { system: { serviceTag: 'FWSRV002', model: 'PowerEdge R650', hostName: 'h2', health: 'OK', powerState: 'On 10.9.9.9 bmc-fw2.mgmt.example' }, idrac: { firmwareVersion: 'build 10.20.30.4 by bmc-fw2.mgmt.example' }, collectedAt: Date.now() });
  W.site = (await okOp({ op: 'site.add', corpId: 'kr', name: 'S' })).id;
  W.room = (await okOp({ op: 'room.add', siteId: W.site, name: 'R' })).id;
  const k = await okOp({ op: 'rack.add', roomId: W.room, rev: 0, rack: { name: 'A1', heightU: 42 } });
  W.rack = k.id;
  const p1 = await okOp({ op: 'place.add', rackId: k.id, rev: k.rev, place: { face: 'full', uStart: 1, uSize: 1, kind: 'server', label: 'db', serial: 'FWSRV001' } });
  const p2 = await okOp({ op: 'place.add', rackId: k.id, rev: p1.rev, place: { face: 'full', uStart: 3, uSize: 1, kind: 'server', label: 'web', serial: 'FWSRV002' } });
  W.p1 = p1.id; W.p2 = p2.id; W.rev = p2.rev;
});

test('D1: iDRAC 펌웨어 판(네 마디)은 조회 계정에도 그대로 — 판 꼴이 아닌 자유 글은 가림을 거친다', async () => {
  for (const user of [OP_ALL, OP_A]) {
    const v = (await call('GET /tools/rack/room/:id', { user, params: { id: W.room } })).body;
    assert.equal(v.places.find((p) => p.id === W.p1).link.hw.fw, '7.00.00.171', `${user.username}: 예전엔 IPv4 꼴로 읽혀 masked-… 였다`);
    const fw2 = v.places.find((p) => p.id === W.p2).link.hw.fw;
    assert.ok(!fw2.includes('10.20.30.4') && !fw2.includes('bmc-fw2'), `${user.username}: ${fw2}`);
  }
  for (const v of ['7.00.00.171', '2.83.83.83', '6.10.80.00', 'A04', '1.20']) assert.equal(P.firmwareLike(v), true, v);
  for (const v of ['build 10.20.30.4', 'fw 7.0 build', '', 'x'.repeat(41), null]) assert.equal(P.firmwareLike(v), false, String(v));
});

test('전원 상태: 조회 계정에는 Redfish 열거값만(엣지가 보낸 자유 글은 비운다) · 관리자는 원문', async () => {
  for (const user of [OP_ALL, OP_A]) {
    const v = (await call('GET /tools/rack/room/:id', { user, params: { id: W.room } })).body;
    assert.equal(v.places.find((p) => p.id === W.p1).link.powerState, 'On');
    assert.equal(v.places.find((p) => p.id === W.p2).link.powerState, '', user.username);
  }
  const a = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: W.room } })).body;
  assert.equal(a.places.find((p) => p.id === W.p2).link.powerState, 'On 10.9.9.9 bmc-fw2.mgmt.example');
});

test('시리얼 칸: 등록된 관리 주소(FQDN) · 화면처럼 문자열로 보낸 URL 은 저장하지 않는다(6회차 보안 4 · 정확성 D4 · 화면 D2)', async () => {
  const bad = [
    { serial: 'bmc-fw1.mgmt.example' },
    { extraSerials: 'SW-1 / bmc-fw2.mgmt.example' },
    { extraSerials: 'SW-CORE-1 / https://unreg-host.example/ui' },   // 화면이 보내는 꼴 — 예전엔 'https:' · 'unreg-host.example' · 'ui' 로 쪼개져 저장됐다
    { extraSerials: ['SW-1', 'http:bmc.example'] },
    { serial: 'bmc.10.20.30.4' },
  ];
  for (const place of bad) {
    const r = await op({ op: 'place.update', id: W.p2, rev: W.rev, place });
    assert.equal(r.statusCode, 400, JSON.stringify(place));
    assert.match(r.body.reason, /시리얼 칸에/);
  }
  const ok = await okOp({ op: 'place.update', id: W.p2, rev: W.rev, place: { extraSerials: 'SW-1 / SW-2, SW-3' } });
  W.rev = ok.rev;
  const a = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: W.room } })).body;
  assert.deepEqual(a.places.find((p) => p.id === W.p2).extraSerials, ['SW-1', 'SW-2', 'SW-3']);
});

test('시리얼 칸의 옛 값: URL · 주소 꼴은 시리얼을 보는 판본에 비운다(출력도 입력과 같은 판정)', async () => {
  const db = await R.openRackDb();
  db.prepare('UPDATE rack_place SET extra_serials = ? WHERE id = ?').run(JSON.stringify(['https://bmc.zz.example', 'node.10.20.30.97', 'KEEP-1', '00:1a:2b:3c:4d:5e']), W.p2);
  await R._resyncForTest();
  const v = (await call('GET /tools/rack/room/:id', { user: OP_ALL, params: { id: W.room } })).body;
  assert.deepEqual(v.places.find((p) => p.id === W.p2).extraSerials, ['KEEP-1']);
  db.prepare('UPDATE rack_place SET extra_serials = ? WHERE id = ?').run(JSON.stringify(['SW-1', 'SW-2', 'SW-3']), W.p2);
  await R._resyncForTest();
});

test('D2: 옛 전각 값과의 비교 — 이름 중복 · 시리얼 중복 · 등록 서버 연결이 폭에 무관하다', async () => {
  const db = await R.openRackDb();
  // 이 검사가 생기기 전에 저장된 원장(전각 그대로)을 SQL 로 만든다
  db.prepare('UPDATE rack_site SET name = ? WHERE id = ?').run('ＤＣ２', W.site);
  db.prepare('UPDATE rack_rack SET name = ? WHERE id = ?').run('Ｒ－０１', W.rack);
  const p3 = await okOp({ op: 'place.add', rackId: W.rack, rev: W.rev, place: { face: 'full', uStart: 7, uSize: 1, kind: 'storage', label: 'nas', serial: 'TMPSER01' } });
  W.rev = p3.rev;
  db.prepare("UPDATE rack_place SET serial = 'ＦＷ０００１２３', serial_key = 'ｆｗ０００１２３' WHERE id = ?").run(p3.id);
  db.prepare("UPDATE rack_place SET serial = 'ＦＷＳＲＶ００１', serial_key = 'ｆｗｓｒｖ００１' WHERE id = ?").run(W.p1);
  db.prepare("UPDATE rack_meta SET v = 1 WHERE k = 'placeKeys'").run();   // 키 함수가 바뀌기 전 판 — 다시 열면 키 칸 · 색인을 새 키로 다시 만든다
  R._closeForTest();
  assert.equal((await op({ op: 'site.add', corpId: 'kr', name: 'DC2' })).statusCode, 409, '전각 옛 이름과 같은 반각 이름');
  const room = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: W.room } })).body;
  assert.equal((await op({ op: 'rack.add', roomId: W.room, rev: room.rev, rack: { name: 'R-01', heightU: 42 } })).statusCode, 409);
  assert.equal((await op({ op: 'place.add', rackId: W.rack, rev: room.rev, place: { face: 'full', uStart: 9, uSize: 1, kind: 'storage', label: 'x', serial: 'FW000123' } })).statusCode, 409, '전각 옛 시리얼과 같은 시리얼');
  const s1 = room.places.find((p) => p.id === W.p1);
  assert.equal(s1.linkState, 'linked', '원장 시리얼이 전각이어도 등록 서버(FWSRV001)와 잇는다');
  assert.equal(db === (await R.openRackDb()), false, '다시 연 핸들');
  const k = (await R.openRackDb()).prepare('SELECT serial_key FROM rack_place WHERE id = ?').get(W.p1).serial_key;
  assert.equal(k, 'fwsrv001', '키 칸도 새 키로 다시 만들었다');
});

test('랙 종류 이름은 전 법인 원장의 시리얼로 가린다(범위 계정 — 다른 법인 원장에만 있는 시리얼 · 6회차 보안 5)', async () => {
  const s = await okOp({ op: 'site.add', corpId: 'pl', name: 'PLS' });
  const r = await okOp({ op: 'room.add', siteId: s.id, name: 'PLR' });
  const k = await okOp({ op: 'rack.add', roomId: r.id, rev: 0, rack: { name: 'P1', heightU: 42 } });
  await okOp({ op: 'place.add', rackId: k.id, rev: k.rev, place: { face: 'full', uStart: 1, uSize: 1, kind: 'storage', label: 'x', serial: 'PLONLY001' } });
  const t = await okOp({ op: 'type.add', name: 'T2 PLONLY001', heightU: 42 });
  const tree = (await call('GET /tools/rack', { user: OP_A })).body;
  assert.deepEqual(tree.corps.map((c) => c.id), ['kr']);
  assert.equal(tree.types.find((x) => x.id === t.id).name, 'T2 •••');
});

test('가림 집계 잠금 문구는 이 화면의 동작(다시 세기)으로 — 계정명은 싣지 않는다', async () => {
  const held = busy.acquireExport('rack-census', { user: { username: 'someone-else' } });
  assert.ok(held.ok);
  try {
    const r = await call('GET /tools/rack/mask-census', { user: ADMIN });
    assert.equal(r.statusCode, 409);
    assert.match(r.body.reason, /^다른 가림 집계가 진행 중입니다/);
    assert.ok(!JSON.stringify(r.body).includes('someone-else'));
  } finally { held.release(); }
  assert.equal((await call('GET /tools/rack/mask-census', { user: ADMIN })).statusCode, 200);
});
