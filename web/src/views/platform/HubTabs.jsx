// views/platform/HubTabs.jsx — 허브 탭 줄 하나(v2.915 · 설계 docs/design/virt-platform-menu §4.0-11): 이 화면 안의 보기 ‖ 그 탭 성격의 특수 기능 도구 ‖ 오른쪽 = 탭 고유 조건.
//   가상화 서버 허브의 탭 줄(v2.909 VmHubTabs)을 일반화한 것 — 모양(.vmh-tabs · .vmh-tab)은 그대로라 세 탭(vCenter · 호스트 · VM)이 같은 줄을 쓴다.
//   도구 키는 그대로(권한 파일의 값)이고 권한이 없는 도구는 숨긴다(카탈로그 adminOnly 는 관리자만 — 서버 게이트와 같은 판정).
//   400px 에서는 탭 줄만 가로로 넘긴다(페이지는 밀리지 않는다) — 열린 탭이 보이게 줄만 옮긴다.
import React, { useLayoutEffect, useRef } from 'react';
import { hasRole, toolAllowed } from '../../api.js';
import { TOOLS } from '../specialToolsList.js';
import '../vms/vmHub.css';

/** 이 사용자가 열 수 있는 도구 — [[키, 이름]] 중 카탈로그에 있고 권한이 있는 것만. */
export function toolsFor(list) {
  return (list || []).filter(([k]) => {
    const t = TOOLS.find((x) => x.k === k);
    if (!t) return false;
    return t.adminOnly ? hasRole('admin') && toolAllowed(k) : toolAllowed(k);
  });
}

/**
 * @param {object} p
 * @param {string} p.label                     aria-label
 * @param {Array<{k:string,label:string,href?:string,onClick?:()=>void,count?:number|null,countLabel?:string}>} p.views  이 화면 안의 보기
 * @param {Array<[string,string]>} [p.tools]   도구(이미 권한으로 거른 목록 — toolsFor)
 * @param {string} p.active                    열린 보기 키(또는 도구 키)
 * @param {React.ReactNode} [p.right]          오른쪽 끝(탭 고유 조건)
 */
export default function HubTabs({ label, views, tools = [], active, right = null }) {
  const listRef = useRef(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const a = list?.querySelector('[aria-selected="true"]');
    if (!list || !a || list.scrollWidth <= list.clientWidth) return;
    const l = list.getBoundingClientRect(); const r = a.getBoundingClientRect();
    if (r.right > l.right) list.scrollLeft += r.right - l.right + 8;
    else if (r.left < l.left) list.scrollLeft -= l.left - r.left + 8;
  }, [active]);
  return (
    <div ref={listRef} role="tablist" aria-label={label} className="vmh-tabs tabstrip-noscroll">
      {views.map((v) => {
        const on = v.k === active;
        const cnt = v.count != null && v.count > 0 ? <span className="vmh-tab-cnt" aria-label={v.countLabel || String(v.count)}>{v.count.toLocaleString('en-US')}</span> : null;
        return v.href
          ? <a key={v.k} role="tab" aria-selected={on} href={v.href} className={`vmh-tab${on ? ' on' : ''}`} onClick={v.onClick ? (e) => { e.preventDefault(); v.onClick(); } : undefined}>{v.label}{cnt}</a>
          : <button key={v.k} type="button" role="tab" aria-selected={on} className={`vmh-tab${on ? ' on' : ''}`} style={{ background: 'none', border: 0, borderBottom: '3px solid transparent', cursor: 'pointer', font: 'inherit' }} onClick={v.onClick}>{v.label}{cnt}</button>;
      })}
      {tools.length > 0 && <span className="vmh-tab-sep" aria-hidden="true" />}
      {tools.map(([k, t]) => {
        const on = k === active;
        return <a key={k} role="tab" aria-selected={on} href={`#/tools/${k}`} className={`vmh-tab tool${on ? ' on' : ''}`} title="특수 기능 도구를 엽니다">{t}</a>;
      })}
      {right && <span className="ph-right">{right}</span>}
    </div>
  );
}
