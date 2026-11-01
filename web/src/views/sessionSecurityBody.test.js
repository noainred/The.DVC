import { describe, it, expect } from 'vitest';
import { sessionSecurityBody } from './sessionSecurityBody.js';

describe('sessionSecurityBody (WEB2607-01)', () => {
  it('빈 칸은 키를 빼 서버가 이전 값을 유지한다 — 세션 총 상한 빈 칸이 0(무제한)이 되지 않는다', () => {
    const b = JSON.parse(JSON.stringify(sessionSecurityBody({ idleLogoutMin: '', sessionWarnMin: '', sessionExtendMin: '', sessionMaxHours: '' }, '123456')));
    expect('sessionMaxHours' in b).toBe(false);
    expect('idleLogoutMin' in b).toBe(false);
    expect('sessionWarnMin' in b).toBe(false);
    expect('sessionExtendMin' in b).toBe(false);
  });
  it('명시적 0 은 0(무제한)으로, 숫자는 숫자로 보낸다', () => {
    const b = sessionSecurityBody({ idleLogoutMin: '45', sessionWarnMin: 5, sessionExtendMin: '90', sessionMaxHours: '0', settingsOwners: 'a, b' }, ' 1 ');
    expect(b.sessionMaxHours).toBe(0);
    expect(b.idleLogoutMin).toBe(45);
    expect(b.sessionWarnMin).toBe(5);
    expect(b.sessionExtendMin).toBe(90);
    expect(b.settingsOwners).toEqual(['a', 'b']);
    expect(b.otp).toBe('1');
  });
  it('v2.842 Bareos 자동 설정 본인 OTP 재확인 — 불리언일 때만 보낸다(조회에 칸이 없으면 끔으로 보내지 않는다)', () => {
    expect('bareosSetupOtp' in sessionSecurityBody({}, '1')).toBe(false);
    expect('bareosSetupOtp' in sessionSecurityBody({ bareosSetupOtp: null }, '1')).toBe(false);
    expect('bareosSetupOtp' in sessionSecurityBody({ bareosSetupOtp: 'false' }, '1')).toBe(false);
    expect(sessionSecurityBody({ bareosSetupOtp: false }, '1').bareosSetupOtp).toBe(false);
    expect(sessionSecurityBody({ bareosSetupOtp: true }, '1').bareosSetupOtp).toBe(true);
  });
  it('v2.842 반증 F4 — 불러온 값(orig)을 주면 바뀐 때만 보낸다(오래 열어 둔 화면이 그사이 다시 켠 값을 끔으로 덮지 않게)', () => {
    expect('bareosSetupOtp' in sessionSecurityBody({ bareosSetupOtp: false }, '1', { bareosSetupOtp: false })).toBe(false);
    expect('bareosSetupOtp' in sessionSecurityBody({ bareosSetupOtp: true }, '1', { bareosSetupOtp: true })).toBe(false);
    expect(sessionSecurityBody({ bareosSetupOtp: false }, '1', { bareosSetupOtp: true }).bareosSetupOtp).toBe(false);
    expect(sessionSecurityBody({ bareosSetupOtp: true }, '1', { bareosSetupOtp: false }).bareosSetupOtp).toBe(true);
    expect(sessionSecurityBody({ bareosSetupOtp: false }, '1', {}).bareosSetupOtp).toBe(false);   // 불러온 값을 모르면 예전처럼
  });
});
