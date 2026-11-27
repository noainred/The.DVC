// [탐침 · 테스트 공백 축 r6] 칸 목록 투영 · 법인별 가림 — 살아남은 변이(R09 · R18 · R22 · R34 · R35 · R37 · R38 · R39 · R40)를 잡는 시험.
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

test('R18 · R22: 목록 응답의 전산실 이름 · 랙 종류 이름도 그 법인의 원장 시리얼로 가린다(범위 계정)', async () => {
  const t = (await call('GET /tools/rack', { user: OP_A })).body;
  const krRoom = t.rooms.find((r) => r.id === W.kr.roomId);
  assert.equal(krRoom.name, 'R •••', `전산실(목록): ${krRoom.name}`);
  assert.equal(t.sites.find((s) => s.id === W.kr.site).name, 'S •••');
  assert.equal(t.types.find((x) => x.id === W.type).name, 'T •••', '랙 종류 이름(전 법인 공용)도 이 계정이 보는 법인의 원장 시리얼로');
  assert.ok(!JSON.stringify(t).toLowerCase().includes('krser0001'));
  // 대조: 시리얼을 보는 판본은 그대로
  const full = (await call('GET /tools/rack', { user: OP_ALL })).body;
  assert.equal(full.rooms.find((r) => r.id === W.kr.roomId).name, 'R KRSER0001');
});

test('R09: 법인마다 가림이 따로다 — 법인 둘을 보는 범위 계정의 목록에서 두 법인 이름이 모두 가려진다(가림 캐시 키)', async () => {
  const t = (await call('GET /tools/rack', { user: OP_AB })).body;
  const names = [...t.sites, ...t.rooms].map((x) => x.name);
  assert.deepEqual(names.filter((n) => /SER0001/i.test(n)), [], JSON.stringify(names));
  assert.equal(t.rooms.find((r) => r.id === W.pl.roomId).name, 'R •••');
  assert.equal(t.rooms.find((r) => r.id === W.kr.roomId).name, 'R •••');
});

test('R34 · R35 · R37: 시리얼 칸의 옛 값 — 등록 주소가 글 속에 든 값 · 보이지 않는 글자가 낀 IP · 300자를 넘는 낱말은 비운다(시리얼을 보는 판본)', async () => {
  const p = await okOp({ op: 'place.add', rackId: W.kr.rackId, rev: W.kr.rev, place: { face: 'full', uStart: 7, uSize: 1, kind: 'storage', label: 'old', serial: 'OLD00001' } });
  W.kr.rev = p.rev;
  const db = await R.openRackDb();
  db.prepare('UPDATE rack_place SET serial = ?, extra_serials = ? WHERE id = ?')
    .run('SN/bmc-r6.mgmt.example', JSON.stringify(['10.20\u200b.30.97', 'Z'.repeat(310), 'KEEP-ME-2']), p.id);
  await R._resyncForTest();
  const v = (await room(OP_ALL, W.kr.roomId)).places.find((x) => x.id === p.id);
  assert.equal(v.serial, '', `글 속의 등록 주소(R35): ${v.serial}`);
  assert.deepEqual(v.extraSerials, ['KEEP-ME-2'], `보이지 않는 글자가 낀 IP(R37) · 300자 넘는 낱말(R34): ${JSON.stringify(v.extraSerials).slice(0, 120)}`);
  const a = (await room(ADMIN, W.kr.roomId)).places.find((x) => x.id === p.id);
  assert.equal(a.serial, 'SN/bmc-r6.mgmt.example', '관리자는 원문');
});

test('R39: 낱말 하나인 이름이 전각으로 적힌 주소면 이름 가림 표기(반각 주소와 같은 꼴)', async () => {
  const p = await okOp({ op: 'place.add', rackId: W.kr.rackId, rev: W.kr.rev, place: { face: 'full', uStart: 9, uSize: 1, kind: 'other', label: 'tmp' } });
  W.kr.rev = p.rev;
  const db = await R.openRackDb();
  db.prepare('UPDATE rack_place SET label = ? WHERE id = ?').run('１０．２０．３０．４４', p.id);
  await R._resyncForTest();
  const v = (await room(OP_ALL, W.kr.roomId)).places.find((x) => x.id === p.id);
  assert.match(v.label, /^masked-[0-9a-f]{12} \(이름 가림\)$/, v.label);
});

