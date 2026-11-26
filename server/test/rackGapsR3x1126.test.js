// 랙 실장도 3회차 점검(2026-11-26 · 2회차 뒤 다시 쓴 코드의 변이 70건 중 살아남은 26건을 막는 테스트 — 테스트 이름의 번호가 그 변이).
// 랙 실장도 3회차 점검(2026-11-26 · 테스트 공백 축) 탐침 — 2회차 뒤에 들어온 코드에서 살아남은 변이를 잡는다.
// 공개 함수(TM.* · R.*)와 라우트 응답만 본다. SQL 로 직접 고치는 곳은 '옛 원장 · 손상 · 기록을 못 채운 원장' 을 흉내 내는 준비뿐이다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackr3probe-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const registry = await import(`${S}/idrac/registry.js`);
const invCache = await import(`${S}/idrac/invCache.js`);
const remoteInv = await import(`${S}/collector/remoteInventory.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const TM = await import(`${S}/rack/textMask.js`);
const routes = new Map();
RT.registerRack({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
async function call(key, { user, params = {}, query = {}, body = {} }) {
  const res = { statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {}, end(b) { this.raw = b; return this; } };
  const req = { user, params, query, body, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0], originalUrl: `/api${key.replace(/^\w+ /, '')}` };
  for (const h of routes.get(key)) { let n = false; await h(req, res, () => { n = true; }); if (!n) break; }
  return res;
}
const U = (name, role, vcenters = []) => ({ username: name, role, scope: { vcenters, regions: [], writeVcenters: [] } });
const ADMIN = U('admin', 'admin'); const OP_A = U('op-a', 'operator', ['vc-a']); const OP_ALL = U('op', 'operator');
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: ['vc-a', 'vc-c'].map((id) => ({ id, name: id, status: 'ok' })), hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr'); dc.setVcenterDatacenter('vc-c', 'kr');
registry.importServers([
  { id: 's-a', name: 'srv-a', host: 'https://idrac-a1.mgmt.example', username: 'root', password: 'x', serviceTag: 'SVA0001', vcenterId: 'vc-a' },
  { id: 's-x', name: 'srv-x', host: 'https://idrac-x9.mgmt.example', username: 'root', password: 'x', serviceTag: 'SVX0099', vcenterId: 'vc-c' },   // 같은 법인 · 범위 계정(vc-a)의 범위 밖 · 원장에 없는 태그
  { id: 's-inv', name: 'srv-inv', host: 'https://idrac-i2.mgmt.example', username: 'root', password: 'x', serviceTag: '', vcenterId: 'vc-a' },      // 등록부 태그 칸이 빈 서버(태그는 인벤토리에만)
  { id: 's-nd', name: 'srv-nd', host: 'https://bmc-main.mgmt.example', username: 'root', password: 'x', serviceTag: 'SVN0003', vcenterId: 'vc-a' },  // 숫자 없는 관리 FQDN
]);
invCache.setInventory('s-inv', { system: { model: 'R650', serviceTag: 'INVT7788' }, collectedAt: Date.now() });
// host 없이 올라온 원격(엣지) 서버 — id 가 관리 주소다
remoteInv.setCollectorServers('edge-kr', 'kr', [{ id: 'bmc-edge7.mgmt.example', name: 'edge-seven', serviceTag: 'REM0007', datacenterId: 'kr', vcenterId: 'vc-c' }]);
const op = (body) => call('POST /tools/rack/op', { user: ADMIN, body });
const views = async (user, roomId) => {
  const room = (await call('GET /tools/rack/room/:id', { user, params: { id: roomId } })).body;
  const list = (await call('GET /tools/rack/versions', { user, query: { corp: 'kr' } })).body;
  const details = [];
  for (const v of list.versions) details.push((await call('GET /tools/rack/versions/:vid', { user, params: { vid: String(v.id) }, query: { corp: 'kr' } })).body);
  return { room, list, details, all: JSON.stringify({ room, list, details }), ver: JSON.stringify({ list, details }) };
};
let roomId; let rackId; let rev;
const put = async (place) => { const p = await op({ op: 'place.add', rackId, rev, place: { face: 'full', uSize: 1, kind: 'other', ...place } }); assert.equal(p.statusCode, 200, JSON.stringify(p.body)); rev = p.body.rev; return p.body.id; };
const labelAt = (room, u) => room.places.find((p) => p.uStart === u)?.label;

test('준비', async () => {
  const s = (await op({ op: 'site.add', corpId: 'kr', name: 'S' })).body.id;
  roomId = (await op({ op: 'room.add', siteId: s, name: 'R' })).body.id;
  const k = await op({ op: 'rack.add', roomId, rev: 0, rack: { name: 'A1', heightU: 42 } });
  rackId = k.body.id; rev = k.body.rev;
  await put({ uStart: 1, label: 'spare-for-SVX0099' });                 // M03 · M27: 범위 밖 서버의 등록부 태그(원장에는 없는 값)
  await put({ uStart: 2, label: 'spare-for-INVT7788' });                // M04: 인벤토리에서만 읽힌 태그
  await put({ uStart: 3, label: 'uplink bmc-edge7.mgmt.example rear' });// M02: host 없는 원격 서버의 id(관리 주소)
  await put({ uStart: 4, label: 'gw (2001:db8::51) rear' });            // M14 · M15: 괄호로 싼 IPv6
  await put({ uStart: 5, label: 'gw 2001:db8::52, rear' });             // M15: 쉼표가 붙은 IPv6
  await put({ uStart: 6, label: 'v6 (2001:db8::53 up' });               // M14: 여는 괄호만
  await put({ uStart: 7, label: '[2001:db8::10]:443' });                // M21: 대괄호 + 포트 — 낱말 하나인 주소
  await put({ uStart: 8, label: 'core-sw 10.20.30.40 uplink' });        // M22: 여러 낱말 — 주소인 낱말만
  await put({ uStart: 9, label: 'rear bmc-main.mgmt.example' });        // T26: 글 끝에 닿는 등록 주소(숫자 없음)
  const gone = await put({ uStart: 10, kind: 'storage', label: 'stor-GONE4321', serial: 'GONE4321' });
  const rm = await op({ op: 'place.remove', id: gone, rev }); assert.equal(rm.statusCode, 200); rev = rm.body.rev;
});

test('탐침 S06 · S09 · S10 · T12 · T16 · T21 · T22 · T26: textMask 순수 판정의 경계', () => {
  const ix = TM.tagIndexOf(['XY-56-ZW78']);
  assert.equal(TM.stripTags('node XY\t56\tZW78 rear', ix), 'node ••• rear', '탭(normKey 의 \\s)');
  assert.equal(TM.stripTags('node XY\u00a056\u00a0ZW78 rear', ix), 'node ••• rear', '줄 바꿈 없는 공백 U+00A0');
  assert.equal(TM.stripTags('node XY\u300056\u3000ZW78 rear', ix), 'node ••• rear', '전각 공백 U+3000');
  const t64 = 'A1B2C3D4'.repeat(8);   // 시리얼 길이 상한(LIMITS.serial = 64)과 같은 길이
  assert.equal(TM.stripTags(`x ${t64} y`, TM.tagIndexOf([t64])), 'x ••• y', '딱 64자인 시리얼도 가린다');
  // 소문자로 바꾸면 길이가 달라지는 글자('İ' → 2글자)가 앞에 있어도 가리는 범위가 어긋나지 않는다
  assert.equal(TM.stripTags('İ ABCD1234 x', TM.tagIndexOf(['ABCD1234'])), 'İ ••• x');
  assert.equal(TM.replaceNeedles('x abc y', TM.needleIndexOf(['abc'], { min: 3 }), '(X)'), 'x (X) y', '딱 min 자인 항목은 색인에 든다');
  assert.equal(TM.replaceNeedles('abcdef', TM.needleIndexOf(['abcdef'], { max: 5 }), '(X)'), 'abcdef', 'max 를 넘는 항목은 색인에 없다');
  assert.equal(TM.needleIndexOf(['a'.repeat(256)]).set.size, 0, '기본 max = 255');
  assert.equal(TM.replaceNeedles('bmc idrac-main.mgmt.example', TM.needleIndexOf(['idrac-main.mgmt.example'], { min: 3 }), '(X)'), 'bmc (X)', '글 끝에 닿는 항목');
});

test('탐침 M02 · M03 · M04 · M27 · T26: 가림 재료 — host 없는 원격 서버의 id · 범위 밖 서버의 등록부 태그 · 인벤토리에서만 읽힌 태그 · 글 끝의 등록 주소', async () => {
  for (const user of [OP_ALL, OP_A]) {
    const v = await views(user, roomId);
    const low = v.all.toLowerCase();
    assert.ok(!low.includes('bmc-edge7'), `${user.username}: host 없는 원격 서버의 id(관리 주소)가 응답에 있다`);
    assert.ok(!low.includes('bmc-main'), `${user.username}: 글 끝에 닿는 등록 주소가 응답에 있다`);
    assert.equal(labelAt(v.room, 9), 'rear (주소 가림)');
  }
  const scoped = await views(OP_A, roomId);
  assert.equal(scoped.room.serialsHidden, true);
  assert.equal(labelAt(scoped.room, 1), 'spare-for-•••', '범위 밖(같은 법인 다른 vCenter) 서버의 등록부 태그');
  assert.equal(labelAt(scoped.room, 2), 'spare-for-•••', '등록부 태그 칸이 빈 서버 — 인벤토리에서 읽힌 태그');
  assert.ok(!scoped.ver.toLowerCase().includes('svx0099'), '판 목록 · 판 글 · 판 차이에도 등록부 태그가 없다');
  assert.ok(!scoped.ver.toLowerCase().includes('invt7788'));
  assert.ok(scoped.list.versions.some((x) => x.detail.includes('spare-for-•••')), '판 글은 통째로가 아니라 태그만 가린다');
  const adm = await views(ADMIN, roomId);
  assert.equal(labelAt(adm.room, 3), 'uplink bmc-edge7.mgmt.example rear', '관리자는 원문');
});

test('탐침 M14 · M15 · M21 · M22: 낱말 판정 — 문장 부호가 붙은 IPv6 · 대괄호 + 포트인 이름 · 여러 낱말 이름', async () => {
  const room = (await call('GET /tools/rack/room/:id', { user: OP_ALL, params: { id: roomId } })).body;
  const all = JSON.stringify(room).toLowerCase();
  for (const a of ['2001:db8::51', '2001:db8::52', '2001:db8::53', '2001:db8::10', '10.20.30.40']) assert.ok(!all.includes(a), `'${a}' 가 응답에 있다`);
  assert.ok(/^gw \S+ rear$/.test(labelAt(room, 4)) && /^gw \S+ rear$/.test(labelAt(room, 5)), `주소인 낱말만 가린다: ${labelAt(room, 4)} / ${labelAt(room, 5)}`);
  assert.ok(labelAt(room, 7).endsWith('(이름 가림)'), `낱말 하나인 주소(대괄호 + 포트)는 통째로 ‘이름 가림’: ${labelAt(room, 7)}`);
  const multi = labelAt(room, 8);
  assert.ok(multi.startsWith('core-sw ') && multi.endsWith(' uplink') && !multi.includes('이름 가림'), `여러 낱말 이름은 주소인 낱말만: ${multi}`);
});

test('탐침 M18 · M25 · D11: 시리얼 기록을 못 채운 원장 — 뺀 장비의 시리얼은 그 행 · 그 장비의 tags 로 가려진다(둘째 재료)', async () => {
  const db = await R.openRackDb();
  db.exec('DELETE FROM rack_serial_seen');   // 열 때 채우기(backfillSeen)가 실패한 원장 흉내 — 기록 없이도 행의 tags 가 있다
  const v = await views(OP_A, roomId);
  assert.ok(!v.all.toLowerCase().includes('gone4321'), '이력 · 판 목록 · 판 글 · 판 차이 어디에도 없다');
  assert.ok(v.room.logs.some((l) => l.detail.includes('stor-•••')), '이력 글은 태그만 가린다');
  const names = v.details.flatMap((d) => [...(d.changes?.items || []), ...(d.restore?.items || [])].map((i) => i.name));
  assert.ok(names.includes('stor-•••'), `판 차이 항목 이름도 그 장비의 시리얼로 가린다: ${names}`);
});

test('탐침 D03 · M23: tags 가 배열이 아닌 행은 ‘모른다’ — 시리얼을 가리는 판본에 통째로 · 시리얼이 보이는 판본에는 글 그대로', async () => {
  const db = await R.openRackDb();
  db.prepare("UPDATE rack_log SET tags = '{}' WHERE action LIKE 'place.%'").run();
  db.prepare("UPDATE rack_version SET tags = '{}' WHERE action LIKE 'place.%'").run();
  const scoped = (await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: roomId } })).body;
  assert.ok(scoped.logs.filter((l) => l.action.startsWith('place.')).length > 0);
  assert.ok(scoped.logs.filter((l) => l.action.startsWith('place.')).every((l) => l.detail === R.LEGACY_DETAIL_HIDDEN), '배열이 아닌 tags(JSON 객체)');
  const list = (await call('GET /tools/rack/versions', { user: OP_A, query: { corp: 'kr' } })).body;
  assert.ok(list.versions.filter((x) => x.action.startsWith('place.')).every((x) => x.detail === R.LEGACY_DETAIL_HIDDEN));
  // 시리얼이 보이는 판본(전체 범위 비관리자)은 옛 장비 글을 통째로 가리지 않는다(주소만 가린다)
  db.prepare("UPDATE rack_log SET tags = NULL WHERE action LIKE 'place.%'").run();
  db.prepare("UPDATE rack_version SET tags = NULL WHERE action LIKE 'place.%'").run();
  const full = (await call('GET /tools/rack/room/:id', { user: OP_ALL, params: { id: roomId } })).body;
  assert.equal(full.serialsHidden, false);
  assert.ok(!full.logs.some((l) => l.detail === R.LEGACY_DETAIL_HIDDEN), '시리얼을 보는 계정에게는 옛 장비 글이 보인다');
  assert.ok(full.logs.some((l) => l.detail.includes('stor-GONE4321')));
  const fullList = (await call('GET /tools/rack/versions', { user: OP_ALL, query: { corp: 'kr' } })).body;
  assert.ok(!fullList.versions.some((x) => x.detail === R.LEGACY_DETAIL_HIDDEN));
});

test('탐침 D16 · D18: 놓을 때 · 되돌릴 때의 시리얼도 법인 기록에 남는다 — 그 장비를 뺀 뒤에도 다른 장비 이름 속 그 시리얼이 가려진다', async () => {
  rev = (await R.getRoom(roomId)).room.rev;
  const a = await put({ uStart: 20, kind: 'storage', label: 'stor-keep', serial: 'KEEP-5566' });
  await put({ uStart: 21, label: 'pair-of-KEEP5566' });
  const withA = (await R.listVersions('kr'))[0].id;   // A · B 가 둘 다 있는 판
  let rm = await op({ op: 'place.remove', id: a, rev }); assert.equal(rm.statusCode, 200); rev = rm.body.rev;
  const labelB = async () => labelAt((await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: roomId } })).body, 21);
  assert.equal(await labelB(), 'pair-of-•••', '놓을 때 넣은 시리얼');
  // 되돌리기: 기록이 빈 원장(열 때 채우기 실패 흉내)에서 A 가 든 판으로 되돌린 뒤 A 를 다시 뺀다
  const db = await R.openRackDb();
  db.exec('DELETE FROM rack_serial_seen');
  await R.restoreVersion({ corpId: 'kr', versionId: withA, expectLatestId: (await R.listVersions('kr'))[0].id, user: 'admin' });
  const room = await R.getRoom(roomId);
  const a2 = room.places.find((p) => p.uStart === 20);
  assert.ok(a2, '되돌려 다시 놓였다');
  rm = await op({ op: 'place.remove', id: a2.id, rev: room.room.rev }); assert.equal(rm.statusCode, 200); rev = rm.body.rev;
  assert.equal(await labelB(), 'pair-of-•••', '되돌려 다시 놓인 장비의 시리얼');
});

test('탐침 D20: 판이 하나도 없던 옛 원장 — 열 때 지금 원장의 시리얼로 법인 기록을 채운다', async () => {
  let db = await R.openRackDb();
  const p = await op({ op: 'place.add', rackId, rev, place: { face: 'full', uStart: 30, uSize: 1, kind: 'storage', label: 'old', serial: 'OLD-0001' } });
  assert.equal(p.statusCode, 200, JSON.stringify(p.body)); rev = p.body.rev;
  db.exec('DELETE FROM rack_version'); db.exec('DELETE FROM rack_serial_seen'); db.exec("DELETE FROM rack_meta WHERE k = 'seenKeys'");
  R._closeForTest();
  db = await R.openRackDb();
  assert.ok((await R.corpSerials('kr')).includes('old0001'), '지금 원장 시리얼의 비교 키가 기록에 있다');
});

test('탐침 L01: 이름 가운데의 줄 · 문단 분리 문자(U+2028 · U+2029)도 정리된다(앞뒤 끝은 trim 이 지워 기존 테스트가 구분하지 못했다)', async () => {
  const L = await import(`${S}/rack/layout.js`);
  const out = L.cleanText('A\u20281\u2029B', 32);
  assert.ok(!/[\u2028\u2029]/.test(out), JSON.stringify(out));
  assert.equal(out.replace(/ /g, ''), 'A1B');
});

test.after(() => R._closeForTest());
