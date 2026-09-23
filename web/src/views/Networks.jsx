import React, { lazy, Suspense, useState } from 'react';
import { useHashTab } from '../hooks/useHashTab.js';
import { usePolling } from '../api.js';
import { DataTable, Loading, ErrorBox, ResultCount } from '../components/ui.jsx';
import IpmsMatches from '../components/IpmsMatches.jsx';

const PingMonitor = lazy(() => import('./PingMonitor.jsx'));
const NetworkCheck = lazy(() => import('./NetworkCheck.jsx'));
const VcenterPorts = lazy(() => import('./VcenterPorts.jsx'));

function NetworkList({ filters }) {
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
    // v2.598 VC2598-04: SOAP 수집은 네트워크별 호스트·VM 수를 조회하지 않아 null 을 준다 — 빈칸이 아니라 '—'(모름).
    { key: 'hostCount', label: '호스트', align: 'right', render: (n) => (n.hostCount == null ? '—' : n.hostCount) },
    { key: 'vmCount', label: 'VM', align: 'right', render: (n) => (n.vmCount == null ? '—' : n.vmCount) },
  ];

  return (
    <>
      {/* 폴링 지속 실패 시 낡은 데이터를 무경고로 표시하지 않고 배너로 알린다(v2.287, #20). */}
      {error && <div className="badge red" style={{ display: 'block', marginBottom: 10, padding: '6px 10px' }}>⚠ 갱신 실패 — 직전 데이터를 표시 중입니다({error}).</div>}
      <ResultCount total={data.total} label="네트워크" filtered={Object.keys(filters || {}).length > 0} />
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'vmCount', dir: 'desc' }} />
      <IpmsMatches filters={filters} />
    </>
  );
}

const SUBS = [
  ['list', '네트워크 목록'],
  ['check', '네트워크 체크 (서버 Ping)'],
  ['vcport', 'vCenter 포트 응답속도'],
  ['ping', 'Ping 모니터링'],
];

export default function Networks({ filters }) {
  // 하위 탭을 URL(#/networks/<키>)에 싣는다(v2.438) — Ping 모니터링을 보다 새로고침하면
  // 목록으로 튀던 문제를 없앤다.
  const [sub, setSub] = useHashTab({ base: ['networks'], valid: SUBS.map(([k]) => k), fallback: 'list' });
  return (
    <>
      <div className="flex gap wrap" style={{ marginBottom: 12 }}>
        {SUBS.map(([k, l]) => (
          <button key={k} className={sub === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setSub(k)}>{l}</button>
        ))}
      </div>
      {sub === 'list' && <NetworkList filters={filters} />}
      {sub === 'check' && <Suspense fallback={<Loading />}><NetworkCheck /></Suspense>}
      {sub === 'vcport' && <Suspense fallback={<Loading />}><VcenterPorts /></Suspense>}
      {sub === 'ping' && <Suspense fallback={<Loading />}><PingMonitor /></Suspense>}
    </>
  );
}
