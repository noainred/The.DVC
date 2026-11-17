/**
 * 민감 변경 재인증 게이트(v2.818 — routes/api/credentials.js 에서 옮겼다. 통합 계정 관리·Backup 백업 실행이 같은 판정을 쓴다).
 *  - 로컬 OTP 계정: 현재 OTP 코드(body.otp, DELETE 는 query.otp) — 1회용·실패 잠금(verifyUserOtp). 실패는 403 + needOtp(+needEnroll).
 *  - OTP 가 없는 계정(AD 등): 설정 소유자만.
 *  - 인증이 꺼진 설치(AUTH_ENABLED=false)는 통과(그 설치에는 계정 자체가 없다).
 * 복사해서 쓰지 말 것 — 판정이 갈라진다(CLAUDE.md '판정 코어는 하나').
 */
import { verifyUserOtp, getUser } from '../../auth/auth.js';
import { config } from '../../config.js';
import { loadSessionSecurity } from '../../security/securitySettings.js';

export function reauth(req, res, next) {
  if (!config.auth.enabled) return next();
  const username = req.user?.username || '';
  const u = getUser(username);
  if (u && u.totpEnabled) {
    const v = verifyUserOtp(username, req.body?.otp ?? req.query?.otp); // DELETE 는 본문이 없어 쿼리로
    if (!v.ok) return res.status(403).json({ ok: false, reason: v.reason, needOtp: true, needEnroll: !!v.needEnroll });
    return next();
  }
  let owners = [];
  try { owners = loadSessionSecurity().settingsOwners || []; } catch { owners = []; }
  if (owners.includes(username)) return next();
  return res.status(403).json({ ok: false, reason: 'OTP 가 없는 계정은 설정 소유자만 이 작업을 할 수 있습니다(OTP 를 등록하면 본인 재인증으로 가능).' });
}

/**
 * 본인 OTP 필수 게이트(소유자 예외 없음 — 위 reauth 와 다르다). OTP 미등록 계정은 403 + needEnroll, 틀린 코드는 403 + needOtp.
 *   호스트 접근 제어 적용 · 확정(v2.485 — routes/admin/hostAccess.js 에 있던 것을 옮겼다)과 원격 명령의 상태 변경 · 임의 실행
 *   (결정(56~75 남긴 것) — routes/api/rma.js)이 같은 판정을 쓴다. 인증이 꺼진 설치는 통과.
 * @param {string} what  OTP 미등록 사유 괄호 안 문구(예: '서버 접근 경로 변경')
 */
export function ownOtpGate(what) {
  return function requireOwnOtp(req, res, next) {
    if (!config.auth.enabled) return next();
    const name = req.user?.username || '';
    const u = getUser(name);
    if (!u?.totpEnabled) return res.status(403).json({ ok: false, reason: `이 작업은 OTP 가 등록된 계정만 실행할 수 있습니다(${what}). 사용자 관리에서 OTP 를 등록하세요.`, needEnroll: true });
    const v = verifyUserOtp(name, req.body?.otp);
    if (!v.ok) return res.status(403).json({ ok: false, reason: `OTP 인증 실패 — ${v.reason}`, needOtp: true });
    return next();
  };
}
