import React, { useState } from 'react';
import { usePolling } from '../api.js';
import { DataTable, UsageCell, StateBadge, Loading, ErrorBox, ResultCount, EntityDetail } from '../components/ui.jsx';

export default function Hosts({ filters }) {
  const { data, error, loading } = usePolling('/hosts', filters, 15_000);
  const [detail, setDetail] = useState(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const rows = data?.items || [];

  const columns = [
    { key: 'name', label: '호스트', render: (h) => <button className="cell-link" onClick={() => setDetail(h)}>{h.name}</button> },
    { key: 'vcenterId', label: 'vCenter', render: (h) => <span className="muted">{h.vcenterId}</span> },
    { key: 'cluster', label: '클러스터' },
    { key: 'connectionState', label: '상태', render: (h) => <StateBadge state={h.connectionState} /> },
    { key: 'cpuCores', label: 'Cores', align: 'right', render: (h) => h.cpuCores },
    { key: 'cpuUsagePct', label: 'CPU', render: (h) => <UsageCell pct={h.cpuUsagePct} /> },
    { key: 'memUsagePct', label: '메모리', render: (h) => <UsageCell pct={h.memUsagePct} /> },
    { key: 'memTotalMB', label: 'RAM', align: 'right', render: (h) => `${Math.round(h.memTotalMB / 1024)} GB` },
    { key: 'powerWatts', label: '전력', align: 'right', render: (h) => (h.powerWatts > 0 ? `${(h.powerWatts / 1000).toFixed(2)} kW` : '—') },
    { key: 'vmCount', label: 'VM', align: 'right' },
  ];

  return (
    <>
      <ResultCount total={data.total} label="호스트" filtered={Object.keys(filters || {}).length > 0} />
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'cpuUsagePct', dir: 'desc' }} />
      {detail && <EntityDetail type="host" item={detail} onClose={() => setDetail(null)} />}
    </>
  );
}
