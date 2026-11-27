// 랙 실장도 라우트(routes/api/rack.js) — 범위 · 관리자만 편집 · 조회 밖 404 → 쓰기 밖 403 · rev 충돌 · 서비스 태그 연결 ·
//   범위 비관리자 시리얼 미노출 · 관리 주소는 관리자 판본만 · 랙 종류는 전체 범위 관리자 · 엑셀 내보내기.
//   설계 docs/design/rack-elevation/README.md(2026-11-20 결정: 중앙 원장 · 관리자만 편집 · 서버는 서비스 태그로).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackr-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp;
process.env.RACK_DB = path.join(tmp, 'rack.db');
process.env.RACK_SELF_CHECK = '1';   // 조각 캐시로 만든 판 · 시리얼 키 색인 판정을 원장 훑기와 매번 대조한다(다르면 던진다)

const dc = await import('../src/datacenter/store.js');
const registry = await import('../src/idrac/registry.js');
const { store } = await import('../src/store.js');
const { registerRack, corpAccessOf } = await import('../src/routes/api/rack.js');
const { TOOL_PATH_KEYS } = await import('../src/auth/toolAccess.js');
const { PRESET } = await import('../src/toolcats/catalog.js');
const R = await import('../src/rack/db.js');

const routes = new Map();
registerRack({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });

const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const ADMIN_A = { username: 'admin-a', role: 'admin', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
const ADMIN_RW = { username: 'admin-rw', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: ['vc-a'] } };
const OP_A = { username: 'op-a', role: 'operator', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
const OP_ALL = { username: 'op', role: 'operator', scope: { vcenters: [], regions: [], writeVcenters: [] } };

/** 미들웨어까지 차례로 돈다(역할 · 권한 게이트 포함). */
async function call(key, { user = ADMIN, params = {}, body = {} } = {}) {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; },
    end(b) { this.raw = b; this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; } };
  const req = { user, params, query: {}, body, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0], originalUrl: `/api${key.replace(/^\w+ /, '')}` };
  for (const h of routes.get(key)) {
    let nexted = false;
    await h(req, res, () => { nexted = true; });
    if (!nexted) break;
  }
  return res;
}

const snap = () => ({ ...store.snapshot, initial: false, generatedAt: Date.now(),
  vcenters: [{ id: 'vc-a', name: 'vcenter-a', status: 'ok' }, { id: 'vc-b', name: 'vcenter-b', status: 'ok' }, { id: 'vc-c', name: 'vcenter-c', status: 'ok' }], hosts: [], vms: [] });
store.snapshot = snap();
dc.addDatacenter({ id: 'kr', name: '한국 법인' });
dc.addDatacenter({ id: 'pl', name: '폴란드 법인' });
dc.addDatacenter({ id: 'empty', name: '할당 없는 법인' });
dc.setVcenterDatacenter('vc-a', 'kr');
dc.setVcenterDatacenter('vc-c', 'kr');   // 한국 법인 = vc-a + vc-c
dc.setVcenterDatacenter('vc-b', 'pl');
registry.importServers([
  { id: 's1', name: 'kr-esx-01', host: 'https://192.0.2.11', username: 'root', password: 'x', serviceTag: 'ABC1234', vcenterId: 'vc-a' },
  { id: 's2', name: 'kr-esx-02', host: 'https://192.0.2.12', username: 'root', password: 'x', serviceTag: 'DEF5678', vcenterId: 'vc-a' },
  { id: 's3', name: 'pl-esx-01', host: 'https://192.0.2.13', username: 'root', password: 'x', serviceTag: 'PL00001', vcenterId: 'vc-b' },
], 'replace');

const op = (user, body) => call('POST /tools/rack/op', { user, body });

test('등록: 도구 키 = 세그먼트(rack) · 서버 분류에 배치', () => {
  assert.equal(TOOL_PATH_KEYS.rack, 'rack');
  assert.ok(PRESET.find((c) => c.id === 'server').tools.includes('rack'));
});

