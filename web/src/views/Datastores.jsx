import React from 'react';
import { usePolling } from '../api.js';
import { DataTable, UsageCell, Kpi, Loading, ErrorBox, ResultCount } from '../components/ui.jsx';
import IpmsMatches from '../components/IpmsMatches.jsx';

export default function Datastores({ filters }) {
  const { data, error, loading } = usePolling('/datastores', filters, 15_000);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />; // 데이터 보유 중 일시 폴링 오류는 화면 유지
  const rows = data?.items || [];

  const tb = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb} GB`);
  const typeBadge = { vSAN: 'purple', NFS: 'blue', VMFS: 'green' };

  // Sum capacity/used/free across the currently shown (filtered) datastores.
  const sum = (k) => rows.reduce((a, d) => a + (d[k] || 0), 0);
  const capGB = sum('capacityGB'), usedGB = sum('usedGB'), freeGB = sum('freeGB');
  const usagePct = capGB > 0 ? Math.round((usedGB / capGB) * 100) : 0;
  const filtered = Object.keys(filters || {}).length > 0;

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
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Kpi label={filtered ? '데이터스토어 (필터)' : '데이터스토어'} value={rows.length.toLocaleString()} meta={filtered ? '필터 적용 합계' : '전체 합계'} />
        <Kpi label="총 용량 합계" value={tb(capGB)} meta={`${rows.length}개 데이터스토어`} />
        <Kpi label="사용 합계" value={tb(usedGB)} meta={`${usagePct}% 사용`} accent={usagePct >= 85 ? 'var(--red)' : usagePct >= 70 ? 'var(--amber)' : undefined} />
        <Kpi label="여유 합계" value={tb(freeGB)} />
        <Kpi label="평균 사용률" value={usagePct} unit="%" pct={usagePct} />
      </div>
      <ResultCount total={data.total} label="데이터스토어" filtered={filtered} />
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'usagePct', dir: 'desc' }} />
      <IpmsMatches filters={filters} />
    </>
  );
}
