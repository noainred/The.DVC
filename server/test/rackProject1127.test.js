// 랙 실장도 — 칸 목록 투영(2026-11-27 · 설계 docs/design/rack-mask-redesign J1 · J7 '표식 시험').
//   공개가 아닌 모든 칸에 서로 다른 표식 글자를 심고, 조회 계정 2종의 **모든 GET 응답 바이트**에 표식이 한 번도 없는지 본다.
//   '어떤 표기가 빠지는가' 를 하나씩 막는 시험이 아니라 구조를 고정하는 시험이다 — 새 칸을 응답에 더하고 등급을 잊으면 여기서 걸린다(키 목록 대조).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackproj-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const registry = await import(`${S}/idrac/registry.js`);
const invCache = await import(`${S}/idrac/invCache.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const P = await import(`${S}/rack/project.js`);
const L = await import(`${S}/rack/layout.js`);
after(() => R._closeForTest());
const routes = new Map();
RT.registerRack({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
async function call(key, { user, params = {}, query = {}, body = {} }) {
  const res = { statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.raw = b; return this; } };
  const req = { user, params, query, body, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0], originalUrl: `/api${key.replace(/^\w+ /, '')}` };
  for (const h of routes.get(key)) { let n = false; await h(req, res, () => { n = true; }); if (!n) break; }
  return res;
}
const U = (name, role, vcenters = []) => ({ username: name, role, scope: { vcenters, regions: [], writeVcenters: [] } });
const ADMIN = U('zzadminuser', 'admin'); const OP_ALL = U('op', 'operator'); const OP_A = U('op-a', 'operator', ['vc-a']);
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }], hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr');
const op = (body) => call('POST /tools/rack/op', { user: ADMIN, body });
const okOp = async (body) => { const r = await op(body); assert.equal(r.statusCode, 200, `${body.op}: ${JSON.stringify(r.body)}`); return r.body; };

// 표식 — 판본마다 응답 어디에도 없어야 하는 글자(소문자로 대조).
const IP = '10.99.88.77';
const HOST = 'zzhost-a1.mgmt.example';
const SECRET_ALL = ['zznote-secret', 'zzsrvname', 'zzoshost', 'zzhost-a1', IP, 'zzadminuser'];   // 조회 계정 2종 모두
const SECRET_SCOPED = ['zztag0001', 'zzser0002'];                                                              // 시리얼을 가리는 판본(범위 계정)만

/** 원장을 만든다 — 사람이 적는 칸마다 주소(IP · 등록 호스트 이름)를 넣고, 공개가 아닌 칸에는 표식을 넣는다. */
async function seed() {
  registry.importServers([{ id: 's1', name: 'ZZSRVNAME-A1', host: `https://${HOST}`, username: 'root', password: 'x', serviceTag: 'ZZTAG0001', vcenterId: 'vc-a' }]);
  invCache.setInventory('s1', { system: { hostName: 'zzoshost-a1.corp', model: 'PowerEdge R760', serviceTag: 'ZZTAG0001', health: 'OK', powerState: 'On' }, collectedAt: Date.now() });
  const t = await okOp({ op: 'type.add', name: `T ${IP} ${HOST}`, heightU: 42 });
  const site = (await okOp({ op: 'site.add', corpId: 'kr', name: `DC ${IP}` })).id;
  const roomId = (await okOp({ op: 'room.add', siteId: site, name: `R ${HOST}` })).id;
  const k1 = await okOp({ op: 'rack.add', roomId, rev: 0, rack: { name: `A1 ${IP}`, heightU: 42, row: `row ${IP}`, role: `role ${HOST} ZZTAG0001` } });
  const k2 = await okOp({ op: 'rack.add', roomId, rev: k1.rev, rack: { name: 'B2', typeId: t.id } });
  // 연결된 서버(서비스 태그 = 등록 서버) · 메모에 표식
  const p1 = await okOp({ op: 'place.add', rackId: k1.id, rev: k2.rev, place: { face: 'full', uStart: 1, uSize: 2, kind: 'server', label: `db ${IP} ZZTAG0001`, model: `model ${HOST}`, serial: 'ZZTAG0001', note: `ZZNOTE-SECRET bmc ${IP}` } });
  // 등록부에 없는 장비(원장 시리얼만) — 이름에 그 시리얼
  const p2 = await okOp({ op: 'place.add', rackId: k1.id, rev: p1.rev, place: { face: 'full', uStart: 5, uSize: 1, kind: 'storage', label: 'stor-ZZSER0002', model: 'Unity', serial: 'ZZSER0002', extraSerials: ['ZZSER0002B'], note: 'ZZNOTE-SECRET 2' } });
  // 옮기기(판 차이의 위치 글에 랙 이름이 실린다) · 메모만 고치기(판 차이 fields 에 note)
  const mv = await okOp({ op: 'place.update', id: p2.id, rackId: k2.id, rev: p2.rev, place: { uStart: 7 } });
  const nt = await okOp({ op: 'place.update', id: p2.id, rev: mv.rev, place: { note: 'ZZNOTE-SECRET 3' } });
  return { roomId, site, p1: p1.id, p2: p2.id, rev: nt.rev, typeId: t.id };
}

