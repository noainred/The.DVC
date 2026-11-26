// 랙 실장도 1회차 점검(2026-11-26 · 살아남은 변이를 막는 테스트 — 테스트 이름의 번호가 그 변이) — rack/db.js 의 테스트 공백(조각 캐시 사용 · _pending 복원 · 자기 점검 · 색인 다시 채우기 · 중복 검사 ·
//   이력 정리 · 되돌리기 왕복 · 기준 판 · 미리 보기 캐시).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackprobe-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp;
process.env.RACK_DB = path.join(tmp, 'rack.db');
process.env.RACK_SELF_CHECK = '1';

const R = await import('../src/rack/db.js');
const V = await import('../src/rack/versions.js');

const rev = async (roomId) => (await R.getRoom(roomId)).room.rev;
const P = (uStart, label, extra = {}) => ({ face: 'full', uStart, uSize: 1, kind: 'other', label, serial: '', extraSerials: [], ...extra });
const unpack = (blob) => JSON.parse(zlib.gunzipSync(Buffer.from(blob)).toString('utf8'));
async function latestSnap(corpId) {
  const db = await R.openRackDb();
  return unpack(db.prepare('SELECT data FROM rack_version WHERE corp_id = ? ORDER BY id DESC LIMIT 1').get(corpId).data);
}
async function ledgerSnap(corpId) {
  const db = await R.openRackDb();
  const sites = db.prepare('SELECT id, name, sort FROM rack_site WHERE corp_id = ?').all(corpId);
  const rooms = []; const racks = []; const places = [];
  for (const s of sites) for (const m of db.prepare('SELECT * FROM rack_room WHERE site_id = ?').all(s.id)) {
    rooms.push({ id: m.id, siteId: m.site_id, name: m.name, sort: m.sort });
    const v = await R.getRoom(m.id);
    racks.push(...v.racks); places.push(...v.places);
  }
  return V.buildSnapshot(corpId, { sites, rooms, racks, places });
}
const add = async (roomId, rackId, input) => R.addPlace({ roomId, rev: await rev(roomId), user: 'a', rackId, input });

/** 전산실 조각(판 재료)을 원장에서 다시 읽은 횟수 — roomFrag 의 장비 조회 문장만 센다(getRoom 은 ORDER BY 가 붙어 다른 문장). */
const FRAG_SQL = 'SELECT p.* FROM rack_place p JOIN rack_rack r ON r.id = p.rack_id WHERE r.room_id = ?';
function spyFragReads(db) {
  const orig = db.prepare.bind(db);
  const reads = [];
  db.prepare = (sql) => {
    const st = orig(sql);
    if (sql !== FRAG_SQL) return st;
    return { all: (...a) => { reads.push(a[0]); return st.all(...a); } };
  };
  return { reads, restore: () => { delete db.prepare; } };
}

let c1;
test('준비: 법인 c1(전산실 A · B) · c2(전산실 C)', async () => {
  const s = (await R.addSite({ corpId: 'c1', name: 'S1', user: 'a' })).id;
  const a = (await R.addRoom({ siteId: s, name: 'A', user: 'a' })).id;
  const b = (await R.addRoom({ siteId: s, name: 'B', user: 'a' })).id;
  const ra = (await R.addRack({ roomId: a, rev: 0, user: 'a', input: { name: 'A1', heightU: 42 } })).id;
  const rb = (await R.addRack({ roomId: b, rev: 0, user: 'a', input: { name: 'B1', heightU: 42 } })).id;
  await add(a, ra, P(1, 'a-1')); await add(b, rb, P(1, 'b-1'));
  const s2 = (await R.addSite({ corpId: 'c2', name: 'S2', user: 'a' })).id;
  const c = (await R.addRoom({ siteId: s2, name: 'C', user: 'a' })).id;
  const rc = (await R.addRack({ roomId: c, rev: 0, user: 'a', input: { name: 'C1', heightU: 42 } })).id;
  c1 = { s, a, b, ra, rb, s2, c, rc };
});

