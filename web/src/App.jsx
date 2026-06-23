import React, { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { usePolling, getToken, setToken, setUnauthorizedHandler, fetchAuthConfig, fetchMe } from './api.js';
import { SearchBox } from './components/ui.jsx';
import { RemoteConsoleWindow } from './remote/RemoteConsoleWindow.jsx';
import Login from './views/Login.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

// 탭 화면은 지연 로드(코드 스플릿)해 초기 번들/첫 로딩을 줄인다(recharts 등 무거운 의존성 분리).
const Overview = lazy(() => import('./views/Overview.jsx'));
const Hosts = lazy(() => import('./views/Hosts.jsx'));
const Vms = lazy(() => import('./views/Vms.jsx'));
const Datastores = lazy(() => import('./views/Datastores.jsx'));
const Networks = lazy(() => import('./views/Networks.jsx'));
const Nsx = lazy(() => import('./views/Nsx.jsx'));
const Alarms = lazy(() => import('./views/Alarms.jsx'));
const Explore = lazy(() => import('./views/Explore.jsx'));
const VCenters = lazy(() => import('./views/VCenters.jsx'));
const Summary = lazy(() => import('./views/Summary.jsx'));
const Upgrade = lazy(() => import('./views/Upgrade.jsx'));
const Settings = lazy(() => import('./views/Settings.jsx'));
const SpecialTools = lazy(() => import('./views/SpecialTools.jsx'));
const Insights = lazy(() => import('./views/Insights.jsx'));
const VmProvision = lazy(() => import('./views/VmProvision.jsx'));
const ReleaseNotes = lazy(() => import('./views/ReleaseNotes.jsx'));

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'summary', label: 'Summary' },
  { id: 'vcenters', label: 'Platform' },
  { id: 'explore', label: '탐색·랭킹' },
  { id: 'hosts', label: '호스트' },
  { id: 'vms', label: '가상머신' },
  { id: 'datastores', label: '스토리지' },
  { id: 'networks', label: '네트워크' },
  { id: 'nsx', label: 'NSX' },
  { id: 'alarms', label: '알람' },
  { id: 'tools', label: '특수 기능' },
  { id: 'insights', label: '인사이트' },
  { id: 'provision', label: 'VM 생성', adminOnly: true },
  { id: 'settings', label: '설정', adminOnly: true },
  { id: 'upgrade', label: '업그레이드', adminOnly: true, feature: 'upgradeTab' },
];

const REGIONS = ['아시아', '중국', '유럽', '북미'];

// Per-menu filter (added to the shared filter bar on the matching tab).
const MENU_FILTERS = {
  hosts: { key: 'state', options: [['', '전체 상태'], ['CONNECTED', '정상'], ['MAINTENANCE', '점검'], ['DISCONNECTED', '연결끊김']] },
  vms: { key: 'powerState', options: [['', '전체 전원'], ['POWERED_ON', 'On'], ['POWERED_OFF', 'Off']] },
  datastores: { key: 'type', options: [['', '전체 유형'], ['VMFS', 'VMFS'], ['NFS', 'NFS'], ['vSAN', 'vSAN']] },
  networks: { key: 'type', options: [['', '전체 유형'], ['STANDARD_PORTGROUP', 'Standard'], ['DISTRIBUTED_PORTGROUP', 'Distributed']] },
  alarms: { key: 'severity', options: [['', '전체 심각도'], ['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']] },
};
const fmtUptime = (s) => {
  if (s == null) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
};
const LANDING_KEY = 'vmportal.landingTab';
const getLandingTab = () => {
  const saved = localStorage.getItem(LANDING_KEY);
  return TABS.some((t) => t.id === saved) ? saved : 'overview';
};

export default function App() {
  // auth bootstrap: 'loading' | 'anon' | user object
  const [user, setUser] = useState('loading');

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    (async () => {
      const cfg = await fetchAuthConfig();
      if (!cfg.authEnabled) return setUser({ name: 'Anonymous', role: 'admin' });
      if (!getToken()) return setUser(null);
      const me = await fetchMe();
      setUser(me || null);
    })();
  }, []);

  const logout = () => { setToken(null); setUser(null); };

  if (user === 'loading') {
    return <div className="login-screen"><div className="loading">불러오는 중…</div></div>;
  }
  if (!user) return <Login onSuccess={setUser} />;
  return (
    <ErrorBoundary fallback={
      <div className="login-screen"><div className="error-box">
        <div style={{ fontWeight: 700, marginBottom: 8 }}>화면을 표시하는 중 오류가 발생했습니다.</div>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} onClick={() => window.location.reload()}>새로고침</button>
      </div></div>
    }>
      <Portal user={user} onLogout={logout} />
    </ErrorBoundary>
  );
}

