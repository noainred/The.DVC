// 랙 실장도 2회차 점검(2026-11-26 · 1회차 뒤 들어온 코드의 변이 70건 중 살아남은 10건을 막는 테스트 — 테스트 이름의 번호가 그 변이).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackprobe2-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp;
process.env.RACK_DB = path.join(tmp, 'rack.db');
process.env.RACK_SELF_CHECK = '1';

const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const L = await import(`${S}/rack/layout.js`);
const TM = await import(`${S}/rack/textMask.js`);
const registry = await import(`${S}/idrac/registry.js`);
const audit = await import(`${S}/audit.js`);

const routes = new Map();
RT.registerRack({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
async function call(key, { user, params = {}, query = {}, body = {} }) {
  const res = { statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; },
    setHeader(k, v) { this.headers[k] = v; }, end(b) { this.raw = b; return this; } };
  const req = { user, params, query, body, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0], originalUrl: `/api${key.replace(/^\w+ /, '')}` };
  for (const h of routes.get(key)) { let n = false; await h(req, res, () => { n = true; }); if (!n) break; }
  return res;
}
const U = (name, role, vcenters = [], writeVcenters = []) => ({ username: name, role, scope: { vcenters, regions: [], writeVcenters } });
const ADMIN = U('admin', 'admin'); const OP_A = U('op-a', 'operator', ['vc-a']); const OP_ALL = U('op', 'operator');
const { TAG_MASK_MIN } = await import(`${S}/util/ruleName.js`);
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: ['vc-a'].map((id) => ({ id, name: id, status: 'ok' })), hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr');
const op = (user, body) => call('POST /tools/rack/op', { user, body });
const rev = async (roomId) => (await R.getRoom(roomId)).room.rev;
const room = async (user, id) => (await call('GET /tools/rack/room/:id', { user, params: { id } })).body;
const versions = async (user) => (await call('GET /tools/rack/versions', { user, query: { corp: 'kr' } })).body.versions;
const vdetail = async (user, vid) => (await call('GET /tools/rack/versions/:vid', { user, params: { vid: String(vid) }, query: { corp: 'kr' } })).body;

let kr;
test('준비', async () => {
  const s1 = (await op(ADMIN, { op: 'site.add', corpId: 'kr', name: 'KR-1' })).body.id;
  const r1 = (await op(ADMIN, { op: 'room.add', siteId: s1, name: 'R1' })).body.id;
  const a1 = (await op(ADMIN, { op: 'rack.add', roomId: r1, rev: 0, rack: { name: 'A1', heightU: 42 } })).body.id;
  const b1 = (await op(ADMIN, { op: 'rack.add', roomId: r1, rev: await rev(r1), rack: { name: 'B1', heightU: 42 } })).body.id;
  kr = { s1, r1, a1, b1 };
  registry.importServers([{ id: 's-a', name: 'kr-esx-a', host: 'https://192.0.2.80', username: 'root', password: 'x', serviceTag: 'REGTAG01', vcenterId: 'vc-a' }], 'replace');
});
const place = async (p) => { const r = await op(ADMIN, { op: 'place.add', rackId: kr.a1, rev: await rev(kr.r1), place: { face: 'full', uSize: 1, kind: 'other', ...p } }); assert.equal(r.statusCode, 200, JSON.stringify(r.body)); return r.body.id; };
const remove = async (id) => { const r = await op(ADMIN, { op: 'place.remove', id, rev: await rev(kr.r1) }); assert.equal(r.statusCode, 200, JSON.stringify(r.body)); };
const update = async (id, p) => { const r = await op(ADMIN, { op: 'place.update', id, rev: await rev(kr.r1), place: p }); assert.equal(r.statusCode, 200, JSON.stringify(r.body)); return r.body; };

test('탐침 N01 · N08: 한 칸만 바꾼 저장은 버리지 않는다 — 랙 이름만 · 장비의 랙만(같은 U 로 옆 랙에)', async () => {
  let rv = await rev(kr.r1);
  const r = await R.updateRack({ roomId: kr.r1, rev: rv, user: 'a', id: kr.a1, input: { name: 'A1-새이름' } });
  assert.ok(!r.unchanged && r.rev === rv + 1, `N01 랙 이름만 바꿔도 저장된다: ${JSON.stringify(r)}`);
  assert.equal((await R.getRoom(kr.r1)).racks.find((x) => x.id === kr.a1).name, 'A1-새이름', 'N01 랙 이름 저장');
  const pid = await place({ uStart: 1, label: 'mv' });
  rv = await rev(kr.r1);
  const m = await R.updatePlace({ roomId: kr.r1, rev: rv, user: 'a', id: pid, rackId: kr.b1, input: {} });
  assert.ok(!m.unchanged && m.rev === rv + 1, `N08 같은 U 로 옆 랙에 옮겨도 저장된다: ${JSON.stringify(m)}`);
  assert.equal((await R.getRoom(kr.r1)).places.find((x) => x.id === pid).rackId, kr.b1, 'N08 옮긴 랙 저장');
});

