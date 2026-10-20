import React, { useState, useEffect, useRef } from 'react';
import { usePolling } from '../api.js';
import { DataTable, Loading, ErrorBox, EntityDetail, GpuBadge } from '../components/ui.jsx';
import IpmsMatches from '../components/IpmsMatches.jsx';
import { unitText } from './unitText.js';
import { VM_PAGE_SIZE, vmPageQueryKey, resetNoticeText, pageNavState, vmPageSummary, vmPageSortNote, navView, navNext, navPrev, navFirst, navSync, navAfterError } from './vmPageText.js';
// v2.746 C안: '가상머신 상세' = 분포 4패널 + 선택 칩 + 표. 판정·문구는 vmDistText.js, 그리기는 VmDistPanels.jsx.
import { EMPTY_FACETS, facetParams, facetKey, hasFacet, clearFacet, chipList, facetErrorText, specText, specSort, selectionView } from './vmDistText.js';
import { VmDistPanels, VmDistChips, VmUsageBar, VmNameCell, VmMobileList, useNarrowScreen } from './VmDistPanels.jsx';

/** Render every IPv4 a VM has (multi-homed), one per line; IPv6 is excluded upstream. */
function ipList(vm) {
  const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
  if (!ips.length) return <span className="muted">—</span>;
  return ips.map((ip, i) => <div key={i}>{ip}</div>);
}


export default function Vms({ filters }) {
  const [selected, setSelected] = useState(null);
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
  const params = { ...filters, limit: VM_PAGE_SIZE, sortBy: 'cpuUsagePct', order: 'desc', paged: '1', dist: '1', ...facetParams(facets) };
  if (cursor) params.cursor = cursor;
  if (gpuOnly) params.gpu = '1';
  if (gpuType) { params.gpu = '1'; params.gpuType = gpuType; }
  const { data, error, loading } = usePolling('/vms', params, 15_000);
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
  const openVm = (v) => setSelected(v);
  // v2.746 C안 표 열 — 전원은 VM 이름 앞 점(색 + 글자), vCPU·RAM 은 한 칸(정렬은 vCPU 우선 그다음 메모리).
  //   CPU·메모리 막대는 이 화면 전용 VmUsageBar(공용 UsageCell 은 다른 화면이 쓰므로 바꾸지 않는다).
  const columns = [
    { key: 'name', label: 'VM', render: (v) => <VmNameCell vm={v} onOpen={openVm} /> },
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
  // v2.629(감사 WEB2629-01): 사용률을 수집하지 않은 구동 VM 은 평균에서 뺐다 — 그 개수를 밝힌다(조용한 제외 금지).
  const usageMeta = (miss) => (miss > 0 ? `구동중 VM 기준 · 사용률 미수집 ${fmt(miss)}대 제외` : '구동중 VM 기준');
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
          <div className="section-title" style={{ marginTop: 0 }}>글로벌 가상머신 요약</div>
          <div className="kpis" style={{ marginBottom: 12 }}>
            <div className="card kpi"><div className="label">전체 VM</div><div className="value">{fmt(t.count)}</div><div className="meta">구동중 {fmt(t.poweredOn)} · 정지 {fmt(t.poweredOff)}</div></div>
            <div className="card kpi"><div className="label">할당 vCPU / vCore</div><div className="value" style={{ color: 'var(--accent)' }}>{fmt(t.vcpu)}</div><div className="meta">vCPU {fmt(t.vcpu)} · vCore {fmt(t.vcpu)}</div></div>
            <div className="card kpi"><div className="label">평균 CPU 사용량</div><div className="value">{unitText(t.avgCpuUsagePct, '%')}</div><div className="meta">{usageMeta(t.usageUnknown?.cpu)}</div></div>
            <div className="card kpi"><div className="label">할당 메모리 합계</div><div className="value" style={{ color: 'var(--purple)' }}>{fmt(t.ramGB)}<small> GB</small></div><div className="meta">≈ {(t.ramGB / 1024).toFixed(1)} TB</div></div>
            <div className="card kpi"><div className="label">평균 메모리 사용률</div><div className="value">{unitText(t.avgMemUsagePct, '%')}</div><div className="meta">{usageMeta(t.usageUnknown?.mem)}</div></div>
            <div className="card kpi"><div className="label">할당 디스크 합계</div><div className="value" style={{ color: 'var(--accent-2)' }}>{fmt(t.diskTB)}<small> TB</small></div><div className="meta">{fmt(t.diskGB)} GB{t.storageUnknown ? ` · 용량 미상 ${fmt(t.storageUnknown)}대 제외` : ''}</div></div>
            <div className="card kpi"><div className="label">평균 디스크 사용률</div><div className="value">{unitText(t.avgDiskUsagePct, '%')}</div><div className="meta">프로비저닝 대비 사용</div></div>
            <div className="card kpi" role="button" tabIndex={0}
              style={{ cursor: 'pointer', outline: (gpuOnly || gpuType) ? '1px solid var(--green)' : 'none' }}
              title="클릭하면 GPU 할당 VM만 표시"
              onClick={() => { const n = !(gpuOnly || gpuType); setGpuOnly(n); if (!n) setGpuType(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const n = !(gpuOnly || gpuType); setGpuOnly(n); if (!n) setGpuType(''); } }}>
              <div className="label">GPU 할당 VM {(gpuOnly || gpuType) ? '✓' : '▸'}</div>
              <div className="value" style={{ color: 'var(--green)' }}>{fmt(g.total)}</div>
              <div className="meta">vGPU {fmt(g.vgpu)} · 패스쓰루 {fmt(g.passthrough)}{g.mixed ? ` · 혼합 ${fmt(g.mixed)}` : ''}</div>
            </div>
          </div>
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
            : <DataTable columns={columns} rows={rows} className="vmd-table" initialSort={{ key: 'cpuUsagePct', dir: 'desc' }} />}
          {rows.length > 30 && pager}
        </div>
      </section>

      <IpmsMatches filters={filters} />
      {selected && <EntityDetail type="vm" item={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
