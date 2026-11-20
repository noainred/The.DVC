// 랙 실장도 법인별 판(최근 30개) · 되돌리기 — 2026-11-20 사용자 요청 '랙 변경 사항을 법인별로 최근 30개 저장'(선택: 판 30개 + 되돌리기 · 오래된 판은 지운다).
//   판 = 변경 직후 법인 원장 전체(같은 트랜잭션) · 30개 넘으면 지움 · 기준 판 · 되돌리기(최신 판 대조 409 · 다른 법인 무손상 · id 겹침 거절 ·
//   지워진 랙 종류 · rev 올림 · 되돌리기도 새 판) · 차이 계산 · 라우트(범위 404 · 쓰기 403 · 계정명 가림).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackv-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp;
process.env.RACK_DB = path.join(tmp, 'rack.db');

const V = await import('../src/rack/versions.js');
const R = await import('../src/rack/db.js');
const dc = await import('../src/datacenter/store.js');
const { store } = await import('../src/store.js');
const { registerRack } = await import('../src/routes/api/rack.js');

const routes = new Map();
registerRack({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
async function call(key, { user, params = {}, query = {}, body = {} }) {
  const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {}, end() { return this; } };
  const req = { user, params, query, body, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0], originalUrl: `/api${key.replace(/^\w+ /, '')}` };
  for (const h of routes.get(key)) { let n = false; await h(req, res, () => { n = true; }); if (!n) break; }
  return res;
}
const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const OP_A = { username: 'op-a', role: 'operator', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
const ADMIN_B = { username: 'admin-b', role: 'admin', scope: { vcenters: ['vc-b'], regions: [], writeVcenters: [] } };
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }, { id: 'vc-b', name: 'b', status: 'ok' }], hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: '한국 법인' }); dc.addDatacenter({ id: 'pl', name: '폴란드 법인' });
dc.setVcenterDatacenter('vc-a', 'kr'); dc.setVcenterDatacenter('vc-b', 'pl');

const roomRev = async (roomId) => (await R.getRoom(roomId)).room.rev;

test('순수: 차이 계산 — 추가 · 삭제 · 이동 · 정보 수정을 나눠 센다', () => {
  const base = V.buildSnapshot('kr', {
    sites: [{ id: 'a'.repeat(16), name: 'S', sort: 0 }], rooms: [{ id: 'b'.repeat(16), siteId: 'a'.repeat(16), name: 'R', sort: 0 }],
    racks: [{ id: 'c'.repeat(16), roomId: 'b'.repeat(16), name: 'A1', row: '', typeId: '', heightU: 42, role: '', pduA: 0, pduB: 0, sort: 0 }],
    places: [
      { id: '1'.repeat(16), rackId: 'c'.repeat(16), face: 'full', uStart: 1, uSize: 2, kind: 'server', label: 'x', model: '', serial: 's1', extraSerials: [], note: '' },
      { id: '2'.repeat(16), rackId: 'c'.repeat(16), face: 'full', uStart: 5, uSize: 1, kind: 'other', label: 'y', model: '', serial: '', extraSerials: [], note: '' },
    ],
  });
  const next = JSON.parse(JSON.stringify(base));
  next.places[0].uStart = 10; next.places[0].label = 'x2';
  next.places.splice(1, 1);
  next.places.push({ ...base.places[1], id: '3'.repeat(16), label: 'z' });
  const d = V.diffSnapshots(base, next);
  assert.equal(d.counts.placeMove, 1); assert.equal(d.counts.placeChange, 1); assert.equal(d.counts.placeRemove, 1); assert.equal(d.counts.placeAdd, 1);
  assert.match(d.items.find((i) => i.op === 'move').where, /A1 U1–2 → A1 U10–11/);
  assert.deepEqual(d.items.find((i) => i.op === 'change').fields, ['label']);
  assert.ok(!JSON.stringify(d).includes('s1'), '차이에 시리얼 값을 싣지 않는다(필드 이름만)');
});