test('탐침 A3(· A2 · A4 형제 경로): 바뀐 것 없는 랙 · 장비 · 전산실 저장은 감사에 남기지 않는다(라우트)', async () => {
  const pid = await place({ uStart: 3, label: 'aud', model: 'M' });
  const n = (a) => audit.auditEntriesWithAction(a).length;
  const before = { rack: n('rack.rack.update'), place: n('rack.place.update'), roomName: n('rack.room.rename'), rev: await rev(kr.r1) };
  const r1 = await op(ADMIN, { op: 'rack.update', id: kr.b1, rev: before.rev, rack: { name: 'B1', heightU: 42 } });
  assert.equal(r1.statusCode, 200, JSON.stringify(r1.body)); assert.equal(r1.body.unchanged, true);
  const r2 = await op(ADMIN, { op: 'place.update', id: pid, rev: before.rev, place: { label: 'aud', model: 'M' } });
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.body)); assert.equal(r2.body.unchanged, true);
  const r3 = await op(ADMIN, { op: 'room.rename', id: kr.r1, name: 'R1' });
  assert.equal(r3.statusCode, 200, JSON.stringify(r3.body)); assert.equal(r3.body.unchanged, true);
  assert.deepEqual({ rack: n('rack.rack.update'), place: n('rack.place.update'), roomName: n('rack.room.rename'), rev: await rev(kr.r1) }, before, '감사 · rev 가 늘지 않는다');
  // 실제로 바꾼 저장은 남는다(감사를 통째로 끈 것이 아니다)
  const r4 = await op(ADMIN, { op: 'rack.update', id: kr.b1, rev: before.rev, rack: { name: 'B1', heightU: 42, role: 'net' } });
  assert.equal(r4.statusCode, 200, JSON.stringify(r4.body));
  assert.equal(n('rack.rack.update'), before.rack + 1);
});

test('탐침 N61 · N43 · N58 · N38: 원장에서 빠진 시리얼이 범위 비관리자의 이력 · 판 목록에 남지 않는다 — 추가 시리얼 · 구분자가 든 시리얼 · 고치기 전 시리얼 · 깨진 tags', async () => {
  const chassis = await place({ uStart: 10, label: 'ch-NODESER55', serial: 'MAINSER55', extraSerials: ['NODESER55'] });   // 이름에 든 것은 추가(노드) 시리얼
  const dashed = await place({ uStart: 11, label: 'sw-AB-CD-9876', serial: 'AB-CD-9876' });                               // 구분자가 든 시리얼 원문 그대로인 이름
  const keep = await place({ uStart: 12, label: 'keep-OLDSER4242', serial: 'OLDSER4242' });
  await update(keep, { serial: 'NEWSER4343' });      // 시리얼만 바꾼다 — 이 글('keep-OLDSER4242 정보 수정')에는 고치기 전 시리얼이 들어 있다
  await update(keep, { label: 'keep-renamed' });     // 관리자가 표시 이름을 고쳤다 — 이제 OLDSER4242 는 원장 어디에도 없다
  await remove(chassis); await remove(dashed);
  const logs = (await room(OP_A, kr.r1)).logs; const list = await versions(OP_A);
  for (const [where, rows] of [['이력', logs], ['판 목록', list]]) {
    const t = rows.map((x) => x.detail).join('\n').toLowerCase();
    assert.ok(!t.includes('nodeser55'), `N61 ${where}: 뺀 장비의 추가 시리얼 — ${t}`);
    assert.ok(!t.includes('ab-cd-9876') && !t.includes('abcd9876'), `N43 ${where}: 구분자가 든 시리얼 원문 — ${t}`);
    assert.ok(!t.includes('oldser4242'), `N58 ${where}: 고치기 전 시리얼 — ${t}`);
    assert.ok(rows.some((x) => x.detail.includes('ch-•••')) && rows.some((x) => x.detail.includes('sw-•••')) && rows.some((x) => x.detail.includes('keep-•••')), `${where}: 이름의 나머지는 남는다`);
  }
  for (const v of list.filter((x) => x.action.startsWith('place.'))) {
    const d = await vdetail(OP_A, v.id);
    assert.ok(!/nodeser55|ab-cd-9876|oldser4242/i.test(String(d.version?.detail)), `판 #${v.id} 글: ${d.version?.detail}`);
  }
  assert.ok((await room(ADMIN, kr.r1)).logs.some((l) => l.detail.includes('sw-AB-CD-9876')), '관리자는 원문');
  // tags 칸이 깨진 행: 어떤 시리얼이 들었는지 알 수 없다 — 장비 글은 통째로 가리고, 장비 글이 아닌 행은 그대로
  const db = await R.openRackDb();
  db.prepare("UPDATE rack_log SET tags = '{깨진' WHERE room_id = ?").run(kr.r1);
  db.prepare("UPDATE rack_version SET tags = '{깨진' WHERE corp_id = 'kr'").run();
  await R.updateRack({ roomId: kr.r1, rev: await rev(kr.r1), user: 'a', id: kr.b1, input: { row: 'Z' } });   // 새 판을 하나 만든다 — SQL 로 직접 고친 tags 가 판 상세 캐시(최신 판 id 키)에 가리지 않게
  const logs2 = (await room(OP_A, kr.r1)).logs; const list2 = await versions(OP_A);
  for (const [where, rows] of [['이력', logs2], ['판 목록', list2]]) {
    assert.ok(rows.filter((x) => x.action.startsWith('place.')).length > 0 && rows.filter((x) => x.action.startsWith('place.')).every((x) => x.detail === R.LEGACY_DETAIL_HIDDEN), `N38 ${where}: 깨진 tags 의 장비 글은 통째로 가린다 — ${JSON.stringify(rows.map((x) => x.detail))}`);
    assert.ok(rows.some((x) => x.action === 'rack.add' && x.detail.includes('B1')), `${where}: 장비 글이 아닌 행은 그대로`);
  }
  const d2 = await vdetail(OP_A, list2.find((x) => x.action.startsWith('place.')).id);
  assert.equal(d2.version.detail, R.LEGACY_DETAIL_HIDDEN, 'N38 판 글');
  assert.ok((await room(ADMIN, kr.r1)).logs.some((l) => l.detail.includes('sw-AB-CD-9876')), '관리자는 깨진 tags 행도 원문');
});

