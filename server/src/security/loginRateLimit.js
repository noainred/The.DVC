/**
 * 로그인 무차별 대입 방어 — IP+계정 키별 실패 카운터와 일시적 잠금(메모리, 의존성 없음).
 * 성공 시 카운터 초기화. 운영(단일 어플라이언스) 가정으로 관대한 기본값을 쓰되,
 * 환경변수로 조정/비활성화할 수 있다. 분산 다중노드라면 공유 저장소로 확장 필요.
 *
 *  - LOGIN_MAX_FAILS         (기본 8)   : 잠금 전 허용 실패 횟수
 *  - LOGIN_LOCKOUT_MS        (기본 900000=15분) : 잠금 지속시간
 *  - LOGIN_FAIL_WINDOW_MS    (기본 900000=15분) : 실패 카운트 집계 창
 *  - LOGIN_RATELIMIT_DISABLED=true       : 전체 비활성화(비권장)
 *
 * OTP 재인증(민감작업)용 별도 키 공간도 함께 제공한다 — 아래 checkOtpAllowed/recordOtpFailure/
 * recordOtpSuccess. 로그인 잠금과 카운터가 섞이면(같은 계정) 한쪽 실패로 다른 쪽이 잠기므로
 * 키를 분리한다.
 *  - OTP_MAX_FAILS           (기본 5)   : 잠금 전 허용 OTP 실패 횟수
 *  - OTP_LOCKOUT_MS          (기본 600000=10분)
 *  - OTP_FAIL_WINDOW_MS      (기본 600000=10분)
 *  - OTP_RATELIMIT_DISABLED=true         : OTP 잠금만 비활성화(비권장)
 */

const MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS) || 8;
const LOCKOUT_MS = Number(process.env.LOGIN_LOCKOUT_MS) || 15 * 60_000;
const WINDOW_MS = Number(process.env.LOGIN_FAIL_WINDOW_MS) || 15 * 60_000;
const DISABLED = process.env.LOGIN_RATELIMIT_DISABLED === 'true';

const attempts = new Map(); // key -> { count, first, lockUntil }

const keyOf = (ip, username) => `${String(ip || '?')}|${String(username || '?').toLowerCase()}`;

// 계정 전역(모든 IP 합산) 분산 브루트포스 방어 레이어. per-IP 키(<ip>|<user>)는 IP 로테이션으로
// 우회되므로, 계정 단위로도 실패를 합산한다 — 특히 OTP 전용 계정은 로그인 credential 이 6자리
// TOTP(100만 조합)라 시도 제한이 계정 단위여야 온라인 무차별을 막을 수 있다(감사 L5).
// 단, 임계값을 낮게 잡으면 '아무나 몇 번 틀려 정상 관리자 로그인을 봉쇄'하는 가용성 공격이 되므로
// per-IP 의 GLOBAL_FACTOR 배(기본 10×)로 높여, 단일 출발지 그리핑은 per-IP 잠금이 먼저 막고
// 계정 전역 잠금은 진짜 분산 공격(다수 IP)에서만 발동하게 한다(pyportal SessionStore 와 동형).
const GLOBAL_FACTOR = Number(process.env.LOGIN_GLOBAL_FACTOR) || 10;
const ACCT_MAX_FAILS = MAX_FAILS * GLOBAL_FACTOR;
const acctKeyOf = (username) => `acct:${String(username || '?').toLowerCase()}`; // ':' 라 per-IP('|') 키와 불충돌

