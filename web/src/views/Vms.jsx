import React from 'react';
import { usePolling } from '../api.js';
import { DataTable, UsageCell, StateBadge, Loading, ErrorBox } from '../components/ui.jsx';

export default function Vms({ filters }) {
  const { data, error, loading } = usePolling('/vms', { ...filters, limit: 1000 }, 15_000);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const rows = data?.items || [];

  const columns = [
    { key: 'name', label: 'VM', render: (v) => <b>{v.name}</b> },
    { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
    { key: 'powerState', label: '전원', render: (v) => <StateBadge state={v.powerState} /> },
    { key: 'guestOS', label: 'Guest OS' },
    { key: 'ipAddress', label: 'IP', render: (v) => v.ipAddress || <span className="muted">—</span> },
    { key: 'cpuCount', label: 'vCPU', align: 'right' },
    { key: 'memMB', label: 'RAM', align: 'right', render: (v) => `${Math.round(v.memMB / 1024)} GB` },
    { key: 'cpuUsagePct', label: 'CPU', render: (v) => <UsageCell pct={v.cpuUsagePct} /> },
    { key: 'memUsagePct', label: '메모리', render: (v) => <UsageCell pct={v.memUsagePct} /> },
    { key: 'storageGB', label: '디스크', align: 'right', render: (v) => `${v.storageGB} GB` },
    { key: 'host', label: '호스트', render: (v) => <span className="muted">{v.host}</span> },
  ];

  return (
    <>
      <div className="muted" style={{ marginBottom: 10 }}>
        총 {data.total.toLocaleString()}개 VM {rows.length < data.total && `(상위 ${rows.length}개 표시)`}
      </div>
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'cpuUsagePct', dir: 'desc' }} />
    </>
  );
}
