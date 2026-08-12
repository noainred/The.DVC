import React, { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { usePolling, getToken, setToken, setUnauthorizedHandler, fetchAuthConfig, fetchMe, broadcastLogout, LOGOUT_BROADCAST_KEY, setCurrentUser, toolAllowed } from './api.js';
import { SearchBox } from './components/ui.jsx';
import { RemoteConsoleWindow } from './remote/RemoteConsoleWindow.jsx';
import Login from './views/Login.jsx';
import ForceOtpEnroll from './views/ForceOtpEnroll.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

// 탭 화면은 지연 로드(코드 스플릿)해 초기 번들/첫 로딩을 줄인다(recharts 등 무거운 의존성 분리).
const Overview = lazy(() => import('./views/Overview.jsx'));
const Hosts = lazy(() => import('./views/Hosts.jsx'));
const Vms = lazy(() => import('./views/Vms.jsx'));
const Datastores = lazy(() => import('./views/Datastores.jsx'));
const Networks = lazy(() => import('./views/Networks.jsx'));
const Alarms = lazy(() => import('./views/Alarms.jsx'));
// IP관리(구 '센터별 IP 관리대장', v2.274 특수 기능에서 승격) — 화면 코드는 SpecialTools.jsx 안에
// 있어(Ipam 본체가 그 파일의 헬퍼들과 얽힘) 단독 래퍼(IpamStandalone)만 named import 한다.
const Ipam = lazy(() => import('./views/SpecialTools.jsx').then((m) => ({ default: m.IpamStandalone })));
const VCenters = lazy(() => import('./views/VCenters.jsx'));
const Summary = lazy(() => import('./views/Summary.jsx'));
const Upgrade = lazy(() => import('./views/Upgrade.jsx'));
const Settings = lazy(() => import('./views/Settings.jsx'));
const SpecialTools = lazy(() => import('./views/SpecialTools.jsx'));
const SvcMonitor = lazy(() => import('./views/SvcMonitor.jsx'));
const Insights = lazy(() => import('./views/Insights.jsx'));
const ReleaseNotes = lazy(() => import('./views/ReleaseNotes.jsx'));
const CodexCheck = lazy(() => import('./views/CodexCheck.jsx'));

const TABS = [
  { id: 'overview', label: 'Overview' }, // 랜딩(항상 노출)
  { id: 'summary', label: 'Summary', perm: 'dashboard' },
  { id: 'vcenters', label: 'Platform', perm: 'dashboard' },
  { id: 'svcmon', label: 'Monitoring', perm: 'dashboard' },
  // 탐색·랭킹은 '특수 기능' 하위로 이동(v2.274, specialToolsList 'explore' 카드).
  { id: 'hosts', label: 'VM호스트', perm: 'inv.hosts' },
  { id: 'vms', label: '가상머신', perm: 'inv.vms' },
  { id: 'datastores', label: '스토리지', perm: 'inv.datastores' },
  { id: 'networks', label: '네트워크', perm: 'inv.networks' },
  // NSX는 '특수 기능' 하위로 이동(specialToolsList의 'nsx' 카드 → 전체 NSX 관리 화면).
  // IP관리는 반대로 특수 기능 카드에서 승격(v2.274) — toolKey 로 도구별 접근(toolsDenied 'ipam') 경계를 그대로 유지.
  { id: 'ipam', label: 'IP관리', perm: 'tools', toolKey: 'ipam' },
  { id: 'alarms', label: '알람', perm: 'inv.alarms' },
  // '특수 기능'은 항목이 많아 탭 자체는 항상 노출한다(권한 없는 도구는 화면 안에서 회색·클릭불가).
  { id: 'tools', label: '특수 기능' },
  { id: 'insights', label: '인사이트', perm: 'insights' },
  { id: 'settings', label: '설정', adminOnly: true, ownerOnly: true, perm: 'settings' },
  { id: 'upgrade', label: '업그레이드', adminOnly: true, feature: 'upgradeTab', perm: 'upgrade' },
  { id: 'codex-check', label: '보안점검', adminOnly: true, perm: 'settings' },
];

// 기능 권한 보유 여부 — admin 은 항상 전체. permissions 배열이 없으면(구버전/인증 비활성) 통과.
export const hasPerm = (u, key) => !key || !u || u.role === 'admin'
  || !Array.isArray(u.permissions) || u.permissions.includes(key);

// '설정'은 지정한 소유 계정으로 로그인했을 때만 노출/접근(목록은 설정 › 세션 보안에서 변경).
// 판단은 서버가 /auth/me 로 내려주는 isSettingsOwner 불리언을 그대로 쓴다 — 예전에는 미인증
// /auth/config 가 '소유 계정명 목록'을 내려줘 계정 열거 단서가 됐다(v2.207 에서 제거).
// 서버도 requireSettingsOwner 로 강제하므로 이 값은 UX 게이팅 용도다.
const isSettingsOwner = (u) => {
  if (!u) return false;
  if (u.name === 'Anonymous') return true;
  return u.isSettingsOwner === true;
};

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
  const [loginNotice, setLoginNotice] = useState('');
  const [authCfg, setAuthCfg] = useState(null);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    (async () => {
      const cfg = await fetchAuthConfig();
      setAuthCfg(cfg);
      if (!cfg.authEnabled) return setUser({ name: 'Anonymous', role: 'admin' });
      if (!getToken()) return setUser(null);
      const me = await fetchMe();
      setUser(me || null);
    })().catch(() => setUser(null)); // 부팅 fetch 실패 시 무한 '로딩' 고착 대신 로그인 화면으로
  }, []);

  // 유휴 자동 로그아웃 — 로그인(실세션) 상태에서 설정된 시간(기본 30분) 동안 입력이 없으면 강제 로그아웃.
  useEffect(() => {
    if (!user || user === 'loading' || !getToken()) return undefined;
    if (authCfg && authCfg.idleLogoutEnabled === false) return undefined;
    const mins = Math.max(1, Number(authCfg?.idleLogoutMin) || 30);
    const IDLE_MS = mins * 60 * 1000;
    let t;
    const doLogout = () => { setToken(null); broadcastLogout(); setLoginNotice(`${mins}분 동안 활동이 없어 자동 로그아웃되었습니다. 다시 로그인하세요.`); setUser(null); };
    const reset = () => { clearTimeout(t); t = setTimeout(doLogout, IDLE_MS); };
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click', 'visibilitychange'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => { clearTimeout(t); events.forEach((e) => window.removeEventListener(e, reset)); };
  }, [user, authCfg]);

  const logout = () => { setToken(null); broadcastLogout(); setUser(null); };

  // 크로스탭 로그아웃 — 한 탭에서 로그아웃하면 다른 탭도 즉시 세션 종료(sessionStorage 토큰
  // 탭 포함). 이전에는 리스너가 없어 복제 탭이 무기한 인증 상태로 남았다.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === LOGOUT_BROADCAST_KEY) { setToken(null); setUser(null); }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // 전역 권한 접근자(api.can/toolAllowed)에 현재 사용자를 반영 — 버튼/도구 게이팅이 참조한다.
  setCurrentUser(user === 'loading' ? null : user);

  if (user === 'loading') {
    return <div className="login-screen"><div className="loading">불러오는 중…</div></div>;
  }
  if (!user) return <Login onSuccess={(u) => { setLoginNotice(''); setUser(u); }} notice={loginNotice} setup={authCfg} />;
  // 고권한 계정이 OTP 미등록 상태로 로그인 → 등록을 마칠 때까지 이 화면에 고정(서버도 API 차단).
  if (user.mustEnrollOtp) {
    return <ForceOtpEnroll user={user} onExit={(completed) => {
      logout();
      setLoginNotice(completed ? 'OTP 등록이 완료되었습니다. 인증 앱의 6자리 코드로 로그인하세요.' : '');
    }} />;
  }
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
  const isOwner = isSettingsOwner(user);
  const isAllowed = (id) => {
    const t = TABS.find((x) => x.id === id);
    return Boolean(t && (!t.adminOnly || user.role === 'admin') && (!t.ownerOnly || isOwner) && hasPerm(user, t.perm)
      && (!t.toolKey || toolAllowed(t.toolKey))); // 특수 기능에서 승격한 탭은 도구별 접근(toolsDenied)도 유지
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
  const qIpms = !!cur.qIpms;   // IPMS(IP 스캔) 자료 포함 — IP 검색 시 해당 대역 스캔 IP도 표시
  const patchFilter = (patch, t = tab) => setTabFilters((m) => ({ ...m, [t]: { ...(m[t] || {}), ...patch } }));
  const setRegion = (v) => patchFilter({ region: v, vcenterId: '' });
  const setVcenterId = (v) => patchFilter({ vcenterId: v });
  const setQ = (v) => patchFilter({ q: v });
  const setQNotes = (v) => patchFilter({ qNotes: v });
  const setQIpms = (v) => patchFilter({ qIpms: v });

  // Keep the URL hash in sync with the active tab, and follow back/forward.
  const setTab = (id) => { setTabState(id); window.location.hash = `#/${id}`; };
  // Platform 탭 재클릭 신호 — vCenter 상세로 드릴다운한 상태에서 상단메뉴 Platform을 다시
  // 누르면 전체 vCenter 목록으로 복귀한다(드릴다운은 VCenters 내부 상태라 탭 클릭만으론 못 되돌림).
  const [platformResetSeq, setPlatformResetSeq] = useState(0);
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
    if (t.ownerOnly && !isOwner) return false; // '설정'은 소유 계정만(설정 › 세션 보안에서 지정)
    if (t.feature && !health?.features?.[t.feature]) return false;
    if (!hasPerm(user, t.perm)) return false;   // 기능 권한 매트릭스로 탭 노출 제어
    if (t.toolKey && !toolAllowed(t.toolKey)) return false; // 승격 탭의 도구별 접근(toolsDenied) 보존
    return true;
  });

  // 현재 탭이 권한/필터로 더 이상 접근 불가하면 안전한 탭(overview)으로 되돌린다.
  useEffect(() => {
    if (tab !== 'overview' && !isAllowed(tab)) setTab('overview');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, user]);

  const filters = useMemo(() => {
    const f = {};
    if (vcenterId) f.vcenterId = vcenterId;
    else if (region) f.region = region;
    if (q) { f.q = q; if (qNotes) f.notes = '1'; if (qIpms) f.qIpms = '1'; }
    const mf = MENU_FILTERS[tab];
    if (mf && menuFilter[tab]) f[mf.key] = menuFilter[tab];
    return f;
  }, [vcenterId, region, q, qNotes, qIpms, tab, menuFilter]);

  // Scope (region/vCenter) without the free-text query, used by Summary.
  const scope = useMemo(() => {
    const s = {};
    if (vcenterId) s.vcenterId = vcenterId;
    else if (region) s.region = region;
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vcenterId, region]);


  // 상단 필터바(리전·vCenter·이름 검색)를 쓰지 않는 탭 — 화면이 자체 필터를 갖거나 필터 대상이
  // 아닌 경우. 성능점검(svcmon)은 트리 검색·상태 칩·Test name 검색을 자체로 갖고 상단 필터값을
  // 받지도 않아(<SvcMonitor /> 는 filters 미전달) 상단 검색이 눌러도 아무 일이 없는 죽은 UI 였다.
  // IP관리(ipam)는 화면 안에 자체 vCenter 범위 선택자가 있어 상단 필터바를 쓰지 않는다.
  const noFilterTabs = ['overview', 'vcenters', 'summary', 'upgrade', 'tools', 'insights', 'settings', 'svcmon', 'codex-check', 'ipam'];
  const showFilters = !noFilterTabs.includes(tab);

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
            <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => { if (t.id === 'vcenters') setPlatformResetSeq((n) => n + 1); setTab(t.id); }}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="status-pill">
          {(() => {
            const total = health?.vcenters ?? 0;
            const conn = health?.vcentersConnected ?? 0;
            const pending = health?.vcentersPending ?? 0;      // 첫 수집 전/수집 중 — '불가' 아님
            const unreach = health?.vcentersUnreachable ?? 0;  // 실제 연결 실패
            const maint = health?.vcentersMaintenance ?? 0;    // 점검중 — '불가' 아님
            const allOk = total === 0 || conn + maint === total; // 점검중도 정상 취급(연결 실패 아님)
            const color = allOk ? 'var(--green)' : unreach > 0 ? 'var(--red)' : 'var(--amber)';
            // 상태 문구: 실제 불가만 빨간 '불가', 수집 전/중은 노란 '수집 중'.
            let tail = null;
            if (health && !allOk) {
              if (unreach > 0) tail = <span style={{ color: '#f87171', fontWeight: 700 }}> ({unreach} 불가{pending ? ` · ${pending} 수집중` : ''})</span>;
              else if (pending > 0) tail = <span style={{ color: '#fbbf24', fontWeight: 700 }}> ({pending} 수집중)</span>;
              else tail = <span style={{ color: '#fbbf24', fontWeight: 700 }}> ({total - conn - maint} 확인중)</span>;
            }
            return (
              <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                <span>
                  <span className="dot live" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
                  {health ? `${conn}/${total} vCenter` : '연결 중…'}
                  {health && (allOk ? <span style={{ color: '#4ade80', fontWeight: 700 }}> OK</span> : tail)}
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
              {/* scope.regions 가 지정된 사용자는 허용 리전만 선택 가능(데이터도 서버에서 동일 제한). */}
              {((user.scope?.regions?.length) ? REGIONS.filter((r) => user.scope.regions.includes(r)) : REGIONS)
                .map((r) => <option key={r} value={r}>{r}</option>)}
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
            <SearchBox placeholder="이름 / IP / OS 검색…" value={q} onChange={setQ} />
            <label className="flex gap" style={{ alignItems: 'center', fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer' }}
              title="체크하면 검색에 메모(Notes) 내용도 포함합니다. (기본: 미포함)">
              <input type="checkbox" checked={qNotes} onChange={(e) => setQNotes(e.target.checked)} /> 메모 포함
            </label>
            {['vms', 'networks', 'hosts', 'datastores'].includes(tab) && (
              <label className="flex gap" style={{ alignItems: 'center', fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer' }}
                title="체크하면 IP로 검색할 때 IPMS(IP 스캔) 자료의 해당 대역 IP도 함께 보여줍니다. (vCenter가 모르는 스캔 IP 포함)">
                <input type="checkbox" checked={qIpms} onChange={(e) => setQIpms(e.target.checked)} /> IPMS 포함
              </label>
            )}
            {(region || vcenterId || q || menuFilter[tab]) && (
              <button className="tab" onClick={() => { patchFilter({ region: '', vcenterId: '', q: '', qNotes: false, qIpms: false }); setMenuFilter((m) => ({ ...m, [tab]: '' })); }}>필터 초기화</button>
            )}
          </div>
        )}

        <ErrorBoundary key={tab}>
         <Suspense fallback={<div className="muted" style={{ padding: 24 }}>로딩 중…</div>}>
          {tab === 'overview' && <Overview onSelectSite={selectSite} onGotoTab={setTab} />}
          {tab === 'summary' && <Summary scope={scope} onGotoTab={setTab} />}
          {tab === 'vcenters' && <VCenters onSelectSite={selectSite} resetSignal={platformResetSeq} />}
          {tab === 'svcmon' && <SvcMonitor />}
          {tab === 'ipam' && <Ipam />}
          {tab === 'hosts' && <Hosts filters={filters} />}
          {tab === 'vms' && <Vms filters={filters} />}
          {tab === 'datastores' && <Datastores filters={filters} />}
          {tab === 'networks' && <Networks filters={filters} />}
          {tab === 'alarms' && <Alarms filters={filters} />}
          {tab === 'tools' && <SpecialTools />}
          {tab === 'insights' && <Insights onGotoTab={setTab} />}
          {tab === 'settings' && user.role === 'admin' && isOwner && <Settings />}
          {tab === 'upgrade' && user.role === 'admin' && health?.features?.upgradeTab && <Upgrade />}
          {tab === 'codex-check' && user.role === 'admin' && <CodexCheck />}
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
