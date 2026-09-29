import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ACTIVITY_TEXT, activityOf, memText, gbText, tempText, allocText, capacityNote, coverageText, activityRuleNote, activitySummary } from './gpuUsageText.js';

describe('gpuUsageText (v2.650)', () => {
  it('값이 없으면 단위를 붙이지 않는다', () => {
    expect(tempText(null)).toBe('—'); expect(tempText('')).toBe('—'); expect(tempText(71.4)).toBe('71℃');
    expect(memText(null, 1000)).toBe('—'); expect(memText(2048, 0)).toBe('—');
    expect(memText(42048, 163840)).toBe('41.1 / 160 GB');
    expect(gbText(null)).toBe('—'); expect(gbText(0.5)).toBe('0.5 GB');
  });
  it('동작 상태 문구는 서버 상태 5종을 덮고, 모르는 값은 판정 불가', () => {
    expect(Object.keys(ACTIVITY_TEXT).sort()).toEqual(['busy', 'held', 'idle', 'off', 'unknown']);
    expect(activityOf('xx')).toBe(ACTIVITY_TEXT.unknown);
    expect(activitySummary({ busy: 2, held: 0, idle: 1, unknown: 0 })).toBe('연산 중 2 · 유휴 1');
    expect(activitySummary({ busy: 0, held: 0, idle: 0, unknown: 0 })).toBe('');
  });
  it('할당: vGPU 는 GB, 패스스루는 장, 해석 불가는 개수로', () => {
    expect(allocText({ allocGB: 60, capacityGB: 160, allocPct: 38, passthroughOn: 0 })).toBe('vGPU 60 GB / 160 GB (38%)');
    expect(allocText({ allocGB: null, passthroughOn: 2 })).toBe('패스스루 2장');
    expect(allocText({ allocGB: null, passthroughOn: 0, allocUnknown: 1 })).toBe('프로파일 해석 불가 1대');
    expect(allocText({ allocGB: null, passthroughOn: 0 })).toMatch(/할당 없음/);
  });
  it('용량 출처·수집 범위·판정 기준을 말한다', () => {
    expect(capacityNote({ capacityGB: 282, capacityEstimated: true })).toMatch(/추정/);
    expect(capacityNote({ capacityGB: null })).toMatch(/알 수 없습니다/);
    expect(coverageText({ vmsOn: 3, vmsRead: 1 })).toMatch(/\*\*1대\*\*.*2대는 미수집/);
    expect(coverageText({ vmsOn: 2, vmsRead: 0 })).toMatch(/게스트 수집값이 없습니다/);
    expect(activityRuleNote({ busyUtilPct: 10, heldMemPct: 10 })).toMatch(/10% 이상 = 연산 중/);
  });
  it('문구에 백틱이 없다(BoldText 는 백틱을 글자로 그린다)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'gpuUsageText.js'), 'utf8');
    const strings = src.match(/'[^'\n]*'/g) || [];
    expect(strings.filter((s) => s.includes('`'))).toEqual([]);
  });
});

describe('activitySummary short (v2.650 판독)', () => {
  it('표 칸용 짧은 표기', () => {
    expect(activitySummary({ busy: 3, held: 1, idle: 2, unknown: 1 }, { short: true })).toBe('연산 3 · 점유 1 · 유휴 2 · 불가 1');
  });
});
