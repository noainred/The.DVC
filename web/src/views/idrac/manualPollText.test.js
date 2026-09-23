/**
 * manualPollText — '지금 1회 수집'(iDRAC) 응답 문구(v2.591 감사 P1).
 * 고정하는 것: 재진입 가드에 막힌 요청을 '방금 수집한 결과' 로 보고하지 않는다 ·
 * 긴급중단을 '성공 0 · 실패 0' 으로 말하지 않는다 · 구버전 서버(필드 없음)는 예전 문구.
 */
import { describe, it, expect } from 'vitest';
import { manualPollMessage } from './manualPollText.js';

describe('manualPollMessage', () => {
  it('busy 면 직전 lastRun 을 이번 결과인 척하지 않는다', () => {
    const m = manualPollMessage({ ran: false, busy: true, lastRun: { ok: 40, failed: 0 } });
    expect(m.ok).toBe(false);
    expect(m.tone).toBe('amber');
    expect(m.text).toContain('실행하지 않았습니다');
    expect(m.text).not.toContain('성공 40');
  });

  it('긴급중단이면 성공 0 · 실패 0 이 아니라 긴급중단이라 말한다(stopped 또는 구버전 skipped)', () => {
    for (const r of [{ stopped: true, lastRun: { ok: 0, failed: 0 } }, { lastRun: { skipped: '긴급중단', ok: 0, failed: 0 } }]) {
      const m = manualPollMessage(r);
      expect(m.tone).toBe('amber');
      expect(m.text).toContain('긴급중단');
      expect(m.text).not.toContain('성공 0');
    }
  });

  it('실제로 돌았으면 예전 문구 · 실패가 있으면 빨강 · 인증 정지 수를 덧붙인다', () => {
    expect(manualPollMessage({ ran: true, lastRun: { ok: 3, failed: 0 } })).toEqual({ ok: true, tone: 'green', text: '수동 1회 수집 — 성공 3 · 실패 0' });
    const m = manualPollMessage({ ran: true, lastRun: { ok: 2, failed: 1, authStopped: 4 } });
    expect(m.tone).toBe('red');
    expect(m.text).toContain('인증 실패 정지 4');
  });

  it('구버전 서버 응답(busy/stopped 없음)도 예전과 같게 읽는다', () => {
    expect(manualPollMessage({ ok: true, lastRun: { ok: 1, failed: 0 } }).text).toBe('수동 1회 수집 — 성공 1 · 실패 0');
    expect(manualPollMessage(null).text).toBe('수동 1회 수집 — 성공 0 · 실패 0');
  });
});
