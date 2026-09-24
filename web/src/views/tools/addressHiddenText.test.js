import { describe, it, expect } from 'vitest';
import { hostText, addressHiddenNote } from './addressHiddenText.js';

describe('addressHiddenText (v2.599 AUTHZ-2599-03)', () => {
  it('빈 주소는 — 로, 값은 그대로', () => {
    expect(hostText('')).toBe('—');
    expect(hostText(null)).toBe('—');
    expect(hostText(undefined)).toBe('—');
    expect(hostText('10.0.0.5')).toBe('10.0.0.5');
  });
  it('addressHidden 일 때만 배너 — 백틱 없음', () => {
    expect(addressHiddenNote({ addressHidden: true })).toMatch(/관리자에게만/);
    expect(addressHiddenNote({ addressHidden: true })).not.toMatch(/`/);
    expect(addressHiddenNote({})).toBeNull();
    expect(addressHiddenNote(null)).toBeNull();
    expect(addressHiddenNote({ addressHidden: 'true' })).toBeNull();
  });
});
