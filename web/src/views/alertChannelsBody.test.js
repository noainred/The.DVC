import { describe, it, expect } from 'vitest';
import { alertChannelsBody } from './alertChannelsBody.js';

describe('alertChannelsBody (WEB2607-04)', () => {
  it('빈 칸은 보내지 않는다(0 = 억제 끔으로 둔갑 금지)', () => {
    const b = JSON.parse(JSON.stringify(alertChannelsBody({ channels: {}, suppressWindowMin: '' })));
    expect('suppressWindowMin' in b).toBe(false);
  });
  it('명시적 0 과 숫자는 그대로', () => {
    expect(alertChannelsBody({ suppressWindowMin: '0' }).suppressWindowMin).toBe(0);
    expect(alertChannelsBody({ suppressWindowMin: '7' }).suppressWindowMin).toBe(7);
    expect(alertChannelsBody({ suppressWindowMin: 5, cooldownMin: 10 }).cooldownMin).toBe(10);
  });
});
