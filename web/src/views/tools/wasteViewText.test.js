import { describe, it, expect } from 'vitest';
import { reclaimStorage, ageBucketOf, ageCounts, corpOffShare, sizeText, AGE_BUCKETS } from './wasteViewText.js';

describe('wasteViewText (v2.651 시안 A)', () => {
  it('회수 가능 스토리지 = 꺼진 VM 점유 + Thin 여유, 둘 다 모르면 null', () => {
    const r = reclaimStorage({ poweredOff: { storageGB: 290406 }, thinReclaim: { reclaimableGB: 350413, count: 1620 } });
    expect(r.totalGB).toBe(640819); expect(r.offPct).toBe(45); expect(r.thinVms).toBe(1620); expect(r.partial).toBe(false);
    expect(reclaimStorage({})).toBe(null);
    expect(reclaimStorage({ poweredOff: { storageGB: 100 } }).partial).toBe(true);
  });
  it('꺼진 기간 칸: 경계는 긴 쪽, 모르는 값은 모름(0일 아님)', () => {
    expect(ageBucketOf(30)).toBe('ge30'); expect(ageBucketOf(29)).toBe('d7'); expect(ageBucketOf(7)).toBe('d7');
    expect(ageBucketOf(6)).toBe('lt7'); expect(ageBucketOf(0)).toBe('lt7');
    expect(ageBucketOf(null)).toBe('unknown'); expect(ageBucketOf('')).toBe('unknown'); expect(ageBucketOf(-1)).toBe('unknown');
    expect(AGE_BUCKETS.map((b) => b.k)).toEqual(['ge30', 'd7', 'lt7', 'unknown']);
  });
  it('분포: 행이 모자라면 모름으로, off-since 전이면 null', () => {
    expect(ageCounts([{ offDays: 40 }, { offDays: 10 }, { offDays: null }], 5)).toEqual({ ge30: 1, d7: 1, lt7: 0, unknown: 3 });
    expect(ageCounts(null, 5)).toBe(null);
  });
  it('법인별 점유: 0 제외 · 큰 순 · 나머지 합', () => {
    const r = corpOffShare([{ vcenterId: 'a', poweredOffGB: 10 }, { vcenterId: 'b', poweredOffGB: 0 }, { vcenterId: 'c', poweredOffGB: 40 }, { vcenterId: 'd', poweredOffGB: 5 }], 2);
    expect(r.top.map((x) => x.vcenterId)).toEqual(['c', 'a']); expect(r.top[0].pct).toBe(100);
    expect(r.restCount).toBe(1); expect(r.restGB).toBe(5);
  });
  it('크기 문구', () => {
    expect(sizeText(null)).toBe('—'); expect(sizeText(512)).toBe('512 GB'); expect(sizeText(290406)).toBe('283.6 TB');
  });
});

describe('Optimization 화면 소스 규약(v2.651)', () => {
  it('0 인 분포 칸은 중립색(zero) 클래스를 쓴다 · 확인 필요 후보 안내를 지우지 않는다', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./CapacityTools.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/dist\[b\.k\] \? b\.k : 'zero'/);
    expect(src).toMatch(/확인 필요 후보/);
    expect(src).toMatch(/포탈은 VM 을 지우지 않습니다/);
  });
});
