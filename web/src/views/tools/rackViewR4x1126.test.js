// 랙 실장도 4회차 점검(2026-11-26) — 화면 판정을 순수 함수로 뺀 것(테스트 공백 축 6절 · 3회차 반증 C5: RackTool.jsx 의 3회차 MEDIUM 수정을 되돌려도 테스트가 전부 통과했다)
//   + 컴포넌트가 그 함수들을 실제로 쓰는지(배선)를 소스로 확인한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as V from './rackView.js';

describe('spotVisible — 쓰기의 대상 자리를 지금도 보고 있을 때만 알린다', () => {
  const now = { corp: 'kr', site: 's1', room: 'r1' };
  it('정한 칸만 따진다(정하지 않은 칸은 무엇이든 참)', () => {
    expect(V.spotVisible({}, now)).toBe(true); expect(V.spotVisible(null, now)).toBe(true);
    expect(V.spotVisible({ room: '', site: '', corp: '' }, now)).toBe(true);
    expect(V.spotVisible({ room: 'r1' }, now)).toBe(true); expect(V.spotVisible({ room: 'r2' }, now)).toBe(false);
    expect(V.spotVisible({ site: 's1' }, now)).toBe(true); expect(V.spotVisible({ site: 's2' }, now)).toBe(false);
    expect(V.spotVisible({ corp: 'kr' }, now)).toBe(true); expect(V.spotVisible({ corp: 'pl' }, now)).toBe(false);
  });
  it('여럿을 정했으면 전부 맞아야 한다', () => {
    expect(V.spotVisible({ room: 'r1', site: 's1', corp: 'kr' }, now)).toBe(true);
    expect(V.spotVisible({ room: 'r1', site: 's1', corp: 'pl' }, now)).toBe(false);
    expect(V.spotVisible({ room: 'r1', site: 's9', corp: 'kr' }, now)).toBe(false);
    expect(V.spotVisible({ room: 'r9', site: 's1', corp: 'kr' }, now)).toBe(false);
  });
  it('지금 자리를 모르면 정한 칸은 거짓', () => { expect(V.spotVisible({ corp: 'kr' }, null)).toBe(false); expect(V.spotVisible({}, null)).toBe(true); });
});

describe('lostViewReason · modalWithRoom — 장비 · 랙 창은 연 때의 전산실에만 쓴다', () => {
  it('화면 자료가 없으면 noView · 창을 연 전산실이 다르면 roomChanged · 같거나 전산실을 담지 않은 창이면 통과', () => {
    expect(V.lostViewReason(null, { kind: 'place', roomId: 'r1' })).toBe('noView');
    expect(V.lostViewReason({ room: { id: 'r2' } }, { kind: 'place', roomId: 'r1' })).toBe('roomChanged');
    expect(V.lostViewReason({ room: { id: 'r1' } }, { kind: 'rack', roomId: 'r1' })).toBe('');
    expect(V.lostViewReason({ room: { id: 'r1' } }, { kind: 'types' })).toBe('');
    expect(V.lostViewReason({ room: { id: 'r1' } }, null)).toBe('');
    expect(V.lostViewReason({}, { kind: 'place', roomId: 'r1' })).toBe('roomChanged');
  });
  it('장비 · 랙 창에만 전산실을 담는다 — 이미 담겼으면 그대로 · 다른 창 · null 은 그대로', () => {
    expect(V.modalWithRoom({ kind: 'place', init: {} }, 'r1')).toEqual({ kind: 'place', init: {}, roomId: 'r1' });
    expect(V.modalWithRoom({ kind: 'rack', init: {} }, 'r1').roomId).toBe('r1');
    const kept = { kind: 'place', roomId: 'r0' }; expect(V.modalWithRoom(kept, 'r1')).toBe(kept);
    for (const kind of ['site', 'room', 'site-edit', 'room-edit', 'versions', 'types']) { const m = { kind }; expect(V.modalWithRoom(m, 'r1')).toBe(m); }
    expect(V.modalWithRoom(null, 'r1')).toBe(null);
  });
});

describe('conflictHint — 충돌 뒤 안내의 갈래', () => {
  it('최신을 불러왔으면 fresh · 404/403 이면 gone · 그 밖의 실패는 stale', () => {
    expect(V.conflictHint({ room: {} }, null)).toBe('fresh'); expect(V.conflictHint({ room: {} }, { status: 404 })).toBe('fresh');
    expect(V.conflictHint(null, { status: 404 })).toBe('gone'); expect(V.conflictHint(null, { status: 403 })).toBe('gone');
    expect(V.conflictHint(null, { status: 500 })).toBe('stale'); expect(V.conflictHint(null, null)).toBe('stale'); expect(V.conflictHint(null, { status: 400 })).toBe('stale');
  });
});

