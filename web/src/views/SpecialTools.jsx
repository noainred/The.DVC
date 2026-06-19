import React, { useState } from 'react';
import { usePolling } from '../api.js';
import { Loading, ErrorBox, StateBadge, EntityDetail } from '../components/ui.jsx';

/** 특수 기능 — 운영 진단 도구 모음. 현재: 중복 IP 찾기. */
export default function SpecialTools() {
  const [scope, setScope] = useState(''); // '' = 전체
  const [detail, setDetail] = useState(null);
  const [expanded, setExpanded] = useState({});
  const { data: vcList } = usePolling('/vcenters', {}, 60_000);
  const { data, error, loading } = usePolling('/tools/duplicate-ips', scope ? { vcenterId: scope } : {}, 20_000);

  const toggle = (ip) => setExpanded((e) => ({ ...e, [ip]: !e[ip] }));

  return (
    <>
      <div className="flex between wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
        <div className="section-title" style={{ margin: '6px 0' }}>🛠️ 특수 기능 — 중복 IP 찾기</div>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
          <span className="muted">범위</span>
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">전체 vCenter</option>
            {(vcList || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
      </div>

      <div className="muted" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.7 }}>
        VM에 할당된 <b>IPv4</b> 중 <b>둘 이상의 VM이 같은 주소</b>를 쓰는 경우를 찾습니다(IPv6 제외).
        전체 또는 특정 vCenter 단위로 조회할 수 있습니다.
      </div>

      {loading && !data && <Loading />}
      {error && <ErrorBox message={error} />}

      {data && (
        <>
          <div className="kpis" style={{ marginBottom: 16 }}>
            <div className="card kpi"><div className="label">중복 IP</div><div className="value" style={{ color: data.duplicateIps ? 'var(--red)' : 'var(--green)' }}>{data.duplicateIps}</div><div className="meta">검사 대상 VM {data.scannedVms.toLocaleString()}</div></div>
            <div className="card kpi"><div className="label">영향 받는 VM</div><div className="value">{data.affectedVms.toLocaleString()}</div></div>
            <div className="card kpi"><div className="label">범위</div><div className="value" style={{ fontSize: 20 }}>{scope ? (vcList || []).find((v) => v.id === scope)?.name || scope : '전체'}</div></div>
          </div>

          {data.items.length === 0 ? (
            <div className="card" style={{ borderColor: 'var(--green)' }}><b style={{ color: 'var(--green)' }}>✓ 중복 IP가 없습니다.</b></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>IP 주소</th><th className="right">중복 수</th><th>유형</th><th>사용 중인 VM</th></tr></thead>
                <tbody>
                  {data.items.map((d) => (
                    <React.Fragment key={d.ip}>
                      <tr className="vcd-row" onClick={() => toggle(d.ip)}>
                        <td><b style={{ color: 'var(--amber)' }}>{expanded[d.ip] ? '▾' : '▸'} {d.ip}</b></td>
                        <td className="right tabular"><span className="badge red">{d.count}</span></td>
                        <td>{d.crossVcenter ? <span className="badge amber">vCenter 간</span> : <span className="badge gray">동일 vCenter</span>}</td>
                        <td className="muted">{d.vms.map((v) => v.name).join(', ')}</td>
                      </tr>
                      {expanded[d.ip] && d.vms.map((v) => (
                        <tr key={v.id} style={{ background: 'rgba(12,19,34,.5)' }}>
                          <td></td>
                          <td colSpan={3}>
                            <span className="vcd-link" onClick={() => setDetail(v)} style={{ fontWeight: 700 }}>{v.name}</span>
                            <span className="muted" style={{ marginLeft: 8 }}>
                              {v.vcenterId} · {v.host || '—'} · {v.guestOS} <StateBadge state={v.powerState} />
                              {v.ipAddresses?.length > 1 && <span style={{ marginLeft: 8 }}>IP: {v.ipAddresses.join(', ')}</span>}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {detail && <EntityDetail type="vm" item={detail} onClose={() => setDetail(null)} />}
    </>
  );
}