test('순수: 판 검사 — 다른 법인 · 다른 형식 · 끊어진 참조 · 이상한 id 는 거절', () => {
  const ok = V.buildSnapshot('kr', { sites: [{ id: 'a'.repeat(16), name: 'S', sort: 0 }], rooms: [], racks: [], places: [] });
  assert.ok(V.validateSnapshot(ok, 'kr'));
  assert.equal(V.validateSnapshot(ok, 'pl'), null);
  assert.equal(V.validateSnapshot({ ...ok, format: 2 }, 'kr'), null);
  assert.equal(V.validateSnapshot({ ...ok, rooms: [{ id: 'b'.repeat(16), siteId: 'z'.repeat(16), name: 'R' }] }, 'kr'), null);
  assert.equal(V.validateSnapshot({ ...ok, sites: [{ id: '../x', name: 'S' }] }, 'kr'), null);
});

let siteId; let roomId; let rackId;

test('저장: 변경마다 판 하나 · 법인별로 따로 · 30개를 넘으면 오래된 판을 지운다', async () => {
  siteId = (await R.addSite({ corpId: 'kr', name: 'KR-SEL', user: 'admin' })).id;
  roomId = (await R.addRoom({ siteId, name: '전산실 A', user: 'admin' })).id;
  const a = await R.addRack({ roomId, rev: 0, user: 'admin', input: { name: 'A1', heightU: 42 } });
  rackId = a.id;
  await R.addSite({ corpId: 'pl', name: 'PL-WAW', user: 'admin' });
  let list = await R.listVersions('kr');
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((v) => v.action), ['rack.add', 'room.add', 'site.add']);
  assert.equal(list[0].counts.racks, 1);
  assert.equal((await R.listVersions('pl')).length, 1, '다른 법인 판은 따로 센다');
  let rev = a.rev;
  for (let i = 0; i < 32; i += 1) {
    const p = await R.addPlace({ roomId, rev, user: 'admin', rackId, input: { face: 'full', uStart: i + 1, uSize: 1, kind: 'other', label: `p${i}`, serial: '', extraSerials: [] } });
    rev = p.rev;
  }
  list = await R.listVersions('kr');
  assert.equal(list.length, V.VERSION_KEEP);
  assert.equal(list[0].counts.places, 32);
  assert.equal(list.at(-1).counts.places, 3, '가장 오래 남은 판 = 장비 3대일 때(앞의 판은 지워짐)');
  const db = await R.openRackDb();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rack_version WHERE corp_id = 'kr'").get().n, V.VERSION_KEEP, '표에서도 실제로 지운다(목록만 자르지 않는다)');
});

test('되돌리기: 고른 판의 모습으로 · rev 올림 · 새 판으로 남음 · 다른 법인 무손상 · 최신 판 대조', async () => {
  const list = await R.listVersions('kr');
  const target = list.find((v) => v.counts.places === 10);
  const before = await roomRev(roomId);
  const plBefore = await R.listTree(new Set(['pl']));
  await assert.rejects(R.restoreVersion({ corpId: 'kr', versionId: target.id, expectLatestId: list[1].id, user: 'admin' }), (e) => e.status === 409 && e.extra.code === 'versionConflict');
  await assert.rejects(R.restoreVersion({ corpId: 'kr', versionId: list[0].id, expectLatestId: list[0].id, user: 'admin' }), (e) => e.extra.code === 'versionSame');
  await assert.rejects(R.restoreVersion({ corpId: 'pl', versionId: target.id, expectLatestId: (await R.listVersions('pl'))[0].id, user: 'admin' }), (e) => e.status === 404, '다른 법인 판 id 로는 되돌릴 수 없다');
  const r = await R.restoreVersion({ corpId: 'kr', versionId: target.id, expectLatestId: list[0].id, user: 'kim' });
  assert.equal(r.counts.places, 10);
  const room = await R.getRoom(roomId);
  assert.equal(room.places.length, 10);
  assert.ok(room.room.rev > before, '열려 있던 편집 화면이 옛 rev 로 덮어쓰지 못하게');
  await assert.rejects(R.addPlace({ roomId, rev: before, user: 'x', rackId, input: { face: 'full', uStart: 40, uSize: 1, kind: 'other', label: 'stale', serial: '', extraSerials: [] } }), (e) => e.extra.code === 'revConflict');
  assert.equal(room.logs[0].action, 'version.restore');
  const after2 = await R.listVersions('kr');
  assert.equal(after2[0].action, 'version.restore');
  assert.equal(after2[0].id, r.latestId);
  assert.deepEqual(await R.listTree(new Set(['pl'])), plBefore, '다른 법인 원장은 그대로');
  // 되돌리기도 되돌릴 수 있다(되돌리기 직전 판 = 장비 32대)
  const prev = after2.find((v) => v.counts.places === 32);
  await R.restoreVersion({ corpId: 'kr', versionId: prev.id, expectLatestId: after2[0].id, user: 'kim' });
  assert.equal((await R.getRoom(roomId)).places.length, 32);
});

