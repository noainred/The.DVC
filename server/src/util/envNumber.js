/**
 * util/envNumber.js — 환경변수의 '양수' 설정값(상한 · 개수 · 시한 · 지연)을 읽는다(v3.17.6 · 2차 공통 기능 점검 5회차).
 *
 * 왜: 서버 34곳이 `Number(process.env.X) || 기본값` 으로 읽었다. 이 형태는 0 · 빈 값 · 숫자 아님만 기본값으로 바꾸고
 *   **음수와 Infinity 를 그대로 통과시킨다**(v2.600 reqTimeoutMs 가 시한 env 에서 같은 계열을 고쳤지만 나머지는 남아 있었다). 실제 결과:
 *   · `AUDIT_MAX=-5` → 감사 로그 정리가 `lines.slice(len + 5)` = 빈 배열을 써 **감사 기록이 통째로 지워진다**(500건마다).
 *   · `LOGIN_MAX_FAILS=Infinity` → 로그인 실패 잠금이 꺼진다 · 음수면 첫 실패에 잠긴다. `OTP_MAX_FAILS` 도 같다.
 *   · 음수 시한 · 동시성 · 포트 → 즉시 시간 초과 · 일이 돌지 않음 · 연결 오류.
 * 규칙: 유한한 양수만 값이다(숫자 문자열 포함). 그 밖(빈 값 · 0 · 음수 · 숫자 아님 · Infinity · 배열)은 기본값.
 *   `int`(기본 참)면 내림하고, 내림해 0 이 되면 기본값. 상한은 각 모듈이 의미에 맞게 따로 둔다(이 함수는 '못 쓰는 값' 만 거른다).
 */

/** 양수 설정값 — 못 쓰는 값이면 def. */
export function envPositive(raw, def, { int = true } = {}) {
  const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(v) || v <= 0) return def;
  const n = int ? Math.floor(v) : v;   // 지역 사본들(agentIdentity · gpu/store)과 같은 내림
  return n > 0 ? n : def;
}

export default envPositive;
