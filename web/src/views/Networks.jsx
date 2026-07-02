import React from 'react';
import { usePolling } from '../api.js';
import { DataTable, Loading, ErrorBox, ResultCount } from '../components/ui.jsx';
import IpmsMatches from '../components/IpmsMatches.jsx';

export default function Networks({ filters }) {
  const { data, error, loading } = usePolling('/networks', filters, 15_000);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />; // 데이터 보유 중 일시 폴링 오류는 화면 유지
  const rows = data?.items || [];

  const label = (t) =>
    t === 'DISTRIBUTED_PORTGROUP' ? ['purple', 'Distributed'] :
    t === 'STANDARD_PORTGROUP' ? ['blue', 'Standard'] : ['gray', t];

  const columns = [
    { key: 'name', label: '네트워크', render: (n) => <b>{n.name}</b> },
    { key: 'vcenterId', label: 'vCenter', render: (n) => <span className="muted">{n.vcenterId}</span> },
    { key: 'type', label: '유형', render: (n) => { const [c, l] = label(n.type); return <span className={`badge ${c}`}>{l}</span>; } },
    { key: 'vlanId', label: 'VLAN', align: 'right' },
    { key: 'hostCount', label: '호스트', align: 'right' },
    { key: 'vmCount', label: 'VM', align: 'right' },
  ];

  return (
    <>
      <ResultCount total={data.total} label="네트워크" filtered={Object.keys(filters || {}).length > 0} />
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'vmCount', dir: 'desc' }} />
      <IpmsMatches filters={filters} />
    </>
  );
}
