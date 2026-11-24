// 랙 실장도 점검(2026-11-24 · 5축 + 반증 1인) 회귀 — 사용자 요청 '버그 찾고 개선 사항 찾아줘'(범위: 랙 실장도 전체 · 표준 · 확정 결함 수정 후 릴리스).
//   ① 테스트 공백 점검의 살아남은 변이(쓰기 범위 403 · 옮기기 범위 · 가림 · 엑셀 권한 · 트랜잭션 · 시리얼 중복 · 이름 중복 · 상한 · 정규화 동일성)
//   ② 확정 결함 회귀: C3 후면 장비 합계 · C5 IP 등록 서버 id/이름 가림 · C6 이름 속 서비스 태그 · 반증 추가 1 OS 호스트 이름 · C7 감사 id ·
//      C8 법인 상한 = 판 상한 · C10 되돌리기 미리 보기 = 실제 · C11 전산실 삭제가 이력을 지우지 않음 · C12 전산실 없는 이력 정리 · C13 앞 판 손상 구분 ·
//      C16 법인 목록에 없는 법인 · C18 랙 종류 치수 · C4 엑셀 시트 나누기
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackaudit-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp;
process.env.RACK_DB = path.join(tmp, 'rack.db');

const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const { registerRack } = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const L = await import(`${S}/rack/layout.js`);
const { normKey } = await import(`${S}/insights/serialKey.js`);
const V = await import(`${S}/rack/versions.js`);
const registry = await import(`${S}/idrac/registry.js`);
const audit = await import(`${S}/audit.js`);

const routes = new Map();
registerRack({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
async function call(key, { user, params = {}, query = {}, body = {} }) {
  const res = { statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; },
    setHeader(k, v) { this.headers[k] = v; }, end(b) { this.raw = b; return this; } };
  const req = { user, params, query, body, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0], originalUrl: `/api${key.replace(/^\w+ /, '')}` };
  for (const h of routes.get(key)) { let n = false; await h(req, res, () => { n = true; }); if (!n) break; }
  return res;
}
const U = (name, role, vcenters = [], writeVcenters = []) => ({ username: name, role, scope: { vcenters, regions: [], writeVcenters } });
const ADMIN = U('admin', 'admin');
const ADMIN_A = U('admin-a', 'admin', ['vc-a']);
const OP_A = U('op-a', 'operator', ['vc-a']);
const OP_ALL = U('op', 'operator');
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: ['vc-a', 'vc-b', 'vc-c'].map((id) => ({ id, name: id, status: 'ok' })), hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.addDatacenter({ id: 'pl', name: 'PL' });
dc.setVcenterDatacenter('vc-a', 'kr'); dc.setVcenterDatacenter('vc-c', 'kr'); dc.setVcenterDatacenter('vc-b', 'pl');
const op = (user, body) => call('POST /tools/rack/op', { user, body });
const rev = async (roomId) => (await R.getRoom(roomId)).room.rev;
const hex = () => crypto.randomBytes(8).toString('hex');

let kr; let pl;
test('준비(법인 kr = vc-a + vc-c · pl = vc-b)', async () => {
  const s1 = (await op(ADMIN, { op: 'site.add', corpId: 'kr', name: 'KR-1' })).body.id;
  const r1 = (await op(ADMIN, { op: 'room.add', siteId: s1, name: 'R1' })).body.id;
  const r2 = (await op(ADMIN, { op: 'room.add', siteId: s1, name: 'R2' })).body.id;
  const a1 = (await op(ADMIN, { op: 'rack.add', roomId: r1, rev: 0, rack: { name: 'A1', heightU: 42 } })).body.id;
  const b1 = (await op(ADMIN, { op: 'rack.add', roomId: r2, rev: 0, rack: { name: 'B1', heightU: 42 } })).body.id;
  kr = { s1, r1, r2, a1, b1 };
  const ps = (await op(ADMIN, { op: 'site.add', corpId: 'pl', name: 'PL-1' })).body.id;
  const pr = (await op(ADMIN, { op: 'room.add', siteId: ps, name: 'P-ROOM' })).body.id;
  const pa = (await op(ADMIN, { op: 'rack.add', roomId: pr, rev: 0, rack: { name: 'P-RACK', heightU: 42 } })).body.id;
  const pp = await op(ADMIN, { op: 'place.add', rackId: pa, rev: await rev(pr), place: { face: 'full', uStart: 1, uSize: 1, kind: 'other', label: 'PL-DEV', serial: 'PLSER-9' } });
  pl = { ps, pr, pa, pp: pp.body.id };
});

