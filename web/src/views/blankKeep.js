/**
 * 제어형 숫자 입력칸의 onChange 값 → 새 상태값(v2.600, 감사 T2600-05).
 * 빈 칸(또는 숫자로 읽히지 않는 값)이면 **이전 값을 그대로** 둔다 — 예전 `Number('') || 기본값` 은 칸을 비우는
 * 순간 기본값(주기 60초·타임아웃 20초·최대 1000대…)으로 바뀌어 그대로 저장됐다(v2.596 '빈 칸 = 미지정' 규약).
 * 숫자면 map(n) 으로 변환한다(하한·단위 환산). 명시적 0 은 값이다.
 */
import { blankOr } from './blankOr.js';

export function keepIfBlank(raw, prev, map = (n) => n) {
  const n = blankOr(raw);
  return n === undefined ? prev : map(n);
}

/**
 * v2.601(감사 RECENT2601-05): 제어형 입력칸에 keepIfBlank 를 **입력 중(onChange)** 에 걸면 칸을 비울 수 없다 —
 * 상태가 이전 값으로 남아 React 가 DOM 을 그 값으로 되돌린다. 게다가 하한(map)이 중간 입력에 걸려
 * 60→30 으로 고치려 '0' 을 지우는 순간 '6'→하한 10 으로 바뀌어 '10' 뒤에 글자가 붙었다.
 * 그래서 입력 중에는 **원문 문자열(초안)** 을 그대로 들고 있고, 저장할 때 한 번만 keepIfBlank 를 적용한다
 * (빈 칸이면 이전 값 — v2.596 '빈 칸 = 미지정' 규약은 그대로).
 * @param {object} obj    현재 폼(저장값 단위)
 * @param {object} drafts {키: 입력칸 원문} — 사용자가 건드린 칸만 있다
 * @param {object} maps   {키: (숫자) => 저장값} — 하한·단위 환산
 * @returns {object} 초안을 반영한 새 폼(초안이 없는 칸은 그대로)
 */
export function applyDrafts(obj, drafts, maps) {
  const out = { ...obj };
  for (const k of Object.keys(drafts || {})) {
    if (typeof maps?.[k] === 'function') out[k] = keepIfBlank(drafts[k], obj[k], maps[k]);
  }
  return out;
}
