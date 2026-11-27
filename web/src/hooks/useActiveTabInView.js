/**
 * hooks/useActiveTabInView.js — 가로로 넘치는 탭 줄에서 **열린 탭이 보이게 그 줄만** 옮긴다(v3.10.16 · 가상화 플랫폼 점검 4회차).
 *  - 허브 탭 줄(HubTabs · v2.915)에 있던 규칙을 vCenter 상세 · 개체 보기(VM · 호스트)의 `.vcd-views` 도 쓰게 뺀 것 — 400px 에서 주소로 바로 연 ‘네트워크’ 같은
 *    뒤쪽 탭과 강조 탭(‘호스트 및 클러스터’ · ‘VM’)이 줄 밖에 숨어 있었다.
 *  - 창 스크롤은 건드리지 않는다 — 요소를 창 안으로 끌어오는 DOM 호출은 창까지 내려 상단(머리 · KPI)을 가렸다(SvcMonitor 실측 v2.5xx — 그래서 scrollLeft 만 옮긴다). 넘치지 않으면 아무것도 하지 않는다.
 */
import { useLayoutEffect } from 'react';

/** 순수 계산(테스트용 주입 가능): 열린 탭이 줄 밖이면 scrollLeft 를 옮기고 true. */
export function keepActiveTabInView(list) {
  const a = list?.querySelector?.('[aria-selected="true"]');
  if (!list || !a || !(list.scrollWidth > list.clientWidth)) return false;
  const l = list.getBoundingClientRect(); const r = a.getBoundingClientRect();
  if (r.right > l.right) { list.scrollLeft += r.right - l.right + 8; return true; }
  if (r.left < l.left) { list.scrollLeft -= l.left - r.left + 8; return true; }
  return false;
}

export default function useActiveTabInView(ref, active) {
  useLayoutEffect(() => { keepActiveTabInView(ref.current); }, [ref, active]);
}