test('R38: 이름이 아닌 자유 글(모델 · 랙의 줄 · 용도)의 옛 전각 값도 접어서 판정한다 — 전각 IP 가 원문으로 나가지 않는다', async () => {
  const p = await okOp({ op: 'place.add', rackId: W.kr.rackId, rev: W.kr.rev, place: { face: 'full', uStart: 15, uSize: 1, kind: 'other', label: 'wide', model: 'tmp' } });
  W.kr.rev = p.rev;
  const db = await R.openRackDb();
  db.prepare('UPDATE rack_place SET model = ? WHERE id = ?').run('mdl １０．２０．３０．５５', p.id);
  db.prepare('UPDATE rack_rack SET role = ?, row_name = ? WHERE id = ?').run('role １０．２０．３０．５６', 'row １０．２０．３０．５７', W.kr.rackId);
  await R._resyncForTest();
  for (const user of [OP_ALL, OP_A]) {
    const v = await room(user, W.kr.roomId);
    assert.match(v.places.find((x) => x.id === p.id).model, /^mdl masked-[0-9a-f]{12}$/, `${user.username} 모델`);
    const k = v.racks.find((x) => x.id === W.kr.rackId);
    assert.match(k.role, /^role masked-[0-9a-f]{12}$/, `${user.username} 용도: ${k.role}`);
    assert.match(k.row, /^row masked-[0-9a-f]{12}$/, `${user.username} 줄: ${k.row}`);
  }
});

test('R40: 등록부 서비스 태그가 전각이어도 — 연결 키 · 가림 재료가 반각으로 접힌 값(원장에는 그 시리얼이 없다 — 등록부 경로만 본다)', async () => {
  registry.importServers([{ id: 'fw1', name: 'fw1', host: 'https://10.61.0.1', username: 'root', password: 'x', serviceTag: 'ＦＷＴＡＧ００１', vcenterId: 'vc-a' }], 'merge');
  const q = await okOp({ op: 'place.add', rackId: W.kr.rackId, rev: W.kr.rev, place: { face: 'full', uStart: 11, uSize: 1, kind: 'other', label: 'spare FWTAG001 box' } });
  W.kr.rev = q.rev;
  const adm = await room(ADMIN, W.kr.roomId);
  assert.ok(adm.unplaced.some((u) => u.serverId === 'fw1' && u.serviceTag === 'FWTAG001'), `연결 키는 접힌 값: ${JSON.stringify(adm.unplaced)}`);
  assert.equal((await room(OP_A, W.kr.roomId)).places.find((x) => x.id === q.id).label, 'spare ••• box');
});

test('빠진 시험: 법인 목록에서 지운 법인의 원장(전체 범위 계정에게 “법인 목록에 없음” 으로 보인다)도 이름을 가린다 · 범위 계정에는 주지 않는다', async () => {
  const s = await okOp({ op: 'site.add', corpId: 'pl', name: 'DC 10.71.0.1' });
  dc.removeDatacenter('pl');
  const t = (await call('GET /tools/rack', { user: OP_ALL })).body;
  assert.ok(t.corps.some((c) => c.id === 'pl' && c.orphan && c.name === 'pl(법인 목록에 없음)'), JSON.stringify(t.corps));
  assert.match(t.sites.find((x) => x.id === s.id).name, /^DC masked-[0-9a-f]{12}$/);
  const scoped = (await call('GET /tools/rack', { user: OP_AB })).body;
  assert.ok(!scoped.sites.some((x) => x.corpId === 'pl') && !scoped.corps.some((c) => c.id === 'pl'), '범위 계정에는 지운 법인의 원장을 주지 않는다');
});
