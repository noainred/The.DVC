// 랙 실장도 개선 1 · 2(2026-11-26 사용자 요청 '개선 제안 1, 2, 3 진행해') 회귀.
//   개선 1: 판 저장의 전산실 조각 캐시((전산실, rev) → 랙 · 장비 행) + gzip 1단계 — 캐시가 낡으면 **틀린 판**이 저장된다(되돌리면 원장이 망가진다).
//     · ROLLBACK 된 내용이 캐시에 남지 않는다(COMMIT 뒤에만 넣는다) · 되돌리기 · 전산실 삭제/되살리기 · 다른 전산실 · 다른 법인이 섞이지 않는다 ·
//       핸들을 다시 열면 비운다 · 자기 점검(RACK_SELF_CHECK=1)은 캐시로 만든 판을 원장 훑기와 글자까지 대조한다.
//   개선 2: 시리얼 키 색인(rack_place_key) — 놓기 · 고치기 · 빼기 · 되돌리기가 색인을 맞춘다 · 색인 없던 원장은 열 때 한 번 채운다 ·
//     중복 판정은 예전(원장 훑기)과 같다(자기 점검이 매번 대조).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackperf-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp;
process.env.RACK_DB = path.join(tmp, 'rack.db');
process.env.RACK_SELF_CHECK = '1';

const R = await import('../src/rack/db.js');
const V = await import('../src/rack/versions.js');
const { serialKeyOf } = await import('../src/rack/layout.js');

