// VmInfoTools.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { DataTable, Loading, ErrorBox, StateBadge, EntityDetail } from '../../components/ui.jsx';
import { Card, tb, useTool } from './shared.jsx';


export function DupIp({ scope }) {
  const { loading, data, error } = useTool('/tools/duplicate-ips', scope ? { vcenterId: scope } : {});
  const [detail, setDetail] = useState(null);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const cols = [
    { key: 'ip', label: 'IP 주소', render: (d) => <b style={{ color: 'var(--amber)' }}>{d.ip}</b> },
    { key: 'count', label: '중복', align: 'right', render: (d) => <span className="badge red">{d.count}</span> },
    { key: 'crossVcenter', label: '유형', sortValue: (d) => (d.crossVcenter ? 1 : 0), render: (d) => (d.crossVcenter ? <span className="badge amber">vCenter 간</span> : <span className="badge gray">동일</span>) },
    { key: 'vms', label: '사용 중인 VM', sortValue: (d) => d.count, render: (d) => d.vms.map((v, i) => <span key={v.id}>{i > 0 && ', '}<span className="vcd-link" onClick={() => setDetail(v)}>{v.name}</span></span>) },
  ];
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="중복 IP" value={data.duplicateIps} accent={data.duplicateIps ? 'var(--red)' : 'var(--green)'} meta={`검사 VM ${data.scannedVms.toLocaleString()}`} />
        <Card label="영향 VM" value={data.affectedVms} />
      </div>
      {data.items.length === 0 ? <div className="card" style={{ borderColor: 'var(--green)' }}><b style={{ color: 'var(--green)' }}>✓ 중복 IP가 없습니다.</b></div>
        : <DataTable columns={cols} rows={data.items} initialSort={{ key: 'count', dir: 'desc' }} />}
      {detail && <EntityDetail type="vm" item={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

export function VmTools({ scope }) {
  const { loading, data, error } = useTool('/tools/vmtools', scope ? { vcenterId: scope } : {});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  // Tools 업그레이드는 서버가 admin/operator만 허용 — viewer에게 버튼을 숨겨 403 체험 방지.
  const [canManage, setCanManage] = useState(false);
  useEffect(() => { fetchJson('/auth/me').then((r) => setCanManage(['admin', 'operator'].includes(r.user?.role))).catch(() => {}); }, []);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;

  const upgrade = async (row) => {
    if (!window.confirm(`Tools 버전 '${row.version}' VM ${row.count}대를 업그레이드할까요? (재부팅이 필요할 수 있음)`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/vms/upgrade-tools', { ids: row.ids });
      setMsg({ ok: true, text: `업그레이드 요청: ${r.succeeded ?? r.requested}/${r.requested}건${r.mock ? ' (데모)' : ''}` });
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };

  const cols = [
    { key: 'version', label: 'Tools 버전', render: (r) => <b>{r.version}</b> },
    { key: 'count', label: 'VM 수', align: 'right' },
    { key: 'running', label: '정상', align: 'right' },
    { key: 'outdated', label: '오래됨', align: 'right', render: (r) => <span style={{ color: r.outdated ? 'var(--amber)' : undefined }}>{r.outdated}</span> },
    { key: 'act', label: '작업', sortable: false, render: (r) => (canManage ? <button className="tab" disabled={busy} onClick={() => upgrade(r)}>업그레이드</button> : null) },
  ];
  return (
    <>
      {msg && <div style={{ marginBottom: 12, padding: '9px 12px', borderRadius: 8, fontSize: 13, background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</div>}
      <div className="muted" style={{ marginBottom: 10 }}>검사 VM <b style={{ color: 'var(--text)' }}>{data.scannedVms.toLocaleString()}</b> · 버전 {data.versions.length}종</div>
      <DataTable columns={cols} rows={data.versions} initialSort={{ key: 'count', dir: 'desc' }} />
    </>
  );
}

export function Snapshots({ scope }) {
  const { loading, data, error } = useTool('/tools/snapshots', scope ? { vcenterId: scope } : {});
  const [detail, setDetail] = useState(null);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const cols = [
    { key: 'name', label: 'VM', render: (v) => <button className="cell-link" onClick={() => setDetail(v)}>{v.name}</button> },
    { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
    { key: 'host', label: '호스트', render: (v) => <span className="muted">{v.host}</span> },
    { key: 'snapshotCount', label: '개수', align: 'right' },
    { key: 'snapshotSizeGB', label: '용량', align: 'right', render: (v) => tb(v.snapshotSizeGB) },
    { key: 'powerState', label: '전원', render: (v) => <StateBadge state={v.powerState} /> },
  ];
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="스냅샷 보유 VM" value={data.count} accent={data.count ? 'var(--amber)' : 'var(--green)'} />
        <Card label="총 스냅샷 용량" value={tb(data.totalSizeGB)} accent="var(--accent-2)" />
      </div>
      {data.items.length === 0 ? <div className="card" style={{ borderColor: 'var(--green)' }}><b style={{ color: 'var(--green)' }}>✓ 스냅샷이 있는 VM이 없습니다.</b></div>
        : <DataTable columns={cols} rows={data.items} initialSort={{ key: 'snapshotSizeGB', dir: 'desc' }} />}
      {detail && <EntityDetail type="vm" item={detail} onClose={() => setDetail(null)} />}
    </>
  );
}
