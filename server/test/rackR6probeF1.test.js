// [탐침 · 테스트 공백 축 r6 · 결함 F1] 랙 종류 이름(전 법인 공용)의 가림 재료가 '이 계정이 보는 법인' 의 원장 시리얼뿐이다 — **지금 판본에서 실패한다**(고친 뒤 통과해야 하는 시험).
//   (2026-11-27 저장소에 옮김 — 처음에는 점검 사본에서만 돌렸다)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r6probe-proj-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const registry = await import(`${S}/idrac/registry.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
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
const OP_AB = U('op-ab', 'operator', ['vc-a', 'vc-b']);   // 범위 계정 — 법인 둘(kr · pl)을 본다
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }, { id: 'vc-b', name: 'b', status: 'ok' }], hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr');
dc.addDatacenter({ id: 'pl', name: 'PL' }); dc.setVcenterDatacenter('vc-b', 'pl');
const op = (body) => call('POST /tools/rack/op', { user: ADMIN, body });
const okOp = async (body) => { const r = await op(body); assert.equal(r.statusCode, 200, `${body.op}: ${JSON.stringify(r.body)}`); return r.body; };
const room = async (user, id) => (await call('GET /tools/rack/room/:id', { user, params: { id } })).body;

const W = {};
test('준비: 법인 둘 — 원장에만 있는 시리얼(등록부에 없음)을 그 법인의 데이터센터 · 전산실 · 랙 종류 이름에 적는다', async () => {
  registry.importServers([{ id: 'b1', name: 'b1', host: 'https://bmc-r6.mgmt.example', username: 'root', password: 'x', serviceTag: 'REGTAG61', vcenterId: 'vc-a' }]);
  for (const [corp, ser] of [['kr', 'KRSER0001'], ['pl', 'PLSER0001']]) {
    const site = (await okOp({ op: 'site.add', corpId: corp, name: `S ${ser}` })).id;
    const roomId = (await okOp({ op: 'room.add', siteId: site, name: `R ${ser}` })).id;
    const k = await okOp({ op: 'rack.add', roomId, rev: 0, rack: { name: 'K1', heightU: 42 } });
    const p = await okOp({ op: 'place.add', rackId: k.id, rev: k.rev, place: { face: 'full', uStart: 1, uSize: 1, kind: 'storage', label: 'nas', serial: ser } });
    W[corp] = { site, roomId, rackId: k.id, rev: p.rev };
  }
  W.type = (await okOp({ op: 'type.add', name: 'T KRSER0001', heightU: 42 })).id;
});

test('F1: 범위 계정(kr 만)에게 랙 종류 이름 속 다른 법인(pl) 원장 전용 시리얼도 가린다', async () => {
  const id = (await okOp({ op: 'type.add', name: 'T2 PLSER0001', heightU: 42 })).id;
  const t = (await call('GET /tools/rack', { user: OP_A })).body;
  assert.deepEqual(t.corps.map((c) => c.id), ['kr'], '이 계정은 pl 을 보지 않는다');
  assert.equal(t.types.find((x) => x.id === id).name, 'T2 •••');
});
