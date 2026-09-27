// v2.628 그룹 A — 법인별 사용량·배포 현황 문구(C2628-03·04·06 · R2628-04·05·07 · EDGE2628-01 · SEC2628-02).
import { describe, it, expect } from 'vitest';
import { coverageText, srcText, isPartial, noticesOf } from './corpUsageText.js';
import { distStateOf, distributionCounts, distributionSummary } from './bmUsageDistText.js';

describe('법인별 사용량 문구(v2.628)', () => {
  it('지표 하나만 빠진 서버·키 겹침을 반영 문구가 말하고, 부분으로 본다', () => {
    const a = { servers: 3, cpu: { n: 3 }, mem: { n: 2 }, unread: 0, stale: 0, noCap: 0, memMissing: 1, keyConflict: 1 };
    const t = coverageText(a);
    expect(t).toContain('메모리 값 없음 1');
    expect(t).toContain('키 겹침 1');
    expect(isPartial(a)).toBe(true);
  });
  it('섞인 출처는 iDRAC+OS 로 밝힌다', () => {
    expect(srcText({ src: { idrac: 1, os: 0, mixed: 2, vcenter: 0 } })).toBe('iDRAC 1 · iDRAC+OS 2');
  });
  it('읽히지 않는 vCenter·엣지 절단을 안내하고, 설정 안내는 이 포탈 기준임을 말한다', () => {
    const texts = noticesOf({ settings: { enabled: false }, corps: [], unreadVcenters: 2, edgeTruncated: 5 }).map((n) => n.text).join('\n');
    expect(texts).toContain('지금 읽히지 않는 vCenter 2곳');
    expect(texts).toContain('5대 잘렸습니다');
    expect(texts).toContain('이 포탈의 베어메탈 사용률 수집이 꺼져 있습니다');
    expect(texts).not.toMatch(/`/);
  });
});

describe('배포 현황 문구(v2.628)', () => {
  it('전달됨 상태와 이름 미검증 개수를 센다', () => {
    const dist = { enabled: true, rows: [{ state: 'applied' }, { state: 'delivered' }, { state: 'pending', verified: false }] };
    const c = distributionCounts(dist);
    expect(c.delivered).toBe(1);
    expect(c.unverified).toBe(1);
    const s = distributionSummary(dist);
    expect(s).toContain('전달됨 1');
    expect(s).toContain('이름 미검증 1');
    expect(distStateOf('delivered').label).toBe('전달됨');
  });
});