test('되돌리기: 지워진 랙 종류는 직접 높이로 · 판에 없는 전산실은 지운다 · 손상 판 거절 · id 겹침 거절', async () => {
  const t = await R.addType({ name: '40U', heightU: 40 });
  let rev = await roomRev(roomId);
  const rk = await R.addRack({ roomId, rev, user: 'admin', input: { name: 'T1', typeId: t.id } });
  const withType = (await R.listVersions('kr'))[0];
  rev = rk.rev;
  rev = (await R.removeRack({ roomId, rev, user: 'admin', id: rk.id })).rev;
  await R.removeType({ id: t.id });
  const room2 = (await R.addRoom({ siteId, name: '전산실 B', user: 'admin' })).id;
  let latest = (await R.listVersions('kr'))[0].id;
  await R.restoreVersion({ corpId: 'kr', versionId: withType.id, expectLatestId: latest, user: 'admin' });
  const t1 = (await R.getRoom(roomId)).racks.find((x) => x.name === 'T1');
  assert.equal(t1.typeId, ''); assert.equal(t1.heightU, 40);
  assert.equal(await R.getRoom(room2), null, '판에 없던 전산실 B 는 지워진다');
  // 손상 판
  const db = await R.openRackDb();
  db.prepare('UPDATE rack_version SET data = ? WHERE id = ?').run(Buffer.from('not gzip'), withType.id);
  latest = (await R.listVersions('kr'))[0].id;
  await assert.rejects(R.restoreVersion({ corpId: 'kr', versionId: withType.id, expectLatestId: latest, user: 'admin' }), (e) => e.extra.code === 'versionUnreadable');
  assert.equal((await R.versionDetail('kr', withType.id)).readable, false);
  // 다른 법인 자료와 id 가 겹치는 판(조작된 판) — 폴란드 데이터센터 id 를 넣는다
  const plSite = (await R.listTree(new Set(['pl']))).sites[0];
  const forged = V.buildSnapshot('kr', { sites: [{ id: plSite.id, name: 'X', sort: 0 }], rooms: [], racks: [], places: [] });
  db.prepare('UPDATE rack_version SET data = ? WHERE id = ?').run(zlib.gzipSync(Buffer.from(JSON.stringify(forged))), withType.id);
  await assert.rejects(R.restoreVersion({ corpId: 'kr', versionId: withType.id, expectLatestId: latest, user: 'admin' }), (e) => e.extra.code === 'versionIdClash');
  assert.equal((await R.listTree(new Set(['pl']))).sites[0].name, 'PL-WAW', '실패한 되돌리기는 아무것도 바꾸지 않는다');
  assert.ok((await R.getRoom(roomId)), '한국 법인 원장도 그대로(롤백)');
});

test('기준 판: 판 기능 이전 원장(판이 없는 법인)은 열 때 지금 모습을 기준 판으로 남긴다', async () => {
  const db = await R.openRackDb();
  db.prepare("DELETE FROM rack_version WHERE corp_id = 'pl'").run();
  R._closeForTest();
  await R.openRackDb();
  const l = await R.listVersions('pl');
  assert.equal(l.length, 1); assert.equal(l[0].action, 'version.baseline');
});

