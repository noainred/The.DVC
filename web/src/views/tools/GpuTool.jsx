// GpuTool.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState, useRef } from 'react';
import { fetchJson, postJson, getToken } from '../../api.js';
import { DataTable, Loading, ErrorBox, UsageCell, Modal, VmLink } from '../../components/ui.jsx';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Brush } from 'recharts';
import { Card, fmtTrendTick, saveResponseAsFile, useTool } from './shared.jsx';


const GPU_MODE = { vgpu: ['vGPU', 'green'], passthrough: ['패스쓰루', 'amber'], vsga: ['vSGA', 'blue'] };
function GpuModeBadge({ mode, modes }) {
  const [label, cls] = GPU_MODE[mode] || ['—', 'gray'];
  // 한 호스트에 모드가 섞여 있으면 보조 표기.
  const extra = modes ? Object.entries(modes).filter(([k]) => k !== mode) : [];
  return (
    <span>
      <span className={`badge ${cls}`}>{label}</span>
      {extra.map(([k, n]) => <span key={k} className={`badge ${GPU_MODE[k]?.[1] || 'gray'}`} style={{ marginLeft: 4, opacity: 0.8 }}>{GPU_MODE[k]?.[0] || k} {n}</span>)}
    </span>
  );
}

/** VM의 GPU 사용 방식 배지(혼합이면 vGPU/패스쓰루 장수 분리 표기). */
function VmGpuModeBadge({ gpu }) {
  if (!gpu) return <span className="muted">—</span>;
  if (gpu.type === 'mixed') return <span><span className="badge green">vGPU {gpu.vgpu}</span> <span className="badge amber" style={{ marginLeft: 4 }}>패스쓰루 {gpu.passthrough}</span></span>;
  const [l, c] = GPU_MODE[gpu.type] || ['—', 'gray'];
  return <span className={`badge ${c}`}>{l}</span>;
}

