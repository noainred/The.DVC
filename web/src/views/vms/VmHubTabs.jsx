// views/vms/VmHubTabs.jsx — 가상화 서버 허브 탭 줄(v2.909 · 시안 docs/design/vm-screen 시안 1).
//   분석 · 목록 · 법인별 · 조치 필요 · 과할당(v3.21.0 — 이 화면 안의 보기 — #/vms/<k> · 과할당은 Optimization 권한이 있을 때만) ‖ 기존 VM 도구 6개(#/tools/<k> — 도구 키는 그대로, 권한이 없으면 숨긴다).
//   Vms.jsx 와 특수 기능 도구 패널(SpecialTools ToolPanel — 그 6개 도구를 열었을 때) 두 곳에서 같은 줄을 그린다.
//   v2.915: 줄 자체는 views/platform/HubTabs.jsx(허브 세 탭 공용)로 — 모양 · 가로 스크롤 규약은 그대로. `right` 가 이 탭 고유 조건(전원 · 메모 · IPMS · 호스트 칩).
import React from 'react';
import HubTabs, { toolsFor } from '../platform/HubTabs.jsx';
import { HUB_VIEWS, HUB_TOOLS, HUB_OVER_TOOL } from './vmHubText.js';
import './vmHub.css';

/** 이 사용자가 열 수 있는 허브 도구 — 카탈로그 adminOnly 는 관리자만(서버 게이트와 같은 판정). */
export function hubToolsFor() {
  return toolsFor(HUB_TOOLS);
}

/**
 * v3.21.0: 도구 하나를 이 사용자가 열 수 있는가 — 허브 도구 칸과 **같은 판정**(toolsFor — 카탈로그 adminOnly 는 관리자만 · toolAllowed).
 * 분석 보기의 도구 패널 · '과할당' 칸이 이것으로 숨는다(설계 §6 ⑪ — 권한이 없는 계정에 요약이 새지 않게. 서버 집행은 도구 라우트의 requirePerm('tools')).
 */
export function canHubTool(k) {
  return toolsFor([[k, k]]).length > 0;
}

export default function VmHubTabs({ active, attention = null, right = null }) {
  const canOver = canHubTool(HUB_OVER_TOOL);
  const views = HUB_VIEWS.filter(([k]) => k !== 'over' || canOver).map(([k, label]) => ({
    k, label, href: `#/vms/${k}`,
    ...(k === 'attention' && attention != null && attention > 0 ? { count: attention, countLabel: `신호가 있는 VM ${attention}대` } : {}),
  }));
  return <HubTabs label="가상화 서버 보기" views={views} tools={hubToolsFor()} active={active} right={right} />;
}