test('라우트: 범위 밖 404 · 쓰기 밖 403 · 비관리자에게 계정명 없음 · 차이 · 되돌리기', async () => {
  assert.equal((await call('GET /tools/rack/versions', { user: OP_A, query: { corp: 'pl' } })).statusCode, 404);
  const v = await call('GET /tools/rack/versions', { user: OP_A, query: { corp: 'kr' } });
  assert.equal(v.statusCode, 200); assert.equal(v.body.canRestore, false);
  assert.ok(v.body.versions.every((x) => x.user === ''));
  const a = await call('GET /tools/rack/versions', { user: ADMIN, query: { corp: 'kr' } });
  assert.equal(a.body.versions[0].user, 'admin'); assert.equal(a.body.canRestore, true);
  const pick = a.body.versions.find((x) => x.counts.places === 32 && x.action !== 'version.restore') || a.body.versions[3];
  const d = await call('GET /tools/rack/versions/:vid', { user: OP_A, params: { vid: String(pick.id) }, query: { corp: 'kr' } });
  assert.equal(d.statusCode, 200); assert.equal(d.body.version.user, '');
  assert.ok(d.body.restore && d.body.restore.counts);
  assert.equal((await call('GET /tools/rack/versions/:vid', { user: ADMIN_B, params: { vid: String(pick.id) }, query: { corp: 'kr' } })).statusCode, 404);
  assert.equal((await call('POST /tools/rack/op', { user: OP_A, body: { op: 'version.restore', corpId: 'kr', versionId: pick.id, expectLatestId: a.body.latestId } })).statusCode, 403, '운영자는 역할 게이트에서');
  assert.equal((await call('POST /tools/rack/op', { user: ADMIN_B, body: { op: 'version.restore', corpId: 'kr', versionId: pick.id, expectLatestId: a.body.latestId } })).statusCode, 404, '범위 밖 법인');
  const r = await call('POST /tools/rack/op', { user: ADMIN, body: { op: 'version.restore', corpId: 'kr', versionId: pick.id, expectLatestId: a.body.latestId } });
  assert.equal(r.statusCode, 200); assert.ok(r.body.latestId > a.body.latestId);
  const stale = await call('POST /tools/rack/op', { user: ADMIN, body: { op: 'version.restore', corpId: 'kr', versionId: pick.id, expectLatestId: a.body.latestId } });
  assert.equal(stale.statusCode, 409); assert.equal(stale.body.code, 'versionConflict');
});

test('반증 L-2 · L-3: 지웠다 되살린 전산실은 옛 rev 를 다시 받지 않는다 · 되돌리기는 이력을 지우지 않는다', async () => {
  const sid = (await R.addSite({ corpId: 'kr', name: 'KR-PUS', user: 'admin' })).id;
  const rid = (await R.addRoom({ siteId: sid, name: '부산 1', user: 'admin' })).id;
  let rev = 0;
  for (let i = 0; i < 3; i += 1) rev = (await R.addRack({ roomId: rid, rev, user: 'admin', input: { name: `B${i}`, heightU: 42 } })).rev;
  const withRoom = (await R.listVersions('kr'))[0];
  const staleRev = rev;
  await R.removeRack({ roomId: rid, rev, user: 'admin', id: (await R.getRoom(rid)).racks[0].id });
  const logsBefore = (await R.getRoom(rid)).logs.length;
  // 판에 없는 모습으로 되돌려 전산실을 없앤 뒤(이력은 남아야 한다), 다시 전산실이 있는 판으로
  const noRoom = (await R.listVersions('kr')).find((v) => v.id < withRoom.id && v.action === 'site.add');
  await R.restoreVersion({ corpId: 'kr', versionId: noRoom.id, expectLatestId: (await R.listVersions('kr'))[0].id, user: 'admin' });
  assert.equal(await R.getRoom(rid), null);
  const db = await R.openRackDb();
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM rack_log WHERE room_id = ?').get(rid).n >= logsBefore, '되돌리기는 rack_log 를 지우지 않는다');
  await R.restoreVersion({ corpId: 'kr', versionId: withRoom.id, expectLatestId: (await R.listVersions('kr'))[0].id, user: 'admin' });
  const back = await R.getRoom(rid);
  assert.ok(back.room.rev > staleRev + 1, `되살린 전산실 rev(${back.room.rev}) 는 지워지기 전 rev(${staleRev + 1}) 보다 커야 한다`);
  await assert.rejects(R.addRack({ roomId: rid, rev: staleRev, user: 'x', input: { name: 'stale', heightU: 42 } }), (e) => e.extra.code === 'revConflict');
  assert.ok(back.logs.some((l) => l.action === 'rack.add'), '되살린 전산실의 옛 이력이 다시 보인다');
});