/** 그 계정이 받을 수 있는 랙 GET 응답 전부(본문을 글로). */
async function allResponses(user, roomId) {
  const out = [];
  // keyText = 키 이름 대조용(입력 상한표 `limits` 에는 note · serial 같은 **칸 이름**이 값 없이 들어 있다 — 그것은 뺀다)
  const add = (name, r) => out.push({ name, status: r.statusCode, body: r.body, text: JSON.stringify(r.body ?? null) + JSON.stringify(r.headers || {}) + String(r.raw ?? ''), keyText: JSON.stringify({ ...(r.body || {}), limits: undefined }).toLowerCase() });
  add('목록', await call('GET /tools/rack', { user }));
  add('전산실', await call('GET /tools/rack/room/:id', { user, params: { id: roomId } }));
  const list = await call('GET /tools/rack/versions', { user, query: { corp: 'kr' } });
  add('판 목록', list);
  for (const v of list.body?.versions || []) add(`판 #${v.id}`, await call('GET /tools/rack/versions/:vid', { user, params: { vid: String(v.id) }, query: { corp: 'kr' } }));
  add('엑셀', await call('GET /tools/rack/room/:id/xlsx', { user, params: { id: roomId } }));
  return out;
}

const KEYS = {
  site: ['corpId', 'id', 'name', 'sort'],
  room: ['id', 'name', 'rev', 'siteId', 'sort', 'updatedAt'],
  treeRoom: ['id', 'name', 'places', 'racks', 'rev', 'siteId', 'sort', 'updatedAt'],
  type: ['depthMm', 'heightU', 'id', 'name', 'widthMm'],
  rack: ['heightU', 'id', 'name', 'pduA', 'pduB', 'role', 'roomId', 'row', 'sort', 'totals', 'typeId'],
  placeSerial: ['extraSerials', 'face', 'id', 'kind', 'label', 'link', 'linkState', 'model', 'opW', 'rackId', 'ratedW', 'serial', 'uSize', 'uStart', 'updatedAt', 'weightKg'],
  linkNonAdmin: ['collectedAt', 'health', 'hw', 'model', 'parts', 'powerState', 'remote', 'serverId'],
  hwNonAdmin: ['cpu', 'fw', 'mem'],
  log: ['action', 'detail', 'ts', 'user'],
  roomView: ['canEdit', 'corp', 'limits', 'logs', 'ok', 'places', 'racks', 'rev', 'room', 'serialsHidden', 'serversNoTag', 'site', 'unplaced', 'unplacedListed', 'unplacedTotal'],
  version: ['action', 'counts', 'detail', 'id', 'ts', 'user'],
  versionDetailNonAdmin: ['changes', 'counts', 'ok', 'prevUnreadable', 'readable', 'restore', 'version'],
};
const keys = (o) => Object.keys(o).sort();

