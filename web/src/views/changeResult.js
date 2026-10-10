/**
 * v2.731(점검 1회차 A5-01): 변경 요청 응답 판정 — 순수 모듈(화면·테스트가 같이 쓴다).
 *
 * api.js 의 putJson·patchJson·delJson(sendJson)은 **400·409 를 던지지 않고 본문을 돌려준다** — IPMS 대역 화면 등이 400 본문의
 * invalid[]·field 를 읽기 때문이고, 그 규약은 바꾸지 않는다. 그 반환값을 그대로 성공으로 처리하면 서버가 입력을 거부해도
 * 화면은 창을 닫고 '저장됨' 을 말한다(svcmon 대상 수정·RMA 비밀번호 '해제했습니다(무서명)'·vCenter 로그 설정이 실제로 그랬다).
 * 서버의 실패 본문은 두 모양이다 — `{ ok:false, reason }`(대부분) · `{ error }`(svcmon 등). 둘 다 실패로 읽는다.
 *
 * 성공 본문(`{ ok:true, … }` · 저장된 객체 · 설정 객체)에는 `error` 문자열이 없다 — `ok:true` 가 있으면 무엇이 와도 성공이다.
 */
const txt = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

export const CHANGE_FAIL_FALLBACK = '서버가 변경을 받아들이지 않았습니다(사유 미상).';

/** 응답 본문이 실패를 말하면 화면에 보일 사유, 아니면 null. fallback = 사유 없는 ok:false 일 때의 문구. */
export function changeFailText(r, fallback = CHANGE_FAIL_FALLBACK) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (r.ok === true) return null;
  if (r.ok === false) return txt(r.reason) || txt(r.error) || txt(r.message) || txt(fallback) || CHANGE_FAIL_FALLBACK;
  // ok 필드 없이 {error} 만 오는 라우트 — error 가 코드('forbidden'·'conflict')면 사람이 읽을 reason 이 먼저다.
  if (txt(r.error)) return txt(r.reason) || txt(r.error);
  return null;
}

/**
 * 성공이면 본문을 그대로 돌려주고, 실패면 사유를 메시지로 던진다 — 호출부의 기존 catch(setErr·alert)가 그대로 보인다.
 * 사용: `const r = requireChanged(await putJson(...))`.
 */
export function requireChanged(r, fallback) {
  const why = changeFailText(r, fallback);
  if (why == null) return r;
  const e = new Error(why);
  e.changeRejected = true;
  e.body = r;
  throw e;
}
