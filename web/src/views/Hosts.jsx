import React, { useState } from 'react';
import { usePolling } from '../api.js';
import { DataTable, UsageCell, StateBadge, Loading, ErrorBox, ResultCount, EntityDetail } from '../components/ui.jsx';
import IpmsMatches from '../components/IpmsMatches.jsx';

export default function Hosts({ filters }) {
  const { data, error, loading } = usePolling('/hosts', filters, 15_000);
  const [detail, setDetail] = useState(null);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />; // 데이터 보유 중 일시 폴링 오류는 화면 유지
  const rows = data?.items || [];

  const columns = [
    { key: 'name', label: '호스트', render: (h) => <button className="cell-link" onClick={() => setDetail(h)}>{h.name}</button> },
    { key: 'vcenterId', label: 'vCenter', render: (h) => <span className="muted">{h.vcenterId}</span> },
    { key: 'cluster', label: '클러스터' },
    { key: 'connectionState', label: '상태', render: (h) => <StateBadge state={h.connectionState} /> },
    { key: 'cpuCores', label: 'Cores', align: 'right', render: (h) => h.cpuCores },
    { key: 'cpuUsagePct', label: 'CPU', render: (h) => <UsageCell pct={h.cpuUsagePct} /> },
    { key: 'memUsagePct', label: '메모리', render: (h) => <UsageCell pct={h.memUsagePct} /> },
    { key: 'memTotalMB', label: 'RAM', align: 'right', render: (h) => (Number.isFinite(h.memTotalMB) ? `${Math.round(h.memTotalMB / 1024)} GB` : '—') }, // REST 폴백 수집엔 메모리 정보 없음 — 'NaN GB' 방지
    { key: 'powerWatts', label: '전력', align: 'right', render: (h) => (h.powerWatts > 0 ? `${(h.powerWatts / 1000).toFixed(2)} kW` : '—') },
    { key: 'vmCount', label: 'VM', align: 'right' },
  ];

  const s = data.summary;
  const fmt = (n) => (n ?? 0).toLocaleString('en-US');

  return (
    <>
      {s && (
        <>
          <div className="section-title" style={{ marginTop: 0 }}>글로벌 호스트 요약</div>
          <div className="kpis" style={{ marginBottom: 12 }}>
            <div className="card kpi"><div className="label">전체 호스트(ESXi)</div><div className="value">{fmt(s.total)}</div><div className="meta">전원 On {fmt(s.poweredOn)} · Off {fmt(s.poweredOff)}</div></div>
            <div className="card kpi"><div className="label">상태</div><div className="value">{fmt(s.total)}</div><div className="meta">
              정상 {fmt(s.connected)} · <span className={s.maintenance ? 'blink-red' : ''} title={s.maintenance ? '점검(Maintenance) 상태 호스트가 있습니다' : ''}>점검 {fmt(s.maintenance)}</span>
              {' · '}
              <span className={s.disconnected ? 'blink-red' : ''} title={s.disconnected ? '끊김(Disconnected) 호스트가 있습니다 — 연결 확인 필요' : ''}>끊김 {fmt(s.disconnected)}</span>
            </div></div>
            <div className="card kpi"><div className="label">물리 코어</div><div className="value">{fmt(s.physicalCores)}</div><div className="meta">논리 코어 {fmt(s.logicalCores)}</div></div>
            <div className="card kpi"><div className="label">할당 vCore</div><div className="value" style={{ color: 'var(--accent)' }}>{fmt(s.vcoreAllocated)}</div><div className="meta">vCore:물리 {s.vcorePerCore} : 1</div></div>
            <div className="card kpi"><div className="label">전체 메모리</div><div className="value">{fmt(s.memTotalGB)}<small> GB</small></div><div className="meta">≈ {(s.memTotalGB / 1024).toFixed(1)} TB{s.powerKw > 0 ? ` · ${s.powerKw} kW` : ''}</div></div>
            <div className="card kpi">
              <div className="label">ESXi 버전</div>
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {s.esxiVersions.slice(0, 6).map((v) => (
                  <span key={v.version} className="badge blue" title={`${v.count} 호스트`}>{v.version} · {v.count}</span>
                ))}
                {s.esxiVersions.length === 0 && <span className="muted">정보 없음</span>}
              </div>
            </div>
          </div>
          <div className="section-title">호스트 상세</div>
        </>
      )}
      <ResultCount total={data.total} label="호스트" filtered={Object.keys(filters || {}).length > 0} />
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'cpuUsagePct', dir: 'desc' }} />
      <IpmsMatches filters={filters} />
      {detail && <EntityDetail type="host" item={detail} onClose={() => setDetail(null)} />}
    </>
  );
}
