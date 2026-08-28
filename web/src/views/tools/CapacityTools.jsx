// CapacityTools.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState, useRef } from 'react';
import { fetchJson } from '../../api.js';
import { DataTable, Loading, ErrorBox, StateBadge, UsageCell, Modal, ResultCount, SearchBox, VmLink } from '../../components/ui.jsx';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Brush } from 'recharts';
import { Card, fmtTrendTick, tb, tempColor, useTool } from './shared.jsx';


export function EsxiTemp({ scope }) {
  const { loading, data, error } = useTool('/tools/esxi-temp', scope ? { vcenterId: scope } : {});
  const [view, setView] = useState('host'); // host | cluster | vc
  const [hist, setHist] = useState(null); // { level, key, days, points, synthesized }
  const [days, setDays] = useState(7);
  const [bucket, setBucket] = useState('auto'); // auto | minute | hour | day
  const histGen = useRef(0); // 세대 가드 — 늦은 응답이 닫힌 모달을 재오픈하거나 다른 대상 차트를 덮어쓰지 않게
  const openHist = async (level, key) => {
    const gen = ++histGen.current;
    setHist({ level, key, loading: true });
    const bq = bucket && bucket !== 'auto' ? `&bucket=${bucket}` : '';
    const r = await fetchJson(`/tools/esxi-temp/history?level=${level}&key=${encodeURIComponent(key)}&days=${days}${bq}`).catch(() => null);
    if (gen !== histGen.current) return;
    setHist(r ? { ...r } : { error: true });
  };
  const closeHist = () => { histGen.current++; setHist(null); };
  useEffect(() => { if (hist && hist.key) openHist(hist.level, hist.key); /* eslint-disable-next-line */ }, [days, bucket]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;

  const rows = view === 'host'
    ? data.hosts.map((h) => ({ key: h.id, name: h.name, sub: `${h.vcenterId} / ${h.cluster || '-'}`, curC: h.curC, avg5C: h.avg5C, maxC: h.tempMaxC, level: 'host' }))
    : (view === 'cluster' ? data.clusters : data.vcenters).map((g) => ({ key: g.key, name: g.key.replace('|', ' / '), sub: `${g.hosts} 호스트`, curC: g.curC, avg5C: g.avg5C, maxC: g.maxC, level: view === 'cluster' ? 'cluster' : 'vc' }));

  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="온도 보고 호스트" value={`${data.reportingHosts}/${data.totalHosts}`} meta="센서 보고 호스트" />
        <Card label="평균 온도" value={data.hosts.length ? `${(data.hosts.reduce((a, h) => a + h.curC, 0) / data.hosts.length).toFixed(1)}℃` : '—'} />
        <Card label="최고 온도" value={data.hosts.length ? `${Math.max(...data.hosts.map((h) => h.tempMaxC))}℃` : '—'} accent="var(--red)" />
      </div>
      {data.reportingHosts === 0 && <div className="card" style={{ marginBottom: 12, borderColor: 'var(--amber)' }}><span className="muted">온도 센서를 보고하는 호스트가 없습니다(하드웨어/CIM 미지원이거나 nested ESXi). 라이브 수집 시 표시됩니다.</span></div>}
      <div className="flex gap" style={{ marginBottom: 8 }}>
        {[['host', '호스트별'], ['cluster', '클러스터별'], ['vc', '법인별']].map(([k, l]) => (
          <button key={k} className={view === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView(k)}>{l}</button>
        ))}
      </div>
      <DataTable rows={rows} initialSort={{ key: 'curC', dir: 'desc' }} columns={[
        { key: 'name', label: view === 'host' ? '호스트' : (view === 'cluster' ? '클러스터' : '법인'), render: (r) => <button className="cell-link" onClick={() => openHist(r.level, r.key)}>{r.name}</button> },
        { key: 'sub', label: '구분', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.sub}</span> },
        { key: 'curC', label: '현재온도 ℃', align: 'right', render: (r) => <b style={{ color: tempColor(r.curC) }}>{r.curC ?? '—'}</b> },
        { key: 'avg5C', label: '5분 평균 ℃', align: 'right', render: (r) => <span style={{ color: tempColor(r.avg5C) }}>{r.avg5C ?? '—'}</span> },
        { key: 'maxC', label: '최대 온도 ℃', align: 'right', render: (r) => <span style={{ color: tempColor(r.maxC) }}>{r.maxC ?? '—'}</span> },
        { key: 'hist', label: '추이', render: (r) => <button className="tab" onClick={() => openHist(r.level, r.key)}>5년 추이</button> },
      ]} />

      {hist && (
        <Modal title={`온도 추이 — ${hist.key || ''}`} onClose={closeHist} width={760}>
          <div className="flex gap wrap" style={{ marginBottom: 8 }}>
            {[[1, '1일'], [7, '1주'], [30, '1달'], [365, '1년'], [1830, '5년']].map(([d, l]) => (
              <button key={d} className={days === d ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} onClick={() => setDays(d)}>{l}</button>
            ))}
            {hist.synthesized && <span className="badge amber" style={{ alignSelf: 'center' }}>데모 합성</span>}
          </div>
          <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>집계 단위(기준)</span>
            {[['auto', '자동'], ['minute', '분'], ['hour', '시간'], ['day', '일']].map(([b, l]) => (
              <button key={b} className={bucket === b ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} onClick={() => setBucket(b)}>{l}</button>
            ))}
            {hist.points?.length ? <span className="muted" style={{ fontSize: 11 }}>{hist.points.length}개 구간</span> : null}
          </div>
          {hist.loading ? <Loading /> : hist.error ? <ErrorBox message="이력을 불러오지 못했습니다." /> : (hist.points || []).length === 0
            ? <div className="muted">해당 기간 데이터가 없습니다(수집 누적 후 표시).</div>
            : (
              <>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={(hist.points || []).map((p) => ({ t: fmtTrendTick(p.ts, days), avg: p.avg, max: p.max }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                    <XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={40} />
                    <YAxis tick={{ fontSize: 11 }} unit="℃" domain={['auto', 'auto']} />
                    <Tooltip contentStyle={{ background: '#0b1220', border: '1px solid #243049', fontSize: 12 }} />
                    <Line type="monotone" dataKey="avg" stroke="#22d3ee" dot={false} name="평균" isAnimationActive={false} />
                    <Line type="monotone" dataKey="max" stroke="#f87171" dot={false} name="최고" isAnimationActive={false} />
                    <Brush dataKey="t" height={22} stroke="#6366f1" travellerWidth={8} tickFormatter={() => ''} />
                  </LineChart>
                </ResponsiveContainer>
                <div className="muted" style={{ fontSize: 11, marginTop: 4, textAlign: 'center' }}>아래 막대를 드래그하면 구간을 좁혀 스크롤·확대해 볼 수 있습니다.</div>
              </>
            )}
        </Modal>
      )}
    </>
  );
}

export function Forecast({ scope }) {
  const { loading, data, error } = useTool('/tools/capacity-forecast', scope ? { vcenterId: scope } : {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const tb2 = (g) => (g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${g} GB`);
  const dlabel = (d) => d == null ? '—' : d > 3650 ? '>10년' : d > 365 ? `${(d / 365).toFixed(1)}년` : `${d}일`;
  const soon = data.items.filter((x) => x.daysToFull != null && x.daysToFull <= 180).length;
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="데이터스토어" value={data.items.length} />
        <Card label="180일 내 포화 예상" value={soon} accent={soon ? 'var(--red)' : 'var(--green)'} />
      </div>
      {data.mock && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>※ 데모: 증가율/예상일은 합성값입니다. 라이브는 수집 이력(ds_usedgb)이 쌓이면 선형회귀로 산출됩니다.</div>}
      <DataTable rows={data.items} initialSort={{ key: 'daysToFull', dir: 'asc' }} columns={[
        { key: 'name', label: '데이터스토어', render: (d) => <b>{d.name}</b> },
        { key: 'vcenterId', label: 'vCenter', render: (d) => <span className="muted">{d.vcenterId}</span> },
        { key: 'usagePct', label: '현재 사용', render: (d) => <UsageCell pct={d.usagePct} /> },
        { key: 'freeGB', label: '여유', align: 'right', render: (d) => tb2(d.freeGB) },
        { key: 'growthGBperDay', label: '증가율/일', align: 'right', render: (d) => d.growthGBperDay == null ? '—' : `${d.growthGBperDay} GB` },
        { key: 'daysToFull', label: '가득 찰 예상', align: 'right', render: (d) => <b style={{ color: d.daysToFull != null && d.daysToFull <= 180 ? 'var(--red)' : undefined }}>{dlabel(d.daysToFull)}</b> },
      ]} />
    </>
  );
}

export function Capacity({ scope }) {
  const { loading, data, error } = useTool('/tools/capacity', scope ? { vcenterId: scope } : {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const t = data.totals;
  const cols = [
    { key: 'cluster', label: '클러스터', render: (c) => <b>{c.cluster}</b> },
    { key: 'vcenterId', label: 'vCenter', render: (c) => <span className="muted">{c.vcenterId}</span> },
    { key: 'hosts', label: '호스트', align: 'right' },
    { key: 'vmsOn', label: 'VM(On)', align: 'right', render: (c) => `${c.vmsOn}/${c.vms}` },
    { key: 'cores', label: '물리코어', align: 'right' },
    { key: 'vcpuAllocated', label: '할당 vCPU', align: 'right' },
    { key: 'vcpuPerCore', label: 'vCPU:코어', align: 'right', render: (c) => <span className={`badge ${c.vcpuPerCore >= 4 ? 'red' : c.vcpuPerCore >= 3 ? 'amber' : 'green'}`}>{c.vcpuPerCore}:1</span> },
    { key: 'ramOvercommitPct', label: 'RAM 오버커밋', align: 'right', render: (c) => <span className={`badge ${c.ramOvercommitPct >= 100 ? 'red' : c.ramOvercommitPct >= 85 ? 'amber' : 'green'}`}>{c.ramOvercommitPct}%</span> },
    { key: 'cpuUsedPct', label: 'CPU 사용', render: (c) => <UsageCell pct={c.cpuUsedPct} /> },
    { key: 'memUsedPct', label: '메모리 사용', render: (c) => <UsageCell pct={c.memUsedPct} /> },
    { key: 'ramHeadroomGB', label: 'RAM 여유', align: 'right', render: (c) => tb(c.ramHeadroomGB) },
  ];
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="클러스터" value={t.clusters} meta={`호스트 ${t.hosts}`} />
        <Card label="물리코어 / 할당 vCPU" value={`${t.cores} / ${t.vcpuAllocated}`} meta={`${t.vcpuPerCore}:1 평균`} accent={t.vcpuPerCore >= 4 ? 'var(--red)' : undefined} />
        <Card label="메모리 / 할당" value={`${tb(t.memTotalGB)} / ${tb(t.ramAllocatedGB)}`} />
        <Card label="RAM 여유(헤드룸)" value={tb(t.ramHeadroomGB)} accent={t.ramHeadroomGB <= 0 ? 'var(--red)' : 'var(--green)'} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>오버커밋: vCPU:코어 ≥4 또는 RAM ≥100%면 과밀(빨강). RAM 여유 = 물리RAM − 할당(전원 On).</div>
      <DataTable columns={cols} rows={data.clusters} initialSort={{ key: 'ramOvercommitPct', dir: 'desc' }} />
    </>
  );
}

/**
 * 할당 vs 실사용 추이(v2.374) — '주기적 실사용률 트렌드로 할당량을 조절' 하기 위한 차트.
 * 샘플러(기본 1분)가 적재한 집계를 시간/일/주 버킷으로 보여준다(시간당 이상은 롤업 사용).
 * 사용률(%) 축과 절대량(GHz/GB) 축을 탭으로 나눠 본다 — 한 차트에 섞으면 스케일이 무의미해진다.
 */
function WasteTrend({ scope }) {
  const [days, setDays] = useState(30);
  const [bucket, setBucket] = useState('auto');
  const [mode, setMode] = useState('pct');   // pct | abs
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let dead = false;
    setD(null); setErr(null);
    const p = { days: String(days), ...(scope ? { vcenterId: scope } : {}), ...(bucket !== 'auto' ? { bucket } : {}) };
    fetchJson('/tools/waste/history', p).then((r) => { if (!dead) setD(r); }).catch((e) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, [scope, days, bucket]);
  const pts = d?.points || [];
  const fmtTs = (t) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit' });
  return (
    <>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>기간</span>
        <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ minWidth: 110 }}>
          {[1, 7, 30, 90, 365].map((n) => <option key={n} value={n}>최근 {n}일</option>)}
        </select>
        <span className="muted" style={{ fontSize: 12 }}>집계</span>
        <select className="select" value={bucket} onChange={(e) => setBucket(e.target.value)} style={{ minWidth: 110 }}>
          <option value="auto">자동</option><option value="hour">1시간</option><option value="day">1일</option><option value="week">1주</option>
        </select>
        <div className="flex gap" style={{ marginLeft: 4 }}>
          <button className={mode === 'pct' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px' }} onClick={() => setMode('pct')}>사용률(%)</button>
          <button className={mode === 'abs' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px' }} onClick={() => setMode('abs')}>절대량</button>
        </div>
      </div>
      {err ? <ErrorBox message={err} />
        : !d ? <Loading />
          : pts.length < 2 ? (
            <div className="muted" style={{ fontSize: 13, padding: 20, textAlign: 'center' }}>
              표시할 추이 데이터가 아직 없습니다. 사용량은 <b>샘플러가 수집하는 시점부터</b> 쌓입니다
              {d.collectedSince ? <> (수집 시작: {new Date(d.collectedSince).toLocaleString('ko-KR')})</> : null}.
              업그레이드 직후에는 몇 시간 뒤부터 그래프가 보입니다.
            </div>
          ) : (
            <div style={{ width: '100%', height: 320 }}>
              <ResponsiveContainer>
                <LineChart data={pts} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke="rgba(148,163,184,.15)" />
                  <XAxis dataKey="ts" tickFormatter={fmtTs} tick={{ fontSize: 11 }} minTickGap={28} />
                  <YAxis tick={{ fontSize: 11 }} domain={mode === 'pct' ? [0, 100] : ['auto', 'auto']}
                    label={{ value: mode === 'pct' ? '%' : 'GHz / GB', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                  <Tooltip labelFormatter={(t) => new Date(t).toLocaleString('ko-KR')}
                    contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', fontSize: 12 }} />
                  {mode === 'pct' ? <>
                    <Line type="monotone" dataKey="cpuUsedPct" name="CPU 사용률" stroke="#60a5fa" dot={false} connectNulls={false} />
                    <Line type="monotone" dataKey="memUsedPct" name="메모리 사용률" stroke="#4ade80" dot={false} connectNulls={false} />
                  </> : <>
                    <Line type="monotone" dataKey="cpuAllocGHz" name="CPU 할당(GHz)" stroke="#60a5fa" strokeDasharray="4 3" dot={false} connectNulls={false} />
                    <Line type="monotone" dataKey="cpuUsedGHz" name="CPU 사용(GHz)" stroke="#60a5fa" dot={false} connectNulls={false} />
                    <Line type="monotone" dataKey="memAllocGB" name="메모리 할당(GB)" stroke="#4ade80" strokeDasharray="4 3" dot={false} connectNulls={false} />
                    <Line type="monotone" dataKey="memUsedGB" name="메모리 사용(GB)" stroke="#4ade80" dot={false} connectNulls={false} />
                  </>}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
      {pts.length >= 2 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          점선 = 할당, 실선 = 실사용. 사용률이 장기간 낮게 유지되면 할당을 줄일 여지가 있습니다.
          {' '}집계 단위 {d.bucketMs >= 86_400_000 ? `${Math.round(d.bucketMs / 86_400_000)}일` : `${Math.round(d.bucketMs / 3_600_000)}시간`} 평균 ·
          {' '}표본 {pts.length}점{d.collectedSince ? ` · 수집 시작 ${new Date(d.collectedSince).toLocaleDateString('ko-KR')}` : ''}
        </div>
      )}
    </>
  );
}

export function Waste({ scope }) {
  const { loading, data, error } = useTool('/tools/waste', scope ? { vcenterId: scope } : {});
  const [tab, setTab] = useState('off');
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const tb2 = (g) => (g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${g} GB`);
  const oa = data.overAllocated || null; // 과할당(할당 vs 사용) — 구버전 서버 응답이면 없음
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="전원 꺼진 VM" value={data.poweredOff.count} meta={`스토리지 ${tb2(data.poweredOff.storageGB)} 점유`} accent={data.poweredOff.count ? 'var(--amber)' : undefined} />
        <Card label="스냅샷 보유 VM" value={data.snapshots.count} meta={`${tb2(data.snapshots.sizeGB)} 사용`} accent={data.snapshots.count ? 'var(--amber)' : undefined} />
        <Card label="Thin 회수가능(추정)" value={tb2(data.thinReclaim.reclaimableGB)} meta={`${data.thinReclaim.count} VM`} />
        <Card label="Tools 미실행(On)" value={data.noTools.count} accent={data.noTools.count ? 'var(--amber)' : undefined} />
        {oa && <Card label="미사용 CPU clock" value={`${oa.cpu.idleGHz} GHz`}
          meta={`할당 ${oa.cpu.allocGHz} · 사용 ${oa.cpu.usedGHz} GHz → 절감 가능 ${oa.cpu.savingPct}%`}
          accent={oa.cpu.savingPct >= 50 ? 'var(--amber)' : undefined} />}
        {oa && <Card label="미사용 메모리" value={tb2(oa.mem.idleGB)}
          meta={`할당 ${tb2(oa.mem.allocGB)} · 사용 ${tb2(oa.mem.usedGB)} → 절감 가능 ${oa.mem.savingPct}%`}
          accent={oa.mem.savingPct >= 50 ? 'var(--amber)' : undefined} />}
      </div>
      <div className="flex gap" style={{ marginBottom: 8 }}>
        {[['off', `전원 꺼짐 (${data.poweredOff.count})`], ['snap', `스냅샷 (${data.snapshots.count})`], ['tools', `Tools 미실행 (${data.noTools.count})`],
          ...(oa ? [['cpu', `CPU 과할당 (${oa.cpu.candidates})`], ['mem', `메모리 과할당 (${oa.mem.candidates})`], ['trend', '📈 사용 추이']] : [])].map(([k, l]) => (
          <button key={k} className={tab === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'off' && <DataTable rows={data.poweredOff.vms} initialSort={{ key: 'storageGB', dir: 'desc' }} columns={[
        { key: 'name', label: 'VM', render: (v) => <VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /> }, { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
        { key: 'guestOS', label: 'OS' }, { key: 'storageGB', label: '스토리지', align: 'right', render: (v) => tb2(v.storageGB) }]} />}
      {tab === 'snap' && <DataTable rows={data.snapshots.vms} initialSort={{ key: 'snapshotSizeGB', dir: 'desc' }} columns={[
        { key: 'name', label: 'VM', render: (v) => <VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /> }, { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
        { key: 'snapshotCount', label: '개수', align: 'right' }, { key: 'snapshotSizeGB', label: '크기', align: 'right', render: (v) => tb2(v.snapshotSizeGB) }]} />}
      {tab === 'tools' && <DataTable rows={data.noTools.vms} columns={[
        { key: 'name', label: 'VM', render: (v) => <VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /> }, { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
        { key: 'toolsStatus', label: 'Tools 상태', render: (v) => <span className="badge amber">{v.toolsStatus}</span> }]} />}
      {tab === 'cpu' && oa && <>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          할당 clock = vCPU × 호스트 코어당 MHz · 사용 clock = 할당 × 현재 사용률. 사용률 <b>{oa.thresholds.cpuIdlePct}% 이하</b>이고 vCPU 2개 이상인 VM만 후보로 봅니다(1 vCPU 는 줄일 수 없음).
        </div>
        <DataTable rows={oa.cpuTop} initialSort={{ key: 'cpuIdleMhz', dir: 'desc' }} columns={[
          { key: 'name', label: 'VM', render: (v) => <VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /> },
          { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
          { key: 'vcpu', label: 'vCPU', align: 'right' },
          { key: 'cpuAllocMhz', label: '할당 clock', align: 'right', render: (v) => (v.cpuAllocMhz == null ? '—' : `${(v.cpuAllocMhz / 1000).toFixed(1)} GHz`) },
          { key: 'cpuUsedMhz', label: '사용 clock', align: 'right', render: (v) => (v.cpuUsedMhz == null ? '—' : `${(v.cpuUsedMhz / 1000).toFixed(1)} GHz`) },
          { key: 'cpuIdleMhz', label: '미사용 clock', align: 'right', render: (v) => (v.cpuIdleMhz == null ? '—' : <b style={{ color: 'var(--amber)' }}>{(v.cpuIdleMhz / 1000).toFixed(1)} GHz</b>) },
          { key: 'cpuUsagePct', label: '사용률', align: 'right', render: (v) => `${v.cpuUsagePct}%` },
          { key: 'cpuSavingPct', label: '절감 가능', align: 'right', render: (v) => (v.cpuSavingPct == null ? '—' : <b>{v.cpuSavingPct}%</b>) },
          { key: 'host', label: 'ESXi 호스트', render: (v) => <span className="muted">{v.host}</span> },
        ]} />
      </>}
      {tab === 'mem' && oa && <>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          사용 메모리는 게스트가 실제로 쓰는 양(guest memory usage)입니다. 사용률 <b>{oa.thresholds.memIdlePct}% 이하</b>인 VM을 후보로 봅니다.
        </div>
        <DataTable rows={oa.memTop} initialSort={{ key: 'memIdleGB', dir: 'desc' }} columns={[
          { key: 'name', label: 'VM', render: (v) => <VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /> },
          { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
          { key: 'memAllocGB', label: '할당', align: 'right', render: (v) => tb2(v.memAllocGB) },
          { key: 'memUsedGB', label: '사용', align: 'right', render: (v) => tb2(v.memUsedGB) },
          { key: 'memIdleGB', label: '미사용', align: 'right', render: (v) => <b style={{ color: 'var(--amber)' }}>{tb2(v.memIdleGB)}</b> },
          { key: 'memUsagePct', label: '사용률', align: 'right', render: (v) => `${v.memUsagePct}%` },
          { key: 'memSavingPct', label: '절감 가능', align: 'right', render: (v) => (v.memSavingPct == null ? '—' : <b>{v.memSavingPct}%</b>) },
          { key: 'guestOS', label: 'Guest OS' },
          { key: 'host', label: 'ESXi 호스트', render: (v) => <span className="muted">{v.host}</span> },
        ]} />
      </>}
      {tab === 'trend' && <WasteTrend scope={scope} />}
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>※ 고아 디스크(orphaned VMDK)는 데이터스토어 파일 스캔이 필요해 현재 미포함입니다.</div>
      {oa && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        ※ 과할당 수치는 <b>스냅샷 시점(현재)의 순간 사용률</b> 기준 추정입니다 — 리사이징 결정에는 기간 평균·피크(예: 1주 P95)를 함께 확인하세요. 전원이 꺼진 VM은 제외했고(위 ‘전원 꺼짐’ 참조),
        {oa.excludedNoHostMhz > 0 ? <> 호스트 코어 clock을 알 수 없는 <b>{oa.excludedNoHostMhz}대</b>는 CPU clock 집계에서 제외했습니다(값을 추정하지 않음).</> : null}
      </div>}
    </>
  );
}

export function ThinVms({ scope }) {
  const { loading, data, error } = useTool('/tools/thin-vms', scope ? { vcenterId: scope } : {});
  const [q, setQ] = useState('');
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const term = q.trim().toLowerCase();
  const rows = data.items.filter((r) => !term || (r.name || '').toLowerCase().includes(term) || (r.guestOS || '').toLowerCase().includes(term) || (r.host || '').toLowerCase().includes(term));
  const cols = [
    { key: 'name', label: 'VM', render: (r) => <VmLink name={r.name} vcenterId={r.vcenterId} label={r.name} /> },
    { key: 'vcenterId', label: 'vCenter', render: (r) => <span className="muted">{r.vcenterId}</span> },
    { key: 'powerState', label: '전원', render: (r) => <StateBadge state={r.powerState} /> },
    { key: 'guestOS', label: 'Guest OS' },
    { key: 'committedGB', label: '사용(committed)', align: 'right', render: (r) => tb(r.committedGB) },
    { key: 'provisionedGB', label: '할당(provisioned)', align: 'right', render: (r) => tb(r.provisionedGB) },
    { key: 'uncommittedGB', label: '회수가능(추정)', align: 'right', render: (r) => <b style={{ color: 'var(--amber)' }}>{tb(r.uncommittedGB)}</b> },
    { key: 'host', label: 'ESXi 호스트', render: (r) => <span className="muted">{r.host}</span> },
  ];
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="Thin VM" value={data.thinVms.toLocaleString()} meta={`전체 ${data.totalVms.toLocaleString()} 중 ${data.thinPct}%`} />
        <Card label="사용 합계" value={`${data.committedTB} TB`} meta="committed" />
        <Card label="할당 합계" value={`${data.provisionedTB} TB`} meta="provisioned" />
        <Card label="회수 가능(추정)" value={`${data.reclaimableTB} TB`} accent="var(--amber)" meta="uncommitted 합" />
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>※ Thin 판정은 vCenter의 uncommitted(여유) 기준 <b>추정</b>입니다. 회수 가능 용량은 정확한 값이 아니라 참고치입니다.</div>
      <div className="flex gap" style={{ marginBottom: 8 }}>
        <SearchBox className="input" style={{ maxWidth: 260 }} placeholder="VM / OS / 호스트 검색" value={q} onChange={setQ} />
      </div>
      <ResultCount total={data.items.length} shown={rows.length} label="Thin VM" filtered={!!term} />
      <DataTable columns={cols} rows={rows} initialSort={{ key: 'uncommittedGB', dir: 'desc' }} />
    </>
  );
}
