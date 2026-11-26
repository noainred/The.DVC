// 랙 실장도 1회차 점검(2026-11-26) 회귀: 원장에서 빠진 장비 · 바뀐 시리얼이 이력 · 판 목록 · 판 글(detail)에 남지 않는다 — 범위 비관리자(시리얼을 가리는 판본).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackleak-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const routes = new Map();
RT.registerRack({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
async function call(key, { user, params = {}, query = {}, body = {} }) {
  const res = { statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {}, end(b) { this.raw = b; return this; } };
  const req = { user, params, query, body, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0], originalUrl: `/api${key.replace(/^\w+ /, '')}` };
  for (const h of routes.get(key)) { let n = false; await h(req, res, () => { n = true; }); if (!n) break; }
  return res;
}
const U = (name, role, vcenters = []) => ({ username: name, role, scope: { vcenters, regions: [], writeVcenters: [] } });
const ADMIN = U('admin', 'admin'); const OP_A = U('op-a', 'operator', ['vc-a']);
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }], hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr');
const op = (body) => call('POST /tools/rack/op', { user: ADMIN, body });

test('원장에서 뺀 · 시리얼을 바꾼 장비의 시리얼이 든 이름 — 범위 비관리자의 이력 · 판 목록 · 판 글 · 판 차이에 없다', async () => {
  const s = (await op({ op: 'site.add', corpId: 'kr', name: 'S' })).body.id;
  const r = (await op({ op: 'room.add', siteId: s, name: 'R' })).body.id;
  const k = await op({ op: 'rack.add', roomId: r, rev: 0, rack: { name: 'A1', heightU: 42 } });
  const p = await op({ op: 'place.add', rackId: k.body.id, rev: k.body.rev, place: { face: 'full', uStart: 1, uSize: 1, kind: 'storage', label: 'stor-SERIALX9', serial: 'SERIALX9' } });
  assert.ok(!JSON.stringify((await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: r } })).body).toLowerCase().includes('serialx9'), '놓여 있는 동안');
  const rm = await op({ op: 'place.remove', id: p.body.id, rev: p.body.rev });
  assert.equal(rm.statusCode, 200);
  const room = (await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: r } })).body;
  const list = (await call('GET /tools/rack/versions', { user: OP_A, query: { corp: 'kr' } })).body;
  const addVer = list.versions.find((v) => v.action === 'place.add');
  const d = (await call('GET /tools/rack/versions/:vid', { user: OP_A, params: { vid: String(addVer.id) }, query: { corp: 'kr' } })).body;
  // 1회차 점검(테스트 공백 축이 재현): 뺀 장비의 시리얼은 '지금 원장' 에 없어, 그 장비 이름으로 만든 옛 글에서 가려지지 않았다 — 행마다 그 장비의 시리얼(tags)로 걷어 낸다.
  assert.equal(room.serialsHidden, true);
  for (const [where, texts] of [['이력', room.logs.map((l) => l.detail)], ['판 목록', list.versions.map((v) => v.detail)], ['판 글', [d.version.detail]],
    ['판 차이', [...(d.changes?.items || []), ...(d.restore?.items || [])].map((i) => i.name)]]) {
    assert.ok(!texts.some((x) => /serialx9/i.test(String(x))), `${where}: ${JSON.stringify(texts)}`);
  }
  assert.ok(room.logs.some((l) => l.detail.includes('stor-•••')), '이름의 나머지는 남는다');
  assert.ok(!('tags' in room.logs[0]) && !JSON.stringify(list).includes('"tags"') && !JSON.stringify(d).includes('"tags"'), 'tags(시리얼 원문)는 응답에 싣지 않는다');
  // 관리자 · 전체 범위 계정은 원문 그대로
  const adm = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: r } })).body;
  assert.ok(adm.logs.some((l) => l.detail.includes('stor-SERIALX9')));
  assert.ok(!('tags' in adm.logs[0]));
  // 시리얼을 바꾼 장비의 옛 글도 가려진다(바꾸기 전 · 후 시리얼 둘 다 그 행의 tags 에 있다)
  const p2 = await op({ op: 'place.add', rackId: k.body.id, rev: rm.body.rev, place: { face: 'full', uStart: 3, uSize: 1, kind: 'storage', label: 'nas-OLDSER77', serial: 'OLDSER77' } });
  const p3 = await op({ op: 'place.update', id: p2.body.id, rev: p2.body.rev, place: { serial: 'NEWSER88', label: 'nas-NEWSER88', uStart: 4 } });
  assert.equal(p3.statusCode, 200);
  const room2 = (await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: r } })).body;
  const j2 = JSON.stringify(room2).toLowerCase();
  assert.ok(!j2.includes('oldser77') && !j2.includes('newser88'), '바꾸기 전 · 후 시리얼 모두(놓을 때의 글은 그때 시리얼로, 고친 글은 앞뒤 시리얼로 걷어 낸다)');
  // ⚠ 표시 이름을 그대로 두고 시리얼만 바꾸면, 이름에 남은 옛 시리얼 글자는 더는 어느 장비의 시리얼도 아니다 — 그 글자는 가리지 않는다(관리자가 표시 이름을 고친다).
  //   이 한계는 docs/rules/rack.md(1회차 절)에 적어 둔다.
  // tags 칸이 없던 때의 행(NULL)은 어떤 시리얼이 들었는지 알 수 없다 — 장비 글은 통째로 가린다(조용히 내보내지 않는다)
  const db = await R.openRackDb();
  db.prepare("UPDATE rack_log SET tags = NULL WHERE action LIKE 'place.%'").run();
  db.prepare("UPDATE rack_version SET tags = NULL WHERE action LIKE 'place.%'").run();
  const room3 = (await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: r } })).body;
  assert.ok(room3.logs.filter((l) => l.action.startsWith('place.')).every((l) => l.detail === R.LEGACY_DETAIL_HIDDEN));
  assert.ok(room3.logs.some((l) => l.action === 'rack.add' && l.detail.includes('A1')), '장비 글이 아닌 옛 행은 그대로');
  const list3 = (await call('GET /tools/rack/versions', { user: OP_A, query: { corp: 'kr' } })).body;
  assert.ok(list3.versions.filter((v) => v.action.startsWith('place.')).every((v) => v.detail === R.LEGACY_DETAIL_HIDDEN));
  const adm3 = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: r } })).body;
  assert.ok(adm3.logs.some((l) => l.detail.includes('nas-OLDSER77')), '관리자는 옛 행도 원문');
});
test('S2: 주소 판정기는 요청당 하나(범위 안 등록부 전체 주소) — 이름이 id 와 같기만 한 서버는 가리지 않고, 다른 서버의 관리 주소와 같은 이름은 가린다', async () => {
  const registry = await import(`${S}/idrac/registry.js`);
  registry.importServers([
    { id: 'kr-esx-01', name: 'kr-esx-01', host: 'https://10.9.9.1', username: 'root', password: 'x', serviceTag: 'SVCAAA1', vcenterId: 'vc-a' },
    { id: 'x2', name: 'IDRAC21.mgmt.EXAMPLE', host: 'https://10.9.9.2', username: 'root', password: 'x', serviceTag: 'SVCAAA2', vcenterId: 'vc-a' },
    { id: 'x3', name: 'srv3', host: 'https://idrac21.mgmt.example', username: 'root', password: 'x', serviceTag: 'SVCAAA3', vcenterId: 'vc-a' },
  ]);
  const OP_ALL = U('op', 'operator');
  const roomId = (await R.listTree(new Set(['kr']))).rooms[0].id;
  const v = (await call('GET /tools/rack/room/:id', { user: OP_ALL, params: { id: roomId } })).body;
  const names = v.unplaced.map((x) => x.name);
  assert.ok(names.includes('kr-esx-01'), `이름이 id 와 같아도 주소가 아니면 그대로: ${names}`);
  assert.ok(names.includes('srv3'));
  assert.ok(!names.some((n) => /idrac21\.mgmt\.example/i.test(n)), `다른 서버의 관리 주소와 같은 이름은 가린다: ${names}`);
  assert.ok(v.unplaced.every((x) => x.serverId.startsWith('masked-')), '비관리자에게 서버 id 는 항상 토큰');
  const adm = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: roomId } })).body;
  assert.ok(adm.unplaced.some((x) => x.name === 'IDRAC21.mgmt.EXAMPLE' && x.serverId === 'x2'), '관리자는 원문');
});

test.after(() => R._closeForTest());
