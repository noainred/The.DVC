/**
 * Bareos 하위 탭(v2.828) — 통합 현황 · 법인별 현황(조회 전용 도구) · 백업 대상 · 실행 현황·이력 · 설정(관리 도구 bareos-backup).
 *   Backup 상단 탭(VeeamHeader)의 'Bareos' 안쪽 줄이다. 탭은 주소만 바꾼다 — 도구 키·권한은 그대로(서버가 집행 · 탭은 UX 게이팅).
 *   400px 에서 넘치면 이 줄만 가로로 넘긴다(tabstrip-noscroll — VeeamHeader 와 같은 규칙).
 */
import React from 'react';
import { getCurrentUser, hasRole, toolAllowed } from '../../api.js';
import { bareosSubTabs } from './bareosViewText.js';

export default function BareosTabs({ active }) {
  const me = getCurrentUser();
  const fullScope = !me?.scope || (!(me.scope.vcenters || []).length && !(me.scope.regions || []).length);
  const tabs = bareosSubTabs({
    summaryOk: toolAllowed('bareos-summary'), detailOk: toolAllowed('bareos-detail'), manageOk: toolAllowed('bareos-backup'), admin: hasRole('admin'), fullScope,
  });
  if (tabs.length < 2) return null;
  return (
    <div role="tablist" aria-label="Bareos 보기" className="tabstrip-noscroll" data-bareos-tabs=""
      style={{ display: 'flex', gap: 6, overflowX: 'auto', overflowY: 'hidden', minWidth: 0, paddingBottom: 2 }}>
      {tabs.map(([k, label, href]) => (
        <a key={k} role="tab" aria-selected={k === active} href={href} className={`tab${k === active ? ' active' : ''}`}
          style={{ flex: '0 0 auto', textDecoration: 'none', padding: '6px 14px', fontSize: 13 }}>{label}</a>
      ))}
    </div>
  );
}
