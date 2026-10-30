/**
 * Veeam 백업 현황 머리 — 제목 + Summary | Detail 탭(v2.787, 사용자 요청 + 시안: 왼쪽 메뉴 '서버 › Veeam' 하나로 들어와 화면 위 탭으로 두 화면을 오간다).
 * 탭은 주소만 바꾼다 — 도구 키(backup-summary · backup-detail · v2.788 backup-em)와 권한·북마크는 그대로다(CLAUDE.md '도구 키는 바꾸지 않는다').
 * actions: 오른쪽 버튼 줄(새로고침·CSV·vCenter 선택 — 화면마다 다르다).
 */
import React, { useLayoutEffect, useRef } from 'react';
import { hasRole, toolAllowed } from '../../api.js';

// v2.788: 탭 3개 — 400px 본문(352px)에 들어가게 최소 폭 120→96 · 좌우 여백 22→18(Chromium 실측: 3×120+8=368 이 오른쪽 여백으로 16px 넘쳤다)
export const VEEAM_TABS = [['summary', 'Summary', '#/tools/backup-summary'], ['detail', 'Detail', '#/tools/backup-detail'], ['em', 'EM', '#/tools/backup-em']];   // v2.788 EM
// v2.818: 백업 실행 탭(관리자 전용 도구 backup-run — 상태를 바꾼다). 관리자에게만 보인다(서버 API 도 admin 만 — 탭은 UX 게이팅일 뿐).
export const RUN_TAB = ['run', '백업 실행', '#/tools/backup-run'];
// v2.822(사용자 요청 'Backup 상단 메뉴에 Bareos 탭'): Bareos VM 백업(관리자 전용 도구 bareos-backup — 상태를 바꾼다). 백업 실행 탭과 같은 게이트.
export const BAREOS_TAB = ['bareos', 'Bareos', '#/tools/bareos-backup'];
// v2.828(권장안 A): 조회 전용 화면(통합 현황 bareos-summary · 법인별 bareos-detail)은 관리자가 아니어도 보인다 — 탭은 그 권한이 있으면 통합 현황으로 간다.
export const visibleTabs = ({ admin = false, runOk = false, bareosOk = false, bareosViewOk = false } = {}) => [
  ...VEEAM_TABS,
  ...(admin && runOk ? [RUN_TAB] : []),
  ...(bareosViewOk ? [['bareos', 'Bareos', '#/tools/bareos-summary']] : admin && bareosOk ? [BAREOS_TAB] : []),
];

export default function VeeamHeader({ active, desc, actions }) {
  // v2.822(Chromium 400px 확인): 탭이 5개면 탭 줄이 가로로 스크롤되고 오른쪽 끝 탭(Bareos)이 열린 채로 화면 밖에 있었다 —
  //   열린 탭이 보이도록 탭 줄만 옮긴다(scrollIntoView 는 페이지 세로 위치까지 움직일 수 있어 쓰지 않는다).
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
    <div data-veeam-header="" style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="flex gap wrap" style={{ alignItems: 'flex-end', rowGap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 22, fontWeight: 800 }}>Backup 현황</div>
          {desc && <div className="muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{desc}</div>}
        </div>
        {actions && <div className="flex gap wrap" style={{ marginLeft: 'auto', alignItems: 'flex-end', rowGap: 6 }}>{actions}</div>}
      </div>
      {/* v2.818: 탭 4개(백업 실행)면 400px 본문에서 넘칠 수 있다 — 탭 줄만 가로 스크롤(페이지는 밀리지 않는다). v2.822 Bareos 로 5개
          v2.825.1(사용자 요청 '스크롤바 생기는거 없애줘'): overflowX:auto 는 세로도 auto 로 만든다 — 탭의 음수 아래 여백(-1px — 테두리 겹치기)이 세로 1px 를 넘겨
          Windows(화살표 스크롤바)에서 탭 줄 오른쪽에 세로 스크롤바가 생겼다. 아래 선은 안쪽 그림자(내용 아래에 그려져 열린 탭 밑줄이 덮는다)로 바꾸고
          세로는 숨긴다 · 좁은 폭의 가로 스크롤바도 그리지 않는다(tabstrip-noscroll — 터치·트랙패드·Shift+휠로 넘어가고 열린 탭은 위 효과가 보이게 옮긴다) */}
      <div ref={listRef} role="tablist" aria-label="Backup 현황 보기" className="tabstrip-noscroll"
        style={{ display: 'flex', gap: 4, boxShadow: 'inset 0 -1px 0 var(--border)', overflowX: 'auto', overflowY: 'hidden', minWidth: 0 }}>
        {visibleTabs({ admin: hasRole('admin'), runOk: toolAllowed('backup-run'), bareosOk: toolAllowed('bareos-backup'), bareosViewOk: toolAllowed('bareos-summary') }).map(([k, label, href]) => {
          const on = k === active;
          return (
            <a key={k} role="tab" aria-selected={on} href={href}
              style={{ flex: '0 0 auto', minWidth: 'min(84px, 18vw)', minHeight: 40, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 clamp(10px, 2vw, 18px)', textDecoration: 'none', fontSize: 15, fontWeight: on ? 800 : 600, color: on ? 'var(--text)' : 'var(--text-dim)', borderBottom: `3px solid ${on ? 'var(--accent)' : 'transparent'}` }}>
              {label}
            </a>
          );
        })}
      </div>
    </div>
  );
}
