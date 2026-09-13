/**
 * "접속 대상이 바뀌면 저장 비밀을 승계하지 않는다" — 공용 판정(v2.500).
 *
 * 왜 공용으로 만드는가: 이 규칙은 uagmon(v2.257 M3)·relaytopo(v2.435)·mail 에서 각각 따로
 * 구현돼 있었고, **그래서 다른 스토어에는 빠졌다**. 2026-09-13 감사에서 같은 결함이 세 곳
 * (`agent/deployRegistry.js`·`proxy/registry.js`·`net/monitor.js`)에서 독립적으로 확인됐다.
 * 결함의 모양은 모두 같다:
 *
 *   1. 저장 라우트가 "비밀이 빈 값/`********` 이면 기존 값 유지"를 한다(편집 UX 상 필요).
 *   2. 그런데 같은 요청이 host/url 을 바꾼다.
 *   3. 이후 '연결 테스트'·'상태 확인'·폴러·배포가 **저장된 비밀을 새 주소로 보낸다.**
 *
 * v2.480 규칙("연결 테스트는 host 도 저장값으로 고정")은 테스트 라우트만 막는다 — 저장 요청을
 * 한 번 끼우면 그 방어를 지나간다. 그래서 **저장 시점**에 버리는 이 규칙이 함께 필요하다.
 *
 * 새 비밀 스토어를 만들면 여기 두 함수를 쓸 것. 각자 구현하면 다음 스토어에서 또 빠진다.
 */

/** 값 하나를 비교용으로 정규화(대소문자·앞뒤 공백 무시. 포트는 문자열 비교). */
const norm = (v) => String(v ?? '').trim().toLowerCase();

/**
 * 접속 신원이 바뀌었는지. keys 는 '어디에 접속하는가'를 정하는 필드들
 * (예: ['host','port','username'] 또는 ['url']).
 * body 에 그 키가 없으면 기존 값을 유지하는 것으로 본다(부분 저장 지원).
 */
export function accessMoved(prev = {}, body = {}, keys = ['host']) {
  if (!prev) return false;                       // 신규 항목은 '이동'이 아니다
  for (const k of keys) {
    const after = body[k] !== undefined ? body[k] : prev[k];
    if (norm(prev[k]) !== norm(after)) return true;
  }
  return false;
}

/** 요청이 그 비밀을 **새로** 준 것인가(빈 값·redacted 는 '기존 유지' 신호이므로 아니다). */
export const secretProvided = (v) => v !== undefined && v !== null && v !== '' && v !== '********';

/**
 * 신원이 바뀐 경우, 요청이 새로 주지 않은 비밀 필드를 target 에서 제거한다(제자리 수정).
 * 반환: 실제로 버린 키 목록(감사로그·응답에 '비밀을 다시 입력해야 한다'고 알리는 데 쓴다).
 *
 * ⚠ 제거는 `delete`(키 자체를 없앰)다 — `''` 로 덮으면 "빈 값 = 기존 유지" 규칙을 타는 다음
 *   저장에서 되살아날 수 있는 구현이 나온다.
 */
export function dropCarriedSecrets(target, body = {}, secretKeys = []) {
  const dropped = [];
  for (const k of secretKeys) {
    if (secretProvided(body[k])) continue;
    if (target[k] === undefined) continue;
    delete target[k];
    dropped.push(k);
  }
  return dropped;
}
