import React, { useState, useEffect, useRef } from 'react';
import { usePolling } from '../api.js';
import { DataTable, Loading, ErrorBox, GpuBadge } from '../components/ui.jsx';
import IpmsMatches from '../components/IpmsMatches.jsx';
import { unitText } from './unitText.js';
import { VM_PAGE_SIZE, vmPageQueryKey, resetNoticeText, pageNavState, vmPageSummary, vmPageSortNote, navView, navNext, navPrev, navFirst, navSync, navAfterError } from './vmPageText.js';
// v2.746 C안: '가상머신 상세' = 분포 4패널 + 선택 칩 + 표. 판정·문구는 vmDistText.js, 그리기는 VmDistPanels.jsx.
import { EMPTY_FACETS, facetParams, facetKey, hasFacet, clearFacet, chipList, facetErrorText, specText, specSort, selectionView } from './vmDistText.js';
import { VmDistPanels, VmDistChips, VmUsageBar, VmNameCell, VmMobileList, useNarrowScreen } from './VmDistPanels.jsx';
// v2.909 가상화 서버 허브(시안 docs/design/vm-screen 시안 1): 탭(현황 · 법인별 · 조치 필요 ‖ VM 도구 6) · 타일 5장 · 신호 열 · 드로어.
import VmHubTabs from './vms/VmHubTabs.jsx';
import VmDrawer from './vms/VmDrawer.jsx';
import { HUB_VIEW_KEYS, signalText, usageTone, TONE_COLOR, barW } from './vms/vmHubText.js';
import { tabFromHash, isUnderBase } from '../hooks/hashTab.js';
import { currentHash, goHash } from './vcd/vcdRoute.js';
import './vms/vmHub.css';

const VmsByCorp = React.lazy(() => import('./vms/VmsByCorp.jsx'));
const VmsAttention = React.lazy(() => import('./vms/VmsAttention.jsx'));
const HUB_BASE = ['vms'];

/** Render every IPv4 a VM has (multi-homed), one per line; IPv6 is excluded upstream. */
function ipList(vm) {
  const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
  if (!ips.length) return <span className="muted">—</span>;
  return ips.map((ip, i) => <div key={i}>{ip}</div>);
}


/**
 * v2.909: 허브 보기 — #/vms/<list|corp|attention>. 브라우저가 아닌 곳(렌더 시험)에서도 던지지 않는다(currentHash).
 * useHashTab 과 같은 규약(base 아래의 해시 변화만 받는다)이지만 window 가 없는 렌더 시험을 위해 이 화면 안에 둔다.
 */
