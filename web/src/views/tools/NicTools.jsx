// NicTools.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';


/**
 * 서버 NIC 속도 구분 — iDRAC 수집 서버의 물리 NIC 최고 속도(10G/25G/100G…)별 분류.
 * DataCenter(법인)·가상화(ESXi 호스트)/베어메탈 필터. 이미 수집된 인벤토리만 집계(추가 수집 없음).
 */
export function NicSpeed() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [dc, setDc] = useState('');
  const [type, setType] = useState('');       // '' | virtual | baremetal
  const [speedSel, setSpeedSel] = useState(''); // 표 필터: 특정 속도만
  const [sort, setSort] = useState({ key: 'maxSpeedMbps', dir: 'desc' });

  const load = () => {
    const qs = new URLSearchParams({ ...(dc ? { datacenterId: dc } : {}), ...(type ? { type } : {}) }).toString();
    fetchJson(`/admin/idrac/nic-speed${qs ? `?${qs}` : ''}`).then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e.message));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dc, type]);

  if (err) return <ErrorBox message={err} />;
  if (!data) return <Loading />;

  const typeLabel = (t) => (t === 'virtual' ? '가상화(ESXi)' : '베어메탈');
  let servers = (data.servers || []).filter((s) => !speedSel || s.maxSpeed === speedSel);
  const val = (s, k) => (k === 'maxSpeedMbps' ? s.maxSpeedMbps : k === 'vcMaxSpeedMbps' ? (s.vcMaxSpeedMbps || 0) : k === 'nicPorts' ? s.nicPorts : String(s[k] || '').toLowerCase());
  servers = [...servers].sort((a, b) => { const av = val(a, sort.key), bv = val(b, sort.key); const d = av < bv ? -1 : av > bv ? 1 : 0; return (sort.dir === 'desc' ? -d : d) || String(a.name).localeCompare(String(b.name)); });
  const toggleSort = (k) => setSort((s) => (s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'desc' }));
  const Th = ({ k, children, right }) => <th style={{ textAlign: right ? 'right' : 'left', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} onClick={() => toggleSort(k)}>{children}<span style={{ opacity: sort.key === k ? 1 : 0.25, fontSize: 10, marginLeft: 3 }}>{sort.key === k ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span></th>;

  const exportCsv = () => {
    const head = ['server', 'serviceTag', 'model', 'datacenter', 'type', 'maxSpeed', 'allSpeeds', 'nicPorts', 'nicModels', 'vcMaxSpeed', 'vcSpeeds', 'vcPorts'];
    const rows = servers.map((s) => [s.name, s.serviceTag, s.model, s.datacenter, typeLabel(s.type), s.maxSpeed, (s.speeds || []).join(' '), s.nicPorts, (s.nicModels || []).join(' | '), s.vcMaxSpeed || '', (s.vcSpeeds || []).join(' '), s.vcPorts || 0]);
    const csv = [head, ...rows].map((r) => r.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `nic-speed${dc ? `-${dc}` : ''}${type ? `-${type}` : ''}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div style={{ maxWidth: 1200 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🔌 서버 NIC 속도 구분</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        iDRAC로 수집 중인 서버의 물리 NIC(네트워크 어댑터) <b>최고 속도</b>별 분류입니다(포트가 미링크여도 카드 지원속도로 판별). 서버는 가장 빠른 NIC 기준으로 1회 집계됩니다.
        <span className="muted"> · <b>vCenter 속도</b> 컬럼은 서비스태그로 매칭된 ESXi 호스트의 vCenter 수집(pnic) 정보로, iDRAC과 독립적으로 교차 확인할 수 있습니다.</span>
      </p>

      <div className="card" style={{ padding: 14 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <label style={{ fontSize: 13 }}>DataCenter&nbsp;
            <select className="select" value={dc} onChange={(e) => { setDc(e.target.value); setSpeedSel(''); }} style={{ minWidth: 160 }}>
              <option value="">전체</option>
              {(data.datacenters || []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              <option value="__unmapped__">(미매핑)</option>
            </select>
          </label>
          <label style={{ fontSize: 13 }}>유형&nbsp;
            <select className="select" value={type} onChange={(e) => { setType(e.target.value); setSpeedSel(''); }} style={{ minWidth: 130 }}>
              <option value="">전체</option>
              <option value="virtual">가상화(ESXi)</option>
              <option value="baremetal">베어메탈</option>
            </select>
          </label>
          <span className="muted" style={{ fontSize: 12 }}>
            대상 {data.totalServers} · 수집됨 {data.collected}{data.missing ? ` · 미수집 ${data.missing}` : ''} · 가상화 {data.virtual} · 베어메탈 {data.baremetal} · vCenter 매칭 {data.vcCollected || 0}
          </span>
          <button className="tab" style={{ marginLeft: 'auto', padding: '6px 12px' }} onClick={exportCsv}>CSV 내보내기</button>
        </div>

        <div className="flex gap wrap" style={{ marginTop: 12, gap: 8 }}>
          <button className="tab" style={{ padding: '6px 12px', fontWeight: 700, background: !speedSel ? 'rgba(34,211,238,.12)' : undefined }} onClick={() => setSpeedSel('')}>전체 {data.totalServers}</button>
          {(data.bySpeed || []).map((b) => (
            <button key={b.speed} className="tab" style={{ padding: '6px 12px', fontWeight: 700, background: speedSel === b.speed ? 'rgba(34,211,238,.18)' : undefined, color: b.mbps >= 10000 ? 'var(--green)' : undefined }}
              onClick={() => setSpeedSel(speedSel === b.speed ? '' : b.speed)} title={`최고 NIC ${b.speed}인 서버 ${b.count}대`}>
              {b.speed} <b>{b.count}</b>
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 0, marginTop: 12 }}>
        <div className="table-wrap" style={{ maxHeight: '60vh' }}>
          <table>
            <thead><tr>
              <Th k="name">서버</Th><Th k="serviceTag">서비스태그</Th><Th k="model">모델</Th>
              <Th k="datacenter">DataCenter</Th><Th k="type">유형</Th><Th k="maxSpeedMbps">최고 속도</Th>
              <th style={{ textAlign: 'left' }}>모든 NIC 속도</th>
              <Th k="vcMaxSpeedMbps">vCenter 속도</Th><Th k="nicPorts" right>포트</Th>
            </tr></thead>
            <tbody>
              {servers.length === 0 && <tr><td colSpan={9} className="muted" style={{ padding: 16, textAlign: 'center' }}>조건에 맞는 서버가 없습니다.</td></tr>}
              {servers.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.name}</b></td>
                  <td className="muted" style={{ fontSize: 12 }}>{s.serviceTag || '—'}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{s.model || '—'}</td>
                  <td>{s.datacenter}</td>
                  <td><span className={`badge ${s.type === 'virtual' ? 'blue' : 'amber'}`}>{typeLabel(s.type)}</span></td>
                  <td><span className={`badge ${s.maxSpeedMbps >= 10000 ? 'green' : 'gray'}`}>{s.maxSpeed}</span></td>
                  <td className="muted" style={{ fontSize: 12 }} title={(s.nicModels || []).join(' | ')}>{(s.speeds || []).join(', ') || '—'}</td>
                  <td>
                    {s.vcMaxSpeed
                      ? <span title={`vCenter 수집(pnic) — 포트 ${s.vcPorts} · ${(s.vcSpeeds || []).join(', ')}`}>
                          <span className={`badge ${(s.vcMaxSpeedMbps || 0) >= 10000 ? 'green' : 'gray'}`}>{s.vcMaxSpeed}</span>
                          <span className="muted" style={{ fontSize: 11 }}> ×{s.vcPorts}</span>
                        </span>
                      : <span className="muted" style={{ fontSize: 12 }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>{s.nicPorts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/**
 * 서버 NIC 모델 확인 — iDRAC 수집 서버에 설치된 NIC 어댑터의 종류·모델명(Intel/Broadcom/Mellanox…)별
 * 분류. DataCenter(법인)·가상화(ESXi)/베어메탈 필터. 이미 수집된 인벤토리만 집계(추가 수집 없음).
 */
export function NicModels() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [dc, setDc] = useState('');
  const [type, setType] = useState('');
  const [modelSel, setModelSel] = useState('');
  const [vcModelSel, setVcModelSel] = useState(''); // vCenter 수집 모델 칩 필터(별도 컬럼)
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });

  const load = () => {
    const qs = new URLSearchParams({ ...(dc ? { datacenterId: dc } : {}), ...(type ? { type } : {}) }).toString();
    fetchJson(`/admin/idrac/nic-models${qs ? `?${qs}` : ''}`).then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e.message));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dc, type]);

  if (err) return <ErrorBox message={err} />;
  if (!data) return <Loading />;

  const typeLabel = (t) => (t === 'virtual' ? '가상화(ESXi)' : '베어메탈');
  let servers = (data.servers || []).filter((s) => (!modelSel || (s.nicModels || []).includes(modelSel)) && (!vcModelSel || (s.vcModels || []).includes(vcModelSel)));
  const val = (s, k) => (k === 'nicCount' ? (s.adapters || []).length : String(s[k] || '').toLowerCase());
  servers = [...servers].sort((a, b) => { const av = val(a, sort.key), bv = val(b, sort.key); const d = av < bv ? -1 : av > bv ? 1 : 0; return (sort.dir === 'desc' ? -d : d) || String(a.name).localeCompare(String(b.name)); });
  const toggleSort = (k) => setSort((s) => (s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' }));
  const Th = ({ k, children, right }) => <th style={{ textAlign: right ? 'right' : 'left', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} onClick={() => toggleSort(k)}>{children}<span style={{ opacity: sort.key === k ? 1 : 0.25, fontSize: 10, marginLeft: 3 }}>{sort.key === k ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span></th>;

  const exportCsv = () => {
    // 어댑터 단위로 펼쳐서 내보내기(서버 × NIC 모델). source: iDRAC 인벤토리 / vCenter(pnic) 구분.
    const head = ['server', 'serviceTag', 'systemModel', 'datacenter', 'type', 'source', 'nicModel', 'nicName', 'speeds', 'ports'];
    const lines = [];
    for (const s of servers) {
      for (const a of (s.adapters || [])) lines.push([s.name, s.serviceTag, s.model, s.datacenter, typeLabel(s.type), 'iDRAC', a.model, a.name, (a.speeds || []).join(' '), a.ports]);
      for (const a of (s.vcAdapters || [])) lines.push([s.name, s.serviceTag, s.model, s.datacenter, typeLabel(s.type), 'vCenter', a.model, '', (a.speeds || []).join(' '), a.ports]);
    }
    const csv = [head, ...lines].map((r) => r.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `nic-models${dc ? `-${dc}` : ''}${type ? `-${type}` : ''}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div style={{ maxWidth: 1240 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🧬 서버 NIC 모델 확인</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        iDRAC로 수집 중인 서버에 설치된 물리 NIC(네트워크 어댑터)의 <b>종류·모델명</b>별 분류입니다(Intel·Broadcom·Mellanox 등).
        <span className="muted"> · <b>vCenter 수집</b> 컬럼은 서비스태그로 매칭된 ESXi 호스트의 vCenter(pnic+PCI) 정보로, iDRAC 인벤토리와 독립적으로 교차 확인할 수 있습니다.</span>
      </p>

      <div className="card" style={{ padding: 14 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <label style={{ fontSize: 13 }}>DataCenter&nbsp;
            <select className="select" value={dc} onChange={(e) => { setDc(e.target.value); setModelSel(''); setVcModelSel(''); }} style={{ minWidth: 160 }}>
              <option value="">전체</option>
              {(data.datacenters || []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              <option value="__unmapped__">(미매핑)</option>
            </select>
          </label>
          <label style={{ fontSize: 13 }}>유형&nbsp;
            <select className="select" value={type} onChange={(e) => { setType(e.target.value); setModelSel(''); setVcModelSel(''); }} style={{ minWidth: 130 }}>
              <option value="">전체</option>
              <option value="virtual">가상화(ESXi)</option>
              <option value="baremetal">베어메탈</option>
            </select>
          </label>
          <span className="muted" style={{ fontSize: 12 }}>
            대상 {data.totalServers} · 수집됨 {data.collected}{data.missing ? ` · 미수집 ${data.missing}` : ''} · 모델 {(data.byModel || []).length}종 · vCenter 매칭 {data.vcCollected || 0} (모델 {(data.vcByModel || []).length}종)
          </span>
          <button className="tab" style={{ marginLeft: 'auto', padding: '6px 12px' }} onClick={exportCsv}>CSV 내보내기</button>
        </div>

        <div className="flex gap wrap" style={{ marginTop: 12, gap: 8, alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 12, fontWeight: 700 }}>iDRAC</span>
          <button className="tab" style={{ padding: '6px 12px', fontWeight: 700, background: !modelSel ? 'rgba(34,211,238,.12)' : undefined }} onClick={() => setModelSel('')}>전체 {data.totalServers}</button>
          {(data.byModel || []).map((b) => (
            <button key={b.model} className="tab" style={{ padding: '6px 12px', background: modelSel === b.model ? 'rgba(34,211,238,.18)' : undefined }}
              onClick={() => setModelSel(modelSel === b.model ? '' : b.model)} title={`${b.model} — 서버 ${b.servers}대 · 포트 ${b.ports}`}>
              {b.model} <b>{b.servers}</b>
            </button>
          ))}
        </div>
        {(data.vcByModel || []).length > 0 && (
          <div className="flex gap wrap" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 700 }}>vCenter</span>
            <button className="tab" style={{ padding: '6px 12px', fontWeight: 700, background: !vcModelSel ? 'rgba(52,211,153,.12)' : undefined }} onClick={() => setVcModelSel('')}>전체 {data.vcCollected || 0}</button>
            {(data.vcByModel || []).map((b) => (
              <button key={b.model} className="tab" style={{ padding: '6px 12px', background: vcModelSel === b.model ? 'rgba(52,211,153,.18)' : undefined }}
                onClick={() => setVcModelSel(vcModelSel === b.model ? '' : b.model)} title={`${b.model} — 서버 ${b.servers}대 · 포트 ${b.ports} (vCenter 수집)`}>
                {b.model} <b>{b.servers}</b>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 0, marginTop: 12 }}>
        <div className="table-wrap" style={{ maxHeight: '60vh' }}>
          <table>
            <thead><tr>
              <Th k="name">서버</Th><Th k="serviceTag">서비스태그</Th><Th k="model">서버 모델</Th>
              <Th k="datacenter">DataCenter</Th><Th k="type">유형</Th>
              <th style={{ textAlign: 'left' }}>설치된 NIC — iDRAC (모델 · 속도 · 포트)</th>
              <th style={{ textAlign: 'left' }}>vCenter 수집 (모델 · 속도 · 포트)</th>
            </tr></thead>
            <tbody>
              {servers.length === 0 && <tr><td colSpan={7} className="muted" style={{ padding: 16, textAlign: 'center' }}>조건에 맞는 서버가 없습니다.</td></tr>}
              {servers.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.name}</b></td>
                  <td className="muted" style={{ fontSize: 12 }}>{s.serviceTag || '—'}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{s.model || '—'}</td>
                  <td>{s.datacenter}</td>
                  <td><span className={`badge ${s.type === 'virtual' ? 'blue' : 'amber'}`}>{typeLabel(s.type)}</span></td>
                  <td style={{ fontSize: 12 }}>
                    {(s.adapters || []).length === 0 ? <span className="muted">정보없음</span> : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {s.adapters.map((a, i) => (
                          <span key={i} style={{ opacity: modelSel && a.model !== modelSel ? 0.4 : 1 }}>
                            <b>{a.model}</b>
                            <span className="muted">{a.maxSpeed && a.maxSpeed !== '—' ? ` · ${a.maxSpeed}` : ''} · 포트 {a.ports}{a.name && a.name !== a.model ? ` · ${a.name}` : ''}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {(s.vcAdapters || []).length === 0 ? <span className="muted">—</span> : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {s.vcAdapters.map((a, i) => (
                          <span key={i} style={{ opacity: vcModelSel && a.model !== vcModelSel ? 0.4 : 1 }}>
                            <b>{a.model}</b>
                            <span className="muted">{a.maxSpeed && a.maxSpeed !== '—' ? ` · ${a.maxSpeed}` : ''} · 포트 {a.ports}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