let seeded = null;
test('표식 시험(J7): 조회 계정 2종(전체 범위 · 범위)의 모든 랙 응답에 공개가 아닌 칸의 글자가 없다', async () => {
  seeded = await seed();
  const { roomId } = seeded;
  // 표식이 실제로 원장 · 등록부에 들어 있는지부터(헛통과 방지) — 관리자 응답에는 전부 있다.
  const adminText = (await allResponses(ADMIN, roomId)).map((r) => r.text).join('\n').toLowerCase();
  for (const s of [...SECRET_ALL, ...SECRET_SCOPED]) assert.ok(adminText.includes(s), `관리자 응답에는 '${s}' 가 있어야 시험이 뜻이 있다`);

  for (const [user, extra] of [[OP_ALL, []], [OP_A, SECRET_SCOPED]]) {
    const rs = await allResponses(user, roomId);
    for (const r of rs) {
      if (r.name === '엑셀') { assert.equal(r.status, 403, `${user.username}: 엑셀은 data.csv 권한(관리자)만`); continue; }
      assert.equal(r.status, 200, `${user.username} ${r.name}: ${r.text.slice(0, 200)}`);
      const low = r.text.toLowerCase();
      for (const s of [...SECRET_ALL, ...extra]) assert.ok(!low.includes(s), `${user.username} · ${r.name} 에 '${s}' — ${r.text.slice(Math.max(0, low.indexOf(s) - 80), low.indexOf(s) + 60)}`);
      for (const k of ['"note"', '"tags"', '"_tags"', '"serialkey"', '"mgmthost"', '"hostname"']) assert.ok(!r.keyText.includes(k), `${user.username} · ${r.name}: 관리자 전용 키 ${k}`);
    }
  }
  // 시리얼을 보는 판본(전체 범위 운영자)은 시리얼 칸에서만 그 값을 본다 — 이름 · 용도 속 태그는 그대로(지금 규칙).
  const full = (await call('GET /tools/rack/room/:id', { user: OP_ALL, params: { id: roomId } })).body;
  assert.equal(full.serialsHidden, false);
  assert.deepEqual(full.places.find((p) => p.id === seeded.p2).extraSerials, ['ZZSER0002B']);
});

