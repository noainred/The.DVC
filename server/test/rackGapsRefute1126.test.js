// 랙 실장도 1회차 반증(2026-11-26) 회귀 — 1회차 수정이 덜 닫았거나 새로 만든 것:
//   B-2 글이 쓰인 뒤에 넣은 시리얼(놓을 때는 빈칸)도 옛 글에서 가려진다(법인별 시리얼 기록 rack_serial_seen)
//   B-3 색인을 트랜잭션 안에서 다시 채운 쓰기가 ROLLBACK 되면 준비 표식도 되돌린다(같은 시리얼이 둘째 시도에 통과하지 않는다)
//   C-1 색인 다시 채우기 중 SQLite 가 쓰기 트랜잭션 전체를 되돌린 오류면 쓰기를 멈춘다(변경이 트랜잭션 밖에서 확정되지 않는다)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackrefute-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db');
// 자기 점검은 끈다 — 색인을 일부러 깨뜨린 상태를 다룬다(켜면 점검이 먼저 던진다).
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
const P = (uStart, label, extra = {}) => ({ face: 'full', uStart, uSize: 1, kind: 'other', label, serial: '', extraSerials: [], ...extra });

let roomId; let rackId;
const rev = async () => (await R.getRoom(roomId)).room.rev;
test('준비', async () => {
  const s = (await op({ op: 'site.add', corpId: 'kr', name: 'S' })).body.id;
  roomId = (await op({ op: 'room.add', siteId: s, name: 'R' })).body.id;
  rackId = (await op({ op: 'rack.add', roomId, rev: 0, rack: { name: 'A1', heightU: 42 } })).body.id;
});

test('B-2: 놓을 때는 시리얼이 빈칸이던 장비 — 나중에 넣은 시리얼도 옛 글(놓기 줄)에서 가려진다', async () => {
  const p = await op({ op: 'place.add', rackId, rev: await rev(), place: P(21, 'stor-LATE7777', { kind: 'storage' }) });
  assert.equal(p.statusCode, 200);
  const u = await op({ op: 'place.update', id: p.body.id, rev: p.body.rev, place: { serial: 'LATE7777' } });
  assert.equal(u.statusCode, 200);
  const rm = await op({ op: 'place.remove', id: p.body.id, rev: u.body.rev });
  assert.equal(rm.statusCode, 200);
  const room = (await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: roomId } })).body;
  const list = (await call('GET /tools/rack/versions', { user: OP_A, query: { corp: 'kr' } })).body;
  const texts = [...room.logs.map((l) => l.detail), ...list.versions.map((v) => v.detail)];
  for (const v of list.versions) {
    const d = (await call('GET /tools/rack/versions/:vid', { user: OP_A, params: { vid: String(v.id) }, query: { corp: 'kr' } })).body;
    texts.push(d.version.detail, ...[...(d.changes?.items || []), ...(d.restore?.items || [])].map((i) => i.name));
  }
  assert.equal(room.serialsHidden, true);
  assert.ok(!texts.some((t) => /late7777/i.test(String(t))), JSON.stringify(texts.filter((t) => /late/i.test(String(t)))));
  assert.ok(texts.some((t) => String(t).includes('stor-•••')));
  // 되돌려 다시 놓인 장비의 시리얼도 기록에 든다(되돌리기 경로)
  const db = await R.openRackDb();
  assert.ok(db.prepare("SELECT 1 AS x FROM rack_serial_seen WHERE corp_id = 'kr' AND key = 'late7777'").get());
  assert.ok(!(await R.corpSerials('pl')).includes('late7777'), '법인별로 따로');
});

test('B-2: 기록이 없던 원장(업그레이드 전)은 열 때 한 번 채운다 — 지금 원장 + 남은 판의 시리얼', async () => {
  let db = await R.openRackDb();
  await op({ op: 'place.add', rackId, rev: await rev(), place: P(22, 'now', { serial: 'NOW-0001' }) });
  db.exec('DELETE FROM rack_serial_seen'); db.exec("DELETE FROM rack_meta WHERE k = 'seenKeys'");
  R._closeForTest();
  db = await R.openRackDb();
  const keys = db.prepare("SELECT key FROM rack_serial_seen WHERE corp_id = 'kr'").all().map((r) => r.key);
  assert.ok(keys.includes('now0001'), '지금 원장');
  assert.ok(keys.includes('late7777'), '남아 있는 판(지금 원장에는 없는 장비)');
  assert.equal(db.prepare("SELECT v FROM rack_meta WHERE k = 'seenKeys'").get().v, 1);
});

