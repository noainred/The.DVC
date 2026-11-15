/**
 * components/pressable.js — 누르는 카드 · 행(div · td)에 **키보드 접근**을 주는 props(v3.10.19 · 가상화 플랫폼 점검 7회차).
 *  - 마우스로만 열리던 div(onClick) 는 Tab 으로 닿지 않고 Enter · Space 로 열리지 않았다(허브 vCenter 카드 · KPI 카드 3장 · 법인별 비교 표의 행).
 *  - 한 벌: role="button" · tabIndex 0 · Enter/Space → onClick(기본 동작 막음 — Space 가 페이지를 내리지 않게). onClick 이 없거나 disabled 면 아무 props 도 주지 않는다(장식 카드는 그대로).
 *  - 포커스 테두리는 CSS(`:focus-visible`)가 그린다 — platform.css `.card.kpi[role="button"]` · `.card.vc-card[role="button"]`.
 *  - 안쪽에 버튼 · 링크가 있는 카드도 쓸 수 있다 — 안쪽 요소에서 올라온 키 이벤트(target ≠ currentTarget)는 카드가 받지 않는다(안쪽 버튼의 Enter 는 그 버튼만 누른다). 클릭 전파는 안쪽에서 stop.
 */
export const PRESS_KEYS = Object.freeze(['Enter', ' ']);
/**
 * v3.12.3: Enter/Space 를 그 요소 자신의 '누름' 으로 바꾸는 onKeyDown 한 벌 — role 을 바꾸면 안 되는 요소(정렬 열 머리 th — columnheader · aria-sort)도 쓴다.
 * 안쪽 버튼 · 링크에서 올라온 키는 무시한다 — 안 그러면 '호스트 →' 에서 Enter 를 쳤을 때 카드(상세)가 열리고 버튼의 클릭은 preventDefault 로 막혔다(반증 재현 · v3.10.19 보완).
 */
export function onPressKey(fn) {
  return (e) => { if (e.target !== e.currentTarget) return; if (PRESS_KEYS.includes(e.key)) { e.preventDefault(); fn(e); } };
}
export function pressable(onClick, { disabled = false } = {}) {
  if (typeof onClick !== 'function' || disabled) return {};
  return { role: 'button', tabIndex: 0, onClick, onKeyDown: onPressKey(onClick) };
}
