import React, { useState } from 'react';
import { usePolling } from '../api.js';
import { DataTable, UsageCell, StateBadge, Loading, ErrorBox, ResultCount, EntityDetail, GpuBadge } from '../components/ui.jsx';
import IpmsMatches from '../components/IpmsMatches.jsx';

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
  const params = { ...filters, limit: 1000 };
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

  return (
    <>
      {t && (
        <>
          <div className="section-title" style={{ marginTop: 0 }}>글로벌 가상머신 요약</div>
          <div className="kpis" style={{ marginBottom: 12 }}>
            <div className="card kpi"><div className="label">전체 VM</div><div className="value">{fmt(t.count)}</div><div className="meta">구동중 {fmt(t.poweredOn)} · 정지 {fmt(t.poweredOff)}</div></div>
            <div className="card kpi"><div className="label">할당 vCPU / vCore</div><div className="value" style={{ color: 'var(--accent)' }}>{fmt(t.vcpu)}</div><div className="meta">vCPU {fmt(t.vcpu)} · vCore {fmt(t.vcpu)}</div></div>
            <div className="card kpi"><div className="label">평균 CPU 사용량</div><div className="value">{t.avgCpuUsagePct}%</div><div className="meta">구동중 VM 기준</div></div>
            <div className="card kpi"><div className="label">할당 메모리 합계</div><div className="value" style={{ color: 'var(--purple)' }}>{fmt(t.ramGB)}<small> GB</small></div><div className="meta">≈ {(t.ramGB / 1024).toFixed(1)} TB</div></div>
            <div className="card kpi"><div className="label">평균 메모리 사용률</div><div className="value">{t.avgMemUsagePct}%</div><div className="meta">구동중 VM 기준</div></div>
            <div className="card kpi"><div className="label">할당 디스크 합계</div><div className="value" style={{ color: 'var(--accent-2)' }}>{fmt(t.diskTB)}<small> TB</small></div><div className="meta">{fmt(t.diskGB)} GB</div></div>
            <div className="card kpi"><div className="label">평균 디스크 사용률</div><div className="value">{t.avgDiskUsagePct ?? 0}%</div><div className="meta">프로비저닝 대비 사용</div></div>
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
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'cpuUsagePct', dir: 'desc' }} />

      <IpmsMatches filters={filters} />
      {selected && <EntityDetail type="vm" item={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
