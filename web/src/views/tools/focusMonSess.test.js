/**
 * 서버 집중 모니터링 v2.979 — 수집 종료 단추 · 중복 모니터링 방지 · 진행 중인 수집에 더하기(화면 쪽).
 * 사용자 요청(2026-11-12): "모니터링 종료 하는 버튼" · "중복 모니터링 방지" · "기존 모니터링 돌고있는데, 추가하면 잘 안되" → 선택 '빼고 시작 + 수집에 추가'.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { sessionIndex, sessionLabel, startNote, joinResultText, ENDED_TEXT } from './focusMonText.js';
import { stripComments } from '../../test/_stripComments.js';

const S1 = { id: 'fs-1', mode: 'watch', interval: 2, by: 'kim', targets: ['a', 'b'], until: 1_000_000 + 5 * 60_000 };
const S2 = { id: 'fs-2', mode: 'record', interval: 10, by: '', targets: ['c'], until: null };

describe('진행 중인 수집 글 · 중복 안내', () => {
  it('서버 → 수집 색인', () => {
    const m = sessionIndex([S1, S2]);
    expect(m.get('a').id).toBe('fs-1'); expect(m.get('c').id).toBe('fs-2'); expect(m.has('z')).toBe(false);
  });
  it('수집 한 줄 — 방식 · 대수 · 주기 · 시작한 사람 · 남은 시간(잠깐 보기만)', () => {
    expect(sessionLabel(S1, 1_000_000)).toBe('잠깐 보기 · 2대 · 2초 · kim · 남은 05:00');
    expect(sessionLabel(S2, 1_000_000)).toBe('계속 수집 · 1대 · 10초');
  });
  it('시작 전 안내 — 빼는 서버 · 넘겨받는 서버(서버 planJoin 과 같은 규칙)', () => {
    const idx = sessionIndex([S1, S2]);
    expect(startNote({ picked: ['x', 'y'], index: idx, mode: 'watch' })).toBe('');
    expect(startNote({ picked: ['a', 'c', 'x'], index: idx, mode: 'watch' })).toBe('고른 3대 가운데 2대는 이미 수집 중이라 빼고 시작합니다.');
    expect(startNote({ picked: ['a', 'c', 'x'], index: idx, mode: 'record' })).toBe('고른 3대 가운데 1대는 이미 수집 중이라 빼고 시작합니다 · 1대는 잠깐 보기에서 계속 수집으로 넘겨받습니다.');
  });
  it('시작 · 더하기 결과 — 뺀 수 · 넘겨받은 수를 숨기지 않는다', () => {
    expect(joinResultText({ ok: true, session: { targets: ['x', 'y'] }, skipped: [{ id: 'a' }], moved: [] })).toBe('2대 수집을 시작했습니다 — 이미 수집 중인 1대는 뺐습니다.');
    expect(joinResultText({ ok: true, added: ['x'], session: { targets: ['a', 'x'] }, skipped: [], moved: ['x'] }, { verb: '진행 중인 수집에 더했습니다' })).toBe('1대 수집을 진행 중인 수집에 더했습니다 — 1대는 잠깐 보기에서 넘겨받았습니다.');
  });
  it('끝난 까닭 — 서버의 why(moved · removed)를 문구로 덮는다', () => {
    const src = fs.readFileSync(new URL('../../../../server/src/focusmon/store.js', import.meta.url), 'utf8');
    for (const why of [...src.matchAll(/stopSession\([^,]+, '([a-z-]+)'/g)].map((m) => m[1])) expect(ENDED_TEXT[why], why).toBeTruthy();
  });
});

describe('단추 연결(소스 스윕)', () => {
  const src = stripComments(fs.readFileSync(new URL('./FocusMonTool.jsx', import.meta.url), 'utf8'));
  it('진행 중인 수집마다 종료 · 잠깐 보기는 연장 · 둘 이상이면 모두 종료', () => {
    expect(src).toMatch(/sessions\.map\(\(s\) => \([\s\S]{0,900}onClick=\{\(\) => stopSession\(s, s\.mode === 'record'\)\}>종료<\/button>/);
    expect(src).toMatch(/sessions\.length > 1 \? <button type="button" className="fm-btn danger" onClick=\{stopAll\}>모두 종료/);
    expect(src).toMatch(/Promise\.allSettled\(sessions\.map\(\(s\) => delJson\(`\/tools\/focus-mon\/sessions\/\$\{encodeURIComponent\(s\.id\)\}`\)\)\)/);
  });
  it('대상 표 — 수집 중인 서버에 표시와 서버별 수집 종료(DELETE …/targets/:tid)', () => {
    expect(src).toMatch(/sIdx\.has\(t\.id\) \? <span className="fm-badge ok"/);
    expect(src).toMatch(/sIdx\.has\(t\.id\) \? <button type="button" className="fm-btn sm danger" disabled=\{!!busy\} onClick=\{\(\) => stopOne\(t, sIdx\.get\(t\.id\)\)\}>수집 종료<\/button>/);
    expect(src).toMatch(/delJson\(`\/tools\/focus-mon\/sessions\/\$\{encodeURIComponent\(s\.id\)\}\/targets\/\$\{encodeURIComponent\(t\.id\)\}`\)/);
  });
  it('진행 중인 수집에 더하기(POST …/targets) · 시작 전 안내', () => {
    expect(src).toMatch(/postJson\(`\/tools\/focus-mon\/sessions\/\$\{encodeURIComponent\(joinSel\.id\)\}\/targets`, \{ targets: picked \}\)/);
    expect(src).toMatch(/const note = startNote\(\{ picked, index: sIdx, mode \}\)/);
    expect(src).toMatch(/\{note \? <div className="fm-ban fm-pad-x">\{note\}<\/div> : null\}/);
  });
});

describe('화면이 보는 서버 · 수집 상태 글(v2.979 화면 검증에서 발견)', () => {
  const src = stripComments(fs.readFileSync(new URL('./FocusMonTool.jsx', import.meta.url), 'utf8'));
  it('따로 고른 서버가 없으면 진행 중인 모든 수집의 서버를 본다(가장 최근 수집만이 아니라)', () => {
    expect(src).toMatch(/const all = \[\.\.\.new Set\(sessions\.flatMap\(\(s\) => s\.targets\)\)\]\.filter\(\(x\) => known\.has\(x\)\);/);
    expect(src).not.toMatch(/return active \? active\.targets\.filter/);
  });
  it('수집이 없거나 과거 구간이면 ‘수집 중’ 이 아니라 ‘값 있음’', () => {
    expect(src).toMatch(/const liveNow = tb\.end == null && \(main\.sessions \|\| \[\]\)\.length > 0;/);
    expect(src).toMatch(/\{liveNow \? '수집 중' : '값 있음'\}/);
  });
});

