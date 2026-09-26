import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePolling, can, toolAllowed } from '../api.js';
import { TOOLS } from '../views/specialToolsList.js';
import { resolveTree, activeKeyOf, TAB_NAMES, groupOfTab, groupOfTool } from './tree.js';
import { searchResults } from './searchData.js';
import { statusCard } from './overviewData.js';
import { handoffSearch } from '../hooks/searchHandoff.js';
import { agoText } from '../views/tools/relTime.js';
import './v5.css';

/**
 * V5 셸(v2.616) — 기존 라우터 위의 새 틀. 본문(children)은 App 이 그리는 기존 화면 그대로다.
 * 이 컴포넌트는 폴링을 새로 만들지 않는다 — /health·/vcenters 는 App 것을 받는다. 예외는 하단 상태 카드의
 * 통신 지도(`/tools/comm-map`, 60초)뿐이고 **관리자 + 전체 범위 + 그 도구 허용** 일 때만 부른다
 * (조건 밖 계정에 403 을 만들지 않는다 — V4 규약).
 */

const ICON_PATHS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  summary: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  pulse: 'M3 12h4l3-8 4 16 3-8h4',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  gauge: 'M12 14l4-4M4 18a9 9 0 1 1 16 0',
  net: 'M12 3v6M5 21v-4h14v4M12 9a3 3 0 1 0 0 .01M12 12v5',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a7.9 7.9 0 0 0 .1-6l2-1.5-2-3.5-2.4 1a8 8 0 0 0-5-3L11.6 0h-4l-.5 2a8 8 0 0 0-5 3l-2.4-1-2 3.5L0 9a7.9 7.9 0 0 0 0 6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  chev: 'M9 6l6 6-6 6',
  building: 'M4 21V3h16v18M9 7h1M14 7h1M9 11h1M14 11h1M10 21v-4h4v4',
  up: 'M12 19V5M5 12l7-7 7 7',
  vm: 'M3 4h18v7H3zM3 13h18v7H3z',
  alarm: 'M12 3l9 16H3zM12 10v4M12 17h.01',
  list: 'M4 7h16M4 12h16M4 17h10',
};
function Icon({ name, size = 18, stroke = 'currentColor', strokeWidth = 1.8 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d={ICON_PATHS[name] || ICON_PATHS.list} />
    </svg>
  );
}

const PAGE_SUB = {
  overview: '전사 상태와 데이터 신뢰도를 빠르게 확인', summary: '법인·리전별 요약', vcenters: 'vCenter 플랫폼 현황',
  svcmon: '서비스 성능 점검', hosts: 'ESXi 호스트 인벤토리', vms: '가상머신 인벤토리', datastores: '데이터스토어 용량',
  networks: '포트그룹·네트워크', ipam: 'IP 관리 대장', alarms: '활성 알람', tools: '특수 기능 전체 목록',
  settings: '포탈 설정', upgrade: '버전·업그레이드',
};

