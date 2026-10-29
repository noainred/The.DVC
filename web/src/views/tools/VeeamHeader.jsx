/**
 * Veeam 백업 현황 머리 — 제목 + Summary | Detail 탭(v2.787, 사용자 요청 + 시안: 왼쪽 메뉴 '서버 › Veeam' 하나로 들어와 화면 위 탭으로 두 화면을 오간다).
 * 탭은 주소만 바꾼다 — 도구 키(backup-summary · backup-detail · v2.788 backup-em)와 권한·북마크는 그대로다(CLAUDE.md '도구 키는 바꾸지 않는다').
 * actions: 오른쪽 버튼 줄(새로고침·CSV·vCenter 선택 — 화면마다 다르다).
 */
import React from 'react';
import { hasRole, toolAllowed } from '../../api.js';

// v2.788: 탭 3개 — 400px 본문(352px)에 들어가게 최소 폭 120→96 · 좌우 여백 22→18(Chromium 실측: 3×120+8=368 이 오른쪽 여백으로 16px 넘쳤다)
export const VEEAM_TABS = [['summary', 'Summary', '#/tools/backup-summary'], ['detail', 'Detail', '#/tools/backup-detail'], ['em', 'EM', '#/tools/backup-em']];   // v2.788 EM
// v2.818: 백업 실행 탭(관리자 전용 도구 backup-run — 상태를 바꾼다). 관리자에게만 보인다(서버 API 도 admin 만 — 탭은 UX 게이팅일 뿐).
export const RUN_TAB = ['run', '백업 실행', '#/tools/backup-run'];
export const visibleTabs = ({ admin = false, runOk = false } = {}) => (admin && runOk ? [...VEEAM_TABS, RUN_TAB] : VEEAM_TABS);

export default function VeeamHeader({ active, desc, actions }) {
  return (
    <div data-veeam-header="" style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="flex gap wrap" style={{ alignItems: 'flex-end', rowGap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 22, fontWeight: 800 }}>Backup 현황</div>
          {desc && <div className="muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{desc}</div>}
        </div>
        {actions && <div className="flex gap wrap" style={{ marginLeft: 'auto', alignItems: 'flex-end', rowGap: 6 }}>{actions}</div>}
      </div>
      {/* v2.818: 탭 4개(백업 실행)면 400px 본문에서 넘칠 수 있다 — 탭 줄만 가로 스크롤(페이지는 밀리지 않는다) */}
      <div role="tablist" aria-label="Backup 현황 보기" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', overflowX: 'auto', minWidth: 0 }}>
        {visibleTabs({ admin: hasRole('admin'), runOk: toolAllowed('backup-run') }).map(([k, label, href]) => {
          const on = k === active;
          return (
            <a key={k} role="tab" aria-selected={on} href={href}
              style={{ flex: '0 0 auto', minWidth: 84, minHeight: 40, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 18px', marginBottom: -1, textDecoration: 'none', fontSize: 15, fontWeight: on ? 800 : 600, color: on ? 'var(--text)' : 'var(--text-dim)', borderBottom: `3px solid ${on ? 'var(--accent)' : 'transparent'}` }}>
              {label}
            </a>
          );
        })}
      </div>
    </div>
  );
}
