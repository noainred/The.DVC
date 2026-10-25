import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prevKpiMeta, prevCompareNote, elapsedText } from './sanPortUsageText.js';

// v2.782(점검 K3 I-B2) — 진행 중 기간의 '앞 기간 대비' 는 같은 경과 구간끼리 견준다(서버가 잘라 준 값 + 화면 안내).
const H = 3_600_000;

describe('앞 기간 KPI 한 줄', () => {
  it('진행 중이면 같은 구간이라고 밝히고, 지난 기간은 전과 같다', () => {
    expect(prevKpiMeta(110e6, 100e6, { sameElapsed: true })).toBe('앞 기간 같은 구간 800.0 Mbps (+10%)');
    expect(prevKpiMeta(110e6, 100e6)).toBe('앞 기간 800.0 Mbps (+10%)');
    expect(prevKpiMeta(90e6, 100e6)).toMatch(/\(-10%\)$/);
  });
  it('어느 쪽이든 값이 없으면 변화율을 붙이지 않는다(0% 로 지어내지 않는다)', () => {
    expect(prevKpiMeta(null, 100e6)).not.toMatch(/%/);
    expect(prevKpiMeta(100e6, null, { sameElapsed: true })).toBe('앞 기간 같은 구간 —');
  });
});

describe('같은 경과 시간 안내', () => {
  it('진행 중(sameElapsed)일 때만 안내하고, 경과 시간을 적는다', () => {
    const note = prevCompareNote({ sameElapsed: true, elapsedMs: 6 * H + 10 * 60_000 });
    expect(note).toContain('같은 경과 시간');
    expect(note).toContain('6시간 10분');
    expect(note).toContain('겹쳐 그린 선은 앞 기간 전체');
    expect(prevCompareNote({ avgMean: 1 })).toBe('');
    expect(prevCompareNote(null)).toBe('');
  });
  it('문구에 백틱이 없다(BoldText 는 강조만 해석)', () => {
    expect(prevCompareNote({ sameElapsed: true, elapsedMs: H })).not.toMatch(/`/);
  });
  it('경과 시간 표기 — 하루 미만은 시간·분, 이상은 일·시간', () => {
    expect(elapsedText(0)).toBe('0분');
    expect(elapsedText(45 * 60_000)).toBe('45분');
    expect(elapsedText(6 * H + 10 * 60_000)).toBe('6시간 10분');
    expect(elapsedText(3 * 24 * H + 5 * H + 59 * 60_000)).toBe('3일 5시간');
    expect(elapsedText(2 * 24 * H)).toBe('2일');
    expect(elapsedText(null)).toBe('—');
  });
});

describe('화면 연결', () => {
  it('SanPortUsage 는 앞 기간 KPI 를 prevKpiMeta 로, 안내를 prevCompareNote 로 그린다', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'SanPortUsage.jsx'), 'utf8');
    expect(src).toMatch(/prevKpiMeta\(k\.avg, kp\.avg, \{ sameElapsed: kp\.sameElapsed \}\)/);
    expect(src).toMatch(/prevKpiMeta\(k\.peak, kp\.peak, \{ sameElapsed: kp\.sameElapsed \}\)/);
    expect(src).toMatch(/prevCompareNote\(t\.chart\.prev\)/);
  });
});