export default function V5Shell({
  user, health, healthError = null, upgrading = false, vcenters, tab, visibleTabIds, scope, setScope, children, onSearchIn, onShowVcDown, onShowNotes, onExit, onLogout,
}) {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const isAdmin = user?.role === 'admin';
  const fullScope = !(user?.scope?.vcenters?.length || user?.scope?.regions?.length);
  const tabKey = (visibleTabIds || []).join(',');
  const tree = useMemo(() => resolveTree(TOOLS, {
    isAdmin, toolsAllowed: user?.toolsAllowed ?? null, visibleTabIds, can, toolAllowed, serviceHubUrl: user?.serviceHubUrl || '',
  }), [isAdmin, user, tabKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeKey = activeKeyOf(hash);
  const activeGroupId = useMemo(() => {
    const [kind, id] = activeKey.split(':');
    return (kind === 'tool' ? groupOfTool(id) : groupOfTab(id))?.id
      || tree.groups.find((g) => g.items.some((i) => i.key === activeKey))?.id || null;
  }, [activeKey, tree]);
  const [open, setOpen] = useState(() => new Set());
  useEffect(() => { if (activeGroupId) setOpen((s) => (s.has(activeGroupId) ? s : new Set([...s, activeGroupId]))); }, [activeGroupId]);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { setDrawer(false); }, [hash]);
  // 활성 항목이 사이드바 밖에 있으면 보이게 한다(딥링크·검색으로 들어오면 그 그룹이 펼쳐지지만 스크롤은 그대로다).
  const navRef = useRef(null);
  const activeOpen = !!activeGroupId && open.has(activeGroupId); // 사용자가 다른 그룹을 여닫을 때는 스크롤하지 않는다
  useEffect(() => {
    const t = setTimeout(() => {
      const el = navRef.current?.querySelector('[aria-current="page"]');
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    }, 0);
    return () => clearTimeout(t);
  }, [activeKey, activeOpen]);

  // 하단 상태 카드 — 통신 지도는 조건을 만족할 때만 부른다(아니면 path '' → 폴링하지 않는다).
  const commOk = isAdmin && fullScope && toolAllowed('comm-map');
  const { data: commMap } = usePolling(commOk ? '/tools/comm-map' : '', {}, 60_000);
  const sc = statusCard({ health, healthError, upgrading, commMap: commOk ? commMap : null });
  // v2.620(WEB2620-02): '최근 수집 N분 전' 은 부모 재렌더에만 기대면 멈춘다 — 30초마다 다시 그린다.
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);

  // 통합 검색
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const res = useMemo(() => searchResults(q, tree, TOOLS), [q, tree]);
  const flat = [...res.data.map((d) => ({ type: 'data', d })), ...res.tools.map((t) => ({ type: 'tool', t }))];
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); inputRef.current?.focus(); setSearchOpen(true); }
      else if (e.key === '/' && tag !== 'input' && tag !== 'textarea' && tag !== 'select') { e.preventDefault(); inputRef.current?.focus(); setSearchOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const go = (entry) => {
    if (!entry) return;
    if (entry.type === 'data') {
      const t = entry.d.target;
      if (t.kind === 'tab') onSearchIn?.(t.id, entry.d.q);
      else { handoffSearch(t.id, entry.d.q); window.location.hash = t.hash; }
    } else {
      const t = entry.t;
      if (t.locked) return;
      if (t.href) window.open(t.href, '_blank', 'noopener,noreferrer');
      else if (t.hash) window.location.hash = t.hash;
    }
    setQ(''); setSearchOpen(false); inputRef.current?.blur();
  };
  const onSearchKey = (e) => {
    if (e.key === 'Escape') { setSearchOpen(false); e.currentTarget.blur(); return; }
    if (!flat.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => (i + 1) % flat.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => (i - 1 + flat.length) % flat.length); }
    else if (e.key === 'Enter') { e.preventDefault(); go(flat[sel]); }
  };

  // 제목
  const [ak, aid] = activeKey.split(':');
  const activeItem = [...tree.home, ...tree.groups.flatMap((g) => g.items)].find((i) => i.key === activeKey);
  const title = ak === 'tool' ? (TOOLS.find((t) => t.k === aid)?.label || aid) : (activeItem?.name || TAB_NAMES[tab] || tab);
  const subtitle = ak === 'tool'
    ? (tree.groups.find((g) => g.id === activeGroupId)?.label || '특수 기능')
    : (PAGE_SUB[aid] || '');

  const scopeName = scope ? ((vcenters || []).find((v) => v.id === scope)?.name || scope) : '전체 법인';

  const navItem = (it) => {
    if (it.kind === 'sub') return <div key={it.key} className="v5-sub">{it.name}</div>;
    const active = it.key === activeKey;
    const cls = `v5-item${active ? ' active' : ''}${it.locked ? ' locked' : ''}`;
    const tip = it.locked ? it.lockReason : it.comingSoon ? '준비 중인 기능입니다' : it.external ? '새 탭에서 열립니다' : undefined;
    if (it.href) {
      return <a key={it.key} className={cls} href={it.href} target="_blank" rel="noopener noreferrer" title={tip}><span className="v5-item-name">{it.name}</span><span className="v5-item-tail">↗</span></a>;
    }
    return (
      <a key={it.key} className={cls} href={it.locked ? undefined : it.hash} aria-disabled={it.locked || undefined} aria-current={active ? 'page' : undefined}
        title={tip} onClick={(e) => { if (it.locked) e.preventDefault(); }}>
        <span className="v5-item-name">{it.name}</span>
        {it.locked ? <span className="v5-item-tail">🔒</span> : it.comingSoon ? <span className="v5-item-tail">준비 중</span> : null}
      </a>
    );
  };

  const sections = [];
  for (const g of tree.groups) {
    let s = sections.find((x) => x.name === g.section);
    if (!s) { s = { name: g.section, groups: [] }; sections.push(s); }
    s.groups.push(g);
  }

  return (
    <div className={`v5${drawer ? ' v5-drawer-open' : ''}`}>
      {drawer && <div className="v5-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}
      <nav className="v5-side" aria-label="V5 메뉴">
        <div className="v5-brand">
          <div className="v5-logo">D</div>
          <div className="v5-brand-text"><b>THE DAVINCI</b><span>Unified Operations</span></div>
          <button type="button" className="v5-icon-btn v5-only-narrow" aria-label="메뉴 닫기" onClick={() => setDrawer(false)}><Icon name="close" /></button>
        </div>
        <div className="v5-nav" ref={navRef}>
          <div className="v5-section">HOME</div>
          {tree.home.map((it) => (
            <a key={it.key} className={`v5-home${it.key === activeKey ? ' active' : ''}`} href={it.hash} aria-current={it.key === activeKey ? 'page' : undefined}>
              <Icon name={it.id === 'overview' ? 'home' : 'summary'} />{it.name}
            </a>
          ))}
          {sections.map((s) => (
            <React.Fragment key={s.name}>
              <div className="v5-section">{s.name}</div>
              {s.groups.map((g) => {
                const isOpen = open.has(g.id);
                return (
                  <div key={g.id} className={`v5-group${g.id === activeGroupId ? ' has-active' : ''}`}>
                    <button type="button" className="v5-group-head" aria-expanded={isOpen}
                      onClick={() => setOpen((set) => { const n = new Set(set); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n; })}>
                      <Icon name={g.icon} />
                      <span className="v5-group-label">{g.label}</span>
                      <span className="v5-count">{g.count}</span>
                      <span className={`v5-chev${isOpen ? ' open' : ''}`}><Icon name="chev" size={14} /></span>
                    </button>
                    {isOpen && <div className="v5-group-items">{g.items.map(navItem)}</div>}
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
        <div className={`v5-status tone-${sc.tone}`}>
          <div className="v5-status-head">
            <span className="v5-dot" />
            <b>{sc.label}</b>
          </div>
          {sc.detail && (
            sc.detailTarget === 'vcenter' ? <button type="button" className="v5-status-detail" onClick={onShowVcDown} title="클릭하면 연결 안 되는 vCenter 목록">{sc.detail}</button>
              : sc.detailTarget === 'edges' ? <button type="button" className="v5-status-detail" onClick={() => { window.location.hash = '#/tools/comm-map'; }} title="클릭하면 통신 지도(엣지 상태)">{sc.detail}</button>
              : <div className="v5-status-detail" style={{ cursor: 'default', textDecoration: 'none' }}>{sc.detail}</div>
          )}
          <div className="v5-status-sub">
            {sc.generatedMs ? `최근 수집 ${agoText(sc.generatedMs)}` : '수집 시각 없음'}
            {health?.version && <> · <button type="button" className="v5-link" onClick={onShowNotes} title="릴리즈 노트 보기">v{health.version}</button></>}
          </div>
          <button type="button" className="v5-exit" onClick={onExit} title="V5 를 끄고 기존 개발 포탈 화면으로 돌아갑니다(주소는 그대로)">기존 화면으로</button>
        </div>
      </nav>

      <div className="v5-main">
        <header className="v5-top">
          <button type="button" className="v5-icon-btn v5-only-narrow" aria-label="메뉴 열기" onClick={() => setDrawer(true)}><Icon name="menu" size={22} /></button>
          <div className="v5-title">
            <div className="v5-title-main">{title}</div>
            {subtitle && <div className="v5-title-sub">{subtitle}</div>}
          </div>
          <div className={`v5-search${searchOpen ? ' open' : ''}`}>
            <label className="v5-search-box">
              <Icon name="search" size={16} />
              <input ref={inputRef} aria-label="통합 검색" placeholder="VM, IP, 시리얼, 알람, 기능 검색" value={q}
                onChange={(e) => { setQ(e.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)}
                onBlur={() => setTimeout(() => setSearchOpen(false), 150)} onKeyDown={onSearchKey} />
              <span className="v5-kbd">{q ? 'Esc' : 'Ctrl K'}</span>
            </label>
            {searchOpen && q.trim() && (
              <div className="v5-dropdown" role="listbox" aria-label="검색 결과">
                {res.data.length > 0 && <div className="v5-dd-head">데이터에서 찾기</div>}
                {res.data.map((d, i) => (
                  <div key={d.key} role="option" aria-selected={sel === i} className={`v5-dd-item${sel === i ? ' sel' : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); go({ type: 'data', d }); }} onMouseEnter={() => setSel(i)}>
                    <Icon name={d.icon} size={16} /><span className="v5-dd-name">{d.label}</span><span className="v5-dd-where">{d.where}</span>
                  </div>
                ))}
                {res.data.length > 0 && res.tools.length > 0 && <div className="v5-dd-sep" />}
                {res.tools.length > 0 && <div className="v5-dd-head">기능 · 메뉴</div>}
                {res.tools.map((t, j) => {
                  const i = res.data.length + j;
                  return (
                    <div key={t.key} role="option" aria-selected={sel === i} aria-disabled={t.locked || undefined}
                      className={`v5-dd-item${sel === i ? ' sel' : ''}${t.locked ? ' locked' : ''}`} title={t.lockReason || undefined}
                      onMouseDown={(e) => { e.preventDefault(); go({ type: 'tool', t }); }} onMouseEnter={() => setSel(i)}>
                      <span className="v5-dd-name">{t.name}{t.locked ? ' 🔒' : ''}</span><span className="v5-dd-where">{t.group}</span>
                    </div>
                  );
                })}
                {res.toolsOmitted > 0 && <div className="v5-dd-foot">기능 {res.toolsOmitted}개 더 있음 — 검색어를 더 입력하세요</div>}
                {!flat.length && <div className="v5-dd-foot">일치하는 기능이 없습니다.</div>}
                <div className="v5-dd-foot">↑↓ 이동 · Enter 열기 · Esc 닫기 — 권한이 없는 메뉴는 목록에 나오지 않습니다</div>
              </div>
            )}
          </div>
          <label className="v5-scope" title="법인(vCenter) 범위 — 인벤토리 화면과 특수 기능의 vCenter 범위에 함께 적용됩니다">
            <Icon name="building" size={16} stroke="var(--mint)" />
            <span className="v5-scope-name">{scopeName}</span>
            <select aria-label="법인 범위" value={scope || ''} onChange={(e) => setScope(e.target.value)}>
              <option value="">전체 법인</option>
              {(vcenters || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <div className="v5-user">
            <div className="v5-avatar" title={`${user?.name || ''} (${user?.role || ''})`}>{(user?.name || 'U').slice(0, 1).toUpperCase()}</div>
            <button type="button" className="v5-logout" onClick={onLogout} title="로그아웃">Out</button>
          </div>
        </header>
        <main className="v5-body">{children}</main>
      </div>
      <BackToTop />
    </div>
  );
}

function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const on = () => setShow(window.scrollY > 600);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  if (!show) return null;
  return (
    <button type="button" className="v5-top-btn" aria-label="맨 위로" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
      <Icon name="up" size={20} />
    </button>
  );
}
