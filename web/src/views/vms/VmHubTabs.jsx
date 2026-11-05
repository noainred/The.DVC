// views/vms/VmHubTabs.jsx — 가상화 서버 허브 탭 줄(v2.909 · 시안 docs/design/vm-screen 시안 1).
//   현황 · 법인별 · 조치 필요(이 화면 안의 보기 — #/vms/<k>) ‖ 기존 VM 도구 6개(#/tools/<k> — 도구 키는 그대로, 권한이 없으면 숨긴다).
//   Vms.jsx 와 특수 기능 도구 패널(SpecialTools ToolPanel — 그 6개 도구를 열었을 때) 두 곳에서 같은 줄을 그린다.
//   400px 에서는 탭 줄만 가로로 넘긴다(페이지는 밀리지 않는다) — 열린 탭이 보이게 줄만 옮긴다(VeeamHeader 와 같은 방식).
import React, { useLayoutEffect, useRef } from 'react';
import { hasRole, toolAllowed } from '../../api.js';
import { TOOLS } from '../specialToolsList.js';
import { HUB_VIEWS, HUB_TOOLS } from './vmHubText.js';
import './vmHub.css';

/** 이 사용자가 열 수 있는 허브 도구 — 카탈로그 adminOnly 는 관리자만(서버 게이트와 같은 판정). */
export function hubToolsFor() {
  return HUB_TOOLS.filter(([k]) => {
    const t = TOOLS.find((x) => x.k === k);
    if (!t) return false;
    return t.adminOnly ? hasRole('admin') && toolAllowed(k) : toolAllowed(k);
  });
}

export default function VmHubTabs({ active, attention = null }) {
  const listRef = useRef(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const a = list?.querySelector('[aria-selected="true"]');
    if (!list || !a || list.scrollWidth <= list.clientWidth) return;
    const l = list.getBoundingClientRect(); const r = a.getBoundingClientRect();
    if (r.right > l.right) list.scrollLeft += r.right - l.right + 8;
    else if (r.left < l.left) list.scrollLeft -= l.left - r.left + 8;
  }, [active]);
  const tools = hubToolsFor();
  return (
    <div ref={listRef} role="tablist" aria-label="가상화 서버 보기" className="vmh-tabs tabstrip-noscroll">
      {HUB_VIEWS.map(([k, label]) => {
        const on = k === active;
        return (
          <a key={k} role="tab" aria-selected={on} href={`#/vms/${k}`} className={`vmh-tab${on ? ' on' : ''}`}>
            {label}
            {k === 'attention' && attention != null && attention > 0 && <span className="vmh-tab-cnt" aria-label={`신호가 있는 VM ${attention}대`}>{attention.toLocaleString('en-US')}</span>}
          </a>
        );
      })}
      {tools.length > 0 && <span className="vmh-tab-sep" aria-hidden="true" />}
      {tools.map(([k, label]) => {
        const on = k === active;
        return (
          <a key={k} role="tab" aria-selected={on} href={`#/tools/${k}`} className={`vmh-tab tool${on ? ' on' : ''}`} title="특수 기능 도구를 엽니다">
            {label}
          </a>
        );
      })}
    </div>
  );
}
