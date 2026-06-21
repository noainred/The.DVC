import React, { useState } from 'react';
import { usePolling } from '../api.js';
import { DataTable, UsageCell, StateBadge, Loading, ErrorBox, ResultCount, Modal } from '../components/ui.jsx';
import { VmMetricButton } from '../components/VmMetrics.jsx';
import { VmConsoleButton } from '../components/VmConsole.jsx';
import { VmRemoteButton } from '../components/VmRemote.jsx';

/** Render every IPv4 a VM has (multi-homed), one per line; IPv6 is excluded upstream. */
function ipList(vm) {
  const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
  if (!ips.length) return <span className="muted">—</span>;
  return ips.map((ip, i) => <div key={i}>{ip}</div>);
}

const GPU_TYPE = { vgpu: ['vGPU', 'green'], passthrough: ['패스쓰루', 'amber'], mixed: ['혼합', 'purple'] };
function GpuBadge({ gpu }) {
  if (!gpu) return <span className="muted">—</span>;
  const [label, cls] = GPU_TYPE[gpu.type] || ['GPU', 'gray'];
  return (
    <span className={`badge ${cls}`} title={gpu.profile || gpu.model || ''}>
      {label}{gpu.count > 1 ? ` ×${gpu.count}` : ''}{gpu.profile ? ` · ${gpu.profile}` : ''}
    </span>
  );
}

function DetailRow({ label, children }) {
  return (
    <div className="flex between" style={{ padding: '8px 0', borderBottom: '1px solid rgba(36,48,73,.4)', gap: 16 }}>
      <span className="muted">{label}</span>
      <span style={{ textAlign: 'right', wordBreak: 'break-all' }}>{children}</span>
    </div>
  );
}

function VmDetail({ vm, onClose }) {
  return (
    <Modal title={`VM 상세 — ${vm.name}`} onClose={onClose} width={620}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
        <DetailRow label="이름"><b>{vm.name}</b></DetailRow>
        <DetailRow label="전원"><StateBadge state={vm.powerState} /></DetailRow>
        <DetailRow label="vCenter">{vm.vcenterId}</DetailRow>
        <DetailRow label="호스트">{vm.host || '—'}</DetailRow>
        <DetailRow label="클러스터">{vm.cluster || '—'}</DetailRow>
        <DetailRow label="Guest OS">{vm.guestOS}</DetailRow>
        <DetailRow label={`IP 주소${vm.ipAddresses?.length > 1 ? ` (${vm.ipAddresses.length})` : ''}`}>{ipList(vm)}</DetailRow>
        <DetailRow label="VMware Tools"><StateBadge state={vm.toolsStatus} /></DetailRow>
        <DetailRow label="vCPU">{vm.cpuCount} 코어</DetailRow>
        <DetailRow label="RAM">{Math.round(vm.memMB / 1024)} GB ({vm.memMB.toLocaleString()} MB)</DetailRow>
        <DetailRow label="디스크">{vm.storageGB} GB</DetailRow>
        <DetailRow label="Tools 버전">{vm.toolsVersion || '—'}</DetailRow>
        <DetailRow label="스냅샷">{vm.snapshotCount ? `${vm.snapshotCount}개 · ${vm.snapshotSizeGB || 0} GB` : '없음'}</DetailRow>
        <DetailRow label="GPU">{vm.gpu ? <GpuBadge gpu={vm.gpu} /> : <span className="muted">없음</span>}</DetailRow>
        <DetailRow label="vCenter ID">{vm.id}</DetailRow>
      </div>
      <div style={{ marginTop: 12 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>태그</div>
        <div style={{ marginBottom: 10 }}>
          {(vm.tags?.length ? vm.tags : []).map((t) => <span key={t} className="badge blue" style={{ marginRight: 6 }}>{t}</span>)}
          {!vm.tags?.length && <span className="muted">—</span>}
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>메모(Notes)</div>
        <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: vm.notes ? 'var(--text)' : 'var(--text-faint)' }}>{vm.notes || '—'}</div>
      </div>
      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>CPU 사용률</div>
          <UsageCell pct={vm.cpuUsagePct} />
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>메모리 사용률</div>
          <UsageCell pct={vm.memUsagePct} />
        </div>
      </div>
      <div className="flex gap" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
        <VmConsoleButton vmId={vm.id} vmName={vm.name} />
        <VmRemoteButton item={vm} />
        <VmMetricButton vmId={vm.id} vmName={vm.name} />
      </div>
    </Modal>
  );
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
  if (error) return <ErrorBox message={error} />;
  const rows = data?.items || [];

  const showGpuCol = gpuOnly || gpuType || rows.some((v) => v.gpu);
  const columns = [
    { key: 'name', label: 'VM', render: (v) => <button className="cell-link" onClick={() => setSelected(v)}>{v.name}</button> },
    { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
    { key: 'powerState', label: '전원', render: (v) => <StateBadge state={v.powerState} /> },
    { key: 'guestOS', label: 'Guest OS' },
    { key: 'ipAddress', label: 'IP', render: (v) => ipList(v) },
    { key: 'cpuCount', label: 'vCPU', align: 'right' },
    { key: 'memMB', label: 'RAM', align: 'right', render: (v) => `${Math.round(v.memMB / 1024)} GB` },
    ...(showGpuCol ? [{ key: 'gpu', label: 'GPU', sortValue: (v) => v.gpu?.type || '', render: (v) => <GpuBadge gpu={v.gpu} /> }] : []),
    { key: 'cpuUsagePct', label: 'CPU', render: (v) => <UsageCell pct={v.cpuUsagePct} /> },
    { key: 'memUsagePct', label: '메모리', render: (v) => <UsageCell pct={v.memUsagePct} /> },
    { key: 'storageGB', label: '디스크', align: 'right', render: (v) => `${v.storageGB} GB` },
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
      {selected && <VmDetail vm={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
