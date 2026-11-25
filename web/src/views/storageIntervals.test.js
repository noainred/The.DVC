/**
 * storageIntervals 회귀 테스트(v2.409) — 중앙에서 엣지 수집 주기를 지정하는 화면의 순수 로직.
 * 핵심은 '미지정 = 상속(엣지 로컬 유지)' 계약이다. 이게 깨지면 중앙이 전 키를 배포해
 * 각 법인이 portal.env 로 잡아 둔 현장 설정을 통째로 덮어쓴다.
 */
import { describe, it, expect } from 'vitest';
import { effectiveFor, sourceOf, worstCaseLagMs, lagText, toBody, presetsFor, presetsForSpec, rangeText, timeoutSpecs, timerSpecs, unsetNote, msLabel } from './storageIntervals.js';
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
    // 주기 표와 대기 시간 표가 사양을 빠짐없이 · 겹치지 않게 나눈다(한 항목이 두 표에 나오거나 어느 표에도 안 나오면 안 된다)
    expect(timerSpecs([POLL, ISI]).map((s) => s.key)).toEqual(['pollMs']);
    expect(timerSpecs(null)).toEqual([]);
  });
  it('화면은 사양으로 선택지를 그리고 숫자를 따로 갖지 않는다', () => {
    const src = fs.readFileSync(new URL('./StorageIntervals.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/const presets = presetsForSpec\(s\);/);
    // 대기 시간은 주기 표의 열이 아니라 따로 그린다 — 주기 표는 1440px 에서도 가로로 넘쳐 새 열이 스크롤해야만 보였다(Chromium 판독).
    expect(src).toMatch(/const timerSpec = timerSpecs\(spec\);/);
    expect(src).toMatch(/const timeoutSpec = timeoutSpecs\(spec\);/);
    expect(src).toMatch(/\{timerSpec\.map\(\(s\) => <th key=\{s\.key\}/);
    expect(src).toMatch(/\{timeoutSpec\.length > 0 && \(/);
    expect(src).not.toMatch(/\{spec\.map\(/);   // 사양 전체를 한 표에 그리지 않는다
    // 이름 뒤에 조사를 붙이지 않는다(‘명령 대기은’ — 이름은 서버 사양에서 오므로 받침을 알 수 없다)
    expect(src).not.toMatch(/\{s\.label\}<\/b>[은는이가을를]/);
    expect(src).not.toMatch(/300_?000|180_?000/);
  });
});

// v3.41.1 — 주기 표가 1440px 에서도 본문 폭을 넘던 것(대상 칸 설명 한 줄 471px · 긴 첫 선택지). 첫 선택지를 줄이고 칸 아래 줄이 뜻을 말한다.
describe('unsetNote — 선택 칸 아래 줄(v3.41.1)', () => {
  it('전역 행: 지정하면 그 값, 아니면 엣지 로컬 값을 그대로 둔다고 말한다', () => {
    expect(unsetNote('pollMs', '__global__', { pollMs: '1800000' }, {})).toBe('→ 30분');
    expect(unsetNote('pollMs', '__global__', {}, {})).toBe('엣지 로컬 값 유지');
    expect(unsetNote('pollMs', '__global__', { pollMs: '' }, {})).toBe('엣지 로컬 값 유지');
  });
  it('대상 행: 지정 > 전역(물려받았다고 밝힌다) > 로컬(중앙은 env · 엣지는 엣지 로컬)', () => {
    expect(unsetNote('pollMs', 'NJ', { pollMs: '1800000' }, { pollMs: '600000' })).toBe('→ 10분');
    expect(unsetNote('pollMs', 'NJ', { pollMs: '1800000' }, {})).toBe('→ 30분(전역 기본)');
    expect(unsetNote('pollMs', 'NJ', {}, {})).toBe('엣지 로컬');
    expect(unsetNote('pollMs', '', {}, {})).toBe('중앙 기본(env)');
    expect(unsetNote('isiCmdTimeoutMs', '', { isiCmdTimeoutMs: '120000' }, { isiCmdTimeoutMs: '300000' })).toBe('→ 5분');
  });
  it('화면: 첫 선택지는 짧고(열 폭) · 줄바꿈은 낱말 단위 · 고정 칸 배경은 행 배경과 같은 변수', () => {
    const src = fs.readFileSync(new URL('./StorageIntervals.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/\{target === '__global__' \? '미지정' : '상속'\}/);
    expect(src).not.toMatch(/'미지정\(엣지 로컬\)'/);          // 긴 첫 선택지가 열 폭을 정했다
    expect(src).toMatch(/const WRAP_TD = \{ whiteSpace: 'normal', wordBreak: 'keep-all'/);
    expect(src).toMatch(/const WRAP_TH = \{ whiteSpace: 'normal', wordBreak: 'keep-all'/);
    // 고정(sticky) 칸은 불투명 배경 — 표 바탕 · 전역 행과 같은 변수여야 떠 보이지 않는다
    expect(src).toMatch(/const TABLE_BG = \{ background: 'var\(--panel\)' \}/);
    expect(src).toMatch(/const STICKY_TD = \{ \.\.\.WRAP_TD, position: 'sticky', left: 0, zIndex: 1, background: 'var\(--panel\)' \}/);
    expect(src).toMatch(/const GLOBAL_ROW = \{ background: 'var\(--panel-2\)' \}/);
    expect(src).toMatch(/const STICKY_TD_GLOBAL = \{ \.\.\.STICKY_TD, background: 'var\(--panel-2\)' \}/);
    expect((src.match(/className="table-wrap" style=\{TABLE_BG\}/g) || []).length).toBe(2);
    expect((src.match(/<tr style=\{GLOBAL_ROW\}>/g) || []).length).toBe(2);
  });
});
