// 랙 실장도 — 2회차 반증 · 3회차 화면 축의 남은 항목(2026-11-26): 낡음 표시는 화면 자료에 · 늦은 응답의 자리 대조 · 끌어 놓기 반영의 합계 표시
import { describe, it, expect } from 'vitest';
import * as V from './rackView.js';

const view = (id, extra = {}) => ({ room: { id }, rev: 3, loadSeq: 5, racks: [{ id: 'k1', totals: { usedU: 8 } }, { id: 'k2', totals: { usedU: 14 } }, { id: 'k3', totals: { usedU: 1 } }],
  places: [{ id: 'p1', rackId: 'k1', uStart: 5 }, { id: 'p2', rackId: 'k1', uStart: 9 }], ...extra });

describe('viewAfterLoadFail — 낡음 표시는 그 전산실의 화면 자료에 붙는다(B-3)', () => {
  const e500 = { status: 500, message: 'x' };
  it('그 전산실의 직전 화면이 남아 있으면 staleErr 를 붙이고 나머지는 그대로', () => {
    const v = view('A'); const out = V.viewAfterLoadFail(v, 'A', 6, e500);
    expect(out.staleErr).toBe(e500); expect(out.places).toBe(v.places); expect(out.rev).toBe(3); expect(v.staleErr).toBeUndefined();
  });
  it('다른 전산실의 자료 · 자료 없음은 건드리지 않는다', () => {
    const v = view('B'); expect(V.viewAfterLoadFail(v, 'A', 6, e500)).toBe(v); expect(V.viewAfterLoadFail(null, 'A', 6, e500)).toBe(null);
  });
  it('이 시도보다 나중에 받은 자료는 잠그지 않는다(늦게 온 옛 실패) — 같은 시도 · 앞선 시도의 자료는 잠근다', () => {
    const fresh = view('A', { loadSeq: 7 }); expect(V.viewAfterLoadFail(fresh, 'A', 6, e500)).toBe(fresh);
    expect(V.viewAfterLoadFail(view('A', { loadSeq: 6 }), 'A', 6, e500).staleErr).toBe(e500);
    expect(V.viewAfterLoadFail({ room: { id: 'A' } }, 'A', 1, e500).staleErr).toBe(e500);
  });
  it('없어짐(404) · 권한 없음(403)이면 비운다 — 그것도 그 전산실의 옛 자료일 때만', () => {
    expect(V.viewAfterLoadFail(view('A'), 'A', 6, { status: 404 })).toBe(null);
    expect(V.viewAfterLoadFail(view('A'), 'A', 6, { status: 403 })).toBe(null);
    const other = view('B'); expect(V.viewAfterLoadFail(other, 'A', 6, { status: 404 })).toBe(other);
    const fresh = view('A', { loadSeq: 9 }); expect(V.viewAfterLoadFail(fresh, 'A', 6, { status: 404 })).toBe(fresh);
  });
  it('한 번 붙은 표시는 다른 전산실 실패로 지워지지 않는다(B-3 경로: A 실패 → B 실패 → A 로 돌아옴)', () => {
    const a = V.viewAfterLoadFail(view('A'), 'A', 6, e500);
    const afterB = V.viewAfterLoadFail(a, 'B', 7, e500);
    expect(afterB).toBe(a); expect(afterB.staleErr).toBe(e500);
  });
  it('오류 객체가 없어도 표시는 참', () => { expect(V.viewAfterLoadFail(view('A'), 'A', 6, null).staleErr).toBe(true); });
});

describe('sameSpot — 쓰기를 시작한 자리에서 옮기지 않았을 때만 선택을 새 항목으로 옮긴다(C5 · 3회차 화면 1)', () => {
  const m = { kind: 'room' }; const at = { corp: 'kr', site: 's1', room: 'r1', modal: m };
  it('같은 자리 · 창이 닫혔거나 그 창 그대로면 참', () => {
    expect(V.sameSpot(at, { corp: 'kr', site: 's1', room: 'r1', modal: null })).toBe(true);
    expect(V.sameSpot(at, { corp: 'kr', site: 's1', room: 'r1', modal: m })).toBe(true);
  });
  it('법인 · 데이터센터 · 전산실 중 하나라도 바뀌었으면 거짓', () => {
    expect(V.sameSpot(at, { corp: 'pl', site: 's1', room: 'r1', modal: null })).toBe(false);
    expect(V.sameSpot(at, { corp: 'kr', site: 's2', room: 'r1', modal: null })).toBe(false);
    expect(V.sameSpot(at, { corp: 'kr', site: 's1', room: 'r2', modal: null })).toBe(false);
  });
  it('다른 창이 열려 있으면 거짓(같은 종류의 새 창도 다른 창이다)', () => {
    expect(V.sameSpot(at, { corp: 'kr', site: 's1', room: 'r1', modal: { kind: 'room-edit' } })).toBe(false);
    expect(V.sameSpot(at, { corp: 'kr', site: 's1', room: 'r1', modal: { kind: 'room' } })).toBe(false);
  });
  it('자리를 모르면 거짓', () => { expect(V.sameSpot(null, at)).toBe(false); expect(V.sameSpot(at, null)).toBe(false); });
});

describe('viewAfterMove — 끌어 놓기 반영(C6)', () => {
  it('랙을 건너 옮기면 위치를 바꾸고 두 랙의 합계만 낡음으로 표시한다', () => {
    const v = view('A'); const out = V.viewAfterMove(v, 'A', 'p1', 'k2', 30);
    expect(out.places.find((p) => p.id === 'p1')).toEqual({ id: 'p1', rackId: 'k2', uStart: 30 });
    expect(out.places.find((p) => p.id === 'p2')).toBe(v.places[1]);
    expect(out.racks.map((k) => !!k.totalsStale)).toEqual([true, true, false]);
    expect(out.racks[0].totals).toEqual({ usedU: 8 }); expect(v.racks[0].totalsStale).toBeUndefined();
    expect(out.rev).toBe(3); expect(out.loadSeq).toBe(5);
  });
  it('같은 랙 안에서 옮기면 합계는 그대로(표시하지 않는다)', () => {
    const v = view('A'); const out = V.viewAfterMove(v, 'A', 'p1', 'k1', 20);
    expect(out.places[0].uStart).toBe(20); expect(out.racks).toBe(v.racks);
  });
  it('다른 전산실의 자료 · 없는 장비 · 자료 없음은 그대로', () => {
    const v = view('B'); expect(V.viewAfterMove(v, 'A', 'p1', 'k2', 1)).toBe(v);
    const a = view('A'); expect(V.viewAfterMove(a, 'A', 'nope', 'k2', 1)).toBe(a);
    expect(V.viewAfterMove(null, 'A', 'p1', 'k2', 1)).toBe(null);
  });
  it('낡음 표시(staleErr)는 옮겨도 남는다', () => {
    const v = V.viewAfterLoadFail(view('A'), 'A', 6, { status: 500 });
    expect(V.viewAfterMove(v, 'A', 'p1', 'k2', 30).staleErr).toEqual({ status: 500 });
  });
});
