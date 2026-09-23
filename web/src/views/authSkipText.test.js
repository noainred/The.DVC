/**
 * authSkipText — v2.591(감사 F1·F2·F4·F5) 인증 실패 정지를 보조 수집기·게스트 계정·메일·네트워크 모니터
 * 화면이 **말하게** 하는 문구. 고정하는 것: 조용히 빼지 않는다(개수·이름) · 원인을 단정하지 않는다 ·
 * 수동 실행은 막지 않는다는 사실 · 백틱 0(BoldText 는 강조만 해석한다).
 */
import { describe, it, expect } from 'vitest';
import { vcAuthSkipNote, guestAuthLines, mailAuthStopText, netmonStopBadge, cloneRunMark } from './authSkipText.js';

const NOW = Date.UTC(2026, 8, 23, 3, 30, 0); // 고정 기준 시각(Date.now() 를 쓰지 않는다 — CLAUDE.md v2.517)
const stop = { since: NOW - 30 * 60_000, at: NOW - 5 * 60_000, attempts: 2, reason: 'SMTP 인증 실패 — 서버 응답 535' };

describe('vcAuthSkipNote (F1)', () => {
  it('정지 vCenter 가 없으면 빈 문자열(말할 것이 없다)', () => {
    expect(vcAuthSkipNote(null)).toBe('');
    expect(vcAuthSkipNote([])).toBe('');
    // 다른 사유로 건너뛴 것은 인증 정지가 아니다 — 이 문장에 섞지 않는다
    expect(vcAuthSkipNote([{ vcenterId: 'vc1', why: 'no-folder' }])).toBe('');
  });

  it('건너뜀 목록(why)과 정지 전용 목록 둘 다 받는다 · 개수와 이름을 밝힌다', () => {
    const a = vcAuthSkipNote([{ vcenterId: 'vc1', name: 'HQ', why: 'auth-stopped' }, { vcenterId: 'vc2', why: 'no-folder' }], { what: '현재 사용자 수집' });
    expect(a).toContain('vCenter 1곳');
    expect(a).toContain('HQ');
    expect(a).toContain('현재 사용자 수집');
    const b = vcAuthSkipNote([{ vcenterId: 'a' }, { vcenterId: 'b' }, { vcenterId: 'c' }, { vcenterId: 'd' }, { vcenterId: 'e' }, { vcenterId: 'f' }]);
    expect(b).toContain('vCenter 6곳');
    expect(b).toContain('외 2곳'); // 앞 4개 + 나머지 개수 — 조용히 자르지 않는다
  });

  it('수동 실행 버튼 이름이 있으면 막지 않는다는 사실을 말한다', () => {
    const s = vcAuthSkipNote([{ vcenterId: 'vc1' }], { manual: '지금 수집' });
    expect(s).toContain("'지금 수집'은 막지 않습니다");
    expect(vcAuthSkipNote([{ vcenterId: 'vc1' }])).not.toContain('막지 않습니다(1회');
  });
});

describe('guestAuthLines (F2)', () => {
  it('기록이 없거나 아무 일도 없으면 빈 배열', () => {
    expect(guestAuthLines(null)).toEqual([]);
    expect(guestAuthLines({ vmStopped: 0, vmSkipped: 0 })).toEqual([]);
  });

  it('OS 스캐너 모양(vcStopped 배열 · breakerTripped · breakerSkipped)', () => {
    const lines = guestAuthLines({ vcStopped: [{ vcenterId: 'vc1' }], breakerTripped: [{ vcenterId: 'vc1' }], breakerSkipped: 7, vmStopped: 3, vmSkipped: 10 });
    expect(lines.length).toBe(4);
    expect(lines[0]).toContain('vc1');
    expect(lines[1]).toContain('연속 3회');
    expect(lines[1]).toContain('남은 VM 7대');
    expect(lines.join(' ')).toContain('거부 3대');
    expect(lines.join(' ')).toContain('건너뛴 VM 10대');
  });

  it('게스트 스캔 모양(vcStopped 객체 · jobStopped · breaker 객체) — 임계는 서버 값을 쓴다', () => {
    const lines = guestAuthLines({ vcStopped: { vcenterId: 'vc9' }, jobStopped: { attempts: 1 }, breaker: { threshold: 4, tripped: ['x'], skipped: 6 } }, { manual: '지금' });
    expect(lines[0]).toContain('vc9');
    expect(lines[1]).toContain('작업 계정');
    expect(lines[1]).toContain('실패 1회');
    expect(lines[1]).toContain("'지금'은 막지 않습니다");
    expect(lines[2]).toContain('연속 4회');
    expect(lines[2]).toContain('남은 VM 6대');
  });

  it('시도 횟수를 모르면 지어내지 않는다(Number(null) === 0 함정)', () => {
    const lines = guestAuthLines({ jobStopped: { attempts: null } });
    expect(lines[0]).not.toContain('실패 0회');
  });
});

describe('mailAuthStopText (F4) / netmonStopBadge (F5)', () => {
  it('메일: 정지가 없으면 빈 문자열 · 있으면 자동 발송을 멈췄다고 말하고 테스트 발송은 막지 않는다', () => {
    expect(mailAuthStopText(null, NOW)).toBe('');
    const s = mailAuthStopText(stop, NOW);
    expect(s).toContain('자동 발송을 멈췄습니다');
    expect(s).toContain("'메일 테스트'는 막지 않습니다");
    expect(s).toContain('535');
  });

  it('네트워크 모니터: 멈춘 쪽만 배지에 적고 title 에는 별표를 남기지 않는다', () => {
    expect(netmonStopBadge(null, NOW)).toBe(null);
    expect(netmonStopBadge({}, NOW)).toBe(null);
    const b = netmonStopBadge({ B: stop }, NOW);
    expect(b.label).toBe('인증 실패 정지(B)');
    expect(b.title).toContain('B 서버');
    expect(b.title).toContain('주기 실행을 멈췄습니다');
    expect(b.title).not.toContain('**'); // title 속성은 BoldText 를 거치지 않는다
    expect(netmonStopBadge({ A: stop, B: stop }, NOW).label).toBe('인증 실패 정지(A·B)');
  });
});

describe('cloneRunMark (F1)', () => {
  it('인증 정지로 건너뛴 실행은 실패도 성공도 아니다', () => {
    expect(cloneRunMark({ ok: false, skipped: true })).toEqual({ icon: '⏸', tone: 'amber' });
    expect(cloneRunMark({ ok: true })).toEqual({ icon: '✅', tone: 'green' });
    expect(cloneRunMark({ ok: false })).toEqual({ icon: '⛔', tone: 'red' });
  });
});

describe('문구 위생', () => {
  it('어느 문구에도 백틱이 없다(BoldText 는 강조만 해석한다)', () => {
    const all = [
      vcAuthSkipNote([{ vcenterId: 'vc1' }], { manual: '지금 수집' }),
      ...guestAuthLines({ vcStopped: [{ vcenterId: 'v' }], jobStopped: { attempts: 1 }, breaker: { tripped: [1], skipped: 2 }, vmStopped: 1, vmSkipped: 1 }, { manual: '지금' }),
      mailAuthStopText(stop, NOW),
      netmonStopBadge({ A: stop }, NOW).title,
    ].join('\n');
    expect(all).not.toContain('`');
  });
});
