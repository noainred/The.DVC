// 랙 실장도 1회차 점검(2026-11-26 · 변이 245건 중 살아남은 173건을 막는 테스트 — 테스트 이름의 번호가 그 변이) — rack/versions.js · rack/layout.js 순수 판정의 테스트 공백.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const V = await import('../src/rack/versions.js');
const L = await import('../src/rack/layout.js');

const id = (c, n = 0) => (c + String(n).padStart(15, '0')).slice(0, 16).replace(/[^a-f0-9]/g, 'a');
const SITE = { id: id('a'), name: 'S', sort: 0 };
const ROOM = { id: id('b'), siteId: SITE.id, name: 'R', sort: 0 };
const RACK = { id: id('c'), roomId: ROOM.id, name: 'A1', row: 'A', typeId: '', heightU: 42, role: 'net', pduA: 1, pduB: 2, sort: 0 };
const PLACE = { id: id('d'), rackId: RACK.id, face: 'full', uStart: 1, uSize: 2, kind: 'server', label: 'x', model: 'R750', serial: 'SER-1', extraSerials: ['EX-1'], note: 'n', ratedW: 750, opW: 500, weightKg: 30 };
const base = () => V.buildSnapshot('kr', { sites: [SITE], rooms: [ROOM], racks: [RACK], places: [PLACE] });
const clone = (x) => JSON.parse(JSON.stringify(x));
const bad = (fn, why) => { const s = clone(base()); fn(s); assert.equal(V.validateSnapshot(s, 'kr'), null, why); };

test('탐침 V03~V18 · V38: validateSnapshot 의 거절 조건 하나하나', () => {
  assert.ok(V.validateSnapshot(base(), 'kr'), '기준 판은 통과');
  bad((s) => { s.rooms = 'x'; }, 'V04 배열이 아닌 rooms');
  bad((s) => { s.places = null; }, 'V04 배열이 아닌 places');
  bad((s) => { s.sites.push({ ...SITE }); }, 'V05 데이터센터 id 중복');
  bad((s) => { s.sites[0].name = ''; }, 'V06 데이터센터 빈 이름');
  bad((s) => { s.rooms[0].id = '../etc'; s.racks[0].roomId = '../etc'; }, 'V07 전산실 id 모양(랙도 그 id 를 가리킨다)');
  bad((s) => { s.rooms.push({ ...ROOM }); }, 'V08 전산실 id 중복');
  bad((s) => { s.racks[0].roomId = id('e'); }, 'V09 랙 → 없는 전산실');
  bad((s) => { s.racks[0].heightU = 0; }, 'V10 랙 높이 0');
  bad((s) => { s.racks[0].heightU = 61; }, 'V10 랙 높이 61');
  bad((s) => { s.racks.push({ ...RACK }); }, 'V11 랙 id 중복');
  bad((s) => { s.racks[0].id = 'RACK-1'; s.places = []; }, 'V17 랙 id 모양');
  bad((s) => { s.places[0].rackId = id('e'); }, 'V12 장비 → 없는 랙');
  bad((s) => { s.places[0].uStart = 0; }, 'V13 시작 U 0');
  bad((s) => { s.places[0].uSize = 0; }, 'V13 높이 0');
  bad((s) => { s.places[0].face = 'side'; }, 'V14 모르는 면');
  bad((s) => { s.places.push({ ...PLACE }); }, 'V15 장비 id 중복');
  bad((s) => { s.places[0].id = "x' OR 1=1"; }, 'V16 장비 id 모양');
  // V03: 개수 상한(판 검사) — 데이터센터 1,001곳
  const many = clone(base()); many.rooms = []; many.racks = []; many.places = [];
  many.sites = Array.from({ length: V.SNAP_CAPS.sites + 1 }, (_, i) => ({ id: i.toString(16).padStart(16, '0'), name: `S${i}`, sort: i }));
  assert.equal(V.validateSnapshot(many, 'kr'), null, 'V03 개수 상한');
  // V18 · V38: 정리(추가 시리얼 16개 · 숫자 아닌 전력은 null)
  const s = clone(base()); s.places[0].extraSerials = Array.from({ length: 20 }, (_, i) => `E${i}`); s.places[0].ratedW = 'abc'; s.places[0].opW = '500';
  const out = V.validateSnapshot(s, 'kr');
  assert.equal(out.places[0].extraSerials.length, 16, 'V18');
  assert.equal(out.places[0].ratedW, null, 'V38 숫자 아닌 전력'); assert.equal(out.places[0].opW, null, 'V38 문자열 수');
});

test('탐침 V37: capExceeded 는 네 항목 모두 본다', () => {
  for (const k of ['sites', 'rooms', 'racks', 'places']) {
    assert.equal(V.capExceeded({ [k]: V.SNAP_CAPS[k] + 1 }), k, k);
    assert.equal(V.capExceeded({ [k]: V.SNAP_CAPS[k] }), '', `${k} 경계`);
  }
});

test('탐침 V02: restorableSnapshot 은 남아 있는 랙 종류를 건드리지 않는다', () => {
  const s = clone(base()); s.racks[0].typeId = id('f');
  assert.equal(V.restorableSnapshot(s, () => true).racks[0].typeId, id('f'), '있는 종류는 그대로');
  assert.equal(V.restorableSnapshot(s, () => false).racks[0].typeId, '', '지워진 종류만 직접 높이로');
});

