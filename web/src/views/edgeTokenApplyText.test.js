import { describe, it, expect } from 'vitest';
import { stepTimeText, jobLine, hms, confirmText, JOB_STATE, STEP_STATE_ICON } from './edgeTokenApplyText.js';

const T = new Date(2026, 9, 24, 14, 50, 2).getTime();

describe('v2.776 개별 토큰 자동 적용 문구', () => {
  it('단계 시각 — 끝난 단계는 구간·초, 진행 중은 그 사실', () => {
    expect(stepTimeText({ at: T, endAt: T + 2400, state: 'ok' })).toBe('14:50:02~14:50:04 (2초)');
    expect(stepTimeText({ at: T, endAt: null, state: 'running' })).toBe('14:50:02~ (진행 중)');
    expect(stepTimeText({ at: null })).toBe('');
    expect(hms(0)).toBe('');
  });
  it('작업 한 줄 — 시각·실행자·상태·통로·지문(토큰 평문 없음)', () => {
    expect(jobLine({ startedAt: T, by: 'noainred', state: 'ok', path: 'edge-api', fp: 'ab12cd34' })).toBe('10-24 14:50:02 · noainred · 완료 · 수집 토큰 통로 · 지문 ab12cd34');
    expect(jobLine({ startedAt: T, state: 'failed', path: null })).toBe('10-24 14:50:02 · 실패');
    expect(jobLine(null)).toBe('');
  });
  it('확인 문구는 단계와 무중단 사실을 말하고 백틱이 없다', () => {
    const t = confirmText('AZ-IRS');
    expect(t).toContain("'AZ-IRS'");
    expect(t).toContain('수집은 끊기지 않습니다');
    expect(t).not.toContain('`');
    for (const k of ['running', 'ok', 'warn', 'failed']) expect(JOB_STATE[k].text).toBeTruthy();
    for (const k of ['running', 'ok', 'warn', 'bad', 'skip']) expect(STEP_STATE_ICON[k]).toBeTruthy();
  });
});
