import { describe, it, expect } from 'vitest';
import { syncRows, syncSummary, orphanTokens, agentNameOf, SYNC_STATE, edgeApiOk, MIN_EDGE_API_VERSION } from './edgeTokenSyncText.js';
import { cmpVersion } from '../cmpVersion.js';

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

describe('v2.826 엣지 판 — 수집 토큰 통로 유무', () => {
  it('edgeApiOk — 2.776.0 이상 true · 미만 false · 모름 null(낮다고 보지 않는다)', () => {
    expect(MIN_EDGE_API_VERSION).toBe('2.776.0');
    expect(edgeApiOk('2.776.0')).toBe(true);
    expect(edgeApiOk('v2.826.0')).toBe(true);
    expect(edgeApiOk('2.775.0')).toBe(false);
    expect(edgeApiOk('')).toBe(null);
    expect(edgeApiOk(undefined)).toBe(null);
    expect(edgeApiOk('dev')).toBe(null);
  });
  it('cmpVersion(웹) — 서버 util 과 같은 규칙: v 접두·짧은 세그먼트·숫자 아님 null·부호만', () => {
    expect(cmpVersion('2.5', '2.5.0')).toBe(0);
    expect(cmpVersion('v2.826.0', '2.775.0')).toBe(1);
    expect(cmpVersion('2.775.0', '2.776.0')).toBe(-1);
    expect(cmpVersion('2.x', '2.0.0')).toBe(null);
    expect(cmpVersion('', '1')).toBe(null);
  });
  it('syncRows 에 pull 상태를 주면 엣지 판·통로 유무·안내가 붙고, 없으면 모름(—)', () => {
    const cols = [{ id: 'WA', name: 'agent-WA', url: 'http://w:4000', enabled: true }, { id: 'KR', name: 'KR', url: 'http://k:4000', enabled: true }, { id: 'XX', name: 'XX', url: 'http://x:4000' }];
    const rows = syncRows(cols, [], { WA: { version: '2.775.0' }, KR: { version: '2.826.0' } });
    const wa = rows.find((r) => r.agent === 'agent-WA'); const kr = rows.find((r) => r.agent === 'KR'); const xx = rows.find((r) => r.agent === 'XX');
    expect(wa.edgeVersion).toBe('2.775.0'); expect(wa.apiOk).toBe(false); expect(wa.versionHint).toContain('2.776.0'); expect(wa.versionHint).toContain('엣지 업그레이드 뒤 자동 적용');
    expect(wa.canApply).toBe(true);   // 자동 적용 칸은 연다 — 서버 작업이 통로 유무를 판정하고 다음 수단을 안내한다
    expect(kr.apiOk).toBe(true); expect(kr.versionHint).toBe('');
    expect(xx.edgeVersion).toBe(''); expect(xx.apiOk).toBe(null); expect(xx.versionHint).toContain('모릅니다');
    expect(syncRows(cols, []).every((r) => r.apiOk === null)).toBe(true);   // status 생략(옛 호출) — 모름
    for (const r of rows) expect(r.versionHint).not.toContain('`');
  });
});
