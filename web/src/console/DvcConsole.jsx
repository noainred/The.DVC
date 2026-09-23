/**
 * DvcConsole — 통합 관제 콘솔 셸(v2.487). 헤더의 데이터 소스 배지(LIVE/MOCK)를 눌러 진입하는 별도 화면.
 *
 * 디자인 핸드오프(Claude Design 'DVC Console.dc.html')의 좌측 8도메인 내비 + 6화면(전사 현황·컴퓨트·
 * 스토리지·네트워크·물리/설비·알람 센터)을 **실 API만으로** 구현한다 — 시안의 목업 수치(9 DC/12 vCenter 등)는
 * 쓰지 않고, 수집 API 가 없는 항목(사이트 간 백본 회선 사용률·계약 전력)은 표시하지 않는다.
 *
 * 폴링은 여러 화면·사이드바 카운트·도메인 타일이 같은 원본을 읽도록 여기서 한 번만 돌리고(전사·알람·NSX·
 * 성능점검·데이터스토어·스토리지·PDU·iDRAC), 화면 전용 데이터(/hosts·/tools/capacity 등)는 각 페이지가
 * 마운트될 때만 폴링한다. 권한상 호출하지 않을 API 는 path 를 null 로 넘겨 403 을 만들지 않는다.
 * 해시는 #/console/<page> — 새로고침해도 같은 화면에 머문다(App.jsx 가 'console' 첫 세그먼트를 콘솔로 해석).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { usePolling, toolAllowed, can } from '../api.js';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import { hashSegments } from '../hooks/hashTab.js';
import './console.css';
import { PAGE_IDS, PAGE_META, GROUP_TILE, visibleGroups } from './nav.js';
import { buildDomainTiles, severityCounts, siteRows, fmtInt } from './consoleData.js';
import { loadPhase, loadText } from '../version_4/loadState.js'; // v2.586 — 타일 대기 문구(순수 모듈, import 0)
import { levelColor } from './ui.jsx';
import ConsoleOverview from './pages/ConsoleOverview.jsx';
import ConsoleCompute from './pages/ConsoleCompute.jsx';
import ConsoleStorage from './pages/ConsoleStorage.jsx';
import ConsoleNetwork from './pages/ConsoleNetwork.jsx';
import ConsoleFacility from './pages/ConsoleFacility.jsx';
import ConsoleAlarms from './pages/ConsoleAlarms.jsx';

export const CONSOLE_HASH = '#/console';
export const isConsoleHash = (hash) => hashSegments(hash)[0] === 'console';
export const pageFromHash = (hash) => { const s = hashSegments(hash); return s[0] === 'console' && PAGE_IDS.includes(s[1]) ? s[1] : 'overview'; };

const PAGES = { overview: ConsoleOverview, compute: ConsoleCompute, storage: ConsoleStorage, network: ConsoleNetwork, facility: ConsoleFacility, alarms: ConsoleAlarms };

export default function DvcConsole({ user, health, onExit }) {
  const [page, setPageState] = useState(() => pageFromHash(window.location.hash));
  const [q, setQ] = useState('');          // 상단 검색 — 현재 화면의 표·목록을 클라이언트에서 거른다
  const [region, setRegion] = useState(''); // 리전 범위 — 표·목록에만 적용(KPI·타일은 전사 기준, 헤더에 명시)
  const [focusVc, setFocusVc] = useState('');
  useEffect(() => {
    const on = () => { if (isConsoleHash(window.location.hash)) setPageState(pageFromHash(window.location.hash)); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (p, opts = {}) => {
    if (opts.vcenterId !== undefined) setFocusVc(opts.vcenterId || '');
    setPageState(p);
    window.location.hash = `${CONSOLE_HASH}/${p}`;
    window.scrollTo(0, 0);
  };

  const isAdmin = user?.role === 'admin';
  const ov = usePolling('/overview', {}, 15_000);
  const al = usePolling('/alarms', {}, 15_000);
  const nsx = usePolling('/nsx', {}, 30_000);
  // svcmon 은 기능 권한 게이트(v2.506) 아래다 — 권한 없는 역할에 폴링을 걸면 30초마다 403 이고
  // usePolling 이 폴링을 끊은 뒤에도 타일이 '점검 상태 대기'(거짓 원인)로 남는다.
  const canSvcmon = can('svcmon');
  const svc = usePolling(canSvcmon ? '/svcmon/state' : null, { limit: 1 }, 30_000);
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
  const waitMeta = loadText(loadPhase({ health, poll: ov }), { health, pollError: ov.error }).short;
  const dsOver = ds.data ? ds.data.items.filter((d) => d.usagePct >= 90).length : null;
  const tiles = useMemo(() => buildDomainTiles({
    global, alarms: alarmsAll, nsx: nsx.data, svcmon: svc.data, pdu: pdu.data, idracPoller: idrac.data?.poller || null,
    dsOver, storageDevices: stor.data ? stor.data.devices.length : null,
    permission: { idrac: isAdmin, pdu: canPdu, svcmon: canSvcmon },
    waitMeta,
  }), [global, alarmsAll, nsx.data, svc.data, pdu.data, idrac.data, dsOver, stor.data, isAdmin, canPdu, canSvcmon, waitMeta]);
  const sev = severityCounts(alarmsAll);

  const counts = { hosts: fmtInt(global?.hosts), datastores: fmtInt(global?.datastores), networks: fmtInt(global?.networks), powerReporting: fmtInt(global?.powerReporting), alarms: al.data ? fmtInt(sev.total) : '' };
  const groupLevel = (gid) => {
    const idx = GROUP_TILE[gid];
    if (!idx) return null;
    const lv = idx.map((i) => tiles[i]?.level).filter((v) => v != null);
    if (gid === 'monitoring') lv.push(sev.critical ? 2 : sev.warning ? 1 : 0);
    return lv.length ? Math.max(...lv) : null;
  };
  const groups = visibleGroups(user);
  const meta = PAGE_META[page] || PAGE_META.overview;
  const Page = PAGES[page] || ConsoleOverview;
  const updated = health?.generatedAt ? new Date(health.generatedAt).toLocaleTimeString('ko-KR') : '—';
  const pageProps = {
    user, isAdmin, scope, go, global, ov: ov.data, sitesAll, alarmsAll, tiles,
    polls: { ov, al, nsx, svc, ds, stor, pdu, idrac }, perms: { storage: canStorage, pdu: canPdu, idrac: isAdmin },
  };

  return (
    <div className="dvc">
      <aside className="dvc-side">
        <div className="dvc-brand">
          <div className="dvc-logo">V</div>
          <div><div className="dvc-brand-title">The Davinci</div><div className="dvc-brand-sub">GLOBAL OPS CONSOLE</div></div>
        </div>
        <nav className="dvc-nav">
          {groups.map((g) => (
            <div className="dvc-nav-group" key={g.id}>
              <div className="dvc-nav-label"><span>{g.label}</span><i className="dvc-dot" style={{ background: levelColor(groupLevel(g.id)) }} /></div>
              {g.items.map((it) => it.page ? (
                <button key={it.id} className={`dvc-nav-item${page === it.id ? ' active' : ''}`} onClick={() => go(it.id)}>
                  <span className="dvc-nav-name">{it.name}</span>
                  {it.count && <span className="dvc-nav-count">{counts[it.count]}</span>}
                </button>
              ) : (
                <button key={it.id} className="dvc-nav-item ext" title={`개발 포탈 ${it.hash} 로 이동`} onClick={() => onExit(it.hash)}>
                  <span className="dvc-nav-name">{it.name}</span><span className="dvc-nav-count">↗</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="dvc-foot">
          <div className="dvc-foot-row"><span>VERSION</span><b>{health?.version ? `v${health.version}` : '—'}</b></div>
          <div className="dvc-foot-row"><span>SOURCE</span><b style={{ color: health?.source === 'live' ? '#16a34a' : '#d97706' }}>{(health?.source || '—').toUpperCase()}</b></div>
          <div className="dvc-foot-row"><span>VCENTER</span><b>{health ? `${health.vcentersConnected}/${health.vcenters}` : '—'}</b></div>
          <div className="dvc-foot-row"><span>UPDATED</span><b>{updated}</b></div>
        </div>
      </aside>

      <div className="dvc-main">
        <div className="dvc-top">
          <label className="dvc-search">
            <span className="dvc-mono">⌕</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="이 화면의 표 · 목록 검색 (이름 / 사이트 / 메시지)" />
            {q ? <button className="dvc-kbd" style={{ background: 'transparent', color: '#6b7280', cursor: 'pointer' }} onClick={() => setQ('')}>지움</button> : <span className="dvc-kbd">필터</span>}
          </label>
          <label className="dvc-chip"><span>리전</span>
            <select value={region} onChange={(e) => { setRegion(e.target.value); setFocusVc(''); }}>
              <option value="">전체</option>
              {regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="dvc-chip"><span>vCenter</span>
            <select value={focusVc} onChange={(e) => setFocusVc(e.target.value)}>
              <option value="">전체</option>
              {sitesAll.filter((s) => !region || s.region === region).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <span style={{ flex: 1 }} />
          <div className={`dvc-live${health ? '' : ' down'}`} title="데이터 소스 · 마지막 수집 시각">
            <i />{health ? `${String(health.source || '').toUpperCase()} · ${updated}` : '연결 중…'}
          </div>
          <div className="dvc-user">
            <div className="dvc-avatar" title={user?.name}>{(user?.name || 'U').slice(0, 1).toUpperCase()}</div>
            <div><div className="dvc-user-name">{user?.name}</div><div className="dvc-user-role">{user?.role}</div></div>
          </div>
          <button className="dvc-exit" onClick={() => onExit()} title="기존 개발 포탈 화면으로 돌아갑니다">개발 포탈 ↗</button>
        </div>

        <div className="dvc-body">
          <div className="dvc-head">
            <div>
              <div className="dvc-crumb">{meta.crumb} / {meta.group}</div>
              <div className="dvc-title">{meta.title}</div>
            </div>
            <div className="dvc-head-sub">
              {global ? `${fmtInt(global.vcenters)} vCenter · ${fmtInt(global.hosts)} 호스트 · ${fmtInt(global.vms)} VM` : '수집 대기'}
              {(region || focusVc) && <span> · 표·목록 범위: <b style={{ color: '#2563eb' }}>{focusVc ? (sitesAll.find((s) => s.id === focusVc)?.name || focusVc) : region}</b> (KPI·타일은 전사 기준)</span>}
            </div>
          </div>
          {ov.error && ov.data && <div className="dvc-banner">갱신 실패(직전 데이터 표시 중): {ov.error}</div>}
          <ErrorBoundary key={page} fallback={<div className="dvc-banner">이 화면을 표시하는 중 오류가 발생했습니다.</div>}>
            <Page {...pageProps} />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