/** GPU가 할당된 VM 목록 모달 — 어떤 VM이 어떤 방식·프로파일로 GPU를 쓰는지. */
function GpuVmsModal({ title, params, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v)).toString();
    fetchJson(`/tools/gpu/vms${qs ? `?${qs}` : ''}`).then(setD).catch((e) => setErr(e.message));
  }, []);
  return (
    <Modal title={title} onClose={onClose} width={1000} resizable minWidth={560} minHeight={380}>
      {err ? <ErrorBox message={err} /> : !d ? <Loading /> : (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>GPU 할당 VM <b>{d.total}</b>개 · 어떤 VM이 어떤 방식/프로파일로 GPU를 사용하는지 보여줍니다. <span style={{ opacity: 0.8 }}>사용률·메모리는 게스트 OS(nvidia-smi) 수집값 — 전원 ON·VMware Tools·GPU 게스트 수집 계정이 있어야 표시됩니다(패스쓰루·vGPU 공통).</span></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>VM</th><th>법인</th><th>호스트</th><th>GPU 모델</th><th>사용 방식</th><th>프로파일</th><th style={{ textAlign: 'right' }}>장수</th><th style={{ textAlign: 'right' }}>사용률</th><th style={{ textAlign: 'right' }}>메모리</th><th>전원</th></tr></thead>
              <tbody>
                {d.vms.length === 0 && <tr><td colSpan={10} className="center muted" style={{ padding: 20 }}>GPU 할당 VM이 없습니다.</td></tr>}
                {d.vms.map((v) => (
                  <tr key={v.id}>
                    <td><VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /></td>
                    <td className="muted">{v.vcenterId}</td>
                    <td className="muted" style={{ fontSize: 12, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.host || ''}>{v.host || '—'}</td>
                    <td style={{ fontSize: 12 }}>{v.model || '—'}</td>
                    <td><VmGpuModeBadge gpu={v.gpu} /></td>
                    <td className="muted" style={{ fontSize: 12 }}>{v.gpu?.profile || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{v.gpu?.count ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>{v.guestUtilPct == null ? <span className="muted" title={v.powerState === 'POWERED_ON' ? 'GPU 게스트 수집 미설정/미수집 — 설정 › GPU 게스트 수집에서 해당 VM 계정 등록 후 수집됩니다' : '전원 OFF — 게스트에서 사용률 수집 불가'}>—</span> : <UsageCell pct={v.guestUtilPct} />}</td>
                    <td style={{ textAlign: 'right' }}>{v.guestMemPct == null ? <span className="muted" title={v.powerState === 'POWERED_ON' ? 'GPU 게스트 수집 미설정/미수집 — 설정 › GPU 게스트 수집에서 계정 등록 후 수집됩니다' : '전원 OFF — 수집 불가'}>—</span> : <UsageCell pct={v.guestMemPct} />}</td>
                    <td>{v.powerState === 'POWERED_ON' ? <span className="badge green">On</span> : <span className="badge gray">Off</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

export function Gpu({ scope }) {
  const [bust, setBust] = useState(0);       // '지금 수집' 후 재조회 트리거
  const [collecting, setCollecting] = useState(false);
  const { loading, data, error } = useTool('/tools/gpu', { ...(scope ? { vcenterId: scope } : {}), _b: bust });
  const collectNow = async () => {
    setCollecting(true);
    try { await postJson('/admin/gpu/collect-util', {}); } catch { /* best effort */ }
    setCollecting(false); setBust((b) => b + 1);
  };
  const [exportOpen, setExportOpen] = useState(false);
  // 현재 상태(스냅샷) CSV·JSON 내려받기(vCenter 스코프 반영, zip 인식).
  const exportGpu = async (fmt, vcId) => {
    const vc = vcId ?? scope;
    const q = vc ? `?vcenterId=${encodeURIComponent(vc)}` : '';
    const res = await fetch(`/api/tools/gpu.${fmt}${q}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    await saveResponseAsFile(res, `gpu-${new Date().toISOString().slice(0, 10)}.${fmt}`);
  };
  const [view, setView] = useState('host'); // host | cluster | vc | model
  const [hist, setHist] = useState(null);   // { level, key, days, points, synthesized }
  const [vmList, setVmList] = useState(null); // { title, params } for GpuVmsModal
  const [days, setDays] = useState(7);
  const histGen = useRef(0); // 세대 가드 — 늦은 응답의 모달 재오픈/다른 대상 덮어쓰기 방지
  const openHist = async (level, key) => {
    const gen = ++histGen.current;
    setHist({ level, key, loading: true });
    const r = await fetchJson(`/tools/gpu/history?level=${level}&key=${encodeURIComponent(key)}&days=${days}`).catch(() => null);
    if (gen !== histGen.current) return;
    setHist(r ? { ...r } : { error: true });
  };
  const closeHist = () => { histGen.current++; setHist(null); };
  const [mode, setMode] = useState(''); // '' | vgpu | passthrough | vsga
  const [modelFilter, setModelFilter] = useState(''); // '' = 전체 모델, 아니면 특정 GPU 모델
  const [power, setPower] = useState(''); // '' | on(켜진 VM 있는 호스트) | off(꺼진 VM 있는 호스트)
  useEffect(() => { if (hist && hist.key) openHist(hist.level, hist.key); /* eslint-disable-next-line */ }, [days]);
  // 선택한 사용 방식(mode) 필터에 해당하는 GPU가 0개면 '전체'로 자동 복구(빈 표 혼란 방지).
  useEffect(() => { if (data && mode && (data.byMode?.[mode] ?? 0) === 0) setMode(''); }, [data, mode]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;

  let items = mode ? data.items.filter((h) => h.mode === mode) : data.items;
  if (modelFilter) items = items.filter((h) => h.model === modelFilter);
  // 전원 필터: 켜진/꺼진 GPU 할당 VM이 있는 호스트만.
  if (power === 'on') items = items.filter((h) => (h.assignedVmsOn || 0) > 0);
  else if (power === 'off') items = items.filter((h) => (h.assignedVmsOff || 0) > 0);

  // Aggregate by cluster / vCenter from per-host items. 사용률 미보고(패스쓰루) 호스트도
  // GPU 장수·할당 VM·방식 집계에는 포함하고, 평균/최고 사용률만 보고 호스트로 계산한다.
  const aggregate = (keyFn, labelFn) => {
    const m = new Map();
    for (const h of items) {
      const k = keyFn(h);
      const g = m.get(k) || { key: k, name: labelFn(h), hosts: 0, sum: 0, util: 0, max: 0, gpus: 0, assignedVms: 0, modes: {}, models: {} };
      g.hosts++; g.gpus += h.count; g.assignedVms += h.assignedVms || 0;
      g.models[h.model] = (g.models[h.model] || 0) + h.count;
      for (const [md, n] of Object.entries(h.modes || {})) g.modes[md] = (g.modes[md] || 0) + n;
      if (h.utilPct != null) { g.util++; g.sum += h.utilPct; g.max = Math.max(g.max, h.utilPct); }
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({
      key: g.key, name: g.name, hosts: g.hosts, gpus: g.gpus, assignedVms: g.assignedVms, modes: g.modes, models: g.models,
      sub: `${g.hosts} 호스트 · GPU ${g.gpus}`, avg: g.util ? Math.round(g.sum / g.util) : null, max: g.max, level: view,
    }));
  };

  const hostRows = items.map((h) => ({
    key: h.id, name: h.host, vcenterId: h.vcenterId, sub: `${h.vcenterId} / ${h.cluster || '-'} · ${h.model}`,
    model: h.model, count: h.count, memGB: h.memGB, mode: h.mode, modes: h.modes, utilSource: h.utilSource, avg: h.utilPct, max: h.utilPct, util: h.utilPct, assignedVms: h.assignedVms || 0, assignedVmsOn: h.assignedVmsOn || 0, assignedVmsOff: h.assignedVmsOff || 0, assignedVmNames: h.assignedVmNames || [], level: 'host',
  }));
  // 법인 × GPU 모델별 수량 집계: 어떤 법인에 어떤 GPU 카드가 몇 장 설치됐는지.
  const modelAgg = () => {
    const m = new Map();
    for (const h of items) {
      const k = `${h.vcenterId}|${h.model}`;
      const g = m.get(k) || { key: k, vcenterId: h.vcenterId, model: h.model, gpus: 0, hosts: 0, assignedVms: 0, memGB: h.memGB || 0, modeSet: new Set() };
      g.gpus += h.count; g.hosts++; g.assignedVms += h.assignedVms || 0; if (h.mode) g.modeSet.add(h.mode); g.memGB = Math.max(g.memGB, h.memGB || 0); m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, modes: [...g.modeSet] }));
  };

  const rows = view === 'host' ? hostRows
    : view === 'cluster' ? aggregate((h) => `${h.vcenterId}|${h.cluster || 'standalone'}`, (h) => `${h.vcenterId} / ${h.cluster || 'standalone'}`)
      : view === 'model' ? modelAgg()
        : aggregate((h) => h.vcenterId, (h) => h.vcenterId);

  const hostCols = [
    { key: 'name', label: '호스트', render: (r) => <button className="cell-link" onClick={() => openHist('host', r.key)}>{r.name}</button> },
    { key: 'vcenterId', label: 'vCenter', render: (r) => <span className="muted">{r.vcenterId}</span> },
    { key: 'model', label: 'GPU 모델' },
    { key: 'count', label: '개수', align: 'right' },
    { key: 'memGB', label: 'VRAM', align: 'right', render: (r) => `${r.memGB} GB` },
    { key: 'mode', label: '사용 방식', sortValue: (r) => r.mode, render: (r) => <GpuModeBadge mode={r.mode} modes={r.modes} /> },
    { key: 'util', label: '사용률', render: (r) => (r.util == null ? <span className="muted">—</span>
      : <span className="flex gap" style={{ alignItems: 'center' }}><UsageCell pct={r.util} />{r.utilSource === 'guest' && <span className="badge gray" style={{ fontSize: 10 }} title="게스트 OS에서 수집(패스쓰루)">게스트</span>}</span>) },
    { key: 'assignedVms', label: '할당 VM', sortValue: (r) => r.assignedVms, render: (r) => (r.assignedVms ? (
      <div style={{ minWidth: 160 }}>
        <button className="cell-link" onClick={() => setVmList({ title: `GPU 할당 VM — ${r.name}`, params: { host: r.name } })}>{r.assignedVms}대</button>
        <span className="muted" style={{ fontSize: 11, marginLeft: 6 }} title="GPU 할당 VM의 전원 상태">🟢{r.assignedVmsOn || 0} ⚫{r.assignedVmsOff || 0}</span>
        {(r.assignedVmNames || []).length > 0 && (
          <div className="muted" style={{ fontSize: 11, marginTop: 2, lineHeight: 1.5, whiteSpace: 'normal', wordBreak: 'break-all' }} title={(r.assignedVmNames || []).map((x) => `${x.name || x} ${(x.on ?? true) ? '(On)' : '(Off)'}`).join(', ')}>
            {(r.assignedVmNames || []).slice(0, 6).map((x, i) => {
              const nm = x.name || x; const on = x.on ?? true;
              return (
                <span key={i}>{i > 0 && ', '}<span title={on ? 'On' : 'Off'} style={{ color: on ? 'var(--green)' : 'var(--text-faint)' }}>{on ? '🟢' : '⚫'}</span> <VmLink name={nm} vcenterId={r.vcenterId} label={nm} /></span>
              );
            })}
            {(r.assignedVmNames || []).length > 6 && <span> 외 {(r.assignedVmNames || []).length - 6}대</span>}
          </div>
        )}
      </div>
    ) : <span className="muted">0</span>) },
    { key: 'hist', label: '추이', render: (r) => <button className="tab" onClick={() => openHist('host', r.key)}>5년 추이</button> },
  ];
  const aggCols = [
    { key: 'name', label: '클러스터', render: (r) => <button className="cell-link" onClick={() => openHist(r.level, r.key)}>{r.name}</button> },
    { key: 'sub', label: '구분', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.sub}</span> },
    { key: 'avg', label: '평균 사용률', render: (r) => (r.avg == null ? <span className="muted">—</span> : <UsageCell pct={r.avg} />) },
    { key: 'max', label: '최고 %', align: 'right', render: (r) => <b>{r.max}%</b> },
    { key: 'hist', label: '추이', render: (r) => <button className="tab" onClick={() => openHist(r.level, r.key)}>5년 추이</button> },
  ];
  // 법인별: 법인에 GPU가 몇 장·어떤 방식·할당 VM 몇 개.
  const vcCols = [
    { key: 'name', label: '법인(vCenter)', render: (r) => <button className="cell-link" onClick={() => openHist(r.level, r.key)}>{r.name}</button> },
    { key: 'gpus', label: 'GPU 장수', align: 'right', render: (r) => <b style={{ color: 'var(--accent)' }}>{r.gpus}</b> },
    { key: 'models', label: 'GPU 종류(장수)', sortValue: (r) => Object.keys(r.models || {}).length, render: (r) => Object.entries(r.models || {}).sort((a, b) => b[1] - a[1]).map(([md, n]) => <span key={md} className="badge gray" style={{ marginRight: 4, marginBottom: 2, display: 'inline-block' }}>{md} <b style={{ color: 'var(--accent)' }}>×{n}</b></span>) },
    { key: 'hosts', label: '호스트', align: 'right' },
    { key: 'modes', label: '사용 방식', sortValue: (r) => Object.keys(r.modes || {}).join(','), render: (r) => Object.entries(r.modes || {}).map(([m, n]) => <span key={m} className={`badge ${GPU_MODE[m]?.[1] || 'gray'}`} style={{ marginRight: 4 }}>{GPU_MODE[m]?.[0] || m} {n}</span>) },
    { key: 'assignedVms', label: '할당 VM', align: 'right', render: (r) => (r.assignedVms ? <button className="cell-link" onClick={() => setVmList({ title: `GPU 할당 VM — ${r.name}`, params: { vcenterId: r.key } })}>{r.assignedVms}</button> : <span className="muted">0</span>) },
    { key: 'avg', label: '평균 사용률', render: (r) => (r.avg == null ? <span className="muted">—</span> : <UsageCell pct={r.avg} />) },
  ];
  // 법인·모델별: 어떤 법인에 어떤 GPU 카드가 몇 장·할당 VM 몇 개.
  const modelCols = [
    { key: 'vcenterId', label: '법인(vCenter)', render: (r) => <b>{r.vcenterId}</b> },
    { key: 'model', label: 'GPU 모델' },
    { key: 'gpus', label: 'GPU 장수', align: 'right', render: (r) => <b style={{ color: 'var(--accent)' }}>{r.gpus}</b> },
    { key: 'hosts', label: '호스트 수', align: 'right' },
    { key: 'memGB', label: 'VRAM', align: 'right', render: (r) => `${r.memGB} GB` },
    { key: 'modes', label: '사용 방식', sortValue: (r) => (r.modes || []).join(','), render: (r) => (r.modes || []).map((m) => <GpuModeBadge key={m} mode={m} />) },
    { key: 'assignedVms', label: '할당 VM', align: 'right', render: (r) => (r.assignedVms ? <button className="cell-link" onClick={() => setVmList({ title: `GPU 할당 VM — ${r.vcenterId} · ${r.model}`, params: { vcenterId: r.vcenterId, model: r.model } })}>{r.assignedVms}</button> : <span className="muted">0</span>) },
  ];

  return (
    <>
      {/* 상단 요약 — 선택 범위에서 몇 개 호스트의 몇 개 VM이 GPU를 사용하는지 한눈에 */}
      <div className="card" style={{ padding: '12px 16px', marginBottom: 14, borderLeft: '3px solid var(--accent,#2563eb)' }}>
        <span style={{ fontSize: 15 }}>
          <b style={{ color: 'var(--accent)' }}>{scope || '전체'}</b> 범위 —
          GPU 호스트 <b>{data.hostsWithGpu}</b>대에서 VM <b>{data.gpuVmCount ?? 0}</b>대가 GPU 사용 중
          <span className="muted" style={{ fontSize: 13 }}>{' '}(총 GPU {data.totalGpus}장 · vGPU {data.byMode?.vgpu ?? 0} · 패스쓰루 {data.byMode?.passthrough ?? 0})</span>
        </span>
      </div>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label={`${scope || '전체'} 범위 · 총 GPU`} value={data.totalGpus} accent="var(--accent)" meta={`설치된 GPU 장수`} />
        <Card label="GPU 호스트" value={data.hostsWithGpu} accent="var(--accent-2)" meta="GPU 설치 ESXi 호스트" />
        <Card label="GPU 사용 VM" value={data.gpuVmCount ?? 0} accent="var(--green)" meta="GPU 할당된 VM 수" />
        <Card label="평균 GPU 사용률" value={data.avgUtilPct == null ? '—' : `${data.avgUtilPct}%`} meta={data.utilReporting ? `${data.utilReporting} 호스트 보고` : '사용률 미보고'} />
        <Card label="vGPU" value={data.byMode?.vgpu ?? 0} accent="var(--green)" meta="공유 다이렉트(GRID)" />
        <Card label="패스쓰루" value={data.byMode?.passthrough ?? 0} accent="var(--amber)" meta="DirectPath I/O" />
        {(data.byMode?.vsga ?? 0) > 0 && <Card label="vSGA" value={data.byMode.vsga} meta="공유(소프트)" />}
      </div>
      {/* GPU 모델(종류)별 총 장수 합계 — 클릭하면 그 GPU가 설치된 호스트만 표시 */}
      {(data.byModel || []).length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>GPU 모델별 합계 (총 {data.totalGpus}장 · {data.byModel.length}종) <span style={{ opacity: 0.8 }}>— 박스를 클릭하면 해당 GPU 설치 호스트만 봅니다</span></div>
          <div className="flex gap wrap">
            {data.byModel.map((m) => {
              const active = view === 'host' && modelFilter === m.model;
              const pick = () => { if (active) { setModelFilter(''); } else { setView('host'); setModelFilter(m.model); } };
              return (
                <div key={m.model} role="button" tabIndex={0} onClick={pick}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}
                  className="card" title={active ? '필터 해제' : `${m.model} 설치 호스트만 보기`}
                  style={{ padding: '8px 14px', minWidth: 120, flex: 'none', cursor: 'pointer',
                    outline: active ? '2px solid var(--accent)' : 'none', outlineOffset: -1 }}>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>{m.model}{active && ' ✕'}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent)' }}>{m.count}<small style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-dim)' }}> 장</small></div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>※ vGPU/vSGA는 ESXi가 사용률을 보고하지만, <b>패스쓰루(DirectPath I/O)</b>는 게스트 OS가 GPU를 직접 소유해 ESXi에서 사용률을 볼 수 없습니다(설정 › GPU 게스트 수집에서 게스트 OS 수집을 켜면 표시). 이름을 클릭하면 최근 5년 추이를 봅니다.</div>
      {data.items.length === 0 ? <div className="card"><span className="muted">GPU가 설치된 호스트가 없습니다.</span></div> : (
        <>
          <div className="flex gap wrap" style={{ marginBottom: 8 }}>
            {[['host', '호스트별'], ['cluster', '클러스터별'], ['vc', '법인별'], ['model', '법인·모델별']].map(([k, l]) => (
              <button key={k} className={view === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView(k)}>{l}</button>
            ))}
            <span style={{ width: 12 }} />
            {[['', '전체'], ['vgpu', 'vGPU'], ['passthrough', '패스쓰루'], ['vsga', 'vSGA']].map(([k, l]) => {
              const cnt = k ? (data.byMode?.[k] ?? 0) : data.totalGpus;
              const off = !!k && cnt === 0;
              return (
                <button key={k || 'all'} className={mode === k ? 'login-btn' : 'tab'} disabled={off}
                  style={{ flex: 'none', padding: '7px 12px', opacity: off ? 0.45 : 1, cursor: off ? 'not-allowed' : 'pointer' }}
                  title={off ? `${l} GPU가 없습니다` : ''} onClick={() => { if (!off) setMode(k); }}>
                  {l} <b style={{ opacity: 0.7 }}>{cnt}</b>
                </button>
              );
            })}
            <span style={{ width: 8 }} />
            <select className="select" style={{ flex: 'none', maxWidth: 240 }} value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} title="GPU 종류(모델)별로 보기">
              <option value="">GPU 종류: 전체</option>
              {(data.byModel || []).map((m) => <option key={m.model} value={m.model}>{m.model} (×{m.count})</option>)}
            </select>
            <select className="select" style={{ flex: 'none', maxWidth: 220 }} value={power} onChange={(e) => setPower(e.target.value)} title="GPU 할당 VM의 전원 상태로 호스트 필터">
              <option value="">전원: 전체</option>
              <option value="on">🟢 켜진 VM 있는 호스트</option>
              <option value="off">⚫ 꺼진 VM 있는 호스트</option>
            </select>
            <button className="logout-btn" style={{ flex: 'none', padding: '7px 12px', marginLeft: 'auto' }} disabled={collecting}
              onClick={collectNow} title="vCenter 성능 카운터(gpu.utilization)로 지금 사용률을 즉시 수집합니다(설정 주기 무시).">{collecting ? '수집 중…' : '⟳ 지금 수집'}</button>
            <button className="logout-btn" style={{ flex: 'none', padding: '7px 12px' }}
              onClick={() => setVmList({ title: `GPU 할당 VM${modelFilter ? ` — ${modelFilter}` : ' 전체'}`, params: { ...(scope ? { vcenterId: scope } : {}), ...(mode ? { mode } : {}), ...(modelFilter ? { model: modelFilter } : {}) } })}>🎮 GPU 할당 VM 보기</button>
            <button className="logout-btn" style={{ flex: 'none', padding: '7px 12px' }} onClick={() => setExportOpen(true)} title="수집된 GPU 사용률 데이터(전체/기간)를 CSV·JSON으로 내려받기.">⬇ 내보내기</button>
          </div>
          {view === 'model' && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>법인별로 설치된 GPU 카드 모델·장수·할당 VM 수입니다(같은 법인·같은 모델은 합산). <b>할당 VM</b> 숫자를 클릭하면 해당 VM 목록과 사용 방식을 봅니다.</div>}
          {view === 'vc' && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>법인별 GPU 장수·사용 방식·할당 VM 수입니다. <b>할당 VM</b> 숫자를 클릭하면 VM별 사용 방식을 봅니다.</div>}
          {rows.length === 0 && data.items.length > 0 ? (
            <div className="card" style={{ padding: 16 }}>
              <span className="muted">현재 필터에 해당하는 GPU 호스트가 없습니다{mode ? ` (사용 방식: ${{ vgpu: 'vGPU', passthrough: '패스쓰루', vsga: 'vSGA' }[mode] || mode})` : ''}{modelFilter ? ` (모델: ${modelFilter})` : ''}. GPU는 총 {data.totalGpus}장 있습니다.</span>
              <button className="tab" style={{ marginLeft: 10, padding: '4px 10px' }} onClick={() => { setMode(''); setModelFilter(''); setPower(''); }}>필터 초기화</button>
            </div>
          ) : (
            <DataTable
              columns={view === 'host' ? hostCols : view === 'model' ? modelCols : view === 'vc' ? vcCols : aggCols}
              rows={rows}
              initialSort={{ key: (view === 'host' || view === 'model' || view === 'vc') ? (view === 'host' ? 'count' : 'gpus') : 'avg', dir: 'desc' }} />
          )}
        </>
      )}

      {hist && (
        <Modal title={`GPU 사용률 추이 — ${hist.key || ''}`} onClose={closeHist} width={760}>
          <div className="flex gap" style={{ marginBottom: 10 }}>
            {[[1, '1일'], [7, '1주'], [30, '1달'], [365, '1년'], [1830, '5년']].map(([d, l]) => (
              <button key={d} className={days === d ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} onClick={() => setDays(d)}>{l}</button>
            ))}
            {hist.synthesized && <span className="badge amber" style={{ alignSelf: 'center' }}>데모 합성</span>}
          </div>
          {hist.loading ? <Loading /> : hist.error ? <ErrorBox message="이력을 불러오지 못했습니다." /> : (hist.points || []).length === 0
            ? <div className="muted">해당 기간 데이터가 없습니다(수집 누적 후 표시).</div>
            : (
              <>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={(hist.points || []).map((p) => ({ t: fmtTrendTick(p.ts, days), avg: p.avg, max: p.max }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                    <XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={40} />
                    <YAxis tick={{ fontSize: 11 }} unit="%" domain={[0, 100]} allowDataOverflow />
                    <Tooltip contentStyle={{ background: '#0b1220', border: '1px solid #243049', fontSize: 12 }} />
                    <Line type="monotone" dataKey="avg" stroke="#a78bfa" dot={false} name="평균" isAnimationActive={false} />
                    <Line type="monotone" dataKey="max" stroke="#f59e0b" dot={false} name="최고" isAnimationActive={false} />
                    <Brush dataKey="t" height={22} stroke="#6366f1" travellerWidth={8} tickFormatter={() => ''} />
                  </LineChart>
                </ResponsiveContainer>
                <div className="muted" style={{ fontSize: 11, marginTop: 4, textAlign: 'center' }}>아래 막대를 드래그하면 구간을 좁혀 스크롤·확대해 볼 수 있습니다.</div>
              </>
            )}
        </Modal>
      )}
      {vmList && <GpuVmsModal title={vmList.title} params={vmList.params} onClose={() => setVmList(null)} />}
      {exportOpen && <GpuExportModal scope={scope} onClose={() => setExportOpen(false)} onSnapshot={exportGpu} />}
    </>
  );
}

/** GPU 데이터 내보내기 — 수집 시작 일시 안내 + 전체/기간 선택 + CSV/JSON. */
function GpuExportModal({ scope, onClose, onSnapshot }) {
  const [meta, setMeta] = useState(null);   // { collectedSince, latestAt, sampleCount }
  const [range, setRange] = useState('all'); // all | days
  const [days, setDays] = useState(30);
  const [vc, setVc] = useState(scope || ''); // 내보낼 vCenter(빈값=전체)
  const [vcs, setVcs] = useState([]);
  useEffect(() => { fetchJson('/vcenters').then((d) => setVcs(d || [])).catch(() => {}); }, []);
  useEffect(() => {
    const q = vc ? `?vcenterId=${encodeURIComponent(vc)}` : '';
    fetchJson(`/tools/gpu/series-meta${q}`).then(setMeta).catch(() => setMeta({ collectedSince: null, sampleCount: 0 }));
  }, [vc]);
  const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : null);
  const sinceTxt = meta && meta.collectedSince
    ? `${fmtTs(meta.collectedSince)} 부터 데이터가 쌓여 있습니다`
    : (meta ? '아직 수집된 GPU 사용률 이력이 없습니다(샘플러가 한 주기 이상 돌면 생성됩니다)' : '확인 중…');
  const daysSince = meta && meta.collectedSince ? Math.max(1, Math.round((Date.now() - meta.collectedSince) / 86_400_000)) : null;
  const download = async (fmt) => {
    const params = new URLSearchParams();
    if (vc) params.set('vcenterId', vc);
    params.set('range', range);
    if (range === 'days') params.set('days', String(days));
    const res = await fetch(`/api/tools/gpu/export.${fmt}?${params.toString()}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    await saveResponseAsFile(res, `gpu-history-${range}-${new Date().toISOString().slice(0, 10)}.${fmt}`);
  };
  return (
    <Modal title="GPU 데이터 내보내기" onClose={onClose} width={560}>
      <div className="card" style={{ padding: 12, marginBottom: 14, borderLeft: '3px solid var(--accent,#2563eb)' }}>
        <div style={{ fontSize: 13 }}>📅 <b>수집 시작</b>: {sinceTxt}</div>
        {meta && meta.collectedSince && (
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            총 {daysSince}일 누적 · 샘플 {meta.sampleCount?.toLocaleString?.() ?? meta.sampleCount}개{meta.latestAt ? ` · 마지막 ${fmtTs(meta.latestAt)}` : ''}
          </div>
        )}
      </div>

      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>법인(vCenter) 선택</div>
      <select className="select" value={vc} onChange={(e) => setVc(e.target.value)} style={{ minWidth: 220, marginBottom: 12 }}>
        <option value="">전체 vCenter</option>
        {vcs.map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
      </select>

      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>내보낼 범위</div>
      <label className="flex gap" style={{ alignItems: 'center', marginBottom: 6, cursor: 'pointer' }}>
        <input type="radio" name="gpuexp" checked={range === 'all'} onChange={() => setRange('all')} />
        <span><b>전체 수집 데이터</b> — 수집 시작일부터 현재까지 모두</span>
      </label>
      <label className="flex gap" style={{ alignItems: 'center', marginBottom: 6, cursor: 'pointer' }}>
        <input type="radio" name="gpuexp" checked={range === 'days'} onChange={() => setRange('days')} />
        <span>기간 지정 — 최근
          <input className="input" type="number" min={1} max={1830} value={days} disabled={range !== 'days'}
            onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 30))} style={{ width: 80, margin: '0 6px' }} /> 일
        </span>
      </label>

      <div className="flex gap" style={{ marginTop: 16, alignItems: 'center' }}>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => download('csv')}>⬇ CSV 내보내기</button>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => download('json')}>⬇ JSON 내보내기</button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 12, borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 10 }}>
        시계열(샘플마다 한 행)로 내보냅니다. 현재 상태(호스트별 1행 스냅샷)만 필요하면&nbsp;
        <button className="cell-link" onClick={() => onSnapshot('csv', vc)}>스냅샷 CSV</button> ·&nbsp;
        <button className="cell-link" onClick={() => onSnapshot('json', vc)}>스냅샷 JSON</button>
        <div style={{ marginTop: 6 }}>💡 파일 용량이 1MB를 넘으면 자동으로 <b>zip</b>으로 압축해 내려받습니다. · <b>gpu_util_pct</b>=GPU 사용률(0~100%) · <b>epoch_ms</b>=Unix 밀리초(엑셀은 지수표기로 보일 수 있음).</div>
      </div>
    </Modal>
  );
}

