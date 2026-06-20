import React, { useMemo, useState } from 'react';
import { usePolling } from '../api.js';
import { Kpi, DataTable, Modal, Loading, ErrorBox } from '../components/ui.jsx';

const MGR_BADGE = { connected: 'green', degraded: 'amber', unreachable: 'red', pending: 'gray', disabled: 'gray' };
const MGR_LABEL = { connected: '정상', degraded: '저하', unreachable: '연결끊김', pending: '대기', disabled: '비활성' };
const ACT_BADGE = { ALLOW: 'green', DROP: 'red', REJECT: 'amber' };

const VIEWS = [['gateways', '게이트웨이'], ['segments', '세그먼트'], ['nodes', '전송 노드'], ['dfw', '분산방화벽(DFW)'], ['groups', '보안그룹']];

/** NSX — NSX Manager(분산 네트워크/보안) 통합 모니터링 + DFW 규칙·보안그룹·검색·상세. */
export default function Nsx() {
  const [mgr, setMgr] = useState('');
  const { data, error, loading } = usePolling('/nsx', mgr ? { managerId: mgr } : {}, 20_000);
  const [view, setView] = useState('gateways');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState(null); // { type, item }
  // NOTE: all hooks must run before any early return (React error #310).
  const rules = useMemo(() => (data?.dfw || []).flatMap((p) => p.rules || []), [data]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const r = data.rollup || {};
  const managers = data.managers || [];

  const match = (s) => !q || String(s).toLowerCase().includes(q.toLowerCase());
  const list = (() => {
    if (view === 'gateways') return data.gateways.filter((g) => match(`${g.name} ${g.tier} ${g.managerId} ${g.haMode}`));
    if (view === 'segments') return data.segments.filter((s) => match(`${s.name} ${s.type} ${s.connectivity} ${(s.subnets || []).join(' ')} ${(s.vlanIds || []).join(' ')}`));
    if (view === 'nodes') return data.transportNodes.filter((t) => match(`${t.name} ${t.type}`));
    if (view === 'dfw') return rules.filter((x) => match(`${x.name} ${x.policy} ${(x.sources || []).join(' ')} ${(x.destinations || []).join(' ')} ${(x.services || []).join(' ')} ${x.action}`));
    if (view === 'groups') return (data.securityGroups || []).filter((g) => match(`${g.name} ${g.memberType} ${g.criteria} ${(g.members || []).join(' ')} ${(g.memberIps || []).join(' ')}`));
    return [];
  })();

  return (
    <>
      {data.source === 'mock' && (
        <div className="card" style={{ marginBottom: 12, borderColor: 'var(--amber)', padding: '10px 14px' }}>
          <b style={{ color: 'var(--amber)' }}>ℹ 데모(mock) 데이터</b>
          <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>설정 → NSX 관리에서 NSX Manager를 등록하고 데이터 소스를 LIVE로 전환하면 실제 NSX 정보가 표시됩니다.</span>
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
        <Kpi label="NSX Manager" value={r.managers ?? 0} meta={`정상 ${r.managersUp ?? 0}${r.managersDegraded ? ` · 저하 ${r.managersDegraded}` : ''}`} accent={r.managersDegraded ? 'var(--amber)' : undefined} onClick={() => setView('gateways')} />
        <Kpi label="게이트웨이" value={(r.t0 ?? 0) + (r.t1 ?? 0)} meta={`T0 ${r.t0 ?? 0} · T1 ${r.t1 ?? 0}`} onClick={() => setView('gateways')} />
        <Kpi label="세그먼트" value={r.segments ?? 0} meta={`Overlay ${r.overlaySegments ?? 0} · VLAN ${r.vlanSegments ?? 0}`} onClick={() => setView('segments')} />
        <Kpi label="전송 노드" value={(r.hostNodes ?? 0) + (r.edgeNodes ?? 0)} meta={`Host ${r.hostNodes ?? 0} · Edge ${r.edgeNodes ?? 0}`} onClick={() => setView('nodes')} />
        <Kpi label="분산 방화벽(DFW)" value={r.dfwRules ?? 0} meta={`정책 ${r.dfwPolicies ?? 0} · 그룹 ${r.groups ?? 0}`} onClick={() => setView('dfw')} />
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
                <td className="right">{m.gateways ?? 0}</td>
                <td className="right">{m.segments ?? 0}</td>
                <td className="right">{m.transportNodes ?? 0}</td>
                <td className="right">{m.firewall?.rules ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
        {VIEWS.map(([k, l]) => {
          const cnt = k === 'gateways' ? data.gateways.length : k === 'segments' ? data.segments.length : k === 'nodes' ? data.transportNodes.length : k === 'dfw' ? rules.length : (data.securityGroups || []).length;
          return <button key={k} className={view === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => { setView(k); }}>{l} ({cnt})</button>;
        })}
        <input className="input" style={{ maxWidth: 280 }} placeholder="이름 / IP / 서비스 / 그룹 검색…" value={q} onChange={(e) => setQ(e.target.value)} />
        {mgr && <span className="muted" style={{ fontSize: 12 }}>· {mgr} 필터됨 <button className="tab" style={{ padding: '2px 8px' }} onClick={() => setMgr('')}>해제</button></span>}
      </div>

      {view === 'gateways' && <GatewayTable rows={list} onOpen={(g) => setDetail({ type: 'gateway', item: g })} />}
      {view === 'segments' && <SegmentTable rows={list} onOpen={(s) => setDetail({ type: 'segment', item: s })} />}
      {view === 'nodes' && <NodeTable rows={list} />}
      {view === 'dfw' && <DfwTable rows={list} onOpen={(x) => setDetail({ type: 'rule', item: x })} />}
      {view === 'groups' && <GroupTable rows={list} onOpen={(g) => setDetail({ type: 'group', item: g })} />}

      {detail && <DetailModal detail={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

function GatewayTable({ rows, onOpen }) {
  const cols = [
    { key: 'name', label: '게이트웨이', render: (g) => <button className="cell-link" onClick={() => onOpen(g)}>{g.name}</button> },
    { key: 'tier', label: '계층', render: (g) => <span className={`badge ${g.tier === 'T0' ? 'purple' : 'blue'}`}>{g.tier}</span> },
    { key: 'managerId', label: 'NSX Manager', render: (g) => <span className="muted">{g.managerId}</span> },
    { key: 'haMode', label: 'HA 모드', render: (g) => <span className="muted">{g.haMode || '—'}</span> },
    { key: 'nat', label: 'NAT', align: 'right', render: (g) => g.nat ?? '—' },
    { key: 'lb', label: 'LB', align: 'right', render: (g) => g.lb ?? '—' },
  ];
  return <DataTable columns={cols} rows={rows} initialSort={{ key: 'name', dir: 'asc' }} />;
}
function SegmentTable({ rows, onOpen }) {
  const cols = [
    { key: 'name', label: '세그먼트', render: (s) => <button className="cell-link" onClick={() => onOpen(s)}>{s.name}</button> },
    { key: 'type', label: '유형', render: (s) => <span className={`badge ${s.type === 'VLAN' ? 'amber' : 'green'}`}>{s.type}</span> },
    { key: 'connectivity', label: '연결(T1/T0)', render: (s) => <span className="muted">{s.connectivity || '—'}</span> },
    { key: 'vlanIds', label: 'VLAN', render: (s) => (s.vlanIds || []).join(', ') || '—' },
    { key: 'subnets', label: '서브넷', render: (s) => (s.subnets || []).join(', ') || '—' },
    { key: 'vmCount', label: 'VM', align: 'right', render: (s) => s.vmCount ?? '—' },
  ];
  return <DataTable columns={cols} rows={rows} initialSort={{ key: 'name', dir: 'asc' }} />;
}
function NodeTable({ rows }) {
  const cols = [
    { key: 'name', label: '전송 노드', render: (t) => <b>{t.name}</b> },
    { key: 'type', label: '유형', render: (t) => <span className={`badge ${t.type === 'edge' ? 'purple' : 'blue'}`}>{t.type === 'edge' ? 'Edge' : 'Host'}</span> },
    { key: 'status', label: '상태', render: (t) => <span className={`badge ${/up|success|connected/i.test(t.status) ? 'green' : t.status ? 'red' : 'gray'}`}>{t.status || '—'}</span> },
    { key: 'managerId', label: 'Manager', render: (t) => <span className="muted">{t.managerId}</span> },
  ];
  return <DataTable columns={cols} rows={rows} initialSort={{ key: 'name', dir: 'asc' }} />;
}
function DfwTable({ rows, onOpen }) {
  const cols = [
    { key: 'policy', label: '정책', render: (x) => <span className="muted">{x.policy}</span> },
    { key: 'name', label: '규칙', render: (x) => <button className="cell-link" onClick={() => onOpen(x)}>{x.name}</button> },
    { key: 'sources', label: '소스', render: (x) => (x.sources || []).join(', ') || 'Any' },
    { key: 'destinations', label: '목적지', render: (x) => (x.destinations || []).join(', ') || 'Any' },
    { key: 'services', label: '서비스', render: (x) => (x.services || []).join(', ') || 'Any' },
    { key: 'action', label: '동작', render: (x) => <span className={`badge ${ACT_BADGE[x.action] || 'gray'}`}>{x.action || '—'}</span> },
    { key: 'enabled', label: '사용', render: (x) => (x.enabled === false ? <span className="badge gray">off</span> : <span className="badge green">on</span>) },
  ];
  return <DataTable columns={cols} rows={rows} initialSort={{ key: 'policy', dir: 'asc' }} emptyText="DFW 규칙이 없습니다. (라이브: 권한/도메인 확인)" />;
}
function GroupTable({ rows, onOpen }) {
  const cols = [
    { key: 'name', label: '보안그룹', render: (g) => <button className="cell-link" onClick={() => onOpen(g)}>{g.name}</button> },
    { key: 'memberType', label: '멤버 유형', render: (g) => <span className="badge blue">{g.memberType || '—'}</span> },
    { key: 'memberCount', label: '멤버 수', align: 'right', render: (g) => (g.memberCount == null ? '조회' : g.memberCount) },
    { key: 'criteria', label: '기준(조건)', render: (g) => <span className="muted" style={{ fontSize: 12 }}>{g.criteria || '—'}</span> },
    { key: 'managerId', label: 'Manager', render: (g) => <span className="muted">{g.managerId}</span> },
  ];
  return <DataTable columns={cols} rows={rows} initialSort={{ key: 'name', dir: 'asc' }} />;
}

function DetailModal({ detail, onClose }) {
  const { type, item } = detail;
  const Row = ({ label, children }) => (
    <div className="flex between" style={{ padding: '8px 0', borderBottom: '1px solid rgba(36,48,73,.4)', gap: 16 }}>
      <span className="muted">{label}</span><span style={{ textAlign: 'right', wordBreak: 'break-all' }}>{children}</span>
    </div>
  );
  const titles = { gateway: '게이트웨이', segment: '세그먼트', rule: 'DFW 규칙', group: '보안그룹' };
  return (
    <Modal title={`${titles[type]} — ${item.name}`} onClose={onClose} width={620}>
      {type === 'gateway' && <>
        <Row label="계층">{item.tier}</Row>
        <Row label="NSX Manager">{item.managerId}</Row>
        <Row label="HA 모드">{item.haMode || '—'}</Row>
        <Row label="Failover">{item.failoverMode || '—'}</Row>
        <Row label="인터페이스">{item.interfaces ?? '—'}</Row>
        <Row label="NAT 규칙">{item.nat ?? '—'}</Row>
        <Row label="로드밸런서(LB)">{item.lb ?? '—'}</Row>
      </>}
      {type === 'segment' && <>
        <Row label="유형">{item.type}</Row>
        <Row label="연결(T1/T0)">{item.connectivity || '—'}</Row>
        <Row label="Transport Zone">{item.transportZone || '—'}</Row>
        <Row label="VLAN">{(item.vlanIds || []).join(', ') || '—'}</Row>
        <Row label="서브넷">{(item.subnets || []).join(', ') || '—'}</Row>
        <Row label="연결 VM 수">{item.vmCount ?? '—'}</Row>
        {item.ports?.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>연결된 VM (포트)</div>
            <div className="flex gap wrap">{item.ports.map((p) => <span key={p} className="badge gray" style={{ fontSize: 12 }}>{p}</span>)}</div>
          </div>
        )}
      </>}
      {type === 'rule' && <>
        <Row label="정책">{item.policy}</Row>
        <Row label="소스">{(item.sources || []).join(', ') || 'Any'}</Row>
        <Row label="목적지">{(item.destinations || []).join(', ') || 'Any'}</Row>
        <Row label="서비스">{(item.services || []).join(', ') || 'Any'}</Row>
        <Row label="동작"><span className={`badge ${ACT_BADGE[item.action] || 'gray'}`}>{item.action || '—'}</span></Row>
        <Row label="방향">{item.direction || '—'}</Row>
        <Row label="적용 대상(Applied To)">{item.appliedTo || 'DFW'}</Row>
        <Row label="사용">{item.enabled === false ? '비활성' : '활성'}</Row>
      </>}
      {type === 'group' && <>
        <Row label="멤버 유형">{item.memberType || '—'}</Row>
        <Row label="멤버 수">{item.memberCount ?? '(라이브는 별도 조회)'}</Row>
        <Row label="기준(조건)">{item.criteria || '—'}</Row>
        {item.members?.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>멤버 VM ({item.members.length})</div>
            <div className="flex gap wrap">{item.members.map((m) => <span key={m} className="badge gray" style={{ fontSize: 12 }}>{m}</span>)}</div>
          </div>
        )}
        {item.memberIps?.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>멤버 IP ({item.memberIps.length})</div>
            <div className="flex gap wrap">{item.memberIps.map((ip) => <span key={ip} className="badge blue" style={{ fontSize: 12 }}>{ip}</span>)}</div>
          </div>
        )}
      </>}
    </Modal>
  );
}
