/**
 * 요청 값을 글자·수로 바꿀 때 던지지 않게 하는 공용 규칙(v2.603 감사 CEN2603-05).
 *
 * 왜: JSON 본문은 `{"toString":1}` 같은 객체를 만들 수 있고, 그 객체는 `String(v)`·`${v}`·`Number(v)`·배열 join 에서
 * `TypeError: Cannot convert object to primitive value` 를 던진다(toString 이 함수가 아니면 ToPrimitive 가 실패한다).
 * 중앙 수신 경로 16곳(guest-disk·ping-result·rma-poll·*-result …)이 요청 값을 타입을 좁히지 않고 String() 으로 바꿔 **500** 이
 * 났다. v2.600 CEN2600-10 은 agent 필드만 좁혔다 — 필드마다 고치면 다음 필드에서 또 난다.
 *
 * 두 가지를 둔다:
 *  · `stripCoercionTraps(body)` — 수신 라우터 입구에서 본문 전체의 객체에서 **자기 속성 toString/valueOf** 를 지운다.
 *    JSON 에서 온 값은 함수일 수 없으므로 그 두 키는 정상 데이터가 아니다(그 이름을 키로 쓰는 사전이 있다면 그 항목만 빠진다 —
 *    지운 개수를 돌려줘 호출부가 밝힐 수 있다). 지우고 나면 그 객체는 '[object Object]' 로 바뀌고 각 라우트의 형식 검사가 거른다.
 *  · `strOf(v, max)` — 글자·유한수·불리언만 글자로, 그 밖(객체·배열·null)은 ''. numOrNull 처럼 **타입부터** 좁힌다.
 */

const TRAP_KEYS = ['toString', 'valueOf'];

/**
 * @param {unknown} root  JSON 본문
 * @param {{maxDepth?:number}} [opts] 이보다 깊은 객체는 보지 않는다(정상 본문은 10단 안쪽이다)
 * @returns {number} 지운 속성 수
 */
export function stripCoercionTraps(root, { maxDepth = 64 } = {}) {
  if (!root || typeof root !== 'object') return 0;
  let removed = 0;
  const stack = [root]; const depth = [0];
  while (stack.length) {
    const o = stack.pop(); const d = depth.pop();
    if (Array.isArray(o)) {
      if (d >= maxDepth) continue;
      for (let i = 0; i < o.length; i++) { const v = o[i]; if (v && typeof v === 'object') { stack.push(v); depth.push(d + 1); } }
      continue;
    }
    for (const k of TRAP_KEYS) if (Object.hasOwn(o, k)) { delete o[k]; removed += 1; }
    if (d >= maxDepth) continue;
    for (const k in o) { const v = o[k]; if (v && typeof v === 'object') { stack.push(v); depth.push(d + 1); } }
  }
  return removed;
}

/** 글자·유한수·불리언만 글자로(최대 max 자). 그 밖은 ''. */
export function strOf(v, max = 256) {
  if (typeof v === 'string') return v.slice(0, max);
  if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') return String(v).slice(0, max);
  return '';
}