test('탐침 D02 · D04 · D07 · D16: 바뀌지 않은 전산실은 다시 읽지 않는다(조각 캐시가 실제로 쓰인다)', async () => {
  const db = await R.openRackDb();
  const spy = spyFragReads(db);
  try {
    await add(c1.a, c1.ra, P(2, 'a-2'));
    await add(c1.a, c1.ra, P(3, 'a-3'));
    await R.renameSite({ id: c1.s, name: 'S1b', user: 'a' });
    assert.deepEqual(spy.reads, [c1.a, c1.a], '전산실 A 쓰기 두 번 = A 만 두 번 읽는다(B 는 캐시에서 · 데이터센터 이름 변경은 0번)');
    spy.reads.length = 0;
    const l = await R.listVersions('c1');
    await R.versionDetail('c1', l[1].id);   // 읽기 경로(트랜잭션 밖)도 캐시에서
    assert.deepEqual(spy.reads, [], '미리 보기는 조각을 다시 읽지 않는다');
  } finally { spy.restore(); }
});

test('탐침 D15: ROLLBACK 된 조각이 트랜잭션 밖 읽기(되돌리기 미리 보기)에 섞이지 않는다', async () => {
  const db = await R.openRackDb();
  const before = await rev(c1.a);
  db.exec("CREATE TRIGGER rl_fail BEFORE INSERT ON rack_log BEGIN SELECT RAISE(ABORT, 'probe'); END;");
  try { await assert.rejects(R.addPlace({ roomId: c1.a, rev: before, user: 'a', rackId: c1.ra, input: P(20, 'ghost') })); } finally { db.exec('DROP TRIGGER rl_fail'); }
  await R.addPlace({ roomId: c1.a, rev: before, user: 'a', rackId: c1.ra, input: P(21, 'real') });   // 같은 rev 에서 다른 내용
  const l = await R.listVersions('c1');
  const d = await R.versionDetail('c1', l[0].id);   // 최신 판 = 지금 원장 → 되돌리면 바뀌는 것 0건이어야 한다
  assert.equal(d.restore.items.length, 0, JSON.stringify(d.restore.items));
  const prev = await R.versionDetail('c1', l[1].id);
  assert.deepEqual(prev.restore.items.map((i) => `${i.op}:${i.name}`), ['remove:real'], '앞 판으로 되돌리면 real 만 빠진다(ghost 는 원장에 없다)');
});

test('탐침 D14: 핸들을 다시 연 직후의 읽기도 앞 핸들의 조각을 쓰지 않는다(쓰기 전에 미리 보기부터)', async () => {
  let db = await R.openRackDb();
  await add(c1.a, c1.ra, P(25, 'will-vanish'));   // 마지막 트랜잭션이 전산실 A 조각을 새로 읽는다
  const victim = db.prepare("SELECT id FROM rack_place WHERE label = 'will-vanish'").get().id;
  R._closeForTest();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(process.env.RACK_DB);
  raw.prepare('DELETE FROM rack_place WHERE id = ?').run(victim); raw.close();   // 닫힌 사이 밖에서 바뀐 원장(rev 그대로)
  db = await R.openRackDb();
  const l = await R.listVersions('c1');
  const d = await R.versionDetail('c1', l[0].id);
  assert.deepEqual(d.restore.items.map((i) => `${i.op}:${i.name}`), ['add:will-vanish'], '지금 원장에는 없으므로 되돌리면 생긴다');
  await R.renameSite({ id: c1.s, name: 'S1c', user: 'a' });   // 판을 지금 원장에 맞춘다
});

test('탐침 D12 · D13: 자기 점검은 캐시로 만든 판이 원장과 다르면 던진다(랙 테스트 전부가 이 점검에 기댄다)', async () => {
  const db = await R.openRackDb();
  db.prepare("UPDATE rack_place SET label = 'tampered' WHERE label = 'b-1'").run();   // 전산실 B — rev 를 올리지 않은 변경
  const before = await rev(c1.a);
  await assert.rejects(R.addPlace({ roomId: c1.a, rev: before, user: 'a', rackId: c1.ra, input: P(30, 'x') }), /자기 점검/);
  assert.equal(await rev(c1.a), before, '던지면 쓰기도 취소');
  await R._resyncForTest();
  assert.ok((await add(c1.a, c1.ra, P(30, 'x'))).id, '원장에 맞춘 뒤에는 쓸 수 있다');
});

test('탐침 D29: 자기 점검은 시리얼 키 색인의 중복 판정이 원장과 다르면 던진다', async () => {
  const db = await R.openRackDb();
  const p = await add(c1.a, c1.ra, P(31, 'sc', { serial: 'SC-0001' }));
  db.prepare('DELETE FROM rack_place_key WHERE place_id = ?').run(p.id);   // 색인만 낡게
  await assert.rejects(add(c1.b, c1.rb, P(31, 'dup', { serial: 'sc0001' })), /자기 점검/);
  await R._resyncForTest();
  await assert.rejects(add(c1.b, c1.rb, P(31, 'dup', { serial: 'sc0001' })), (e) => e.extra?.code === 'serialDup');
});

