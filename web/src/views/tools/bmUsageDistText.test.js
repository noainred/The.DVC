import { describe, it, expect } from 'vitest';
import { distStateOf, distributionCounts, distributionSummary, centralManagedNote, ignoredCentralNote, DIST_STATE, DIST_ENTERPRISE_NOTE } from './bmUsageDistText.js';

const dist = (enabled, states) => ({ enabled, rows: states.map((s, i) => ({ agent: `e${i}`, state: s })) });

describe('bmUsageDistText (v2.627)', () => {
  it('상태 5종에 라벨이 있고 모르는 상태는 확인 불가(정상으로 칠하지 않는다)', () => {
    for (const k of ['applied', 'pending', 'no-pull', 'excluded', 'off']) expect(DIST_STATE[k].label).toBeTruthy();
    expect(distStateOf('zzz').label).toBe('확인 불가');
    expect(distStateOf('no-pull').label).not.toMatch(/실패/);
  });
  it('개수는 겹치지 않고 합계와 맞는다', () => {
    const c = distributionCounts(dist(true, ['applied', 'applied', 'pending', 'no-pull', 'excluded']));
    expect(c).toMatchObject({ total: 5, applied: 2, pending: 1, 'no-pull': 1, excluded: 1 });
    expect(c.applied + c.pending + c['no-pull'] + c.excluded + c.off).toBe(c.total);
  });
  it('꺼짐·켜짐 요약 — 저장 즉시 바뀐다고 말하지 않는다', () => {
    expect(distributionSummary(dist(false, ['off', 'off']))).toMatch(/배포 꺼짐/);
    const on = distributionSummary(dist(true, ['applied', 'pending']));
    expect(on).toMatch(/다음 인출/);
    expect(on).toMatch(/저장 즉시 바뀌지 않습니다/);
    expect(on).not.toMatch(/제외/);
    expect(distributionSummary(null)).toBe('');
  });
  it('엣지 배너 — 배포 중일 때만 · Enterprise 는 엣지가 정한다고 말한다', () => {
    expect(centralManagedNote({ managed: false })).toBe('');
    const s = centralManagedNote({ managed: true, at: 1 }, () => '3분 전');
    expect(s).toMatch(/중앙이 이 설정을 배포 중/);
    expect(s).toMatch(/3분 전/);
    expect(s).toMatch(/Enterprise/);
  });
  it('저장 응답 무시 키 문구 · 문구에 백틱 없음', () => {
    expect(ignoredCentralNote({ ignoredCentralManaged: ['enabled', 'intervalMs'] })).toMatch(/2개/);
    expect(ignoredCentralNote({})).toBe('');
    const all = [DIST_ENTERPRISE_NOTE, distributionSummary(dist(true, ['applied'])), centralManagedNote({ managed: true })];
    for (const s of all) expect(s).not.toMatch(/`/);
  });
});
