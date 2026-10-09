/**
 * 세션 수명 정책 — 한 곳(2026-10-09 검토 S-05·S-06·S-08).
 *
 * 왜 따로 두나: '이 토큰이 아직 살아 있는가' 를 발급(로그인)·연장(/auth/extend)·검사(resolveTokenUser — HTTP·WS 공통)
 *   세 곳이 각자 계산하면 한쪽만 고친 날 어긋난다. v2.689 까지 총 상한(sessionMaxHours)은 **연장에서만** 적용돼,
 *   연장하지 않는 것만으로 상한을 넘겨 쓸 수 있었다(S-06). 이 모듈은 **순수 함수**만 둔다(파일·설정을 읽지 않는다 —
 *   호출부가 값을 넣는다). 그래서 단위 테스트가 시각을 고정해 경계를 그대로 찌를 수 있다.
 *
 * 규칙(되돌리지 말 것):
 *   ① 총 상한 = 원래 로그인 시각(`lt`, 없으면 구버전 토큰이라 `iat`) + 상한. 상한은 (a) 세션 보안의 `sessionMaxHours`
 *      (0 = 무제한) (b) AD 토큰이면 AD 세션 상한(도메인 계정·그룹 변경이 반영되는 최대 지연 — LDAP 재조회 없이)
 *      중 **짧은 것**.
 *   ② 최초 발급 만료 = min(지금 + TTL, 총 상한). 연장 만료 = min(기존 만료 + 연장분, 총 상한).
 *   ③ 검사도 같은 총 상한을 다시 본다 — 운영 중 상한을 줄이면 **기존 세션에도 다음 요청부터** 적용된다
 *      (보안 정책이므로 '이미 발급된 것은 예외' 로 두지 않는다. 늘리는 방향은 이미 발급된 토큰의 exp 가 막는다).
 *   ④ 유휴(서버측): 마지막 '사용자 활동' + 유휴 분 + 여유(IDLE_GRACE_SEC)를 넘기면 무효. 자동 폴링은 활동이 아니다
 *      — 활동은 로그인·연장·`POST /auth/activity`(웹이 키보드·마우스 활동 때 스로틀해 보낸다)뿐이다.
 *      여유는 웹의 활동 신호 스로틀(60초)보다 커야 한다(작으면 웹의 유휴 타이머보다 서버가 먼저 끊는다).
 *   ⑤ 세션 ID(sid)가 없는 구버전 토큰은 서버가 개별 세션을 추적할 수 없다 — 유휴는 적용하지 않고(TTL 로 자연 만료),
 *      총 상한·폐기(토큰 해시)는 적용한다.
 */

/** 서버 유휴 판정 여유(초) — 웹 활동 신호 스로틀(60초)의 두 배. */
export const IDLE_GRACE_SEC = 120;

/** 연장 가능한 최대 폭(분) — 세션 보안 설정의 상한(경고 120분 + 연장 720분). 폐기 기록 보관 기간 계산에 쓴다. */
export const MAX_WARN_PLUS_EXTEND_MIN = 120 + 720;

const pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

/** 원래 로그인 시각(초). lt → iat → fallback. */
export function loginAtOf(payload, fallbackSec) {
  const lt = Number(payload?.lt);
  if (Number.isFinite(lt) && lt > 0) return Math.floor(lt);
  const iat = Number(payload?.iat);
  if (Number.isFinite(iat) && iat > 0) return Math.floor(iat);
  return Math.floor(Number(fallbackSec) || 0);
}

/**
 * 이 세션에 적용할 상한(시간) — 0 이면 상한 없음.
 * @param {{ maxHours?: number, adMaxHours?: number, isAd?: boolean }} p
 */
export function effectiveMaxHours({ maxHours = 0, adMaxHours = 0, isAd = false } = {}) {
  const cands = [pos(maxHours)];
  if (isAd) cands.push(pos(adMaxHours));
  const set = cands.filter((h) => h > 0);
  return set.length ? Math.min(...set) : 0;
}

/** 총 상한 시각(초) 또는 null(상한 없음). */
export function hardLimitSec({ loginAt, maxHours = 0, adMaxHours = 0, isAd = false } = {}) {
  const h = effectiveMaxHours({ maxHours, adMaxHours, isAd });
  if (!h) return null;
  return Math.floor(Number(loginAt) || 0) + Math.round(h * 3600);
}

