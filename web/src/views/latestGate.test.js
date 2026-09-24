import { describe, it, expect } from 'vitest';
import { makeLatestGate } from './latestGate.js';

describe('latestGate (v2.606 LEFT2606-05)', () => {
  it('뒤 요청이 시작되면 앞 요청의 응답은 최신이 아니다', () => {
    const g = makeLatestGate();
    const a = g.next();
    const b = g.next();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
  });
  it('게이트끼리 섞이지 않는다', () => {
    const g1 = makeLatestGate(); const g2 = makeLatestGate();
    const a = g1.next(); g2.next();
    expect(a()).toBe(true);
  });
});