test('반증 L-4: 판이 하나도 없는 법인은 첫 변경 전에 기준 판을 남긴다(열 때 실패했어도)', async () => {
  const db = await R.openRackDb();
  db.prepare("DELETE FROM rack_version WHERE corp_id = 'pl'").run();
  const site = (await R.listTree(new Set(['pl']))).sites[0];
  await R.renameSite({ id: site.id, name: 'PL-WAW2', user: 'admin' });
  const l = await R.listVersions('pl');
  assert.deepEqual(l.map((v) => v.action), ['site.rename', 'version.baseline']);
  const d = await R.versionDetail('pl', l[0].id);
  assert.equal(d.changes.counts.siteChange, 1, '기준 판 = 변경 전 모습');
});

test('반증 L-1 · M-1: 압축 해제 상한을 넘는 판은 읽지 못함 · 차이 결과는 사본(캐시 오염 없음)', async () => {
  const db = await R.openRackDb();
  const l = await R.listVersions('kr');
  await R.versionDetail('kr', l[1].id);   // 첫 호출이 캐시를 채운다
  const d1 = await R.versionDetail('kr', l[1].id);   // 캐시에서 온 값
  d1.restore.items.length = 0; d1.version.user = 'tampered';
  const d2 = await R.versionDetail('kr', l[1].id);
  assert.notEqual(d2.version.user, 'tampered', '캐시된 결과를 호출자가 바꿔도 다음 응답은 그대로');
  assert.equal(await R.versionDetail('pl', l[1].id), null, '다른 법인의 판 id 로는 차이를 볼 수 없다');
  const bomb = zlib.gzipSync(Buffer.alloc(R.SNAP_MAX_BYTES + 1024, 0x20), { level: 9 });
  db.prepare('UPDATE rack_version SET data = ? WHERE id = ?').run(bomb, l[2].id);
  const warn = console.warn; const seen = []; console.warn = (m) => seen.push(String(m));
  try { assert.equal((await R.versionDetail('kr', l[2].id)).readable, false); } finally { console.warn = warn; }
  assert.ok(seen.some((m) => m.includes('판을 풀지 못했습니다')), '실패를 조용히 삼키지 않는다');
});

test('반증 L-2: 판에 전산실이 없는 되돌리기로 사라진 전산실도 rev 바닥값을 남긴다', async () => {
  const sid = (await R.addSite({ corpId: 'pl', name: 'PL-KRK', user: 'admin' })).id;
  const siteOnly = (await R.listVersions('pl'))[0];
  const rid = (await R.addRoom({ siteId: sid, name: '크라쿠프', user: 'admin' })).id;
  const db = await R.openRackDb();
  db.prepare('UPDATE rack_room SET rev = 900000 WHERE id = ?').run(rid);   // 오래 편집된 전산실(전역 최댓값)
  const withRoom = (await R.addRack({ roomId: rid, rev: 900000, user: 'admin', input: { name: 'K1', heightU: 42 } }));
  const vRoom = (await R.listVersions('pl'))[0];
  // 다른 법인 판들 정리 없이 pl 을 '데이터센터만' 판으로 → 전산실이 사라진다(이 되돌리기는 pl 전산실을 하나도 되살리지 않는 판이 아니므로 사이트만 판을 고른다)
  await R.restoreVersion({ corpId: 'pl', versionId: siteOnly.id, expectLatestId: vRoom.id, user: 'admin' });
  await R.restoreVersion({ corpId: 'pl', versionId: vRoom.id, expectLatestId: (await R.listVersions('pl'))[0].id, user: 'admin' });
  assert.ok((await R.getRoom(rid)).room.rev > withRoom.rev, '사라졌던 전산실이 옛 rev 이하로 돌아오지 않는다');
});

test.after(() => R._closeForTest());