test('탐침 V19~V22: 차이 — 면 · 높이 변경은 이동, 필드별 수정', () => {
  const a = base();
  for (const [f, v] of [['face', 'front'], ['uSize', 3], ['uStart', 5]]) {
    const b = clone(a); b.places[0][f] = v;
    const d = V.diffSnapshots(a, b);
    assert.equal(d.counts.placeMove, 1, `V19 ${f} 변경은 이동`); assert.equal(d.counts.placeChange, 0, f);
  }
  for (const [f, v] of [['kind', 'storage'], ['model', 'R760'], ['serial', 'SER-2'], ['extraSerials', ['EX-2']], ['note', 'm'], ['ratedW', 800], ['opW', null], ['weightKg', 31]]) {
    const b = clone(a); b.places[0][f] = v;
    const d = V.diffSnapshots(a, b);
    assert.deepEqual(d.items.find((i) => i.op === 'change')?.fields, [f], `V20 ${f}`); assert.equal(d.counts.placeMove, 0);
  }
  for (const [f, v] of [['row', 'B'], ['heightU', 45], ['role', 'x'], ['pduA', 3], ['pduB', 0]]) {
    const b = clone(a); b.racks[0][f] = v;
    assert.deepEqual(V.diffSnapshots(a, b).items.find((i) => i.type === 'rack')?.fields, [f], `V21 ${f}`);
  }
  const b = clone(a); b.sites.push({ id: id('a', 9), name: 'S2', sort: 1 }); b.rooms[0].siteId = id('a', 9);
  const d = V.diffSnapshots(a, b);
  assert.deepEqual(d.items.find((i) => i.type === 'room')?.fields, ['siteId'], 'V22 전산실이 다른 데이터센터로');
  assert.equal(d.counts.siteAdd, 1, 'V29');
  assert.equal(V.diffSnapshots(b, a).counts.siteRemove, 1, 'V28');
});

test('탐침 V23~V27 · V39: 차이 — 상한 · 생략 수 · 위치 글자(추가는 새 판 랙 이름 · 삭제는 옛 판 랙 이름 · 면 표시)', () => {
  const a = base();
  const b = clone(a);
  for (let i = 0; i < 305; i += 1) b.places.push({ ...PLACE, id: `9${(i + 1).toString(16).padStart(15, '0')}`, uStart: 3, uSize: 1, face: 'front' });
  const d = V.diffSnapshots(a, b);
  assert.equal(d.counts.placeAdd, 305); assert.equal(d.items.length, 300, 'V24'); assert.equal(d.omitted, 5, 'V23');
  // 새 랙에 놓인 장비 · 사라진 랙에 있던 장비 · 새 랙으로 옮긴 장비
  const c = clone(a);
  c.racks = [{ ...RACK, id: id('c', 7), name: 'NEW' }];
  c.places = [{ ...PLACE, rackId: id('c', 7), uStart: 10, face: 'rear' }, { ...PLACE, id: id('d', 5), rackId: id('c', 7), uStart: 20, uSize: 1, face: 'front', label: 'added' }];
  const e = V.diffSnapshots(a, c);
  assert.equal(e.items.find((i) => i.type === 'place' && i.op === 'add').where, 'NEW U20(앞)', 'V25 · V39');
  assert.equal(e.items.find((i) => i.type === 'place' && i.op === 'move').where, 'A1 U1–2 → NEW U10–11(뒤)', 'V27 · V39');
  const f = V.diffSnapshots(c, a);
  assert.equal(f.items.find((i) => i.type === 'place' && i.op === 'remove').where, 'NEW U20(앞)', 'V26');
  assert.equal(f.counts.rackRemove, 1); assert.equal(f.counts.rackAdd, 1);
});

test('탐침 V35: 이름 없는 장비의 차이에 시리얼 값을 싣지 않는다', () => {
  const a = base();
  const b = clone(a); b.places = [{ ...PLACE, label: '', serial: 'SECRETTAG9', uStart: 9 }, { ...PLACE, id: id('d', 3), label: '', serial: 'SECRETTAG8', uStart: 20 }];
  for (const d of [V.diffSnapshots(a, b), V.diffSnapshots(b, a), V.diffSnapshots(b, { ...clone(b), places: [{ ...b.places[0], note: 'z' }] })]) {
    assert.ok(!JSON.stringify(d).includes('SECRETTAG'), JSON.stringify(d.items));
  }
});

test('탐침 L01~L04 · L07: layout 순수 판정', () => {
  assert.equal(L.nonNeg('1.234'), 1.23, 'L01 소수 둘째 자리');
  assert.equal(L.rackTotals({ heightU: 10 }, [{ uStart: 1, uSize: 1, opW: 0.1 }, { uStart: 2, uSize: 1, opW: 0.2 }]).opW, 0.3, 'L02 합계 반올림');
  assert.equal(L.rackTotals({ heightU: 10 }, [{ uStart: 1, uSize: 3 }]).freeU, 7, 'L03 남은 U');
  assert.deepEqual(L.cleanPlaceInput({ uStart: 1, uSize: 1, label: 'x', extraSerials: 'A1, A1 / B2' }).value.extraSerials, ['A1', 'B2'], 'L04 같은 추가 시리얼은 한 번');
  assert.deepEqual(L.cleanPlaceInput({ ratedW: '', opW: null }, { partial: true }).value, { ratedW: null, opW: null }, 'L07 부분 수정에서 비운 전력은 null(지우기)');
});
