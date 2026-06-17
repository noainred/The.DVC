import React, { useMemo, useState } from 'react';
import { usePolling } from './api.js';
import Overview from './views/Overview.jsx';
import Hosts from './views/Hosts.jsx';
import Vms from './views/Vms.jsx';
import Datastores from './views/Datastores.jsx';
import Networks from './views/Networks.jsx';
import Alarms from './views/Alarms.jsx';

const TABS = [
  { id: 'overview', label: '개요' },
  { id: 'hosts', label: '호스트' },
  { id: 'vms', label: '가상머신' },
  { id: 'datastores', label: '스토리지' },
  { id: 'networks', label: '네트워크' },
  { id: 'alarms', label: '알람' },
];

const REGIONS = ['Americas', 'EMEA', 'APAC'];

export default function App() {
  const [tab, setTab] = useState('overview');
  const [vcenterId, setVcenterId] = useState('');
  const [region, setRegion] = useState('');
  const [q, setQ] = useState('');

  const { data: health } = usePolling('/health', {}, 20_000);
  const { data: vcenters } = usePolling('/vcenters', {}, 60_000);

  const filters = useMemo(() => {
    const f = {};
    if (vcenterId) f.vcenterId = vcenterId;
    else if (region) f.region = region;
    if (q) f.q = q;
    return f;
  }, [vcenterId, region, q]);

  const showFilters = tab !== 'overview';

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
          <span className={`dot live ${health?.status === 'ok' ? '' : ''}`} />
          {health ? `${health.source.toUpperCase()} · ${health.vcenters} vCenter` : '연결 중…'}
          {health?.generatedAt && <span className="muted">· {new Date(health.generatedAt).toLocaleTimeString('ko-KR')}</span>}
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
            <input className="input" placeholder="이름 / IP / OS 검색…" value={q} onChange={(e) => setQ(e.target.value)} />
            {(region || vcenterId || q) && (
              <button className="tab" onClick={() => { setRegion(''); setVcenterId(''); setQ(''); }}>필터 초기화</button>
            )}
          </div>
        )}

        {tab === 'overview' && <Overview onSelectSite={selectSite} onGotoTab={setTab} />}
        {tab === 'hosts' && <Hosts filters={filters} />}
        {tab === 'vms' && <Vms filters={filters} />}
        {tab === 'datastores' && <Datastores filters={filters} />}
        {tab === 'networks' && <Networks filters={filters} />}
        {tab === 'alarms' && <Alarms filters={filters} />}
      </main>
    </div>
  );
}