test('범위 판정(corpAccessOf): 조회 = 할당 vCenter 하나라도 · 쓰기 = 관리자 ∧ 할당 vCenter 전부 쓰기 범위', () => {
  const s = store.get();
  const full = corpAccessOf(ADMIN, s);
  assert.equal(full.read, null); assert.equal(full.write, null);
  const a = corpAccessOf(ADMIN_A, s);
  assert.deepEqual([...a.read], ['kr']);
  assert.deepEqual([...a.write], [], 'vc-c 가 범위 밖이라 한국 법인 전체를 고칠 수 없다');
  const rw = corpAccessOf(ADMIN_RW, s);
  assert.equal(rw.read, null);
  assert.deepEqual([...rw.write], [], 'writeVcenters=vc-a 만이면 kr(vc-a+vc-c)도 pl 도 못 고친다');
  assert.deepEqual([...corpAccessOf(OP_ALL, s).write], [], '관리자가 아니면 쓰기 없음');
  assert.ok(!corpAccessOf(OP_A, s).read.has('empty'), '할당 없는 법인은 범위 계정에 보이지 않는다');
});

let siteId; let roomId; let rackId; let rev;

test('쓰기: 관리자만 — 운영자 403 · 범위 관리자(법인 일부만 쓰기) 403 · 범위 밖 법인 404', async () => {
  assert.equal((await op(OP_ALL, { op: 'site.add', corpId: 'kr', name: 'KR-SEL' })).statusCode, 403);
  assert.equal((await op(ADMIN_A, { op: 'site.add', corpId: 'kr', name: 'KR-SEL' })).statusCode, 403);
  assert.equal((await op(ADMIN_A, { op: 'site.add', corpId: 'pl', name: 'PL-WAW' })).statusCode, 404, '조회 밖은 존재를 숨긴다');
  assert.equal((await op(ADMIN, { op: 'site.add', corpId: 'nope', name: 'X' })).statusCode, 404);
  const r = await op(ADMIN, { op: 'site.add', corpId: 'kr', name: 'KR-SEL' });
  assert.equal(r.statusCode, 200); siteId = r.body.id;
  roomId = (await op(ADMIN, { op: 'room.add', siteId, name: '전산실 A' })).body.id;
  const rk = await op(ADMIN, { op: 'rack.add', roomId, rev: 0, rack: { name: 'A4', heightU: 42, pduA: 2, pduB: 2 } });
  assert.equal(rk.statusCode, 200); rackId = rk.body.id; rev = rk.body.rev;
  const pl = (await op(ADMIN, { op: 'site.add', corpId: 'pl', name: 'PL-WAW' })).body.id;
  assert.equal((await op(ADMIN_A, { op: 'room.add', siteId: pl, name: 'X' })).statusCode, 404, '범위 밖 데이터센터 id 로 쓰기 — 404');
});

test('쓰기: rev 충돌 409 · 겹침 409 · 입력 오류 400', async () => {
  const p = await op(ADMIN, { op: 'place.add', rackId, rev, place: { face: 'full', uStart: 1, uSize: 2, kind: 'server', label: '가상화서버 #1', model: 'R740', serial: 'abc-1234', opW: 560, ratedW: 750, weightKg: 33 } });
  assert.equal(p.statusCode, 200); rev = p.body.rev;
  const stale = await op(ADMIN, { op: 'place.add', rackId, rev: rev - 1, place: { uStart: 5, uSize: 1, kind: 'other', label: 'x' } });
  assert.equal(stale.statusCode, 409); assert.equal(stale.body.code, 'revConflict'); assert.equal(stale.body.rev, rev);
  const ov = await op(ADMIN, { op: 'place.add', rackId, rev, place: { uStart: 2, uSize: 1, kind: 'other', label: 'x' } });
  assert.equal(ov.statusCode, 409); assert.equal(ov.body.code, 'overlap');
  assert.equal((await op(ADMIN, { op: 'place.add', rackId, rev, place: { uStart: 5, kind: 'other', label: 'x' } })).statusCode, 400, '높이 없음');
  const n = await op(ADMIN, { op: 'place.add', rackId, rev, place: { face: 'full', uStart: 20, uSize: 1, kind: 'other', label: 'KVM' } });
  assert.equal(n.statusCode, 200); rev = n.body.rev;
  assert.equal((await op(ADMIN, { op: 'bogus' })).statusCode, 400);
});

