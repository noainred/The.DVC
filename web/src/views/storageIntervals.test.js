/**
 * storageIntervals 회귀 테스트(v2.409) — 중앙에서 엣지 수집 주기를 지정하는 화면의 순수 로직.
 * 핵심은 '미지정 = 상속(엣지 로컬 유지)' 계약이다. 이게 깨지면 중앙이 전 키를 배포해
 * 각 법인이 portal.env 로 잡아 둔 현장 설정을 통째로 덮어쓴다.
 */
import { describe, it, expect } from 'vitest';
import { effectiveFor, sourceOf, worstCaseLagMs, lagText, toBody, presetsFor, msLabel } from './storageIntervals.js';

describe('effectiveFor', () => {
  it('전역 위에 대상별 값을 덮는다', () => {
    expect(effectiveFor({ pollMs: 600_000, pushMs: 300_000 }, { pollMs: 60_000 }))
      .toEqual({ pollMs: 60_000, pushMs: 300_000 });
  });

  it('미지정 키는 결과에 넣지 않는다 — 엣지 로컬 설정을 덮지 않기 위한 계약', () => {
    expect(effectiveFor({}, {})).toEqual({});
    expect(effectiveFor({ pollMs: 0, pushMs: 300_000 }, { areasMs: null })).toEqual({ pushMs: 300_000 });
  });
});

describe('sourceOf', () => {
  it('대상별 > 전역 > 상속', () => {
    expect(sourceOf('pollMs', { pollMs: 1 }, { pollMs: 2 })).toBe('target');
    expect(sourceOf('pollMs', { pollMs: 1 }, {})).toBe('global');
    expect(sourceOf('pollMs', {}, {})).toBe('inherit');
  });
});

describe('worstCaseLagMs', () => {
  it('엣지는 수집 주기 + push 주기(중앙 화면 반영까지)', () => {
    const r = worstCaseLagMs({ pollMs: 600_000, pushMs: 300_000 }, {});
    expect(r).toEqual({ ms: 900_000, estimated: false });
    expect(lagText({ pollMs: 600_000, pushMs: 300_000 }, {})).toBe('최대 15분');
  });

  it('중앙 직접 수집은 push 가 없어 수집 주기만', () => {
    expect(worstCaseLagMs({ pollMs: 600_000, pushMs: 300_000 }, {}, { isEdge: false }).ms).toBe(600_000);
  });

  it('미지정이면 기본값으로 추정하고 estimated 로 알린다(확정값처럼 보이면 안 됨)', () => {
    const r = worstCaseLagMs({}, { pollMs: 600_000, pushMs: 300_000 });
    expect(r.ms).toBe(900_000);
    expect(r.estimated).toBe(true);
    expect(lagText({}, { pollMs: 600_000, pushMs: 300_000 }).startsWith('약 ')).toBe(true);
  });

  it('1시간 넘으면 시간+분 표기', () => {
    expect(lagText({ pollMs: 3_600_000, pushMs: 600_000 }, {})).toBe('최대 1시간 10분');
    expect(lagText({ pollMs: 3_600_000, pushMs: 3_600_000 }, {})).toBe('최대 2시간');
  });
});

describe('toBody', () => {
  it('빈 문자열(미지정)은 키를 빼고, 나머지는 숫자로 변환', () => {
    expect(toBody({ pollMs: '60000', pushMs: '' }, { 'agent-MI': { areasMs: '600000', pollMs: '' } }))
      .toEqual({ global: { pollMs: 60_000 }, agents: { 'agent-MI': { areasMs: 600_000 } } });
  });
});

describe('presetsFor / msLabel', () => {
  it('하한 미만 선택지는 숨긴다(서버가 어차피 올림 — 고를 수 있으면 거짓말이 된다)', () => {
    expect(presetsFor(600_000).every((p) => p.ms >= 600_000)).toBe(true);
    expect(presetsFor(600_000).some((p) => p.ms === 60_000)).toBe(false);
  });
  it('프리셋에 없는 값도 정확히 표기', () => {
    expect(msLabel(600_000)).toBe('10분');
    expect(msLabel(420_000)).toBe('7분');
    expect(msLabel(90_000)).toBe('90초');
    expect(msLabel(0)).toBe('미지정');
  });
});
