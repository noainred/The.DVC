// v2.954(점검 A-3) — 월간 보고서 '받는 사람' 칸 안내. 비관리자 판본은 주소 대신 개수(toCount · toHidden)만 온다.
import { describe, it, expect } from 'vitest';
import { reportToPlaceholder } from './sanStorageText.js';

describe('reportToPlaceholder', () => {
  it('관리자 판본(가림 아님)은 예시 그대로', () => {
    expect(reportToPlaceholder({ to: ['a@b'] })).toBe('storage-team@example.com, ...');
    expect(reportToPlaceholder(undefined)).toBe('storage-team@example.com, ...');
  });
  it('가림 판본 — 지정 수를 알리고 주소는 싣지 않는다', () => {
    expect(reportToPlaceholder({ to: [], toCount: 3, toHidden: true })).toBe('받는 사람 3명 지정됨 — 주소는 관리자만 봅니다');
  });
  it('가림 판본 · 지정 0 — 기본 수신자', () => {
    expect(reportToPlaceholder({ to: [], toCount: 0, toHidden: true })).toBe('지정 없음 — 기본 수신자로 보냅니다');
  });
  it('개수를 못 읽었으면 0 으로 단정하지 않는다', () => {
    expect(reportToPlaceholder({ to: [], toHidden: true })).toBe('받는 사람 주소는 관리자만 봅니다');
    expect(reportToPlaceholder({ to: [], toCount: null, toHidden: true })).toBe('받는 사람 주소는 관리자만 봅니다');
  });
});
