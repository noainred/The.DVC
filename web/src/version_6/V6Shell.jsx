import React, { useEffect, useMemo, useRef, useState } from 'react';
import { can, toolAllowed } from '../api.js';
import { TOOLS } from '../views/specialToolsList.js';
import { resolveNav, activePageOf, menuById, menuOfKey, TAB_INFO } from './menus.js';
import { parseMenuHash, menuHash } from './route.js';
import { searchResults } from '../version_5/searchData.js';
import { handoffSearch } from '../hooks/searchHandoff.js';
import { vcStatusCounts } from '../console/consoleData.js';
import { statusCounts } from '../views/statusBarText.js'; // v2.675 — 첫 수집 중 판정은 개발 포탈 상태바와 한 벌
import MenuPage from './pages/MenuPage.jsx';
import './v6.css';

/**
 * V6 셸(v2.623) — 좌측 사이드바(DASHBOARD 2 + 상위 메뉴 10) · 상단 헤더 · 하단 상태바. 사용자 제공 핸드오프
 * `design_handoff_portal_home`(Portal Home.dc.html) 구현. V5 와 같은 원칙이다:
 *   · 새 라우터가 아니라 **기존 라우터 위의 새 틀**이다 — 본문(children)은 App 이 그리는 기존 화면 그대로.
 *     예외는 V6 전용 페이지 셋(Overview·Summary·메뉴 페이지 `#/m/<id>`)이다.
 *   · 폴링을 새로 만들지 않는다 — /health·/vcenters 는 App 것을 받는다.
 *   · 숨김·잠금은 views/toolVisibility.js, 검색은 V5 searchData(= views/toolSearch.js) 를 그대로 쓴다.
 */

