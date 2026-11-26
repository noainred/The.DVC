// 랙 실장도 5회차 점검(2026-11-26 · 테스트 공백 축) — 4회차 뒤 순수 함수로 뺀 화면 판정(rackView.js)과 RackTool.jsx 배선의 변이 중
//   기존 테스트(rackView*.test.js 5파일)를 전부 통과한 것을 막는 탐침. 테스트 이름의 번호가 그 변이(scratchpad r5mut/{w,j}.spec).
//   배선은 소스를 읽어 확인하되 **주석을 뺀 글**에서 본다(주석으로 바꾼 줄 · 주석 속 같은 글자에 걸려 통과하지 않게 — J08).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as V from './rackView.js';

describe('viewAfterMove — 같은 랙 안 이동의 합계 표시(W23 · W26)', () => {
  const view = (places) => ({ room: { id: 'A' }, racks: [{ id: 'k1', heightU: 42, totals: { usedU: 3 } }, { id: 'k2', heightU: 42, totals: { usedU: 0 } }], places });
  it('W23: 반깊이 장비와 전체 깊이 장비가 섞인 랙에서 반깊이 장비를 옮기면 그 랙 합계가 낡음 — 전부 반깊이일 때만이 아니다', () => {
    // 앞 · 뒤가 같은 U(5)를 나눠 쓰다가 앞 장비가 U6 으로 가면 사용 U 가 2 → 3 으로 바뀐다(서버 합계는 다시 불러올 때까지 옛 값)
    const v = view([{ id: 'f', rackId: 'k1', uStart: 5, face: 'front' }, { id: 'r', rackId: 'k1', uStart: 5, face: 'rear' }, { id: 'x', rackId: 'k1', uStart: 1, face: 'full' }]);
    const out = V.viewAfterMove(v, 'A', 'f', 'k1', 6);
    expect(out.racks.map((k) => !!k.totalsStale)).toEqual([true, false]);
    expect(out.places.find((p) => p.id === 'f').uStart).toBe(6);
    expect(V.roomSummary(out).usedStale).toBe(true);   // 랙 하나만 낡아도 요약은 낡음(W24 — 전부 낡았을 때만이 아니다)
  });
  it('W26: 옮긴 장비가 전체 깊이여도 그 랙에 반깊이 장비가 있으면 표시한다(주석이 적은 계약 — 그 랙에 반깊이 장비가 있을 때)', () => {
    const v = view([{ id: 'x', rackId: 'k1', uStart: 1, face: 'full' }, { id: 'h', rackId: 'k1', uStart: 5, face: 'rear' }]);
    expect(V.viewAfterMove(v, 'A', 'x', 'k1', 9).racks.map((k) => !!k.totalsStale)).toEqual([true, false]);
  });
});

