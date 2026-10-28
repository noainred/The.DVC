/**
 * hooks/useStickyOffset.js — 화면 안에서 sticky 로 붙이는 바의 top 을 '숫자를 박지 않고' 정하기 위한 높이 측정 훅(v2.810).
 *
 * 왜 재는가: 셸 머리(.topbar)는 좁은 화면에서 여러 줄로 늘어나고, 화면 안의 바도 버튼이 꺾이면 높아진다.
 *   top 을 56 같은 숫자로 박으면 머리가 늘어난 폭에서 바가 머리 밑으로 숨는다. 그래서 실제 높이를 재서 넘긴다.
 * 쓰는 곳: 특수 기능 홈의 분류 바(SpecialTools · v2.679) · Veeam 백업 현황 › Detail 의 일괄 표시 바(BackupDetailTool · v2.810).
 *   셸 머리 선택자는 여기 하나만 둔다(사본 금지).
 *
 * 규칙: 훅이므로 조기 return 위에서 부른다(React #310).
 */
import { useEffect, useState } from 'react';

// 셸마다 머리(sticky) 요소가 다르다. 첫 번째로 찾은 것의 높이를 쓴다.
export const STICKY_HEADS = '.v6 .v6-top, .v5 .v5-top, .v3-top, .topbar';

function observeHeight(el, set) {
  const calc = () => set(Math.round(el.getBoundingClientRect().height || 0));
  calc();
  const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(calc) : null;
  if (ro) ro.observe(el);
  window.addEventListener('resize', calc);
  return () => { if (ro) ro.disconnect(); window.removeEventListener('resize', calc); };
}

/** 셸 머리(sticky)의 실제 높이(px). enabled 가 false 면 재지 않는다(값은 마지막 것 그대로). 머리가 없으면 0. */
export function useStickyHeadH(enabled = true) {
  const [h, setH] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const el = document.querySelector(STICKY_HEADS);
    if (!el) { setH(0); return undefined; }
    return observeHeight(el, setH);
  }, [enabled]);
  return h;
}

/** 요소 하나의 실제 높이(px) — [콜백 ref, 높이]. 요소가 사라지면 0(그 바가 없는 상태). */
export function useBoxHeight() {
  const [el, setEl] = useState(null);
  const [h, setH] = useState(0);
  useEffect(() => {
    if (!el) { setH(0); return undefined; }
    return observeHeight(el, setH);
  }, [el]);
  return [setEl, h];
}