test('공백 D18: 장비를 다른 전산실 · 다른 법인 랙으로 옮기면 404 · 제자리', async () => {
  const p = await op(ADMIN, { op: 'place.add', rackId: kr.a1, rev: await rev(kr.r1), place: { face: 'full', uStart: 5, uSize: 1, kind: 'other', label: 'MV' } });
  for (const target of [kr.b1, pl.pa]) {
    const m = await op(ADMIN, { op: 'place.update', id: p.body.id, rackId: target, rev: await rev(kr.r1), place: { uStart: 10 } });
    assert.equal(m.statusCode, 404, target);
  }
  assert.equal((await R.getRoom(kr.r1)).places.find((x) => x.id === p.body.id).rackId, kr.a1);
  assert.equal((await R.getRoom(pl.pr)).places.length, 1, '다른 법인 랙은 그대로');
});

test('공백 R15: 법인 일부만 쓰기 범위인 관리자 — gate 경유 쓰기 403', async () => {
  assert.equal((await op(ADMIN_A, { op: 'room.add', siteId: kr.s1, name: 'X' })).statusCode, 403);
  assert.equal((await op(ADMIN_A, { op: 'rack.add', roomId: kr.r1, rev: await rev(kr.r1), rack: { name: 'X', heightU: 42 } })).statusCode, 403);
});

test('공백 R18: 법인 일부만 쓰기 범위인 관리자 — 되돌리기 403', async () => {
  const v = (await R.listVersions('kr'));
  assert.equal((await op(ADMIN_A, { op: 'version.restore', corpId: 'kr', versionId: v[2].id, expectLatestId: v[0].id })).statusCode, 403);
});

test('공백 R05/R06: 범위 비관리자에게 추가 시리얼 · 정규화 키도 없다', async () => {
  const p = await op(ADMIN, { op: 'place.add', rackId: kr.a1, rev: await rev(kr.r1), place: { face: 'full', uStart: 20, uSize: 4, kind: 'storage', label: 'H700', serial: 'MAIN-01', extraSerials: ['NODE-02'] } });
  assert.equal(p.statusCode, 200);
  const o = await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: kr.r1 } });
  const j = JSON.stringify(o.body).toLowerCase();
  assert.ok(!j.includes('main01') && !j.includes('main-01'), 'serialKey');
  assert.ok(!j.includes('node-02') && !j.includes('node02'), 'extraSerials');
});

test('공백 R04: 전체 범위 비관리자는 시리얼을 본다', async () => {
  const o = await call('GET /tools/rack/room/:id', { user: OP_ALL, params: { id: kr.r1 } });
  assert.equal(o.body.serialsHidden, false);
  assert.equal(o.body.places.find((x) => x.label === 'H700').serial, 'MAIN-01');
});

test('공백 R28: 법인 일부만 쓰기 범위 관리자 화면 canEdit=false', async () => {
  assert.equal((await call('GET /tools/rack/room/:id', { user: ADMIN_A, params: { id: kr.r1 } })).body.canEdit, false);
});

test('공백 R20: tools 는 있고 data.csv 가 없는 운영자 — 엑셀 403', async () => {
  assert.equal((await call('GET /tools/rack/room/:id', { user: OP_ALL, params: { id: kr.r1 } })).statusCode, 200);
  assert.equal((await call('GET /tools/rack/room/:id/xlsx', { user: OP_ALL, params: { id: kr.r1 } })).statusCode, 403);
});