test('조회: 서비스 태그로 iDRAC 서버 연결 · 미배치 · 관리 주소는 관리자만 · 범위 비관리자에게 시리얼 없음', async () => {
  const a = await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: roomId } });
  assert.equal(a.statusCode, 200);
  const srv = a.body.places.find((p) => p.kind === 'server');
  assert.equal(srv.linkState, 'linked', '대소문자 · 하이픈이 달라도 서비스 태그로 잇는다');
  assert.equal(srv.link.serverId, 's1');
  assert.equal(srv.link.mgmtHost, '192.0.2.11');
  assert.equal(srv.serial, 'abc-1234');
  assert.equal(a.body.places.find((p) => p.kind === 'other').linkState, 'n/a');
  assert.deepEqual(a.body.unplaced.map((u) => u.serverId), ['s2'], '한국 법인 서버 중 원장에 없는 것만(폴란드 서버 제외)');
  assert.equal(a.body.canEdit, true);
  assert.equal(a.body.racks[0].totals.opW, 560);
  assert.equal(a.body.racks[0].totals.opRead, 1, 'KVM 은 전력이 비어 합에 넣지 않고 읽은 대수로 밝힌다');

  const o = await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: roomId } });
  assert.equal(o.statusCode, 200);
  const s2 = o.body.places.find((p) => p.kind === 'server');
  assert.equal(s2.serial, ''); assert.equal(s2.serialHidden, true);
  assert.equal(s2.link.mgmtHost, undefined, '비관리자 판본에는 관리 주소 없음');
  // 2026-11-27: 미배치 서버 목록은 관리자에게만 싣는다(조회 계정에는 대수만 — `rack/project.js` 칸 목록). 예전 단언(범위 비관리자의 미배치 항목에 serviceTag 가 없다)보다 강한 사실:
  //   목록 자체가 비어 있고, 등록부 이름 · 서비스 태그 · 관리 주소가 응답 어디에도 없다.
  assert.deepEqual(o.body.unplaced, [], '조회 계정의 미배치 목록은 비어 있다'); assert.equal(o.body.unplacedListed, false);
  assert.equal(o.body.unplacedTotal, 1, '대수는 그대로(s2)');
  assert.ok(s2.link.serverId.startsWith('masked-') && !('name' in s2.link) && !('hostname' in s2.link), `연결 정보에 등록부 이름 · 호스트 이름 키가 없다: ${JSON.stringify(s2.link)}`);
  const oj = JSON.stringify(o.body);
  for (const secret of ['DEF5678', 'ABC1234', 'abc-1234', 'kr-esx-0', '192.0.2.']) assert.ok(!oj.includes(secret), `범위 비관리자 응답에 ‘${secret}’ 가 있다`);
  assert.equal(a.body.unplacedListed, true);
  assert.deepEqual(a.body.unplaced.map((u) => [u.name, u.serviceTag]), [['kr-esx-02', 'DEF5678']], '관리자 판본의 미배치 목록은 등록부 이름 · 서비스 태그 원문');
  assert.equal(srv.link.name, 'kr-esx-01', '관리자 판본의 연결 정보는 등록부 이름 그대로');
  assert.equal(o.body.canEdit, false);
  assert.ok(o.body.logs.every((l) => l.user === ''), '비관리자에게 작업자 계정명 없음');

  const t = await call('GET /tools/rack', { user: OP_A });
  assert.deepEqual(t.body.corps.map((c) => c.id), ['kr'], '범위 계정은 자기 법인만');
  assert.ok(t.body.sites.every((s) => s.corpId === 'kr'));
});

test('조회: 범위 밖 · 없는 전산실은 404', async () => {
  const pl = (await R.listTree(null)).sites.find((s) => s.corpId === 'pl');
  const plRoom = (await op(ADMIN, { op: 'room.add', siteId: pl.id, name: 'W1' })).body.id;
  const OP_B = { username: 'op-b', role: 'operator', scope: { vcenters: ['vc-b'], regions: [], writeVcenters: [] } };
  assert.equal((await call('GET /tools/rack/room/:id', { user: OP_B, params: { id: roomId } })).statusCode, 404);
  assert.equal((await call('GET /tools/rack/room/:id', { user: OP_B, params: { id: plRoom } })).statusCode, 200);
  assert.equal((await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: 'zz' } })).statusCode, 404);
});