/**
 * 최초 발급 만료(초) = min(지금 + TTL, 총 상한).
 * @param {{ nowSec: number, ttlSec: number, loginAt?: number, maxHours?: number, adMaxHours?: number, isAd?: boolean }} p
 */
export function initialExpSec({ nowSec, ttlSec, loginAt = nowSec, maxHours = 0, adMaxHours = 0, isAd = false } = {}) {
  const byTtl = Math.floor(nowSec) + Math.max(1, Math.floor(Number(ttlSec) || 0));
  const hard = hardLimitSec({ loginAt, maxHours, adMaxHours, isAd });
  return hard == null ? byTtl : Math.min(byTtl, hard);
}

/**
 * 연장 만료(초) = min(기존 만료 + 연장분, 총 상한). capped 는 상한에 걸려 잘렸는가.
 * @returns {{ exp: number, capped: boolean, hardLimit: number|null }}
 */
export function extendedExpSec({ curExp, extendSec, loginAt, maxHours = 0, adMaxHours = 0, isAd = false } = {}) {
  let exp = Math.floor(Number(curExp) || 0) + Math.max(0, Math.floor(Number(extendSec) || 0));
  const hard = hardLimitSec({ loginAt, maxHours, adMaxHours, isAd });
  let capped = false;
  if (hard != null && exp > hard) { exp = hard; capped = true; }
  return { exp, capped, hardLimit: hard };
}

/**
 * 검사 — 이 토큰(서명·exp 는 이미 검증됨)이 세션 정책상 아직 살아 있는가.
 * 판정 순서: 일괄 폐기 시각(notBefore) → 개별 폐기 → 총 상한 → 유휴.
 * @param {object} payload 토큰 클레임
 * @param {{ nowSec: number, maxHours?: number, adMaxHours?: number, isAd?: boolean,
 *           notBeforeSec?: number, revoked?: boolean,
 *           idleEnabled?: boolean, idleMin?: number, lastActivitySec?: number|null }} ctx
 * @returns {{ ok: true } | { ok: false, reason: 'not-before'|'revoked'|'max-age'|'idle' }}
 */
export function sessionVerdict(payload, ctx = {}) {
  const now = Math.floor(Number(ctx.nowSec) || 0);
  const loginAt = loginAtOf(payload, now);
  if (pos(ctx.notBeforeSec) && loginAt < Math.floor(ctx.notBeforeSec)) return { ok: false, reason: 'not-before' };
  if (ctx.revoked) return { ok: false, reason: 'revoked' };
  const hard = hardLimitSec({ loginAt, maxHours: ctx.maxHours, adMaxHours: ctx.adMaxHours, isAd: !!ctx.isAd });
  if (hard != null && now >= hard) return { ok: false, reason: 'max-age' };
  if (ctx.idleEnabled && payload?.sid && ctx.lastActivitySec != null) {
    const idleSec = Math.max(1, Math.round(Number(ctx.idleMin) || 0)) * 60;
    if (now > Math.floor(ctx.lastActivitySec) + idleSec + IDLE_GRACE_SEC) return { ok: false, reason: 'idle' };
  }
  return { ok: true };
}

/**
 * 폐기 기록을 언제까지 들고 있어야 하나(초) — 그 sid 로 이미 발급됐을 수 있는 **가장 늦은 만료**까지.
 * 연장은 같은 sid 로 새 토큰을 만들므로 로그아웃에 쓴 토큰의 exp 보다 늦은 사본이 있을 수 있다:
 *   이미 발급된 토큰의 exp ≤ 발급 시각 + max(TTL, 경고+연장) ≤ 지금 + max(TTL, 경고+연장).
 * 총 상한이 있으면 그 뒤로는 검사가 어차피 거부하므로 거기까지만 들고 있는다.
 */
export function revokeRetentionSec({ nowSec, exp, ttlSec, hardLimit = null } = {}) {
  const now = Math.floor(Number(nowSec) || 0);
  const span = Math.max(Math.floor(Number(ttlSec) || 0), MAX_WARN_PLUS_EXTEND_MIN * 60);
  let until = Math.max(Math.floor(Number(exp) || 0), now + span);
  if (hardLimit != null && Number.isFinite(Number(hardLimit))) until = Math.min(until, Math.floor(Number(hardLimit)));
  return Math.max(until, now);
}