test('공백 D26: 판 저장이 실패하면 변경도 취소(트랜잭션)', async () => {
  const db = await R.openRackDb();
  const before = await R.getRoom(kr.r1);
  db.exec("CREATE TRIGGER rv_fail BEFORE INSERT ON rack_version BEGIN SELECT RAISE(ABORT, 'probe'); END;");
  try {
    await assert.rejects(R.addRack({ roomId: kr.r1, rev: before.room.rev, user: 'x', input: { name: 'TXN', heightU: 42 } }));
  } finally { db.exec('DROP TRIGGER rv_fail'); }
  const now = await R.getRoom(kr.r1);
  assert.equal(now.room.rev, before.room.rev);
  assert.ok(!now.racks.some((r) => r.name === 'TXN'));
});

test('공백 D22/D24/D25: 시리얼 중복 — 수정 경로 · 기존 추가 시리얼 · 다른 법인은 대조 안 함', async () => {
  const q = await op(ADMIN, { op: 'place.add', rackId: kr.a1, rev: await rev(kr.r1), place: { face: 'full', uStart: 30, uSize: 1, kind: 'other', label: 'Q', serial: 'QQQ-1' } });
  assert.equal(q.statusCode, 200);
  const u = await op(ADMIN, { op: 'place.update', id: q.body.id, rev: await rev(kr.r1), place: { serial: 'main01' } });
  assert.equal(u.statusCode, 409, '수정으로 다른 장비 시리얼을 넣으면 409'); assert.equal(u.body.code, 'serialDup');
  const n = await op(ADMIN, { op: 'place.add', rackId: kr.a1, rev: await rev(kr.r1), place: { face: 'full', uStart: 32, uSize: 1, kind: 'server', label: 'N', serial: 'node02' } });
  assert.equal(n.statusCode, 409, '기존 장비의 추가 시리얼과도 대조');
  const c = await op(ADMIN, { op: 'place.add', rackId: kr.a1, rev: await rev(kr.r1), place: { face: 'full', uStart: 34, uSize: 1, kind: 'other', label: 'C', serial: 'PLSER-9' } });
  assert.equal(c.statusCode, 200, '다른 법인 시리얼과는 대조하지 않는다(다른 법인 위치가 409 문구로 새지 않게)');
});

test('공백 D04/D10/D11: 이름 중복 409(데이터센터 이름 바꾸기 · 랙 추가 · 랙 이름 바꾸기)', async () => {
  const s2 = (await op(ADMIN, { op: 'site.add', corpId: 'kr', name: 'KR-2' })).body.id;
  assert.equal((await op(ADMIN, { op: 'site.rename', id: s2, name: 'KR-1' })).statusCode, 409);
  assert.equal((await op(ADMIN, { op: 'rack.add', roomId: kr.r1, rev: await rev(kr.r1), rack: { name: 'A1', heightU: 42 } })).statusCode, 409);
  const a2 = (await op(ADMIN, { op: 'rack.add', roomId: kr.r1, rev: await rev(kr.r1), rack: { name: 'A2', heightU: 42 } })).body.id;
  assert.equal((await op(ADMIN, { op: 'rack.update', id: a2, rev: await rev(kr.r1), rack: { name: 'A1' } })).statusCode, 409);
});

test('공백 D07: removeRoom 로 지운 전산실을 되살리면 옛 rev 이하가 아니다', async () => {
  const sid = (await R.addSite({ corpId: 'pl', name: 'PL-2', user: 'admin' })).id;
  const rid = (await R.addRoom({ siteId: sid, name: 'RR', user: 'admin' })).id;
  const withRoom = (await R.listVersions('pl'))[0];
  const db = await R.openRackDb();
  db.prepare('UPDATE rack_room SET rev = 900000 WHERE id = ?').run(rid);
  await R.removeRoom({ id: rid, user: 'admin' });
  await R.restoreVersion({ corpId: 'pl', versionId: withRoom.id, expectLatestId: (await R.listVersions('pl'))[0].id, user: 'admin' });
  assert.ok((await R.getRoom(rid)).room.rev > 900000);
});

