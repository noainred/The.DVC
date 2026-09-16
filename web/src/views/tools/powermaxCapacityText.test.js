/**
 * powermaxCapacityText.test.js — 구독·할당·실제 기록을 섞지 않는다(v2.534).
 * 수치는 서버 테스트(`server/test/powermaxWritten2534.test.js`)와 같은 표본을 쓴다.
 */
import { describe, it, expect } from 'vitest';
import { capacityRows, srpRows, subscribedNote, usageTrust, tb } from './powermaxCapacityText.js';

const EX_V3 = {
  capacityBasis: 'system_capacity.usable',
  capacityDetail: {
    usableUsedTb: 440.74, allocatedTb: 439.53, subscribedTb: 693.84,
    usableTotalTb: 1070.61, rawTb: 1325.68, snapshotTb: 12.5, subscribedPct: 65,
    srps: [{ array: 'A1', id: 'SRP_1', usedTb: 34.32, totalTb: 171.15, basis: 'srp_capacity.usable', drr: 1.6, compression: 'Enabled' }],
  },
};

describe('용량 구성 행', () => {
  it('★ 실제 기록 → 할당 → 구독 순서가 계약이다(셋의 관계가 보여야 한다)', () => {
    const keys = capacityRows(EX_V3).map((r) => r.key);
    expect(keys.slice(0, 3)).toEqual(['written', 'allocated', 'subscribed']);
    expect(keys).toContain('usable');
    expect(keys).toContain('raw');
  });

  it('실제 기록 행만 강조하고 설명에 "감축" 근거를 적는다', () => {
    const w = capacityRows(EX_V3).find((r) => r.key === 'written');
    expect(w.strong).toBe(true);
    expect(w.value).toBe('440.74 TB');
    expect(w.desc).toMatch(/감축/);
    expect(capacityRows(EX_V3).filter((r) => r.strong).length).toBe(1);
  });

  it('없는 값은 행을 만들지 않는다 — 0 으로 지어내지 않는다', () => {
    expect(capacityRows({ capacityDetail: { usableUsedTb: 1 } }).map((r) => r.key)).toEqual(['written']);
    expect(capacityRows({})).toEqual([]);
    expect(capacityRows(null)).toEqual([]);
  });

  it('tb — null 은 "—", 숫자는 천 단위 구분', () => {
    expect(tb(null)).toBe('—');
    expect(tb(undefined)).toBe('—');
    expect(tb('x')).toBe('—');
    expect(tb(1070.61)).toBe('1,070.61 TB');
    expect(tb(0)).toBe('0 TB');
  });
});

describe('구독 비율', () => {
  it('100% 초과가 정상임을 밝힌다(Dell 이 명시한 값)', () => {
    expect(subscribedNote({ capacityDetail: { subscribedPct: 246 } })).toMatch(/정상/);
    expect(subscribedNote({ capacityDetail: { subscribedPct: 65 } })).not.toMatch(/정상/);
    expect(subscribedNote({})).toBe(null);
  });
});

describe('SRP 행', () => {
  it('어느 필드로 읽었는지 밝히고 사용률을 계산한다', () => {
    const [r] = srpRows(EX_V3);
    expect(r.id).toBe('SRP_1');
    expect(r.basis).toBe('srp_capacity.usable');
    expect(r.pct).toBe(20.1);
    expect(r.meta).toMatch(/감축 1.60:1/);
    expect(r.meta).toMatch(/압축 Enabled/);
  });

  it('V4 는 감축 전(effective)을 참고로만 싣는다 — 사용량으로 올리지 않는다', () => {
    const [r] = srpRows({ capacityDetail: { srps: [{ id: 'S', usedTb: 0.49, totalTb: 108.95, effectiveUsedTb: 1.47, basis: 'fba_srp_capacity.effective.physical_capacity' }] } });
    expect(r.used).toBe('0.49 TB');
    expect(r.meta).toMatch(/감축 전 1.47 TB/);
  });

  it('전체가 0 이면 사용률은 null — 0% 라고 말하지 않는다', () => {
    const [r] = srpRows({ capacityDetail: { srps: [{ id: 'S', usedTb: 0, totalTb: 0 }] } });
    expect(r.pct).toBe(null);
  });

  it('SRP 가 없으면 빈 배열', () => {
    expect(srpRows({})).toEqual([]);
    expect(srpRows(null)).toEqual([]);
  });
});

describe('사용량 신뢰 판정', () => {
  it('★ physicalCapacity 로 읽었고 used==total 이면 경고한다', () => {
    const t = usageTrust({ capacitySuspect: true, capacityBasis: 'physicalCapacity' });
    expect(t.kind).toBe('suspect');
    expect(t.short).toBe('기준 불명');
    expect(t.text).toMatch(/실제 기록량이 아닐 수 있습니다/);
  });

  it('문서화된 필드로 읽었으면 경고하지 않는다', () => {
    expect(usageTrust(EX_V3).kind).toBe('ok');
    expect(usageTrust(EX_V3).short).toBe(null);
    expect(usageTrust({ capacityBasis: 'srp:fba_srp_capacity.effective.physical_capacity' }).kind).toBe('ok');
  });

  it('extra 가 없어도 터지지 않는다(다른 타입 장비)', () => {
    expect(usageTrust(null).kind).toBe('ok');
    expect(usageTrust(undefined).short).toBe(null);
  });
});