describe('nameTarget — 이름 창은 연 때 담은 대상에 쓴다(3회차 MEDIUM)', () => {
  const at = { corp: 'kr', site: 's-now', room: 'r-now' };
  it('추가 창: 창에 담긴 법인 · 데이터센터가 먼저 · 없을 때만 지금 자리', () => {
    expect(V.nameTarget({ kind: 'site', corpId: 'pl' }, at)).toEqual({ corpId: 'pl' });
    expect(V.nameTarget({ kind: 'site' }, at)).toEqual({ corpId: 'kr' });
    expect(V.nameTarget({ kind: 'room', siteId: 's-open' }, at)).toEqual({ siteId: 's-open' });
    expect(V.nameTarget({ kind: 'room' }, at)).toEqual({ siteId: 's-now' });
    expect(V.nameTarget({ kind: 'room' }, null)).toEqual({ siteId: '' });
  });
  it('이름 바꾸기 · 지우기 창: 창에 담긴 id 만 — 지금 고른 항목으로 떨어지지 않는다', () => {
    expect(V.nameTarget({ kind: 'room-edit', id: 'r-open' }, at)).toEqual({ id: 'r-open' });
    expect(V.nameTarget({ kind: 'site-edit', id: 's-open' }, at)).toEqual({ id: 's-open' });
    expect(V.nameTarget({ kind: 'room-edit' }, at)).toEqual({ id: '' });
    expect(V.nameTarget({ kind: 'site-edit' }, at)).toEqual({ id: '' });
  });
  it('다른 창 · 없음은 빈 대상', () => { expect(V.nameTarget({ kind: 'place' }, at)).toEqual({}); expect(V.nameTarget(null, at)).toEqual({}); });
});

describe('viewAfterMove · roomSummary — 합계가 낡은 랙(정확성 3)', () => {
  const view = (places) => ({ room: { id: 'A' }, racks: [{ id: 'k1', heightU: 42, totals: { usedU: 1 } }, { id: 'k2', heightU: 42, totals: { usedU: 4 } }], places });
  it('같은 랙 안에서 옮겨도 그 랙에 반깊이 장비가 있으면 합계를 낡음으로 표시한다(앞 · 뒤가 같은 U 면 한 번만 세므로 사용 U 가 바뀐다)', () => {
    const v = view([{ id: 'f', rackId: 'k1', uStart: 5, face: 'front' }, { id: 'r', rackId: 'k1', uStart: 5, face: 'rear' }]);
    const out = V.viewAfterMove(v, 'A', 'f', 'k1', 6);
    expect(out.racks.map((k) => !!k.totalsStale)).toEqual([true, false]);
    const other = view([{ id: 'x', rackId: 'k1', uStart: 5, face: 'full' }, { id: 'h', rackId: 'k2', uStart: 1, face: 'rear' }]);
    expect(V.viewAfterMove(other, 'A', 'x', 'k1', 9).racks).toBe(other.racks);   // 반깊이 장비는 다른 랙에만 — 이 랙 합계는 그대로
    const noFace = view([{ id: 'x', rackId: 'k1', uStart: 5 }, { id: 'y', rackId: 'k1', uStart: 7 }]);
    expect(V.viewAfterMove(noFace, 'A', 'x', 'k1', 9).racks).toBe(noFace.racks);   // face 가 없으면 전체 깊이로 본다
  });
  it('요약: 낡은 랙이 하나라도 있으면 usedStale — 없으면 거짓', () => {
    const v = view([{ id: 'x', rackId: 'k1', uStart: 5, face: 'full' }]);
    expect(V.roomSummary(v).usedStale).toBe(false);
    expect(V.roomSummary(V.viewAfterMove(v, 'A', 'x', 'k2', 3)).usedStale).toBe(true);
    expect(V.roomSummary(null).usedStale).toBe(false);
  });
});

