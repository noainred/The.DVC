/**
 * util/capStr.js — 외부 문자열을 **상주 구조**(Map 키·보관 레코드)에 넣을 때의 길이 상한(v2.606 감사 TIM2606-02).
 *
 * ⚠⚠ 왜 `.slice(0, n)` 만으로는 부족한가: V8 은 13자 이상의 부분 문자열을 원문을 가리키는 **SlicedString** 으로
 *   만든다. 5MB 본문 문자열을 64자로 잘라 Map 키로 두면 **그 64자가 5MB 원문을 붙잡는다** — 길이 상한은 지켜진 것처럼
 *   보이는데 메모리 상한은 무효다(감사 실측: 5MB agent 30개 → 잔존 힙 143MB, 평탄화하면 4.8MB). v2.605 TIM2605-01 이
 *   dsBrowse 에서 확인한 같은 메커니즘이다(flattenFiles).
 *   `trim()` 도 같다 — 앞뒤 공백을 떼면 원문의 부분 문자열이 된다.
 *
 * 규칙: 길이가 n 을 넘으면 자른다. 그리고 **13자 이상이면 항상** 새 문자열로 평탄화한다(짧아 보여도 부모를 붙잡고
 *   있을 수 있다 — 이미 잘린 값을 다시 넘기는 호출부가 있다). 12자 이하는 V8 이 복사하므로 그대로 둔다.
 *   평탄화는 JSON 왕복이다 — 짝 없는 서로게이트도 보존된다(Buffer utf8 왕복은 U+FFFD 로 바꾼다).
 */
const SLICED_MIN = 13;

/** 문자열 평탄화 — 원문과 무관한 새 문자열. */
export function flatStr(s) {
  if (typeof s !== 'string' || s.length < SLICED_MIN) return s;
  return JSON.parse(JSON.stringify(s));
}

/**
 * 길이 n 이하로 자르고 평탄화한다. 문자열이 아니면 String() 없이 '' 를 돌려준다
 * (객체의 toString 을 부르지 않는다 — v2.600 CEN2600-10 · v2.603 coercionTrap 과 같은 판단).
 * 숫자·불리언은 글자로 바꿔 받는다.
 */
export function capStr(v, n) {
  let s;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') s = String(v);
  else return '';
  const max = Math.max(0, Math.floor(Number(n) || 0));
  if (s.length > max) s = s.slice(0, max);
  return flatStr(s);
}

/** trim 한 뒤 자르고 평탄화(`String(v ?? '').trim().slice(0, n)` 의 대체). */
export function capTrim(v, n) {
  return capStr(typeof v === 'string' ? v.trim() : v, n);
}
