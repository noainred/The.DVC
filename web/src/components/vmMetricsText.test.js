/**
 * vmMetricsText — 성능 모달의 조회 실패 판정(v2.591 감사 F6).
 * 고정하는 것: 서버의 409 authStopped 를 알아보고(자동 갱신을 멈추는 근거) 횟수를 모르면 지어내지 않는다 ·
 * 다른 오류는 정지로 오인하지 않는다 · 백틱 0.
 */
import { describe, it, expect } from 'vitest';
import { metricErrorState, metricAuthStopText } from './vmMetricsText.js';

describe('metricErrorState', () => {
  it('409 authStopped 본문을 정지로 판정한다', () => {
    const err = Object.assign(new Error('인증 실패'), { status: 409, body: { authStopped: true, attempts: 3, since: 1000, reason: '인증 실패로 멈춘 vCenter' } });
    const s = metricErrorState(err);
    expect(s.authStopped).toEqual({ attempts: 3, since: 1000, reason: '인증 실패로 멈춘 vCenter' });
    expect(s.message).toBe('인증 실패로 멈춘 vCenter');
  });

  it('횟수·시각을 모르면 null(Number(null) === 0 함정)', () => {
    const s = metricErrorState({ body: { authStopped: true, attempts: null, since: '' } });
    expect(s.authStopped.attempts).toBe(null);
    expect(s.authStopped.since).toBe(null);
  });

  it('다른 오류(502·네트워크)는 정지가 아니다 — 자동 갱신을 멈추지 않는다', () => {
    expect(metricErrorState(Object.assign(new Error('SOAP 500'), { status: 502, body: { error: 'x' } })).authStopped).toBe(null);
    expect(metricErrorState(new Error('fetch failed')).authStopped).toBe(null);
    expect(metricErrorState('boom').message).toBe('boom');
    expect(metricErrorState({ body: { authStopped: 'true' } }).authStopped).toBe(null); // 불리언 true 만
  });
});

describe('metricAuthStopText', () => {
  it('정지가 없으면 빈 문자열 · 있으면 자동 갱신 중지와 조치 · 수동 1회를 말한다', () => {
    expect(metricAuthStopText(null)).toBe('');
    const t = metricAuthStopText({ attempts: 2 });
    expect(t).toContain('자동 갱신을 멈췄습니다');
    expect(t).toContain('실패 2회');
    expect(t).toContain('1회만 시도');
    expect(metricAuthStopText({ attempts: null })).not.toContain('실패 null');
    expect(t).not.toContain('`');
  });
});