test('공백 D09/D15/D20: 상한 — 전산실 랙 400 · 랙 장비 120(놓기 · 옮기기)', async () => {
  const db = await R.openRackDb();
  const sid = (await R.addSite({ corpId: 'kr', name: 'CAP', user: 'admin' })).id;
  const rid = (await R.addRoom({ siteId: sid, name: 'CAP', user: 'admin' })).id;
  const full = (await R.addRack({ roomId: rid, rev: 0, user: 'admin', input: { name: 'FULL', heightU: 60 } })).id;
  const other = (await R.addRack({ roomId: rid, rev: 1, user: 'admin', input: { name: 'OTHER', heightU: 60 } })).id;
  const mv = await R.addPlace({ roomId: rid, rev: 2, user: 'admin', rackId: other, input: { face: 'full', uStart: 1, uSize: 1, kind: 'other', label: 'mv' } });
  const insP = db.prepare("INSERT INTO rack_place (id,rack_id,face,u_start,u_size,kind,updated_at) VALUES (?,?,?,?,1,'other',0)");
  for (let u = 1; u <= 60; u += 1) { insP.run(hex(), full, 'front', u); insP.run(hex(), full, 'rear', u); }
  await assert.rejects(R.addPlace({ roomId: rid, rev: mv.rev, user: 'a', rackId: full, input: { face: 'full', uStart: 1, uSize: 1, kind: 'other', label: 'x' } }), /120대까지/);
  await assert.rejects(R.updatePlace({ roomId: rid, rev: mv.rev, user: 'a', id: mv.id, rackId: full, input: {} }), /120대까지/);
  const insR = db.prepare('INSERT INTO rack_rack (id,room_id,name,height_u) VALUES (?,?,?,42)');
  for (let i = 0; i < 398; i += 1) insR.run(hex(), rid, `R${i}`);
  await assert.rejects(R.addRack({ roomId: rid, rev: mv.rev, user: 'a', input: { name: 'over', heightU: 42 } }), /400개까지/);
});

test('공백 xlsx R22/R23/R24: 부분 합 표기 · 없는 합은 — · 후면 장비는 후면 줄에만', async () => {
  const sid = (await op(ADMIN, { op: 'site.add', corpId: 'kr', name: 'XL' })).body.id;
  const rid = (await op(ADMIN, { op: 'room.add', siteId: sid, name: 'XL' })).body.id;
  const x = (await op(ADMIN, { op: 'rack.add', roomId: rid, rev: 0, rack: { name: 'X', heightU: 10 } })).body.id;
  const y = (await op(ADMIN, { op: 'rack.add', roomId: rid, rev: 1, rack: { name: 'Y', heightU: 10 } })).body.id;
  let r = 2;
  for (const [rackId, place] of [[x, { face: 'full', uStart: 1, uSize: 1, kind: 'other', label: 'PA', opW: 100 }], [x, { face: 'full', uStart: 2, uSize: 1, kind: 'other', label: 'PB' }],
    [x, { face: 'rear', uStart: 5, uSize: 1, kind: 'other', label: 'REARSW' }], [y, { face: 'full', uStart: 1, uSize: 1, kind: 'other', label: 'PC' }]]) {
    const p = await op(ADMIN, { op: 'place.add', rackId, rev: r, place }); assert.equal(p.statusCode, 200); r = p.body.rev;
  }
  const res = await call('GET /tools/rack/room/:id/xlsx', { user: ADMIN, params: { id: rid } });
  assert.equal(res.statusCode, 200);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(res.raw);
  const texts = []; wb.worksheets[0].eachRow((row) => row.eachCell((c) => { if (!c.isMerged || c.master === c || c.master.address === c.address) texts.push(String(c.value ?? '')); }));
  assert.ok(texts.includes('100 W (3대 중 1대)'), 'R22 · C3(후면 장비도 대수에 든다)');
  assert.ok(!texts.some((t) => t.startsWith('0 W')), 'R23');
  assert.equal(texts.filter((t) => t.includes('REARSW')).length, 1, 'R24');
});

test('공백 pure: L05 · L09 · L11 · L14 · L17 · L20', () => {
  assert.deepEqual(L.overflowOnResize([{ id: 'a', uStart: 10, uSize: 4 }], 13), [], 'L05 꼭 맞게 줄이기는 허용');
  assert.ok(L.cleanPlaceInput({ uStart: 1, uSize: 1, label: 'x', opW: 1e8 }).error, 'L09');
  assert.ok(L.cleanPlaceInput({ uStart: 1, uSize: 1, label: 'x', extraSerials: Array.from({ length: 17 }, (_, i) => `S${i}`) }).error, 'L11');
  assert.ok(L.cleanRackInput({ name: 'a', heightU: 42, pduA: 9 }).error, 'L14');
  assert.equal(L.rackTotals({ heightU: 2 }, [{ uStart: 1, uSize: 4 }]).usedU, 2, 'L17');
  for (const s of ['ab_c.d', 'A.B_C-1', ' x:y ']) assert.equal(L.serialKeyOf(s), normKey(s), `L20 ${s}`);
});

