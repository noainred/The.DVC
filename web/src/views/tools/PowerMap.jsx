// PowerMap.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useState } from 'react';
import { usePolling } from '../../api.js';
import { Loading, ErrorBox, ResultCount, SearchBox } from '../../components/ui.jsx';
import { Card, fmtKwh, fmtWatts, useTool } from './shared.jsx';
import { csvCell } from '../../util/csv.js'; // 수식 인젝션 가드 포함 공통 셀 이스케이프


/** 가로 막대(비중 표시) — recharts 없이 CSS만으로. */
function Bar({ frac, color = 'var(--accent-2,#22d3ee)' }) {
  return (
    <div style={{ background: 'rgba(148,163,184,.14)', borderRadius: 4, height: 8, overflow: 'hidden', minWidth: 60 }}>
      <div style={{ width: `${Math.max(2, Math.round((frac || 0) * 100))}%`, height: '100%', background: color, borderRadius: 4 }} />
    </div>
  );
}

export function PowerMap({ scope }) {
  const { loading, data, error } = useTool('/insights/power-breakdown', scope ? { vcenterId: scope } : {});
  const { data: vcList } = usePolling('/vcenters', {}, 60_000);
  const [view, setView] = useState('datacenter'); // datacenter | vcenter | model | region | server
  const [q, setQ] = useState('');
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  if (!data) return null;
  const vcName = new Map((vcList || []).map((v) => [v.id, v.name || v.id]));
  const cur = data.config?.currency || '₩';
  const won = (v) => `${cur}${Number(v || 0).toLocaleString()}`;
  const maxW = Math.max(1, ...(data.byVcenter || []).map((r) => r.watts), ...(data.byModel || []).map((r) => r.watts));

  const csv = () => {
    const head = ['서버', '모델', '서비스태그', 'vCenter', '지역', '수집원', 'W', '매핑'];
    const rows = (data.servers || []).map((s) => [s.name, s.model, s.serviceTag, s.vcenterId, s.region, s.source, s.watts, s.mapped ? 'O' : 'X']);
    const body = [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `power-breakdown-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const term = q.trim().toLowerCase();
  const servers = (data.servers || []).filter((s) => !term
    || (s.name || '').toLowerCase().includes(term) || (s.model || '').toLowerCase().includes(term)
    || (s.serviceTag || '').toLowerCase().includes(term) || (s.vcenterId || '').toLowerCase().includes(term));

  const TABS = [['datacenter', `DataCenter별 (${(data.byDatacenter || []).length})`], ['vcenter', `vCenter별 (${(data.byVcenter || []).length})`], ['model', `모델별 (${(data.byModel || []).length})`], ['region', `지역별 (${(data.byRegion || []).length})`], ['server', `서버 (${data.totalServers})`]];

  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="총 측정 전력" value={fmtWatts(data.totals.watts)} accent="var(--amber)" meta={`서버 ${data.totalServers}대 측정`} />
        <Card label="월 에너지 / 요금" value={fmtKwh(data.totals.kwhMonth)} meta={`월 ${won(data.totals.costMonth)} · PUE ${data.config.pue}`} />
        <Card label="연 전기요금(추정)" value={won(data.totals.costYear)} accent="#fbbf24" meta={`연 CO₂ ${Number(data.totals.co2YearKg || 0).toLocaleString()} kg`} />
        <Card label="법인 매핑" value={`${data.mappedServers} / ${data.totalServers}`} accent={data.unmappedServers ? 'var(--red)' : 'var(--green)'}
          meta={data.unmappedServers ? `미매핑 ${data.unmappedServers}대(${fmtWatts(data.unmappedWatts)})` : '전부 vCenter 매핑됨'} />
      </div>
      {data.unmappedServers > 0 && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 12, borderLeft: '3px solid var(--amber)' }}>
          <div style={{ fontSize: 13 }}>⚠ {data.unmappedServers}대({fmtWatts(data.unmappedWatts)})는 ESXi 호스트와 매핑되지 않아 <b>'(미매핑)'</b>으로 집계됩니다. 측정 전력 합계에는 포함됩니다.</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>자동 매핑은 ① iDRAC 호스트명 = ESXi 호스트명, ② Dell 서비스태그 일치로 시도합니다. 설정 → 수집(iDRAC)에서 서버의 <b>hostNames</b>에 해당 ESXi 호스트명을 넣으면 그 법인으로 귀속됩니다.</div>
        </div>
      )}
      <div className="flex between wrap gap" style={{ marginBottom: 10, alignItems: 'center' }}>
        <div className="flex gap" style={{ flexWrap: 'wrap' }}>
          {TABS.map(([k, label]) => (
            <button key={k} className={view === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView(k)}>{label}</button>
          ))}
        </div>
        <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={csv}>CSV</button>
      </div>

      {view === 'datacenter' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {(data.byDatacenter || []).map((d) => {
            const dcMax = Math.max(1, ...d.children.map((c) => c.watts));
            return (
              <div key={d.datacenterId || '__nodc__'} className="card" style={{ padding: 14, borderLeft: '3px solid var(--accent, #60a5fa)' }}>
                <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontWeight: 800, fontSize: 16 }}>
                    🏢 {d.datacenterName}
                    <span className="muted" style={{ fontWeight: 400, fontSize: 13, marginLeft: 8 }}>· {d.servers}대 · {d.children.length}개 (vCenter/Baremetal)</span>
                  </div>
                  <div className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
                    <b style={{ color: 'var(--amber)' }}>{fmtWatts(d.watts)}</b>
                    <span className="muted">월 {won(d.costMonth)} · 연 {won(d.costYear)}</span>
                  </div>
                </div>
                <table style={{ width: '100%', fontSize: 13 }}>
                  <thead><tr>
                    <th style={{ textAlign: 'left' }}>2차 분류</th><th style={{ textAlign: 'right' }}>서버</th>
                    <th style={{ textAlign: 'right' }}>현재 전력</th><th style={{ width: 160 }}>비중</th>
                    <th style={{ textAlign: 'right' }}>월 요금</th><th style={{ textAlign: 'right' }}>연 요금</th>
                  </tr></thead>
                  <tbody>
                    {d.children.map((c) => (
                      <tr key={c.key || c.name}>
                        <td>
                          {c.type === 'baremetal'
                            ? <span className="badge amber" title="이 법인엔 속하지만 어떤 vCenter에도 속하지 않는 물리 서버">🔩 Baremetal</span>
                            : <><span className="badge blue" style={{ marginRight: 6 }}>vCenter</span><b>{vcName.get(c.vcenterId) || c.vcenterId}</b></>}
                        </td>
                        <td style={{ textAlign: 'right' }}>{c.servers}</td>
                        <td style={{ textAlign: 'right' }}><b>{fmtWatts(c.watts)}</b></td>
                        <td><Bar frac={c.watts / dcMax} color={c.type === 'baremetal' ? 'var(--amber)' : undefined} /></td>
                        <td style={{ textAlign: 'right' }}>{won(c.costMonth)}</td>
                        <td style={{ textAlign: 'right' }} className="muted">{won(c.costYear)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          {!(data.byDatacenter || []).length && <div className="card" style={{ padding: 16 }}><span className="muted">측정된 전력이 없습니다.</span></div>}
        </div>
      )}

      {view === 'vcenter' && (
        <div className="table-wrap" style={{ maxHeight: '60vh' }}>
          <table>
            <thead><tr><th>법인(vCenter)</th><th>지역</th><th style={{ textAlign: 'right' }}>서버</th><th style={{ textAlign: 'right' }}>현재 전력</th><th style={{ width: 160 }}>비중</th><th style={{ textAlign: 'right' }}>월 요금</th><th style={{ textAlign: 'right' }}>연 요금</th></tr></thead>
            <tbody>
              {data.byVcenter.map((r) => (
                <tr key={r.vcId}>
                  <td><b>{r.vcId}</b></td><td className="muted">{r.region}</td>
                  <td style={{ textAlign: 'right' }}>{r.servers}</td>
                  <td style={{ textAlign: 'right' }}><b>{fmtWatts(r.watts)}</b></td>
                  <td><Bar frac={r.watts / maxW} color={r.vcId === '(미매핑)' ? 'var(--red)' : undefined} /></td>
                  <td style={{ textAlign: 'right' }}>{won(r.costMonth)}</td>
                  <td style={{ textAlign: 'right' }} className="muted">{won(r.costYear)}</td>
                </tr>
              ))}
              {!data.byVcenter.length && <tr><td colSpan={7} className="center muted" style={{ padding: 20 }}>측정된 전력이 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {view === 'model' && (
        <div className="table-wrap" style={{ maxHeight: '60vh' }}>
          <table>
            <thead><tr><th>모델</th><th style={{ textAlign: 'right' }}>서버</th><th style={{ textAlign: 'right' }}>현재 전력</th><th style={{ width: 160 }}>비중</th><th style={{ textAlign: 'right' }}>대당 평균</th><th style={{ textAlign: 'right' }}>연 요금</th></tr></thead>
            <tbody>
              {data.byModel.map((r) => (
                <tr key={r.model}>
                  <td><b>{r.model}</b></td>
                  <td style={{ textAlign: 'right' }}>{r.servers}</td>
                  <td style={{ textAlign: 'right' }}><b>{fmtWatts(r.watts)}</b></td>
                  <td><Bar frac={r.watts / maxW} color="var(--green)" /></td>
                  <td style={{ textAlign: 'right' }} className="muted">{fmtWatts(r.watts / r.servers)}</td>
                  <td style={{ textAlign: 'right' }} className="muted">{won(r.costYear)}</td>
                </tr>
              ))}
              {!data.byModel.length && <tr><td colSpan={6} className="center muted" style={{ padding: 20 }}>모델 정보가 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {view === 'region' && (
        <div className="table-wrap" style={{ maxHeight: '60vh' }}>
          <table>
            <thead><tr><th>지역</th><th style={{ textAlign: 'right' }}>vCenter</th><th style={{ textAlign: 'right' }}>서버</th><th style={{ textAlign: 'right' }}>현재 전력</th><th style={{ textAlign: 'right' }}>연 요금</th></tr></thead>
            <tbody>
              {data.byRegion.map((r) => (
                <tr key={r.region}>
                  <td><b>{r.region}</b></td><td style={{ textAlign: 'right' }}>{r.vcenters}</td>
                  <td style={{ textAlign: 'right' }}>{r.servers}</td>
                  <td style={{ textAlign: 'right' }}><b>{fmtWatts(r.watts)}</b></td>
                  <td style={{ textAlign: 'right' }} className="muted">{won(r.costYear)}</td>
                </tr>
              ))}
              {!data.byRegion.length && <tr><td colSpan={5} className="center muted" style={{ padding: 20 }}>—</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {view === 'server' && (
        <>
          <div className="flex" style={{ marginBottom: 8 }}>
            <SearchBox className="input" style={{ maxWidth: 320 }} placeholder="서버/모델/서비스태그/vCenter 검색" value={q} onChange={setQ} />
          </div>
          <ResultCount total={(data.servers || []).length} shown={servers.length} label="서버" filtered={!!term} />
          <div className="table-wrap" style={{ maxHeight: '60vh' }}>
            <table>
              <thead><tr><th>서버</th><th>모델</th><th>서비스태그</th><th>법인(vCenter)</th><th>수집</th><th style={{ textAlign: 'right' }}>현재 전력</th></tr></thead>
              <tbody>
                {servers.map((s, i) => (
                  <tr key={`${s.name}-${i}`}>
                    <td><b>{s.name}</b></td>
                    <td className="muted" style={{ fontSize: 12 }}>{s.model}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{s.serviceTag || '—'}</td>
                    <td>{s.mapped ? s.vcenterId : <span className="badge red">미매핑</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{s.source}</td>
                    <td style={{ textAlign: 'right' }}>{fmtWatts(s.watts)}</td>
                  </tr>
                ))}
                {!servers.length && <tr><td colSpan={6} className="center muted" style={{ padding: 20 }}>표시할 서버가 없습니다.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7 }}>
        측정된 모든 전력원(iDRAC 직접 · OME · 원격 수집서버)을 서버 단위로 집계합니다. 모델·서비스태그는 iDRAC Redfish 인벤토리에서 읽으므로 ESXi 매핑이 없어도 모델별 분석이 가능합니다.
      </div>
    </>
  );
}
