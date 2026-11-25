/**
 * storageIntervals 회귀 테스트(v2.409) — 중앙에서 엣지 수집 주기를 지정하는 화면의 순수 로직.
 * 핵심은 '미지정 = 상속(엣지 로컬 유지)' 계약이다. 이게 깨지면 중앙이 전 키를 배포해
 * 각 법인이 portal.env 로 잡아 둔 현장 설정을 통째로 덮어쓴다.
 */
import { describe, it, expect } from 'vitest';
import { effectiveFor, sourceOf, worstCaseLagMs, lagText, toBody, presetsFor, presetsForSpec, rangeText, timeoutSpecs, msLabel } from './storageIntervals.js';
import fs from 'node:fs';

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

// v3.39.0 — PowerScale SSH 명령 대기(주기가 아닌 시한 · 기본 3분 · 1~5분). 선택지·범위는 서버 사양에서 온다.
describe('presetsForSpec / rangeText / timeoutSpecs (v3.39.0)', () => {
  const ISI = { key: 'isiCmdTimeoutMs', label: 'PowerScale SSH 명령 대기', def: 180_000, min: 60_000, max: 300_000, timer: false,
    presets: [60_000, 120_000, 180_000, 240_000, 300_000] };
  const POLL = { key: 'pollMs', label: '장비 수집 주기', def: 3_600_000, min: 60_000 };

  it('사양에 선택지가 있으면 그것만 — 5분을 넘는 주기 선택지(10분…24시간)를 보여 주지 않는다', () => {
    const ps = presetsForSpec(ISI);
    expect(ps.map((p) => p.ms)).toEqual([60_000, 120_000, 180_000, 240_000, 300_000]);
    expect(ps.map((p) => p.label)).toEqual(['1분', '2분', '3분', '4분', '5분']);
  });
  it('선택지가 없는 항목은 예전 그대로(하한 이상 전부) · 상한이 있으면 그 위는 뺀다', () => {
    expect(presetsForSpec(POLL)).toEqual(presetsFor(POLL.min));
    expect(presetsForSpec({ min: 60_000, max: 300_000 }).map((p) => p.ms)).toEqual([60_000, 120_000, 180_000, 300_000]);
    // 사양이 범위 밖 값을 실어도 고를 수 없다(서버가 어차피 가둔다 — 고를 수 있으면 거짓말이 된다)
    expect(presetsForSpec({ ...ISI, presets: [30_000, 180_000, 600_000, 'x'] }).map((p) => p.ms)).toEqual([180_000]);
  });
  it('범위 문구 — 상한이 있는 항목만 상한을 말한다', () => {
    expect(rangeText(ISI)).toBe('하한 1분 · 상한 5분 · 기본 3분');
    expect(rangeText(POLL)).toBe('하한 1분 · 기본 1시간');
  });
  it('시한 항목만 고른다 — 주기 설명과 따로 안내하려고', () => {
    expect(timeoutSpecs([POLL, ISI]).map((s) => s.key)).toEqual(['isiCmdTimeoutMs']);
    expect(timeoutSpecs(null)).toEqual([]);
  });
  it('화면은 사양으로 선택지를 그리고 숫자를 따로 갖지 않는다', () => {
    const src = fs.readFileSync(new URL('./StorageIntervals.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/const presets = presetsForSpec\(s\);/);
    expect(src).toMatch(/timeoutSpecs\(spec\)\.map/);
    expect(src).not.toMatch(/300_?000|180_?000/);
  });
});
