import { describe, it, expect } from 'vitest';
import { progressHint, blockedStep, STEP_ICON } from './veeamProgressText.js';

const steps = [
  { key: 'assign', label: '배정', state: 'ok' },
  { key: 'token', label: '개별 토큰', state: 'bad' },
  { key: 'contact', label: '엣지 접속', state: 'ok' },
  { key: 'result', label: '결과', state: 'wait' },
];

describe('v2.773 Veeam 진행 상태 표시', () => {
  it('앞 단계에서 막히면 상태 칸 아래에 단계 번호·이름을 말한다', () => {
    const h = progressHint({ steps, blockedAt: 'token' });
    expect(h).toEqual({ text: '진행 2/4단계 ‘개별 토큰’에서 막힘 — 진행 상태를 눌러 보세요', tone: 'bad' });
  });
  it('기다리는 단계는 막힘이 아니라 기다리는 중', () => {
    const h = progressHint({ steps: [{ key: 'contact', label: '엣지 접속', state: 'wait' }, { key: 'result', label: '결과', state: 'wait' }], blockedAt: 'contact' });
    expect(h.text).toContain('기다리는 중');
    expect(h.tone).toBe('muted');
  });
  it('마지막 결과 단계·막힌 곳 없음·모르는 키·progress 없음이면 한 줄을 붙이지 않는다', () => {
    expect(progressHint({ steps, blockedAt: 'result' })).toBeNull();
    expect(progressHint({ steps, blockedAt: null })).toBeNull();
    expect(progressHint({ steps, blockedAt: 'nope' })).toBeNull();
    expect(progressHint(undefined)).toBeNull();
    expect(blockedStep(null)).toBeNull();
  });
  it('문구에 백틱이 없다(BoldText 규약) · 상태마다 아이콘이 있다', () => {
    expect(progressHint({ steps, blockedAt: 'token' }).text).not.toContain('`');
    for (const k of ['ok', 'warn', 'bad', 'wait', 'skip']) expect(STEP_ICON[k]).toBeTruthy();
  });
});