test('탐침 D27 · D30 · D31: 중복 검사 — 둘째 키(추가 시리얼)도 조회 · 겹친 장비 id · 추가 시리얼만 고쳐도 검사', async () => {
  const have = await add(c1.a, c1.ra, P(32, 'have', { serial: 'HAVE-1' }));
  // 주 시리얼은 새것, 추가 시리얼이 기존 장비와 같다 — 키 집합의 **둘째** 키가 겹친다
  await assert.rejects(add(c1.b, c1.rb, P(32, 'new', { serial: 'BRAND-NEW', extraSerials: ['have1'] })),
    (e) => e.status === 409 && e.extra?.code === 'serialDup' && e.extra.withId === have.id);
  const other = await add(c1.b, c1.rb, P(33, 'other', { serial: 'OTHER-1' }));
  await assert.rejects(R.updatePlace({ roomId: c1.b, rev: other.rev, user: 'a', id: other.id, input: { extraSerials: ['HAVE-1'] } }), (e) => e.extra?.code === 'serialDup');
  assert.deepEqual((await R.getRoom(c1.b)).places.find((x) => x.id === other.id).extraSerials, []);
});

test('탐침 D22 · D24: 색인 다시 채우기 — 추가 시리얼만 있는 장비도 · 낡은 행은 비우고', async () => {
  let db = await R.openRackDb();
  const x = await add(c1.a, c1.ra, P(34, 'chassis', { serial: '', extraSerials: ['ONLY-EX1', 'ONLY-EX2'] }));
  db.exec('DELETE FROM rack_place_key'); db.exec("DELETE FROM rack_meta WHERE k = 'placeKeys'");
  R._closeForTest(); db = await R.openRackDb();
  assert.deepEqual(db.prepare('SELECT key FROM rack_place_key WHERE place_id = ? ORDER BY key').all(x.id).map((r) => r.key), ['onlyex1', 'onlyex2'], 'D22');
  await assert.rejects(add(c1.b, c1.rb, P(34, 'dup', { serial: 'only-ex2' })), (e) => e.extra?.code === 'serialDup');
  // 낡은 행(없는 장비의 키)이 남은 채 표식만 지워진 원장 — 다시 채울 때 비운다
  db.prepare("INSERT INTO rack_place_key (key, place_id) VALUES ('ghostkey', '0000000000000000')").run();
  db.exec("DELETE FROM rack_meta WHERE k = 'placeKeys'");
  R._closeForTest(); db = await R.openRackDb();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rack_place_key WHERE key = 'ghostkey'").get().n, 0, 'D24');
  assert.ok((await R.placedSerialKeys('c1')).has('onlyex1'));
});

