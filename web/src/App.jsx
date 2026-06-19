import React, { useEffect, useMemo, useState } from 'react';
import { usePolling, getToken, setToken, setUnauthorizedHandler, fetchAuthConfig, fetchMe } from './api.js';
import Overview from './views/Overview.jsx';
import Hosts from './views/Hosts.jsx';
import Vms from './views/Vms.jsx';
import Datastores from './views/Datastores.jsx';
import Networks from './views/Networks.jsx';
import Alarms from './views/Alarms.jsx';
import Explore from './views/Explore.jsx';
import VCenters from './views/VCenters.jsx';
import Summary from './views/Summary.jsx';
import Upgrade from './views/Upgrade.jsx';
import VCenterAdmin from './views/VCenterAdmin.jsx';
import Diagnostics from './views/Diagnostics.jsx';
import Login from './views/Login.jsx';

const TABS = [
  { id: 'overview', label: '개요' },
  { id: 'summary', label: '통합 서머리' },
  { id: 'vcenters', label: 'vCenter' },
  { id: 'explore', label: '탐색·랭킹' },
  { id: 'hosts', label: '호스트' },
  { id: 'vms', label: '가상머신' },
  { id: 'datastores', label: '스토리지' },
  { id: 'networks', label: '네트워크' },
  { id: 'alarms', label: '알람' },
  { id: 'vcenter-admin', label: 'vCenter 관리', adminOnly: true },
  { id: 'diagnostics', label: '진단·로그', adminOnly: true },
  { id: 'upgrade', label: '업그레이드', adminOnly: true, feature: 'upgradeTab' },
];

const REGIONS = ['Americas', 'EMEA', 'APAC'];

// Per-menu filter (added to the shared filter bar on the matching tab).
const MENU_FILTERS = {
  hosts: { key: 'state', options: [['', '전체 상태'], ['CONNECTED', '정상'], ['MAINTENANCE', '점검'], ['DISCONNECTED', '연결끊김']] },
  vms: { key: 'powerState', options: [['', '전체 전원'], ['POWERED_ON', 'On'], ['POWERED_OFF', 'Off']] },
  datastores: { key: 'type', options: [['', '전체 유형'], ['VMFS', 'VMFS'], ['NFS', 'NFS'], ['vSAN', 'vSAN']] },
  networks: { key: 'type', options: [['', '전체 유형'], ['STANDARD_PORTGROUP', 'Standard'], ['DISTRIBUTED_PORTGROUP', 'Distributed']] },
  alarms: { key: 'severity', options: [['', '전체 심각도'], ['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']] },
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
  return <Portal user={user} onLogout={logout} />;
}

function Portal({ user, onLogout }) {
  const isAllowed = (id) => {
    const t = TABS.find((x) => x.id === id);
    return Boolean(t && (!t.adminOnly || user.role === 'admin'));
  };
  const tabFromHash = () => {
    const h = window.location.hash.replace(/^#\/?/, '');
    return isAllowed(h) ? h : null;
  };

  // Initial view: the tab in the URL hash (so a refresh stays put), else the
  // user's saved landing-page preference.
  const [tab, setTabState] = useState(() => tabFromHash() || getLandingTab());
  const [landingTab, setLandingTab] = useState(getLandingTab);
  const [vcenterId, setVcenterId] = useState('');
  const [region, setRegion] = useState('');
  const [q, setQ] = useState('');
  const [menuFilter, setMenuFilter] = useState({}); // { [tabId]: value }

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
    if (q) f.q = q;
    const mf = MENU_FILTERS[tab];
    if (mf && menuFilter[tab]) f[mf.key] = menuFilter[tab];
    return f;
  }, [vcenterId, region, q, tab, menuFilter]);

  // Scope (region/vCenter) without the free-text query, used by Explore.
  const scope = useMemo(() => {
    const s = {};
    if (vcenterId) s.vcenterId = vcenterId;
    else if (region) s.region = region;
    return s;
  }, [vcenterId, region]);

  const noFilterTabs = ['overview', 'vcenters', 'summary', 'upgrade', 'vcenter-admin', 'diagnostics'];
  const showFilters = !noFilterTabs.includes(tab);
  const showTextSearch = tab !== 'explore';

  const selectSite = (id) => { setVcenterId(id); setTab('hosts'); };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo">V</div>
          <div>
            <h1>VMware Global Monitoring Portal{health?.version && <span className="ver-badge">v{health.version}</span>}</h1>
            <div className="sub">전세계 vCenter 인프라 통합 모니터링{health?.version && <> · 버전 v{health.version}</>}</div>
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
              <>
                <span className="dot live" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
                {health ? `${health.source.toUpperCase()} · ${conn}/${total} vCenter` : '연결 중…'}
                {!allOk && <span className="muted">({total - conn} 불가)</span>}
                {health?.generatedAt && <span className="muted">· {new Date(health.generatedAt).toLocaleTimeString('ko-KR')}</span>}
              </>
            );
          })()}
        </div>
        <div className="settings-box" title="로그인 후 처음 보여줄 화면">
          <span className="muted">시작 화면</span>
          <select className="select select-sm" value={landingTab} onChange={(e) => saveLanding(e.target.value)}>
            {visibleTabs.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div className="user-box">
          <div className="user-avatar" title={user.name}>{(user.name || 'U').slice(0, 1).toUpperCase()}</div>
          <div className="user-meta">
            <div className="user-name">{user.name}</div>
            <div className="user-role muted">{user.role}</div>
          </div>
          <button className="logout-btn" onClick={onLogout} title="로그아웃">로그아웃</button>
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
              <input className="input" placeholder="이름 / IP / OS 검색…" value={q} onChange={(e) => setQ(e.target.value)} />
            )}
            {(region || vcenterId || q || menuFilter[tab]) && (
              <button className="tab" onClick={() => { setRegion(''); setVcenterId(''); setQ(''); setMenuFilter((m) => ({ ...m, [tab]: '' })); }}>필터 초기화</button>
            )}
          </div>
        )}

        {tab === 'overview' && <Overview onSelectSite={selectSite} onGotoTab={setTab} />}
        {tab === 'summary' && <Summary scope={scope} onGotoTab={setTab} />}
        {tab === 'vcenters' && <VCenters onSelectSite={selectSite} />}
        {tab === 'explore' && <Explore scope={scope} />}
        {tab === 'hosts' && <Hosts filters={filters} />}
        {tab === 'vms' && <Vms filters={filters} />}
        {tab === 'datastores' && <Datastores filters={filters} />}
        {tab === 'networks' && <Networks filters={filters} />}
        {tab === 'alarms' && <Alarms filters={filters} />}
        {tab === 'vcenter-admin' && user.role === 'admin' && <VCenterAdmin />}
        {tab === 'diagnostics' && user.role === 'admin' && <Diagnostics />}
        {tab === 'upgrade' && user.role === 'admin' && health?.features?.upgradeTab && <Upgrade />}
      </main>
    </div>
  );
}
