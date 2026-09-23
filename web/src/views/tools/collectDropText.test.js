import { describe, it, expect } from 'vitest';
import { collectDropNote, DROP_WINDOW_MS } from './collectDropText.js';

const NOW = 1_800_000_000_000;

describe('collectDropNote — 폐기된 위임 수집 요청 안내(v2.591)', () => {
  it('폐기가 없거나 오래됐으면 말하지 않는다', () => {
    expect(collectDropNote([], undefined, NOW)).toBeNull();
    expect(collectDropNote(null, undefined, NOW)).toBeNull();
    expect(collectDropNote([{ id: 'a', agent: 'e1', at: NOW - DROP_WINDOW_MS - 1, tries: 2 }], undefined, NOW)).toBeNull();
  });
  it('개수·엣지·이름·시각을 말하고, 수집됐다는 뜻이 아님을 밝힌다', () => {
    const t = collectDropNote([{ id: 'u1', agent: 'edge-a', at: NOW - 5 * 60_000, tries: 2 }], (id) => ({ u1: 'OC2-unity-01' })[id], NOW);
    expect(t).toContain('**1건**');
    expect(t).toContain('edge-a');
    expect(t).toContain('OC2-unity-01');
    expect(t).toContain('5분 전');
    expect(t).toContain('수집이 되었다는 뜻이 아닙니다');
  });
  it('5대를 넘으면 나머지 개수를 밝힌다(조용한 축약 금지) · 시각이 없는 항목은 세지 않는다', () => {
    const drops = Array.from({ length: 7 }, (_, i) => ({ id: `d${i}`, agent: 'e', at: NOW - i * 1000, tries: 2 }));
    drops.push({ id: 'x', agent: 'e', at: null });
    const t = collectDropNote(drops, undefined, NOW);
    expect(t).toContain('**7건**');
    expect(t).toContain('외 2대');
  });
  it('문구에 백틱이 없다(BoldText 는 **강조** 만 해석한다)', () => {
    const t = collectDropNote([{ id: 'a', agent: 'e', at: NOW, tries: 2 }], undefined, NOW);
    expect(t.includes('`')).toBe(false);
  });
});
