/**
 * components/pressable.js — 누르는 카드 · 행(div · td)에 **키보드 접근**을 주는 props(v3.10.19 · 가상화 플랫폼 점검 7회차).
 *  - 마우스로만 열리던 div(onClick) 는 Tab 으로 닿지 않고 Enter · Space 로 열리지 않았다(허브 vCenter 카드 · KPI 카드 3장 · 법인별 비교 표의 행).
 *  - 한 벌: role="button" · tabIndex 0 · Enter/Space → onClick(기본 동작 막음 — Space 가 페이지를 내리지 않게). onClick 이 없거나 disabled 면 아무 props 도 주지 않는다(장식 카드는 그대로).
 *  - 포커스 테두리는 CSS(`:focus-visible`)가 그린다 — platform.css `.card.kpi[role="button"]` · `.card.vc-card[role="button"]`.
 *  - 안쪽에 버튼 · 링크가 있는 카드도 쓸 수 있다(안쪽 요소는 제 포커스를 가진다 · 클릭 전파는 안쪽에서 stop).
 */
export const PRESS_KEYS = Object.freeze(['Enter', ' ']);
export function pressable(onClick, { disabled = false } = {}) {
  if (typeof onClick !== 'function' || disabled) return {};
  return {
    role: 'button', tabIndex: 0, onClick,
    onKeyDown: (e) => { if (PRESS_KEYS.includes(e.key)) { e.preventDefault(); onClick(e); } },
  };
}
