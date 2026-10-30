import { describe, it, expect } from 'vitest';
import { syncRows, syncSummary, orphanTokens, agentNameOf, SYNC_STATE } from './edgeTokenSyncText.js';

const cols = [
  { id: 'c1', name: 'KR', url: 'https://kr:8443' },
  { id: 'c2', name: 'PL', url: 'https://pl:8443' },
  { id: 'c3', name: 'US', url: 'https://us:8443', enabled: false },
  { id: 'c4', name: 'AZ-IRS', url: 'https://az:8443' },
];

describe('엣지 토큰 맞추기 — 행 판정(v2.825)', () => {
  it('개별 토큰 사용 · 사용 기록 없음 · 공유 토큰 · 수집 꺼짐을 가른다(대소문자 무시)', () => {
    const rows = syncRows(cols, [
      { agent: 'kr', createdAt: 1, lastUsedAt: 5 },
      { agent: 'PL', createdAt: 1, lastUsedAt: null },
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.agent, r]));
    expect(by.KR.state).toBe('ok');
    expect(by.PL.state).toBe('unused');
    expect(by['AZ-IRS'].state).toBe('shared');
    expect(by.US.state).toBe('off');
  });

  it('자동 적용은 켜진 서버 + 개별 토큰 없음에서만 연다', () => {
    const rows = syncRows(cols, [{ agent: 'KR', lastUsedAt: 5 }, { agent: 'PL' }]);
    const can = rows.filter((r) => r.canApply).map((r) => r.agent);
    expect(can).toEqual(['AZ-IRS']);
  });

  it('토큰 목록을 못 읽었으면 모두 모름 — 없음으로 칠하지 않고 자동 적용도 닫는다', () => {
    const rows = syncRows(cols, null);
    expect(rows.every((r) => r.state === 'unknown')).toBe(true);
    expect(rows.some((r) => r.canApply)).toBe(false);
  });

  it('이름이 없으면 id 를 엣지 이름으로 쓴다 · URL 이 없으면 적용하지 않는다', () => {
    expect(agentNameOf({ id: 'edge-1', name: ' ' })).toBe('edge-1');
    const rows = syncRows([{ id: 'x' }], []);
    expect(rows[0].state).toBe('shared');
    expect(rows[0].canApply).toBe(false);
  });

  it('못 읽은 시각은 null(0 을 시각으로 쓰지 않는다)', () => {
    const [r] = syncRows([cols[0]], [{ agent: 'KR', createdAt: '', lastUsedAt: 0 }]);
    expect(r.createdAt).toBeNull();
    expect(r.lastUsedAt).toBeNull();
    expect(r.state).toBe('unused');
  });

  it('요약은 0 인 항목을 빼고 센다 · 빈 목록 문구', () => {
    const rows = syncRows(cols, [{ agent: 'KR', lastUsedAt: 5 }]);
    expect(syncSummary(rows)).toBe('엣지 4대 · 개별 토큰 사용 1 · 공유 토큰 2 · 수집 꺼짐 1');
    expect(syncSummary([])).toMatch(/없습니다/);
  });

  it('등록부에 없는 개별 토큰을 따로 알린다(이름·id 모두 대조)', () => {
    expect(orphanTokens(cols, [{ agent: 'kr' }, { agent: 'c2' }, { agent: 'OLD' }])).toEqual(['OLD']);
    expect(orphanTokens(cols, null)).toEqual([]);
  });

  it('모든 상태에 배지 문구가 있고 백틱이 없다', () => {
    for (const k of ['ok', 'unused', 'shared', 'off', 'unknown']) {
      expect(SYNC_STATE[k].text).toBeTruthy();
      expect(SYNC_STATE[k].text).not.toMatch(/`/);
    }
  });
});
