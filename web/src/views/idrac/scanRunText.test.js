/**
 * scanRunText — '법인별 iDRAC 장비 스캔' 표의 최근 결과 문구(v2.441).
 * 사용자 요구: '발견(xx대)' 표기 + 성공/실패 표시. 위임 스캔이 결과를 못 보여주던 회귀를 고정한다.
 */
import { describe, it, expect } from 'vitest';
import { describeScanRun } from './scanRunText.js';

describe('describeScanRun', () => {
  it('기록이 없으면 —', () => {
    const d = describeScanRun(null);
    expect(d.state).toBe('none');
    expect(d.text).toBe('—');
  });

  it('성공 — 발견 대수를 사용자 요구 형식으로 보여준다', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 3, registered: 3, scanned: 254, durationMs: 45_000, agent: 'AZ' });
    expect(d.state).toBe('ok');
    expect(d.badge).toBe('성공');
    expect(d.text).toContain('발견 3대');
    expect(d.text).toContain('등록 3대');
    expect(d.text).toContain('스캔 254개');
    expect(d.tone).toBe('green');
    expect(d.title).toContain('위임(AZ)');
    expect(d.title).toContain('45초');
  });

  it('성공했지만 0대면 초록으로 강조하지 않는다(찾은 게 없는 것도 사실대로)', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 0, registered: 0, scanned: 100 });
    expect(d.badge).toBe('성공');
    expect(d.text).toContain('발견 0대');
    expect(d.tone).toBe('muted');
  });

  it('무응답·인증실패는 괄호로 덧붙인다', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 2, registered: 2, scanned: 254, unreachable: 250, authFailed: 2 });
    expect(d.text).toContain('(무응답 250 · 인증실패 2)');
  });

  it('차단 대역이라 찌르지 않은 IP 는 개수를 말한다(v2.537 — 조용한 제외 금지)', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 1, scanned: 10, blocked: 3 });
    expect(d.extra).toContain('차단대역 제외 3');
    expect(d.text).toContain('(차단대역 제외 3)');
    // 0 이면 조각을 만들지 않는다(없는 것을 말하지 않는다)
    expect(describeScanRun({ at: 1, ok: true, found: 1, scanned: 10, blocked: 0 }).extra).toEqual([]);
  });

  it('실패 — 사유를 보여주고 툴팁에 전문', () => {
    const err = '엣지 응답 HTTP 401 — 이 엣지에 PUSH 스캔 엔드포인트가 없습니다. 경로가 없어 인증 라우터가 401 을 낸 것입니다.';
    const d = describeScanRun({ at: 1, error: err, agent: 'nb-irs' });
    expect(d.state).toBe('fail');
    expect(d.badge).toBe('실패');
    expect(d.tone).toBe('red');
    expect(d.text).toContain('엣지 응답 HTTP 401');
    expect(d.text.startsWith('실패')).toBe(false);   // 배지와 중복되지 않게
    expect(d.title).toContain(err);            // 잘리지 않은 전문
  });

  it('위임했지만 결과 미회신은 대기 — 성공으로 오인하게 두지 않는다', () => {
    const now = 1_000_000;
    const d = describeScanRun({ at: 1, delegated: true, pending: true, agent: 'HM-IRS', dispatch: 'poll', dispatchedAt: now - 300_000 }, now);
    expect(d.state).toBe('pending');
    expect(d.badge).toBe('대기');
    expect(d.text).toContain('위임(HM-IRS) 요청함');
    expect(d.text).toContain('5분째');
    expect(d.title).toContain('에이전트 폴링');
  });

  it('PUSH 대기는 방식을 구분해 안내한다', () => {
    const d = describeScanRun({ at: 1, delegated: true, pending: true, agent: 'AZ-IRS', dispatch: 'push' });
    expect(d.title).toContain('중앙→엣지 직접 PUSH');
  });

  it('구버전 기록(pending 플래그 없음)도 대기로 본다 — 위임 + found 없음', () => {
    const d = describeScanRun({ at: 1, delegated: true, agent: 'GM1' });
    expect(d.state).toBe('pending');
  });

  it('중앙 직접 스캔은 위임 표기를 붙이지 않는다', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 1, registered: 1, scanned: 10 });
    expect(d.title).toContain('중앙');
    expect(d.title).not.toContain('위임');
  });
});

describe('metrics — 등록 수량 강조(v2.442, 사용자 요구)', () => {
  it('발견/등록/스캔을 조각으로 내보내고 등록에만 accent 를 붙인다', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 6, registered: 6, scanned: 30, unreachable: 20 });
    expect(d.metrics).toEqual([
      { k: '발견', n: 6, unit: '대' },
      { k: '등록', n: 6, unit: '대', accent: 'red' },
      { k: '스캔', n: 30, unit: '개' },
    ]);
    expect(d.extra).toEqual(['무응답 20']);
    // 문자열도 그대로 유지된다(툴팁·구버전 호환).
    expect(d.text).toBe('발견 6대 · 등록 6대 · 스캔 30개 (무응답 20)');
  });

  it('등록 값이 없으면 등록 조각을 만들지 않는다', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 2 });
    expect(d.metrics.map((m) => m.k)).toEqual(['발견']);
  });

  it('실패·대기에는 metrics 가 없다(색 강조 대상이 아니다)', () => {
    expect(describeScanRun({ at: 1, error: 'x' }).metrics).toBe(undefined);
    expect(describeScanRun({ at: 1, delegated: true, pending: true }).metrics).toBe(undefined);
  });
});
