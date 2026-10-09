/**
 * 장비 TLS 검증 모드 env 해석(2026-10-09 검토 S-02) — 의존 없는 잎 모듈.
 *
 * `config.js` 와 `security/tlsTrust.js` 가 함께 쓴다(config.js 는 util/·security/·내장만 import 한다 —
 * tlsTrust.js 는 config 를 import 하므로 config 가 그것을 부르면 순환이 된다).
 *
 * 값의 뜻(사용자 승인 — 기본값 전환):
 *   미설정·빈 값       → 'verify'   CA 체인(시스템 루트 + 사설 CA 번들)이 맞으면 통과, 아니면 장비별 승인 지문(peerTrust)
 *   true/1/yes/on       → 'strict'   CA 체인만 허용(승인 지문으로 대신하지 않는다)
 *   false/0/no/off      → 'insecure' **명시적 예외** — 예전처럼 어떤 인증서든 받는다(상태에 '예외 사용 중' 으로 드러난다)
 *   그 밖의 값          → 'verify'   (모르는 값을 '검증 안 함' 으로 읽지 않는다 — unknown 을 함께 돌려준다)
 *
 * ⚠ 예전에는 'true' 일 때만 검증했다(미설정 = 검증 안 함). 이제 미설정이 검증이다.
 */
export const TLS_VERIFY_MODES = Object.freeze(['verify', 'strict', 'insecure']);

const STRICT = new Set(['true', '1', 'yes', 'on', 'strict']);
const INSECURE = new Set(['false', '0', 'no', 'off', 'insecure']);

/** env 원문 → { mode, raw, unknown } */
export function tlsModeInfo(raw) {
  if (raw == null) return { mode: 'verify', raw: null, unknown: false };
  const v = String(raw).trim().toLowerCase();
  if (!v) return { mode: 'verify', raw: '', unknown: false };
  if (STRICT.has(v)) return { mode: 'strict', raw: v, unknown: false };
  if (INSECURE.has(v)) return { mode: 'insecure', raw: v, unknown: false };
  return { mode: 'verify', raw: v.slice(0, 32), unknown: true };
}

/** env 원문 → 'verify' | 'strict' | 'insecure' */
export function tlsModeFromEnv(raw) {
  return tlsModeInfo(raw).mode;
}
