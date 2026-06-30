import React, { useState } from 'react';
import { usePolling, fetchJson, postJson, delJson } from '../api.js';
import { DataTable, SeverityBadge, Loading, ErrorBox, EntityDetail, Modal } from '../components/ui.jsx';

const ENDPOINT = { vm: '/vms', host: '/hosts', datastore: '/datastores' };

export default function Alarms({ filters }) {
  const { data, error, loading } = usePolling('/alarms', filters, 15_000);
  const { data: muteData } = usePolling('/alarm-mutes', {}, 30_000);
  const [detail, setDetail] = useState(null);
  const [muteFor, setMuteFor] = useState(null);  // alarm being muted
  const [showMutes, setShowMutes] = useState(false);
  const [busy, setBusy] = useState(false);

  const openEntity = async (a) => {
    const ep = ENDPOINT[a.entityType];
    if (!ep) return;
    try {
      const res = await fetchJson(ep, { vcenterId: a.vcenterId, name: a.entity, limit: 100 });
      const item = (res.items || []).find((x) => x.name === a.entity) || (res.items || [])[0];
      if (item) setDetail({ type: a.entityType, item });
    } catch { /* ignore */ }
  };

  const mute = async (scope) => {
    setBusy(true);
    try {
      await postJson('/alarm-mutes', { message: muteFor.message, entityType: muteFor.entityType, vcenterId: muteFor.vcenterId, scope });
      setMuteFor(null);
    } catch { /* ignore */ } finally { setBusy(false); }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const rows = data?.items || [];
  const mutes = muteData?.mutes || [];

  const sevRank = { critical: 3, warning: 2, info: 1 };
  const columns = [
    { key: 'severity', label: '심각도', sortValue: (a) => sevRank[a.severity] || 0, render: (a) => <SeverityBadge severity={a.severity} /> },
    { key: 'message', label: '메시지', render: (a) => <b>{a.message}</b> },
    { key: 'entityType', label: '대상유형', render: (a) => <span className="badge gray">{a.entityType}</span> },
    { key: 'entity', label: '대상', render: (a) => (ENDPOINT[a.entityType] ? <button className="cell-link" onClick={() => openEntity(a)}>{a.entity}</button> : a.entity) },
    { key: 'vcenterId', label: 'vCenter', render: (a) => <span className="muted">{a.vcenterId}</span> },
    { key: 'time', label: '발생시각', render: (a) => new Date(a.time).toLocaleString('ko-KR') },
    { key: 'act', label: '', sortable: false, render: (a) => <button className="tab" title="앞으로 동일한 알람 무시" onClick={() => setMuteFor(a)}>🔕 무시</button> },
  ];

  return (
    <>
      <div className="flex between wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
        <div className="muted">
          총 <b style={{ color: 'var(--text)' }}>{data.total.toLocaleString()}</b>개 알람 · 위험 {rows.filter((a) => a.severity === 'critical').length} · 경고 {rows.filter((a) => a.severity === 'warning').length}
          {Object.keys(filters || {}).length > 0 && <span className="badge blue" style={{ marginLeft: 8 }}>필터 적용 중</span>}
        </div>
        <button className="tab" onClick={() => setShowMutes(true)}>🔕 무시 규칙 {mutes.length}개</button>
      </div>
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'severity', dir: 'desc' }} emptyText="활성 알람이 없습니다." />

      {detail && <EntityDetail type={detail.type} item={detail.item} onClose={() => setDetail(null)} />}

      {muteFor && (
        <Modal title="앞으로 이 알람 무시" onClose={() => setMuteFor(null)} width={480}>
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <div className="muted">대상 유형 / 메시지 패턴</div>
            <div style={{ margin: '6px 0 14px', padding: '8px 10px', background: 'rgba(12,19,34,.6)', borderRadius: 8 }}>
              <span className="badge gray">{muteFor.entityType}</span> <b>{muteFor.message.replace(/\d+/g, '#')}</b>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>예: “{muteFor.message}”</div>
            </div>
            앞으로 이 유형의 알람을 대시보드/카운트에서 숨깁니다(숫자 무관). 적용 범위를 선택하세요.
          </div>
          <div className="flex gap" style={{ marginTop: 16, flexWrap: 'wrap' }}>
            <button className="login-btn" style={{ flex: 'none', padding: '10px 16px' }} disabled={busy} onClick={() => mute('all')}>전체 vCenter에서 무시</button>
            <button className="logout-btn" style={{ padding: '10px 16px' }} disabled={busy} onClick={() => mute('vcenter')}>{muteFor.vcenterId} 에서만 무시</button>
          </div>
        </Modal>
      )}

      {showMutes && (
        <Modal title="알람 무시 규칙" onClose={() => setShowMutes(false)} width={620}>
          {mutes.length === 0 ? <div className="muted" style={{ padding: 12 }}>무시 규칙이 없습니다.</div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>대상유형</th><th>메시지 패턴</th><th>범위</th><th className="right">해제</th></tr></thead>
                <tbody>
                  {mutes.map((m) => (
                    <tr key={m.id}>
                      <td><span className="badge gray">{m.entityType || '전체'}</span></td>
                      <td><b>{m.template}</b><div className="muted" style={{ fontSize: 11 }}>예: {m.sample}</div></td>
                      <td className="muted">{m.vcenterId || '전체'}</td>
                      <td className="right"><button className="tab" style={{ color: 'var(--red)' }} onClick={async () => { await delJson(`/alarm-mutes/${encodeURIComponent(m.id)}`); }}>해제</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>해제하면 다음 수집 주기에 해당 알람이 다시 표시됩니다.</div>
        </Modal>
      )}
    </>
  );
}