/** 최신 판(저장된 글자)을 풀어 원장과 직접 비교한다 — 자기 점검과 별개로 '저장된 것' 을 본다. */
async function latestSnap(corpId) {
  const db = await R.openRackDb();
  const row = db.prepare('SELECT data FROM rack_version WHERE corp_id = ? ORDER BY id DESC LIMIT 1').get(corpId);
  return JSON.parse(zlib.gunzipSync(Buffer.from(row.data)).toString('utf8'));
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
const same = async (corpId, why) => assert.deepEqual(await latestSnap(corpId), await ledgerSnap(corpId), why);
const P = (uStart, label, extra = {}) => ({ face: 'full', uStart, uSize: 1, kind: 'other', label, serial: '', extraSerials: [], ...extra });

let kr; let pl;
test('준비: 법인 둘 · 전산실 셋', async () => {
  const s1 = (await R.addSite({ corpId: 'kr', name: 'KR-1', user: 'a' })).id;
  const a = (await R.addRoom({ siteId: s1, name: 'A', user: 'a' })).id;
  const b = (await R.addRoom({ siteId: s1, name: 'B', user: 'a' })).id;
  const ra = (await R.addRack({ roomId: a, rev: 0, user: 'a', input: { name: 'A1', heightU: 42 } }));
  const rb = (await R.addRack({ roomId: b, rev: 0, user: 'a', input: { name: 'B1', heightU: 42 } }));
  kr = { s1, a, b, ra: ra.id, rb: rb.id };
  const s2 = (await R.addSite({ corpId: 'pl', name: 'PL-1', user: 'a' })).id;
  const c = (await R.addRoom({ siteId: s2, name: 'C', user: 'a' })).id;
  const rc = (await R.addRack({ roomId: c, rev: 0, user: 'a', input: { name: 'C1', heightU: 42 } }));
  pl = { s2, c, rc: rc.id };
  await same('kr'); await same('pl');
});

const rev = async (roomId) => (await R.getRoom(roomId)).room.rev;

test('개선 1: 한 전산실만 바꾼 쓰기의 판에도 다른 전산실 · 다른 데이터센터 자료가 그대로 들어 있다', async () => {
  const p1 = await R.addPlace({ roomId: kr.a, rev: await rev(kr.a), user: 'a', rackId: kr.ra, input: P(1, 'a-1') });
  await R.addPlace({ roomId: kr.b, rev: await rev(kr.b), user: 'a', rackId: kr.rb, input: P(1, 'b-1') });
  await R.updatePlace({ roomId: kr.a, rev: p1.rev, user: 'a', id: p1.id, input: { uStart: 5 } });
  const snap = await latestSnap('kr');
  assert.deepEqual(snap.places.map((p) => `${p.label}@${p.uStart}`).sort(), ['a-1@5', 'b-1@1']);
  await same('kr', '옮긴 뒤 판 = 원장');
  await R.renameSite({ id: kr.s1, name: 'KR-1b', user: 'a' });   // 전산실을 건드리지 않는 쓰기(전부 캐시에서)
  await same('kr', '데이터센터 이름만 바꾼 판에도 장비가 다 있다');
  assert.equal((await latestSnap('pl')).places.length, 0, '다른 법인 판에 섞이지 않는다');
});

test('개선 1: ROLLBACK 된 쓰기의 내용이 다음 판에 섞이지 않는다(조각은 COMMIT 뒤에만 캐시에)', async () => {
  const db = await R.openRackDb();
  const before = await rev(kr.a);
  // 판 저장(saveVersion) **뒤** 이력 쓰기에서 실패하게 한다 — 그 사이 (전산실 A, rev+1) 조각은 이미 읽혔다.
  db.exec("CREATE TRIGGER rl_fail BEFORE INSERT ON rack_log BEGIN SELECT RAISE(ABORT, 'probe'); END;");
  try {
    await assert.rejects(R.addPlace({ roomId: kr.a, rev: before, user: 'a', rackId: kr.ra, input: P(20, 'ghost') }));
  } finally { db.exec('DROP TRIGGER rl_fail'); }
  assert.equal(await rev(kr.a), before, '실패한 쓰기는 rev 를 올리지 않았다');
  // 같은 rev 에서 다른 내용으로 성공 — 캐시에 ghost 가 남아 있으면 이 판에 ghost 가 들어간다.
  await R.addPlace({ roomId: kr.a, rev: before, user: 'a', rackId: kr.ra, input: P(21, 'real') });
  const labels = (await latestSnap('kr')).places.map((p) => p.label);
  assert.ok(labels.includes('real') && !labels.includes('ghost'), labels.join(','));
  await same('kr');
  // 실패 직후 다른 전산실을 쓰는 경우(전산실 A 조각을 캐시에서 꺼낸다)도 같다
  await R.addPlace({ roomId: kr.b, rev: await rev(kr.b), user: 'a', rackId: kr.rb, input: P(22, 'b-22') });
  await same('kr');
});

test('개선 1: 되돌리기 · 전산실 삭제 뒤 되살리기 · 랙 추가/삭제를 섞어도 판 = 원장(매 단계)', async () => {
  const empty = (await R.addRoom({ siteId: kr.s1, name: 'TMP', user: 'a' })).id;
  const rk = await R.addRack({ roomId: empty, rev: 0, user: 'a', input: { name: 'T1', heightU: 10 } });
  const pp = await R.addPlace({ roomId: empty, rev: rk.rev, user: 'a', rackId: rk.id, input: P(1, 't-1') });
  const withTmp = (await R.listVersions('kr'))[0];
  await same('kr');
  const r2 = await R.removePlace({ roomId: empty, rev: pp.rev, user: 'a', id: pp.id }); await same('kr');
  const r3 = await R.removeRack({ roomId: empty, rev: r2.rev, user: 'a', id: rk.id }); await same('kr');
  void r3;
  await R.removeRoom({ id: empty, user: 'a' }); await same('kr');
  await R.restoreVersion({ corpId: 'kr', versionId: withTmp.id, expectLatestId: (await R.listVersions('kr'))[0].id, user: 'a' });
  await same('kr', '되돌린 직후 판 = 원장');
  assert.ok((await latestSnap('kr')).places.some((p) => p.label === 't-1'));
  // 되돌린 뒤 이어지는 쓰기(모든 전산실 rev 가 새 값 — 조각을 다시 읽는다)
  await R.addPlace({ roomId: kr.a, rev: await rev(kr.a), user: 'a', rackId: kr.ra, input: P(30, 'after-restore') });
  await same('kr');
  await R.updateRack({ roomId: kr.b, rev: await rev(kr.b), user: 'a', id: kr.rb, input: { name: 'B1-renamed' } });
  await same('kr');
});

test('개선 1: 원장을 다시 열면 조각을 비운다(다른 파일로 바뀌었어도 앞 핸들의 조각을 쓰지 않는다)', async () => {
  const db = await R.openRackDb();
  const rackId = kr.ra;
  // 핸들을 닫은 사이 밖에서 원장이 바뀐 상황을 흉내 — rev 는 그대로 두고 장비 하나를 지운다
  const victim = db.prepare("SELECT p.id FROM rack_place p WHERE p.rack_id = ? AND p.label = 'real'").get(rackId).id;
  R._closeForTest();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(process.env.RACK_DB);
  raw.prepare('DELETE FROM rack_place WHERE id = ?').run(victim); raw.close();
  await R.renameSite({ id: kr.s1, name: 'KR-1c', user: 'a' });
  assert.ok(!(await latestSnap('kr')).places.some((p) => p.id === victim), '다시 연 뒤 판은 지금 원장을 읽는다');
  await same('kr');
});

test('개선 1: 판은 gzip 으로 풀리고 예전 6단계 판도 그대로 읽는다 · 판 모양(format)은 그대로', async () => {
  const db = await R.openRackDb();
  const l = await R.listVersions('kr');
  const snap = await latestSnap('kr');
  assert.equal(snap.format, V.SNAPSHOT_FORMAT);
  // 예전 판(6단계 압축)을 흉내 — 읽기 · 되돌리기 미리 보기가 된다
  db.prepare('UPDATE rack_version SET data = ? WHERE id = ?').run(zlib.gzipSync(Buffer.from(JSON.stringify(snap)), { level: 6 }), l[0].id);
  const d = await R.versionDetail('kr', l[0].id);
  assert.equal(d.readable, true);
  assert.equal(d.restore.items.length, 0, '지금 원장과 같은 판');
});

test('개선 2: 놓기 · 고치기 · 빼기가 시리얼 키 색인을 맞춘다 — 비운 시리얼은 다시 쓸 수 있고 추가 시리얼도 대조한다', async () => {
  const db = await R.openRackDb();
  const keysOfPlace = (id) => db.prepare('SELECT key FROM rack_place_key WHERE place_id = ? ORDER BY key').all(id).map((r) => r.key);
  let rv = await rev(kr.a);
  const p = await R.addPlace({ roomId: kr.a, rev: rv, user: 'a', rackId: kr.ra, input: P(10, 'h700', { kind: 'storage', serial: 'MAIN-01', extraSerials: ['NODE_02', 'node.03'] }) }); rv = p.rev;
  assert.deepEqual(keysOfPlace(p.id), ['main01', 'node02', 'node03']);
  const clash = (input) => assert.rejects(R.addPlace({ roomId: kr.b, rev: 0, user: 'a', rackId: kr.rb, input }), (e) => e.extra?.code === 'serialDup' || e.extra?.code === 'revConflict');
  void clash;
  const tryAdd = async (serial, uStart) => { try { return await R.addPlace({ roomId: kr.b, rev: await rev(kr.b), user: 'a', rackId: kr.rb, input: P(uStart, `x-${uStart}`, { serial }) }); } catch (e) { return e; } };
  assert.equal((await tryAdd('main 01', 11)).extra?.code, 'serialDup', '다른 전산실 · 같은 법인 · 표기만 다른 주 시리얼');
  assert.equal((await tryAdd('NODE-03', 11)).extra?.code, 'serialDup', '기존 장비의 추가 시리얼');
  // 고치기: 추가 시리얼 하나를 뺀다 → 그 시리얼은 다른 장비가 쓸 수 있다
  rv = (await R.updatePlace({ roomId: kr.a, rev: rv, user: 'a', id: p.id, input: { extraSerials: ['NODE_02'] } })).rev;
  assert.deepEqual(keysOfPlace(p.id), ['main01', 'node02']);
  const q = await tryAdd('NODE-03', 11);
  assert.ok(q.id, '뺀 추가 시리얼은 다시 쓸 수 있다');
  // 옮기기만 하면 색인은 그대로
  rv = (await R.updatePlace({ roomId: kr.a, rev: rv, user: 'a', id: p.id, input: { uStart: 12 } })).rev;
  assert.deepEqual(keysOfPlace(p.id), ['main01', 'node02']);
  // 주 시리얼을 비운다
  rv = (await R.updatePlace({ roomId: kr.a, rev: rv, user: 'a', id: p.id, input: { serial: '' } })).rev;
  assert.deepEqual(keysOfPlace(p.id), ['node02']);
  assert.ok((await tryAdd('MAIN-01', 13)).id, '비운 주 시리얼은 다시 쓸 수 있다');
  // 빼기
  await R.removePlace({ roomId: kr.a, rev: rv, user: 'a', id: p.id });
  assert.deepEqual(keysOfPlace(p.id), []);
  assert.ok((await tryAdd('node02', 14)).id, '뺀 장비의 시리얼은 다시 쓸 수 있다');
  // 다른 법인은 대조하지 않는다
  assert.ok((await R.addPlace({ roomId: pl.c, rev: await rev(pl.c), user: 'a', rackId: pl.rc, input: P(1, 'pl', { serial: 'MAIN-01' }) })).id);
  assert.ok((await R.addPlace({ roomId: pl.c, rev: await rev(pl.c), user: 'a', rackId: pl.rc, input: P(2, 'pl-only', { serial: 'PLONLY-9' }) })).id);
  assert.ok(!(await R.placedSerialKeys('kr')).has('plonly9'), '다른 법인의 키는 이 법인의 놓인 키 집합에 없다');
  assert.ok((await R.placedSerialKeys('pl')).has('plonly9'));
  // 전산실 조회용 키 집합 = 원장에서 직접 만든 집합
  const want = new Set();
  for (const m of [kr.a, kr.b]) for (const x of (await R.getRoom(m)).places) for (const s of [x.serial, ...x.extraSerials]) { const k = serialKeyOf(s); if (k) want.add(k); }
  const tmpRoom = db.prepare("SELECT m.id FROM rack_room m WHERE m.name = 'TMP'").get();
  if (tmpRoom) for (const x of (await R.getRoom(tmpRoom.id)).places) for (const s of [x.serial, ...x.extraSerials]) { const k = serialKeyOf(s); if (k) want.add(k); }
  assert.deepEqual([...(await R.placedSerialKeys('kr'))].sort(), [...want].sort());
});

test('개선 2: 되돌리기가 색인을 판의 장비로 다시 맞춘다 — 되돌린 뒤에도 중복 판정이 맞다', async () => {
  const db = await R.openRackDb();
  let rv = await rev(kr.a);
  const p = await R.addPlace({ roomId: kr.a, rev: rv, user: 'a', rackId: kr.ra, input: P(35, 'srv-r', { kind: 'server', serial: 'RST-0001', extraSerials: ['RST-EX1'] }) }); rv = p.rev;
  const withIt = (await R.listVersions('kr'))[0];
  rv = (await R.removePlace({ roomId: kr.a, rev: rv, user: 'a', id: p.id })).rev;
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rack_place_key WHERE key IN ('rst0001','rstex1')").get().n, 0);
  // 판 뒤에 놓은 장비(판에 없다) — 되돌리면 사라지고 그 키도 색인에서 지워져야 한다
  const late = await R.addPlace({ roomId: kr.a, rev: rv, user: 'a', rackId: kr.ra, input: P(38, 'late', { serial: 'LATE-1', extraSerials: ['LATE-X'] }) }); rv = late.rev;
  await R.restoreVersion({ corpId: 'kr', versionId: withIt.id, expectLatestId: (await R.listVersions('kr'))[0].id, user: 'a' });
  assert.deepEqual(db.prepare('SELECT key FROM rack_place_key WHERE place_id = ? ORDER BY key').all(p.id).map((r) => r.key), ['rst0001', 'rstex1']);
  await assert.rejects(R.addPlace({ roomId: kr.b, rev: await rev(kr.b), user: 'a', rackId: kr.rb, input: P(36, 'dup', { serial: 'rst-ex1' }) }), (e) => e.extra?.code === 'serialDup');
  // 색인에 판에 없는 장비의 키가 남지 않는다
  const orphan = db.prepare('SELECT COUNT(*) AS n FROM rack_place_key k WHERE NOT EXISTS (SELECT 1 FROM rack_place p WHERE p.id = k.place_id)').get().n;
  assert.equal(orphan, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rack_place_key WHERE key IN ('late1','latex')").get().n, 0, '판에 없는 장비의 키');
  assert.ok((await R.addPlace({ roomId: kr.b, rev: await rev(kr.b), user: 'a', rackId: kr.rb, input: P(39, 'late-again', { serial: 'late-x' }) })).id, '되돌려 사라진 장비의 시리얼은 다시 쓸 수 있다');
});

test('개선 2: 색인이 없던 원장(업그레이드 전)은 열 때 한 번 채운다 · 이미 채운 원장은 다시 훑지 않는다', async () => {
  let db = await R.openRackDb();
  const n0 = db.prepare('SELECT COUNT(*) AS n FROM rack_place_key').get().n;
  assert.ok(n0 > 0);
  db.exec('DELETE FROM rack_place_key'); db.exec("DELETE FROM rack_meta WHERE k = 'placeKeys'");
  R._closeForTest();
  db = await R.openRackDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rack_place_key').get().n, n0, '열 때 다시 채웠다');
  assert.equal(db.prepare("SELECT v FROM rack_meta WHERE k = 'placeKeys'").get().v, R.RACK_META_VERSIONS.placeKeys);   // 2026-11-27: 비교 키가 폭에 무관해져 판 번호가 올랐다
  await assert.rejects(R.addPlace({ roomId: kr.b, rev: await rev(kr.b), user: 'a', rackId: kr.rb, input: P(37, 'dup2', { serial: 'RST-0001' }) }), (e) => e.extra?.code === 'serialDup');
  // 표식이 있으면 다시 채우지 않는다(색인을 비워 두고 다시 열어도 그대로 — 매번 원장을 훑지 않는다는 뜻)
  process.env.RACK_SELF_CHECK = '';
  db.exec("DELETE FROM rack_place_key WHERE key = 'rst0001'");
  R._closeForTest();
  db = await R.openRackDb();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rack_place_key WHERE key = 'rst0001'").get().n, 0);
  await R._resyncForTest();
  process.env.RACK_SELF_CHECK = '1';
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rack_place_key WHERE key = 'rst0001'").get().n, 1);
});

test.after(() => R._closeForTest());
