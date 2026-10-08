/**
 * views/sidebar/Sidebar.jsx — 개발 포탈 좌측 사이드바(v2.726, 사용자 선택 '상단 1줄 + 좌측 세로 메뉴').
 *
 * 세 모양 하나의 컴포넌트:
 *   full   — 236px, 그룹을 누르면 하위 메뉴가 펼쳐진다(아코디언, 여러 그룹 동시 펼침 가능 · 지금 화면의 그룹은 자동 펼침)
 *   rail   — 64px 아이콘 레일, 아이콘 위에 올리면(또는 포커스) 하위 메뉴가 옆으로 뜬다. 그룹을 누르면 마지막 하위 메뉴로 간다
 *   drawer — 720px 미만, 왼쪽에서 밀려 나오는 서랍(백드롭 클릭·Esc·이동으로 닫힌다)
 * 메뉴 데이터는 App 이 준다(topMenu.visibleMenu 로 권한을 거른 그룹) — 여기서 권한을 다시 보지 않는다.
 * 특수 기능 그룹은 저장된 하위 메뉴가 없고 `toolsSub`(전체 카드 + 분류 바로가기)를 그릴 때 합성한다(sideMenu.toolsChildren).
 * ⚠ CSS 는 `.sb` 아래로 한정한다(전역 `.tab`·`.btn` 과 겹치지 않게). 대문자 변환 금지(v2.575).
 */
import React, { useEffect, useState } from 'react';
import { entryOf } from '../topMenu.js';
import { Icon, iconNameOf } from './sidebarIcons.jsx';

const SOURCE_TEXT = { mine: '내 메뉴', distributed: '배포된 메뉴', default: '포탈 기본 메뉴' };