test('칸 목록(J1): 조회 계정 응답의 키는 적어 둔 것뿐이다 — 새 칸은 project.js 에 등급을 적어야 나간다', async () => {
  const { roomId } = seeded;
  for (const user of [OP_ALL, OP_A]) {
    const tree = (await call('GET /tools/rack', { user })).body;
    for (const s of tree.sites) assert.deepEqual(keys(s), KEYS.site);
    for (const r of tree.rooms) assert.deepEqual(keys(r), KEYS.treeRoom);
    for (const t of tree.types) assert.deepEqual(keys(t), KEYS.type);
    const v = (await call('GET /tools/rack/room/:id', { user, params: { id: roomId } })).body;
    assert.deepEqual(keys(v), KEYS.roomView, user.username);
    assert.deepEqual(keys(v.site), KEYS.site); assert.deepEqual(keys(v.room), KEYS.room);
    for (const r of v.racks) assert.deepEqual(keys(r), KEYS.rack);
    for (const p of v.places) {
      assert.deepEqual(keys(p), user === OP_A ? [...KEYS.placeSerial, 'serialHidden'].sort() : KEYS.placeSerial, `${user.username} 장비 키`);
      if (p.link) { assert.deepEqual(keys(p.link), KEYS.linkNonAdmin); assert.match(p.link.serverId, /^masked-/); if (p.link.hw) assert.deepEqual(keys(p.link.hw), KEYS.hwNonAdmin); }
    }
    assert.ok(v.places.some((p) => p.link), '연결된 서버가 있어야 link 키를 본 것이다');
    for (const l of v.logs) { assert.deepEqual(keys(l), KEYS.log); assert.equal(l.user, ''); }
    // 미배치 목록은 관리자에게만 — 그 밖에는 대수만
    assert.deepEqual(v.unplaced, []); assert.equal(v.unplacedListed, false); assert.equal(typeof v.unplacedTotal, 'number');
    const list = (await call('GET /tools/rack/versions', { user, query: { corp: 'kr' } })).body;
    for (const x of list.versions) { assert.deepEqual(keys(x), KEYS.version); assert.equal(x.user, ''); }
    for (const x of list.versions) {
      const d = (await call('GET /tools/rack/versions/:vid', { user, params: { vid: String(x.id) }, query: { corp: 'kr' } })).body;
      assert.ok(keys(d).every((k) => KEYS.versionDetailNonAdmin.includes(k)), `${user.username} 판 상세 키 ${keys(d)}`);
      assert.equal(d.restore, null, '되돌리면 바뀌는 것은 되돌릴 수 없는 계정에 싣지 않는다');
      for (const it of d.changes?.items || []) {
        assert.ok(keys(it).every((k) => ['fields', 'id', 'name', 'op', 'type', 'where'].includes(k)), `차이 항목 키 ${keys(it)}`);
        assert.ok(!(it.fields || []).includes('note'), '관리자 전용 칸의 이름은 차이에 싣지 않는다');
      }
    }
  }
  // 관리자는 예전과 같다 — 메모 · 등록부 이름 · 관리 주소 · 미배치 목록 · 되돌리기 미리 보기
  const a = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: roomId } })).body;
  const p1 = a.places.find((p) => p.id === seeded.p1);
  assert.match(p1.note, /ZZNOTE-SECRET/); assert.equal(p1.link.name, 'ZZSRVNAME-A1'); assert.equal(p1.link.hostname, 'zzoshost-a1.corp'); assert.equal(p1.link.mgmtHost, HOST);
  assert.equal(a.unplacedListed, true);
  assert.equal(a.racks.find((r) => r.name.startsWith('A1')).name, `A1 ${IP}`);
  const alist = (await call('GET /tools/rack/versions', { user: ADMIN, query: { corp: 'kr' } })).body;
  const ad = (await call('GET /tools/rack/versions/:vid', { user: ADMIN, params: { vid: String(alist.versions[1].id) }, query: { corp: 'kr' } })).body;
  assert.ok(ad.restore && ad.restore.counts, '관리자에게는 되돌리기 미리 보기');
});

