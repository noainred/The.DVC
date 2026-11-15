/**
 * auth/otpRebind.js — **본인 자격증명 변경 전 현재 OTP 확인**(전체 점검 19회차 A-2 · 20회차 반증 F1 — 판정 하나).
 *
 * 왜: 세션 토큰만으로 본인 OTP 를 다른 앱으로 다시 묶거나(begin → confirm) 해제 · 비밀번호 설정 · 로그인 차단을 할 수 있으면
 *   탈취한 세션(로그아웃 · 유휴 · 총 상한으로 끝나야 할 것)이 **영구 계정 탈취**가 된다. 19회차는 본인 경로(/auth/totp/*)만 막았고,
 *   admin 은 관리자 대리 라우트(/admin/users/:me/totp/* · password)를 자기 자신에게 써서 그대로 우회했다(20회차 반증 F1 — 재현).
 *   그래서 **대상 = 요청자이고 OTP 가 등록된 계정**이면 어느 경로든 이 함수로 현재 코드를 받는다. 다른 사람 대상 대리 등록(폰 분실 복구)은 그대로.
 *   확인은 계정별로 10분 기억한다 — begin 에서 확인하고 confirm 은 그 기억이 있을 때만(begin 만 막으면 남은 pending 시크릿으로 confirm 만 부를 수 있다).
 *   빈 코드는 OTP 실패로 세지 않는다(잠금 카운터 보호). 기억은 노드 메모리 — 재시작 · 다른 노드면 다시 확인(닫히는 쪽).
 */
import { getUser, verifyUserOtp } from './auth.js';

export const SELF_REBIND_MS = 10 * 60_000;
const _ok = new Map();   // username → 현재 OTP 를 확인한 시각

/** OTP 가 실제로 등록된(로그인에 쓰이는) 계정인가. 레거시 '시작만 하고 미확정'(totpSecret && !totpEnabled)은 아니다. */
export function otpEnrolled(name) {
  const u = getUser(name);
  return !!(u && u.totpEnabled && u.totpSecret);
}

/** 대상이 요청자 자신인가 — 저장된 계정 이름으로 비교한다(대소문자만 다른 경로 인자로 비켜 가지 못하게). */
export function isSelfTarget(req, targetName) {
  const u = getUser(targetName);
  return !!(u && req?.user?.username && u.username === req.user.username);
}

/**
 * 현재 OTP 를 확인한다. 등록되지 않은 계정은 확인할 것이 없다(null).
 * @returns {null | { status:number, body:{ ok:false, needCurrentOtp:true, reason:string } }}
 */
export function requireCurrentOtp(name, currentCode, what = '본인 자격증명 변경') {
  if (!otpEnrolled(name)) return null;
  const cur = String(currentCode ?? '').trim();
  const v = cur ? verifyUserOtp(name, cur) : { ok: false, reason: '현재 코드가 없습니다' };
  if (!v.ok) {
    return { status: v.locked ? 429 : 403, body: { ok: false, needCurrentOtp: true,
      reason: `본인 계정의 ${what}에는 지금 쓰는 OTP 앱의 코드(currentCode)가 필요합니다(${v.reason || '확인 실패'}). 폰을 잃었으면 다른 관리자에게 대리 등록을 요청하세요.` } };
  }
  _ok.set(getUser(name).username, Date.now());
  return null;
}

/** begin 에서 현재 코드를 확인한 지 10분 안인가(confirm 이 본다). 등록되지 않은 계정은 늘 참. */
export function selfRebindVerified(name) {
  if (!otpEnrolled(name)) return true;
  return Date.now() - (_ok.get(getUser(name).username) || 0) < SELF_REBIND_MS;
}
export function clearSelfRebind(name) { const u = getUser(name); if (u) _ok.delete(u.username); }
export function _resetOtpRebindForTest() { _ok.clear(); }