test('B-3: 색인을 못 채운 핸들 — 첫 쓰기가 색인을 다시 채운 뒤 거절(ROLLBACK)돼도 둘째 시도가 통과하지 않는다', async () => {
  let db = await R.openRackDb();
  await op({ op: 'place.add', rackId, rev: await rev(), place: P(1, 'srv-1', { kind: 'server', serial: 'TAG-0001' }) });
  await op({ op: 'place.add', rackId, rev: await rev(), place: P(2, 'srv-2', { kind: 'server', serial: 'TAG-0002' }) });
  // 열 때 색인 채우기가 실패한 상황을 만든다(잠금 · 디스크 오류 흉내) — 그 뒤 원인은 사라진다
  db.exec('DELETE FROM rack_place_key'); db.exec("DELETE FROM rack_meta WHERE k = 'placeKeys'");
  db.exec("CREATE TRIGGER k_fail BEFORE INSERT ON rack_place_key BEGIN SELECT RAISE(ABORT, 'probe'); END;");
  R._closeForTest();
  const warn = console.warn; console.warn = () => {};
  try { db = await R.openRackDb(); } finally { console.warn = warn; }
  db.exec('DROP TRIGGER k_fail');
  const tryDup = async () => op({ op: 'place.add', rackId, rev: await rev(), place: P(5, 'dup', { serial: 'tag 0001' }) });
  const a = await tryDup(); assert.equal(a.statusCode, 409); assert.equal(a.body.code, 'serialDup');
  const b = await tryDup(); assert.equal(b.statusCode, 409, '둘째 시도도 거절(예전엔 준비 표식만 남아 빈 색인을 믿고 통과했다)'); assert.equal(b.body.code, 'serialDup');
  assert.deepEqual([...(await R.placedSerialKeys('kr'))].filter((k) => k.startsWith('tag')).sort(), ['tag0001', 'tag0002']);
  // 성공하는 쓰기 뒤에는 색인이 원장과 맞는다
  const ok = await op({ op: 'place.add', rackId, rev: await rev(), place: P(6, 'srv-3', { kind: 'server', serial: 'TAG-0003' }) });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(db.prepare("SELECT key FROM rack_place_key WHERE key LIKE 'tag%' ORDER BY key").all().map((r) => r.key), ['tag0001', 'tag0002', 'tag0003']);
});

test('C-1: 색인 다시 채우기 중 쓰기 트랜잭션 전체가 되돌려지면(디스크 가득 · I/O 오류 흉내) 그 쓰기를 멈춘다 — 원장 · rev · 판 · 이력 무변화', async () => {
  let db = await R.openRackDb();
  db.exec('DELETE FROM rack_place_key'); db.exec("DELETE FROM rack_meta WHERE k = 'placeKeys'");
  db.exec("CREATE TRIGGER k_fail BEFORE INSERT ON rack_place_key BEGIN SELECT RAISE(ABORT, 'probe'); END;");
  R._closeForTest();
  const warn = console.warn; const err = console.error; console.warn = () => {}; console.error = () => {};
  try {
    db = await R.openRackDb();
    db.exec('DROP TRIGGER k_fail');
    db.exec("CREATE TRIGGER k_fail BEFORE INSERT ON rack_place_key BEGIN SELECT RAISE(ROLLBACK, 'disk full'); END;");
    const count = () => ({
      places: db.prepare('SELECT COUNT(*) AS n FROM rack_place').get().n, rev: db.prepare('SELECT rev FROM rack_room WHERE id = ?').get(roomId).rev,
      versions: db.prepare('SELECT COUNT(*) AS n FROM rack_version').get().n, logs: db.prepare('SELECT COUNT(*) AS n FROM rack_log').get().n,
    });
    const before = count();
    const r = await op({ op: 'place.add', rackId, rev: before.rev, place: P(30, 'c1', { serial: 'C1-SERIAL' }) });
    assert.ok(r.statusCode >= 500, `쓰기는 실패로 답한다(${r.statusCode})`);
    assert.deepEqual(count(), before, '아무것도 확정되지 않았다');
    db.exec('DROP TRIGGER k_fail');
    const ok = await op({ op: 'place.add', rackId, rev: before.rev, place: P(30, 'c1', { serial: 'C1-SERIAL' }) });
    assert.equal(ok.statusCode, 200, '원인이 사라지면 같은 쓰기가 된다');
    assert.ok(db.prepare("SELECT 1 AS x FROM rack_place_key WHERE key = 'c1serial'").get(), '색인도 다시 채워졌다');
  } finally { console.warn = warn; console.error = err; try { db.exec('DROP TRIGGER IF EXISTS k_fail'); } catch { /* */ } }
});

test.after(() => R._closeForTest());
