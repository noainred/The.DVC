import React from 'react';
import { usePolling } from '../api.js';
import { DataTable, UsageCell, Loading, ErrorBox } from '../components/ui.jsx';

export default function Datastores({ filters }) {
  const { data, error, loading } = usePolling('/datastores', filters, 15_000);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const rows = data?.items || [];

  const tb = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb} GB`);
  const typeBadge = { vSAN: 'purple', NFS: 'blue', VMFS: 'green' };

  const columns = [
    { key: 'name', label: '데이터스토어', render: (d) => <b>{d.name}</b> },
    { key: 'vcenterId', label: 'vCenter', render: (d) => <span className="muted">{d.vcenterId}</span> },
    { key: 'type', label: '유형', render: (d) => <span className={`badge ${typeBadge[d.type] || 'gray'}`}>{d.type}</span> },
    { key: 'capacityGB', label: '총 용량', align: 'right', render: (d) => tb(d.capacityGB) },
    { key: 'usedGB', label: '사용', align: 'right', render: (d) => tb(d.usedGB) },
    { key: 'freeGB', label: '여유', align: 'right', render: (d) => tb(d.freeGB) },
    { key: 'usagePct', label: '사용률', render: (d) => <UsageCell pct={d.usagePct} /> },
  ];

  return (
    <>
      <div className="muted" style={{ marginBottom: 10 }}>총 {data.total.toLocaleString()}개 데이터스토어</div>
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'usagePct', dir: 'desc' }} />
    </>
  );
}
