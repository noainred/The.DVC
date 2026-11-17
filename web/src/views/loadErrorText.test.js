import { describe, it, expect } from 'vitest';
import { loadErrorText } from './loadErrorText.js';
import { mailMaskedText, mailLoadErrorText } from './mailSettingsText.js';

describe('loadErrorText — 결정(56~75 남긴 것) G2 저장소 표지', () => {
  it('표지가 없으면 빈 문자열(배너를 그리지 않는다)', () => {
    expect(loadErrorText('게시판', null)).toBe('');
    expect(loadErrorText('게시판', undefined)).toBe('');
  });
  it('읽기 오류는 서버 사유만(풀 방법은 서버 사유가 말한다) — 확정 안내를 붙이지 않는다', () => {
    const t = loadErrorText('게시판', { reason: '설정 파일을 읽지 못했습니다(EIO) — 원본은 그대로 두었습니다', readError: true });
    expect(t).toContain('EIO');
    expect(t).not.toContain('기본값으로 확정');
    expect(t).toContain('저장은 거절');
  });
  it('손상은 확정 · 보존본 복구 안내를 붙인다 · 그동안의 영향 문구를 싣는다', () => {
    const t = loadErrorText('수동 분류', { reason: '설정 파일을 읽지 못했습니다(JSON 형식 오류) — 손상 보존본으로 옮겼습니다' }, '자동 분류로 보입니다.');
    expect(t).toContain('기본값으로 확정');
    expect(t).toContain('자동 분류로 보입니다.');
    expect(t).not.toContain('`');
  });
});

describe('mailSettingsText — 73 ① · ③', () => {
  it('범위 관리자 가림은 가린 사실과 개수를 말한다(빈 칸을 설정 없음으로 읽지 않게)', () => {
    const t = mailMaskedText({ scopedMasked: true, smtp: { hasUser: true }, defaultToCount: 2, kinds: { alert: { toCount: 1, ccCount: 1 } } });
    expect(t).toContain('가립니다');
    expect(t).toContain('계정 있음');
    expect(t).toContain('기본 수신자 2명');
    expect(t).toContain('종류별 수신자 2명');
    expect(mailMaskedText({ smtp: { user: 'x' } })).toBe(null);
  });
  it('설정 파일을 못 읽으면 발송 꺼짐 · 저장 거절을 말한다', () => {
    expect(mailLoadErrorText(null)).toBe(null);
    expect(mailLoadErrorText({ reason: 'x' })).toContain('저장은 거절');
  });
});
