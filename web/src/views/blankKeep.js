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