describe('RackTool.jsx 배선(5회차) — 주석을 뺀 소스에서 본다', () => {
  const raw = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'RackTool.jsx'), 'utf8');
  // 블록 주석(JSX 의 {/* */} 포함) → 줄 주석 순서로 뺀다. 줄 주석은 줄 머리 · 공백 뒤의 '//' 만(문자열 속 'https://' 를 건드리지 않게).
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[ \t])\/\/[^\n]*/gm, '$1');
  const count = (re) => (src.match(re) || []).length;
  it('주석 제거가 코드를 건드리지 않았다(기준 확인)', () => {
    expect(src.length).toBeGreaterThan(raw.length / 2);
    expect(src).toMatch(/export default function RackTool|function RackTool/);
    expect(src).not.toMatch(/4회차 점검 화면 제안/);   // 주석에만 있는 글자
  });
  it('J06: 알림 판정(sameRoom)은 쓰기 대상을 **지금 자리**(ref 의 현재 값)와 견준다', () => {
    expect(src).toContain('const sameRoom = () => spotVisible({ room: writeRoom, site: writeSite, corp: writeCorp }, { room: roomIdRef.current, site: siteIdRef.current, corp: corpIdRef.current });');
  });
  it('J08 · J09: 저장 전 확인 4곳이 주석이 아닌 코드이고, lostView 는 까닭이 있으면 참을 돌려준다', () => {
    expect(count(/if \(lostView\(\)\) return;/g)).toBe(4);
    expect(src).toMatch(/const lostView = \(\) => \{\s*const why = lostViewReason\(view, modal\);[\s\S]{0,400}?return !!why;\s*\};/);
  });
  it('J15 · J18: 전산실이 바뀐 창의 안내를 저장 전에도 장비 창 · 랙 창 둘 다에 싣는다', () => {
    expect(src).toContain("const roomChangedText = lostViewReason(view, modal) === 'roomChanged' ? ROOM_CHANGED_TEXT : '';");
    // 5회차 화면 관찰 뒤: 안내가 먼저이고, 저장을 눌러 남은 같은 문구는 더는 해당하지 않으면 보이지 않는다(shownModalErr)
    expect(count(/error=\{roomChangedText \|\| shownModalErr\}/g)).toBe(2);
    expect(src).toMatch(/<PlaceModal [^\n]*error=\{roomChangedText \|\| shownModalErr\}/); expect(src).toMatch(/<RackModal [^\n]*error=\{roomChangedText \|\| shownModalErr\}/);
    expect(src).toContain("const shownModalErr = modalErr === ROOM_CHANGED_TEXT ? '' : modalErr;");
    expect(src).not.toMatch(/error=\{modalErr \|\| roomChangedText\}/);
    expect(count(/lostViewReason\(view, modal\)/g)).toBe(2);
  });
  it('J12 · J13: 판 되돌리기 실패는 창을 닫았고 그 법인을 보고 있을 때만 알림 줄에', () => {
    expect(src).toContain("if (modalRef.current !== modal && spotVisible({ corp: forCorp }, { corp: corpIdRef.current })) say('err',");
  });
  it("J14: '저장 중' 한 줄은 저장 중이면서 slowSave 일 때만 — busy 만으로 바로 그리지 않고, 저장이 끝난 렌더에 남지도 않는다 · 늦은 저장 판정은 SLOW_SAVE_MS 뒤", () => {
    expect(src).toMatch(/\{busy && slowSave && !modal \? <div role="status"/);
    expect(src).not.toMatch(/\{slowSave && !modal \? <div role="status"/);
    expect(src).not.toMatch(/\{busy && !modal \? <div role="status"/);
    expect(src).toMatch(/if \(!busy\) \{ setSlowSave\(false\); return undefined; \}\s*const t = setTimeout\(\(\) => setSlowSave\(true\), SLOW_SAVE_MS\);\s*return \(\) => clearTimeout\(t\);\s*\}, \[busy\]\);/);
    expect(src).toMatch(/const SLOW_SAVE_MS = \d{3,};/);
  });
  it('J17: 요약 타일은 합계가 낡았으면 사용 U 숫자 대신 — 를, 부제에는 다시 불러오는 중을', () => {
    expect(src).toContain('n={sum.usedStale ? `— / ${sum.totalU}U` : `${sum.usedU} / ${sum.totalU}U`}');
    expect(src).toContain("s={sum.usedStale ? '다시 불러오는 중…' :");
  });
  it('J19: 충돌 안내의 세 갈래 — fresh 만 다시 저장을 권하고, gone 은 닫고 새로 고침', () => {
    expect(src).toMatch(/setModalErr\(hint === 'fresh' \? `[^`]*다시 저장하면 고친 칸만 반영합니다\.` : hint === 'gone' \? `[^`]*창을 닫고 새로 고친 뒤 다시 하세요\.` : `[^`]*잠시 뒤 다시 저장하세요/);
  });
  it('J20: 추가 창의 대상은 nameTarget 의 결과 그대로(지금 고른 항목으로 덮지 않는다)', () => {
    expect(src).toContain('const at = whereNow(); const target = nameTarget(modal, at).corpId;');
    expect(src).toContain('const at = whereNow(); const target = nameTarget(modal, at).siteId;');
    expect(count(/const target = /g)).toBe(2);
  });
});