test('가림을 거치는 칸: 모델 · 랙의 이름/줄/용도 · 전산실 · 데이터센터 · 랙 종류 이름 · 판 차이의 위치 글(예전에는 원문이었다)', async () => {
  const { roomId } = seeded;
  const v = (await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: roomId } })).body;
  const rk = v.racks.find((r) => r.name.startsWith('A1'));
  const GONE = '(?:masked-[0-9a-f]+|\\(주소 가림\\))';   // 낱말이 통째로 주소면 토큰, 글 속 등록 주소면 '(주소 가림)'
  assert.match(rk.name, /^A1 masked-[0-9a-f]+$/); assert.match(rk.row, /^row masked-/); assert.match(rk.role, new RegExp(`^role ${GONE} •••$`));
  assert.match(v.site.name, /^DC masked-/); assert.match(v.room.name, new RegExp(`^R ${GONE}$`));
  const p1 = v.places.find((p) => p.id === seeded.p1);
  assert.match(p1.model, new RegExp(`^model ${GONE}$`)); assert.match(p1.label, /^db masked-[0-9a-f]+ •••$/);
  // 같은 이름은 같은 응답 안에서 같은 모양이다(예전: racks[].name 은 원문 · 이력은 가림)
  assert.ok(v.logs.some((l) => l.detail.includes(rk.name)), `이력의 랙 이름 = racks[].name: ${JSON.stringify(v.logs.map((l) => l.detail))}`);
  const tree = (await call('GET /tools/rack', { user: OP_A })).body;
  assert.match(tree.sites[0].name, /^DC masked-/); assert.match(tree.rooms[0].name, new RegExp(`^R ${GONE}$`));
  assert.match(tree.types.find((t) => t.id === seeded.typeId).name, new RegExp(`^T masked-[0-9a-f]+ ${GONE}$`));
  // 판 차이의 위치 글
  const list = (await call('GET /tools/rack/versions', { user: OP_A, query: { corp: 'kr' } })).body;
  let sawWhere = 0; let sawNoteOnly = 0;
  for (const x of list.versions) {
    const d = (await call('GET /tools/rack/versions/:vid', { user: OP_A, params: { vid: String(x.id) }, query: { corp: 'kr' } })).body;
    for (const it of d.changes?.items || []) {
      if (it.where) { sawWhere += 1; assert.ok(!it.where.includes(IP), it.where); }
      if (it.op === 'change' && it.type === 'place' && it.fields && it.fields.length === 0) sawNoteOnly += 1;
    }
  }
  assert.ok(sawWhere >= 3, '위치 글이 든 항목을 실제로 봤다');
  assert.equal(sawNoteOnly, 1, '메모만 고친 변경은 항목은 남고 바뀐 칸 이름은 비어 있다(변경이 있었다는 사실은 가리지 않는다)');
});

test('시리얼 칸의 주소: 새 입력은 거절(400) · 그 전에 저장된 값은 시리얼을 보는 판본에 비운다', async () => {
  const { roomId, p2 } = seeded;
  const cur = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: roomId } })).body;
  for (const place of [{ serial: '10.20.30.99' }, { extraSerials: ['OK1', 'fe80::1'] }, { serial: 'https://bmc.example' }]) {
    const r = await op({ op: 'place.update', id: p2, rev: cur.rev, place });
    assert.equal(r.statusCode, 400, JSON.stringify(place)); assert.match(r.body.reason, /시리얼 칸에는 주소/);
  }
  assert.equal((await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: roomId } })).body.rev, cur.rev, '거절된 쓰기는 rev 를 올리지 않는다');
  // 옛 값(이 검사가 생기기 전에 저장된 원장) — SQL 로 직접 넣는다
  const db = await R.openRackDb();
  db.prepare('UPDATE rack_place SET serial = ?, extra_serials = ? WHERE id = ?').run('10.20.30.99', JSON.stringify([HOST, 'KEEP-ME-1', '00:1a:2b:3c:4d:5e', '１０.２０.３０.９８']), p2);
  await R._resyncForTest();
  const full = (await call('GET /tools/rack/room/:id', { user: OP_ALL, params: { id: roomId } })).body.places.find((p) => p.id === p2);
  assert.equal(full.serial, ''); assert.deepEqual(full.extraSerials, ['KEEP-ME-1'], '주소 꼴(IP · 등록 주소 · MAC · 전각 IP)만 비우고 시리얼은 남긴다');
  const adm = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: roomId } })).body.places.find((p) => p.id === p2);
  assert.equal(adm.serial, '10.20.30.99', '관리자는 원문(고쳐야 할 값을 볼 수 있게)');
});

