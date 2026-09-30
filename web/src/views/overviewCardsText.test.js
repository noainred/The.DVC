import { describe, it, expect } from 'vitest';
import * as T from './overviewCardsText.js';

describe('v2.664 Overview 카드 · 전체 소비 전력 문구', () => {
  it('값이 없으면 단위 없는 —', () => {
    expect(T.kwText(null)).toBe('—'); expect(T.capText(null)).toBe('—'); expect(T.capText(0)).toBe('—'); expect(T.countText(undefined)).toBe('—');
    expect(T.kwText(1660)).toBe('1.7 kW'); expect(T.kwText(123456)).toBe('123 kW');
    expect(T.capText(2e14)).toBe('200 TB'); expect(T.capText(1.5e15)).toBe('1.50 PB'); expect(T.capText(5e12)).toBe('5.0 TB');
  });
  it('범위 계정 사유를 그대로 말한다', () => {
    expect(T.cardMeta('storage', { storage: { totalBytes: null, reason: '전체 범위 계정만' } })).toBe('전체 범위 계정만');
  });
  it('카드 부제 — 못 읽은 수와 측정 수', () => {
    expect(T.cardMeta('storage', { storage: { totalBytes: 100, usedPct: 40, read: 2, devices: 4, unread: 2 } })).toBe('사용 40% · 2/4대 · 못 읽음 2');
    expect(T.cardMeta('storage', { storage: { totalBytes: null, devices: 0 } })).toBe('등록된 스토리지 없음');
        expect(T.cardMeta('power', { power: { servers: { watts: 800, measured: 2 }, network: { watts: 0, measured: 0 }, storage: { watts: 660, measured: 1 } } })).toBe('서버 0.8 kW · 네트워크 — · 스토리지 0.7 kW');
    expect(T.kwOrDash(0)).toBe('—');
    expect(T.powerCatNote('storage', { measured: 1, devices: 3, unread: 1, unsupported: 1 })).toBe('측정 1/3대 · 못 읽음 1 · 수집 경로 없음 1');
    expect(T.powerCatNote('servers', { measured: 2, excludedVcenter: 1 })).toMatch(/vCenter 추정 1대는 뺐습니다/);
  });
  it('문구에 백틱·별표 없음', () => {
    for (const t of T.POWER_FOOTNOTE) { expect(t).not.toMatch(/`|\*\*/); }
  });
});
