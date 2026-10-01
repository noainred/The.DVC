// GpuTool.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState } from 'react';
import { useLatest } from '../../hooks/useLatest.js';
import { useHashTab } from '../../hooks/useHashTab.js';
import { fetchJson, postJson, downloadFile, canCsv } from '../../api.js';
import { downloadFailText } from '../downloadFailText.js';
import { DataTable, Loading, ErrorBox, UsageCell, Modal, VmLink } from '../../components/ui.jsx';
import { Card, useTool } from './shared.jsx';
import { STable } from '../../components/STable.jsx';
import { activityOf, memText, memMainText, gbText, tempText, allocText, allocTitle, activityRuleNote, activitySummary } from './gpuUsageText.js';
import { whyChip, whyBannerItems, vmChips, activityBar, srcText, collectCheckGroups, readCell } from './gpuWhyText.js';
const GpuHistModal = React.lazy(() => import('./GpuHistModal.jsx'));


const numOver = (p) => typeof p === 'number' && p > 100;
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
  // v2.447(감사 B16): params 가 deps 에서 빠져 있어 필터가 바뀌어도 재조회하지 않았고(낡은 클로저),
  // cleanup 도 없어 모달을 바로 닫으면 죽은 컴포넌트에 setState 했다. 세대 가드로 둘 다 해결.
  const run = useLatest();
  const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v)).toString();
  useEffect(() => {
    run(fetchJson(`/tools/gpu/vms${qs ? `?${qs}` : ''}`), setD, (e) => setErr(e.message));
  }, [qs, run]);
  return (
    <Modal title={title} onClose={onClose} width={1000} resizable minWidth={560} minHeight={380}>
      {err ? <ErrorBox message={err} /> : !d ? <Loading /> : (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>GPU 할당 VM <b>{d.total}</b>개 · 어떤 VM이 어떤 방식/프로파일로 GPU를 사용하는지 보여줍니다. <span style={{ opacity: 0.8 }}>사용률·메모리·온도는 게스트 OS(nvidia-smi) 수집값 — 전원 ON·VMware Tools·GPU 게스트 수집 계정이 있어야 표시됩니다(패스쓰루·vGPU 공통). 할당은 vGPU 프로파일 이름(…-10c = 10 GB)에서 계산합니다.</span></div>
          <div className="table-wrap">
            <STable minWidth={1180} wrap={false}>
              <thead><tr><th>VM</th><th>법인</th><th>호스트</th><th>GPU 모델</th><th>사용 방식</th><th>프로파일</th><th style={{ textAlign: 'right' }}>장수</th><th style={{ textAlign: 'right' }}>할당</th><th style={{ textAlign: 'right' }}>사용률</th><th style={{ textAlign: 'right' }}>메모리 점유</th><th style={{ textAlign: 'right' }}>메모리 사용</th><th style={{ textAlign: 'right' }}>온도</th><th>동작</th><th>전원</th></tr></thead>
              <tbody>
                 {d.vms.length === 0 && <tr><td colSpan={14} className="center muted" style={{ padding: 20 }}>GPU 할당 VM이 없습니다.</td></tr>}
                {d.vms.map((v) => (
                  <tr key={v.id}>
                    <td><VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /></td>
                    <td className="muted">{v.vcenterId}</td>
                    <td className="muted" style={{ fontSize: 12, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.host || ''}>{v.host || '—'}</td>
                    <td style={{ fontSize: 12 }}>{v.model || '—'}</td>
                    <td><VmGpuModeBadge gpu={v.gpu} /></td>
                    <td className="muted" style={{ fontSize: 12 }}>{v.gpu?.profile || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{v.gpu?.count ?? '—'}</td>
                    <td style={{ textAlign: 'right' }} data-sort={v.allocGB ?? ''}>{v.allocGB != null ? gbText(v.allocGB) : ((v.gpu?.passthrough || v.gpu?.type === 'passthrough') ? <span className="muted" title="패스스루는 GPU 한 장을 통째로 줍니다">한 장 전체</span> : <span className="muted" title="vGPU 프로파일 이름에서 용량을 읽지 못했습니다">—</span>)}</td>
                    <td style={{ textAlign: 'right' }}>{v.guestUtilNA ? <span className="muted" title="MIG 모드 — GPU 단위 사용률을 nvidia-smi 가 주지 않습니다(0% 가 아닙니다)">N/A(MIG)</span> : v.guestUtilPct == null ? <span className="muted" title={v.powerState === 'POWERED_ON' ? 'GPU 게스트 수집 미설정/미수집 — 설정 › GPU 게스트 수집에서 해당 VM 계정 등록 후 수집됩니다' : '전원 OFF — 게스트에서 사용률 수집 불가'}>—</span> : <UsageCell pct={v.guestUtilPct} />}</td>
                    <td style={{ textAlign: 'right' }}>{v.guestMemPct == null ? <span className="muted" title={v.powerState === 'POWERED_ON' ? 'GPU 게스트 수집 미설정/미수집 — 설정 › GPU 게스트 수집에서 계정 등록 후 수집됩니다' : '전원 OFF — 수집 불가'}>—</span> : <UsageCell pct={v.guestMemPct} />}</td>
                    <td style={{ textAlign: 'right' }} data-sort={v.guestMemUsedMB ?? ''}>{memText(v.guestMemUsedMB, v.guestMemTotalMB)}</td>
                    <td style={{ textAlign: 'right' }} data-sort={v.guestTempC ?? ''}>{tempText(v.guestTempC)}</td>
                    <td>{(() => { const a = activityOf(v.activity); return <span className={`badge ${a.tone}`} title={a.title}>{a.label}</span>; })()}</td>
                    <td>{v.powerState === 'POWERED_ON' ? <span className="badge green">On</span> : <span className="badge gray">Off</span>}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
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
    // v2.613 WEB2613-10: api.js 를 우회한 직접 fetch 금지 — 401 전역 처리·403 안내(HttpError)·X-Request-Id 가 빠진다.
    //   downloadFile 은 Content-Disposition 의 이름(서버가 zip 으로 바꿀 수 있다 — sendMaybeZip)을 먼저 쓴다.
    await downloadFile(`/tools/gpu.${fmt}${q}`);
  };
  // 하위 탭을 URL 에 실어 새로고침·북마크·뒤로가기에서 유지한다(v2.438, hooks/useHashTab.js).
  const [view, setView] = useHashTab({ base: ['tools', 'gpu'], valid: ['host', 'cluster', 'vc', 'model'], fallback: 'host' });
  const [hist, setHist] = useState(null);   // { level, key, metric } — v2.650: GpuHistModal 이 조회한다
  const [vmList, setVmList] = useState(null); // { title, params } for GpuVmsModal
  const [checkOpen, setCheckOpen] = useState(false); // v2.658 수집 점검 창
  const openHist = (level, key, metric = 'util') => setHist({ level, key, metric });
  const closeHist = () => setHist(null);
  const [mode, setMode] = useState(''); // '' | vgpu | passthrough | vsga
  const [modelFilter, setModelFilter] = useState(''); // '' = 전체 모델, 아니면 특정 GPU 모델
  const [power, setPower] = useState(''); // '' | on(켜진 VM 있는 호스트) | off(꺼진 VM 있는 호스트)
  const [openHost, setOpenHost] = useState(null); // v2.653: 할당 VM 을 펼친 호스트(한 번에 한 행)
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
    // v2.650
    tempC: h.tempC ?? null, memUsedMB: h.memUsedMB ?? null, memTotalMB: h.memTotalMB ?? null, memUsedPct: h.memUsedPct ?? null,
    allocGB: h.allocGB ?? null, allocPct: h.allocPct ?? null, capacityGB: h.capacityGB ?? null, allocCapacityGB: h.allocCapacityGB ?? null, allocCapacityBasis: h.allocCapacityBasis ?? null, passthroughOn: h.passthroughOn || 0, allocUnknown: h.allocUnknown || 0,
    activity: h.activity || null,
    // v2.653
    guestWhy: h.guestWhy || null, collectPath: h.collectPath || null, collectAgent: h.collectAgent || null,
    memSource: h.memSource || null, tempSource: h.tempSource || null, vms: h.vms || [],
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

  // v2.653(시안 A): 행 높이를 고정한다 — 할당 VM 은 한 줄 칩 + '+N', 누르면 그 호스트의 VM 표가 행 아래에 펼쳐진다.
  //   값이 없는 칸은 '—' 대신 이유 칩(gpu/guestWhy.js 코드)을 보인다 — 엣지 수집 법인에서 왜 비었는지가 화면에 없었다.
  const toggleHost = (k) => setOpenHost((cur) => (cur === k ? null : k));
  const WhyChip = ({ why }) => {
    const c = whyChip(why);
    if (!c) return <span className="muted">—</span>;
    return <span className="gpu-why" title={c.title}>{c.short}</span>;
  };
  const SrcTag = ({ s }) => (s === 'esxi' ? <span className="gpu-src" title="ESXi 성능 카운터 값(게스트 수집값이 없어 대신 표시)">ESXi</span> : null);
  const hostCols = [
    { key: 'name', label: '호스트', render: (r) => (
      <div className="gpu-host">
        <button className="cell-link gpu-ellip" title={`${r.name} — 누르면 추이`} onClick={() => openHist('host', r.key)}>{r.name}</button>
        <span className="gpu-sub">{r.vcenterId} · <span style={{ color: r.collectPath === 'site' ? 'var(--amber)' : 'var(--accent-2)' }}>{r.collectPath === 'site' ? `엣지${r.collectAgent ? ` ${r.collectAgent}` : ''}` : '중앙 직접'}</span></span>
      </div>
    ) },
    { key: 'count', label: 'GPU', align: 'left', sortValue: (r) => r.count, render: (r) => <span className="nowrap">{r.model} <span className="muted gpu-mono">×{r.count} · {r.memGB} GB</span></span> },
    { key: 'mode', label: '방식', sortValue: (r) => r.mode, render: (r) => <GpuModeBadge mode={r.mode} modes={r.modes} /> },
    { key: 'util', label: '사용률', render: (r) => (r.util == null ? <span className="muted">—</span>
      : <span className="flex gap" style={{ alignItems: 'center', flexWrap: 'nowrap' }}><UsageCell pct={r.util} />{r.utilSource === 'guest' && <span className="gpu-src" title="게스트 OS에서 수집(패스쓰루)">게스트</span>}</span>) },
    { key: 'tempC', label: '온도', align: 'right', sortValue: (r) => r.tempC, render: (r) => (r.tempC == null ? <span className="muted" title="온도 값 없음(게스트 수집값도 ESXi 카운터도 없음)">—</span>
      : <span className="nowrap"><button className="cell-link gpu-mono" title={r.tempSource === 'esxi' ? 'ESXi gpu.temperature(가장 뜨거운 GPU)' : '가장 높은 GPU(게스트 nvidia-smi)'} onClick={() => openHist('host', r.key, 'temp')}>{tempText(r.tempC)}</button><SrcTag s={r.tempSource} /></span>) },
    { key: 'memUsedMB', label: '메모리 사용', sortValue: (r) => r.memUsedPct, render: (r) => ((r.memUsedMB == null && r.memUsedPct == null) ? <WhyChip why={r.guestWhy} /> : (
      <div className="gpu-mem">
        <span className="nowrap"><button className="cell-link gpu-mono" onClick={() => openHist('host', r.key, 'mem')}>{memMainText(r.memUsedMB, r.memTotalMB, r.memUsedPct)}</button>{r.memUsedMB != null && r.memTotalMB && r.memUsedPct != null && <span className="muted" style={{ fontSize: 11 }}> {r.memUsedPct}%</span>}<SrcTag s={r.memSource} /></span>
        {r.memUsedPct != null && <span className="gpu-bar"><span style={{ width: `${Math.max(0, Math.min(100, r.memUsedPct))}%` }} /></span>}
      </div>
    )) },
    { key: 'allocGB', label: '메모리 할당', sortValue: (r) => r.allocGB, render: (r) => <span className="nowrap" style={{ fontSize: 12, color: numOver(r.allocPct) ? 'var(--amber)' : undefined }} title={allocTitle(r)}>{allocText(r)}</span> },
    { key: 'activity', label: 'VM 동작', sortValue: (r) => (r.activity?.busy || 0), render: (r) => {
      const b = activityBar(r.activity);
      const txt = activitySummary(r.activity, { short: true });
      return (
        <span className="gpu-act" title={activitySummary(r.activity) || '켜진 GPU VM 없음'}>
          {b ? <span className="gpu-actbar"><span className="busy" style={{ width: `${b.busy}%` }} /><span className="held" style={{ width: `${b.held}%` }} /><span className="idle" style={{ width: `${b.idle}%` }} /><span className="unk" style={{ width: `${b.unknown}%` }} /></span> : null}
          <span className="muted nowrap" style={{ fontSize: 11 }}>{txt || '—'}</span>
          {(r.memUsedMB != null || r.memUsedPct != null) && r.guestWhy && r.guestWhy.code !== 'partial' && <WhyChip why={r.guestWhy} />}
        </span>
      );
    } },
    { key: 'assignedVms', label: '할당 VM', sortValue: (r) => r.assignedVms, render: (r) => {
      if (!r.assignedVms) return <span className="muted">0</span>;
      const { chips, more } = vmChips(r.assignedVmNames);
      const open = openHost === r.key;
      return (
        <span className="gpu-vms">
          <button className="cell-link nowrap" aria-expanded={open} title={open ? '접기' : '이 호스트의 VM 표 펼치기'} onClick={() => toggleHost(r.key)}>{open ? '▾' : '▸'} {r.assignedVms}대</button>
          <span className="nowrap" style={{ fontSize: 11, color: 'var(--green)' }} title="켜진 GPU 할당 VM">● {r.assignedVmsOn || 0}</span>
          {(r.assignedVmsOff || 0) > 0 && <span className="nowrap" style={{ fontSize: 11, color: 'var(--text-faint)' }} title="꺼진 GPU 할당 VM">● {r.assignedVmsOff}</span>}
          {chips.map((c) => <span key={c.name} className={`gpu-chip${c.on ? '' : ' off'}`}><VmLink name={c.name} vcenterId={r.vcenterId} label={c.name} /></span>)}
          {more > 0 && <button className="gpu-more" onClick={() => toggleHost(r.key)} title="나머지 VM 까지 펼치기">+{more}</button>}
        </span>
      );
    } },
    { key: 'hist', label: '추이', render: (r) => <button className="gpu-icon-btn" aria-label="추이" title="추이(기본 1일)" onClick={() => openHist('host', r.key)}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2 12l4-4 3 3 5-6" /></svg></button> },
  ];
  const renderHostVms = (r) => (
    <div className="gpu-expand">
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{r.name} 의 GPU 할당 VM {r.vms.length}대{r.guestWhy ? <> · <WhyChip why={r.guestWhy} /></> : null}</div>
      <STable minWidth={900}>
        <thead><tr><th>VM</th><th>전원</th><th>방식·프로파일</th><th style={{ textAlign: 'right' }}>할당</th><th style={{ textAlign: 'right' }}>사용률</th><th style={{ textAlign: 'right' }}>메모리</th><th style={{ textAlign: 'right' }}>온도</th><th>동작</th><th>추이</th></tr></thead>
        <tbody>
          {r.vms.length === 0 && <tr><td colSpan={9} className="center muted">VM 정보가 없습니다.</td></tr>}
          {r.vms.map((v) => {
            const a = activityOf(v.activity);
            const on = v.powerState === 'POWERED_ON';
            return (
              <tr key={v.id}>
                <td><VmLink name={v.name} vcenterId={r.vcenterId} label={v.name} /></td>
                <td className="nowrap" style={{ color: on ? 'var(--green)' : 'var(--text-faint)' }}>● {on ? '켜짐' : '꺼짐'}</td>
                <td className="muted gpu-mono" style={{ fontSize: 12 }}>{v.profile || (v.mode === 'passthrough' ? '패스쓰루' : v.mode || '—')}</td>
                <td className="right gpu-mono" data-sort={v.allocGB ?? ''}>{v.allocGB == null ? '—' : gbText(v.allocGB)}</td>
                <td className="right gpu-mono" data-sort={v.utilPct ?? ''}>{v.utilNA ? 'N/A(MIG)' : v.utilPct == null ? '—' : `${v.utilPct}%`}</td>
                <td className="right gpu-mono" data-sort={v.memUsedMB ?? ''}>{memText(v.memUsedMB, v.memTotalMB)}</td>
                <td className="right gpu-mono" data-sort={v.tempC ?? ''}>{tempText(v.tempC)}</td>
                <td className="nowrap" title={a.title} style={{ color: `var(--${a.tone === 'gray' ? 'text-dim' : a.tone})` }}>{on ? a.label : '꺼짐'}</td>
                <td><button className="gpu-icon-btn" aria-label={`${v.name} 추이`} title="VM 추이(기본 1일)" onClick={() => openHist('vm', v.id)}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2 12l4-4 3 3 5-6" /></svg></button></td>
              </tr>
            );
          })}
        </tbody>
      </STable>
    </div>
  );
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
        <Card label="GPU 메모리 사용" value={data.memUsedPct == null ? '—' : `${data.memUsedPct}%`} meta={data.memUsedMB == null ? '게스트 수집값 없음' : memText(data.memUsedMB, data.memTotalMB)} />
        <Card label="vGPU 메모리 할당" value={data.allocGB == null ? '—' : gbText(data.allocGB)} meta="켜진 VM 의 vGPU 프로파일 합" />
        <Card label="최고 GPU 온도" value={tempText(data.tempC)} meta={data.tempC == null ? '게스트 수집값 없음' : '가장 뜨거운 GPU'} />
        <Card label="VM 동작" value={data.activity ? data.activity.busy : '—'} accent="var(--green)" meta={activitySummary(data.activity) || '켜진 GPU VM 없음'} />
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
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>※ vGPU/vSGA는 ESXi가 사용률을 보고하지만, <b>패스쓰루(DirectPath I/O)</b>는 게스트 OS가 GPU를 직접 소유해 ESXi에서 사용률을 볼 수 없습니다(설정 › GPU 게스트 수집에서 게스트 OS 수집을 켜면 표시). 이름·온도·메모리를 누르면 추이(기본 1일)를 봅니다. 온도·GPU 메모리 사용은 게스트 수집값을 먼저 쓰고, 없으면 ESXi 성능 카운터 값(vGPU/vSGA 호스트)을 <b>ESXi</b> 표지와 함께 보입니다. 값이 없는 칸의 점선 칩은 그 이유입니다. 할당은 vGPU 프로파일 이름에서 계산합니다. {data.activityRule && activityRuleNote(data.activityRule)}</div>
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
            {canCsv() && <button className="logout-btn" style={{ flex: 'none', padding: '7px 12px' }} onClick={() => setExportOpen(true)} title="수집된 GPU 사용률 데이터(전체/기간)를 CSV·JSON으로 내려받기.">⬇ 내보내기</button>}
            <button className="logout-btn" style={{ flex: 'none', padding: '7px 12px' }} onClick={() => setCheckOpen(true)}
              title="GPU 값을 읽지 못한 호스트를 법인별로 전부 봅니다(배너에 다 싣지 못한 것 포함).">🩺 수집 점검{(data.guestWhy || []).length ? ` (${new Set((data.guestWhy || []).map((x) => x.vcenterId)).size}개 법인)` : ''}</button>
          </div>
          {view === 'model' && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>법인별로 설치된 GPU 카드 모델·장수·할당 VM 수입니다(같은 법인·같은 모델은 합산). <b>할당 VM</b> 숫자를 클릭하면 해당 VM 목록과 사용 방식을 봅니다.</div>}
          {view === 'vc' && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>법인별 GPU 장수·사용 방식·할당 VM 수입니다. <b>할당 VM</b> 숫자를 클릭하면 VM별 사용 방식을 봅니다.</div>}
          {rows.length === 0 && data.items.length > 0 ? (
            <div className="card" style={{ padding: 16 }}>
              <span className="muted">현재 필터에 해당하는 GPU 호스트가 없습니다{mode ? ` (사용 방식: ${{ vgpu: 'vGPU', passthrough: '패스쓰루', vsga: 'vSGA' }[mode] || mode})` : ''}{modelFilter ? ` (모델: ${modelFilter})` : ''}. GPU는 총 {data.totalGpus}장 있습니다.</span>
              <button className="tab" style={{ marginLeft: 10, padding: '4px 10px' }} onClick={() => { setMode(''); setModelFilter(''); setPower(''); }}>필터 초기화</button>
            </div>
          ) : (
            <>
              {view === 'host' && whyBannerItems(data.guestWhy).length > 0 && (
                <div className="gpu-why-banner">
                  <span className="dot" />
                  <b>게스트 GPU 값을 읽지 못한 호스트가 있습니다</b>
                  <span className="list">{whyBannerItems(data.guestWhy).slice(0, 6).map((x) => <span key={x.key} title={x.title} className="item"><span>{x.text}</span>{x.detail && <span className="detail">{x.detail}</span>}</span>)}{whyBannerItems(data.guestWhy).length > 6 && <button type="button" className="gpu-why-more" onClick={() => setCheckOpen(true)} title="수집 점검 창에서 전부 봅니다">외 {whyBannerItems(data.guestWhy).length - 6}건 — 전부 보기</button>}</span>
                  <a href="#/settings/gpu-guest" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>수집 진단 열기 →</a>
                </div>
              )}
              <DataTable
                className={view === 'host' ? 'gpu-host-table' : ''}
                columns={view === 'host' ? hostCols : view === 'model' ? modelCols : view === 'vc' ? vcCols : aggCols}
                rows={rows}
                expandedKey={view === 'host' ? openHost : null}
                renderExpanded={view === 'host' ? renderHostVms : null}
                initialSort={{ key: (view === 'host' || view === 'model' || view === 'vc') ? (view === 'host' ? 'count' : 'gpus') : 'avg', dir: 'desc' }} />
            </>
          )}
        </>
      )}

      {hist && <React.Suspense fallback={null}><GpuHistModal level={hist.level} hkey={hist.key} initialMetric={hist.metric} onClose={closeHist} /></React.Suspense>}
      {vmList && <GpuVmsModal title={vmList.title} params={vmList.params} onClose={() => setVmList(null)} />}
      {checkOpen && <GpuCollectCheckModal data={data} onClose={() => setCheckOpen(false)} />}
      {canCsv() && exportOpen && <GpuExportModal scope={scope} onClose={() => setExportOpen(false)} onSnapshot={exportGpu} />}
    </>
  );
}

/**
 * v2.658 '수집 점검' — GPU 값을 읽지 못한 호스트를 법인(vCenter)별로 전부 보여 준다.
 * 배너(앞 6줄)와 같은 서버 판정(guestWhy)을 쓰고 '일부만 수집' 까지 싣는다. 왼쪽 법인 칩을 누르면 그 법인만 본다.
 * 폴링하지 않는다 — 화면이 이미 받은 /tools/gpu 응답만 쓴다(장비 왕복 0).
 */
function GpuCollectCheckModal({ data, onClose }) {
  const groups = collectCheckGroups(data.guestWhy, data.items);
  const [sel, setSel] = useState('');
  const shown = sel ? groups.filter((g) => g.vcenterId === sel) : groups;
  const tot = groups.reduce((a, g) => ({ hosts: a.hosts + g.hosts, full: a.full + g.full, partial: a.partial + g.partial, vms: a.vms + g.vms }), { hosts: 0, full: 0, partial: 0, vms: 0 });
  const cell = (ok, src) => { const c = readCell(ok, src); return <td style={{ color: c.bad ? 'var(--amber)' : 'var(--text-dim)', whiteSpace: 'nowrap' }}>{c.text}</td>; };
  return (
    <Modal title="GPU 수집 점검 — 법인별" onClose={onClose} width={1100}>
      {groups.length === 0 ? <div className="muted">GPU 값을 읽지 못한 호스트가 없습니다.</div> : (
        <div style={{ display: 'grid', gap: 10 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            법인 {groups.length}곳 · 호스트 {tot.hosts}대(전부 못 읽음 {tot.full} · 일부만 수집 {tot.partial}) · 못 읽은 켜진 VM {tot.vms}대.
            메모리 할당은 게스트가 아니라 vCenter 의 vGPU 프로파일에서 옵니다. 조치는 <a href="#/settings/gpu-guest" style={{ color: '#7dd3fc' }}>설정 › GPU 게스트 수집 › 수집 진단</a>에서 합니다.
          </div>
          <div className="gpu-check-chips">
            <button type="button" className={`tab${sel ? '' : ' active'}`} onClick={() => setSel('')}>전체 ({groups.length})</button>
            {groups.map((g) => (
              <button type="button" key={g.vcenterId} className={`tab${sel === g.vcenterId ? ' active' : ''}`} onClick={() => setSel(sel === g.vcenterId ? '' : g.vcenterId)}
                title={`전부 못 읽음 ${g.full}대 · 일부만 수집 ${g.partial}대`}>{g.vcenterId || '(vCenter 미상)'} <span className="muted">{g.hosts}</span></button>
            ))}
          </div>
          {shown.map((g) => (
            <div key={g.vcenterId} className="card" style={{ padding: 12, minWidth: 0 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', marginBottom: 6 }}>
                <b style={{ fontSize: 14 }}>{g.vcenterId || '(vCenter 미상)'}</b>
                <span className="muted" style={{ fontSize: 12 }}>호스트 {g.hosts}대 · 전부 못 읽음 {g.full} · 일부만 수집 {g.partial} · 못 읽은 VM {g.vms}대</span>
              </div>
              {g.entries.map((e) => (
                <div key={e.key} style={{ padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 12.5, display: 'grid', gap: 2 }}>
                  <div><b style={{ color: e.partial ? 'var(--text-dim)' : 'var(--amber)' }}>{e.short}</b>{e.agent ? ` (엣지 ${e.agent})` : ''} · 호스트 {e.hosts}대{e.vms > 0 ? ` · 못 읽은 VM ${e.vms}대` : ''}</div>
                  {e.detail && <div className="muted" style={{ overflowWrap: 'anywhere' }}>{e.detail}</div>}
                  <div className="muted" style={{ overflowWrap: 'anywhere' }}>조치: {e.fix}</div>
                </div>
              ))}
              {g.hostRows.length > 0 && (
                <STable className="v3-table" minWidth={720} style={{ marginTop: 6, fontSize: 12 }}>
                  <thead><tr><th>호스트</th><th>GPU</th><th>사유</th><th>못 읽은 VM</th><th>사용률</th><th>메모리 사용</th><th>온도</th></tr></thead>
                  <tbody>{g.hostRows.map((r) => (
                    <tr key={r.key}>
                      <td>{r.host}</td>
                      <td className="muted">{r.model}{r.count != null ? ` ×${r.count}` : ''}</td>
                      <td title={r.whyTitle} style={{ color: r.partial ? 'var(--text-dim)' : 'var(--amber)', whiteSpace: 'nowrap' }}>{r.why}</td>
                      <td data-sort={r.vmsUnread}>{r.vmsUnread}대</td>
                      {cell(r.util, r.utilSrc)}{cell(r.mem, r.memSrc)}{cell(r.temp, r.tempSrc)}
                    </tr>
                  ))}</tbody>
                </STable>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** GPU 데이터 내보내기 — 수집 시작 일시 안내 + 전체/기간 선택 + CSV/JSON. */
function GpuExportModal({ scope, onClose, onSnapshot }) {
  const [meta, setMeta] = useState(null);   // { collectedSince, latestAt, sampleCount }
  const [range, setRange] = useState('all'); // all | days
  const [days, setDays] = useState(30);
  const [vc, setVc] = useState(scope || ''); // 내보낼 vCenter(빈값=전체)
  const [vcs, setVcs] = useState([]);
  const [dlMsg, setDlMsg] = useState('');
  useEffect(() => { fetchJson('/vcenters').then((d) => setVcs(d || [])).catch(() => {}); }, []);
  const runMeta = useLatest();   // v2.447: 세대 가드(감사 B16)
  useEffect(() => {
    const q = vc ? `?vcenterId=${encodeURIComponent(vc)}` : '';
    runMeta(fetchJson(`/tools/gpu/series-meta${q}`), setMeta, () => setMeta({ collectedSince: null, sampleCount: 0 }));
  }, [vc, runMeta]);
  const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : null);
  const sinceTxt = meta && meta.collectedSince
    ? `${fmtTs(meta.collectedSince)} 부터 데이터가 쌓여 있습니다`
    : (meta ? '아직 수집된 GPU 사용률 이력이 없습니다(샘플러가 한 주기 이상 돌면 생성됩니다)' : '확인 중…');
  const daysSince = meta && meta.collectedSince ? Math.max(1, Math.round((Date.now() - meta.collectedSince) / 86_400_000)) : null;
  // v2.602(감사 WEB2602-01): 내려받기 실패(409 동시 내보내기·403)를 파일로 저장하지 않고 여기 말한다(스냅샷 경로 포함).
  const guarded = async (fn) => { setDlMsg(''); try { await fn(); } catch (e) { setDlMsg(downloadFailText(e)); } };
  const download = (fmt) => guarded(async () => {
    const params = new URLSearchParams();
    if (vc) params.set('vcenterId', vc);
    params.set('range', range);
    if (range === 'days') params.set('days', String(days));
    // v2.613 WEB2613-10: api.js 를 우회한 직접 fetch 금지 — 401 전역 처리·403 안내(HttpError)·X-Request-Id 가 빠진다.
    await downloadFile(`/tools/gpu/export.${fmt}?${params.toString()}`);
  });
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
      {dlMsg && <div className="banner error" role="alert" style={{ marginTop: 10 }}>{dlMsg}</div>}
      <div className="muted" style={{ fontSize: 12, marginTop: 12, borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 10 }}>
        시계열(샘플마다 한 행)로 내보냅니다. 현재 상태(호스트별 1행 스냅샷)만 필요하면&nbsp;
        <button className="cell-link" onClick={() => guarded(() => onSnapshot('csv', vc))}>스냅샷 CSV</button> ·&nbsp;
        <button className="cell-link" onClick={() => guarded(() => onSnapshot('json', vc))}>스냅샷 JSON</button>
        <div style={{ marginTop: 6 }}>💡 파일 용량이 1MB를 넘으면 자동으로 <b>zip</b>으로 압축해 내려받습니다. · <b>gpu_util_pct</b>=GPU 사용률(0~100%) · <b>epoch_ms</b>=Unix 밀리초(엑셀은 지수표기로 보일 수 있음).</div>
      </div>
    </Modal>
  );
}

