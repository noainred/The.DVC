/**
 * v2.733(점검 3회차 — 리드 후속, 그룹 d 보고): CPU·메모리 사용률을 둘 다 모르는 클러스터(REST 폴백 호스트만 · 끊긴 호스트만)는
 * 부하 0 이 아니라 '모름' 이다 — 예전에는 '호스트 ≥ 3 중 부하 최저 → 신규 배치 우선' 으로 뽑혔다.
 */
import { describe, it, expect } from 'vitest';
import { clusterRows, capacityAdvice } from './consoleData.js';

const known = { cluster: 'A', vcenterId: 'vc1', hosts: 4, cpuUsedPct: 40, memUsedPct: 55 };
const unknown = { cluster: 'B', vcenterId: 'vc2', hosts: 5, cpuUsedPct: null, memUsedPct: null };

describe('clusterRows · capacityAdvice — 사용률 모름', () => {
  it('부하를 null 로 두고 정렬 맨 뒤', () => {
    const rows = clusterRows([unknown, known]);
    expect(rows.map((r) => r.name)).toEqual(['A', 'B']);
    expect(rows[1].load).toBeNull();
    expect(rows[0].load).toBe(55);
  });
  it('신규 배치 우선 추천에서 뺀다', () => {
    const adv = capacityAdvice([unknown, known]);
    const room = adv.find((a) => a.level === 0);
    expect(room.title).toContain('A (vc1)');
    expect(adv.some((a) => a.title.includes('B (vc2)'))).toBe(false);
  });
  it('한쪽만 알면 아는 값으로', () => {
    expect(clusterRows([{ ...known, cpuUsedPct: null }])[0].load).toBe(55);
  });
});
