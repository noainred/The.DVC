import React, { useState } from 'react';
import { usePolling } from '../api.js';
import { DataTable, UsageCell, StateBadge, Loading, ErrorBox, ResultCount, Modal } from '../components/ui.jsx';
import { VmMetricButton } from '../components/VmMetrics.jsx';

/** Render every IPv4 a VM has (multi-homed), one per line; IPv6 is excluded upstream. */
function ipList(vm) {
  const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
  if (!ips.length) return <span className="muted">—</span>;
  return ips.map((ip, i) => <div key={i}>{ip}</div>);
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
        <DetailRow label="vCenter ID">{vm.id}</DetailRow>
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
      <div className="flex" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
        <VmMetricButton vmId={vm.id} vmName={vm.name} />
      </div>
    </Modal>
  );
}

export default function Vms({ filters }) {
  const { data, error, loading } = usePolling('/vms', { ...filters, limit: 1000 }, 15_000);
  const [selected, setSelected] = useState(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const rows = data?.items || [];

  const columns = [
    { key: 'name', label: 'VM', render: (v) => <button className="cell-link" onClick={() => setSelected(v)}>{v.name}</button> },
    { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
    { key: 'powerState', label: '전원', render: (v) => <StateBadge state={v.powerState} /> },
    { key: 'guestOS', label: 'Guest OS' },
    { key: 'ipAddress', label: 'IP', render: (v) => ipList(v) },
    { key: 'cpuCount', label: 'vCPU', align: 'right' },
    { key: 'memMB', label: 'RAM', align: 'right', render: (v) => `${Math.round(v.memMB / 1024)} GB` },
    { key: 'cpuUsagePct', label: 'CPU', render: (v) => <UsageCell pct={v.cpuUsagePct} /> },
    { key: 'memUsagePct', label: '메모리', render: (v) => <UsageCell pct={v.memUsagePct} /> },
    { key: 'storageGB', label: '디스크', align: 'right', render: (v) => `${v.storageGB} GB` },
    { key: 'host', label: '호스트', render: (v) => <span className="muted">{v.host}</span> },
  ];

  return (
    <>
      <ResultCount total={data.total} shown={rows.length} label="VM" filtered={Object.keys(filters || {}).length > 0} />
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'cpuUsagePct', dir: 'desc' }} />
      {selected && <VmDetail vm={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
