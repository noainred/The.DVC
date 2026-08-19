// HardwareTools.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState, useMemo, useRef } from 'react';
import { fetchJson } from '../../api.js';
import { DataTable, Loading, ErrorBox, StateBadge, Modal, SearchBox } from '../../components/ui.jsx';
import EscClose from '../../components/EscClose.jsx';
// v2.292: IdracDetailModal 이 IdracAdmin.jsx(1,309줄 뷰)에서 views/idrac/ 로 분리됨 — 모달 하나
// 때문에 뷰 전체가 결합되고 Settings·SpecialTools 청크가 IdracAdmin 을 공유 의존하던 문제 해소.
import { IdracDetailModal } from '../idrac/IdracDetailModal.jsx';
import { Card, tempColor, useTool } from './shared.jsx';


export function Hardware({ scope }) {
  const { loading, data, error } = useTool('/tools/hardware', scope ? { vcenterId: scope } : {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const cols = [
    { key: 'vcenterName', label: '법인(vCenter)', render: (r) => <b>{r.vcenterName}</b> },
    { key: 'vendor', label: '벤더', render: (r) => <span className="badge blue">{r.vendor}</span> },
    { key: 'model', label: '모델' },
    { key: 'count', label: '수량', align: 'right', render: (r) => <b>{r.count}</b> },
  ];
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="호스트" value={data.hosts} meta={`벤더 ${data.byVendor.length} · 모델 ${data.byModel.length}`} />
        {data.byVendor.slice(0, 4).map((v) => <Card key={v.vendor} label={v.vendor} value={v.count} />)}
      </div>
      <div className="section-title" style={{ marginTop: 0 }}>모델별 합계</div>
      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        {data.byModel.slice(0, 12).map((m) => <span key={m.model} className="badge gray" style={{ fontSize: 12, padding: '4px 10px' }}>{m.model} · {m.count}</span>)}
      </div>
      <div className="section-title">법인 × 벤더 × 모델</div>
      <DataTable columns={cols} rows={data.items} initialSort={{ key: 'count', dir: 'desc' }} />
    </>
  );
}

export function Esxi({ scope }) {
  const { loading, data, error } = useTool('/tools/esxi', scope ? { vcenterId: scope } : {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const cols = [
    { key: 'host', label: '호스트', render: (h) => <b>{h.host}</b> },
    { key: 'vcenterId', label: 'vCenter', render: (h) => <span className="muted">{h.vcenterId}</span> },
    { key: 'cluster', label: '클러스터' },
    { key: 'version', label: 'ESXi 버전', render: (h) => <span className="badge blue">{h.version}</span> },
    { key: 'build', label: '빌드', render: (h) => <span className="muted">{h.build || '—'}</span> },
    { key: 'connectionState', label: '상태', render: (h) => <StateBadge state={h.connectionState} /> },
  ];
  return (
    <>
      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        <Card label="호스트" value={data.scanned} meta={`버전 ${data.versions.length}종`} />
        {data.versions.map((v) => <span key={v.version} className="badge blue" style={{ alignSelf: 'center', fontSize: 13, padding: '4px 10px' }}>{v.version} · {v.count}</span>)}
      </div>
      <DataTable columns={cols} rows={data.items} initialSort={{ key: 'version', dir: 'desc' }} />
    </>
  );
}

export function VcVersion() {
  const { loading, data, error } = useTool('/tools/solutions', {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const cols = [
    { key: 'name', label: 'vCenter', render: (v) => <b>{v.name}</b> },
    { key: 'version', label: '버전', render: (v) => <span className="badge blue">{v.version || '—'}</span> },
    { key: 'build', label: '빌드', render: (v) => <span className="muted">{v.build || '—'}</span> },
    { key: 'status', label: '상태', render: (v) => <StateBadge state={v.status} /> },
    { key: 'fullName', label: '제품', render: (v) => <span className="muted" style={{ fontSize: 12 }}>{v.fullName || '—'}</span> },
  ];
  return (
    <>
      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        <Card label="vCenter" value={data.items.length} meta={`버전 ${data.vcenterVersions.length}종`} />
        {data.vcenterVersions.map((v) => <span key={v.version} className="badge blue" style={{ alignSelf: 'center', fontSize: 13, padding: '4px 10px' }}>v{v.version} · {v.count}</span>)}
      </div>
      <DataTable columns={cols} rows={data.items} initialSort={{ key: 'version', dir: 'desc' }} />
    </>
  );
}

/** 법인별 서버 정보 — 등록된 iDRAC/OME 서버를 소속 법인(vCenter)별로 묶어 본다. */
/** 하드웨어 집계 — 모든 데이터센터(법인)의 iDRAC 수집 인벤토리를 모델/CPU/메모리/GPU 종류별로 집계. */
// 하드웨어 집계 드릴다운 모달 — 특정 dim+key(예: 모델 R750)의 서버 목록만 표시.
const HW_DIM_LABEL = { model: '모델', cpu: 'CPU', memory: '메모리', gpu: 'GPU' };
function HwDrillModal({ dc, dim, keyVal, onClose, onServer }) {
  const { loading, data, error } = useTool('/admin/idrac/hardware-servers', { datacenterId: dc || '', dim, key: keyVal });
  const rows = data?.servers || [];
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal card" style={{ maxWidth: 820, width: '92vw', maxHeight: '82vh', overflow: 'auto' }}>
        <div className="flex between" style={{ marginBottom: 10 }}>
          <b style={{ fontSize: 15 }}>{dim === 'gpu' ? '🎮' : dim === 'cpu' ? '⚙' : dim === 'memory' ? '💾' : '🖥'} {HW_DIM_LABEL[dim] || dim}: <span style={{ color: 'var(--accent)' }}>{keyVal}</span> <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {rows.length}대</span></b>
          <button className="logout-btn" onClick={onClose}>닫기</button>
        </div>
        {loading ? <Loading /> : error ? <ErrorBox message={error} /> : rows.length === 0 ? (
          <div className="muted" style={{ padding: 16 }}>해당 서버가 없습니다.</div>
        ) : (
          <table className="data-table" style={{ width: '100%', fontSize: 12.5 }}>
            <thead><tr>
              <th style={{ textAlign: 'left' }}>이름</th><th style={{ textAlign: 'left' }}>주소</th>
              <th style={{ textAlign: 'left' }}>서비스태그</th><th style={{ textAlign: 'left' }}>모델</th>
              {dim === 'gpu' && <th style={{ textAlign: 'right' }}>GPU</th>}
            </tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => onServer(s)} title="클릭 — iDRAC 상세">
                <td><b>{s.name}</b>{s.remote && <span className="badge amber" style={{ marginLeft: 4, fontSize: 10 }}>원격</span>}</td>
                <td className="muted">{s.host || '—'}</td>
                <td className="muted">{s.serviceTag || '—'}</td>
                <td className="muted">{s.model || '—'}</td>
                {dim === 'gpu' && <td style={{ textAlign: 'right' }}>{s.gpuCount}장</td>}
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** 하드웨어 집계 — 모든 데이터센터(법인)의 iDRAC 수집 인벤토리를 모델/CPU/메모리/GPU 종류별로 집계. */
function HardwareSummary() {
  const [d, setD] = useState(null);
  const [dcs, setDcs] = useState([]);
  const [dc, setDc] = useState('');
  const [err, setErr] = useState(null);
  const [drill, setDrill] = useState(null); // { dim, key } — 항목 클릭 시 서버 목록
  const [detail, setDetail] = useState(null); // 드릴 목록에서 클릭한 서버의 iDRAC 상세
  useEffect(() => { fetchJson('/admin/datacenters').then((r) => setDcs(r.datacenters || [])).catch(() => {}); }, []);
  useEffect(() => {
    let active = true; // 법인(dc)을 빠르게 바꾸면 느린 이전 응답이 최신을 덮어쓰던 경쟁 방지.
    setD(null);
    fetchJson(`/admin/idrac/hardware-summary${dc ? `?datacenterId=${encodeURIComponent(dc)}` : ''}`).then((r) => { if (active) { setD(r); setErr(null); } }).catch((e) => { if (active) setErr(e.message); });
    return () => { active = false; };
  }, [dc]);
  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const Bars = ({ title, rows, unit = '대', dim }) => {
    const max = Math.max(1, ...rows.map((r) => r.count));
    return (
      <div className="card" style={{ padding: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>{title} <span className="muted" style={{ fontWeight: 400 }}>· {rows.length}종</span></div>
        {rows.length === 0 ? <span className="muted">데이터 없음</span> : rows.map((r) => (
          <div key={r.key} className="hw-bar-row" style={{ marginBottom: 7, cursor: 'pointer', padding: '2px 4px', margin: '0 -4px 5px', borderRadius: 5 }}
            onClick={() => setDrill({ dim, key: r.key })} title={`클릭 — '${r.key}' 서버만 보기`}>
            <div className="flex between" style={{ fontSize: 12.5, marginBottom: 2, gap: 8 }}>
              <span title={r.key} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.key}</span>
              <b style={{ flex: 'none' }}>{r.count}{unit}</b>
            </div>
            <div style={{ height: 6, borderRadius: 4, background: 'rgba(148,163,184,.15)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(r.count / max) * 100}%`, background: 'var(--accent, #60a5fa)' }} />
            </div>
          </div>
        ))}
      </div>
    );
  };
  return (
    <div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          대상 서버 <b style={{ color: 'var(--accent)' }}>{d.totalServers}</b>대 · 수집 <b>{d.collected}</b> · 미수집 <span className="badge amber">{d.missing}</span> · GPU 카드 <b>{d.totalGpuCards}</b>장
          <span style={{ marginLeft: 6 }}>— 항목을 클릭하면 그 서버만 볼 수 있습니다.</span>
        </div>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }} title="법인(DataCenter) 기준. 스캔 등록분은 법인 직접, 그 외는 vCenter→법인 할당으로 해석.">
          <span className="muted">법인(DataCenter)</span>
          <select className="select" value={dc} onChange={(e) => setDc(e.target.value)} style={{ minWidth: 180 }}>
            <option value="">전체 데이터센터</option>
            {dcs.map((x) => <option key={x.id} value={x.id}>{x.name || x.id}</option>)}
            <option value="__unmapped__">⚠ 미지정(법인 없음)</option>
          </select>
        </label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
        <Bars title="🖥 서버 모델 종류" rows={d.byModel} dim="model" />
        <Bars title="⚙ CPU 종류" rows={d.byCpu} dim="cpu" />
        <Bars title="💾 메모리 용량" rows={d.byMemory} dim="memory" />
        <Bars title="🎮 GPU 종류" rows={d.byGpu} unit="장" dim="gpu" />
      </div>
      {drill && <HwDrillModal dc={dc} dim={drill.dim} keyVal={drill.key} onClose={() => setDrill(null)} onServer={(s) => setDetail({ id: s.id, name: s.name })} />}
      {detail && <IdracDetailModal server={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function ServerInfoByVcenter({ vc, onServer }) {
  const [d, setD] = useState(null);
  const [dcs, setDcs] = useState({ datacenters: [], assign: {} });
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [modelDetail, setModelDetail] = useState(null); // { corpName, model, servers } → 모델 상세 모달
  const [inlineCorp, setInlineCorp] = useState(null); // 법인명 클릭 → 카드 아래 인라인 상세 표(팝업 아님)
  const inlineRef = useRef(null);
  useEffect(() => { if (inlineCorp) inlineRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [inlineCorp]);
  const load = () => Promise.all([
    fetchJson('/admin/idrac').then((r) => r.servers || []),
    fetchJson('/admin/datacenters').then((r) => ({ datacenters: r.datacenters || [], assign: r.assign || {} })).catch(() => ({ datacenters: [], assign: {} })),
  ]).then(([servers, dc]) => { setD(servers); setDcs(dc); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { setD(null); load(); /* eslint-disable-next-line */ }, []);
  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const dcName = new Map((dcs.datacenters || []).map((x) => [x.id, x.name || x.id]));
  const assign = dcs.assign || {};
  // 가상화 소속 vCenter: 명시 vcenterId가 있으면 그것, 없으면 mappedVcenterId(서비스태그=ESXi
  // 일련번호 매칭으로 찾은 vCenter). 스캔 등록 iDRAC 서버도 서비스태그가 ESXi와 일치하면 그 vCenter로.
  const effVc = (s) => s.vcenterId || s.mappedVcenterId || '';
  // 서버의 소속 법인: 스캔 등록분은 datacenterId 직접, 그 외는 (매핑 포함) vCenter→DataCenter 할당.
  const dcOf = (s) => s.datacenterId || assign[effVc(s)] || '';
  // 상단 2단 필터(스코프 객체 { datacenterId?, vcenterId?, baremetal? })를 적용. 백엔드
  // serverInScope와 동일 규칙: 법인=그 법인 전체, vCenter=그 vCenter 가상화, Baremetal=vCenter 미소속.
  const scopeMatch = (s) => {
    const sc = (vc && typeof vc === 'object') ? vc : {};
    const ev = effVc(s);
    if (sc.vcenterId) { if (sc.vcenterId === '__unmapped__' ? ev : ev !== sc.vcenterId) return false; }
    if (sc.datacenterId) { if (dcOf(s) !== (sc.datacenterId === '__unmapped__' ? '' : sc.datacenterId)) return false; }
    if (sc.baremetal && ev) return false;
    return true;
  };
  const ql = q.trim().toLowerCase();
  const match = (s) => !ql || [s.name, s.serviceTag, s.host, s.model].some((x) => String(x || '').toLowerCase().includes(ql));
  const rows = d.filter((s) => scopeMatch(s) && match(s));
  const groups = new Map();
  for (const s of rows) { const id = dcOf(s) || '__unmapped__'; if (!groups.has(id)) groups.set(id, []); groups.get(id).push(s); }
  const groupList = [...groups.entries()]
    .map(([id, list]) => ({ id, name: id === '__unmapped__' ? '⚠ 미지정(법인 없음)' : (dcName.get(id) || id), list }))
    .sort((a, b) => (a.id === '__unmapped__' ? 1 : 0) - (b.id === '__unmapped__' ? 1 : 0) || b.list.length - a.list.length || String(a.name).localeCompare(String(b.name)));
  const corpCount = groupList.filter((g) => g.id !== '__unmapped__').length;
  return (
    <div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          등록 서버 <b style={{ color: 'var(--accent)' }}>{rows.length}</b>대 · 법인 <b>{corpCount}</b>개
          {groups.has('__unmapped__') && <> · <span className="badge amber">미지정 {groups.get('__unmapped__').length}</span></>}
          <span style={{ marginLeft: 8 }}>· 서버 행을 클릭하면 iDRAC 상세(버전·온도·CPU)를 봅니다.</span>
        </div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <input className="input" placeholder="이름/서비스태그/주소 검색" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
          <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={load}>↻ 새로고침</button>
        </div>
      </div>
      {groupList.length === 0 ? (
        <div className="card" style={{ padding: 16 }}><span className="muted">등록된 서버가 없습니다. ‘설정 › iDRAC 서버 등록 › 법인별 iDRAC 장비 스캔’에서 등록하세요.</span></div>
      ) : (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14, alignItems: 'start' }}>
        {groupList.map((g) => {
        // 이 법인에 어떤 모델이 몇 대 있는지 집계(대수 많은 순).
        const modelCounts = (() => {
          const m = new Map();
          for (const s of g.list) { const k = (s.model || '').trim() || '미상'; m.set(k, (m.get(k) || 0) + 1); }
          return [...m.entries()].sort((a, b) => b[1] - a[1]);
        })();
        const maxN = modelCounts[0]?.[1] || 1;
        const openModel = (model) => setModelDetail({
          corpName: g.name, model,
          servers: g.list.filter((s) => ((s.model || '').trim() || '미상') === model).map((s) => ({ ...s, _vc: effVc(s) })),
        });
        return (
        <div key={g.id} className="card" style={{ padding: 14, ...(inlineCorp === g.id ? { borderColor: 'var(--accent)' } : {}) }}>
          <div className="cell-link" style={{ fontWeight: 700, fontSize: 15, marginBottom: 4, cursor: 'pointer' }}
            title={`${g.name} 전체 서버 목록을 아래에 표시`}
            onClick={() => setInlineCorp((cur) => (cur === g.id ? null : g.id))}>
            {g.id === '__unmapped__' ? '⚠ ' : '🏢 '}{g.name} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{inlineCorp === g.id ? '▲' : '▼'}</span>
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
            🖥 서버 모델 종류 · <b>{modelCounts.length}</b>종 · 총 <b style={{ color: 'var(--accent, #60a5fa)' }}>{g.list.length}</b>대
            <span style={{ opacity: 0.8 }}> — 법인명 클릭=아래 전체 표, 모델 클릭=해당 모델 목록</span>
          </div>
          {/* 서버 모델 종류 — 가로 막대(대수 비례). 막대 클릭 → 해당 모델 서버 상세 모달 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {modelCounts.map(([model, n]) => (
              <div key={model} onClick={() => openModel(model)} title={`'${model}' 서버 ${n}대 상세 보기`}
                style={{ cursor: 'pointer' }} className="model-bar-row">
                <div className="flex between" style={{ alignItems: 'baseline', marginBottom: 5 }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{model}</span>
                  <span style={{ fontSize: 14, whiteSpace: 'nowrap' }}><b>{n}</b><span className="muted" style={{ fontSize: 12 }}>대</span></span>
                </div>
                <div style={{ height: 7, background: 'rgba(148,163,184,.15)', borderRadius: 5, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.max(4, (n / maxN) * 100)}%`, height: '100%', background: 'linear-gradient(90deg,#3b82f6,#60a5fa)', borderRadius: 5 }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        );
        })}
      </div>
      )}

      {/* 법인명 클릭 → 카드 아래 인라인 세부 표(팝업 아님). 다시 클릭하거나 [닫기]로 접음. */}
      {inlineCorp && (() => {
        const g = groupList.find((x) => x.id === inlineCorp);
        if (!g) return null; // 필터 변경으로 그룹이 사라지면 표시 안 함
        return (
          <div ref={inlineRef} className="card" style={{ marginTop: 14, padding: 14, borderColor: 'var(--accent)' }}>
            <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 10 }}>
              <b style={{ fontSize: 15 }}>{g.id === '__unmapped__' ? '⚠ ' : '🏢 '}{g.name} — 전체 서버 <span style={{ color: 'var(--accent, #60a5fa)' }}>{g.list.length}</span>대</b>
              <button className="logout-btn" style={{ flex: 'none', padding: '6px 14px' }} onClick={() => setInlineCorp(null)}>닫기 ▲</button>
            </div>
            <ServerListBody
              key={g.id}
              corpName={g.name}
              model={null}
              servers={g.list.map((s) => ({ ...s, _vc: effVc(s) }))}
              onRow={(s) => { if (s.type !== 'ome') onServer(s); }}
            />
          </div>
        );
      })()}

      {modelDetail && (
        <ModelServersModal
          {...modelDetail}
          onRow={(s) => { if (s.type !== 'ome') onServer(s); }}
          onClose={() => setModelDetail(null)}
        />
      )}
    </div>
  );
}

/** 법인 서버 상세 목록 '본문'(검색/CSV/표) — 모달(모델 클릭)과 인라인 패널(법인명 클릭)이 공유. */
function ServerListBody({ corpName, model, servers, onRow }) {
  const [q, setQ] = useState('');
  const allMode = !model; // 법인명 클릭 → 전체 서버(모델 컬럼 표시)
  const ql = q.trim().toLowerCase();
  const rows = (servers || [])
    .filter((s) => !ql || [s.name, s.serviceTag, s.host, s.model].some((x) => String(x || '').toLowerCase().includes(ql)))
    .sort((a, b) => (allMode ? String(a.model || '').localeCompare(String(b.model || '')) : 0) || String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, { numeric: true }));
  const exportCsv = () => {
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['name', 'model', 'type', 'host', 'service_tag', 'vcenter', 'status'];
    const lines = [head.join(',')];
    for (const s of rows) lines.push([s.name || s.id, s.model || model || '', s.type === 'ome' ? 'OME' : 'iDRAC', String(s.host || '').replace(/^https?:\/\//, ''), s.serviceTag || '', s._vc || '', s.enabled === false ? '중지' : '수집'].map(esc).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `servers-${String(model || corpName).replace(/[^a-zA-Z0-9._-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  return (
    <>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          {allMode ? <><b style={{ color: 'var(--accent, #60a5fa)' }}>{corpName}</b> 서버</> : <><b style={{ color: 'var(--accent, #60a5fa)' }}>{model}</b> 서버</>} <b>{(servers || []).length}</b>대{ql ? ` · ${rows.length} 표시` : ''}
          <span style={{ marginLeft: 6 }}>· 행을 클릭하면 iDRAC 상세(버전·온도·CPU)를 봅니다.</span>
        </span>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <input className="input" placeholder="이름/모델/태그/주소 검색" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 180 }} />
          <button className="logout-btn" style={{ flex: 'none', padding: '7px 12px' }} disabled={!(servers || []).length} onClick={exportCsv}>⬇ CSV</button>
        </div>
      </div>
      <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
        <thead><tr>
          <th style={{ textAlign: 'left' }}>이름</th><th>유형</th>{allMode && <th style={{ textAlign: 'left' }}>모델</th>}<th style={{ textAlign: 'left' }}>주소</th><th style={{ textAlign: 'left' }}>서비스태그</th><th>상태</th>
        </tr></thead>
        <tbody>{rows.map((s) => {
          const isOme = s.type === 'ome';
          return (
            <tr key={s.id} style={{ cursor: isOme ? 'default' : 'pointer' }} onClick={() => onRow(s)}>
              <td><b>{s.name || s.id}</b></td>
              <td>{isOme ? <span className="badge blue">OME</span> : <span className="badge gray">iDRAC</span>}{s.remote && <span className="badge amber" style={{ marginLeft: 4 }} title="위임 법인 스캔으로 엣지 에이전트가 수집한 서버(원격 인벤토리)">원격</span>}{!isOme && s._vc && <span className="badge blue" style={{ marginLeft: 4 }} title={`서비스태그가 vCenter '${s._vc}'의 ESXi 호스트와 일치 — 가상화 호스트`}>🖧 {s._vc}</span>}</td>
              {allMode && <td className="muted">{s.model || '—'}</td>}
              <td className="muted">{String(s.host || '').replace(/^https?:\/\//, '') || '—'}</td>
              <td className="muted">{s.serviceTag || '—'}</td>
              <td>{s.enabled === false ? <span className="badge gray">중지</span> : <span className="badge green">수집</span>}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </>
  );
}

/** 특정 모델 서버 상세 목록 모달(모델 막대 클릭 시). 법인명 클릭은 모달 대신 인라인 표를 사용. */
function ModelServersModal({ corpName, model, servers, onRow, onClose }) {
  return (
    <Modal title={model ? `${model} — ${corpName}` : `${corpName} — 전체 서버`} onClose={onClose} width={960} resizable minWidth={560} minHeight={360}>
      <ServerListBody corpName={corpName} model={model} servers={servers} onRow={onRow} />
    </Modal>
  );
}

/** 서버 분석 — iDRAC가 수집한 하드웨어 정보 분석. vCenter(법인)별 필터 + 서버 클릭 상세 공용. */
/** 파트 인벤토리 — 물리 서버에 설치된 모든 하드웨어 파트(CPU·GPU·DIMM·디스크·컨트롤러·
 *  NIC·PSU·PCIe·팬)를 모델별 수량으로 집계하고, 클릭하면 장착 서버 목록으로 드릴다운.
 *  집계는 스코프당 1회만 조회하고 카테고리 칩·검색은 클라이언트에서 거른다(키 입력마다
 *  1,069대 재집계 요청을 만들지 않기 위함 — 서버측 15s single-flight 와 이중 방어). */
const PART_CAT_CHIPS = [['', '전체'], ['cpu', 'CPU'], ['gpu', 'GPU'], ['dimm', '메모리'], ['disk', '디스크'], ['controller', '컨트롤러'], ['nic', 'NIC'], ['psu', 'PSU'], ['pcie', 'PCIe'], ['fan', '팬']];
function PartsInventory({ vc, onServer }) {
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [sortKey, setSortKey] = useState('count'); // count | serverCount | label
  const [drill, setDrill] = useState(null);        // { key, label, catName, servers?, error? }
  const genRef = useRef(0);
  const vcKey = JSON.stringify(vc || {});
  useEffect(() => {
    const gen = ++genRef.current; // 느린 이전 응답이 최신 스코프 결과를 덮는 경쟁 방지
    fetchJson(`/admin/idrac/parts-inventory${vcQS(vc)}`)
      .then((d) => { if (genRef.current === gen) { setData(d); setErr(null); } })
      .catch((e) => { if (genRef.current === gen) setErr(e.message); });
  }, [vcKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const openDrill = (b) => {
    setDrill({ key: b.key, label: b.label, catName: b.catName });
    fetchJson(`/admin/idrac/parts-servers${vcQS(vc)}${vcQS(vc) ? '&' : '?'}key=${encodeURIComponent(b.key)}`)
      .then((d) => setDrill((cur) => (cur && cur.key === b.key ? { ...cur, servers: d.servers } : cur)))
      .catch((e) => setDrill((cur) => (cur && cur.key === b.key ? { ...cur, error: e.message } : cur)));
  };
  if (err) return <ErrorBox message={err} />;
  if (!data) return <Loading />;
  const needle = q.trim().toLowerCase();
  const rows = (data.buckets || [])
    .filter((b) => (!cat || b.cat === cat) && (!needle || `${b.label} ${b.detail} ${b.catName}`.toLowerCase().includes(needle)))
    .sort((a, b) => (sortKey === 'label' ? a.label.localeCompare(b.label) : (b[sortKey] || 0) - (a[sortKey] || 0)));
  const exportCsv = () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['분류,파트,상세,수량,서버수', ...rows.map((b) => [b.catName, b.label, b.detail, b.count, b.serverCount].map(esc).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `hardware-parts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  };
  const th = (key, label) => (
    <th style={{ cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => setSortKey(key)}>{label}{sortKey === key ? ' ▾' : ''}</th>
  );
  return (
    <div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          {PART_CAT_CHIPS.map(([k, label]) => (
            <button key={k} className={cat === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px', fontSize: 12 }} onClick={() => setCat(k)}>{label}</button>
          ))}
        </div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <SearchBox value={q} onChange={setQ} placeholder="파트/모델 검색…" />
          <button className="tab" style={{ flex: 'none', padding: '5px 12px', fontSize: 12 }} onClick={exportCsv}>⬇ CSV</button>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        대상 서버 <b>{data.total}</b>대 · 수집 {data.collected} · 미수집 {(data.missing || []).length}
        {(data.missing || []).length > 0 && <span title={(data.missing || []).slice(0, 30).map((m) => m.name).join(', ')}> (목록은 마우스 오버)</span>}
        {' '}— 파트 {rows.length}종 · 행을 클릭하면 장착 서버가 보입니다. 인벤토리는 30분 주기 수집이며 세대/라이선스에 따라 일부 항목이 비어 있을 수 있습니다.
      </div>
      <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
        <thead><tr><th>분류</th>{th('label', '파트(모델)')}<th>상세</th>{th('count', '수량')}{th('serverCount', '서버 수')}</tr></thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.key} style={{ cursor: 'pointer' }} onClick={() => openDrill(b)}>
              <td><span className="badge blue">{b.catName}</span></td>
              <td><b>{b.label}</b></td>
              <td className="muted">{b.detail}</td>
              <td style={{ textAlign: 'right' }}><b>{b.count}</b></td>
              <td style={{ textAlign: 'right' }}>{b.serverCount}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={5} className="muted">조건에 맞는 파트가 없습니다.</td></tr>}
        </tbody>
      </table>
      {drill && (
        <Modal title={`${drill.catName} — ${drill.label}`} onClose={() => setDrill(null)}>
          <EscClose onClose={() => setDrill(null)} />
          {drill.error && <ErrorBox message={drill.error} />}
          {!drill.servers && !drill.error && <Loading />}
          {drill.servers && (
            <>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{drill.servers.length}대 장착 — 서버를 클릭하면 iDRAC 상세가 열립니다.</div>
              <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                <thead><tr><th>서버</th><th>호스트</th><th>모델</th><th>법인(vCenter)</th><th style={{ textAlign: 'right' }}>수량</th></tr></thead>
                <tbody>
                  {drill.servers.map((s) => (
                    <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => onServer && onServer(s)}>
                      <td><b>{s.name}</b>{s.remote && <span className="badge gray" style={{ marginLeft: 6 }}>위임</span>}</td>
                      <td className="muted">{s.host}</td>
                      <td className="muted">{s.model}</td>
                      <td className="muted">{s.vcenterId || '—'}</td>
                      <td style={{ textAlign: 'right' }}><b>{s.count}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

export function ServerAnalysis() {
  const [sub, setSub] = useState('info'); // 법인별 서버 정보가 기본
  const [dc, setDc] = useState('');   // 1차 박스: '' 전체 | DataCenter id
  const [lvl2, setLvl2] = useState(''); // 2차 박스: '' 전체 | vc:<id> | baremetal
  const [vcs, setVcs] = useState([]);
  const [dcs, setDcs] = useState([]); // 등록된 DataCenter(법인)
  const [assign, setAssign] = useState({}); // vCenter → DataCenter 할당
  const [detail, setDetail] = useState(null); // { id, name } → iDRAC 상세 모달
  useEffect(() => { fetchJson('/vcenters').then((d) => setVcs(d || [])).catch(() => fetchJson('/admin/vcenters').then((d) => setVcs(d.vcenters || [])).catch(() => {})); }, []);
  useEffect(() => { fetchJson('/admin/datacenters').then((r) => { setDcs(r.datacenters || []); setAssign(r.assign || {}); }).catch(() => {}); }, []);
  const onServer = (s) => setDetail({ id: s.id || s.serverId, name: s.name || s.server });
  // 2차 박스의 vCenter 목록: 1차에서 법인을 고르면 그 법인 소속 vCenter만, '전체'면 모든 vCenter.
  const dcVcs = dc ? vcs.filter((v) => assign[v.id] === dc) : vcs;
  // (1차 dc, 2차 lvl2) → 스코프 객체. vCenter를 고르면 그 vCenter(가상화), Baremetal이면 (법인)+baremetal.
  // useMemo로 참조를 안정화(안 하면 finder의 useEffect([vc])가 매 렌더 재요청).
  const scope = useMemo(() => (
    lvl2.startsWith('vc:') ? { vcenterId: lvl2.slice(3) }
      : lvl2 === 'baremetal' ? { ...(dc ? { datacenterId: dc } : {}), baremetal: true }
        : (dc ? { datacenterId: dc } : {})
  ), [dc, lvl2]);
  const sp = { vc: scope, onServer };
  return (
    <div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="flex gap wrap">
          <button className={sub === 'info' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 16px' }} onClick={() => setSub('info')}>🗄 법인별 서버 정보</button>
          <button className={sub === 'hw' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 16px' }} onClick={() => setSub('hw')}>🔩 하드웨어 집계</button>
          <button className={sub === 'parts' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 16px' }} onClick={() => setSub('parts')}>🧩 파트 인벤토리</button>
          <button className={sub === 'temp' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 16px' }} onClick={() => setSub('temp')}>🌡 법인별 온도</button>
          <button className={sub === 'gpu' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 16px' }} onClick={() => setSub('gpu')}>🎮 GPU 정보</button>
          <button className={sub === 'fw' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 16px' }} onClick={() => setSub('fw')}>🏷 BIOS/iDRAC 버전 정보</button>
        </div>
        <div className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
          {/* 1차 박스: 법인(DataCenter) — 고르면 그 법인의 모든 장비 */}
          <label className="flex gap" style={{ alignItems: 'center' }} title="1차: 법인(DataCenter). 고르면 그 법인의 모든 장비가 보입니다.">
            <span className="muted">법인(DataCenter)</span>
            <select className="select" value={dc} onChange={(e) => { setDc(e.target.value); setLvl2(''); }} style={{ minWidth: 150 }}>
              <option value="">전체</option>
              {dcs.map((d) => <option key={d.id} value={d.id}>{d.name || d.id}</option>)}
            </select>
          </label>
          {/* 2차 박스: vCenter(가상화) / Baremetal — 1차 선택에 연동 */}
          <label className="flex gap" style={{ alignItems: 'center' }} title="2차: vCenter=가상화 장비만 · Baremetal=vCenter에 속하지 않는 물리 서버">
            <span className="muted">구분</span>
            <select className="select" value={lvl2} onChange={(e) => setLvl2(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">{dc ? '전체 (법인 모든 장비)' : '전체'}</option>
              {dcVcs.length > 0 && (
                <optgroup label="🖥 vCenter (가상화 장비만)">
                  {dcVcs.map((v) => <option key={v.id} value={`vc:${v.id}`}>{v.name || v.id}</option>)}
                </optgroup>
              )}
              <option value="baremetal">🔩 Baremetal (미가상화 물리)</option>
            </select>
          </label>
        </div>
      </div>
      {sub === 'info' && <ServerInfoByVcenter {...sp} vcs={vcs} />}
      {sub === 'hw' && <HardwareSummary />}
      {sub === 'parts' && <PartsInventory {...sp} />}
      {sub === 'gpu' && <ServerGpuFinder {...sp} />}
      {sub === 'fw' && <ServerFirmwareFinder {...sp} />}
      {sub === 'temp' && <ServerTempFinder {...sp} />}
      {detail && <IdracDetailModal server={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

// 서버 분석 스코프 객체 { datacenterId?, vcenterId?, baremetal? } → 쿼리스트링.
// 세 축을 조합할 수 있다(예: 법인 A의 Baremetal = datacenterId=A & baremetal=1).
const vcQS = (sc) => {
  if (!sc || typeof sc !== 'object') return '';
  const p = [];
  if (sc.vcenterId) p.push(`vcenterId=${encodeURIComponent(sc.vcenterId)}`);
  if (sc.datacenterId) p.push(`datacenterId=${encodeURIComponent(sc.datacenterId)}`);
  if (sc.baremetal) p.push('baremetal=1');
  return p.length ? `?${p.join('&')}` : '';
};

/** 온도 보기 — 전체 서버의 최신 온도센서(CPU/GPU/Inlet/Exhaust 등)를 한 표에 모아 정렬. */
// 온도 센서 종류 필터(라벨). iDRAC 센서명(CPU1 Temp·Inlet Temp·Exhaust Temp·GPU1 Temp·DIMM…)에 매칭.
const TEMP_KINDS = [
  ['', '전체 센서'],
  ['cpu', 'CPU'],
  ['gpu', 'GPU'],
  ['inlet', '흡기(Inlet)'],
  ['exhaust', '배기(Exhaust)'],
  ['mem', '메모리(DIMM)'],
  ['other', '기타'],
];
function tempKindMatch(kind, sensor) {
  if (!kind) return true;
  const s = String(sensor || '').toLowerCase();
  if (kind === 'cpu') return /cpu|proc/.test(s);
  if (kind === 'gpu') return /gpu|accel/.test(s);
  if (kind === 'inlet') return /inlet|intake|흡기/.test(s);
  if (kind === 'exhaust') return /exhaust|outlet|배기/.test(s);
  if (kind === 'mem') return /dimm|mem|메모리/.test(s);
  if (kind === 'other') return !/cpu|proc|gpu|accel|inlet|intake|exhaust|outlet|dimm|mem/.test(s);
  return true;
}

function ServerTempFinder({ vc, onServer }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const genRef = useRef(0);
  // 세대 가드: 고RTT vCenter에서 스코프를 빠르게 바꾸면 느린 이전 응답이 나중에 도착해 최신
  // 스코프 데이터를 덮어쓰던 경쟁을 막는다(가장 마지막 요청 결과만 반영).
  const load = () => { const g = ++genRef.current; return fetchJson(`/admin/idrac/temps${vcQS(vc)}`).then((r) => { if (g === genRef.current) { setD(r); setErr(null); } }).catch((e) => { if (g === genRef.current) setErr(e.message); }); };
  useEffect(() => { setD(null); load(); const t = setInterval(load, 30_000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [vc]);
  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const ql = q.trim().toLowerCase();
  const rows = (d.rows || []).filter((r) =>
    tempKindMatch(kind, r.sensor)
    && (!ql || [r.sensor, r.server, r.vcenterId, r.serviceTag].some((x) => String(x || '').toLowerCase().includes(ql))),
  );
  const avg = rows.length ? Math.round(rows.reduce((a, b) => a + b.celsius, 0) / rows.length) : null;
  return (
    <div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          서버 {d.sampledServers}/{d.totalServers} · 센서 <b style={{ color: 'var(--accent)' }}>{rows.length}</b>개
          {d.maxCelsius != null && <> · 최고 <b style={{ color: tempColor(d.maxCelsius) }}>{d.maxCelsius}℃</b></>}
          {avg != null && <> · 평균 {avg}℃</>}
          {d.missing > 0 && <span className="badge amber" style={{ marginLeft: 8 }}>미수집 {d.missing}대</span>}
        </div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <select className="select select-sm" value={kind} onChange={(e) => setKind(e.target.value)} style={{ minWidth: 130 }}>
            {TEMP_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <SearchBox className="input" style={{ maxWidth: 240 }} placeholder="서버/센서/서비스태그 검색" value={q} onChange={setQ} />
          <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={load}>↻</button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="card" style={{ padding: 16 }}><span className="muted">표시할 온도 데이터가 없습니다. 온도는 1분마다 수집되며, 등록된 iDRAC 서버가 켜져 있어야 합니다.</span></div>
      ) : (
        <DataTable
          rows={rows}
          initialSort={{ key: 'celsius', dir: 'desc' }}
          columns={[
            { key: 'server', label: '서버', render: (r) => <span><button className="cell-link" onClick={() => onServer(r)}>{r.server}</button>{r.serviceTag && <div className="muted" style={{ fontSize: 11 }}>{r.serviceTag}</div>}</span> },
            { key: 'vcenterId', label: 'vCenter', render: (r) => <span className="muted">{r.vcenterId || '—'}</span> },
            { key: 'sensor', label: '센서' },
            { key: 'celsius', label: '온도', align: 'right', render: (r) => <b style={{ color: tempColor(r.celsius) }}>{r.celsius}℃</b> },
            { key: 'at', label: '수집', sortValue: (r) => r.at, render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.at ? new Date(r.at).toLocaleTimeString('ko-KR', { hour12: false }) : '—'}</span> },
          ]} />
      )}
    </div>
  );
}

const FW_CAT_COLOR = { iDRAC: 'blue', BIOS: 'teal', NIC: 'green', HBA: 'amber', Storage: 'amber', GPU: 'green', PSU: 'gray', CPLD: 'gray', Disk: 'gray', Driver: 'gray', 기타: 'gray' };

/** 펌웨어 보기 — 서버 모델(R760/R770…) 클릭 → iDRAC·BIOS·NIC·HBA 등 버전별 설치 서버 수. */
function ServerFirmwareFinder({ vc }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [model, setModel] = useState(null);
  const genRef = useRef(0);
  const load = () => { const g = ++genRef.current; return fetchJson(`/admin/idrac/firmware-inventory${vcQS(vc)}`).then((r) => { if (g === genRef.current) { setD(r); setErr(null); } }).catch((e) => { if (g === genRef.current) setErr(e.message); }); };
  useEffect(() => { setD(null); load(); /* eslint-disable-next-line */ }, [vc]);
  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const sel = model && d.models.find((m) => m.model === model);
  return (
    <div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          서버 모델 <b style={{ color: 'var(--accent)' }}>{d.models.length}</b>종 · 서버 {d.collectedServers}/{d.totalServers} 수집됨 · <b>모델을 클릭</b>하면 iDRAC/BIOS/NIC/HBA 드라이버 버전별 설치 대수를 봅니다.
          {d.missing?.length > 0 && <span className="badge amber" style={{ marginLeft: 8 }} title={d.missing.map((x) => x.name).join(', ')}>미수집 {d.missing.length}대</span>}
        </div>
        <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={load}>↻ 새로고침</button>
      </div>

      {d.models.length === 0 ? (
        <div className="card" style={{ padding: 16 }}><span className="muted">수집된 iDRAC 인벤토리가 없습니다(30분마다 갱신). 전력 수집 › 상세 › 하드웨어/버전에서 “↻ 즉시 재수집”으로 채울 수 있습니다.</span></div>
      ) : (
        <>
          <div className="vc-grid" style={{ marginBottom: 16 }}>
            {d.models.map((m) => (
              <div key={m.model} className="card" style={{ cursor: 'pointer', borderColor: model === m.model ? 'var(--accent)' : undefined }} onClick={() => setModel(model === m.model ? null : m.model)}>
                <div style={{ fontSize: 26 }}>🖥</div>
                <div className="vc-name" style={{ marginTop: 6, fontSize: 14 }}>{m.model}</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--accent)', margin: '4px 0' }}>{m.serverCount}<span style={{ fontSize: 13, fontWeight: 400 }} className="muted"> 대</span></div>
                <div className="vc-foot"><span className="muted">{m.categories.length}개 구성요소</span><span className="muted">{model === m.model ? '▲' : '▼'}</span></div>
              </div>
            ))}
          </div>

          {sel && (
            <div className="card" style={{ padding: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>🖥 {sel.model} — {sel.serverCount}대</div>
              {sel.categories.map((c) => (
                <div key={c.category} style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                    <span className={`badge ${FW_CAT_COLOR[c.category] || 'gray'}`}>{c.category}</span>
                    <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>{c.versions.length}개 버전</span>
                  </div>
                  <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                    <thead><tr><th style={{ textAlign: 'left' }}>버전</th><th style={{ textAlign: 'right', width: 110 }}>설치 서버</th><th style={{ textAlign: 'left' }}>서버 목록</th></tr></thead>
                    <tbody>{c.versions.map((v) => (
                      <tr key={v.version}>
                        <td className="tabular"><b>{v.version}</b></td>
                        <td style={{ textAlign: 'right' }}><b style={{ color: 'var(--accent)' }}>{v.count}</b>대</td>
                        <td className="muted" style={{ fontSize: 12 }} title={v.servers.join(', ')}>{v.servers.slice(0, 8).join(', ')}{v.servers.length > 8 ? ` 외 ${v.servers.length - 8}대` : ''}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** GPU 찾기 — iDRAC 수집 GPU를 모델별로 집계(어떤 모델 몇 장, 어느 서버). */
function ServerGpuFinder({ vc, onServer }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // 펼친 모델
  const genRef = useRef(0);
  const load = () => { const g = ++genRef.current; return fetchJson(`/admin/idrac/gpu-inventory${vcQS(vc)}`).then((r) => { if (g === genRef.current) { setD(r); setErr(null); } }).catch((e) => { if (g === genRef.current) setErr(e.message); }); };
  useEffect(() => { setD(null); load(); /* eslint-disable-next-line */ }, [vc]);
  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const ql = q.trim().toLowerCase();
  const models = ql ? d.models.filter((m) => m.model.toLowerCase().includes(ql)
    || (m.servers || []).some((s) => (s.serviceTag || '').toLowerCase().includes(ql) || (s.name || '').toLowerCase().includes(ql))) : d.models;
  return (
    <div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 13 }}>
GPU <b style={{ color: 'var(--accent)' }}>{d.totalGpus}</b>장 · <b>{d.models.length}</b>종 · iDRAC {d.collectedServers}/{d.totalServers}{d.physicalServers ? ` · 물리 ${d.physicalServers}대` : ''}
          {d.missing?.length > 0 && <span className="badge amber" style={{ marginLeft: 8 }} title={d.missing.map((x) => x.name).join(', ')}>미수집 {d.missing.length}대</span>}
        </div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <SearchBox className="input" style={{ maxWidth: 260 }} placeholder="GPU 모델 / 서비스태그 검색" value={q} onChange={setQ} />
          <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={load}>↻ 새로고침</button>
        </div>
      </div>

      {d.totalGpus === 0 ? (
        <div className="card" style={{ padding: 16 }}>
          <span className="muted">iDRAC에서 수집된 GPU가 없습니다. iDRAC 인벤토리는 30분마다 갱신되며, 각 서버의 <b>전력 수집 › 상세 › GPU 수집 확인</b>에서 즉시 확인할 수 있습니다. (패스쓰루로 게스트에 직접 할당된 GPU는 iDRAC에 안 보일 수 있습니다.)</span>
        </div>
      ) : (
        <>
          <div className="vc-grid" style={{ marginBottom: 16 }}>
            {models.map((m) => (
              <div key={m.model} className="card" style={{ cursor: 'pointer', borderColor: open === m.model ? 'var(--accent)' : undefined }} onClick={() => setOpen(open === m.model ? null : m.model)}>
                <div style={{ fontSize: 28 }}>🎮</div>
                <div className="vc-name" style={{ marginTop: 6, fontSize: 14 }}>{m.model}</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--accent)', margin: '4px 0' }}>{m.count}<span style={{ fontSize: 13, fontWeight: 400 }} className="muted"> 장</span></div>
                <div className="vc-foot"><span className="muted">서버 {m.serverCount}대</span><span className="muted">{open === m.model ? '▲' : '▼'}</span></div>
              </div>
            ))}
          </div>
          {open && (() => {
            const m = d.models.find((x) => x.model === open);
            if (!m) return null;
            return (
              <div className="card" style={{ padding: 14, marginBottom: 14 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>🎮 {m.model} — {m.count}장 / {m.serverCount}대 서버</div>
                <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                  <thead><tr><th style={{ textAlign: 'left' }}>서버</th><th style={{ textAlign: 'left' }}>서비스태그</th><th style={{ textAlign: 'left' }}>소속 vCenter</th><th style={{ textAlign: 'right' }}>장수</th></tr></thead>
                  <tbody>{m.servers.map((s) => (
                    <tr key={s.id + (s.source || '')}><td>{s.source === 'physical' ? <span>{s.name} <span className="badge gray" style={{ fontSize: 10 }}>물리</span></span> : <button className="cell-link" onClick={() => onServer(s)}>{s.name}</button>} <span className="muted" style={{ fontSize: 11 }}>({s.host || s.id})</span></td>
                      <td className="tabular">{s.serviceTag || '—'}</td>
                      <td className="muted">{s.vcenterId || '—'}</td>
                      <td style={{ textAlign: 'right' }}><b>{s.count}</b></td></tr>
                  ))}</tbody>
                </table>
              </div>
            );
          })()}
          <DataTable
            rows={models}
            initialSort={{ key: 'count', dir: 'desc' }}
            columns={[
              { key: 'model', label: 'GPU 모델', render: (r) => <button className="cell-link" onClick={() => setOpen(open === r.model ? null : r.model)}>{r.model}</button> },
              { key: 'count', label: '장수', align: 'right', render: (r) => <b style={{ color: 'var(--accent)' }}>{r.count}</b> },
              { key: 'serverCount', label: '서버 수', align: 'right' },
              { key: 'servers', label: '서버', sortValue: (r) => r.serverCount, render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.servers.slice(0, 6).map((s) => `${s.name}${s.count > 1 ? `×${s.count}` : ''}`).join(', ')}{r.servers.length > 6 ? ` 외 ${r.servers.length - 6}대` : ''}</span> },
            ]} />
        </>
      )}
    </div>
  );
}

export function Hba({ scope }) {
  const { loading, data, error } = useTool('/tools/hba', scope ? { vcenterId: scope } : {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const cols = [
    { key: 'host', label: '호스트', render: (h) => <b>{h.host}</b> },
    { key: 'vcenterId', label: 'vCenter', render: (h) => <span className="muted">{h.vcenterId}</span> },
    { key: 'name', label: '어댑터' },
    { key: 'type', label: '유형', render: (h) => <span className="badge gray">{h.type}</span> },
    { key: 'model', label: '모델', render: (h) => <span className="muted">{h.model}</span> },
    { key: 'speedGbps', label: '속도', align: 'right', render: (h) => <b style={{ color: h.speedGbps >= 32 ? 'var(--green)' : h.speedGbps >= 16 ? 'var(--text)' : 'var(--amber)' }}>{h.speedGbps} Gb</b> },
    { key: 'wwn', label: 'WWN', render: (h) => <span className="muted" style={{ fontSize: 11 }}>{h.wwn || '—'}</span> },
  ];
  return (
    <>
      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        <Card label="HBA 어댑터" value={data.adapters} meta={`호스트 ${data.hostsWithHba}`} />
        {data.speedDistribution.map((s) => <span key={s.speed} className="badge blue" style={{ alignSelf: 'center', fontSize: 13, padding: '4px 10px' }}>{s.speed} · {s.count}</span>)}
      </div>
      <DataTable columns={cols} rows={data.items} initialSort={{ key: 'speedGbps', dir: 'asc' }} />
    </>
  );
}
