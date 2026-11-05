/**
 * mentionText.test.js — v2.907 댓글 @멘션 자동완성 순수 판정(시안 docs/design/wiki-mention ①②).
 * 토큰 끝 판정은 서버 mentionsOf 와 같아야 한다 — 같은 입력으로 대조한다(판정 코어 두 벌 규칙).
 */
import { describe, expect, it } from 'vitest';
import { mentionQueryAt, applyMention, mentionText, mentionsInText } from './mentionText.js';
import { commentIssueText } from '../views/wiki/Wiki.jsx';

describe('mentionText', () => {
  it('커서 앞 @검색어 — 줄 머리 · 공백 · ( 뒤만(메일 주소 아님) · 이미 넣은 @계정/이름은 열지 않는다', () => {
    expect(mentionQueryAt('확인 @ki', 7)).toEqual({ start: 3, q: 'ki' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, q: '' });
    expect(mentionQueryAt('(@kim', 5)).toEqual({ start: 1, q: 'kim' });
    expect(mentionQueryAt('a@b.com', 7)).toBe(null);
    expect(mentionQueryAt('확인 @kim.lee/김이령', 16)).toBe(null);
    expect(mentionQueryAt('확인 @ki 다음', 10)).toBe(null);
  });
  it('고르면 @계정/이름 + 공백 — 이름의 공백 · 멘션을 끊는 글자는 뺀다', () => {
    expect(mentionText('kim.lee', '김 이령')).toBe('@kim.lee/김이령');
    expect(mentionText('kim', '')).toBe('@kim');
    expect(mentionText('kim', 'kim')).toBe('@kim');
    expect(applyMention('확인 @ki', 7, { username: 'kim.lee', name: '김이령' })).toEqual({ text: '확인 @kim.lee/김이령 ', caret: 16 });
    expect(applyMention('확인 @ki 뒤', 6, { username: 'kim', name: '' })).toEqual({ text: '확인 @kim 뒤', caret: 8 });
    expect(applyMention('글자만', 3, { username: 'kim' })).toBe(null);
  });
  it('글 속 멘션 — 서버 mentionsOf 와 같은 정규식 · 계정은 / 앞 · 10명 · 중복 제거', () => {
    const r = mentionsInText('@kim.lee/김이령 시한 @park.ki 참고 @kim.lee 또 a@b.c');
    expect(r.map((x) => x.user)).toEqual(['kim.lee', 'park.ki']);
    expect(r[0].name).toBe('김이령');
    expect(mentionsInText(Array.from({ length: 15 }, (_, i) => `@u${i}`).join(' ')).length).toBe(10);
    expect(mentionsInText('끝 @kim.')[0].user).toBe('kim');
  });
  it('등록 결과 문구 — 담당 · 관찰 · 뺀 사람 · 메일 · 실패', () => {
    expect(commentIssueText({ issue: { key: 'ISS-4', assignee: 'kim', watchers: ['lee'], skipped: ['opb'], notifyOn: true, noEmail: [] } }))
      .toBe('이슈 ISS-4 를 만들었습니다 — 담당자 kim · 관찰자 lee · 이 법인을 볼 수 없어 뺀 사람 opb · 메일은 1분 안에 한 통씩 갑니다.');
    expect(commentIssueText({ issue: { key: 'ISS-4', assignee: 'kim', watchers: [], notifyOn: false } })).toMatch(/알림이 꺼져/);
    expect(commentIssueText({ issueError: '상한' })).toMatch(/댓글은 달았지만/);
    expect(commentIssueText({ issue: { key: 'ISS-4', existing: true } })).toMatch(/이미 있습니다/);
    expect(commentIssueText({ issue: { key: 'ISS-5', requestOnly: true, notifyOn: true } })).toMatch(/요청으로 등록/);
  });
});