test('탐침 D38 · D39 · D91: 전산실 이력은 2,000건까지 · 다른 전산실 이력은 건드리지 않는다 · 조회는 기본 100건(최대 500)', async () => {
  const db = await R.openRackDb();
  const nB = db.prepare('SELECT COUNT(*) AS n FROM rack_log WHERE room_id = ?').get(c1.b).n;
  assert.ok(nB >= 3);
  const ins = db.prepare("INSERT INTO rack_log (ts,user,corp_id,room_id,action,detail) VALUES (0,'x','c1',?,'place.update','x')");
  db.exec('BEGIN'); for (let i = 0; i < 2100; i += 1) ins.run(c1.a); db.exec('COMMIT');
  await add(c1.a, c1.ra, P(35, 'trim'));
  const nA = db.prepare('SELECT COUNT(*) AS n FROM rack_log WHERE room_id = ?').get(c1.a).n;
  assert.ok(nA <= 2001 && nA >= 2000, `D38 전산실 A 이력 ${nA}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rack_log WHERE room_id = ?').get(c1.b).n, nB, 'D39 전산실 B 이력은 그대로');
  assert.equal((await R.getRoom(c1.a)).logs.length, 100, 'D91 기본 100건');
  assert.equal((await R.getRoom(c1.a, { logLimit: 99999 })).logs.length, 500, 'D91 최대 500건');
  assert.equal((await R.getRoom(c1.a, { logLimit: 3 })).logs.length, 3);
});

test('탐침 D35 · D36: 전산실 없는 이력 정리는 그 법인 것만 세고 그 법인 것만 지운다', async () => {
  const db = await R.openRackDb();
  const cnt = (corp) => db.prepare("SELECT COUNT(*) AS n FROM rack_log WHERE corp_id = ? AND room_id = ''").get(corp).n;
  const n1 = cnt('c1');
  assert.ok(n1 >= 2 && n1 < 100);
  const ins = db.prepare("INSERT INTO rack_log (ts,user,corp_id,room_id,action,detail) VALUES (0,'x','c2','','site.rename','x')");
  db.exec('BEGIN'); for (let i = 0; i < 2100; i += 1) ins.run(); db.exec('COMMIT');
  await R.renameSite({ id: c1.s2, name: 'S2b', user: 'a' });
  assert.ok(cnt('c2') <= 2001, 'c2 는 2,000건으로');
  assert.equal(cnt('c1'), n1, 'D36 다른 법인(c1)의 옛 이력을 지우지 않는다');
  await R.renameSite({ id: c1.s, name: 'S1d', user: 'a' });
  assert.equal(cnt('c1'), n1 + 1, 'D35 c1 은 상한 아래 — 다른 법인 이력 수 때문에 잘리지 않는다');
});

test('탐침 D40: 되돌리기는 판을 하나만 만든다(전산실마다 만들지 않는다)', async () => {
  const db = await R.openRackDb();
  const l = await R.listVersions('c1');
  const maxBefore = l[0].id;
  await R.restoreVersion({ corpId: 'c1', versionId: l[2].id, expectLatestId: l[0].id, user: 'a' });
  const made = db.prepare("SELECT action FROM rack_version WHERE corp_id = 'c1' AND id > ?").all(maxBefore);
  assert.deepEqual(made.map((r) => r.action), ['version.restore'], '전산실 2곳 법인 — 새 판 1개');
});

test('탐침 D45 · D48 · D52: 미리 보기 — 앞 판이 멀쩡하면 prevUnreadable=false · 이 판에서 바뀐 것의 방향 · 첫 응답도 사본', async () => {
  const p = await add(c1.a, c1.ra, P(40, 'dir'));
  let l = await R.listVersions('c1');
  const d = await R.versionDetail('c1', l[0].id);   // 이 호출이 캐시를 채운다(첫 응답)
  assert.equal(d.prevUnreadable, false, 'D45');
  assert.equal(d.changes.counts.placeAdd, 1, 'D48 장비 놓기 판 = 추가 1'); assert.equal(d.changes.counts.placeRemove, 0, 'D48');
  d.version.user = 'tampered'; d.changes.items.length = 0;   // 첫 응답을 호출자가 바꿔도(라우트가 비관리자에게 user 를 비운다)
  const again = await R.versionDetail('c1', l[0].id);
  assert.equal(again.version.user, 'a', 'D52 캐시된 결과가 오염되지 않는다'); assert.equal(again.changes.items.length, 1, 'D52');
  await R.removePlace({ roomId: c1.a, rev: p.rev, user: 'a', id: p.id });
  l = await R.listVersions('c1');
  const d2 = await R.versionDetail('c1', l[0].id);
  assert.equal(d2.changes.counts.placeRemove, 1, 'D48 장비 빼기 판 = 삭제 1'); assert.equal(d2.changes.counts.placeAdd, 0);
});

test('탐침 D50 · D51: 랙 종류를 지우면 캐시된 미리 보기도 달라진다(원장 판은 그대로인데 종류만 지운 경우)', async () => {
  const t = await R.addType({ name: 'P-40U', heightU: 40 });
  const rk = await R.addRack({ roomId: c1.c, rev: await rev(c1.c), user: 'a', input: { name: 'TY', typeId: t.id } });
  const withType = (await R.listVersions('c2'))[0];
  await R.updateRack({ roomId: c1.c, rev: rk.rev, user: 'a', id: rk.id, input: { heightU: 40 } });   // 직접 높이(종류를 떼어 낸다) — 이제 종류를 쓰는 랙이 없다
  const d1 = await R.versionDetail('c2', withType.id);
  assert.deepEqual(d1.restore.items.find((x) => x.type === 'rack' && x.name === 'TY')?.fields, ['typeId'], '종류가 있을 때: 되돌리면 종류가 다시 붙는다');
  await R.removeType({ id: t.id });   // 판 · 원장은 그대로, 랙 종류만 지웠다
  const d2 = await R.versionDetail('c2', withType.id);
  assert.equal(d2.restore.items.find((x) => x.type === 'rack' && x.name === 'TY'), undefined, '종류가 지워진 뒤: 되돌려도 직접 높이 그대로(캐시된 옛 미리 보기를 주지 않는다)');
});

test('탐침 D55 · D56: 되돌리기 거절 — 판이 없는 법인 404 · 랙/장비 id 가 다른 법인과 겹쳐도 versionIdClash(아무것도 바꾸지 않음)', async () => {
  await assert.rejects(R.restoreVersion({ corpId: 'no-such-corp', versionId: 1, expectLatestId: 1, user: 'a' }), (e) => e.status === 404);
  const db = await R.openRackDb();
  const l = await R.listVersions('c2');
  const mine = await latestSnap('c2');
  const forged = { ...mine, racks: [...mine.racks, { ...mine.racks[0], id: c1.ra, name: 'STOLEN' }] };   // c1 의 랙 id
  db.prepare('UPDATE rack_version SET data = ? WHERE id = ?').run(zlib.gzipSync(Buffer.from(JSON.stringify(forged))), l[1].id);
  const before = await ledgerSnap('c2');
  await assert.rejects(R.restoreVersion({ corpId: 'c2', versionId: l[1].id, expectLatestId: l[0].id, user: 'a' }), (e) => e.status === 409 && e.extra?.code === 'versionIdClash');
  assert.deepEqual(await ledgerSnap('c2'), before);
  assert.equal((await R.getRoom(c1.a)).racks.find((r) => r.id === c1.ra).name, 'A1', '다른 법인 랙은 그대로');
});

test('탐침 D59~D65 · V02: 되돌리기 왕복 — 되돌린 원장 = 고른 판(순서 · PDU · 줄 · 용도 · 면 · 모델 · 메모 · 전력 · 무게 · 남아 있는 랙 종류)', async () => {
  const t = await R.addType({ name: 'RT-45U', heightU: 45 });
  const s1 = (await R.addSite({ corpId: 'rt', name: 'RT-1', user: 'a' })).id;
  const s2 = (await R.addSite({ corpId: 'rt', name: 'RT-2', user: 'a' })).id;
  const m1 = (await R.addRoom({ siteId: s2, name: 'M1', user: 'a' })).id;
  const m2 = (await R.addRoom({ siteId: s2, name: 'M2', user: 'a' })).id;
  const k1 = await R.addRack({ roomId: m2, rev: 0, user: 'a', input: { name: 'K1', row: 'B', typeId: t.id, role: 'storage', pduA: 2, pduB: 3 } });
  const k2 = await R.addRack({ roomId: m2, rev: k1.rev, user: 'a', input: { name: 'K2', row: 'C', heightU: 42, role: 'net', pduA: 1, pduB: 0 } });
  let rv = k2.rev;
  const p1 = await R.addPlace({ roomId: m2, rev: rv, user: 'a', rackId: k1.id, input: P(3, 'front-dev', { face: 'front', uSize: 2, kind: 'network', model: 'MODEL-X', note: 'memo-1', ratedW: 750.5, opW: 300, weightKg: 12.3, serial: 'RT-SER-1', extraSerials: ['RT-EX-1'] }) }); rv = p1.rev;
  const p2 = await R.addPlace({ roomId: m2, rev: rv, user: 'a', rackId: k1.id, input: P(3, 'rear-dev', { face: 'rear', model: 'MODEL-Y', note: 'memo-2', opW: 50 }) }); rv = p2.rev;
  const p3 = await R.addPlace({ roomId: m2, rev: rv, user: 'a', rackId: k2.id, input: P(10, 'full-dev', { uSize: 4, kind: 'storage', weightKg: 80 }) }); rv = p3.rev;
  const target = (await R.listVersions('rt'))[0];
  const want = await latestSnap('rt');
  assert.deepEqual(want, await ledgerSnap('rt'), '판 = 원장(출발점)');
  assert.ok(want.sites.some((x) => x.sort === 1) && want.rooms.some((x) => x.sort === 1) && want.racks.some((x) => x.sort === 1), '순서 값이 0 이 아닌 항목이 있어야 탐침이 된다');
  // 전부 흐트러뜨린다
  rv = (await R.removePlace({ roomId: m2, rev: rv, user: 'a', id: p2.id })).rev;
  rv = (await R.updatePlace({ roomId: m2, rev: rv, user: 'a', id: p1.id, input: { face: 'full', model: '', note: '', ratedW: null, opW: null, weightKg: null, extraSerials: [] } })).rev;
  rv = (await R.updateRack({ roomId: m2, rev: rv, user: 'a', id: k1.id, input: { row: '', role: '', pduA: 0, pduB: 0, heightU: 45 } })).rev;
  rv = (await R.updateRack({ roomId: m2, rev: rv, user: 'a', id: k2.id, input: { name: 'K2x', pduA: 0 } })).rev;
  await R.removeRoom({ id: m1, user: 'a' }); await R.removeSite({ id: s1, user: 'a' });
  await R.restoreVersion({ corpId: 'rt', versionId: target.id, expectLatestId: (await R.listVersions('rt'))[0].id, user: 'a' });
  assert.deepEqual(await ledgerSnap('rt'), want, '되돌린 원장 = 고른 판');
  assert.equal((await R.versionDetail('rt', target.id)).restore.items.length, 0);
});

test('탐침 D74~D79: 판이 하나도 없는 법인 — 어느 쓰기 경로든 변경 전에 기준 판을 남긴다', async () => {
  const db = await R.openRackDb();
  const wipe = () => db.prepare("DELETE FROM rack_version WHERE corp_id = 'bl'").run();
  const acts = async () => (await R.listVersions('bl')).map((v) => v.action);
  const s = (await R.addSite({ corpId: 'bl', name: 'BL-1', user: 'a' })).id;
  wipe(); const s2 = (await R.addSite({ corpId: 'bl', name: 'BL-2', user: 'a' })).id;
  assert.deepEqual(await acts(), ['site.add', 'version.baseline'], 'D79 addSite');
  assert.equal((await R.listVersions('bl'))[1].counts.sites, 1, '기준 판 = 변경 전 모습');
  wipe(); const m = (await R.addRoom({ siteId: s, name: 'M', user: 'a' })).id;
  assert.deepEqual(await acts(), ['room.add', 'version.baseline'], 'D75 addRoom');
  wipe(); await R.renameRoom({ id: m, name: 'M2', user: 'a' });
  assert.deepEqual(await acts(), ['room.rename', 'version.baseline'], 'D77 renameRoom');
  wipe(); const k = await R.addRack({ roomId: m, rev: await rev(m), user: 'a', input: { name: 'K', heightU: 42 } });
  assert.deepEqual(await acts(), ['rack.add', 'version.baseline'], 'D74 roomWrite');
  assert.equal((await R.listVersions('bl'))[1].counts.racks, 0);
  await R.removeRack({ roomId: m, rev: k.rev, user: 'a', id: k.id });
  wipe(); await R.removeRoom({ id: m, user: 'a' });
  assert.deepEqual(await acts(), ['room.remove', 'version.baseline'], 'D76 removeRoom');
  assert.equal((await R.listVersions('bl'))[1].counts.rooms, 1);
  wipe(); await R.removeSite({ id: s2, user: 'a' });
  assert.deepEqual(await acts(), ['site.remove', 'version.baseline'], 'D78 removeSite');
});

test('탐침 D87 · D92: 높이만 바꿔도 이력은 옮기기 · 꽉 찬 랙(120대) 안에서는 고치기 · 옮기기가 된다', async () => {
  const db = await R.openRackDb();
  const p = await add(c1.c, c1.rc, P(5, 'grow'));
  await R.updatePlace({ roomId: c1.c, rev: p.rev, user: 'a', id: p.id, input: { uSize: 2 } });
  assert.equal((await R.getRoom(c1.c)).logs[0].action, 'place.move', 'D87(known.md — 의도된 동작)');
  const full = await R.addRack({ roomId: c1.c, rev: await rev(c1.c), user: 'a', input: { name: 'FULL', heightU: 60 } });
  const insP = db.prepare("INSERT INTO rack_place (id,rack_id,face,u_start,u_size,kind,label,updated_at) VALUES (?,?,?,?,1,'other',?,0)");
  const hex = (i) => `f${i.toString(16).padStart(15, '0')}`;
  for (let u = 1; u <= 60; u += 1) { insP.run(hex(u), full.id, 'front', u, `f${u}`); insP.run(hex(100 + u), full.id, 'rear', u, `r${u}`); }
  await R._resyncForTest();
  const r = await R.updatePlace({ roomId: c1.c, rev: await rev(c1.c), user: 'a', id: hex(1), input: { label: 'renamed' } });
  assert.ok(r.rev, 'D92 꽉 찬 랙의 장비 이름 고치기');
});

test.after(() => R._closeForTest());