test('전각 → 반각: 새 입력은 저장 전에 접고, 옛 값은 가림 판정이 같은 눈으로 본다(전각으로 적은 주소 · 태그가 비켜 가지 않는다)', async () => {
  const { roomId, p1 } = seeded;
  assert.equal(L.foldWidth('１０．２０．３０．４　ＳＶＡ'), '10.20.30.4 SVA');
  assert.equal(L.foldWidth('가나다 ①㈜'), '가나다 ①㈜', '전각 ASCII 만 접는다 — 다른 글자는 그대로');
  assert.equal(L.cleanText('　ＡＢ　', 10), 'AB');
  const cur = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: roomId } })).body;
  const same = await okOp({ op: 'place.update', id: p1, rev: cur.rev, place: { label: 'ｄｂ １０.９９.８８.７７ ＺＺＴＡＧ０００１' } });
  assert.equal(same.unchanged, true, '전각으로 다시 적은 같은 이름은 바뀐 것이 없다(접은 글이 같다)');
  const up = await okOp({ op: 'place.update', id: p1, rev: cur.rev, place: { label: 'ｄｂ １０.９９.８８.７７ ＺＺＴＡＧ０００１ ｎｅｗ' } });
  const adm = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: roomId } })).body.places.find((p) => p.id === p1);
  assert.equal(adm.label, `db ${IP} ZZTAG0001 new`, '저장된 글이 반각이다');
  // 옛 값 — SQL 로 전각 그대로 넣는다
  const db = await R.openRackDb();
  db.prepare('UPDATE rack_place SET label = ? WHERE id = ?').run('ｄｂ １０．９９．８８．７７ ＺＺＴＡＧ０００１', p1);
  await R._resyncForTest();
  const sc = (await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: roomId } })).body.places.find((p) => p.id === p1);
  assert.match(sc.label, /^db masked-[0-9a-f]+ •••$/, sc.label);
  assert.ok(up.rev > cur.rev);
});

test('project.js: 관리자는 원장 그대로(메모 포함) · 모르는 칸은 싣지 않는다', () => {
  const plain = { admin: true, showSerial: true, name: (s) => s, text: (s) => s, serial: (s) => s };
  const row = { id: 'p', rackId: 'r', face: 'full', uStart: 1, uSize: 1, kind: 'server', label: 'L', model: 'M', serial: 'S', serialKey: 's', extraSerials: ['E'], note: 'N', ratedW: 1, opW: null, weightKg: 2, updatedAt: 3, secretNew: 'ZZ' };
  const a = P.projectPlace(row, plain);
  assert.equal(a.note, 'N'); assert.equal(a.serial, 'S'); assert.ok(!('secretNew' in a) && !('serialKey' in a), '칸 목록에 없는 칸은 관리자에게도 싣지 않는다');
  const hidden = { admin: false, showSerial: false, name: (s) => `n:${s}`, text: (s) => `t:${s}`, serial: () => 'X' };
  const b = P.projectPlace(row, hidden);
  assert.deepEqual([b.label, b.model, b.serial, b.extraSerials, b.serialHidden, 'note' in b], ['n:L', 't:M', '', [], true, false]);
  assert.deepEqual(P.projectDiff({ counts: { a: 1 }, omitted: 0, items: [{ type: 'place', op: 'change', id: 'p', name: 'x', fields: ['note', 'label'], _tags: ['S'], extra: 1 }] }, hidden).items[0], { type: 'place', op: 'change', id: 'p', name: 'x', fields: ['label'] });
  assert.equal(P.projectHw({ cpu: { sockets: 2, cores: 8, model: 'X' }, mem: { gib: 64, dimms: 4 }, os: { name: 'RHEL' }, host: 'h', fw: '7.0' }, hidden).host, undefined);
});

