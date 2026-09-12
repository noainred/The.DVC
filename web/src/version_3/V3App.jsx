/**
 * V3App — 신규 포탈(version_3) 셸(v2.490). 설정 › 신규 포탈 보기 › V3 버튼 또는 해시 #/v3/<page> 로 진입한다.
 *
 * Claude Design 'DVC Console.dc.html' 아트보드(좌측 8도메인 내비 236px · 상단 검색/범위/LIVE/사용자 · 6화면)를
 * 값 그대로 옮기고 데이터는 **실 API 만** 쓴다. 시안의 목업 수치(9 DC/12 vCenter 등)는 쓰지 않고, 수집 API 가 없는 항목
 * (백본 회선·계약 전력·펌웨어 기준선)은 '수집 없음' 으로 표시한다.
 *
 * 폴링은 여러 화면·사이드바 카운트·도메인 타일이 같은 원본을 읽도록 여기서 한 번만 돌리고(/overview·/alarms·/nsx·
 * /svcmon/state·/datastores·/tools/storage·/tools/pdu·/admin/idrac), 화면 전용 데이터는 각 페이지가 마운트될 때만 폴링한다.
 * 권한상 호출하지 않을 API 는 path 를 null 로 넘겨 403 을 만들지 않는다. 기존 개발 포탈(App.jsx)은 그대로 두고
 * 내비의 화면 없는 항목은 개발 포탈의 해당 탭으로 이동한다.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { usePolling, toolAllowed } from '../api.js';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import { hashSegments } from '../hooks/hashTab.js';
import './v3.css';
import { PAGE_IDS, PAGE_META, GROUP_TILE, visibleGroups } from './nav.js';
import { buildDomainTiles, severityCounts, siteRows, fmtInt, levelBar } from './data.js';
import Overview from './pages/Overview.jsx';
import Compute from './pages/Compute.jsx';
import Storage from './pages/Storage.jsx';
import Network from './pages/Network.jsx';
import Facility from './pages/Facility.jsx';
import Alarms from './pages/Alarms.jsx';

export const V3_HASH = '#/v3';
export const isV3Hash = (hash) => hashSegments(hash)[0] === 'v3';
export const pageFromHash = (hash) => { const s = hashSegments(hash); return s[0] === 'v3' && PAGE_IDS.includes(s[1]) ? s[1] : 'overview'; };

const PAGES = { overview: Overview, compute: Compute, storage: Storage, network: Network, facility: Facility, alarms: Alarms };

export default function V3App({ user, health, onExit }) {
  const [page, setPageState] = useState(() => pageFromHash(window.location.hash));
  const [q, setQ] = useState('');
  const [region, setRegion] = useState('');
  const [focusVc, setFocusVc] = useState('');
  useEffect(() => {
    const on = () => { if (isV3Hash(window.location.hash)) setPageState(pageFromHash(window.location.hash)); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (p, opts = {}) => {
    if (opts.vcenterId !== undefined) setFocusVc(opts.vcenterId || '');
    setPageState(p);
    window.location.hash = `${V3_HASH}/${p}`;
    window.scrollTo(0, 0);
  };

  const isAdmin = user?.role === 'admin';
  const ov = usePolling('/overview', {}, 15_000);
  const al = usePolling('/alarms', {}, 15_000);
  const nsx = usePolling('/nsx', {}, 30_000);
  const svc = usePolling('/svcmon/state', { limit: 1 }, 30_000);
  const ds = usePolling('/datastores', {}, 60_000);
  const canStorage = toolAllowed('storage-mon'), canPdu = toolAllowed('pdu');
  const stor = usePolling(canStorage ? '/tools/storage' : null, {}, 60_000);
  const pdu = usePolling(canPdu ? '/tools/pdu' : null, {}, 60_000);
  const idrac = usePolling(isAdmin ? '/admin/idrac' : null, {}, 60_000);

  const global = ov.data?.global || null;
  const sitesAll = useMemo(() => siteRows(ov.data?.sites), [ov.data]);
  const vcRegion = useMemo(() => Object.fromEntries(sitesAll.map((s) => [s.id, s.region])), [sitesAll]);
  const regions = useMemo(() => [...new Set(sitesAll.map((s) => s.region))].sort(), [sitesAll]);
  const inScope = (vcId) => (!region || vcRegion[vcId] === region) && (!focusVc || vcId === focusVc);
  const scope = useMemo(() => ({ q, region, focusVc, vcRegion, inScope, scoped: (list, key = 'vcenterId') => (list || []).filter((x) => inScope(x[key])) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, region, focusVc, vcRegion]);

  const alarmsAll = useMemo(() => al.data?.items || [], [al.data]);
  const dsOver = ds.data ? ds.data.items.filter((d) => d.usagePct >= 90).length : null;
  const tiles = useMemo(() => buildDomainTiles({
    global, alarms: alarmsAll, nsx: nsx.data, svcmon: svc.data, pdu: pdu.data, idracPoller: idrac.data?.poller || null,
    dsOver, storageDevices: stor.data ? stor.data.devices.length : null,
    permission: { idrac: isAdmin, pdu: canPdu },
  }), [global, alarmsAll, nsx.data, svc.data, pdu.data, idrac.data, dsOver, stor.data, isAdmin, canPdu]);
  const sev = severityCounts(alarmsAll);

  const counts = {
    hosts: fmtInt(global?.hosts), datastores: fmtInt(global?.datastores), networks: fmtInt(global?.networks), powerReporting: fmtInt(global?.powerReporting),
    alarms: al.data ? fmtInt(sev.total) : '', gpu: ov.data ? fmtInt(ov.data.gpuCards) : '', version: health?.version ? `v${health.version}` : '',
  };
  const groupLevel = (gid) => {
    const idx = GROUP_TILE[gid];
    if (!idx) return null;
    const lv = idx.map((i) => tiles[i]?.level).filter((v) => v != null);
    if (gid === 'monitoring') lv.push(sev.critical ? 2 : sev.warning ? 1 : 0);
    return lv.length ? Math.max(...lv) : null;
  };
  const groups = visibleGroups(user);
  const meta = PAGE_META[page] || PAGE_META.overview;
  const Page = PAGES[page] || Overview;
  const updated = health?.generatedAt ? new Date(health.generatedAt).toLocaleTimeString('ko-KR') : '—';
  const overviewSub = global ? `${fmtInt(sitesAll.length)}개 vCenter · 물리 서버 ${fmtInt(ov.data?.physical?.servers || global.hosts)} · VM ${fmtInt(global.vms)} · 15초 수집` : '수집 대기';
  const pageProps = {
    user, isAdmin, scope, go, global, ov: ov.data, sitesAll, alarmsAll, tiles,
    polls: { ov, al, nsx, svc, ds, stor, pdu, idrac }, perms: { storage: canStorage, pdu: canPdu, idrac: isAdmin },
  };
  const powerMw = global?.powerReporting ? `${(global.powerKw / 1000).toFixed(2)} MW` : '—';

  return (
    <div className="v3">
      <aside className="v3-side">
        <div className="v3-brand">
          <div className="v3-logo">V</div>
          <div><div className="v3-brand-title">The Davinci</div><div className="v3-brand-sub">GLOBAL OPS CONSOLE</div></div>
        </div>
        <nav className="v3-nav">
          {groups.map((g) => (
            <div className="v3-nav-group" key={g.id}>
              <div className="v3-nav-label"><span>{g.label}</span><i className="v3-dot" style={{ background: levelBar(groupLevel(g.id)) }} /></div>
              {g.items.map((it) => it.page ? (
                <button key={it.id} type="button" className={`v3-nav-item${page === it.id ? ' active' : ''}`} onClick={() => go(it.id)}>
                  <span className="v3-nav-name">{it.name}</span>
                  {it.count && <span className="v3-nav-count">{counts[it.count]}</span>}
                </button>
              ) : (
                <button key={it.id} type="button" className="v3-nav-item ext" title={`개발 포탈 ${it.hash} 로 이동`} onClick={() => onExit(it.hash)}>
                  <span className="v3-nav-name">{it.name}</span><span className="v3-nav-count">{it.count ? counts[it.count] : '↗'}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="v3-foot">
          <div className="v3-foot-row"><span>SERVERS</span><b>{fmtInt(ov.data?.physical?.servers || global?.hosts)}</b></div>
          <div className="v3-foot-row"><span>VMS</span><b>{fmtInt(global?.vms)}</b></div>
          <div className="v3-foot-row"><span>POWER</span><b style={{ color: '#b45309' }}>{powerMw}</b></div>
          <div className="v3-foot-row"><span>ALARMS</span><b style={{ color: sev.critical ? '#dc2626' : '#1a2130' }}>{al.data ? fmtInt(sev.total) : '—'}</b></div>
        </div>
      </aside>

      <div className="v3-main">
        <div className="v3-top">
          <label className="v3-search">
            <span className="v3-mono">⌕</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="호스트 / VM / IP / 시리얼 / 어레이 검색… (이 화면의 표·목록)" />
            {q ? <button type="button" className="v3-kbd" style={{ cursor: 'pointer' }} onClick={() => setQ('')}>지움</button> : <span className="v3-kbd">필터</span>}
          </label>
          <label className="v3-chip"><span>리전</span>
            <select value={region} onChange={(e) => { setRegion(e.target.value); setFocusVc(''); }}>
              <option value="">전체</option>
              {regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="v3-chip"><span>vCenter</span>
            <select value={focusVc} onChange={(e) => setFocusVc(e.target.value)}>
              <option value="">전체 {sitesAll.length}</option>
              {sitesAll.filter((s) => !region || s.region === region).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <span style={{ flex: 1 }} />
          <div className={`v3-live${health ? '' : ' down'}`} title="데이터 소스 · vCenter 연결 · 마지막 수집 시각">
            <i />{health ? `${health.vcentersConnected}/${health.vcenters} vCenter OK · ${updated}` : '연결 중…'}
          </div>
          <div className="v3-user">
            <div className="v3-avatar" title={user?.name}>{(user?.name || 'U').slice(0, 1).toUpperCase()}</div>
            <div><div className="v3-user-name">{user?.name}</div><div className="v3-user-role">{user?.role}</div></div>
          </div>
          <button type="button" className="v3-exit" onClick={() => onExit()} title="기존 개발 포탈 화면으로 돌아갑니다">개발 포탈 ↗</button>
        </div>

        <div className="v3-body">
          <div className="v3-head">
            <div>
              <div className="v3-crumb">{meta.crumb}</div>
              <div className="v3-title">{meta.title}</div>
            </div>
            <div className="v3-head-sub">
              {page === 'overview' ? overviewSub : meta.sub}
              {(region || focusVc) && <span> · 표·목록 범위: <b style={{ color: '#2563eb' }}>{focusVc ? (sitesAll.find((s) => s.id === focusVc)?.name || focusVc) : region}</b> (KPI·타일은 전사 기준)</span>}
            </div>
          </div>
          {ov.error && ov.data && <div className="v3-banner">갱신 실패(직전 데이터 표시 중): {ov.error}</div>}
          <ErrorBoundary key={page} fallback={<div className="v3-banner">이 화면을 표시하는 중 오류가 발생했습니다.</div>}>
            <Page {...pageProps} />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