function useHubView() {
  const [view, setView] = useState(() => tabFromHash(currentHash(), HUB_BASE, HUB_VIEW_KEYS) || 'list');
  useEffect(() => {
    const onHash = () => { const h = currentHash(); if (isUnderBase(h, HUB_BASE)) setView(tabFromHash(h, HUB_BASE, HUB_VIEW_KEYS) || 'list'); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return view;
}

/** 가상화 서버 화면 셸 — 머리 · 탭 · 보기 전환 · VM 드로어(현황·조치 필요 공용). onPickVcenter = 위 필터 바의 vCenter 를 바꾼다(App). */
export default function Vms({ filters, onPickVcenter }) {
  const view = useHubView();
  const [drawer, setDrawer] = useState(null);       // 열린 VM(드로어) — 목록이 바뀌어도 연 순간의 값을 보여 준다(넘기면 새 값)
  const rowsRef = useRef([]);                        // 지금 화면에 그린 행(정렬 반영 — DataTable onVisible) → 드로어 ‹ › 순서
  const [hub, setHub] = useState({ sc: null, snapAt: null });
  const open = (vm, rows) => { if (rows) rowsRef.current = rows; setDrawer(vm); };
  const onVisible = (rows) => { rowsRef.current = rows; };
  const sc = hub.sc;
  return (
    <div className="vmh">
      <header className="vmh-head">
        <h1>가상화 서버</h1>
        <span className="vmh-sub">vCenter 가 보고한 VM · 이름 · IP · OS 검색은 위 필터 바에서 합니다</span>
        {hub.snapAt && <span className="vmh-snap" title="이 화면 값의 기준(인벤토리 스냅샷 시각)">스냅샷 {new Date(hub.snapAt).toLocaleTimeString('ko-KR')}</span>}
      </header>
      <VmHubTabs active={view} attention={sc ? sc.any : null} />
      {view === 'list' && <VmsList filters={filters} onOpen={open} onVisible={onVisible} onHub={setHub} selectedId={drawer?.id} />}
      {view === 'corp' && (
        <React.Suspense fallback={<Loading />}>
          <VmsByCorp filters={filters} onPick={(id) => { if (onPickVcenter) onPickVcenter(id); goHash('#/vms/list'); }} />
        </React.Suspense>
      )}
      {view === 'attention' && (
        <React.Suspense fallback={<Loading />}>
          <VmsAttention filters={filters} onOpen={open} onVisible={onVisible} />
        </React.Suspense>
      )}
      {drawer && <VmDrawer vm={drawer} rows={rowsRef.current} onClose={() => setDrawer(null)} onMove={(vm) => setDrawer(vm)} days={sc?.snapAgeDays ?? null} />}
    </div>
  );
}

function VmsList({ filters, onOpen, onVisible, onHub, selectedId }) {
  const [gpuOnly, setGpuOnly] = useState(false);
  const [gpuType, setGpuType] = useState(''); // '' | vgpu | passthrough | mixed
  // v2.746 C안: 분포 패널에서 고른 구간(cpuBin·memBin·power·osName) — 이 화면 안 상태다. GPU 칸은 새 상태를 만들지 않고
  //   위 gpuOnly·gpuType(KPI GPU 카드와 같은 상태)을 그대로 쓴다. 위 KPI 8장은 패널 선택과 무관하다(서버가 그렇게 센다).
  const [facets, setFacets] = useState(EMPTY_FACETS);
  const narrow = useNarrowScreen();
  // v2.631(감사 WEB2631-10): 서버 정렬 없이 limit 만 주면 스냅샷 순서(vCenter 순)의 앞 1000개가 온다 — 그것을
  //   '상위 1,000개' 라 말하면 거짓이다(뒤 vCenter 의 CPU 100% VM 이 빠진다). 표의 기본 정렬(CPU 사용률 내림차순)과
  //   같은 기준으로 서버가 고르게 하고, 다른 열 정렬은 그 안에서만이라는 사실을 표 위에 적는다.
  // v2.730(검토 I-02): 상한 뒤의 VM 은 서버 페이지(paged=1 → nextCursor)로 이어 받는다 — 전량을 한 번에 그리지 않는다.
  //   커서 스택은 필터·GPU·패널 선택이 바뀌면 버린다(다른 조건의 커서는 서버가 400 으로 거절한다). 판정·문구는 vmPageText.js.
  const queryKey = vmPageQueryKey(filters, gpuOnly, gpuType, facets);
  const baseKey = vmPageQueryKey(filters, gpuOnly, gpuType);
  const fKey = facetKey(facets);
  const [nav, setNav] = useState(() => navFirst(queryKey));
  const { stack, notice } = navView(nav, queryKey);
  const cursor = stack.length ? stack[stack.length - 1] : null;
  // v2.909: signals=1 — 항목별 신호(표 '신호' 열 · 드로어)와 신호 개수(탭 배지 · '조치 필요' 줄). 판정은 서버(inventory/vmSignals.js).
  const params = { ...filters, limit: VM_PAGE_SIZE, sortBy: 'cpuUsagePct', order: 'desc', paged: '1', dist: '1', signals: '1', ...facetParams(facets) };
  if (cursor) params.cursor = cursor;
  if (gpuOnly) params.gpu = '1';
  if (gpuType) { params.gpu = '1'; params.gpuType = gpuType; }
  const { data, error, loading } = usePolling('/vms', params, 15_000);
  // 셸(탭 배지 · 스냅샷 시각 · 드로어 기준 일수)에 신호 개수를 올린다 — 새 응답이 올 때만.
  // v2.909: 드로어 ‹ › 순서 — 표가 그린 행(정렬 반영). 훅은 조기 return 위(React #310 규칙).
  const shownRef = useRef([]);
  const sigCounts = data?.signalCounts || null;
  const snapAt = data?.snapshotAt || null;
  useEffect(() => { if (data && onHub) onHub({ sc: sigCounts, snapAt }); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  // 패널을 누르면 요청 조건이 바뀌어 usePolling 이 직전 응답을 비운다. 그때마다 화면 전체를 '불러오는 중' 으로 바꾸면
  //   막대를 누를 때마다 화면이 접혔다 펴진다. 필터·GPU 가 같고 **패널 선택만** 바뀐 동안에만 직전 응답을 흐리게 두고
  //   '선택을 반영하는 중' 이라 말한다(KPI 는 패널 선택과 무관해 그대로 맞는 값이다). 그 밖의 변경은 예전처럼 Loading.
  //   ⚠ 조건 키는 '새 응답이 도착한 렌더' 에서만 적는다 — 선택을 바꾼 직후 한 렌더는 usePolling 이 아직 이전 조건의
  //   응답을 들고 있으므로(비우기는 그 뒤 effect 에서 한다) 그때 지금 키를 적으면 이전 응답이 새 조건의 것으로 기록된다.
  //   ⚠ 흐리게 보이는 응답은 이전 선택의 것이다 — 그 응답의 다음 페이지 커서·칩 개수는 지금 선택에 쓰지 않는다(current).
  //   예전에는 흐림 중에도 '다음 페이지' 가 켜져 이전 조건의 커서를 새 선택에 붙여 보냈고, 서버의 400 을 받은 화면이
  //   '페이지 정보를 읽지 못해 첫 페이지로' 라는 틀린 원인을 말했다(W-R1·C-01). 판정은 vmDistText.selectionView 하나.
  const lastRef = useRef(null);
  if (data && lastRef.current?.data !== data) lastRef.current = { data, baseKey, fKey };
  const { view, pendingSel, current } = selectionView({ data, loading, last: lastRef.current, baseKey, fKey });
  // 순서 기억 만료(409)·커서 거절(400)은 장애가 아니다 — 첫 페이지로 돌아가고 그 사실을 말한다.
  const reset = navAfterError(nav, queryKey, error);
  useEffect(() => {
    if (reset) setNav(reset);
  }, [reset?.notice, reset?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  // 조건이 바뀌면 쪽 번호 기록을 비운다 — 되돌아왔을 때 예전 쪽으로 가지 않고 1페이지부터 보이게(navSync).
  useEffect(() => { setNav((n) => navSync(n, queryKey)); }, [queryKey]);
  const setFacet = (key, value) => setFacets((f) => ({ ...f, [key]: value }));
  const clearAllSel = () => { setFacets(EMPTY_FACETS); setGpuOnly(false); setGpuType(''); };
  if (reset) return <Loading />;
  if (loading && !view) return <Loading />;
  if (error && !view) {
    // 데이터 보유 중 일시 폴링 오류는 화면 유지(아래 배너). 고른 구간이 있으면 해제할 길을 함께 준다(400 bad-facet 포함).
    const fe = facetErrorText(error);
    return (
      <>
        <ErrorBox message={error} />
        {(fe || hasFacet(facets)) && (
          <div className="flex gap wrap" style={{ alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <span className="muted" style={{ whiteSpace: 'normal' }}>{fe || '분포 패널에서 고른 구간이 있습니다 — 해제하고 다시 볼 수 있습니다.'}</span>
            <button type="button" className="tab" style={{ flex: 'none', padding: '6px 11px' }} onClick={() => setFacets(EMPTY_FACETS)}>고른 구간 모두 해제</button>
          </div>
        )}
      </>
    );
  }
  const rows = view?.items || [];
  const navState = pageNavState(stack, current ? view : null);
  const pageSum = vmPageSummary(view);
  const sortNote = vmPageSortNote(view);
  const goFirst = () => setNav(navFirst(queryKey));
  const goPrev = () => setNav(navPrev(nav, queryKey));
  const goNext = () => { if (navState.nextCursor) setNav(navNext(nav, queryKey, navState.nextCursor)); };
  const btnStyle = (on) => ({ flex: 'none', padding: '6px 11px', opacity: on ? 1 : 0.45, cursor: on ? 'pointer' : 'default' });
  const pager = (navState.canPrev || navState.canNext) ? (
    <div className="flex gap wrap" style={{ alignItems: 'center', flexWrap: 'wrap', margin: '6px 0 10px' }}>
      <button className="tab" style={btnStyle(navState.canFirst)} disabled={!navState.canFirst} onClick={goFirst}>⏮ 처음</button>
      <button className="tab" style={btnStyle(navState.canPrev)} disabled={!navState.canPrev} onClick={goPrev}>◀ 이전 페이지</button>
      <span className="muted" style={{ fontSize: 12 }}>{navState.pageNo.toLocaleString('en-US')}페이지</span>
      <button className="tab" style={btnStyle(navState.canNext)} disabled={!navState.canNext} onClick={goNext}
        title={navState.canNext ? '서버에서 다음 페이지를 불러옵니다' : '더 불러올 VM 이 없습니다'}>다음 페이지 불러오기 ▶</button>
    </div>
  ) : null;

  const showGpuCol = gpuOnly || gpuType || rows.some((v) => v.gpu);
  // v2.909: VM 을 누르면 드로어(셸) — ‹ › 순서는 지금 그린 행(표는 정렬 반영 onVisible · 좁은 화면 목록은 받은 순서).
  const openVm = (v) => onOpen(v, narrow ? rows : shownRef.current);
  const onShown = (r) => { shownRef.current = r; if (onVisible) onVisible(r); };
  const days = sigCounts?.snapAgeDays ?? null;
  const hasSig = rows.some((v) => Array.isArray(v.signals));
  // v2.746 C안 표 열 — 전원은 VM 이름 앞 점(색 + 글자), vCPU·RAM 은 한 칸(정렬은 vCPU 우선 그다음 메모리).
  //   CPU·메모리 막대는 이 화면 전용 VmUsageBar(공용 UsageCell 은 다른 화면이 쓰므로 바꾸지 않는다).
  const columns = [
    { key: 'name', label: 'VM', render: (v) => <VmNameCell vm={v} onOpen={openVm} /> },
    // v2.909: 신호(서버 판정 inventory/vmSignals.js — signals=1 일 때만 실린다. 구버전 서버면 열을 그리지 않는다).
    //   VM 바로 뒤에 둔다 — 이 표는 1440 에서도 오른쪽 열(디스크·호스트)이 가로 스크롤 밖이라(v2.898 부터 · A/B 확인) 끝에 두면 보이지 않았다.
    ...(hasSig ? [{ key: 'signals', label: '신호', sortValue: (v) => (v.signals || []).length, render: (v) => (
      <span className="vmh-sig">{(v.signals || []).map((k) => { const x = signalText(k, { days }); return <span key={k} className={`vmh-badge ${x.badge}`} title={x.desc}>{x.short}</span>; })}</span>
    ) }] : []),
    { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
    { key: 'guestOS', label: 'Guest OS' },
    { key: 'ipAddress', label: 'IP', render: (v) => ipList(v) },
    { key: 'spec', label: 'vCPU · RAM', align: 'right', sortValue: specSort, render: (v) => <span className="tabular">{specText(v)}</span> },
    ...(showGpuCol ? [{ key: 'gpu', label: 'GPU', sortValue: (v) => v.gpu?.type || '', render: (v) => <GpuBadge gpu={v.gpu} /> }] : []),
    { key: 'cpuUsagePct', label: 'CPU', render: (v) => <VmUsageBar pct={v.cpuUsagePct} /> },
    { key: 'memUsagePct', label: '메모리', render: (v) => <VmUsageBar pct={v.memUsagePct} /> },
    { key: 'storageGB', label: '디스크', align: 'right', render: (v) => (v.storageGB != null ? `${v.storageGB} GB` : '—') },
    { key: 'host', label: '호스트', render: (v) => <span className="muted">{v.host}</span> },
  ];

  const t = view.totals;
  const g = t?.gpu || { total: 0, vgpu: 0, passthrough: 0, mixed: 0 };
  const fmt = (n) => (n ?? 0).toLocaleString('en-US');
  // v2.629(감사 WEB2629-01): 사용률을 수집하지 않은 구동 VM 은 평균에서 뺐다 — 그 개수를 타일에 밝힌다(조용한 제외 금지).
  const dist = view.dist && typeof view.dist === 'object' ? view.dist : null;
  // 칩 개수는 지금 선택으로 받은 분포에서만 센다 — 흐림 중(직전 응답)에는 개수 없이 라벨만(W-R4).
  const chips = chipList(facets, current ? dist : null, { gpuOnly, gpuType });
  const filtered = Object.keys(filters || {}).length > 0 || gpuOnly || !!gpuType || hasFacet(facets);
  const onClearChip = (key) => {
    if (key === 'gpu') { setGpuOnly(false); setGpuType(''); } else setFacets((f) => clearFacet(f, key));
  };
  const onGpu = (next) => { setGpuOnly(!!next.gpuOnly); setGpuType(next.gpuType || ''); };

  return (
    <>
      {/* 데이터 보유 중 폴링이 지속 실패하면 낡은 데이터를 무경고로 계속 보여주지 않고 배너로 알린다
          (v2.287, 확정 버그 #20 — 죽은 VM 을 '구동중'으로 오인 방지). 여기선 data 가 있는 상태다. */}
      {error && <div className="badge red" style={{ display: 'block', marginBottom: 10, padding: '6px 10px' }}>⚠ 갱신 실패 — 직전 데이터를 표시 중입니다({error}).</div>}
      {t && (
        <>
          {/* v2.909(시안 ② 타일 5장): 예전 KPI 8장의 값을 묶었다 — 빠진 값 없음(vCore 는 vCPU 와 같은 값이라 한 줄). 값은 unitText(못 읽으면 '—'). */}
          <div className="section-title" style={{ marginTop: 0, fontSize: 13, color: 'var(--text-dim)' }}>글로벌 가상머신 요약</div>
          <section className="vmh-tiles" aria-label="요약" style={{ marginBottom: 12 }}>
            <div className="vmh-tile">
              <div className="lb"><span>전체 VM</span>{sigCounts && sigCounts.any > 0 && <a href="#/vms/attention" style={{ fontSize: 12 }}>조치 필요 {fmt(sigCounts.any)} ▸</a>}</div>
              <div className="val">{fmt(t.count)}</div>
              <div className="vmh-bar" aria-hidden="true"><i style={{ width: `${t.count ? Math.round((t.poweredOn / t.count) * 100) : 0}%`, background: 'var(--green)' }} /></div>
              <div className="sub"><span>구동중 {fmt(t.poweredOn)}</span><span>정지 {fmt(t.poweredOff)}</span></div>
            </div>
            <div className="vmh-tile">
              <div className="lb"><span>평균 CPU 사용량</span><small>구동중 VM 기준</small></div>
              <div className="val" style={{ color: TONE_COLOR[usageTone(t.avgCpuUsagePct)] === 'var(--text-faint)' ? undefined : 'var(--accent)' }}>{unitText(t.avgCpuUsagePct, '%')}</div>
              <div className="vmh-bar" aria-hidden="true"><i style={{ width: `${barW(t.avgCpuUsagePct)}%`, background: TONE_COLOR[usageTone(t.avgCpuUsagePct)] }} /></div>
              <div className="sub"><span>할당 vCPU {fmt(t.vcpu)}</span>{t.usageUnknown?.cpu > 0 && <span>사용률 미수집 {fmt(t.usageUnknown?.cpu)}대 제외</span>}</div>
            </div>
            <div className="vmh-tile">
              <div className="lb"><span>평균 메모리 사용률</span><small>구동중 VM 기준</small></div>
              <div className="val" style={{ color: TONE_COLOR[usageTone(t.avgMemUsagePct)] === 'var(--text-faint)' ? undefined : 'var(--purple)' }}>{unitText(t.avgMemUsagePct, '%')}</div>
              <div className="vmh-bar" aria-hidden="true"><i style={{ width: `${barW(t.avgMemUsagePct)}%`, background: TONE_COLOR[usageTone(t.avgMemUsagePct)] === 'var(--accent)' ? 'var(--purple)' : TONE_COLOR[usageTone(t.avgMemUsagePct)] }} /></div>
              <div className="sub"><span>할당 {fmt(t.ramGB)} GB ≈ {(t.ramGB / 1024).toFixed(1)} TB</span>{t.usageUnknown?.mem > 0 && <span>사용률 미수집 {fmt(t.usageUnknown?.mem)}대 제외</span>}</div>
            </div>
            <div className="vmh-tile">
              <div className="lb"><span>평균 디스크 사용률</span><small>프로비저닝 대비</small></div>
              <div className="val" style={{ color: 'var(--accent-2)' }}>{unitText(t.avgDiskUsagePct, '%')}</div>
              <div className="vmh-bar" aria-hidden="true"><i style={{ width: `${barW(t.avgDiskUsagePct)}%`, background: 'var(--accent-2)' }} /></div>
              <div className="sub"><span>할당 {fmt(t.diskTB)} TB</span>{t.storageUnknown ? <span>용량 미상 {fmt(t.storageUnknown)}대 제외</span> : null}</div>
            </div>
            <button type="button" className="vmh-tile btn" aria-pressed={!!(gpuOnly || gpuType)} title="누르면 GPU 할당 VM 만 표시"
              onClick={() => { const n = !(gpuOnly || gpuType); setGpuOnly(n); if (!n) setGpuType(''); }}>
              <span className="lb"><span>GPU 할당 VM {(gpuOnly || gpuType) ? '✓' : '▸'}</span><small>누르면 거르기</small></span>
              <span className="val" style={{ color: 'var(--green)' }}>{fmt(g.total)}</span>
              <span className="vmh-seg" aria-hidden="true">
                <i style={{ width: `${g.total ? (g.vgpu / g.total) * 100 : 0}%`, background: 'var(--green)' }} />
                <i style={{ width: `${g.total ? (g.passthrough / g.total) * 100 : 0}%`, background: 'var(--mint)' }} />
                <i style={{ width: `${g.total ? ((g.mixed || 0) / g.total) * 100 : 0}%`, background: 'var(--amber)' }} />
              </span>
              <span className="sub"><span>vGPU {fmt(g.vgpu)}</span><span>패스쓰루 {fmt(g.passthrough)}</span>{g.mixed ? <span>혼합 {fmt(g.mixed)}</span> : null}</span>
            </button>
          </section>
        </>
      )}
      <section className={`vmd${pendingSel ? ' pending' : ''}`} aria-busy={pendingSel || undefined}>
        <div className="vmd-head">
          <div className="vmd-title">
            <h2>가상머신 상세</h2>
            <span className="vmd-pill">{fmt(view.total)}대</span>
            {filtered && <span className="badge blue">필터 적용 중</span>}
            {pendingSel && <span className="vmd-busy" role="status">선택을 반영하는 중…</span>}
          </div>
          <span className="vmd-head-note">이름·IP·OS 검색은 위 필터 바에서 합니다</span>
        </div>
        <VmDistPanels dist={dist} facets={facets} onFacet={setFacet} gpuSel={{ gpuOnly, gpuType }} onGpu={onGpu} />
        {!dist && (
          // 분포 집계가 없는 응답(구버전 서버)에서도 GPU 선택은 그대로 쓸 수 있게 예전 버튼 줄을 남긴다.
          <div className="flex gap wrap" style={{ alignItems: 'center', padding: '10px 24px 0' }}>
            <button className={gpuOnly || gpuType ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 13px' }}
              onClick={() => { const n = !(gpuOnly || gpuType); setGpuOnly(n); if (!n) setGpuType(''); }}>
              🎮 GPU 할당 VM만 보기 {(gpuOnly || gpuType) ? '✓' : ''}
            </button>
            {(gpuOnly || gpuType) && [['', '전체'], ['vgpu', 'vGPU'], ['passthrough', '패스쓰루'], ...(g.mixed ? [['mixed', '혼합']] : [])].map(([k, l]) => (
              <button key={k || 'all'} className={gpuType === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 11px' }}
                onClick={() => { setGpuType(k); setGpuOnly(true); }}>
                {l} <b style={{ opacity: 0.7 }}>{k === 'vgpu' ? g.vgpu : k === 'passthrough' ? g.passthrough : k === 'mixed' ? g.mixed : g.total}</b>
              </button>
            ))}
          </div>
        )}
        <VmDistChips chips={chips} onClear={onClearChip} onClearAll={clearAllSel} />
        <div className="vmd-body">
          {notice && <div className="badge amber" style={{ display: 'block', marginBottom: 8, padding: '6px 10px', whiteSpace: 'normal' }}>{resetNoticeText(notice)}</div>}
          <div className="muted" style={{ fontSize: 12, marginBottom: 6, whiteSpace: 'normal' }}>
            <div>{pageSum.head}</div>
            {pageSum.notes.map((n) => <div key={n}>{n}</div>)}
            {/* 좁은 화면에는 표(열 머리 정렬)가 없다 — 목록은 서버 순서 그대로다(W-R5). 넓은 화면 문장은 v2.631 테스트가 고정한다. */}
            {sortNote && <div>{sortNote} {narrow ? '목록은 이 순서 그대로 보여 줍니다.' : '표의 다른 열로 정렬하면 이 페이지 안에서만 정렬됩니다.'}</div>}
          </div>
          {pager}
          {narrow
            ? <VmMobileList rows={rows} onOpen={openVm} />
            : <DataTable columns={columns} rows={rows} className="vmd-table" initialSort={{ key: 'cpuUsagePct', dir: 'desc' }} onVisible={onShown}
              rowStyle={(r) => (selectedId && r.id === selectedId ? { background: 'var(--vmh-sel-bg)' } : undefined)} />}
          {rows.length > 30 && pager}
        </div>
      </section>

      <IpmsMatches filters={filters} />
    </>
  );
}
