/**
 * 서버 집중 모니터링 v2.979 — 서버 상세의 네트워크 · 디스크 카드에 ‘구간 끝 순간 | N분 평균’ 단추.
 * 사용자 요청(2026-11-12) "네트워크, 디스크 시간별로 보는거 추가" → 선택 ‘구간 평균 단추만 카드에’.
 *  · 단추 글에 구간 길이를 적는다(무엇의 평균인지) · 카드 제목 옆에 지금 보는 값.
 *  · 세 단추(화면 맨 위 · 네트워크 · 디스크)는 같은 상태 하나를 쓴다 — 카드마다 따로 두면 표 하나는 평균, 다른 하나는 순간인데 요청은 하나라 섞인다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { AT_KEYS, atOptions, atCaption, normAt } from './focusMonText.js';
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
  it('응답이 실제로 덮는 시간을 말한다(반증 2 — 수집이 끝났는데 ‘지금’ · 30분 중 10분인데 ‘30분 평균’)', () => {
    const now = 1_800_000_000_000;
    expect(atCaption('end', { win: 30, past: false, lastAt: now - 3_000, now, staleMs: 8_000 })).toBe('지금(가장 최근 표본)');
    expect(atCaption('end', { win: 30, past: false, lastAt: now - 20 * 60_000, now, staleMs: 8_000 })).toBe('마지막 표본 · 20분 전');
    expect(atCaption('avg', { win: 30, past: false, coverMs: 10 * 60_000, now })).toBe('최근 30분 평균 · 표본은 10분치');
    expect(atCaption('avg', { win: 30, past: false, coverMs: 20_000, now })).toBe('최근 30분 평균 · 표본은 1분 미만');
    expect(atCaption('avg', { win: 30, past: false, coverMs: 29 * 60_000, now })).toBe('최근 30분 평균', '90% 넘게 덮으면 그대로');
    expect(atCaption('end', { win: 5, past: true, lastAt: null })).toBe('고른 구간 끝 순간');
    expect(atCaption('end', { win: 5, past: true, lastAt: now })).toMatch(/^고른 구간의 마지막 표본 · /);
  });
  it('저장값 — 모르는 값 · 못 읽음은 끝 순간', () => {
    expect(normAt('avg')).toBe('avg'); expect(normAt('end')).toBe('end');
    for (const v of [null, undefined, '', 'AVG', 1, {}]) expect(normAt(v)).toBe('end');
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
  it('세 단추가 상태 하나를 쓴다(카드마다 따로 두지 않는다) · 셋 다 구간 길이를 적은 글 · 고른 값을 기억한다', () => {
    expect((body.match(/value=\{at\}\s+onChange=\{setAt\}/g) || []).length).toBe(3);
    expect((body.match(/options=\{atOptions\(tb\.win\)\}/g) || []).length).toBe(3);
    expect(body).not.toMatch(/'구간 평균'\]/);
    expect(body).toMatch(/useState\(\(\) => normAt\(lsGet\('fm\.srv\.at', 'end'\)\)\)/);
  });
  it('setAt 이 실제로 상태를 바꾸고 저장한다(반증 4 — 단추를 눌러도 아무 일이 없는 변이가 살아남았다)', () => {
    const m = body.match(/const setAt = \(v\) => \{([^}]*)\};/);
    expect(m).toBeTruthy();
    expect(m[1]).toMatch(/setAtRaw\(\s*x\s*\)/);
    expect(m[1]).toMatch(/lsSet\('fm\.srv\.at',\s*x\)/);
    expect(m[1]).toMatch(/const x = normAt\(v\)/);
  });
  it('캡션은 과거 구간 판정 · 응답의 덮은 시간으로 만든다 · 표가 바뀌는 카드 전부(CPU · 메모리 · 네트워크 · 디스크 · 프로세스)에 붙는다', () => {
    expect(body).toMatch(/const atText = atCaption\(at, \{ win: tb\.win, past: tb\.end != null, lastAt: d\?\.lastAt \?\? null, coverMs: d\?\.coverMs \?\? null/);
    expect((body.match(/<span className="fm-dim fm-at">· \{atText\}<\/span>/g) || []).length).toBe(5);
  });
  it('프로세스 상위 5 도 같은 값을 따른다(요청에 at)', () => {
    expect(body).toMatch(/usePoll\('\/tools\/focus-mon\/procs', useMemo\(\(\) => \(\{ targets: id, win: tb\.win, end: tb\.end \?\? '', at \}\)/);
  });
  it('안내문의 구간 목록은 응답 값(숫자를 박지 않는다 — 반증 5)', () => {
    expect(body).not.toMatch(/1 · 5 · 10 · 30분/);
    expect((body.match(/\{tb\.windows\.join\(' · '\)\}분 중 하나/g) || []).length).toBe(2);
  });
});