/**
 * 출발지 전용(계정 무관) 레이어 — v2.500(감사 M-1).
 *
 * 왜 필요한가: 기존 두 키는 `<ip>|<user>` 와 `acct:<user>` 라, **사용자명을 매 요청 바꾸면 어느
 * 카운터도 차지 않는다**. 그런데 로그인은 요청마다 동기 scrypt 를 태운다(이 컨테이너 실측 ~48ms).
 * 전역 레이트리밋이 IP당 분당 1800(=30rps)이므로 30 × 48ms ≈ 초당 1.46초 분량의 동기 CPU 가 되어
 * 단일 출발지로 이벤트 루프를 상시 포화시킬 수 있었다(수집·폴링·전 UI 정지). 계정명과 무관한
 * 카운터가 있어야 이 패턴이 멈춘다. 사용자명 사전 열거 스윕도 같은 카운터에 걸린다.
 *
 * 임계값은 per-IP+계정 키보다 높게(기본 6×=48회/창) 잡는다 — NAT 뒤 사무실 하나가 오타 몇 번으로
 * 통째로 잠기는 가용성 사고를 피하기 위한 절충이다.
 *
 * ⚠ v2.503 정정(감사 S2, medium — v2.500 의 내 주석이 틀렸다): "정상 로그인 1회가 이 카운터도
 * 리셋한다" 는 **잠금 전까지만** 참이다. 일단 잠기면 `checkLoginAllowed` 가 시도 자체를 막으므로
 * 성공 경로에 도달할 수 없다(자기지속). 계정 무관 키라 이 잠금은 **그 출발지의 전 사용자**에게
 * 걸리고, 리버스 프록시 뒤라면 그 출발지가 곧 전 사용자다 → 48회 실패로 15분 전체 로그인 마비.
 * 그래서 두 가지를 바꾼다:
 *  · 이 레이어의 잠금 시간만 **분리**한다(`LOGIN_IP_LOCKOUT_MS`, 기본 60초). 목적이 '계정 열거와
 *    scrypt CPU 소진을 늦추는 것' 이므로 60초면 충분하다 — IP당 분당 ~48회 scrypt(≈2.3초 CPU)로
 *    묶이고, 오탐으로 잠긴 사무실은 15분이 아니라 1분 만에 복구된다. 계정을 아는 진짜 브루트포스는
 *    per-IP+계정(8회/15분)·계정 전역(80회/15분) 레이어가 그대로 막는다.
 *  · 호출부는 `util/rateLimit.js clientIp(req)` 로 출발지를 정한다 — `trust proxy` 가 설정된
 *    배포에서만 XFF 를 신뢰하고, 아니면 실제 peer 를 쓴다(v2.428 과 같은 규약). 그 전에는
 *    `req.socket.remoteAddress` 고정이라 프록시 뒤 전 사용자가 한 키를 공유했다.
 * 정직한 한계: 그래도 공유 NAT 에서 48회 실패가 누적되면 그 출발지가 60초 잠긴다.
 */
const IP_FACTOR = Number(process.env.LOGIN_IP_FACTOR) || 6;
const IP_MAX_FAILS = MAX_FAILS * IP_FACTOR;
const IP_LOCKOUT_MS = Math.max(1_000, Number(process.env.LOGIN_IP_LOCKOUT_MS) || 60_000);
const ipKeyOf = (ip) => `ip:${String(ip || '?')}`;                               // ':' 접두 — 위 두 키와 불충돌

function prune(now) {
  if (attempts.size < 5000) return;            // 메모리 상한 방어
  // 1차: 창 만료 + 잠금 해제된 항목 정리.
  for (const [k, v] of attempts) {
    if ((v.lockUntil || 0) < now && (now - (v.first || 0)) > WINDOW_MS) attempts.delete(k);
  }
  // 2차(하드캡): 분산 공격으로 모두 활성 창이라 1차로 안 줄면, 가장 오래된 것부터 강제 제거.
  if (attempts.size >= 5000) {
    const oldest = [...attempts.entries()].sort((a, b) => (a[1].first || 0) - (b[1].first || 0));
    for (let i = 0; i < oldest.length && attempts.size >= 4000; i++) attempts.delete(oldest[i][0]);
  }
}

/** 로그인 시도 전 호출. 잠금 중이면 { blocked:true, retryAfterSec } 반환. */
export function checkLoginAllowed(ip, username, now = Date.now()) {
  if (DISABLED) return { blocked: false };
  for (const k of [keyOf(ip, username), acctKeyOf(username), ipKeyOf(ip)]) { // per-IP·계정전역·출발지 중 하나라도 잠기면 차단
    const rec = attempts.get(k);
    if (rec?.lockUntil && rec.lockUntil > now) {
      return { blocked: true, retryAfterSec: Math.ceil((rec.lockUntil - now) / 1000) };
    }
  }
  return { blocked: false };
}

/** 실패 시 호출. 임계 도달하면 잠금. 반환: { locked, retryAfterSec, remaining }. */
// 한 키(per-IP 또는 계정 전역)의 실패를 집계하고 임계 도달 시 잠근다. 반환: { locked, retryAfterSec, remaining }.
function bump(key, max, now, lockMs = LOCKOUT_MS) {
  let rec = attempts.get(key);
  if (!rec || (now - (rec.first || 0)) > WINDOW_MS) rec = { count: 0, first: now, lockUntil: 0 }; // 창 만료 시 리셋
  rec.count += 1;
  if (rec.count >= max) {
    rec.lockUntil = now + lockMs;
    rec.count = 0; rec.first = now;
    attempts.set(key, rec);
    return { locked: true, retryAfterSec: Math.ceil(lockMs / 1000) };
  }
  attempts.set(key, rec);
  return { locked: false, remaining: max - rec.count };
}

