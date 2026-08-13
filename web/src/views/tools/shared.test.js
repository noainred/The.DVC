// 순수 유틸 회귀 테스트(v2.289 #4) — 웹 최초의 vitest 단위테스트. 전력 대시보드 단위 포맷은
// 임계(1e3/1e6/1e9)에서 상위 단위로 넘어가는 경계 로직이라 조용히 깨지기 쉽다. 결정적(로케일
// 무관: 천단위 구분자가 나오지 않는 값만 사용)인 fmtWatts/fmtKwh 를 고정해 회귀를 잡는다.
import { describe, it, expect } from 'vitest';
import { fmtWatts, fmtKwh } from './shared.jsx';

describe('fmtWatts', () => {
  it('W→kW→MW→GW 단위 스케일 전환', () => {
    expect(fmtWatts(500)).toBe('500 W');
    expect(fmtWatts(1500)).toBe('1.5 kW');
    expect(fmtWatts(2_500_000)).toBe('2.5 MW');
    expect(fmtWatts(3_000_000_000)).toBe('3 GW');
  });
  it('무효값(null/NaN/undefined)은 대시(—)', () => {
    expect(fmtWatts(null)).toBe('—');
    expect(fmtWatts(NaN)).toBe('—');
    expect(fmtWatts(undefined)).toBe('—');
  });
});

describe('fmtKwh', () => {
  it('kWh→MWh→GWh 단위 스케일 전환', () => {
    expect(fmtKwh(500)).toBe('500 kWh');
    expect(fmtKwh(1500)).toBe('1.5 MWh');
    expect(fmtKwh(2_000_000)).toBe('2 GWh');
  });
  it('무효값은 대시(—)', () => {
    expect(fmtKwh(null)).toBe('—');
    expect(fmtKwh(NaN)).toBe('—');
  });
});
