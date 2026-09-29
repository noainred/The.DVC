import { describe, it, expect } from 'vitest';
import { wattText, powerKpis, basisText, powerEmptyNote, POWER_NOTE } from './cvpPowerText.js';

describe('cvpPowerText (v2.647)', () => {
  it('wattText — 값 없으면 단위 없는 —', () => {
    expect(wattText(null)).toBe('—'); expect(wattText(152.4)).toBe('152 W'); expect(wattText(48_200)).toBe('48.2 kW');
  });
  it('powerKpis — 읽은 장비 0 이면 합계 —(0W 아님)', () => {
    const k = powerKpis({ devices: 3, read: 0, watts: 0, unread: { partsNotRead: 3 } });
    expect(k[0].value).toBe('—'); expect(k[3].value).toBe('3'); expect(k[3].accent).toBe('var(--amber)');
    const k2 = powerKpis({ devices: 2, read: 2, watts: 300, unread: {} });
    expect(k2[1].value).toBe('150 W'); expect(k2[3].accent).toBeUndefined();
  });
  it('basisText·빈 상태·백틱', () => {
    expect(basisText('output')).toContain('입력 모름');
    expect(powerEmptyNote({ devices: 2, read: 0, unread: { noPowerField: 2 } })).toContain('필드 이름');
    expect(powerEmptyNote({ devices: 2, read: 1 })).toBe('');
    expect(POWER_NOTE.includes('`')).toBe(false);
  });
});
