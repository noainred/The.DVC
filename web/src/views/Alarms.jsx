import React from 'react';
import { usePolling } from '../api.js';
import { DataTable, SeverityBadge, Loading, ErrorBox } from '../components/ui.jsx';

export default function Alarms({ filters }) {
  const { data, error, loading } = usePolling('/alarms', filters, 15_000);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const rows = data?.items || [];

  const sevRank = { critical: 3, warning: 2, info: 1 };
  const columns = [
    { key: 'severity', label: '심각도', sortValue: (a) => sevRank[a.severity] || 0, render: (a) => <SeverityBadge severity={a.severity} /> },
    { key: 'message', label: '메시지', render: (a) => <b>{a.message}</b> },
    { key: 'entityType', label: '대상유형', render: (a) => <span className="badge gray">{a.entityType}</span> },
    { key: 'entity', label: '대상' },
    { key: 'vcenterId', label: 'vCenter', render: (a) => <span className="muted">{a.vcenterId}</span> },
    { key: 'time', label: '발생시각', render: (a) => new Date(a.time).toLocaleString('ko-KR') },
  ];

  return (
    <>
      <div className="muted" style={{ marginBottom: 10 }}>
        총 <b style={{ color: 'var(--text)' }}>{data.total.toLocaleString()}</b>개 알람 · 위험 {rows.filter((a) => a.severity === 'critical').length} · 경고 {rows.filter((a) => a.severity === 'warning').length}
        {Object.keys(filters || {}).length > 0 && <span className="badge blue" style={{ marginLeft: 8 }}>필터 적용 중</span>}
      </div>
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'severity', dir: 'desc' }} emptyText="활성 알람이 없습니다." />
    </>
  );
}
