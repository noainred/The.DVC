/**
 * Bareos 탭 줄(v2.860 — 사용자 요청 'Bareos UI 전폭 개선 · 직관적이고 복잡하지 않게' + 시안 docs/design/bareos-ui-v2 ⓪).
 *   예전에는 9개 탭이 도구 키마다 다른 자리 · 다른 모양으로 두 벌 그려졌다(조회 도구는 이 컴포넌트, 관리 도구는 버튼 줄).
 *   이제 탭은 5개(현황 · 법인 · 운영 · 정책 · 보존 · 설정)이고 **이 컴포넌트 하나**가 모든 Bareos 화면의 같은 자리(Backup 탭 바로 아래)에 그린다.
 *   탭은 주소만 바꾼다 — 도구 키 · 권한은 그대로(서버가 집행 · 탭은 UX 게이팅). 판정은 bareosViewText.bareosSubTabs 하나.
 *   400px 에서는 줄바꿈한다(v2.843 — 가로로 넘기면 뒤쪽 탭이 있는 줄도 몰랐다 · server/test/bareosLocal2843 이 고정).
 */
import React from 'react';
import { getCurrentUser, hasRole, toolAllowed } from '../../api.js';
import { bareosSubTabs, settingsHomeOk } from './bareosViewText.js';

export default function BareosTabs({ active, right = null }) {
  const me = getCurrentUser();
  const fullScope = !me?.scope || (!(me.scope.vcenters || []).length && !(me.scope.regions || []).length);
  const tabs = bareosSubTabs({
    summaryOk: toolAllowed('bareos-summary'), detailOk: toolAllowed('bareos-detail'), manageOk: toolAllowed('bareos-backup'), admin: hasRole('admin'), fullScope,
    settingsHome: settingsHomeOk(me),   // v2.878 설정은 전체 설정 › vCenter 관리 › Bareos 백업 서버(열 수 있는 계정에게는 탭을 그리지 않는다)
  });
  if (tabs.length < 2 && !right) return null;
  return (
    <div data-bareos-nav="" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 14px', minWidth: 0 }}>
      {tabs.length >= 2 && (
        <div role="tablist" aria-label="Bareos 보기" data-bareos-tabs=""
          style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 3, background: 'var(--panel-deep)', border: '1px solid var(--border)', borderRadius: 10, maxWidth: '100%', minWidth: 0 }}>
          {tabs.map(([k, label, href]) => {
            const on = k === active;
            return (
              <a key={k} role="tab" aria-selected={on} href={href}
                style={{ display: 'inline-flex', alignItems: 'center', minHeight: 34, padding: '0 14px', borderRadius: 8, textDecoration: 'none', fontSize: 13, fontWeight: on ? 800 : 600, whiteSpace: 'nowrap', color: on ? '#fff' : 'var(--text-dim)', background: on ? 'var(--accent)' : 'transparent' }}>
                {label}
              </a>
            );
          })}
        </div>
      )}
      {right}
    </div>
  );
}
