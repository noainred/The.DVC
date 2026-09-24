// v2.606 감사 그룹 c — 수집기 화면 문구(하한·mixed 표지).
import { describe, it, expect } from 'vitest';
import { usersCountText, truncatedNote } from './curUserText.js';
import { lowerBoundPrefix, stateUnknownNote, collectStateNote, unionNote } from './horizonSessionText.js';
import { growthCell } from './storageGrowthText.js';

describe('COL2606-01 현재 사용자 하한', () => {
  it('원문이 잘린 서버가 있으면 최소 N명', () => {
    expect(usersCountText(65, true)).toBe('최소 65명');
    expect(usersCountText(65, false)).toBe('65명');
    expect(usersCountText(null, true)).toBe('—');
    expect(usersCountText('', false)).toBe('—');
    expect(truncatedNote({ vmsTruncated: 2 })).toMatch(/2대/);
    expect(truncatedNote({ vmsTruncated: 0 })).toBe('');
  });
});

describe('COL2606-04·WEB2606-09 Horizon 하한', () => {
  it('세션 절단·상태 미확인이면 접속 중 수는 최소값', () => {
    expect(lowerBoundPrefix({ usersConnected: 5, truncated: true }, 'connected')).toBe('최소 ');
    expect(lowerBoundPrefix({ usersConnected: 5, stateUnknown: 2 }, 'connected')).toBe('최소 ');
    expect(lowerBoundPrefix({ usersConnected: 5, stateUnknown: 0 }, 'connected')).toBe('');
    expect(lowerBoundPrefix({ usersConnected: null, truncated: true }, 'connected')).toBe('');
    expect(lowerBoundPrefix({ users: 3, truncated: true }, 'users')).toBe('최소 ');
    expect(lowerBoundPrefix({ sessions: 3, sessionsLowerBound: true }, 'sessions')).toBe('최소 ');
    expect(stateUnknownNote({ stateUnknown: 2 })).toMatch(/상태 미확인 2세션/);
    expect(stateUnknownNote({ stateUnknown: null })).toBe('');
  });
  it('일부만 읽은 서버를 상태 문구가 밝히고, 이름 목록 절단과 다른 문장을 쓴다', () => {
    const d = { settings: { enabled: true, intervalMs: 300000 }, registered: 2, targets: 2, lastReadAt: 1, total: { serversOk: 2, serversFailed: 0, serversTruncated: 1 } };
    expect(collectStateNote(d).kind).toBe('truncated');
    const u = unionNote({ users: 1500, usersByServerSum: 1510, usersLowerBound: true, usersOmitted: 0 });
    expect(u).toMatch(/페이지 상한/);
    expect(u).not.toMatch(/이름 목록/);
  });
});

describe('RECENT2606-01 mixed 칸은 가리지 않는다', () => {
  it('mixed 는 값을 보이고 사유를 title 에', () => {
    const c = growthCell({ bytes: 1e13, resolutionBytes: 1.1e14, mixed: true, belowResolution: true }, 'auto');
    expect(c.text).not.toMatch(/미만/);
    expect(c.title).toMatch(/반올림 주기가 섞여/);
    const r = growthCell({ bytes: 1e13, resolutionBytes: 1.1e14, belowResolution: true }, 'auto');
    expect(r.text).toMatch(/미만/);
  });
});