describe('RackTool.jsx 배선 — 컴포넌트가 위 판정을 실제로 쓴다', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'RackTool.jsx'), 'utf8');
  it('이름 창의 쓰기는 nameTarget 의 대상으로 — 지금 고른 siteId · roomId 로 쓰지 않는다', () => {
    for (const bad of [/op: 'site\.rename', id: siteId/, /op: 'site\.remove', id: siteId/, /op: 'room\.rename', id: roomId/, /op: 'room\.remove', id: roomId/, /op: 'site\.add', corpId,/, /op: 'room\.add', siteId,/]) expect(src).not.toMatch(bad);
    expect(src.match(/nameTarget\(modal(?:, at)?\)/g)?.length).toBe(6);
    for (const op of ['site.rename', 'site.remove', 'room.rename', 'room.remove']) expect(src).toMatch(new RegExp(`op: '${op.replace('.', '\\.')}', id[,} ]`));
    expect(src).toMatch(/op: 'site\.add', corpId: target/); expect(src).toMatch(/op: 'room\.add', siteId: target/);
  });
  it('이름 창을 열 때 대상을 담는다 · 장비 · 랙 창은 setModal 이 전산실을 담는다', () => {
    expect(src).toMatch(/kind: 'site-edit', id: siteId, name:/); expect(src).toMatch(/kind: 'room-edit', id: view\.room\.id, name:/);
    expect(src).toMatch(/kind: 'site', corpId \}/); expect(src).toMatch(/kind: 'room', siteId, siteName:/);
    expect(src).toMatch(/setModalRaw\(modalWithRoom\(m, roomIdRef\.current\)\)/);
    expect(src).not.toMatch(/setModalRaw\(m\)/);
  });
  it('쓰기 뒤 선택 이동은 unmoved(sameSpot) 일 때만 · 알림은 spotVisible 일 때만 · 저장 전 확인은 lostViewReason', () => {
    expect(src).toMatch(/if \(unmoved\(at\)\) setSiteId\(r\.id\)/); expect(src).toMatch(/if \(unmoved\(at\)\) setRoomId\(r\.id\)/);
    expect(src).not.toMatch(/await loadTree\(\); set(?:Site|Room)Id\(r\.id\)/);
    expect(src).toMatch(/const unmoved = \(at\) => sameSpot\(at, whereNow\(\)\)/);
    expect(src).toMatch(/const sameRoom = \(\) => spotVisible\(\{ room: writeRoom, site: writeSite, corp: writeCorp \}/);
    expect(src).toMatch(/lostViewReason\(view, modal\)/); expect(src).toMatch(/conflictHint\(fresh, lastRoomErr\.current\)/);
    expect(src.match(/if \(lostView\(\)\) return;/g)?.length).toBe(4);   // 장비 저장(savePlace) · 장비 빼기 · 랙 저장 · 랙 지우기
  });
  it('낡은 화면은 편집을 잠근다 · 조회 실패 · 끌어 놓기 반영은 순수 함수로 · 되돌리기 실패를 부모가 받는다', () => {
    expect(src).toMatch(/const canEdit = !!view\?\.canEdit && !view\.staleErr;/);
    expect(src).toMatch(/setView\(\(v\) => viewAfterLoadFail\(v, id, my, e\)\)/);
    expect(src).toMatch(/setView\(\(v\) => viewAfterMove\(v, writeRoom, d\.id, rack\.id, c\.uStart\)\)/);
    expect(src).toMatch(/setView\(\{ \.\.\.v, loadSeq: my \}\)/);
    expect(src).toMatch(/onFailed=\{\(text, forCorp\) =>/); expect(src.match(/onFailed\?\.\(/g)?.length).toBe(2);
    expect(src).toMatch(/rack\.totalsStale \? `— \/ \$\{H\}U`/); expect(src).toMatch(/sum\.usedStale \?/);
  });
  it('저장 중 줄은 busy · slowSave · 창 없음이 함께일 때만 · 다시 불러오는 중 표시는 자리를 차지하는 줄이 아니다(5회차 화면 1 · 2)', () => {
    expect(src).toMatch(/\{busy && slowSave && !modal \? <div role="status"/);
    expect(src).not.toMatch(/\{slowSave && !modal \?/);
    expect(src).not.toMatch(/\{loadingRoom \? <div/);
    expect(src).toMatch(/minWidth: 112 \}\} aria-busy=\{loadingRoom && !!view\}/);
    expect(src.match(/error=\{roomChangedText \|\| shownModalErr\}/g)?.length).toBe(2);
    expect(src).toMatch(/const shownModalErr = modalErr === ROOM_CHANGED_TEXT \? '' : modalErr;/);
  });
});