export function recordLoginFailure(ip, username, now = Date.now()) {
  if (DISABLED) return { locked: false };
  prune(now);
  const perIp = bump(keyOf(ip, username), MAX_FAILS, now);            // 단일 출발지+계정(빠른 잠금)
  const acct = bump(acctKeyOf(username), ACCT_MAX_FAILS, now);        // 분산 합산(느린 계정 전역 잠금)
  const srcIp = bump(ipKeyOf(ip), IP_MAX_FAILS, now, IP_LOCKOUT_MS);  // 계정명 무관(사용자명 로테이션 차단) — 짧은 잠금(위 주석)
  const locked = perIp.locked || acct.locked || srcIp.locked;
  return { locked, retryAfterSec: Math.max(perIp.retryAfterSec || 0, acct.retryAfterSec || 0, srcIp.retryAfterSec || 0) || undefined, remaining: perIp.remaining };
}

/** 로그인 성공 시 호출 — per-IP + 계정 전역 카운터/잠금 모두 해제(정상 로그인이 앞선 실패를 리셋). */
export function recordLoginSuccess(ip, username) {
  if (DISABLED) return;
  attempts.delete(keyOf(ip, username));
  attempts.delete(acctKeyOf(username));
  attempts.delete(ipKeyOf(ip));   // 정상 로그인 1회가 출발지 카운터도 리셋(NAT 오탐 완화)
}

/* --------------------- OTP 재인증 잠금(별도 키 공간, 감사 M1) --------------------- */
// 6자리 OTP는 100만 조합뿐이라 시도 제한이 없으면 온라인 무차별이 현실적이다. 계정 단위로
// 집계한다(IP는 넣지 않음 — 프록시/NAT/IP 로테이션으로 계정별 누적 잠금이 무력화되므로).
// 키는 'otp:<user>' 로 파이프(|)가 없어 로그인 키('<ip>|<user>')와 절대 충돌하지 않는다.
const OTP_MAX_FAILS = Number(process.env.OTP_MAX_FAILS) || 5;
const OTP_LOCKOUT_MS = Number(process.env.OTP_LOCKOUT_MS) || 10 * 60_000;
// 창이 잠금보다 길면 잠금 해제 직후 카운터가 0이라 다시 풀 횟수를 시도할 수 있다(감사 L9).
// 그래서 창은 잠금 시간 이하로 클램프한다.
const OTP_WINDOW_MS = Math.min(Number(process.env.OTP_FAIL_WINDOW_MS) || 10 * 60_000, OTP_LOCKOUT_MS);
const OTP_DISABLED = DISABLED || process.env.OTP_RATELIMIT_DISABLED === 'true';

const otpKeyOf = (username) => `otp:${String(username || '?').toLowerCase()}`;

/** OTP 검증 전 호출. 잠금 중이면 { blocked:true, retryAfterSec }. */
export function checkOtpAllowed(username, now = Date.now()) {
  if (OTP_DISABLED) return { blocked: false };
  const rec = attempts.get(otpKeyOf(username));
  if (rec?.lockUntil && rec.lockUntil > now) {
    return { blocked: true, retryAfterSec: Math.ceil((rec.lockUntil - now) / 1000) };
  }
  return { blocked: false };
}

/** OTP 실패 시 호출. 임계 도달하면 잠금. 반환: { locked, retryAfterSec, remaining }. */
export function recordOtpFailure(username, now = Date.now()) {
  if (OTP_DISABLED) return { locked: false };
  prune(now);
  const key = otpKeyOf(username);
  let rec = attempts.get(key);
  if (!rec || (now - (rec.first || 0)) > OTP_WINDOW_MS) rec = { count: 0, first: now, lockUntil: 0 };
  rec.count += 1;
  if (rec.count >= OTP_MAX_FAILS) {
    rec.lockUntil = now + OTP_LOCKOUT_MS;
    rec.count = 0; rec.first = now;
    attempts.set(key, rec);
    return { locked: true, retryAfterSec: Math.ceil(OTP_LOCKOUT_MS / 1000) };
  }
  attempts.set(key, rec);
  return { locked: false, remaining: OTP_MAX_FAILS - rec.count };
}

/** OTP 검증 성공 시 호출 — 해당 계정 카운터/잠금 해제. */
export function recordOtpSuccess(username) {
  if (OTP_DISABLED) return;
  attempts.delete(otpKeyOf(username));
}