const fmtInt = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v).toLocaleString('en-US') : '—');
function uptimeText(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 0) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}일 ${h}시간` : h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}
const PAGE_TITLE = { overview: ['01 · DASHBOARD', 'Overview'], summary: ['02 · DASHBOARD', 'Summary'] };

export default function V6Shell({
  user, health, healthError = null, upgrading = false, tab, visibleTabIds, children, onSearchIn, onShowVcDown, onShowNotes, onExit, onLogout,
}) {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const isAdmin = user?.role === 'admin';
  const tabKey = (visibleTabIds || []).join(',');
  const opts = useMemo(() => ({
    isAdmin, toolsAllowed: user?.toolsAllowed ?? null, visibleTabIds, can, toolAllowed, serviceHubUrl: user?.serviceHubUrl || '',
  }), [isAdmin, user, tabKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const nav = useMemo(() => resolveNav(TOOLS, opts), [opts]);
  const menuParse = parseMenuHash(hash);
  const active = activePageOf(hash, menuParse);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { setDrawer(false); }, [hash]);

  // 검색 — V5 searchData 가 받는 모양(home/groups)으로 V6 메뉴를 넘긴다. '어디' 는 V6 메뉴 이름으로 바꾼다.
  const searchTree = useMemo(() => ({
    home: [],
    groups: nav.flatMap((s) => s.menus).map((m) => ({ label: m.label, items: m.groups.flatMap((g) => g.items).map((it) => ({ ...it, name: it.label, id: it.k })) })),
  }), [nav]);
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const res = useMemo(() => {
    const r = searchResults(q, searchTree, TOOLS);
    const data = r.data.map((d) => {
      const m = menuById(menuOfKey(d.target.id));
      return m ? { ...d, where: `${m.label} › ${d.noun}` } : d;
    });
    return { ...r, data };
  }, [q, searchTree]);
  const flat = [...res.data.map((d) => ({ type: 'data', d })), ...res.tools.map((t) => ({ type: 'tool', t }))];
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    const onKey = (e) => {
      const tagName = (e.target?.tagName || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); inputRef.current?.focus(); setSearchOpen(true); }
      else if (e.key === '/' && tagName !== 'input' && tagName !== 'textarea' && tagName !== 'select') { e.preventDefault(); inputRef.current?.focus(); setSearchOpen(true); }
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

  // 제목 — 메뉴 페이지면 메뉴 코드·이름, 기존 화면이면 그 화면이 속한 메뉴 코드 + 화면 이름.
  const segs = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  let crumb;
  if (menuParse) { const m = menuById(menuParse.menuId); crumb = m ? [m.code, m.label] : ['MENU', menuParse.menuId]; }
  else if (PAGE_TITLE[active]) crumb = PAGE_TITLE[active];
  else {
    const m = menuById(active);
    const k = segs[0] === 'tools' ? segs[1] : segs[0];
    const label = segs[0] === 'tools' ? (TOOLS.find((t) => t.k === k)?.label || k || '특수 기능 전체') : (TAB_INFO[k]?.label || k || tab);
    crumb = [m ? `${m.code} › ${m.label}` : 'PORTAL', label];
  }

  // vCenter 상태 pill — 헤더(기존 status-pill 과 같은 판정: consoleData.vcStatusCounts).
  const vc = vcStatusCounts(health || null);
  const vcActive = health ? Math.max(0, (health.vcenters || 0) - (vc?.disabled || 0)) : null;
  const pillTone = !health ? 'none' : upgrading ? 'crit' : healthError ? 'warn' : (vc?.unreach || 0) > 0 ? 'crit' : (vc?.pending || 0) > 0 ? 'warn' : 'ok';
  const pillText = !health ? '상태 확인 중' : upgrading ? 'Upgrading…' : `vCenter ${fmtInt(health.vcentersConnected)}/${fmtInt(vcActive)}`;
  const pillSub = !health ? '' : upgrading ? '' : healthError ? '응답 지연' : (vc?.unreach || 0) > 0 ? `불가 ${vc.unreach}` : (vc?.pending || 0) > 0 ? `첫 수집 중 ${vc.pending}` : 'OK';
  const sb = statusCounts(health);   // v2.675: 하단 상태바 — 첫 수집 중이면 개수 대신 '—'

  let idx = 3;
  const navLink = (id, label, n, count, href) => (
    <a key={id} className={`v6-item${active === id ? ' active' : ''}`} href={href} aria-current={active === id ? 'page' : undefined}>
      <span className="v6-idx">{n}</span><span className="v6-item-label">{label}</span>{count != null && <span className="v6-count">{count}</span>}
    </a>
  );

  return (
    <div className={`v6${drawer ? ' v6-drawer-open' : ''}`}>
      {drawer && <div className="v6-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}
      <nav className="v6-side" aria-label="V6 메뉴">
        <div className="v6-brand">
          <div className="v6-logo">V</div>
          <div className="v6-brand-text">
            <b>The Davinci <span>Virtual Platform</span></b>
            <div className="v6-badges">
              {health?.version && <button type="button" className="v6-badge v6-badge-link" onClick={onShowNotes} title="릴리즈 노트 보기">v{health.version}</button>}
              {health?.source && <span className="v6-badge">{String(health.source).toUpperCase()}</span>}
            </div>
          </div>
          <button type="button" className="v6-icon-btn v6-only-narrow" aria-label="메뉴 닫기" onClick={() => setDrawer(false)}>✕</button>
        </div>
        <div className="v6-nav">
          <div className="v6-group-label">DASHBOARD</div>
          {navLink('overview', 'Overview', '01', null, '#/overview')}
          {navLink('summary', 'Summary', '02', null, '#/summary')}
          {nav.map((s) => (
            <React.Fragment key={s.label}>
              <div className="v6-group-label">{s.label}</div>
              {s.menus.map((m) => {
                const n = String(idx++).padStart(2, '0');
                return (
                  <React.Fragment key={m.id}>
                    {navLink(m.id, m.label, n, m.count, menuHash(m.id))}
                    {active === m.id && (
                      <div className="v6-subs">
                        {m.groups.map((g, gi) => {
                          if (m.id === 'server' && g.seg) {
                            const on = menuParse?.menuId === 'server' && menuParse.seg === g.seg;
                            return <a key={g.name} className={`v6-sub${on ? ' on' : ''}`} href={on ? menuHash('server') : menuHash('server', g.seg)}>{g.name}<span>{g.items.length}</span></a>;
                          }
                          return (
                            <button key={g.name} type="button" className="v6-sub" onClick={() => {
                              if (!menuParse) { window.location.hash = menuHash(m.id); return; }
                              document.getElementById(`v6-g-${gi}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                            }}>{g.name}<span>{g.items.length}</span></button>
                          );
                        })}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </React.Fragment>
          ))}
        </div>
        <div className="v6-side-foot">
          <div><span>UPTIME</span> {uptimeText(health?.uptimeSec)}</div>
          <div><span>ROLE</span> {user?.superAdmin ? 'super_admin' : (user?.role || '—')}</div>
          <button type="button" className="v6-exit" onClick={onExit} title="V6 를 끄고 기존 개발 포탈 화면으로 돌아갑니다(주소는 그대로)">기존 화면으로</button>
        </div>
      </nav>

      <div className="v6-main">
        <header className="v6-top">
          <button type="button" className="v6-icon-btn v6-only-narrow" aria-label="메뉴 열기" onClick={() => setDrawer(true)}>☰</button>
          <div className="v6-crumb">
            <div className="v6-crumb-code">{crumb[0]}</div>
            <div className="v6-crumb-title">{crumb[1]}</div>
          </div>
          <div className={`v6-search${searchOpen ? ' open' : ''}`}>
            <label className="v6-search-box">
              <input ref={inputRef} aria-label="통합 검색" placeholder="기능 · 화면 · VM 찾기" value={q}
                onChange={(e) => { setQ(e.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)}
                onBlur={() => setTimeout(() => setSearchOpen(false), 150)} onKeyDown={onSearchKey} />
              <span className="v6-kbd">{q ? 'Esc' : '⌘K'}</span>
            </label>
            {searchOpen && q.trim() && (
              <div className="v6-dropdown" role="listbox" aria-label="검색 결과">
                {res.data.length > 0 && <div className="v6-dd-head">데이터에서 찾기</div>}
                {res.data.map((d, i) => (
                  <div key={d.key} role="option" aria-selected={sel === i} className={`v6-dd-item${sel === i ? ' sel' : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); go({ type: 'data', d }); }} onMouseEnter={() => setSel(i)}>
                    <span className="v6-dd-name">{d.label}</span><span className="v6-dd-where">{d.where}</span>
                  </div>
                ))}
                {res.tools.length > 0 && <div className="v6-dd-head">기능 · 화면</div>}
                {res.tools.map((t, j) => {
                  const i = res.data.length + j;
                  return (
                    <div key={t.key} role="option" aria-selected={sel === i} aria-disabled={t.locked || undefined}
                      className={`v6-dd-item${sel === i ? ' sel' : ''}${t.locked ? ' locked' : ''}`} title={t.lockReason || undefined}
                      onMouseDown={(e) => { e.preventDefault(); go({ type: 'tool', t }); }} onMouseEnter={() => setSel(i)}>
                      <span className="v6-dd-name">{t.icon ? `${t.icon} ` : ''}{t.name}{t.locked ? ' 🔒' : ''}</span><span className="v6-dd-where">{t.group}</span>
                    </div>
                  );
                })}
                {res.toolsOmitted > 0 && <div className="v6-dd-foot">기능 {res.toolsOmitted}개 더 있음 — 검색어를 더 입력하세요</div>}
                {!flat.length && <div className="v6-dd-foot">일치하는 기능이 없습니다.</div>}
              </div>
            )}
          </div>
          <button type="button" className={`v6-pill tone-${pillTone}`} onClick={(vc?.unreach || 0) > 0 ? onShowVcDown : undefined}
            title={(vc?.unreach || 0) > 0 ? '클릭하면 연결 안 되는 vCenter 목록' : undefined} style={{ cursor: (vc?.unreach || 0) > 0 ? 'pointer' : 'default' }}>
            <i />{pillText}{pillSub && <span>{pillSub}</span>}
          </button>
          <div className="v6-user">
            <span className="v6-user-name" title={user?.role || ''}>{user?.name || user?.username || '사용자'}</span>
            <button type="button" className="v6-logout" onClick={onLogout} title="로그아웃">Out</button>
          </div>
        </header>
        <main className="v6-body">
          {menuParse ? <MenuPage menuId={menuParse.menuId} seg={menuParse.seg} opts={opts} /> : children}
        </main>
        <footer className="v6-statusbar">
          <div><span>서버 UPTIME</span><b>{uptimeText(health?.uptimeSec)}</b></div>
          {/* v2.675: 첫 수집 중(health.initial)이면 0 이 아니라 '—'(statusBarText.statusCounts — App 상태바와 같은 판정). */}
          <div><span>전체 호스트</span><b title={sb.title}>{sb.pending ? '—' : fmtInt(health?.hosts)}</b></div>
          <div><span>전체 VM</span><b title={sb.title}>{sb.pending ? '—' : fmtInt(health?.vms)}</b>{sb.pending ? <em>(— On)</em> : health?.vmsPoweredOn != null && <em>({fmtInt(health.vmsPoweredOn)} On)</em>}</div>
          <div><span>활성 알람</span><b title={sb.title} className={!sb.pending && (health?.alarms || 0) > 0 ? 'alarm' : ''}>{sb.pending ? '—' : fmtInt(health?.alarms)}</b></div>
        </footer>
      </div>
    </div>
  );
}

