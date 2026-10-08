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
        expect(T.cardMeta('power', { power: { servers: { watts: 800, measured: 2 }, network: { watts: 0, measured: 0 }, storage: { watts: 660, measured: 1 } } })).toBe('서버 0.8 kW · 네트워크 — · 스토리지 0.7 kW · 측정 3대'); // v2.682 R3D-01: 측정 대수를 함께
    expect(T.kwOrDash(0)).toBe('—');
    expect(T.powerCatNote('storage', { measured: 1, devices: 3, unread: 1, unsupported: 1 })).toBe('측정 1/3대 · 못 읽음 1 · 수집 경로 없음 1');
    expect(T.powerCatNote('servers', { measured: 2, excludedVcenter: 1 })).toMatch(/vCenter 추정 1대는 뺐습니다/);
  });
  it('문구에 백틱·별표 없음', () => {
    for (const t of T.POWER_FOOTNOTE) { expect(t).not.toMatch(/`|\*\*/); }
  });
});

// v2.667 — 스토리지 전력 '못 읽음' 사유 문구는 서버 사유 코드와 1:1(한쪽만 늘면 화면이 코드를 그대로 보인다).
import { STORAGE_POWER_REASON, reasonCountsText } from './overviewCardsText.js';
import { PROBE_REASONS } from '../../../server/src/storage/power.js';
describe('v2.667 스토리지 전력 사유', () => {
  it('서버 사유 코드 전부에 문구가 있다', () => {
    for (const k of [...PROBE_REASONS, 'no-snapshot', 'collect-failed', 'not-reported', 'stale', 'no-time']) expect(STORAGE_POWER_REASON[k], k).toBeTruthy();   // v2.727(감사 C-06): no-time
  });
  it('사유별 개수는 많은 순 · 0 은 뺀다', () => {
    expect(reasonCountsText({ 'no-field': 3, skipped: 0, 'collect-failed': 5 })).toBe('장비 수집 실패(스토리지 모니터링의 오류 참조) 5 · 응답에 전원 필드 없음 3');
  });
});

// v2.727(감사 C-06): 시각 없음(noTime)은 오래됨(stale)과 다른 사유 — 카드·카테고리 문구가 따로 말한다.
import { powerCardMeta, powerCatNote } from './overviewCardsText.js';
describe('v2.727 전력 noTime', () => {
  it('powerCatNote · powerCardMeta 가 수집 시각 없음을 말한다', () => {
    expect(powerCatNote('storage', { measured: 1, devices: 3, noTime: 1, stale: 1 })).toMatch(/수집 시각 없음 1/);
    expect(powerCatNote('network', { measured: 2, devices: 2 })).not.toMatch(/시각 없음/);
    const m = powerCardMeta({ servers: { watts: 0, measured: 0, devices: 0 }, network: { watts: 0, measured: 0, devices: 1, noTime: 1 }, storage: { watts: 0, measured: 0, devices: 0 } });
    expect(m).toMatch(/시각 없음 1/); expect(m).toMatch(/읽은 장비만의 합/);
  });
});
