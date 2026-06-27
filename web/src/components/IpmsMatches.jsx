import React, { useState, useEffect } from 'react';
import { fetchJson } from '../api.js';
import { DataTable, StateBadge } from './ui.jsx';

/**
 * IP 검색 시 IPMS(센터별 IP 관리대장 = vCenter 인식 + 능동 스캔) 자료에서 검색어와 일치하는
 * 해당 대역의 IP를 표로 보여준다. filters.qIpms('IPMS 포함' 체크)와 filters.q(검색어)가 모두
 * 있을 때만 동작. 백엔드 변경 없이 /tools/ipam 데이터를 재사용한다. 여러 화면(가상머신·네트워크
 * 등)에서 동일하게 끼워 쓸 수 있다.
 */
const IPMS_DISC = { vcenter: ['blue', 'vCenter'], scan: ['teal', '스캔'], both: ['green', 'vC+스캔'] };

export default function IpmsMatches({ filters }) {
  const qIpms = !!filters?.qIpms;
  const q = (filters?.q || '').trim();
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!qIpms || !q) { setRows([]); return undefined; }
    let on = true;
    const p = filters?.vcenterId ? { vcenterId: filters.vcenterId } : {};
    fetchJson('/tools/ipam', p).then((r) => {
      if (!on) return;
      const ql = q.toLowerCase();
      setRows((r.rows || []).filter((row) => String(row.ip || '').toLowerCase().includes(ql)).slice(0, 2000));
    }).catch(() => { if (on) setRows([]); });
    return () => { on = false; };
  }, [qIpms, q, filters?.vcenterId]);

  if (!qIpms || !q) return null;
  const fmtT = (t) => (t ? new Date(t).toLocaleString('ko-KR') : '—');
  const cols = [
    { key: 'ip', label: 'IP', sortValue: (r) => r.ipNum ?? 0, render: (r) => <b>{r.ip}</b> },
    { key: 'ownerName', label: '호스트 / 소유자', render: (r) => r.ownerName || r.hostName || '—' },
    { key: 'os', label: 'OS / 서비스', sortValue: (r) => r.osName || '', render: (r) => (r.serverType === 'Scanned'
      ? <span className="muted">{(r.services || []).join(', ') || '—'}</span>
      : ([r.osName, r.osVersion].filter(Boolean).join(' ') || r.guestOS || '—')) },
    { key: 'status', label: '상태', render: (r) => (r.usageStatus
      ? <StateBadge state={r.usageStatus === 'up' ? 'POWERED_ON' : 'POWERED_OFF'} />
      : (r.powerState ? <StateBadge state={r.powerState} /> : '—')) },
    { key: 'discovery', label: '확인출처', sortValue: (r) => r.discovery || '', render: (r) => { const d = IPMS_DISC[r.discovery] || ['gray', r.discovery || '—']; return <span className={`badge ${d[0]}`}>{d[1]}</span>; } },
    { key: 'vcenterName', label: 'vCenter', render: (r) => <span className="muted">{r.vcenterName || '(스캔)'}</span> },
    { key: 'lastSeen', label: '최근 관측', align: 'right', sortValue: (r) => r.lastSeen || 0, render: (r) => <span className="muted" style={{ fontSize: 12 }}>{fmtT(r.lastSeen)}</span> },
  ];
  return (
    <div style={{ marginTop: 18 }}>
      <div className="section-title">🛰️ IPMS 스캔 IP <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>— “{q}” 대역 {rows.length}개 (IP 관리대장 · vCenter 인식 + 능동 스캔)</span></div>
      {rows.length === 0
        ? <div className="card"><span className="muted">해당 검색어와 일치하는 IPMS 자료가 없습니다. (특수 기능 → 센터별 IP 관리대장에서 스캔 설정/실행)</span></div>
        : <DataTable columns={cols} rows={rows} initialSort={{ key: 'ip', dir: 'asc' }} />}
    </div>
  );
}
