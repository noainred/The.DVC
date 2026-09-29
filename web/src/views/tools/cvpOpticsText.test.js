import { describe, it, expect } from 'vitest';
import { dbmText, opticRowState, basisText, opticsKpis, opticsEmptyNote, OPTICS_NOTE } from './cvpOpticsText.js';

describe('cvpOpticsText (v2.646)', () => {
  it('판정 표시 — 링크 없는 포트는 판정 안 함', () => {
    expect(opticRowState({ judged: true, rxState: 'fault' }).tone).toBe('bad');
    expect(opticRowState({ judged: true, rxState: 'warn' }).label).toContain('주의');
    expect(opticRowState({ judged: false, linked: false, rx: -40 }).label).toContain('링크 없음');
    expect(opticRowState({ judged: false, rx: null }).label).toContain('값 없음');
  });
  it('dBm·기준 표시 — 값 없으면 단위 없는 —', () => {
    expect(dbmText(null)).toBe('—'); expect(dbmText(-3.256)).toBe('-3.26 dBm');
    expect(basisText({ judged: true, basis: 'device' })).toBe('장비 임계');
    expect(basisText({ judged: false })).toBe('—');
  });
  it('KPI — 0 은 경고색이 아니다', () => {
    const k = opticsKpis({ fault: 0, warn: 2 }, { warnDbm: -10, faultDbm: -14 });
    expect(k[0].accent).toBeUndefined(); expect(k[1].accent).toBe('var(--amber)');
    expect(k[0].meta).toContain('-14 dBm');
  });
  it('빈 상태 — 원인을 단정하지 않는다', () => {
    expect(opticsEmptyNote({ withDom: 3 })).toBe('');
    expect(opticsEmptyNote({ withDom: 0, present: 5 })).toContain('DOM');
    expect(opticsEmptyNote({ withDom: 0, present: 0, devicesNoXcvrRead: 2 })).toContain('정상이라는 뜻이 아닙니다');
    expect(OPTICS_NOTE.includes('`')).toBe(false);
  });
});
