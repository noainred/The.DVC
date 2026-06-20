import React, { useState } from 'react';
import { usePolling } from '../api.js';
import { Kpi, DataTable, Loading, ErrorBox } from '../components/ui.jsx';

const MGR_BADGE = { connected: 'green', degraded: 'amber', unreachable: 'red', pending: 'gray', disabled: 'gray' };
const MGR_LABEL = { connected: '정상', degraded: '저하', unreachable: '연결끊김', pending: '대기', disabled: '비활성' };

/** NSX — NSX Manager(분산 네트워크/보안) 통합 모니터링. vCenter와 별개의 수집기. */
export default function Nsx() {
  const [mgr, setMgr] = useState('');
  const { data, error, loading } = usePolling('/nsx', mgr ? { managerId: mgr } : {}, 20_000);
  const [view, setView] = useState('gateways');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const r = data.rollup || {};
  const managers = data.managers || [];

  const gwCols = [
    { key: 'name', label: '게이트웨이', render: (g) => <b>{g.name}</b> },
    { key: 'tier', label: '계층', render: (g) => <span className={`badge ${g.tier === 'T0' ? 'purple' : 'blue'}`}>{g.tier}</span> },
    { key: 'managerId', label: 'NSX Manager', render: (g) => <span className="muted">{g.managerId}</span> },
    { key: 'haMode', label: 'HA 모드', render: (g) => <span className="muted">{g.haMode || '—'}</span> },
    { key: 'failoverMode', label: 'Failover', render: (g) => <span className="muted">{g.failoverMode || '—'}</span> },
  ];
  const segCols = [
    { key: 'name', label: '세그먼트', render: (s) => <b>{s.name}</b> },
    { key: 'type', label: '유형', render: (s) => <span className={`badge ${s.type === 'VLAN' ? 'amber' : 'green'}`}>{s.type}</span> },
    { key: 'connectivity', label: '연결(T1/T0)', render: (s) => <span className="muted">{s.connectivity || '—'}</span> },
    { key: 'vlanIds', label: 'VLAN', render: (s) => (s.vlanIds || []).join(', ') || '—' },
    { key: 'subnets', label: '서브넷', render: (s) => (s.subnets || []).join(', ') || '—' },
    { key: 'managerId', label: 'Manager', render: (s) => <span className="muted">{s.managerId}</span> },
  ];
  const tnCols = [
    { key: 'name', label: '전송 노드', render: (t) => <b>{t.name}</b> },
    { key: 'type', label: '유형', render: (t) => <span className={`badge ${t.type === 'edge' ? 'purple' : 'blue'}`}>{t.type === 'edge' ? 'Edge' : 'Host'}</span> },
    { key: 'managerId', label: 'Manager', render: (t) => <span className="muted">{t.managerId}</span> },
  ];
  const rows = view === 'gateways' ? data.gateways : view === 'segments' ? data.segments : data.transportNodes;
  const cols = view === 'gateways' ? gwCols : view === 'segments' ? segCols : tnCols;

  return (
    <>
      {data.source === 'mock' && (
        <div className="card" style={{ marginBottom: 12, borderColor: 'var(--amber)', padding: '10px 14px' }}>
          <b style={{ color: 'var(--amber)' }}>ℹ 데모(mock) 데이터</b>
          <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>
            설정 → NSX 관리에서 NSX Manager를 등록하고 데이터 소스를 LIVE로 전환하면 실제 NSX 정보가 표시됩니다.
          </span>
        </div>
      )}
      {(data.collectionErrors || []).length > 0 && (
        <div className="card" style={{ marginBottom: 12, borderColor: 'var(--red)', padding: '10px 14px' }}>
          <b style={{ color: 'var(--red)' }}>수집 오류 {data.collectionErrors.length}건</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }} className="muted">
            {data.collectionErrors.slice(0, 5).map((e) => <li key={e.managerId}>{e.name}: {e.message}{e.hint ? ` — ${e.hint}` : ''}</li>)}
          </ul>
        </div>
      )}

      <div className="kpis" style={{ marginBottom: 14 }}>
        <Kpi label="NSX Manager" value={r.managers ?? 0} meta={`정상 ${r.managersUp ?? 0}${r.managersDegraded ? ` · 저하 ${r.managersDegraded}` : ''}`} accent={r.managersDegraded ? 'var(--amber)' : undefined} />
        <Kpi label="게이트웨이" value={(r.t0 ?? 0) + (r.t1 ?? 0)} meta={`T0 ${r.t0 ?? 0} · T1 ${r.t1 ?? 0}`} />
        <Kpi label="세그먼트" value={r.segments ?? 0} meta={`Overlay ${r.overlaySegments ?? 0} · VLAN ${r.vlanSegments ?? 0}`} />
        <Kpi label="전송 노드" value={(r.hostNodes ?? 0) + (r.edgeNodes ?? 0)} meta={`Host ${r.hostNodes ?? 0} · Edge ${r.edgeNodes ?? 0}`} />
        <Kpi label="분산 방화벽(DFW)" value={r.dfwRules ?? 0} meta={`정책 ${r.dfwPolicies ?? 0} · 그룹 ${r.groups ?? 0}`} />
      </div>

      <div className="table-wrap" style={{ marginBottom: 14 }}>
        <table>
          <thead><tr><th>NSX Manager</th><th>상태</th><th>버전</th><th>리전</th><th>vCenter</th><th className="right">T0/T1</th><th className="right">세그먼트</th><th className="right">노드</th><th className="right">DFW</th></tr></thead>
          <tbody>
            {managers.length === 0 && <tr><td colSpan={9} className="center muted" style={{ padding: 24 }}>등록된 NSX Manager가 없습니다. 설정 → NSX 관리에서 추가하세요.</td></tr>}
            {managers.map((m) => (
              <tr key={m.id} style={{ cursor: 'pointer', background: mgr === m.id ? 'rgba(99,102,241,.08)' : undefined }} onClick={() => setMgr(mgr === m.id ? '' : m.id)}>
                <td><b>{m.name}</b><span className="muted" style={{ fontSize: 11 }}> · {m.id}</span></td>
                <td><span className={`badge ${MGR_BADGE[m.status] || 'gray'}`}>{MGR_LABEL[m.status] || m.status}</span></td>
                <td className="muted">{m.version || '—'}</td>
                <td><span className="badge blue">{m.region || '—'}</span></td>
                <td className="muted">{m.vcenterId || '—'}</td>
                <td className="right">{(m.gateways ?? 0)}</td>
                <td className="right">{m.segments ?? 0}</td>
                <td className="right">{m.transportNodes ?? 0}</td>
                <td className="right">{m.firewall?.rules ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex gap" style={{ marginBottom: 8, alignItems: 'center' }}>
        {[['gateways', `게이트웨이 (${data.gateways.length})`], ['segments', `세그먼트 (${data.segments.length})`], ['nodes', `전송 노드 (${data.transportNodes.length})`]].map(([k, l]) => (
          <button key={k} className={view === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView(k)}>{l}</button>
        ))}
        {mgr && <span className="muted" style={{ fontSize: 12 }}>· {mgr} 필터됨 <button className="tab" style={{ padding: '2px 8px' }} onClick={() => setMgr('')}>해제</button></span>}
      </div>
      <DataTable columns={cols} rows={rows} initialSort={{ key: 'name', dir: 'asc' }} />
    </>
  );
}
