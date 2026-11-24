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

/** 2^31 − 1 — setTimeout 이 받는 최대 지연이자 개수 상한으로 쓸 수 있는 가장 큰 값. 넘는 env 는 오타로 보고 기본값을 쓴다(결정 57 · 58). */
export const ENV_INT_MAX = 2 ** 31 - 1;
/** TCP 포트 범위(1~65535) — 넘으면 기본값(결정 57: 스토리지 REST 포트 env 가 `Number(env) || 443` 이라 −1 · 70000 을 그대로 썼다). */
export const TCP_PORT_MAX = 65_535;

/**
 * 기본 상한(102회차 — 100회차 반증 제안) = Number.MAX_SAFE_INTEGER. 예전 기본 max 는 Infinity 라 '1e300' 같은 **유한 거대값**이 그대로 통과해
 * 개수 · 상한 · 동시성이 사실상 꺼졌다(Infinity 만 막혔다). 2^53−1 을 넘는 값은 정수로도 정확하지 않아 설정값일 수 없다.
 * ENV_INT_MAX(2^31−1)를 기본으로 하지 않는 이유: 2GB 를 넘는 정당한 바이트 상한(업그레이드 번들 등)이 기본값으로 떨어진다 — 시한은 호출부가 `{ max: ENV_INT_MAX }`.
 */
export const ENV_DEFAULT_MAX = Number.MAX_SAFE_INTEGER;

/**
 * 양수 설정값 — 못 쓰는 값이면 def.
 * max(선택, 기본 ENV_DEFAULT_MAX): 이보다 크면 **기본값**(잘라 쓰지 않는다 — 포트 70000 · 시한 3e9ms 는 단위 착오일 가능성이 커서 가장 가까운 값이 맞지 않다).
 */
export function envPositive(raw, def, { int = true, max = ENV_DEFAULT_MAX } = {}) {
  const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(v) || v <= 0) return def;
  const n = int ? Math.floor(v) : v;   // 지역 사본들(agentIdentity · gpu/store)과 같은 내림
  return n > 0 && n <= max ? n : def;
}

/**
 * 0 도 값인 설정(102회차) — '0' 이 의미(문턱 0 = 항상 오프로드 · 워커 0 = 인프로세스)인 키. 유한한 0 이상만 값이고
 * 그 밖(빈 값 · 음수 · 숫자 아님 · Infinity)은 기본값. 빈 값(`KEY=`)은 0 이 아니라 **미지정**이다(`Number('') === 0` 함정 —
 * config.js numEnv 와 같은 규칙). max(기본 ENV_DEFAULT_MAX)를 넘으면 기본값(잘라 쓰지 않는다 — envPositive 와 같다).
 */
export function envNonNegative(raw, def, { int = true, max = ENV_DEFAULT_MAX } = {}) {
  const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(v) || v < 0) return def;
  const n = int ? Math.floor(v) : v;
  return n <= max ? (n || 0) : def;   // `|| 0`: '-0' 을 0 으로
}

/** 포트 env — 1~65535 정수만, 아니면 def(결정 57). */
export const envPort = (raw, def) => envPositive(raw, def, { max: TCP_PORT_MAX });

export default envPositive;
