import { describe, it, expect } from 'vitest';
import { stepTimeText, jobLine, hms, confirmText, JOB_STATE, STEP_STATE_ICON, upgradeOffered, UPGRADE_BUTTON_TEXT, UPGRADE_HELP_TEXT } from './edgeTokenApplyText.js';

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
    expect(jobLine({ startedAt: T, state: 'ok', path: 'ssh', edgeHost: 'edge2.corp', fp: 'ab12cd34' })).toBe('10-24 14:50:02 · 완료 · SSH 통로 · 호스트 edge2.corp · 지문 ab12cd34');
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

describe('v2.826 옛 판 엣지 — 업그레이드 뒤 자동 적용', () => {
  it('upgradeOffered — 마지막 작업이 hint upgrade 로 끝났을 때만(진행 중·다른 실패·없음은 아니다)', () => {
    expect(upgradeOffered({ state: 'failed', hint: 'upgrade' })).toBe(true);
    expect(upgradeOffered({ state: 'running', hint: 'upgrade' })).toBe(false);
    expect(upgradeOffered({ state: 'failed', hint: '' })).toBe(false);
    expect(upgradeOffered({ state: 'failed' })).toBe(false);
    expect(upgradeOffered(null)).toBe(false);
    expect(upgradeOffered(undefined)).toBe(false);
  });
  it('확인 문구 — 업그레이드 옵션이면 엣지 재시작·대기 상한을 먼저 말한다 · 기본 문구는 그대로 · 백틱 없음', () => {
    const t = confirmText('agent-WA', { upgradeFirst: true });
    expect(t).toContain('0) 엣지 판이 2.776.0 미만이면');
    expect(t).toContain('재시작');
    expect(t).toContain('최대 5분');
    expect(t).toContain('1) 중앙에서 개별 토큰 발급');
    expect(t).not.toContain('`');
    expect(confirmText('agent-WA')).not.toContain('0)');
    expect(confirmText('agent-WA', {})).toBe(confirmText('agent-WA'));
    expect(UPGRADE_BUTTON_TEXT).toBe('엣지 업그레이드 뒤 자동 적용');
    expect(UPGRADE_HELP_TEXT).toContain('2.776.0');
    expect(UPGRADE_HELP_TEXT).not.toContain('`');
  });
  it('작업 한 줄 — 엣지 판·업그레이드 뒤 옵션이 보인다(없으면 빠진다)', () => {
    expect(jobLine({ startedAt: T, by: 'noainred', state: 'failed', edgeVersion: '2.775.0' })).toBe('10-24 14:50:02 · noainred · 실패 · 판 2.775.0');
    expect(jobLine({ startedAt: T, state: 'ok', path: 'edge-api', upgradeFirst: true, edgeVersion: '2.826.0', fp: 'ab12cd34' })).toBe('10-24 14:50:02 · 완료 · 업그레이드 뒤 · 수집 토큰 통로 · 판 2.826.0 · 지문 ab12cd34');
    expect(jobLine({ startedAt: T, state: 'ok', upgradeFirst: false, edgeVersion: '' })).toBe('10-24 14:50:02 · 완료');
  });
});
