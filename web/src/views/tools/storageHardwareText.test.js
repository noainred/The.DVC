import { describe, it, expect } from 'vitest';
import { hardwareSummaryParts } from './storageHardwareText.js';

describe('hardwareSummaryParts (v2.599 C2599-06)', () => {
  it('이상·빈 슬롯·미확인을 나눠 말한다', () => {
    expect(hardwareSummaryParts({ total: 6, unhealthy: 1, absent: 2, unknown: 2 }).map((p) => p.text))
      .toEqual(['이상 1', '상태 미확인 2', '빈 슬롯 2']);
  });
  it('미확인이 있으면 이상 없음이라 단정하지 않는다', () => {
    expect(hardwareSummaryParts({ unhealthy: 0, unknown: 3 })[0].text).toBe('확인된 이상 없음');
  });
  it('구버전 스냅샷(absent/unknown 없음)은 예전 표기', () => {
    expect(hardwareSummaryParts({ total: 4, unhealthy: 0 }).map((p) => p.text)).toEqual(['이상 없음']);
    expect(hardwareSummaryParts(null)).toEqual([]);
  });
});
