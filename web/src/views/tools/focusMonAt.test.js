/**
 * 서버 집중 모니터링 v2.979 — 서버 상세의 네트워크 · 디스크 카드에 ‘구간 끝 순간 | N분 평균’ 단추.
 * 사용자 요청(2026-11-12) "네트워크, 디스크 시간별로 보는거 추가" → 선택 ‘구간 평균 단추만 카드에’.
 *  · 단추 글에 구간 길이를 적는다(무엇의 평균인지) · 카드 제목 옆에 지금 보는 값.
 *  · 세 단추(화면 맨 위 · 네트워크 · 디스크)는 같은 상태 하나를 쓴다 — 카드마다 따로 두면 표 하나는 평균, 다른 하나는 순간인데 요청은 하나라 섞인다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { AT_KEYS, atOptions, atCaption } from './focusMonText.js';
import { stripComments } from '../../test/_stripComments.js';

describe('표의 값 단추 문구', () => {
  it('평균 단추에 구간 길이를 적는다', () => {
    expect(atOptions(5)).toEqual([['end', '구간 끝 순간'], ['avg', '5분 평균']]);
    expect(atOptions(30)[1][1]).toBe('30분 평균');
    expect(atOptions(1).map((x) => x[0])).toEqual([...AT_KEYS]);
  });
  it('카드 제목 옆 — 최근 · 과거 구간을 가른다', () => {
    expect(atCaption('avg', { win: 10, past: false })).toBe('최근 10분 평균');
    expect(atCaption('avg', { win: 10, past: true })).toBe('고른 10분 평균');
    expect(atCaption('end', { win: 10, past: false })).toBe('지금(가장 최근 표본)');
    expect(atCaption('end', { win: 10, past: true })).toBe('고른 구간 끝 순간');
  });
  it('서버의 값 키(at)와 같다 — 라우트는 avg 가 아니면 end 로 읽는다', () => {
    const src = fs.readFileSync(new URL('../../../../server/src/routes/api/focusMon.js', import.meta.url), 'utf8');
    expect(src).toMatch(/view === 'server'[\s\S]{0,200}at: req\.query\.at === 'avg' \? 'avg' : 'end'/);
  });
});

describe('서버 상세 — 네트워크 · 디스크 카드에 단추(소스 스윕)', () => {
  const src = stripComments(fs.readFileSync(new URL('./FocusMonTool.jsx', import.meta.url), 'utf8'));
  const body = src.slice(src.indexOf('function ServerDetail('), src.indexOf('\nfunction ', src.indexOf('function ServerDetail(') + 10));
  const card = (title) => { const i = body.indexOf(title); return i < 0 ? '' : body.slice(i, body.indexOf('<STable', i)); };
  it('네트워크 카드 머리에 같은 상태의 단추 + 지금 보는 값', () => {
    const c = card('네트워크 — 본딩');
    expect(c).toMatch(/<Seg label="네트워크 표의 값" value=\{at\} onChange=\{setAt\} options=\{atOptions\(tb\.win\)\}/);
    expect(c).toMatch(/\{atText\}/);
  });
  it('디스크 카드 머리에 같은 상태의 단추 + 지금 보는 값', () => {
    const c = card('디스크 — 물리');
    expect(c).toMatch(/<Seg label="디스크 표의 값" value=\{at\} onChange=\{setAt\} options=\{atOptions\(tb\.win\)\}/);
    expect(c).toMatch(/\{atText\}/);
  });
  it('세 단추가 상태 하나를 쓴다(카드마다 따로 두지 않는다) · 고른 값을 기억한다', () => {
    expect((body.match(/value=\{at\} onChange=\{setAt\}/g) || []).length).toBe(3);
    expect((body.match(/useState\([^)]*'fm\.srv\.at'/g) || []).length + (body.match(/lsGet\('fm\.srv\.at'/g) || []).length).toBeGreaterThan(0);
    expect(body).toMatch(/lsSet\('fm\.srv\.at', v\)/);
    expect(body).toMatch(/AT_KEYS\.includes\(v\) \? v : 'end'/);
  });
});
