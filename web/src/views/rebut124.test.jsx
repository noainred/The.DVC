/**
 * views/rebut124.test.jsx — 전체 점검 124회차(119회차 수정 반증) 화면 문구.
 *
 *  A1 서버가 **정지 기록 파일을 못 읽는 동안** 모르는 대상에 돌려주는 정지(util/authGuard.js unreadStop — 표지 unread · 시도 0회)는 인증 실패가 아니다.
 *     공용 문구(authStopInfo)가 '인증 실패로 … 멈췄습니다(실패 0회) · 비밀번호를 고치면 자동으로 다시 시작' 이라고 말했다(둘 다 사실이 아니다).
 *  A5 장비 신뢰 배너: 읽기 오류 동안 **승인돼 있던 장비도 전부 거부**된다는 사실을 말하고, 읽지 못하던 중에 파일이 없어진 경우(gone)는
 *     '원본은 그대로 · 읽히면 돌아온다' 가 아니라 '되돌리거나 재시작' 이라고 말한다.
 */
import { describe, it, expect } from 'vitest';
import { authStopInfo } from './tools/storageAuthText.js';
import { mailAuthStopText } from './authSkipText.js';
import { peerLoadErrorText } from './PeerTrustSettings.jsx';

const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const REASON = '정지 기록 파일(mail-auth-stops.json)을 읽지 못해 주기 수집을 건너뜁니다 — 읽기 오류(EACCES)이고 원본은 그대로 있습니다.';

describe('A1 정지 기록 읽기 오류로 건너뛴 대상 — 인증 실패라고 말하지 않는다', () => {
  it('표지(unread)가 있으면 읽기 오류 문구', () => {
    const r = authStopInfo({ since: NOW - 120_000, at: NOW - 120_000, attempts: 0, unread: true, reason: REASON }, { what: '이 PDU', manual: '지금 수집', now: NOW });
    expect(r.unread).toBe(true);
    expect(r.title).toBe('정지 기록 읽기 오류 — 주기 수집 건너뜀');
    expect(r.short).toBe('정지 기록 읽기 오류');
    expect(r.text).toContain('**정지 기록 파일을 읽지 못해 이 PDU의 주기 수집을 건너뛰고 있습니다**');
    expect(r.text).toContain('**인증 실패가 확인된 것이 아닙니다**');
    expect(r.text).toContain("'지금 수집'은 막지 않습니다");
    expect(r.text).toContain(`사유: ${REASON}`);
    expect(r.text).not.toMatch(/인증 실패로|실패 0회|계정이 잠기기|비밀번호\(계정\)를 고치면 자동으로 다시 시작/);
    expect(r.attempts).toBe(null);
    expect(r.text).not.toContain('`');
  });
  it('표지를 떨군 옛 응답 모양(시도 0회)도 같은 문구 — 실제 정지(1회 이상) · 시도 수를 모르는 정지는 예전 문구', () => {
    expect(authStopInfo({ since: NOW - 60_000, at: NOW - 60_000, attempts: 0, reason: REASON }, { now: NOW }).unread).toBe(true);
    const real = authStopInfo({ since: NOW - 60_000, at: NOW - 60_000, attempts: 1, reason: 'HTTP 401' }, { now: NOW });
    expect(real.unread).toBeUndefined();
    expect(real.text).toContain('**인증 실패로 이 대상의 주기 수집을 멈췄습니다**');
    expect(real.text).toContain('실패 1회');
    for (const attempts of [null, '', undefined]) {
      const r = authStopInfo({ since: NOW - 60_000, at: NOW - 60_000, attempts, reason: 'HTTP 401' }, { now: NOW });
      expect(r.unread).toBeUndefined();
      expect(r.text).toContain('인증 실패로');
    }
  });
  it('메일 자동 발송(설정 › 메일 발송)도 같은 문구', () => {
    const t = mailAuthStopText({ since: NOW - 60_000, at: NOW - 60_000, attempts: 0, unread: true, reason: REASON }, NOW);
    expect(t).toContain('**정지 기록 파일을 읽지 못해 메일의 자동 발송을 건너뛰고 있습니다**');
    expect(t).toContain("'메일 테스트'는 막지 않습니다");
    expect(t).not.toMatch(/인증 실패로 메일/);
  });
});

describe('A5 장비 신뢰 배너 — 읽기 오류 동안 무엇이 멈추는지 · 파일이 없어진 경우', () => {
  it('읽기 오류: 승인돼 있던 장비도 거부된다고 말한다', () => {
    const t = peerLoadErrorText({ code: 'unreadable', detail: 'EACCES', writeBlocked: true, readError: true });
    expect(t).toContain('**원본은 그대로 두고 저장을 멈췄습니다**');
    expect(t).toContain('**승인돼 있던 장비를 포함해 모든 SSH·TLS 장비 접속을 거부**합니다');
    expect(t).toContain('30초마다 다시 읽고');
    expect(t).not.toContain('재시작');
  });
  it('읽지 못하던 중에 파일이 없어짐(gone): 되돌리거나 재시작이라고 말한다', () => {
    const t = peerLoadErrorText({ code: 'unreadable', detail: 'ENOENT', writeBlocked: true, readError: true, gone: true });
    expect(t).toContain('**읽지 못하던 중에 파일이 없어졌습니다**');
    expect(t).toContain('포탈을 재시작하세요');
    expect(t).toContain('파일을 되돌리면');
    expect(t).toContain('모든 SSH·TLS 장비 접속을 거부');
    expect(t).not.toContain('원본은 그대로 두고');
    expect(t).not.toContain('`');
  });
  it('손상 · 옮기지 못함 갈래는 그대로', () => {
    expect(peerLoadErrorText({ code: 'unreadable', detail: 'EACCES', writeBlocked: true })).toContain('**원본을 옮기지 못해 저장을 멈췄습니다**');
    expect(peerLoadErrorText({ code: 'corrupt', preserved: 'peer-trust.json.corrupt.1' })).toContain('‘peer-trust.json.corrupt.1’ 로 보존했습니다');
  });
});