test('가림 집계: 조회 · 쓰기 전체 범위 관리자만 · 건수는 (법인, 칸, 글) 이 서로 다른 것 · 재료의 값은 싣지 않는다', async () => {
  const ADMIN_A = U('admin-a', 'admin', ['vc-a']);   // 범위 관리자 — 원장은 고칠 수 있어도 집계는 못 본다(전 법인 재료로 판정하므로)
  for (const user of [OP_ALL, OP_A, ADMIN_A]) {
    const r = await call('GET /tools/rack/mask-census', { user });
    assert.equal(r.statusCode, 403, user.username); assert.ok(!JSON.stringify(r.body).includes('fields'));
  }
  assert.equal((await call('GET /tools/rack/mask-census', { user: ADMIN, query: { corp: 'no-such' } })).statusCode, 404);
  // 폭을 넓히면 걸릴 글 두 가지를 더 넣는다(지금은 그대로 보이는 글)
  const cur = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: seeded.roomId } })).body;
  const rackId = cur.racks.find((r) => r.name === 'B2').id;
  const a = await okOp({ op: 'place.add', rackId, rev: cur.rev, place: { face: 'full', uStart: 20, uSize: 1, kind: 'other', label: 'kvm zzhost-a1 spare' } });
  await okOp({ op: 'place.add', rackId, rev: a.rev, place: { face: 'full', uStart: 22, uSize: 1, kind: 'other', label: 'pdu ip-10-20-30-4' } });
  const r = await call('GET /tools/rack/mask-census', { user: ADMIN });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const c = r.body;
  assert.deepEqual(c.corps, [{ id: 'kr', name: 'KR' }]);
  assert.deepEqual(Object.keys(c.fields).sort(), ['label', 'model', 'rackName', 'rackRole', 'rackRow', 'roomName', 'siteName']);
  // 데이터센터 'DC <IP>' · 전산실 'R <host>' · 랙 'A1 <IP>' · 줄 'row <IP>' · 용도 'role <host> <tag>' — 전부 주소
  assert.deepEqual([c.fields.siteName, c.fields.roomName, c.fields.rackRow, c.fields.rackRole].map((f) => [f.total, f.addr]), [[1, 1], [1, 1], [1, 1], [1, 1]]);
  assert.deepEqual([c.fields.rackName.total, c.fields.rackName.addr], [2, 1], 'A1 <IP> 는 주소 · B2 는 그대로');
  // 표시 이름: 서버(주소 + 태그 → 주소로 센다) · 'stor-ZZSER0002'(태그) · 'kvm zzhost-a1 spare'(첫 마디) · 'pdu ip-10-20-30-4'(구분자를 바꾼 IP)
  assert.equal(c.fields.label.total, 4);
  assert.deepEqual([c.fields.label.addr, c.fields.label.tag, c.fields.label.firstLabel, c.fields.label.altIp], [1, 1, 1, 1]);
  assert.equal(c.sum.total, Object.values(c.fields).reduce((n, f) => n + f.total, 0));
  assert.equal(c.notes, 2, '메모가 있는 장비 수(내용은 싣지 않는다)');
  assert.ok(!JSON.stringify(c).includes('ZZNOTE'), '메모 내용은 집계에 없다');
  // 재료는 개수만 — 표본의 글은 원장의 글(관리자가 이미 보는 값)뿐
  assert.deepEqual(Object.keys(c.material).sort(), ['firstLabels', 'hosts', 'tags']);
  for (const v of Object.values(c.material)) assert.equal(typeof v, 'number');
  assert.ok(c.samples.length >= 7 && c.samples.every((s) => ['addr', 'tag', 'firstLabel', 'altIp'].includes(s.hits[0]) && typeof s.where === 'string'));
  assert.deepEqual(c.samples.find((s) => s.text === 'kvm zzhost-a1 spare').hits, ['firstLabel']);
  assert.deepEqual(c.samples.find((s) => s.text === 'pdu ip-10-20-30-4').hits, ['altIp']);
  // 집계는 읽기만 — 원장의 rev 가 그대로다
  assert.equal((await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: seeded.roomId } })).body.rev, (await call('GET /tools/rack/room/:id', { user: OP_ALL, params: { id: seeded.roomId } })).body.rev);
  // 지금은 그대로 보이는 글(폭을 넓히기 전) — 조회 계정 응답에 원문으로 있다(이 시험이 그 사실을 고정한다 — 폭을 넓히면 여기를 고친다)
  const sc = (await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: seeded.roomId } })).body.places.map((p) => p.label);
  assert.ok(sc.includes('pdu ip-10-20-30-4'), JSON.stringify(sc));
});
