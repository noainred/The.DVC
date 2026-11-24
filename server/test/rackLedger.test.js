/**
 * 랙 실장도 원장(rack/layout.js 순수 판정 + rack/db.js 저장소) 회귀.
 * 설계: docs/design/rack-elevation/README.md — 겹침 · 범위 · rev 충돌 · 남은 자료가 있는 상위 삭제 거절 · 이력 · 부분 합.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rack-'));
process.env.RACK_DB = path.join(dir, 'rack.db');

const L = await import('../src/rack/layout.js');
const D = await import('../src/rack/db.js');

test('layout: 면 — full 은 모두와 부딪히고 front/rear 는 같은 U 에 함께 놓인다', () => {
  assert.equal(L.facesClash('full', 'front'), true);
  assert.equal(L.facesClash('front', 'rear'), false);
  assert.equal(L.facesClash('rear', 'rear'), true);
});

test('layout: placementIssue — 범위 · 겹침 · 자기 자신 무시 · 경계(맞닿음은 겹침 아님)', () => {
  const rack = { heightU: 42 };
  const places = [{ id: 'a', face: 'full', uStart: 3, uSize: 2, label: 'srv-a' }, { id: 'p', face: 'front', uStart: 42, uSize: 1, label: '패치' }];
  assert.equal(L.placementIssue(rack, places, { face: 'full', uStart: 5, uSize: 2 }), null, 'U5 는 U3–4 와 맞닿을 뿐');
  assert.equal(L.placementIssue(rack, places, { face: 'full', uStart: 4, uSize: 1 }).code, 'overlap');
  assert.equal(L.placementIssue(rack, places, { face: 'rear', uStart: 42, uSize: 1 }), null, '앞 반깊이 뒤에 후면 장비');
  assert.equal(L.placementIssue(rack, places, { face: 'full', uStart: 42, uSize: 1 }).code, 'overlap');
  assert.equal(L.placementIssue(rack, places, { face: 'full', uStart: 41, uSize: 3 }).code, 'range');
  assert.equal(L.placementIssue(rack, places, { face: 'full', uStart: 0, uSize: 1 }).code, 'range');
  assert.equal(L.placementIssue(rack, places, { face: 'full', uStart: 3, uSize: 2 }, 'a'), null, '옮기는 장비 자신과는 겹침 아님');
  assert.equal(L.placementIssue(rack, places, { face: 'side', uStart: 10, uSize: 1 }).code, 'input');
});

test('layout: 입력 정리 — 높이를 모르면 1U 로 가정하지 않는다 · 빈 전력은 null(0 아님) · 음수 거절', () => {
  assert.match(L.cleanPlaceInput({ uStart: 3, label: 'x' }).error, /높이/);
  const ok = L.cleanPlaceInput({ uStart: '3', uSize: '2', label: ' srv\u0007 ', kind: 'server', ratedW: '', opW: '560', weightKg: 33 });
  assert.equal(ok.value.label, 'srv');
  assert.equal(ok.value.ratedW, null);
  assert.equal(ok.value.opW, 560);
  assert.match(L.cleanPlaceInput({ uStart: 3, uSize: 1, label: 'x', opW: -1 }).error, /0 이상/);
  assert.match(L.cleanPlaceInput({ uStart: 3, uSize: 1 }).error, /이름이나 시리얼/);
  assert.match(L.cleanPlaceInput({ uStart: 1.5, uSize: 1, label: 'x' }).error, /시작 U/);
  const part = L.cleanPlaceInput({ uStart: 7 }, { partial: true });
  assert.deepEqual(part.value, { uStart: 7 }, '수정은 온 필드만');
  assert.deepEqual(L.cleanPlaceInput({ uStart: 1, uSize: 4, label: 'h700', extraSerials: 'A1 / B2, a1' }).value.extraSerials, ['A1', 'B2', 'a1']);
});

test('layout: 랙 입력 — 종류를 고르면 높이 칸 없이도 받는다(높이는 종류에서) · 종류도 높이도 없으면 거절', () => {
  assert.deepEqual(L.cleanRackInput({ name: 'A4', typeId: 'abc' }).value.heightU, undefined);
  assert.match(L.cleanRackInput({ name: 'A4' }).error, /높이/);
  assert.match(L.cleanRackInput({ name: 'A4', typeId: '', heightU: 0 }).error, /높이/);
  assert.equal(L.cleanRackInput({ name: 'A4', heightU: '45' }).value.heightU, 45);
});

test('layout: 합계 — 못 읽은 값은 합에 넣지 않고 읽은 대수를 함께 · 앞/뒤 반깊이는 U 를 한 번만', () => {
  const t = L.rackTotals({ heightU: 40 }, [
    { uStart: 1, uSize: 2, opW: 560, ratedW: 750, weightKg: 33 },
    { uStart: 3, uSize: 1, opW: null, ratedW: 381, weightKg: null, face: 'front' },
    { uStart: 3, uSize: 1, opW: 52, ratedW: null, weightKg: 5.8, face: 'rear' },
  ]);
  assert.equal(t.usedU, 3);
  assert.equal(t.usePct, 8);
  assert.equal(t.opW, 612); assert.equal(t.opRead, 2);
  assert.equal(t.ratedW, 1131); assert.equal(t.ratedRead, 2);
  assert.equal(L.rackTotals({ heightU: 42 }, []).opW, null, '읽은 것이 없으면 0 이 아니라 null');
});

test('layout: 시리얼 키 — 색인과 같은 정규화', async () => {
  const { normKey } = await import('../src/insights/serialKey.js');
  assert.equal(L.serialKeyOf(' 7QX-2k:M3 '), normKey('7qx2km3'));
});

test('db: 데이터센터 → 전산실 → 랙 → 배치 · rev 충돌 409 · 겹침 409 · 이력', async () => {
  const s = await D.addSite({ corpId: 'kr', name: 'KR-SEL', user: 'admin' });
  await assert.rejects(D.addSite({ corpId: 'kr', name: 'KR-SEL', user: 'admin' }), (e) => e.status === 409);
  const r = await D.addRoom({ siteId: s.id, name: '전산실 A', user: 'admin' });
  const t = await D.addType({ name: '스토리지 랙 40U', heightU: 40 });
  let room = await D.getRoom(r.id);
  assert.equal(room.room.rev, 0);
  const a = await D.addRack({ roomId: r.id, rev: 0, user: 'admin', input: { name: 'S38', row: 'S', typeId: t.id, heightU: 42, pduA: 2, pduB: 2 } });
  assert.equal(a.rev, 1);
  room = await D.getRoom(r.id);
  assert.equal(room.racks[0].heightU, 40, '종류를 고르면 높이는 종류에서');
  await assert.rejects(D.addRack({ roomId: r.id, rev: 0, user: 'b', input: { name: 'S39', heightU: 42 } }),
    (e) => e.status === 409 && e.extra.code === 'revConflict' && e.extra.rev === 1);
  await assert.rejects(D.addRack({ roomId: r.id, user: 'b', input: { name: 'S39', heightU: 42 } }), (e) => e.status === 400);
  const p1 = await D.addPlace({ roomId: r.id, rev: 1, user: 'admin', rackId: a.id, input: { face: 'full', uStart: 1, uSize: 4, kind: 'storage', label: 'H700 #1-4', serial: 'CF2Y-01', extraSerials: ['CF2Y-02', 'cf2y03'] } });
  await assert.rejects(D.addPlace({ roomId: r.id, rev: p1.rev, user: 'admin', rackId: a.id, input: { face: 'full', uStart: 4, uSize: 1, kind: 'other', label: 'x' } }),
    (e) => e.status === 409 && e.extra.code === 'overlap');
  const keys = await D.placedSerialKeys('kr');
  assert.ok(keys.has('cf2y01') && keys.has('cf2y02') && keys.has('cf2y03'));
  // 옮기기 — 다른 랙으로
  const b = await D.addRack({ roomId: r.id, rev: p1.rev, user: 'admin', input: { name: 'S39', heightU: 42 } });
  const mv = await D.updatePlace({ roomId: r.id, rev: b.rev, user: 'kim', id: p1.id, rackId: b.id, input: { uStart: 10 } });
  room = await D.getRoom(r.id);
  assert.equal(room.places[0].rackId, b.id);
  assert.equal(room.places[0].uStart, 10);
  assert.equal(room.places[0].uSize, 4, '온 필드만 바뀐다');
  assert.equal(room.logs[0].action, 'place.move');
  assert.match(room.logs[0].detail, /S38 U1–4 → S39 U10–13/);
  // 높이를 줄여 넘치면 거절 · 장비가 남은 랙 · 랙이 남은 전산실 · 전산실이 남은 데이터센터 삭제 거절
  await assert.rejects(D.updateRack({ roomId: r.id, rev: mv.rev, user: 'admin', id: b.id, input: { heightU: 12 } }), (e) => e.status === 409 && e.extra.overflow.length === 1);
  await assert.rejects(D.removeRack({ roomId: r.id, rev: mv.rev, user: 'admin', id: b.id }), (e) => e.status === 409);
  await assert.rejects(D.removeRoom({ id: r.id, user: 'admin' }), (e) => e.status === 409);
  await assert.rejects(D.removeSite({ id: s.id, user: 'admin' }), (e) => e.status === 409);
  await assert.rejects(D.removeType({ id: t.id }), (e) => e.status === 409, '쓰는 랙이 있는 종류');
  const rm = await D.removePlace({ roomId: r.id, rev: mv.rev, user: 'admin', id: p1.id });
  const rr = await D.removeRack({ roomId: r.id, rev: rm.rev, user: 'admin', id: b.id });
  assert.equal(rr.rev, mv.rev + 2);
  // 소속 법인 찾기
  assert.deepEqual(await D.corpOf('rack', a.id), { corpId: 'kr', roomId: r.id });
  assert.equal(await D.corpOf('rack', 'nope'), null);
  const tree = await D.listTree(new Set(['kr']));
  assert.equal(tree.rooms[0].racks, 1);
  assert.equal((await D.listTree(new Set(['jp']))).sites.length, 0, '다른 법인은 보이지 않는다');
});

test.after(() => { D._closeForTest(); fs.rmSync(dir, { recursive: true, force: true }); });
