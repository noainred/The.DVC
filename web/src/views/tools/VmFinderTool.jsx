// VmFinderTool.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState } from 'react';
import { postJson, usePolling } from '../../api.js';
import { DataTable, ErrorBox, StateBadge, UsageCell, VmLink } from '../../components/ui.jsx';
import { Card } from './shared.jsx';


// 모듈 스코프(props만 사용) — VmFinder 렌더 바디 안에 정의하면 매 렌더 새 타입이 되어 칩
// 목록(overflowY:auto)이 remount, 스크롤/포커스가 매번 맨 위로 튀던 문제 방지.
function Chips({ label, list, sel, onToggle, nameOf }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{label} {sel.length ? `(${sel.length})` : ''}</div>
      <div className="flex gap wrap" style={{ maxHeight: 92, overflowY: 'auto' }}>
        {list.length === 0 && <span className="muted" style={{ fontSize: 12 }}>—</span>}
        {list.map((x) => (
          <span key={x} className="badge gray" style={{ cursor: 'pointer', padding: '4px 10px', fontSize: 12, border: sel.includes(x) ? '1px solid var(--accent,#6366f1)' : undefined, color: sel.includes(x) ? '#c7d2fe' : undefined }}
            onClick={() => onToggle(x)}>{nameOf ? nameOf(x) : x}</span>
        ))}
      </div>
    </div>
  );
}

export function VmFinder() {
  const { data: vcenters } = usePolling('/vcenters', {}, 60_000);
  const [f, setF] = useState({ vcenterIds: [], folders: [], clusters: [], resourcePools: [], powerState: '', os: '', q: '', includeTemplates: false });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [idleThreshold, setIdleThreshold] = useState(5);

  const search = async (withAvg = false) => {
    setLoading(true);
    try { setData(await postJson('/tools/vm-finder', { ...f, withAvg, idleThreshold: Number(idleThreshold) || 5 })); }
    catch (e) { setData({ error: e.message, items: [], facets: { vcenters: [], folders: [], clusters: [], resourcePools: [] } }); }
    finally { setLoading(false); }
  };
  useEffect(() => { search(false); /* eslint-disable-next-line */ }, []);

  const toggle = (key, val) => setF((s) => ({ ...s, [key]: s[key].includes(val) ? s[key].filter((x) => x !== val) : [...s[key], val] }));
  const facets = data?.facets || { vcenters: [], folders: [], clusters: [], resourcePools: [] };
  const vcName = (id) => (vcenters || []).find((v) => v.id === id)?.name || id;
  // vCenter 칩을 설정에서 지정한 순서(/vcenters 응답 순서)대로 정렬.
  const vcOrder = (vcenters || []).map((v) => v.id);
  const orderedVcenters = [...(facets.vcenters || [])].sort((a, b) => {
    const ia = vcOrder.indexOf(a); const ib = vcOrder.indexOf(b);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });

  const items = data?.items || [];
  const withAvg = data?.avgComputed;
  const cols = [
    { key: 'name', label: 'VM', render: (r) => <VmLink name={r.name} vcenterId={r.vcenterId} label={r.name} /> },
    { key: 'vcenterId', label: 'vCenter', render: (r) => <span className="muted">{vcName(r.vcenterId)}</span> },
    { key: 'folder', label: '폴더', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.folder || '—'}</span> },
    { key: 'cluster', label: '클러스터', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.cluster || '—'}</span> },
    { key: 'resourcePool', label: '리소스풀', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.resourcePool || '—'}</span> },
    { key: 'powerState', label: '전원', render: (r) => <StateBadge state={r.powerState} /> },
    { key: 'cpuUsagePct', label: '현재 CPU', render: (r) => <UsageCell pct={r.cpuUsagePct} /> },
    ...(withAvg ? [
      { key: 'avgDayCpu', label: '1일 평균', align: 'right', render: (r) => (r.avgDayCpu == null ? '—' : `${r.avgDayCpu}%`) },
      { key: 'avgWeekCpu', label: '1주 평균', align: 'right', render: (r) => (r.avgWeekCpu == null ? '—' : `${r.avgWeekCpu}%`) },
      { key: 'idle', label: '유휴', render: (r) => (r.idle ? <span className="badge red">유휴</span> : (r.idle === false ? <span className="badge green">사용</span> : '—')) },
    ] : []),
  ];

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <Chips label="vCenter (미선택=전체)" list={orderedVcenters} sel={f.vcenterIds} onToggle={(x) => toggle('vcenterIds', x)} nameOf={vcName} />
        <div className="flex gap wrap">
          <div style={{ flex: 1, minWidth: 220 }}><Chips label="폴더" list={facets.folders} sel={f.folders} onToggle={(x) => toggle('folders', x)} /></div>
          <div style={{ flex: 1, minWidth: 220 }}><Chips label="클러스터" list={facets.clusters} sel={f.clusters} onToggle={(x) => toggle('clusters', x)} /></div>
          <div style={{ flex: 1, minWidth: 220 }}><Chips label="리소스 풀" list={facets.resourcePools} sel={f.resourcePools} onToggle={(x) => toggle('resourcePools', x)} /></div>
        </div>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 6 }}>
          <label style={{ fontSize: 12 }}>전원
            <select className="select" value={f.powerState} onChange={(e) => setF({ ...f, powerState: e.target.value })}>
              <option value="">전체</option><option value="POWERED_ON">On</option><option value="POWERED_OFF">Off</option>
            </select>
          </label>
          <label style={{ fontSize: 12 }}>OS 포함<input className="input" value={f.os} onChange={(e) => setF({ ...f, os: e.target.value })} placeholder="예: Windows" /></label>
          <label style={{ fontSize: 12 }}>이름/IP<input className="input" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="검색" /></label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={f.includeTemplates} onChange={(e) => setF({ ...f, includeTemplates: e.target.checked })} /> 템플릿 포함</label>
          <label style={{ fontSize: 12 }}>유휴 기준(평균 CPU ≤ %)<input className="input" type="number" style={{ maxWidth: 90 }} value={idleThreshold} onChange={(e) => setIdleThreshold(e.target.value)} /></label>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} disabled={loading} onClick={() => search(false)}>{loading ? '검색 중…' : '검색'}</button>
          <button className="logout-btn" style={{ padding: '9px 16px' }} disabled={loading} onClick={() => search(true)} title="필터 결과의 1일/1주 평균 CPU를 조회해 유휴 VM을 찾습니다(상위 일부)">유휴 VM 분석</button>
        </div>
      </div>

      {data?.error && <ErrorBox message={data.error} />}
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Card label="검색 결과" value={items.length.toLocaleString()} meta="조건 일치 VM" />
        {withAvg && <Card label="유휴 VM" value={data.idleCount ?? 0} accent={(data.idleCount ?? 0) ? 'var(--red)' : 'var(--green)'} meta={`평균 CPU ≤ ${data.idleThreshold}%`} />}
        {withAvg && data.avgTruncated && <Card label="평균 분석 범위" value={`상위 ${data.avgCap}`} meta="성능부하 방지 상한" />}
      </div>
      {withAvg && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>※ 1일/1주 평균은 {data.avgTruncated ? `결과 상위 ${data.avgCap}대에 한해 ` : ''}vCenter 성능 데이터로 산출합니다(라이브). 평균이 기준 이하이고 전원 On인 VM을 ‘유휴(생성됐지만 미사용)’로 표시합니다.</div>}
      <DataTable columns={cols} rows={items} initialSort={withAvg ? { key: 'avgWeekCpu', dir: 'asc' } : { key: 'cpuUsagePct', dir: 'asc' }} />
    </>
  );
}
