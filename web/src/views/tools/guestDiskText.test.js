import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { partsUnknownNote } from './guestDiskText.js';

describe('partsUnknownNote (v2.600 LO2600-07)', () => {
  it('개수가 있으면 제외 사실을 말하고, 없으면 빈 문자열', () => {
    expect(partsUnknownNote(3)).toMatch(/파티션 3개/);
    expect(partsUnknownNote(3)).toMatch(/제외/);
    expect(partsUnknownNote(0)).toBe('');
    expect(partsUnknownNote(null)).toBe('');
    expect(partsUnknownNote(undefined)).toBe('');
    expect(partsUnknownNote(3)).not.toMatch(/`/);
  });
  it('GuestDiskReport 가 서버의 partsUnknown 을 BoldText 로 그린다(소스)', () => {
    const src = readFileSync(new URL('./GuestDiskReport.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/partsUnknownNote\(poller\.lastResult\?\.partsUnknown\)/);
  });
});
