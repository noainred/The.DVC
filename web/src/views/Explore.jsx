import React, { useState } from 'react';
import { usePolling } from '../api.js';
import { DataTable, UsageCell, StateBadge, Loading, ErrorBox, EntityDetail } from '../components/ui.jsx';

/** Compact leaderboard list for a "top consumers" category. Rows are clickable. */
function TopList({ title, items, valueOf, label, accent, type, onSelect }) {
  const max = Math.max(1, ...items.map(valueOf));
  return (
    <div className="card">
      <div className="flex between" style={{ marginBottom: 10 }}>
        <b>{title}</b>
        <span className="muted" style={{ fontSize: 12 }}>상위 {items.length}</span>
      </div>
      {items.length === 0 && <div className="muted" style={{ padding: 12 }}>데이터 없음</div>}
      {items.map((it, i) => {
        const v = valueOf(it);
        return (
          <div key={it.id || i} className="top-row top-row-click" onClick={() => onSelect?.({ type, item: it })} title="클릭하여 상세 보기">
            <span className="top-rank">{i + 1}</span>
            <div className="top-main">
              <div className="top-name">{it.name}</div>
              <div className="top-sub muted">{it.vcenterId}{it.host ? ` · ${it.host}` : ''}{it.cluster ? ` · ${it.cluster}` : ''}</div>
            </div>
            <div className="top-bar-wrap">
              <div className="top-bar"><span style={{ width: `${(v / max) * 100}%`, background: accent }} /></div>
              <span className="top-val tabular">{label(it)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Explore({ scope }) {
  const [limit, setLimit] = useState(10);
  const [detail, setDetail] = useState(null); // { type, item }
  const { data: top, error, loading } = usePolling('/top', { ...scope, limit }, 15_000);

  // Advanced spec search state
  const [spec, setSpec] = useState({
    vcpuMin: '', ramMinGB: '', diskMinGB: '', cpuUsageMin: '', memUsageMin: '', os: '', powerState: 'POWERED_ON',
  });
  const searchParams = Object.fromEntries(Object.entries({ ...scope, ...spec }).filter(([, v]) => v !== ''));
  const { data: vmResult } = usePolling('/vms', { ...searchParams, sortBy: 'cpuUsagePct', order: 'desc', limit: 200 }, 20_000);

  if (loading && !top) return <Loading />;
  if (error) return <ErrorBox message={error} />;

  const tb = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb} GB`);

  const vmCols = [
    { key: 'name', label: 'VM', render: (v) => <button className="cell-link" onClick={() => setDetail({ type: 'vm', item: v })}>{v.name}</button> },
    { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
    { key: 'powerState', label: '전원', render: (v) => <StateBadge state={v.powerState} /> },
    { key: 'cpuCount', label: 'vCPU', align: 'right' },
    { key: 'memMB', label: 'RAM', align: 'right', render: (v) => `${Math.round(v.memMB / 1024)} GB` },
    { key: 'storageGB', label: '디스크', align: 'right', render: (v) => `${v.storageGB} GB` },
    { key: 'cpuUsagePct', label: 'CPU', render: (v) => <UsageCell pct={v.cpuUsagePct} /> },
    { key: 'memUsagePct', label: '메모리', render: (v) => <UsageCell pct={v.memUsagePct} /> },
    { key: 'guestOS', label: 'Guest OS' },
    { key: 'host', label: '호스트', render: (v) => <span className="muted">{v.host}</span> },
  ];

  const set = (k) => (e) => setSpec((s) => ({ ...s, [k]: e.target.value }));

  return (
    <>
      <div className="flex between wrap" style={{ marginBottom: 4 }}>
        <div className="section-title" style={{ margin: '6px 0' }}>자원 최다 사용 Top 랭킹</div>
        <select className="select" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          {[5, 10, 20, 50].map((n) => <option key={n} value={n}>Top {n}</option>)}
        </select>
      </div>

      <div className="grid cols-3">
        <TopList title="CPU 사용률 최다 VM" items={top.vmsByCpuUsage} valueOf={(v) => v.cpuUsagePct}
          label={(v) => `${v.cpuUsagePct}%`} accent="var(--accent)" type="vm" onSelect={setDetail} />
        <TopList title="메모리 사용률 최다 VM" items={top.vmsByMemUsage} valueOf={(v) => v.memUsagePct}
          label={(v) => `${v.memUsagePct}%`} accent="var(--purple)" type="vm" onSelect={setDetail} />
        <TopList title="디스크 할당 최다 VM" items={top.vmsByStorage} valueOf={(v) => v.storageGB}
          label={(v) => tb(v.storageGB)} accent="var(--accent-2)" type="vm" onSelect={setDetail} />
      </div>

      <div className="grid cols-3" style={{ marginTop: 16 }}>
        <TopList title="CPU 사용률 최다 호스트" items={top.hostsByCpu} valueOf={(h) => h.cpuUsagePct}
          label={(h) => `${h.cpuUsagePct}%`} accent="var(--red)" type="host" onSelect={setDetail} />
        <TopList title="메모리 사용률 최다 호스트" items={top.hostsByMem} valueOf={(h) => h.memUsagePct}
          label={(h) => `${h.memUsagePct}%`} accent="var(--amber)" type="host" onSelect={setDetail} />
        <TopList title="사용률 최다 데이터스토어" items={top.datastoresByUsage} valueOf={(d) => d.usagePct}
          label={(d) => `${d.usagePct}% · ${tb(d.capacityGB)}`} accent="var(--green)" type="datastore" onSelect={setDetail} />
      </div>

      {top.hostsByPower?.length > 0 && (
        <div className="grid cols-3" style={{ marginTop: 16 }}>
          <TopList title="소비전력 최다 호스트" items={top.hostsByPower} valueOf={(h) => h.powerWatts}
            label={(h) => `${(h.powerWatts / 1000).toFixed(2)} kW`} accent="var(--amber)" type="host" onSelect={setDetail} />
        </div>
      )}

      <div className="grid cols-3" style={{ marginTop: 16 }}>
        <TopList title="vCPU 할당 최다 VM" items={top.vmsByVcpu} valueOf={(v) => v.cpuCount}
          label={(v) => `${v.cpuCount} vCPU`} accent="var(--accent)" type="vm" onSelect={setDetail} />
        <TopList title="RAM 할당 최다 VM" items={top.vmsByRam} valueOf={(v) => v.memMB}
          label={(v) => `${Math.round(v.memMB / 1024)} GB`} accent="var(--purple)" type="vm" onSelect={setDetail} />
        <TopList title="VM 수 최다 호스트" items={top.hostsByVmCount} valueOf={(h) => h.vmCount}
          label={(h) => `${h.vmCount} VM`} accent="var(--accent-2)" type="host" onSelect={setDetail} />
      </div>

      <div className="section-title">VM 사양별 검색</div>
      <div className="card">
        <div className="spec-grid">
          <label>최소 vCPU<input className="input" type="number" min="0" placeholder="예: 8" value={spec.vcpuMin} onChange={set('vcpuMin')} /></label>
          <label>최소 RAM(GB)<input className="input" type="number" min="0" placeholder="예: 16" value={spec.ramMinGB} onChange={set('ramMinGB')} /></label>
          <label>최소 디스크(GB)<input className="input" type="number" min="0" placeholder="예: 500" value={spec.diskMinGB} onChange={set('diskMinGB')} /></label>
          <label>최소 CPU 사용률(%)<input className="input" type="number" min="0" max="100" placeholder="예: 70" value={spec.cpuUsageMin} onChange={set('cpuUsageMin')} /></label>
          <label>최소 메모리 사용률(%)<input className="input" type="number" min="0" max="100" placeholder="예: 80" value={spec.memUsageMin} onChange={set('memUsageMin')} /></label>
          <label>Guest OS 포함<input className="input" placeholder="예: Windows" value={spec.os} onChange={set('os')} /></label>
          <label>전원 상태
            <select className="select" value={spec.powerState} onChange={set('powerState')}>
              <option value="">전체</option>
              <option value="POWERED_ON">On</option>
              <option value="POWERED_OFF">Off</option>
            </select>
          </label>
          <label style={{ alignSelf: 'end' }}>
            <button className="tab" onClick={() => setSpec({ vcpuMin: '', ramMinGB: '', diskMinGB: '', cpuUsageMin: '', memUsageMin: '', os: '', powerState: 'POWERED_ON' })}>
              조건 초기화
            </button>
          </label>
        </div>
        <div className="muted" style={{ margin: '12px 0 10px' }}>
          조건 일치 VM: <b style={{ color: 'var(--text)' }}>{vmResult?.total?.toLocaleString() ?? '…'}</b>개
          {vmResult && vmResult.total > vmResult.items.length && ` (상위 ${vmResult.items.length}개 표시)`}
        </div>
        <DataTable columns={vmCols} rows={vmResult?.items || []} initialSort={{ key: 'cpuUsagePct', dir: 'desc' }}
          emptyText="조건에 맞는 VM이 없습니다." />
      </div>

      {detail && <EntityDetail type={detail.type} item={detail.item} onClose={() => setDetail(null)} />}
    </>
  );
}
