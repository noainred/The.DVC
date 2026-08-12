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

export function Waste({ scope }) {
  const { loading, data, error } = useTool('/tools/waste', scope ? { vcenterId: scope } : {});
  const [tab, setTab] = useState('off');
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const tb2 = (g) => (g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${g} GB`);
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="전원 꺼진 VM" value={data.poweredOff.count} meta={`스토리지 ${tb2(data.poweredOff.storageGB)} 점유`} accent={data.poweredOff.count ? 'var(--amber)' : undefined} />
        <Card label="스냅샷 보유 VM" value={data.snapshots.count} meta={`${tb2(data.snapshots.sizeGB)} 사용`} accent={data.snapshots.count ? 'var(--amber)' : undefined} />
        <Card label="Thin 회수가능(추정)" value={tb2(data.thinReclaim.reclaimableGB)} meta={`${data.thinReclaim.count} VM`} />
        <Card label="Tools 미실행(On)" value={data.noTools.count} accent={data.noTools.count ? 'var(--amber)' : undefined} />
      </div>
      <div className="flex gap" style={{ marginBottom: 8 }}>
        {[['off', `전원 꺼짐 (${data.poweredOff.count})`], ['snap', `스냅샷 (${data.snapshots.count})`], ['tools', `Tools 미실행 (${data.noTools.count})`]].map(([k, l]) => (
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
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>※ 고아 디스크(orphaned VMDK)는 데이터스토어 파일 스캔이 필요해 현재 미포함입니다.</div>
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
