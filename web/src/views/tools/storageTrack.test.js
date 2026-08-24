// 스토리지 사용량 추이(v2.350) 파생 계산 회귀 테스트.
// 조용히 틀리기 쉬운 두 지점을 고정한다:
//  1) 기간 증감을 '전체 첫 슬롯' 기준으로 잡으면, 중간에 등록된 vCenter 가 '전량 신규'로
//     과대 계상된다 → vCenter 단위 첫/마지막.
//  2) 일평균을 '슬롯 수 ÷ 2'로 나누면 폴러가 멈춘 구간에서 왜곡된다 → 수집 시각 차이.
import { describe, it, expect } from 'vitest';
import { tb, gbTb, perVcSummary, growth, hasDsData } from './storageTrack.js';

const DAY = 86_400_000;

describe('tb', () => {
  it('GB→TB 소수 1자리', () => {
    expect(tb(1024)).toBe(1);
    expect(tb(1536)).toBe(1.5);
    expect(tb(0)).toBe(0);
  });
  it('무효값은 0(차트 축이 NaN 으로 깨지지 않게)', () => {
    expect(tb(null)).toBe(0);
    expect(tb(undefined)).toBe(0);
    expect(tb('x')).toBe(0);
  });
});

describe('gbTb', () => {
  it('1TB 경계에서 단위 전환', () => {
    expect(gbTb(512)).toBe('512 GB');
    expect(gbTb(999)).toBe('999 GB');
    expect(gbTb(1023)).toMatch(/GB$/); // 1023 은 아직 GB(천단위 구분자는 로케일 의존이라 단위만 고정)
    expect(gbTb(1024)).toBe('1 TB');
    expect(gbTb(1536)).toBe('1.5 TB');
  });
  it('음수도 절대값 기준으로 단위 전환(감소 표기)', () => {
    expect(gbTb(-2048)).toBe('-2 TB');
    expect(gbTb(-100)).toBe('-100 GB');
  });
  it('무효값은 대시', () => {
    expect(gbTb(null)).toBe('—');
    expect(gbTb(undefined)).toBe('—');
    expect(gbTb(NaN)).toBe('—');
  });
});

describe('perVcSummary', () => {
  const bySlotVc = {
    '2026-08-20T00': [
      { snapId: 1, vcenterId: 'vc-a', dsCount: 3, dsCapGB: 10240, dsUsedGB: 5120, dsUsagePct: 50 },
    ],
    '2026-08-20T12': [
      { snapId: 2, vcenterId: 'vc-a', dsCount: 3, dsCapGB: 10240, dsUsedGB: 6144, dsUsagePct: 60 },
      { snapId: 3, vcenterId: 'vc-b', dsCount: 1, dsCapGB: 2048, dsUsedGB: 1024, dsUsagePct: 50 }, // 중간 등록
    ],
    '2026-08-21T00': [
      { snapId: 4, vcenterId: 'vc-a', dsCount: 4, dsCapGB: 12288, dsUsedGB: 7168, dsUsagePct: 58.3 },
      { snapId: 5, vcenterId: 'vc-b', dsCount: 1, dsCapGB: 2048, dsUsedGB: 1124, dsUsagePct: 54.9 },
    ],
  };

  it('마지막 슬롯의 현재값 + vCenter별 첫 슬롯 대비 증감', () => {
    const rows = perVcSummary(bySlotVc);
    const a = rows.find((r) => r.vcenterId === 'vc-a');
    expect(a.snapId).toBe(4);
    expect(a.dsCount).toBe(4);
    expect(a.usedGB).toBe(7168);
    expect(a.capGB).toBe(12288);
    expect(a.freeGB).toBe(5120);
    expect(a.usagePct).toBe(58.3);
    expect(a.deltaGB).toBe(2048); // 7168 - 5120(첫 슬롯)
  });

  it('중간에 등장한 vCenter 는 전량 신규가 아니라 자기 첫 슬롯 기준으로 증감', () => {
    const b = perVcSummary(bySlotVc).find((r) => r.vcenterId === 'vc-b');
    expect(b.deltaGB).toBe(100); // 1124 - 1024, 1124 가 아니다
  });

  it('사용률 미제공(구버전 응답)이면 용량으로 재계산', () => {
    const rows = perVcSummary({ s1: [{ snapId: 9, vcenterId: 'vc-c', dsCapGB: 1000, dsUsedGB: 250 }] });
    expect(rows[0].usagePct).toBe(25);
  });

  it('용량 0 이면 사용률 0(0 나눗셈 금지)', () => {
    const rows = perVcSummary({ s1: [{ snapId: 9, vcenterId: 'vc-d', dsCapGB: 0, dsUsedGB: 0 }] });
    expect(rows[0].usagePct).toBe(0);
    expect(rows[0].freeGB).toBe(0);
  });

  it('빈 입력은 빈 배열', () => {
    expect(perVcSummary({})).toEqual([]);
    expect(perVcSummary(null)).toEqual([]);
  });

  it('구버전(ds 열 0) 행은 기준선이 아니다 — 첫 DS 행 기준으로 증감', () => {
    const rows = perVcSummary({
      s1: [{ snapId: 1, vcenterId: 'vc-a', dsCount: 0, dsCapGB: 0, dsUsedGB: 0 }],   // v2.348 이전
      s2: [{ snapId: 2, vcenterId: 'vc-a', dsCount: 10, dsCapGB: 20000, dsUsedGB: 15000, dsUsagePct: 75 }],
      s3: [{ snapId: 3, vcenterId: 'vc-a', dsCount: 10, dsCapGB: 20000, dsUsedGB: 15100, dsUsagePct: 75.5 }],
    });
    expect(rows[0].deltaGB).toBe(100); // 15100 - 15000, 15100 전체가 아니다
  });
});