test('C3: 후면 전용 장비도 랙 합계(전력 · 무게 · 대수 · 사용 U)에 든다 — 엑셀 후면 줄에도 값', async () => {
  const sid = (await op(ADMIN, { op: 'site.add', corpId: 'kr', name: 'C3' })).body.id;
  const rid = (await op(ADMIN, { op: 'room.add', siteId: sid, name: 'C3' })).body.id;
  const rk = (await op(ADMIN, { op: 'rack.add', roomId: rid, rev: 0, rack: { name: 'T', heightU: 42 } })).body.id;
  let r = 1;
  for (const place of [{ face: 'full', uStart: 1, uSize: 2, kind: 'other', label: 'FULL', opW: 500, weightKg: 30 }, { face: 'rear', uStart: 10, uSize: 1, kind: 'network', label: 'REAR', opW: 200, weightKg: 5 }]) {
    const p = await op(ADMIN, { op: 'place.add', rackId: rk, rev: r, place }); assert.equal(p.statusCode, 200); r = p.body.rev;
  }
  const v = await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: rid } });
  const t = v.body.racks[0].totals;
  assert.equal(t.opW, 700); assert.equal(t.weightKg, 35); assert.equal(t.devices, 2); assert.equal(t.usedU, 3);
  const x = await call('GET /tools/rack/room/:id/xlsx', { user: ADMIN, params: { id: rid } });
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.raw);
  const texts = []; wb.worksheets[0].eachRow((row) => row.eachCell((c) => texts.push(String(c.value ?? ''))));
  assert.ok(texts.some((s) => s.includes('REAR') && s.includes('5 kg') && s.includes('운전 200 W')), '엑셀 후면 줄에 무게 · 전력');
  assert.ok(texts.includes('700 W'), '엑셀 합계에도 후면 포함');
});

test('C5 · C6 · 반증 추가 1: 비관리자 응답에 IP 로 등록한 서버의 주소 · 이름 속 서비스 태그 · OS 호스트 이름이 없다(관리자는 그대로)', async () => {
  registry.importServers([
    { id: '10.20.30.41', name: '10.20.30.41', host: '10.20.30.41', username: 'root', password: 'x', serviceTag: 'IPN0001', vcenterId: 'vc-a' },
    { id: '10.20.30.42', name: '10.20.30.42', host: '10.20.30.42', username: 'root', password: 'x', serviceTag: 'IPN0002', vcenterId: 'vc-a' },
    { id: 'tagged', name: 'idrac-TAG9876', host: 'https://10.20.30.43', username: 'root', password: 'x', serviceTag: 'TAG9876', vcenterId: 'vc-a' },
  ]);
  const p1 = await op(ADMIN, { op: 'place.add', rackId: kr.a1, rev: await rev(kr.r1), place: { face: 'full', uStart: 38, uSize: 1, kind: 'server', label: '', serial: 'IPN0001' } });
  assert.equal(p1.statusCode, 200);
  const p2 = await op(ADMIN, { op: 'place.add', rackId: kr.a1, rev: await rev(kr.r1), place: { face: 'full', uStart: 40, uSize: 1, kind: 'server', label: '', serial: 'TAG9876' } });
  assert.equal(p2.statusCode, 200);
  for (const user of [OP_A, OP_ALL]) {
    const v = await call('GET /tools/rack/room/:id', { user, params: { id: kr.r1 } });
    assert.equal(v.statusCode, 200);
    const j = JSON.stringify({ places: v.body.places, unplaced: v.body.unplaced });
    assert.ok(!j.includes('10.20.30.4'), `${user.username}: 관리 IP 가 응답에 없다`);
    const linked = v.body.places.find((x) => x.id === p1.body.id).link;
    assert.ok(linked && linked.serverId.startsWith('masked-'), '주소 id 는 토큰');
    assert.ok(linked.name.includes('이름 가림'));
    assert.equal(linked.hostname, '', 'OS 호스트 이름은 관리자만');
  }
  const scoped = JSON.stringify((await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: kr.r1 } })).body).toLowerCase();
  assert.ok(!scoped.includes('tag9876'), '범위 비관리자: 이름 속 서비스 태그도 걷어 낸다');
  const all = (await call('GET /tools/rack/room/:id', { user: OP_ALL, params: { id: kr.r1 } })).body;
  assert.equal(all.places.find((x) => x.id === p2.body.id).link.name, 'idrac-TAG9876', '시리얼을 보는 판본은 이름도 그대로');
  const adm = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: kr.r1 } })).body;
  assert.equal(adm.places.find((x) => x.id === p1.body.id).link.serverId, '10.20.30.41', '관리자 판본은 원문');
});

