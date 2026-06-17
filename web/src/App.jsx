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
];

const REGIONS = ['Americas', 'EMEA', 'APAC'];
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
  // Initial view honours the user's saved landing-page preference.
  const [tab, setTab] = useState(getLandingTab);
  const [landingTab, setLandingTab] = useState(getLandingTab);
  const [vcenterId, setVcenterId] = useState('');
  const [region, setRegion] = useState('');
  const [q, setQ] = useState('');

  const saveLanding = (id) => { setLandingTab(id); localStorage.setItem(LANDING_KEY, id); };

  const { data: health } = usePolling('/health', {}, 20_000);
  const { data: vcenters } = usePolling('/vcenters', {}, 60_000);

  const filters = useMemo(() => {
    const f = {};
    if (vcenterId) f.vcenterId = vcenterId;
    else if (region) f.region = region;
    if (q) f.q = q;
    return f;
  }, [vcenterId, region, q]);

  // Scope (region/vCenter) without the free-text query, used by Explore.
  const scope = useMemo(() => {
    const s = {};
    if (vcenterId) s.vcenterId = vcenterId;
    else if (region) s.region = region;
    return s;
  }, [vcenterId, region]);

  const noFilterTabs = ['overview', 'vcenters', 'summary'];
  const showFilters = !noFilterTabs.includes(tab);
  const showTextSearch = tab !== 'explore';

  const selectSite = (id) => { setVcenterId(id); setTab('hosts'); };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo">V</div>
          <div>
            <h1>VMware Global Monitoring Portal</h1>
            <div className="sub">전세계 vCenter 인프라 통합 모니터링</div>
          </div>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="status-pill">
          <span className="dot live" />
          {health ? `${health.source.toUpperCase()} · ${health.vcenters} vCenter` : '연결 중…'}
          {health?.generatedAt && <span className="muted">· {new Date(health.generatedAt).toLocaleTimeString('ko-KR')}</span>}
        </div>
        <div className="settings-box" title="로그인 후 처음 보여줄 화면">
          <span className="muted">시작 화면</span>
          <select className="select select-sm" value={landingTab} onChange={(e) => saveLanding(e.target.value)}>
            {TABS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
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
            {showTextSearch && (
              <input className="input" placeholder="이름 / IP / OS 검색…" value={q} onChange={(e) => setQ(e.target.value)} />
            )}
            {(region || vcenterId || q) && (
              <button className="tab" onClick={() => { setRegion(''); setVcenterId(''); setQ(''); }}>필터 초기화</button>
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
      </main>
    </div>
  );
}