describe('hasDsData', () => {
  it('ds 열이 전부 0(v2.348 이전 행)이면 false, 하나라도 있으면 true', () => {
    expect(hasDsData({ dsCapGB: 0, dsUsedGB: 0, dsCount: 0 })).toBe(false);
    expect(hasDsData({})).toBe(false);
    expect(hasDsData(null)).toBe(false);
    expect(hasDsData({ dsCapGB: 100 })).toBe(true);
    expect(hasDsData({ dsCount: 1 })).toBe(true);
  });
});

describe('growth', () => {
  it('v2.348 이전(ds 열 0) 스냅샷은 기준선에서 제외 — 전체 사용량이 증가로 잡히던 회귀(실제 발생)', () => {
    const t0 = 1_760_000_000_000;
    const g = growth([
      { collectedAt: t0, dsUsedGB: 0, dsCapGB: 0, dsCount: 0 },                    // 구버전 행
      { collectedAt: t0 + 0.5 * DAY, dsUsedGB: 21_239_086, dsCapGB: 29_485_772, dsCount: 1091 }, // 첫 DS 스냅샷
      { collectedAt: t0 + 1.5 * DAY, dsUsedGB: 21_240_110, dsCapGB: 29_485_772, dsCount: 1091 },
    ]);
    expect(g.netGB).toBe(1024); // +1TB — 2만 TB 전체가 아니다
    expect(g.spanDays).toBe(1); // 기간도 DS 스냅샷 사이만
    expect(g.perDayGB).toBe(1024);
  });

  it('DS 스냅샷이 1건뿐이면(직전 전부 구버전) 증감 0·추정 없음', () => {
    const g = growth([
      { collectedAt: 1_760_000_000_000, dsUsedGB: 0, dsCapGB: 0, dsCount: 0 },
      { collectedAt: 1_760_000_000_000 + DAY, dsUsedGB: 5000, dsCapGB: 10000, dsCount: 5 },
    ]);
    expect(g.netGB).toBe(0);
    expect(g.fullDays).toBeNull();
  });

  it('실측 경과일 기준 일평균과 소진 예상', () => {
    const t0 = 1_760_000_000_000;
    const g = growth([
      { collectedAt: t0, dsUsedGB: 1000, dsCapGB: 10000 },
      { collectedAt: t0 + 10 * DAY, dsUsedGB: 2000, dsCapGB: 10000 },
    ]);
    expect(g.spanDays).toBe(10);
    expect(g.netGB).toBe(1000);
    expect(g.perDayGB).toBe(100);
    expect(g.freeGB).toBe(8000);
    expect(g.fullDays).toBe(80); // 8000 / 100
  });

  it('슬롯 수가 아니라 시각 차이로 센다(폴러 정지 구간 왜곡 방지)', () => {
    const t0 = 1_760_000_000_000;
    // 슬롯 3개지만 실제로는 20일 경과(중간이 비어 있음) — '슬롯/2=1.5일'로 세면 일평균이 13배 부풀려진다.
    const g = growth([
      { collectedAt: t0, dsUsedGB: 1000, dsCapGB: 10000 },
      { collectedAt: t0 + 10 * DAY, dsUsedGB: 1500, dsCapGB: 10000 },
      { collectedAt: t0 + 20 * DAY, dsUsedGB: 2000, dsCapGB: 10000 },
    ]);
    expect(g.spanDays).toBe(20);
    expect(g.perDayGB).toBe(50);
  });

  it('감소·정체 추세면 소진 예상은 null', () => {
    const t0 = 1_760_000_000_000;
    expect(growth([
      { collectedAt: t0, dsUsedGB: 2000, dsCapGB: 10000 },
      { collectedAt: t0 + 5 * DAY, dsUsedGB: 1500, dsCapGB: 10000 },
    ]).fullDays).toBeNull();
    expect(growth([
      { collectedAt: t0, dsUsedGB: 2000, dsCapGB: 10000 },
      { collectedAt: t0 + 5 * DAY, dsUsedGB: 2000, dsCapGB: 10000 },
    ]).fullDays).toBeNull();
  });

  it('스냅샷 1건(첫 수집)은 증감 0·추정 없음', () => {
    const g = growth([{ collectedAt: 1_760_000_000_000, dsUsedGB: 500, dsCapGB: 1000 }]);
    expect(g.spanDays).toBe(0);
    expect(g.netGB).toBe(0);
    expect(g.perDayGB).toBe(0);
    expect(g.fullDays).toBeNull();
  });

  it('빈 입력도 안전', () => {
    expect(growth([])).toEqual({ spanDays: 0, netGB: 0, perDayGB: 0, freeGB: 0, fullDays: null });
    expect(growth(null).fullDays).toBeNull();
  });
});