test('탐침 M12: 판 목록 · 판 글 — 다른 장비의 시리얼(지금 원장에 있는)이 든 표시 이름도 범위 비관리자에게 가린다', async () => {
  await place({ uStart: 20, label: 'yy', serial: 'CROSSSER77' });
  const x = await place({ uStart: 21, label: 'spare-CROSSSER77', serial: 'XSERIAL2288' });   // 이 장비의 시리얼이 아닌, 옆 장비의 시리얼이 이름에 들었다
  const v = await room(OP_A, kr.r1);
  assert.equal(v.places.find((p) => p.id === x).label, 'spare-•••', '전산실 화면의 표시 이름(기준)');
  const list = await versions(OP_A);
  assert.ok(!list.map((r) => r.detail).join('\n').toLowerCase().includes('crossser77'), `판 목록: ${JSON.stringify(list.slice(0, 3).map((r) => r.detail))}`);
  const d = await vdetail(OP_A, list[0].id);
  assert.ok(!JSON.stringify(d).toLowerCase().includes('crossser77'), `판 상세: ${JSON.stringify(d.version)}`);
  assert.ok((await versions(ADMIN))[0].detail.includes('spare-CROSSSER77'), '관리자는 원문');
});

test('탐침 M01: 통째로 주소인 표시 이름 — IPv4 는 ‘이름 가림’ · 등록부에 없는 IPv6 리터럴도 비관리자에게 나가지 않는다', async () => {
  const v4 = await place({ uStart: 30, label: '10.9.8.7' });
  const v6 = await place({ uStart: 31, label: 'fe80::1ff:fe23:4567:890a' });
  for (const user of [OP_A, OP_ALL]) {
    const v = await room(user, kr.r1);
    const l4 = v.places.find((p) => p.id === v4).label; const l6 = v.places.find((p) => p.id === v6).label;
    assert.ok(!l4.includes('10.9.8.7') && l4.includes('이름 가림'), `${user.username} IPv4 이름: ${l4}`);
    assert.ok(!l6.toLowerCase().includes('fe23:4567') && l6.includes('이름 가림'), `${user.username} IPv6 이름: ${l6}`);
  }
  assert.equal((await room(ADMIN, kr.r1)).places.find((p) => p.id === v6).label, 'fe80::1ff:fe23:4567:890a', '관리자는 원문');
});

test('탐침 T01: 태그 최소 길이 경계 — 딱 TAG_MASK_MIN 자인 태그는 가리고, 한 글자 짧으면 가리지 않는다', () => {
  const at = 'zq9x7w5v3k'.slice(0, TAG_MASK_MIN); const under = at.slice(0, -1);
  assert.equal(TM.stripTags(`a-${at}-b`, TM.tagIndexOf([at])), 'a-•••-b');
  assert.equal(TM.stripTags(`a-${under}-b`, TM.tagIndexOf([under])), `a-${under}-b`);
});

test.after(() => R._closeForTest());