test('C7: 감사 상세는 요청 id 가 아니라 실제로 만든 id', async () => {
  const r = await op(ADMIN, { op: 'rack.add', roomId: kr.r1, rev: await rev(kr.r1), id: 'SPOOFED-ID', rack: { name: 'AUD', heightU: 42 } });
  assert.equal(r.statusCode, 200);
  const hits = audit.auditEntriesWithAction('rack.rack.add');
  assert.ok(hits.length, '감사 기록이 남는다');
  const last = hits.at(-1);
  assert.ok(last.detail.includes(r.body.id), last.detail);
  assert.ok(!hits.some((h) => h.detail.includes('SPOOFED')), '요청의 검증 안 된 id 를 싣지 않는다');
});

test('C8: 판 상한과 같은 법인 상한 — 넘는 변경은 409 corpCap 이고 아무것도 바뀌지 않는다', async () => {
  const db = await R.openRackDb();
  const ins = db.prepare('INSERT INTO rack_site (id,corp_id,name,sort,created_at) VALUES (?,?,?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < V.SNAP_CAPS.sites; i += 1) ins.run(hex(), 'cap', `S${i}`, i, 0);
  db.exec('COMMIT');
  await assert.rejects(R.addSite({ corpId: 'cap', name: 'over', user: 'admin' }), (e) => e.status === 409 && e.extra?.code === 'corpCap');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rack_site WHERE corp_id = 'cap'").get().n, V.SNAP_CAPS.sites);
  db.exec("DELETE FROM rack_site WHERE corp_id = 'cap'"); db.exec("DELETE FROM rack_version WHERE corp_id = 'cap'");
  assert.equal(V.capExceeded({ sites: V.SNAP_CAPS.sites }), ''); assert.equal(V.capExceeded({ places: V.SNAP_CAPS.places + 1 }), 'places');
});

test('C10: 되돌리기 미리 보기는 실제 결과와 같다(지워진 랙 종류 → 직접 높이)', async () => {
  const t = await R.addType({ name: 'C10-40U', heightU: 40 });
  const sid = (await R.addSite({ corpId: 'pl', name: 'C10', user: 'admin' })).id;
  const rid = (await R.addRoom({ siteId: sid, name: 'C10', user: 'admin' })).id;
  const rk = await R.addRack({ roomId: rid, rev: 0, user: 'admin', input: { name: 'T1', typeId: t.id } });
  const withType = (await R.listVersions('pl'))[0];
  await R.removeRack({ roomId: rid, rev: rk.rev, user: 'admin', id: rk.id });
  await R.removeType({ id: t.id });
  const d = await R.versionDetail('pl', withType.id);
  const item = d.restore.items.find((x) => x.type === 'rack' && x.name === 'T1');
  assert.equal(item.op, 'add');
  await R.restoreVersion({ corpId: 'pl', versionId: withType.id, expectLatestId: (await R.listVersions('pl'))[0].id, user: 'admin' });
  const after2 = await R.versionDetail('pl', withType.id);
  assert.deepEqual(after2.restore.items.filter((x) => x.type === 'rack'), [], '되돌린 뒤 같은 판과 차이가 없다(예전엔 typeId 차이가 남았다)');
});

test('C11 · C12: 전산실 삭제는 이력을 지우지 않는다 · 전산실 없는 이력도 법인마다 상한', async () => {
  const sid = (await R.addSite({ corpId: 'pl', name: 'C11', user: 'admin' })).id;
  const rid = (await R.addRoom({ siteId: sid, name: 'C11', user: 'admin' })).id;
  const withRoom = (await R.listVersions('pl'))[0];
  await R.removeRoom({ id: rid, user: 'admin' });
  await R.restoreVersion({ corpId: 'pl', versionId: withRoom.id, expectLatestId: (await R.listVersions('pl'))[0].id, user: 'admin' });
  assert.ok((await R.getRoom(rid)).logs.some((l) => l.action === 'room.add'), '되살린 전산실의 옛 이력');
  const db = await R.openRackDb();
  const ins = db.prepare("INSERT INTO rack_log (ts,user,corp_id,room_id,action,detail) VALUES (0,'x','pl','','site.rename','x')");
  db.exec('BEGIN'); for (let i = 0; i < 2100; i += 1) ins.run(); db.exec('COMMIT');
  await R.renameSite({ id: sid, name: 'C11-b', user: 'admin' });
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM rack_log WHERE corp_id = 'pl' AND room_id = ''").get().n <= 2001);
});

test('C13: 앞 판이 손상이면 prevUnreadable(가장 오래된 판과 구분)', async () => {
  const l = await R.listVersions('pl');
  const db = await R.openRackDb();
  db.prepare('UPDATE rack_version SET data = ? WHERE id = ?').run(Buffer.from('broken'), l[1].id);
  const d = await R.versionDetail('pl', l[0].id);
  assert.equal(d.changes, null); assert.equal(d.prevUnreadable, true);
  const oldest = await R.versionDetail('pl', l.at(-1).id);
  assert.equal(oldest.prevUnreadable, false);
});

test('C16: 법인 목록에서 지워진 법인 — 전체 범위 관리자는 다른 쓰기와 같게 데이터센터도 더할 수 있다', async () => {
  await R.addSite({ corpId: 'gone', name: 'G1', user: 'admin' });
  const t = await call('GET /tools/rack', { user: ADMIN });
  const g = t.body.corps.find((c) => c.id === 'gone');
  assert.ok(g?.orphan && g.writable);
  assert.equal((await op(ADMIN, { op: 'site.add', corpId: 'gone', name: 'G2' })).statusCode, 200);
  assert.equal((await op(ADMIN, { op: 'site.add', corpId: 'never', name: 'X' })).statusCode, 404, '원장도 없는 법인은 404');
  assert.equal((await op(ADMIN_A, { op: 'site.add', corpId: 'gone', name: 'G3' })).statusCode, 404, '범위 계정에는 보이지 않는다');
});

test('C18: 랙 종류 너비 · 깊이가 범위 밖이면 400(조용히 비우지 않는다)', async () => {
  assert.equal((await op(ADMIN, { op: 'type.add', name: 'W1', heightU: 42, widthMm: 99999 })).statusCode, 400);
  assert.equal((await op(ADMIN, { op: 'type.add', name: 'W2', heightU: 42, depthMm: 'abc' })).statusCode, 400);
  assert.equal((await op(ADMIN, { op: 'type.add', name: 'W3', heightU: 42, widthMm: 600, depthMm: '' })).statusCode, 200);
});

test('C4: 엑셀은 랙 12대씩 시트를 나눈다(병합 비용이 시트마다 제곱) · 시트 이름 31자 · 금지 글자', async () => {
  const { sheetNamesOf, RACKS_PER_SHEET } = await import(`${S}/routes/api/rack.js`);
  assert.deepEqual(sheetNamesOf('3층 A', 5), ['3층 A']);
  const names = sheetNamesOf('아주 긴 전산실 이름이 들어간 경우를 시험합니다 [x]', RACKS_PER_SHEET * 2 + 1);
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3);
  for (const n of names) { assert.ok(n.length <= 31); assert.ok(!/[\\/?*[\]:]/.test(n)); }
  assert.ok(names[2].endsWith(` ${RACKS_PER_SHEET * 2 + 1}-${RACKS_PER_SHEET * 2 + 1}`));
});

test.after(() => R._closeForTest());