export default function Sidebar({
  mode = 'full', open = false, onCloseDrawer,
  menu = [], here = { group: null, child: null }, menuLast = {},
  toolsSub = [], toolsActive = null,
  onGo, onGoHash, onToggleRail, onEdit,
  isAdmin = false, source = 'default', unknown = 0, menuLoaded = true,
}) {
  // 수동으로 접거나 편 그룹 — 지금 화면의 그룹은 기본 펼침이고, 화면이 바뀌면 그 그룹을 다시 편다.
  const [manual, setManual] = useState({});
  useEffect(() => { if (here.group) setManual((m) => (m[here.group] === true ? m : { ...m, [here.group]: true })); }, [here.group]);
  const isOpen = (id) => (mode === 'rail' ? true : (manual[id] ?? here.group === id));
  const toggle = (id) => setManual((m) => ({ ...m, [id]: !isOpen(id) }));
  const rail = mode === 'rail';

  const go = (g, c) => { if (onGo) onGo(g, c); if (mode === 'drawer' && onCloseDrawer) onCloseDrawer(); };
  const goHash = (h) => { if (onGoHash) onGoHash(h); if (mode === 'drawer' && onCloseDrawer) onCloseDrawer(); };

  const renderChildren = (g, children, activeId, onPick) => (
    <ul className="sb-sub" role="list">
      {rail && <li className="sb-sub-head" aria-hidden="true">{g.label}</li>}
      {children.map((c) => (
        <li key={c.id}>
          <button type="button" className={`sb-item sb-child${activeId === c.id ? ' active' : ''}`} aria-current={activeId === c.id ? 'page' : undefined}
            onClick={() => onPick(c)}>
            <span className="sb-dot" aria-hidden="true" />
            <span className="sb-label">{c.icon ? `${c.icon} ` : ''}{c.label}</span>
            {isAdmin && c.adminOnly && <Icon name="lock" size={11} className="sb-lock" title="관리자 전용" />}
          </button>
        </li>
      ))}
    </ul>
  );

  const renderGroup = (g) => {
    const active = here.group === g.id;
    const icon = iconNameOf(g.id);
    // 특수 기능 — 저장된 하위 메뉴는 없지만 분류 바로가기를 합성해 그린다(분류가 없으면 단독 항목).
    if (g.tab === 'tools' && toolsSub.length > 1) {
      const opened = isOpen(g.id);
      return (
        <div key={g.id} className={`sb-group${active ? ' active' : ''}${opened ? ' open' : ''}`}>
          <button type="button" className={`sb-item sb-top${active ? ' active' : ''}`} aria-expanded={opened} aria-current={active && !toolsActive ? 'page' : undefined}
            title={rail ? g.label : undefined}
            onClick={() => { if (rail || !active) goHash('#/tools'); if (!rail) toggle(g.id); }}>
            <Icon name={icon} className="sb-ico" />
            <span className="sb-label">{g.label}</span>
            <span className="sb-count" aria-hidden="true">{toolsSub.length - 1}</span>
            <Icon name="chevronDown" size={14} className="sb-chev" />
          </button>
          {opened && renderChildren(g, toolsSub, toolsActive, (c) => goHash(c.hash))}
        </div>
      );
    }
    if (!g.children) {
      return (
        <button key={g.id} type="button" className={`sb-item sb-top${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}
          title={rail ? g.label : undefined} onClick={() => go(g, null)}>
          <Icon name={icon} className="sb-ico" />
          <span className="sb-label">{g.label}</span>
        </button>
      );
    }
    const opened = isOpen(g.id);
    return (
      <div key={g.id} className={`sb-group${active ? ' active' : ''}${opened ? ' open' : ''}`}>
        <button type="button" className={`sb-item sb-top${active ? ' active' : ''}`} aria-expanded={opened}
          title={rail ? g.label : undefined}
          onClick={() => { if (rail) go(g, entryOf(g, menuLast)); else toggle(g.id); }}>
          <Icon name={icon} className="sb-ico" />
          <span className="sb-label">{g.label}</span>
          <span className="sb-count" aria-hidden="true">{g.children.length}</span>
          <Icon name="chevronDown" size={14} className="sb-chev" />
        </button>
        {opened && renderChildren(g, g.children, active ? here.child : null, (c) => go(g, c))}
      </div>
    );
  };

  return (
    <>
      {mode === 'drawer' && open && <div className="sb-backdrop" onClick={onCloseDrawer} aria-hidden="true" />}
      <aside className={`sb sb-${mode}${mode === 'drawer' && open ? ' open' : ''}`} aria-label="메뉴" aria-hidden={mode === 'drawer' && !open ? 'true' : undefined}>
        {mode === 'drawer' && (
          <div className="sb-drawer-head">
            <span className="sb-drawer-title">메뉴</span>
            <button type="button" className="sb-item sb-close" onClick={onCloseDrawer} aria-label="메뉴 닫기"><Icon name="close" size={16} /></button>
          </div>
        )}
        <nav className="sb-nav" aria-label="대메뉴">
          {menu.map(renderGroup)}
          {menuLoaded && menu.length === 0 && <div className="sb-empty muted">보이는 메뉴가 없습니다 — 권한을 확인하세요.</div>}
        </nav>
        <div className="sb-foot">
          <button type="button" className="sb-item sb-edit" onClick={onEdit} title={rail ? `메뉴 편집 (${SOURCE_TEXT[source] || source})` : undefined}>
            <Icon name="edit" className="sb-ico" />
            <span className="sb-label">메뉴 편집</span>
            {!rail && <span className="sb-src" title={unknown ? `알 수 없는 항목 ${unknown}개는 보이지 않습니다(삭제된 화면이거나 권한이 없는 도구)` : undefined}>{SOURCE_TEXT[source] || source}{unknown ? ` · 미표시 ${unknown}` : ''}</span>}
          </button>
          {mode !== 'drawer' && (
            <button type="button" className="sb-item sb-collapse" onClick={onToggleRail} aria-label={rail ? '메뉴 펼치기' : '메뉴 접기'} title={rail ? '메뉴 펼치기' : '메뉴 접기(아이콘만)'}>
              <Icon name={rail ? 'chevronRight' : 'chevronLeft'} className="sb-ico" size={16} />
              {!rail && <span className="sb-label">접기</span>}
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
