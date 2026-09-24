import { describe, it, expect } from 'vitest';
import { fleetPartialsNote } from './fleetPartialText.js';

describe('fleetPartialsNote (LEFT2607-02)', () => {
  it('부분 엣지·뺀 대수·상한·귀속 비움을 말한다', () => {
    const t = fleetPartialsNote({ edges: 3, partialEdges: 1, partials: [{ agent: 'edge-kr' }], withheldItems: 4, withheldUnknown: 0, omitted: 2, vcenterBlanked: 1 });
    expect(t).toMatch(/엣지 1곳의 목록이 일부/);
    expect(t).toMatch(/뺀 대수 4대/);
    expect(t).toMatch(/edge-kr/);
    expect(t).toMatch(/상한으로 받지 않은 서버 2대/);
    expect(t).toMatch(/귀속을 비운 서버 1대/);
  });
  it('해당 없거나 null(범위 계정)이면 빈 문자열', () => {
    expect(fleetPartialsNote({ edges: 2, partialEdges: 0, partials: [], withheldItems: 0, withheldUnknown: 0, omitted: 0, vcenterBlanked: 0 })).toBe('');
    expect(fleetPartialsNote(null)).toBe('');
  });
});
