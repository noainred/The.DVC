/**
 * Veeam 백업 현황 머리 — 제목 + Summary | Detail 탭(v2.787, 사용자 요청 + 시안: 왼쪽 메뉴 '서버 › Veeam' 하나로 들어와 화면 위 탭으로 두 화면을 오간다).
 * 탭은 주소만 바꾼다 — 도구 키(backup-summary · backup-detail · v2.788 backup-em)와 권한·북마크는 그대로다(CLAUDE.md '도구 키는 바꾸지 않는다').
 * actions: 오른쪽 버튼 줄(새로고침·CSV·vCenter 선택 — 화면마다 다르다).
 */
import React from 'react';

export const VEEAM_TABS = [['summary', 'Summary', '#/tools/backup-summary'], ['detail', 'Detail', '#/tools/backup-detail'], ['em', 'EM', '#/tools/backup-em']];   // v2.788 EM

export default function VeeamHeader({ active, desc, actions }) {
  return (
    <div data-veeam-header="" style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="flex gap wrap" style={{ alignItems: 'flex-end', rowGap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 22, fontWeight: 800 }}>Veeam 백업 현황</div>
          {desc && <div className="muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{desc}</div>}
        </div>
        {actions && <div className="flex gap wrap" style={{ marginLeft: 'auto', alignItems: 'flex-end', rowGap: 6 }}>{actions}</div>}
      </div>
      <div role="tablist" aria-label="Veeam 백업 현황 보기" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)' }}>
        {VEEAM_TABS.map(([k, label, href]) => {
          const on = k === active;
          return (
            <a key={k} role="tab" aria-selected={on} href={href}
              style={{ flex: '0 1 auto', minWidth: 120, minHeight: 40, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 22px', marginBottom: -1, textDecoration: 'none', fontSize: 15, fontWeight: on ? 800 : 600, color: on ? 'var(--text)' : 'var(--text-dim)', borderBottom: `3px solid ${on ? 'var(--accent)' : 'transparent'}` }}>
              {label}
            </a>
          );
        })}
      </div>
    </div>
  );
}
