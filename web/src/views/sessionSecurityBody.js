import { blankOr } from './blankOr.js';

/**
 * 설정 › 세션 보안 저장 본문(v2.607, 감사 WEB2607-01). 숫자 칸 넷은 blankOr 로 보낸다 — 빈 칸은 **키를 빼서**
 * 서버가 이전 값을 유지하게 한다(서버 securitySettings.js 는 v2.596 부터 빈 값=이전 값, 명시적 0 만 무제한).
 * 예전에는 세션 총 상한 빈 칸을 `'' → 0` 으로 바꿔 보내 **8시간 강제 로그아웃 정책이 조용히 풀렸고**,
 * 나머지 세 칸은 `Number('') || 기본값` 이라 이전 값이 아니라 기본값(30·10·60)으로 덮였다.
 */
/**
 * @param {object} s 화면 값 @param {string} otp @param {{ bareosSetupOtp?: boolean }} [orig] 불러온 값 — 주면 바뀐 보안 칸만 싣는다
 *   (v2.842 반증 F4: 오래 열어 둔 화면이 무관한 항목을 저장하며 그사이 다시 켠 값을 '끔' 으로 되돌리지 않게)
 */
export function sessionSecurityBody(s, otp, orig) {
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
    // v2.842: Bareos 자동 설정 본인 OTP 재확인 — 불리언일 때만 · 불러온 값(orig)이 있으면 바꿨을 때만 보낸다(없음을 '끔' 으로 · 옛 화면 값을 새 값 위에 덮지 않는다)
    ...(typeof s.bareosSetupOtp === 'boolean' && (!orig || typeof orig.bareosSetupOtp !== 'boolean' || orig.bareosSetupOtp !== s.bareosSetupOtp) ? { bareosSetupOtp: s.bareosSetupOtp } : {}),
    otp: String(otp || '').trim(),
  };
}

/**
 * 100회차(98회차 남긴 것 ③): 서버 GET /admin/security/session 의 recovery({ source, problem }) — 본 파일(security-session.json)을 못 읽어
 *   직전 값 · 신뢰 사본 · 엄격 값으로 도는 중이면 화면이 그 사실을 말한다(예전에는 응답에만 있고 화면은 파일 값처럼 보였다).
 *   이름표는 서버 자가 점검(server/src/security/selfCheck.js SESSION_RECOVERY_LABELS)과 같다 — 두 벌이라 서버 테스트(rebut100)가 대조한다.
 */
export const SESSION_RECOVERY_LABELS = Object.freeze({
  problem: Object.freeze({ 'read-error': '읽기 오류', corrupt: '손상', missing: '없음' }),
  source: Object.freeze({ 'last-good': '이 프로세스가 마지막으로 읽은 값', 'trusted-copy': '신뢰 사본(security-session.trusted.json)의 값', strict: '엄격 값(전 계정 OTP 전용 · 단일 세션 · 총 상한 8시간)' }),
});
/** @returns {string} 화면 한 줄 — 회복 중이 아니면 '' */
export function sessionRecoveryText(rec) {
  if (!rec || typeof rec !== 'object') return '';
  const source = SESSION_RECOVERY_LABELS.source[rec.source];
  if (!source) return '';
  const problem = SESSION_RECOVERY_LABELS.problem[rec.problem] || '읽지 못함';
  const next = rec.problem === 'read-error'
    ? '파일 소유자 · 권한(포탈 서비스 계정 · 0600)을 먼저 고치세요 — 읽기 오류 동안 저장은 거절됩니다(30초마다 다시 읽습니다).'
    : '값을 확인한 뒤 본인 OTP 로 저장하면 본 파일이 다시 쓰입니다.';
  return `세션 보안 설정 파일(security-session.json) ${problem} — 지금은 ${source}으로 동작하고 있어 아래 값은 파일 값이 아닙니다. ${next}`;
}