function Portal({ user, onLogout }) {
  const isAllowed = (id) => {
    const t = TABS.find((x) => x.id === id);
    return Boolean(t && (!t.adminOnly || user.role === 'admin'));
  };
  const tabFromHash = () => {
    // 첫 세그먼트만 탭으로 사용(예: #/tools/esxitemp → tools). 나머지는 각 뷰가 처리.
    const h = window.location.hash.replace(/^#\/?/, '').split('/')[0];
    return isAllowed(h) ? h : null;
  };

  // Initial view: the tab in the URL hash (so a refresh stays put), else the
  // user's saved landing-page preference.
  const [tab, setTabState] = useState(() => tabFromHash() || getLandingTab());
  const [landingTab, setLandingTab] = useState(getLandingTab);
  // Filters are kept PER TAB so a filter set on one menu never carries over to
  // (or shows on) another menu. Each tab has its own { region, vcenterId, q }.
  const [tabFilters, setTabFilters] = useState({}); // { [tabId]: { region, vcenterId, q } }
  const [menuFilter, setMenuFilter] = useState({}); // { [tabId]: value }
  const [showNotes, setShowNotes] = useState(false);

  const cur = tabFilters[tab] || {};
  const region = cur.region || '';
  const vcenterId = cur.vcenterId || '';
  const q = cur.q || '';
  const qNotes = !!cur.qNotes; // 메모 포함 검색 (기본 꺼짐)
  const patchFilter = (patch, t = tab) => setTabFilters((m) => ({ ...m, [t]: { ...(m[t] || {}), ...patch } }));
  const setRegion = (v) => patchFilter({ region: v, vcenterId: '' });
  const setVcenterId = (v) => patchFilter({ vcenterId: v });
  const setQ = (v) => patchFilter({ q: v });
  const setQNotes = (v) => patchFilter({ qNotes: v });

  // Keep the URL hash in sync with the active tab, and follow back/forward.
  const setTab = (id) => { setTabState(id); window.location.hash = `#/${id}`; };
  useEffect(() => {
    if (!tabFromHash()) window.history.replaceState(null, '', `#/${tab}`);
    const onHash = () => { const t = tabFromHash(); if (t) setTabState(t); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveLanding = (id) => { setLandingTab(id); localStorage.setItem(LANDING_KEY, id); };

  const { data: health } = usePolling('/health', {}, 20_000);
  const { data: vcenters } = usePolling('/vcenters', {}, 60_000);

  // Notify when the running version changes (an upgrade was applied + restarted).
  const lastVerRef = useRef(null);
  const [upToast, setUpToast] = useState(null);
  useEffect(() => {
    const v = health?.version;
    if (!v) return;
    if (lastVerRef.current === null) { lastVerRef.current = v; return; }
    if (lastVerRef.current !== v) { lastVerRef.current = v; setUpToast(v); }
  }, [health?.version]);
  useEffect(() => {
    if (!upToast) return;
    const t = setTimeout(() => setUpToast(null), 8000);
    return () => clearTimeout(t);
  }, [upToast]);

  // Easter egg: click the logo 30 times.
  const [eggClicks, setEggClicks] = useState(0);
  const [egg, setEgg] = useState(false);
  const bumpEgg = () => setEggClicks((n) => { const m = n + 1; if (m >= 30) { setEgg(true); return 0; } return m; });

  // Hide admin-only tabs from other roles, and feature-gated tabs (e.g. 업그레이드)
  // unless the server enables them.
  const visibleTabs = TABS.filter((t) => {
    if (t.adminOnly && user.role !== 'admin') return false;
    if (t.feature && !health?.features?.[t.feature]) return false;
    return true;
  });

  const filters = useMemo(() => {
    const f = {};
    if (vcenterId) f.vcenterId = vcenterId;
    else if (region) f.region = region;
    if (q) { f.q = q; if (qNotes) f.notes = '1'; }
    const mf = MENU_FILTERS[tab];
    if (mf && menuFilter[tab]) f[mf.key] = menuFilter[tab];
    return f;
  }, [vcenterId, region, q, qNotes, tab, menuFilter]);

  // Scope (region/vCenter) without the free-text query, used by Explore.
  const scope = useMemo(() => {
    const s = {};
    if (vcenterId) s.vcenterId = vcenterId;
    else if (region) s.region = region;
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vcenterId, region]);


  const noFilterTabs = ['overview', 'vcenters', 'summary', 'upgrade', 'tools', 'insights', 'settings', 'nsx', 'provision'];
  const showFilters = !noFilterTabs.includes(tab);
  const showTextSearch = tab !== 'explore';

  // Drill into a site → set the HOSTS tab's own vCenter filter, then go there.
  const selectSite = (id) => { patchFilter({ vcenterId: id, region: '' }, 'hosts'); setTab('hosts'); };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo" onClick={bumpEgg} style={{ cursor: 'pointer' }}>V</div>
          <div>
            <h1 className="brand-title">The Davinci<br />Virtual Platform</h1>
            {health?.version && <span className="ver-badge brand-ver" style={{ cursor: 'pointer' }} title="릴리즈 노트 보기" onClick={() => setShowNotes(true)}>v{health.version}</span>}
            {health?.source && (
              <span className="ver-badge brand-ver" style={{
                marginLeft: 6,
                color: health.source === 'live' ? '#4ade80' : health.source === 'mock' ? '#fbbf24' : '#22d3ee',
                background: health.source === 'live' ? 'rgba(34,197,94,.12)' : health.source === 'mock' ? 'rgba(245,158,11,.14)' : 'rgba(34,211,238,.12)',
                borderColor: 'transparent',
              }} title="데이터 소스">{health.source.toUpperCase()}</span>
            )}
          </div>
        </div>
        <nav className="tabs">
          {visibleTabs.map((t) => (
            <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="status-pill">
          {(() => {
            const total = health?.vcenters ?? 0;
            const conn = health?.vcentersConnected ?? 0;
            const allOk = total === 0 || conn === total;
            const color = allOk ? 'var(--green)' : conn === 0 ? 'var(--red)' : 'var(--amber)';
            return (
              <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                <span>
                  <span className="dot live" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
                  {health ? `${conn}/${total} vCenter` : '연결 중…'}
                  {health && (allOk
                    ? <span style={{ color: '#fbbf24', fontWeight: 700 }}> OK</span>
                    : <span style={{ color: '#f87171', fontWeight: 700 }}> ({total - conn} 불가)</span>)}
                </span>
                {health?.generatedAt && <span className="muted" style={{ fontSize: 11, textAlign: 'center' }}>{new Date(health.generatedAt).toLocaleTimeString('ko-KR')}</span>}
              </div>
            );
          })()}
        </div>
        <div className="user-box">
          <div className="user-avatar" title={user.name}>{(user.name || 'U').slice(0, 1).toUpperCase()}</div>
          <div className="user-meta">
            <div className="user-name">{user.name}</div>
            <div className="user-role muted">{user.role}</div>
          </div>
          <button className="logout-btn" onClick={onLogout} title="로그아웃">Out</button>
        </div>
      </header>

      <main className="content">
        {showFilters && (
          <div className="filters">
            <select className="select" value={region} onChange={(e) => { setRegion(e.target.value); setVcenterId(''); }}>
              <option value="">전체 리전</option>
              {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <select className="select" value={vcenterId} onChange={(e) => setVcenterId(e.target.value)}>
              <option value="">전체 vCenter</option>
              {(vcenters || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            {MENU_FILTERS[tab] && (
              <select className="select" value={menuFilter[tab] || ''}
                onChange={(e) => setMenuFilter((m) => ({ ...m, [tab]: e.target.value }))}>
                {MENU_FILTERS[tab].options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            )}
            {showTextSearch && (
              <SearchBox placeholder="이름 / IP / OS 검색…" value={q} onChange={setQ} />
            )}
            {showTextSearch && (
              <label className="flex gap" style={{ alignItems: 'center', fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer' }}
                title="체크하면 검색에 메모(Notes) 내용도 포함합니다. (기본: 미포함)">
                <input type="checkbox" checked={qNotes} onChange={(e) => setQNotes(e.target.checked)} /> 메모 포함
              </label>
            )}
            {(region || vcenterId || q || menuFilter[tab]) && (
              <button className="tab" onClick={() => { patchFilter({ region: '', vcenterId: '', q: '', qNotes: false }); setMenuFilter((m) => ({ ...m, [tab]: '' })); }}>필터 초기화</button>
            )}
          </div>
        )}

        <ErrorBoundary key={tab}>
         <Suspense fallback={<div className="muted" style={{ padding: 24 }}>로딩 중…</div>}>
          {tab === 'overview' && <Overview onSelectSite={selectSite} onGotoTab={setTab} />}
          {tab === 'summary' && <Summary scope={scope} onGotoTab={setTab} />}
          {tab === 'vcenters' && <VCenters onSelectSite={selectSite} />}
          {tab === 'explore' && <Explore scope={scope} />}
          {tab === 'hosts' && <Hosts filters={filters} />}
          {tab === 'vms' && <Vms filters={filters} />}
          {tab === 'datastores' && <Datastores filters={filters} />}
          {tab === 'networks' && <Networks filters={filters} />}
          {tab === 'nsx' && <Nsx />}
          {tab === 'alarms' && <Alarms filters={filters} />}
          {tab === 'tools' && <SpecialTools />}
          {tab === 'insights' && <Insights onGotoTab={setTab} />}
          {tab === 'provision' && user.role === 'admin' && <VmProvision />}
          {tab === 'settings' && user.role === 'admin' && <Settings />}
          {tab === 'upgrade' && user.role === 'admin' && health?.features?.upgradeTab && <Upgrade />}
         </Suspense>
        </ErrorBoundary>
      </main>

      <footer className="statusbar">
        <div className="sb-cell"><span className="sb-label">서버 Uptime</span><span className="sb-val">{fmtUptime(health?.uptimeSec)}</span></div>
        <div className="sb-cell"><span className="sb-label">전체 호스트</span><span className="sb-val">{(health?.hosts || 0).toLocaleString()}</span></div>
        <div className="sb-cell"><span className="sb-label">전체 VM</span><span className="sb-val">{(health?.vms || 0).toLocaleString()} <small className="muted">({(health?.vmsPoweredOn || 0).toLocaleString()} On)</small></span></div>
        <div className="sb-cell"><span className="sb-label">활성 알람</span><span className="sb-val" style={{ color: health?.alarmsCritical ? 'var(--red)' : undefined }}>{(health?.alarms || 0).toLocaleString()}</span></div>
      </footer>

      {upToast && (
        <div className="up-toast">
          <span className="up-toast-icon">⬆️</span>
          <div className="up-toast-body">
            <div className="up-toast-title">업그레이드 완료</div>
            <div className="up-toast-sub">버전 <b>v{upToast}</b> 으로 업데이트되었습니다.</div>
          </div>
          <button className="up-toast-reload" onClick={() => window.location.reload()}>새로고침</button>
          <button className="up-toast-x" onClick={() => setUpToast(null)} aria-label="닫기">×</button>
        </div>
      )}

      {egg && (
        <div className="egg-overlay" onClick={() => setEgg(false)}>
          <div className="egg-sparkles">{'✨🎉💫⭐🎊✨🌟💥'.split('').map((s, i) => (
            <span key={i} style={{ ['--i']: i }}>{s}</span>
          ))}</div>
          <div className="egg-card" onClick={(e) => e.stopPropagation()}>
            <div className="egg-emoji">🚀</div>
            <div className="egg-line">이 프로그램은</div>
            <div className="egg-name">박준호</div>
            <div className="egg-line">가 만들었습니다.</div>
            <button className="egg-btn" onClick={() => setEgg(false)}>닫기</button>
          </div>
        </div>
      )}

      {showNotes && <Suspense fallback={null}><ReleaseNotes isAdmin={user.role === 'admin'} onClose={() => setShowNotes(false)} /></Suspense>}
      <RemoteConsoleWindow />
    </div>
  );
}