test('랙 종류: 조회 · 쓰기 전체 범위 관리자만', async () => {
  assert.equal((await op(ADMIN_RW, { op: 'type.add', name: '42U', heightU: 42 })).statusCode, 403);
  assert.equal((await op(ADMIN_A, { op: 'type.add', name: '42U', heightU: 42 })).statusCode, 403);
  const t = await op(ADMIN, { op: 'type.add', name: '스토리지 40U', heightU: 40 });
  assert.equal(t.statusCode, 200);
  const g = await call('GET /tools/rack', { user: ADMIN });
  assert.equal(g.body.types[0].heightU, 40);
  assert.equal(g.body.canEditTypes, true);
  assert.equal((await call('GET /tools/rack', { user: ADMIN_RW })).body.canEditTypes, false);
});

test('옮기기: 다른 랙 · 이력에 남는다', async () => {
  const b = await op(ADMIN, { op: 'rack.add', roomId, rev, rack: { name: 'A5', heightU: 42 } });
  rev = b.body.rev;
  const srv = (await call('GET /tools/rack/room/:id', { params: { id: roomId } })).body.places.find((p) => p.kind === 'server');
  const mv = await op(ADMIN, { op: 'place.update', id: srv.id, rackId: b.body.id, rev, place: { uStart: 7 } });
  assert.equal(mv.statusCode, 200); rev = mv.body.rev;
  const v = (await call('GET /tools/rack/room/:id', { params: { id: roomId } })).body;
  assert.equal(v.places.find((p) => p.id === srv.id).rackId, b.body.id);
  assert.equal(v.logs[0].action, 'place.move');
  assert.equal(v.logs[0].user, 'admin');
});

test('엑셀 내보내기: data.csv 권한 · 범위 404 · 장비 · 합계 줄', async () => {
  const OP_NOCSV = { username: 'v', role: 'viewer', scope: { vcenters: [], regions: [], writeVcenters: [] } };
  assert.equal((await call('GET /tools/rack/room/:id/xlsx', { user: OP_NOCSV, params: { id: roomId } })).statusCode, 403);
  const x = await call('GET /tools/rack/room/:id/xlsx', { user: ADMIN, params: { id: roomId } });
  assert.equal(x.statusCode, 200);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.raw);
  const ws = wb.worksheets[0];
  const texts = [];
  ws.eachRow((row) => row.eachCell((c) => texts.push(String(c.value ?? ''))));
  assert.ok(texts.some((t) => t.includes('가상화서버 #1')));
  assert.ok(texts.some((t) => t.startsWith('실장율(N/42)')));
  assert.ok(texts.some((t) => /560 W/.test(t)));
});

test('반증 F1: 이름 없이 시리얼만 넣은 장비 — 이력 내용에 시리얼이 나가지 않는다', async () => {
  const p = await op(ADMIN, { op: 'place.add', rackId, rev, place: { face: 'rear', uStart: 30, uSize: 1, kind: 'other', serial: 'SECRETTAG9' } });
  assert.equal(p.statusCode, 200); rev = p.body.rev;
  const o = await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: roomId } });
  assert.ok(!JSON.stringify(o.body.logs).includes('SECRETTAG9'));
  assert.ok(!JSON.stringify(o.body.places).includes('SECRETTAG9'));
  const rm = await op(ADMIN, { op: 'place.remove', id: p.body.id, rev });
  rev = rm.body.rev;
  assert.ok(!JSON.stringify((await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: roomId } })).body.logs).includes('SECRETTAG9'));
});

test('반증 F3 · F4 · F7: 부분 수정의 빈 면 · 종류는 400 · 이름과 시리얼을 모두 비우면 400 · 같은 법인 시리얼 중복 409', async () => {
  const p = await op(ADMIN, { op: 'place.add', rackId, rev, place: { face: 'rear', uStart: 31, uSize: 1, kind: 'other', label: '후면 장비', serial: 'DUP-1' } });
  assert.equal(p.statusCode, 200); rev = p.body.rev;
  for (const bad of [{ face: '' }, { face: 123 }, { face: ['rear'] }, { kind: '' }]) {
    assert.equal((await op(ADMIN, { op: 'place.update', id: p.body.id, rev, place: bad })).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await op(ADMIN, { op: 'place.update', id: p.body.id, rev, place: { label: '', serial: '' } })).statusCode, 400);
  const d = await op(ADMIN, { op: 'place.add', rackId, rev, place: { face: 'full', uStart: 33, uSize: 1, kind: 'other', label: '다른 장비', serial: 'dup1' } });
  assert.equal(d.statusCode, 409); assert.equal(d.body.code, 'serialDup', '대소문자 · 하이픈이 달라도 같은 시리얼');
  const d2 = await op(ADMIN, { op: 'place.add', rackId, rev, place: { face: 'full', uStart: 33, uSize: 1, kind: 'other', label: '다른 장비', extraSerials: ['DUP-1'] } });
  assert.equal(d2.statusCode, 409, '추가 시리얼도 대조');
  const same = await op(ADMIN, { op: 'place.update', id: p.body.id, rev, place: { serial: 'DUP-1', label: '후면 장비 2' } });
  assert.equal(same.statusCode, 200, '자기 자신과는 중복 아님'); rev = same.body.rev;
  rev = (await op(ADMIN, { op: 'place.remove', id: p.body.id, rev })).body.rev;
});

