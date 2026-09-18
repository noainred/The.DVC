/**
 * util/tokenFingerprint.js — 토큰 '지문'(v2.560, 순수 모듈).
 *
 * `routes/collector.js` 가 v2.437 부터 쓰던 `tokenFp()` 를 공용으로 승격한 것이다. 이 표기가
 * 두 벌이 되면 **'눈으로 대조' 라는 존재 이유가 깨진다** — 엣지의 거부 기록(`authDeny.recent[].fp`)과
 * 중앙 점검 화면의 지문이 같은 글자여야 관리자가 둘을 맞춰 볼 수 있다(v2.528 `credFingerprint` 규약).
 *
 * ── 보안 규칙(되돌리지 말 것) ─────────────────────────────────────────────────
 * 1. **값의 일부도 싣지 않는다.** 앞 몇 글자를 노출하면 그것도 토큰 값이다. sha256 의 앞 8자
 *    (32비트)와 길이만 쓴다.
 * 2. ⚠⚠ **전체 해시를 반환하는 export 를 만들지 말 것.** 개별 엣지 토큰의 전체 sha256 은
 *    곧 `central-agent-tokens.json` 의 저장값이고, 사람이 손으로 정한 공유 토큰이라면 그
 *    해시로 **오프라인 사전 공격**이 성립한다. 비교가 필요하면 `sameToken()` 처럼 판정만
 *    돌려주는 함수를 쓰고 해시 자체는 프로세스 밖으로 내보내지 않는다.
 * 3. 8자(32비트)는 **충돌이 가능하다** — '다르면 확실히 다르고, 같으면 가능성이 높다' 가 전부다.
 *    화면 문구도 그렇게 쓴다(v2.528 규약과 같은 한계).
 */
import { createHash } from 'node:crypto';

/** 내부용 전체 해시 — **export 하지 않는다**(위 규칙 2). */
function sha256Hex(t) {
  return createHash('sha256').update(String(t), 'utf8').digest('hex');
}

/**
 * 사람이 읽는 한 줄 지문. 값이 없으면 **빈 문자열**(0 이나 'none' 을 지어내지 않는다).
 * 예: `sha256:1a2b3c4d(len=43)`
 */
export function tokenFingerprint(t) {
  if (t == null || t === '') return '';
  const s = String(t);
  return `sha256:${sha256Hex(s).slice(0, 8)}(len=${s.length})`;
}

/**
 * 화면이 조합해 쓰는 구조형. `space` 는 앞뒤 공백 — 붙여넣기 사고의 최다 원인인데 화면에서는
 * 보이지 않는다(v2.528 과 같은 이유로 드러낸다).
 * @returns {{set:boolean, fp:string, short:string, len:number, space:boolean}}
 */
export function tokenFingerprintParts(t) {
  if (t == null || t === '') return { set: false, fp: '', short: '', len: 0, space: false };
  const s = String(t);
  return {
    set: true,
    fp: tokenFingerprint(s),
    short: sha256Hex(s).slice(0, 8),
    len: s.length,
    space: /^\s|\s$/.test(s),
  };
}

/**
 * 두 값이 같은 토큰인가 — **서버 안에서 전체 해시로** 비교한다(8자 지문 비교가 아니므로 판정이
 * 확률이 아니라 정확하다). 값 자체는 돌려주지 않는다.
 * ⚠ 둘 중 하나라도 비어 있으면 **false 가 아니라 `null`**(비교 대상이 없는 것이다 — '다르다' 로
 *   말하면 '토큰 미설정' 을 '불일치' 로 뭉개는 거짓이 된다).
 */
export function sameToken(a, b) {
  if (a == null || a === '' || b == null || b === '') return null;
  return sha256Hex(a) === sha256Hex(b);
}

/**
 * 그룹화용 키 — 같은 토큰이면 같은 키. **프로세스 안에서만** 쓰고 응답에 싣지 않는다
 * (전체 해시다 — 위 규칙 2). 응답에 낼 것은 `tokenFingerprintParts().short` 다.
 */
export function tokenGroupKey(t) {
  if (t == null || t === '') return '';
  return sha256Hex(t);
}
