/**
 * 로그인 무차별 대입 방어 — IP+계정 키별 실패 카운터와 일시적 잠금(메모리, 의존성 없음).
 * 성공 시 카운터 초기화. 운영(단일 어플라이언스) 가정으로 관대한 기본값을 쓰되,
 * 환경변수로 조정/비활성화할 수 있다. 분산 다중노드라면 공유 저장소로 확장 필요.
 *
 *  - LOGIN_MAX_FAILS         (기본 8)   : 잠금 전 허용 실패 횟수
 *  - LOGIN_LOCKOUT_MS        (기본 900000=15분) : 잠금 지속시간
 *  - LOGIN_FAIL_WINDOW_MS    (기본 900000=15분) : 실패 카운트 집계 창
 *  - LOGIN_RATELIMIT_DISABLED=true       : 전체 비활성화(비권장)
 */

const MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS) || 8;
const LOCKOUT_MS = Number(process.env.LOGIN_LOCKOUT_MS) || 15 * 60_000;
const WINDOW_MS = Number(process.env.LOGIN_FAIL_WINDOW_MS) || 15 * 60_000;
const DISABLED = process.env.LOGIN_RATELIMIT_DISABLED === 'true';

const attempts = new Map(); // key -> { count, first, lockUntil }

const keyOf = (ip, username) => `${String(ip || '?')}|${String(username || '?').toLowerCase()}`;

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
  const rec = attempts.get(keyOf(ip, username));
  if (rec?.lockUntil && rec.lockUntil > now) {
    return { blocked: true, retryAfterSec: Math.ceil((rec.lockUntil - now) / 1000) };
  }
  return { blocked: false };
}

/** 실패 시 호출. 임계 도달하면 잠금. 반환: { locked, retryAfterSec, remaining }. */
export function recordLoginFailure(ip, username, now = Date.now()) {
  if (DISABLED) return { locked: false };
  prune(now);
  const key = keyOf(ip, username);
  let rec = attempts.get(key);
  // 창이 지났으면 카운터 리셋
  if (!rec || (now - (rec.first || 0)) > WINDOW_MS) rec = { count: 0, first: now, lockUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILS) {
    rec.lockUntil = now + LOCKOUT_MS;
    rec.count = 0; rec.first = now;
    attempts.set(key, rec);
    return { locked: true, retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) };
  }
  attempts.set(key, rec);
  return { locked: false, remaining: MAX_FAILS - rec.count };
}

/** 로그인 성공 시 호출 — 해당 키 카운터/잠금 해제. */
export function recordLoginSuccess(ip, username) {
  if (DISABLED) return;
  attempts.delete(keyOf(ip, username));
}
