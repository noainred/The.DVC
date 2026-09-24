import { describe, it, expect } from 'vitest';
import { pullDropCard, rowCards } from './collectorDiag.js';

describe('pullDropCard (WEB2607-09)', () => {
  it('버린 서버·고친 값·호스트명 겹침을 사유별 개수로 말한다', () => {
    const st = { ok: true, hosts: 10, serversDropped: { notObject: 1, badId: 2, overCount: 0 }, serversCoerced: 4, hostConflicts: ['esx01', 'esx02'] };
    const c = pullDropCard(st);
    expect(c.badge).toBe('버린 서버 3 · 고친 값 4 · 호스트명 겹침 2');
    expect(c.evidence[0].v).toBe('객체 아님 1 · id 오류 2 · 상한 초과 0');
    expect(c.evidence[2].v).toMatch(/esx01, esx02/);
    expect(c.steps.length).toBeGreaterThan(0);
    expect(rowCards({ id: 'a' }, st, null).some((x) => x.kind === 'pull-drop')).toBe(true);
  });
  it('해당 없으면 카드를 만들지 않는다', () => {
    expect(pullDropCard({ ok: true, serversDropped: null, serversCoerced: 0, hostConflicts: null })).toBe(null);
    expect(pullDropCard(undefined)).toBe(null);
  });
});
