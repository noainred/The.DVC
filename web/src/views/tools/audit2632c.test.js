// v2.632 감사 그룹 C — 화면 쪽 회귀(AX2-2632-03 Horizon 부분 합 · AX2-2632-07 서버 온도 오래된 표본).
import { describe, it, expect } from 'vitest';
import { tempCounts, hotList, tempBuckets } from './serverTemp/board.js';
import { collectStateNote, lowerBoundPrefix, unionNote } from './horizonSessionText.js';

describe('AX2-2632-07: 오래된(stale) 온도 표본은 현재값으로 세지 않는다', () => {
  const rows = [{ curC: 22 }, { curC: 45, stale: true }, { curC: null }];
  it('tempCounts — stale 은 미확인(unknown)에 들고 stale 로 따로 밝힌다(항등식 유지)', () => {
    const c = tempCounts(rows);
    expect(c).toMatchObject({ ok: 1, warm: 0, hot: 0, unknown: 2, stale: 1, total: 3 });
    expect(c.ok + c.warm + c.hot + c.unknown).toBe(c.total);
  });
  it('hotList — 3일 전 45℃ 는 이상 서버 목록에 없다', () => {
    expect(hotList(rows)).toEqual([]);
  });
  it('tempBuckets — stale 은 현재 분포에서 빠진다', () => {
    expect(tempBuckets(rows).reduce((a, b) => a + b.n, 0)).toBe(1);
  });
});

describe('AX2-2632-03: 읽지 못한 Horizon 서버가 있으면 수치는 최소값', () => {
  const total = { serversOk: 1, serversFailed: 1, users: 480, usersConnected: 460, sessions: 500, usersByServerSum: 480 };
  it('lowerBoundPrefix — 세 수치 모두 최소', () => {
    expect(lowerBoundPrefix(total, 'users')).toBe('최소 ');
    expect(lowerBoundPrefix(total, 'connected')).toBe('최소 ');
    expect(lowerBoundPrefix(total, 'sessions')).toBe('최소 ');
    expect(lowerBoundPrefix({ ...total, serversFailed: 0 }, 'sessions')).toBe('');
  });
  it('unionNote — 겹치는 계정이 없다고 단정하지 않는다', () => {
    const t = unionNote(total);
    expect(t).toContain('최소 480명');
    expect(t).not.toContain('겹치는 계정이 없습니다');
  });
  it('collectStateNote partial — 추이에 적재하지 않았다는 사실을 말한다', () => {
    const n = collectStateNote({ settings: { enabled: true }, registered: 2, targets: 2, lastReadAt: 1, total });
    expect(n.kind).toBe('partial');
    expect(n.text).toContain('추이에 적재하지 않았습니다');
  });
});