test('반증 F8: 랙 높이만 고치면 종류는 직접 입력으로 바뀐다', async () => {
  const t = (await call('GET /tools/rack', { user: ADMIN })).body.types[0];
  const r = await op(ADMIN, { op: 'rack.add', roomId, rev, rack: { name: 'T1', typeId: t.id } });
  assert.equal(r.statusCode, 200); rev = r.body.rev;
  const u = await op(ADMIN, { op: 'rack.update', id: r.body.id, rev, rack: { heightU: 45 } });
  assert.equal(u.statusCode, 200); rev = u.body.rev;
  const rk = (await call('GET /tools/rack/room/:id', { params: { id: roomId } })).body.racks.find((x) => x.id === r.body.id);
  assert.equal(rk.heightU, 45); assert.equal(rk.typeId, '');
  rev = (await op(ADMIN, { op: 'rack.remove', id: r.body.id, rev })).body.rev;
});

test('반증 F2 · F6: 시트 이름 예약어 · 작은따옴표 · 내보내기 동시 1건', async () => {
  const { sheetNameOf } = await import('../src/routes/api/rack.js');
  assert.equal(sheetNameOf('History'), '전산실 History');
  assert.equal(sheetNameOf("'q'"), 'q');
  assert.equal(sheetNameOf("''"), '전산실');
  assert.equal(sheetNameOf('a/b:c'), 'a b c');
  const r2 = (await op(ADMIN, { op: 'room.add', siteId, name: 'History' })).body.id;
  const x = await call('GET /tools/rack/room/:id/xlsx', { user: ADMIN, params: { id: r2 } });
  assert.equal(x.statusCode, 200);
  const { acquireExport } = await import('../src/util/exportBusy.js');
  const lock = acquireExport('rack-xlsx', { user: ADMIN });
  try { assert.equal((await call('GET /tools/rack/room/:id/xlsx', { user: ADMIN, params: { id: roomId } })).statusCode, 409); } finally { lock.release(); }
});

test('범위: 같은 법인이라도 범위 밖 vCenter 의 서버는 범위 계정에 연결 · 미배치로 보이지 않는다(서버 목록을 먼저 자른다)', async () => {
  registry.importServers([{ id: 's4', name: 'kr-esx-vcc', host: 'https://192.0.2.14', username: 'root', password: 'x', serviceTag: 'VCC0001', vcenterId: 'vc-c' }], 'merge');
  const p = await op(ADMIN, { op: 'place.add', rackId, rev, place: { face: 'full', uStart: 36, uSize: 2, kind: 'server', label: 'vc-c 서버', serial: 'VCC0001' } });
  assert.equal(p.statusCode, 200); rev = p.body.rev;
  const a = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: roomId } })).body;
  assert.equal(a.places.find((x) => x.id === p.body.id).linkState, 'linked', '전체 범위 관리자는 연결된다');
  const o = (await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: roomId } })).body;
  const mine = o.places.find((x) => x.id === p.body.id);
  assert.equal(mine.linkState, 'not-found'); assert.equal(mine.link, null, 'vc-c 서버의 iDRAC 정보가 vc-a 범위 계정에 새지 않는다');
  rev = (await op(ADMIN, { op: 'place.remove', id: p.body.id, rev })).body.rev;
  const o2 = (await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: roomId } })).body;
  assert.ok(!o2.unplaced.some((u) => u.serverId === 's4'), '범위 밖 서버는 미배치 목록에도 없다');
  assert.ok((await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: roomId } })).body.unplaced.some((u) => u.serverId === 's4'));
});
