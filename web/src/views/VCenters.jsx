import React from 'react';
import { usePolling } from '../api.js';
import { Loading, ErrorBox, StateBadge, usageColor } from '../components/ui.jsx';

function Bar({ label, pct, detail }) {
  return (
    <div className="vc-metric">
      <div className="vc-mlabel"><span>{label}</span><b>{pct}%{detail ? ` · ${detail}` : ''}</b></div>
      <div className="usage-bar"><span style={{ width: `${Math.min(pct, 100)}%`, background: usageColor(pct) }} /></div>
    </div>
  );
}

export default function VCenters({ onSelectSite }) {
  const { data, error, loading } = usePolling('/vcenters', {}, 15_000);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} />;

  const sites = data || [];
  const connected = sites.filter((s) => s.status === 'connected').length;
  const totalHosts = sites.reduce((a, s) => a + (s.metrics?.hosts || 0), 0);
  const totalVms = sites.reduce((a, s) => a + (s.metrics?.vms || 0), 0);
  const totalAlarms = sites.reduce((a, s) => a + (s.metrics?.alarmsCritical || 0) + (s.metrics?.alarmsWarning || 0), 0);

  return (
    <>
      <div className="kpis" style={{ marginBottom: 18 }}>
        <div className="card kpi"><div className="label">전체 vCenter</div><div className="value">{sites.length}</div><div className="meta">연결됨 {connected} · 불가 {sites.length - connected}</div></div>
        <div className="card kpi"><div className="label">전체 호스트</div><div className="value">{totalHosts.toLocaleString()}</div></div>
        <div className="card kpi"><div className="label">전체 VM</div><div className="value">{totalVms.toLocaleString()}</div></div>
        <div className="card kpi"><div className="label">활성 알람</div><div className="value" style={{ color: totalAlarms ? 'var(--amber)' : undefined }}>{totalAlarms}</div></div>
      </div>

      <div className="vc-grid">
        {sites.map((s) => {
          const m = s.metrics || {};
          const down = s.status !== 'connected';
          return (
            <div className="card vc-card" key={s.id} onClick={() => onSelectSite?.(s.id)}>
              <div className="vc-head">
                <div>
                  <div className="vc-name">{s.name}</div>
                  <div className="vc-loc">📍 {s.location?.city}, {s.location?.country} · {s.location?.region}</div>
                </div>
                <StateBadge state={s.status} />
              </div>

              {down ? (
                <div style={{ padding: '12px 0' }}>
                  <div className="muted" style={{ marginBottom: 6 }}>이 vCenter에 연결할 수 없습니다.</div>
                  {s.error && <div className="diag-err-msg" style={{ fontSize: 12 }}>{s.error}</div>}
                  {s.hint && <div className="diag-err-hint" style={{ fontSize: 12 }}>💡 {s.hint}</div>}
                </div>
              ) : (
                <>
                  <div className="vc-counts">
                    <div className="vc-count"><b>{m.hosts}</b><span>호스트</span></div>
                    <div className="vc-count"><b>{m.vms}</b><span>VM ({m.vmsPoweredOn} on)</span></div>
                    <div className="vc-count"><b style={{ color: m.alarmsCritical ? 'var(--red)' : m.alarmsWarning ? 'var(--amber)' : 'var(--green)' }}>{(m.alarmsCritical || 0) + (m.alarmsWarning || 0)}</b><span>알람</span></div>
                  </div>
                  <Bar label="CPU" pct={m.cpuUsagePct || 0} />
                  <Bar label="메모리" pct={m.memUsagePct || 0} />
                  <Bar label="스토리지" pct={m.storageUsagePct || 0} detail={`${m.storageTotalTB || 0} TB`} />
                </>
              )}

              <div className="vc-foot">
                <span className="muted">v{s.version || '—'}{s.build ? ` · build ${s.build}` : ''}</span>
                <span className="muted">{s.id} →</span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
