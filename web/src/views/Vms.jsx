import React, { useState } from 'react';
import { usePolling } from '../api.js';
import { DataTable, UsageCell, StateBadge, Loading, ErrorBox, ResultCount, EntityDetail, GpuBadge } from '../components/ui.jsx';
import IpmsMatches from '../components/IpmsMatches.jsx';
import { unitText } from './unitText.js';

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
  // v2.631(감사 WEB2631-10): 서버 정렬 없이 limit 만 주면 스냅샷 순서(vCenter 순)의 앞 1000개가 온다 — 그것을
  //   '상위 1,000개' 라 말하면 거짓이다(뒤 vCenter 의 CPU 100% VM 이 빠진다). 표의 기본 정렬(CPU 사용률 내림차순)과
  //   같은 기준으로 서버가 고르게 하고, 다른 열 정렬은 그 안에서만이라는 사실을 표 위에 적는다.
  const VM_LIMIT = 1000;
  const params = { ...filters, limit: VM_LIMIT, sortBy: 'cpuUsagePct', order: 'desc' };
  if (gpuOnly) params.gpu = '1';
  if (gpuType) { params.gpu = '1'; params.gpuType = gpuType; }
  const { data, error, loading } = usePolling('/vms', params, 15_000);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />; // 데이터 보유 중 일시 폴링 오류는 화면 유지
  const rows = data?.items || [];

  const showGpuCol = gpuOnly || gpuType || rows.some((v) => v.gpu);
  const columns = [
    { key: 'name', label: 'VM', render: (v) => <button className="cell-link" onClick={() => setSelected(v)}>{v.name}</button> },
    { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
    { key: 'powerState', label: '전원', render: (v) => <StateBadge state={v.powerState} /> },
    { key: 'guestOS', label: 'Guest OS' },
    { key: 'ipAddress', label: 'IP', render: (v) => ipList(v) },
    { key: 'cpuCount', label: 'vCPU', align: 'right' },
    { key: 'memMB', label: 'RAM', align: 'right', render: (v) => (Number.isFinite(v.memMB) ? `${Math.round(v.memMB / 1024)} GB` : '—') },
    ...(showGpuCol ? [{ key: 'gpu', label: 'GPU', sortValue: (v) => v.gpu?.type || '', render: (v) => <GpuBadge gpu={v.gpu} /> }] : []),
    { key: 'cpuUsagePct', label: 'CPU', render: (v) => <UsageCell pct={v.cpuUsagePct} /> },
    { key: 'memUsagePct', label: '메모리', render: (v) => <UsageCell pct={v.memUsagePct} /> },
    { key: 'storageGB', label: '디스크', align: 'right', render: (v) => (v.storageGB != null ? `${v.storageGB} GB` : '—') },
    { key: 'host', label: '호스트', render: (v) => <span className="muted">{v.host}</span> },
  ];

  const t = data.totals;
  const g = t?.gpu || { total: 0, vgpu: 0, passthrough: 0, mixed: 0 };
  const fmt = (n) => (n ?? 0).toLocaleString('en-US');
  // v2.629(감사 WEB2629-01): 사용률을 수집하지 않은 구동 VM 은 평균에서 뺐다 — 그 개수를 밝힌다(조용한 제외 금지).
  const usageMeta = (miss) => (miss > 0 ? `구동중 VM 기준 · 사용률 미수집 ${fmt(miss)}대 제외` : '구동중 VM 기준');

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
            <div className="card kpi"><div className="label">할당 디스크 합계</div><div className="value" style={{ color: 'var(--accent-2)' }}>{fmt(t.diskTB)}<small> TB</small></div><div className="meta">{fmt(t.diskGB)} GB</div></div>
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
          <div className="section-title">가상머신 상세</div>
        </>
      )}
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
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
      <ResultCount total={data.total} shown={rows.length} label="VM" filtered={Object.keys(filters || {}).length > 0 || gpuOnly || !!gpuType} />
      {data.total > rows.length && (
        <div className="muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 10 }}>
          CPU 사용률 높은 순으로 {rows.length.toLocaleString('en-US')}개만 받았습니다 — 다른 열로 정렬하면 이 {rows.length.toLocaleString('en-US')}개 안에서만 정렬됩니다(나머지 {(data.total - rows.length).toLocaleString('en-US')}개는 필터로 좁혀 보세요).
        </div>
      )}
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'cpuUsagePct', dir: 'desc' }} />

      <IpmsMatches filters={filters} />
      {selected && <EntityDetail type="vm" item={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
