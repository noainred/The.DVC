import { blankOr } from './blankOr.js';

/**
 * 설정 › 세션 보안 저장 본문(v2.607, 감사 WEB2607-01). 숫자 칸 넷은 blankOr 로 보낸다 — 빈 칸은 **키를 빼서**
 * 서버가 이전 값을 유지하게 한다(서버 securitySettings.js 는 v2.596 부터 빈 값=이전 값, 명시적 0 만 무제한).
 * 예전에는 세션 총 상한 빈 칸을 `'' → 0` 으로 바꿔 보내 **8시간 강제 로그아웃 정책이 조용히 풀렸고**,
 * 나머지 세 칸은 `Number('') || 기본값` 이라 이전 값이 아니라 기본값(30·10·60)으로 덮였다.
 */
export function sessionSecurityBody(s, otp) {
  const owners = String(s.settingsOwners || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  return {
    idleLogoutEnabled: s.idleLogoutEnabled,
    idleLogoutMin: blankOr(s.idleLogoutMin),
    settingsOwners: owners,
    loginPolicy: s.loginPolicy || undefined,
    singleSession: !!s.singleSession,
    // demoSession(v2.294): null 도 유효한 상태값('전역 따름')이라 항상 전송한다(서버가 정규화).
    demoSession: s.demoSession || null,
    sessionWarnEnabled: !!s.sessionWarnEnabled,
    sessionWarnMin: blankOr(s.sessionWarnMin),
    sessionExtendMin: blankOr(s.sessionExtendMin),
    sessionMaxHours: blankOr(s.sessionMaxHours),
    otp: String(otp || '').trim(),
  };
}
