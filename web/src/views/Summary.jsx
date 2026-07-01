import React, { useState } from 'react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { usePolling } from '../api.js';
import { Loading, ErrorBox, usageColor, Modal } from '../components/ui.jsx';
import { GuestOsVmsModal } from './SpecialTools.jsx';

const OS_COLORS = {
  Windows: '#3b82f6', RHEL: '#ef4444', Ubuntu: '#f59e0b', CentOS: '#a855f7',
  SUSE: '#22c55e', Debian: '#ec4899', Other: '#64748b',
};
const tipStyle = { background: '#0c1322', border: '1px solid #243049', borderRadius: 8, color: '#e6edf6', fontSize: 12 };
const itemStyle = { color: '#e6edf6' };
const labelStyle = { color: '#8b9bb4' };
const fmt = (n) => (n ?? 0).toLocaleString('en-US');

function Big({ label, value, unit, sub, accent, onClick }) {
  return (
    <div className="card kpi" onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined} title={onClick ? '클릭 시 vCenter별 상세 보기' : undefined}>
      <div className="label">{label}{onClick && <span style={{ marginLeft: 4, opacity: .6 }}>›</span>}</div>
      <div className="value" style={accent ? { color: accent } : undefined}>{value}{unit && <small> {unit}</small>}</div>
      {sub && <div className="meta">{sub}</div>}
    </div>
  );
}

/** vCenter(법인)별 가상화율(vCPU : 물리코어) 상세 모달. byVcenter 데이터로 클라이언트 계산. 제목 클릭 정렬. */
function VcpuRatioModal({ rows, onClose }) {
  const r2 = (v) => Number((v || 0).toFixed(2));
  const [sort, setSort] = useState({ key: 'ratio', dir: 'desc' });
  const base = (rows || []).map((vc) => ({ ...vc, ratio: vc.cpuCores > 0 ? r2(vc.vcpuAllocated / vc.cpuCores) : 0 }));
  const list = [...base].sort((a, b) => {
    const va = a[sort.key], vb = b[sort.key];
    const cmp = typeof va === 'string' ? String(va).localeCompare(String(vb)) : (va || 0) - (vb || 0);
    return sort.dir === 'asc' ? cmp : -cmp;
  });
  const ratioColor = (r) => (r > 4 ? 'var(--amber)' : r > 0 ? 'var(--green)' : 'var(--text-dim)');
  const toggle = (key) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 'asc' ? 'desc' : 'asc') : (key === 'name' ? 'asc' : 'desc') }));
  const arrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
  const COLS = [
    ['name', 'vCenter(법인)', 'left'], ['vms', 'VM', 'right'], ['vcpuAllocated', '할당 vCPU', 'right'],
    ['cpuCores', '물리 코어', 'right'], ['ratio', '가상화율', 'right'],
  ];
  return (
    <Modal title="vCenter별 가상화율 (vCPU : 물리코어)" onClose={onClose} width={720} resizable minWidth={480} minHeight={360}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>할당된 vCPU ÷ 물리 코어 수. <b style={{ color: 'var(--amber)' }}>4:1 초과</b>는 높은 오버커밋입니다. <span style={{ opacity: .8 }}>제목을 클릭하면 정렬됩니다.</span></div>
      {/* 모달 본문(overflowY:auto)이 이미 세로 스크롤을 담당하므로, 표 자체는 별도 스크롤
          컨테이너를 두지 않는다(overflow:visible). 안쪽 maxHeight 캡이 모달 높이를 초과해
          스크롤바가 이중으로 생기던 문제 해결. thead의 position:sticky는 모달 본문 기준으로
          그대로 고정된다. */}
      <div className="table-wrap" style={{ overflow: 'visible' }}>
        <table>
          <thead><tr>
            {COLS.map(([key, label, align]) => (
              <th key={key} style={{ textAlign: align, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggle(key)} title="클릭하여 정렬">{label}{arrow(key)}</th>
            ))}
            <th>오버커밋</th>
          </tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={6} className="center muted" style={{ padding: 20 }}>데이터가 없습니다.</td></tr>}
            {list.map((vc) => (
              <tr key={vc.id}>
                <td><b>{vc.name}</b></td>
                <td style={{ textAlign: 'right' }} className="tabular">{(vc.vms || 0).toLocaleString()}</td>
                <td style={{ textAlign: 'right' }} className="tabular">{(vc.vcpuAllocated || 0).toLocaleString()}</td>
                <td style={{ textAlign: 'right' }} className="tabular">{(vc.cpuCores || 0).toLocaleString()}</td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: ratioColor(vc.ratio) }} className="tabular">{vc.ratio} : 1</td>
                <td><span className={`badge ${vc.ratio > 4 ? 'amber' : 'green'}`}>{vc.ratio > 4 ? '높음' : '정상'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function CapacityBar({ label, usedLabel, totalLabel, pct }) {
  return (
    <div className="card">
      <div className="flex between" style={{ marginBottom: 8 }}>
        <b>{label}</b><span className="tabular" style={{ color: usageColor(pct), fontWeight: 700 }}>{pct}%</span>
      </div>
      <div className="usage-bar" style={{ height: 12 }}>
        <span style={{ width: `${Math.min(pct, 100)}%`, background: usageColor(pct) }} />
      </div>
      <div className="flex between meta" style={{ marginTop: 8, color: 'var(--text-dim)' }}>
        <span>사용 {usedLabel}</span><span>총 {totalLabel}</span>
      </div>
    </div>
  );
}

export default function Summary({ scope, onGotoTab }) {
  const [corp, setCorp] = useState(''); // '' = all 법인(vCenter)
  const [osPower, setOsPower] = useState('all'); // all | on | off
  const [osKind, setOsKind] = useState('all');   // all | vm | template
  const [showRatio, setShowRatio] = useState(false); // vCenter별 가상화율 모달
  const [osDrill, setOsDrill] = useState(null); // Guest OS 계열 클릭 → 대상 VM 모달(계열명)
  const params = {
    ...scope, ...(corp ? { vcenterId: corp } : {}),
    ...(osPower !== 'all' ? { power: osPower } : {}),
    ...(osKind !== 'all' ? { kind: osKind } : {}),
  };
  const { data: s, error, loading } = usePolling('/summary', params, 15_000);
  const { data: vcList } = usePolling('/vcenters', {}, 60_000); // 법인 목록(필터)
  if (loading && !s) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  if (!s) return null;

  const c = s.counts, comp = s.compute, st = s.storage, al = s.allocation;
  const osPie = s.osDistribution.map((o) => ({ ...o, fill: OS_COLORS[o.name] || '#64748b' }));

  const vcCols = [
    { key: 'name', label: 'vCenter' },
    { key: 'region', label: '리전' },
    { key: 'hosts', label: '호스트', align: 'right' },
    { key: 'vms', label: 'VM', align: 'right' },
    { key: 'cpuCores', label: 'CPU 코어', align: 'right' },
    { key: 'vcpuAllocated', label: 'vCPU 할당', align: 'right' },
    { key: 'memTotalGB', label: 'RAM(GB)', align: 'right' },
    { key: 'ramAllocatedGB', label: 'RAM 할당(GB)', align: 'right' },
    { key: 'storageTotalTB', label: '스토리지(TB)', align: 'right' },
    { key: 'provisionedTB', label: '프로비저닝(TB)', align: 'right' },
  ];
  // totals row
  const totals = s.byVcenter.reduce((a, r) => {
    for (const k of ['hosts', 'vms', 'cpuCores', 'vcpuAllocated', 'memTotalGB', 'ramAllocatedGB', 'storageTotalTB', 'provisionedTB']) {
      a[k] = (a[k] || 0) + (r[k] || 0);
    }
    return a;
  }, {});

  const osAlloc = s.osAllocation || [];
  const osAllocTotals = osAlloc.reduce((a, r) => {
    a.vms += r.vms; a.vcpu += r.vcpu; a.ramGB += r.ramGB; a.diskGB += r.diskGB; return a;
  }, { vms: 0, vcpu: 0, ramGB: 0, diskGB: 0 });
  const corpName = corp ? (vcList || []).find((v) => v.id === corp)?.name || corp : '전체 법인';

  return (
    <>
      <div className="flex between wrap" style={{ marginBottom: 4, alignItems: 'center' }}>
        <div className="section-title" style={{ margin: '6px 0' }}>전체 통합 합계 {corp ? `— ${corpName}` : '(모든 vCenter 자원 SUM)'}</div>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
          <span className="muted">법인 필터</span>
          <select className="select" value={corp} onChange={(e) => setCorp(e.target.value)}>
            <option value="">전체 법인</option>
            {(vcList || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
      </div>
      <div className="kpis">
        <Big label="vCenter" value={fmt(c.vcenters)} sub={`연결 ${c.vcentersConnected} · 클러스터 ${c.clusters}`} accent="var(--accent-2)" />
        <Big label="전체 호스트(ESXi)" value={fmt(c.hosts)} sub={`정상 ${c.hostsConnected} · 점검 ${c.hostsMaintenance} · 끊김 ${c.hostsDisconnected}`} />
        <Big label="전체 가상머신(VM)" value={fmt(c.vms)} sub={`구동 ${fmt(c.vmsPoweredOn)} · 정지 ${fmt(c.vmsPoweredOff)}`} accent="var(--green)" />
        <Big label="전체 데이터스토어" value={fmt(c.datastores)} sub={`네트워크 ${fmt(c.networks)}개`} />
        <Big label="전체 CPU 코어" value={fmt(comp.cpuCores)} sub={`${fmt(comp.cpuTotalGhz)} GHz 물리 용량`} />
        <Big label="전체 메모리" value={fmt(comp.memTotalGB)} unit="GB" sub={`≈ ${(comp.memTotalGB / 1024).toFixed(1)} TB`} />
        <Big label="전체 스토리지" value={fmt(st.capacityTB)} unit="TB" sub={`여유 ${st.freeTB} TB`} />
        {s.power?.reporting > 0 && (
          <Big label="총 소비전력" value={fmt(s.power.kw)} unit="kW" accent="var(--amber)" sub={`${fmt(s.power.reporting)}개 호스트 · 연 ≈ ${fmt(s.power.annualMwh)} MWh`} />
        )}
        <Big label="활성 알람" value={fmt(c.alarms)} accent={c.alarmsCritical ? 'var(--red)' : 'var(--amber)'} sub={`위험 ${c.alarmsCritical} · 경고 ${c.alarmsWarning}`} />
      </div>

      <div className="section-title">물리 자원 사용량 (호스트 기준 합계)</div>
      <div className="grid cols-3">
        <CapacityBar label="CPU" pct={comp.cpuUsagePct} usedLabel={`${fmt(comp.cpuUsedGhz)} GHz`} totalLabel={`${fmt(comp.cpuTotalGhz)} GHz`} />
        <CapacityBar label="메모리" pct={comp.memUsagePct} usedLabel={`${fmt(comp.memUsedGB)} GB`} totalLabel={`${fmt(comp.memTotalGB)} GB`} />
        <CapacityBar label="스토리지" pct={st.usagePct} usedLabel={`${st.usedTB} TB`} totalLabel={`${st.capacityTB} TB`} />
      </div>

      <div className="section-title">VM 할당 합계 &amp; 오버커밋</div>
      <div className="kpis">
        <Big label="할당된 vCPU 합계" value={fmt(al.vcpuAllocated)} sub={`물리 코어 ${fmt(comp.cpuCores)}개`} accent="var(--accent)" />
        <Big label="vCPU : 물리코어 비율" value={`${al.vcpuPerCore} : 1`} sub={al.vcpuPerCore > 4 ? '높은 오버커밋' : '정상 범위'} accent={al.vcpuPerCore > 4 ? 'var(--amber)' : 'var(--green)'} onClick={() => setShowRatio(true)} />
        <Big label="할당된 RAM 합계" value={fmt(al.ramAllocatedGB)} unit="GB" sub={`물리 RAM의 ${al.ramOvercommitPct}%`} accent="var(--purple)" />
        <Big label="프로비저닝 스토리지" value={fmt(al.provisionedStorageTB)} unit="TB" sub="VM 디스크 할당 총량" accent="var(--accent-2)" />
        <Big label="호스트당 평균 VM" value={al.avgVmPerHost} sub={`전체 ${fmt(c.vms)} VM / ${fmt(c.hosts)} 호스트`} />
      </div>

      <div className="section-title">OS별 할당 자원 합계 {corp ? `— ${corpName}` : ''}</div>
      <div className="grid cols-2">
        <div className="card">
          <div className="flex between wrap" style={{ marginBottom: 8, gap: 8, alignItems: 'center' }}>
            <b>OS별 vCPU · 메모리 · 디스크 합계</b>
            <div className="flex gap wrap" style={{ alignItems: 'center' }}>
              <select className="select" value={osPower} onChange={(e) => setOsPower(e.target.value)} style={{ fontSize: 12, padding: '4px 8px' }}>
                <option value="all">전원 전체</option>
                <option value="on">On만</option>
                <option value="off">Off만</option>
              </select>
              <select className="select" value={osKind} onChange={(e) => setOsKind(e.target.value)} style={{ fontSize: 12, padding: '4px 8px' }}>
                <option value="all">VM+템플릿</option>
                <option value="vm">VM만</option>
                <option value="template">템플릿만</option>
              </select>
              <span className="muted" style={{ fontSize: 12 }}>{osAlloc.length} OS · {fmt(osAllocTotals.vms)} VM</span>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>Guest OS</th><th className="right">VM</th><th className="right">vCPU</th><th className="right">메모리(GB)</th><th className="right">디스크(GB)</th>
              </tr></thead>
              <tbody>
                {osAlloc.map((o) => (
                  <tr key={o.name}>
                    <td><span className="dot" style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 9, marginRight: 6, background: OS_COLORS[o.name] || '#64748b' }} />{o.name}</td>
                    <td className="right tabular">{fmt(o.vms)}</td>
                    <td className="right tabular">{fmt(o.vcpu)}</td>
                    <td className="right tabular">{fmt(o.ramGB)}</td>
                    <td className="right tabular">{fmt(o.diskGB)}</td>
                  </tr>
                ))}
                {osAlloc.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 20 }}>데이터 없음</td></tr>}
                <tr style={{ borderTop: '2px solid var(--accent)', fontWeight: 700 }}>
                  <td><b>합계</b></td>
                  <td className="right tabular">{fmt(osAllocTotals.vms)}</td>
                  <td className="right tabular">{fmt(osAllocTotals.vcpu)}</td>
                  <td className="right tabular">{fmt(osAllocTotals.ramGB)}</td>
                  <td className="right tabular">{fmt(osAllocTotals.diskGB)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <b>OS별 할당 자원 (정규화 비교)</b>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={osAlloc} margin={{ top: 14, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#243049" />
              <XAxis dataKey="name" stroke="#8b9bb4" fontSize={11} interval={0} angle={-20} textAnchor="end" height={50} />
              <YAxis stroke="#8b9bb4" fontSize={11} />
              <Tooltip contentStyle={tipStyle} itemStyle={itemStyle} labelStyle={labelStyle} cursor={{ fill: 'rgba(59,130,246,.08)' }}
                formatter={(v, n) => [fmt(v), n === 'vcpu' ? 'vCPU' : n === 'ramGB' ? 'RAM(GB)' : '디스크(GB)']} />
              <Legend wrapperStyle={{ fontSize: 12 }} formatter={(n) => (n === 'vcpu' ? 'vCPU' : n === 'ramGB' ? 'RAM(GB)' : '디스크(GB)')} />
              <Bar dataKey="vcpu" fill="#3b82f6" radius={[3, 3, 0, 0]} />
              <Bar dataKey="ramGB" fill="#a855f7" radius={[3, 3, 0, 0]} />
              <Bar dataKey="diskGB" fill="#22d3ee" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="flex between" style={{ marginBottom: 6 }}>
            <b>Guest OS 분포 (전체 VM)</b>
            <button className="tab" onClick={() => onGotoTab?.('vms')}>VM 보기 →</button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>OS 계열을 클릭하면 해당 VM 목록을 vCenter별로 볼 수 있습니다.</div>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={osPie} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={60} outerRadius={95} paddingAngle={2}
                onClick={(slice) => slice?.name && setOsDrill(slice.name)} style={{ cursor: 'pointer' }}>
                {osPie.map((d, i) => <Cell key={i} fill={d.fill} style={{ cursor: 'pointer' }} />)}
              </Pie>
              <Tooltip contentStyle={tipStyle} itemStyle={itemStyle} labelStyle={labelStyle} formatter={(v, n) => [`${fmt(v)} VM`, n]} />
              <Legend wrapperStyle={{ fontSize: 12, cursor: 'pointer' }} onClick={(e) => e?.value && setOsDrill(e.value)} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <b>물리 용량 vs 할당 (오버커밋 시각화)</b>
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <OverBar title="CPU" physical={comp.cpuCores} physicalLabel={`${fmt(comp.cpuCores)} cores`}
              allocated={al.vcpuAllocated} allocatedLabel={`${fmt(al.vcpuAllocated)} vCPU`} />
            <OverBar title="메모리" physical={comp.memTotalGB} physicalLabel={`${fmt(comp.memTotalGB)} GB`}
              allocated={al.ramAllocatedGB} allocatedLabel={`${fmt(al.ramAllocatedGB)} GB`} />
            <OverBar title="스토리지" physical={st.capacityTB} physicalLabel={`${st.capacityTB} TB`}
              allocated={al.provisionedStorageTB} allocatedLabel={`${al.provisionedStorageTB} TB`} />
          </div>
        </div>
      </div>

      <div className="section-title">vCenter별 기여도 (사이트별 합계)</div>
      <div className="table-wrap">
        <table>
          <thead><tr>{vcCols.map((col) => <th key={col.key} style={{ textAlign: col.align || 'left' }}>{col.label}</th>)}</tr></thead>
          <tbody>
            {s.byVcenter.map((r) => (
              <tr key={r.id}>
                <td><b>{r.name}</b></td>
                <td>{r.region}</td>
                <td className="right tabular">{fmt(r.hosts)}</td>
                <td className="right tabular">{fmt(r.vms)}</td>
                <td className="right tabular">{fmt(r.cpuCores)}</td>
                <td className="right tabular">{fmt(r.vcpuAllocated)}</td>
                <td className="right tabular">{fmt(r.memTotalGB)}</td>
                <td className="right tabular">{fmt(r.ramAllocatedGB)}</td>
                <td className="right tabular">{r.storageTotalTB}</td>
                <td className="right tabular">{r.provisionedTB}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '2px solid var(--accent)', fontWeight: 700 }}>
              <td><b>합계</b></td><td className="muted">{s.byVcenter.length} vCenter</td>
              <td className="right tabular">{fmt(totals.hosts)}</td>
              <td className="right tabular">{fmt(totals.vms)}</td>
              <td className="right tabular">{fmt(totals.cpuCores)}</td>
              <td className="right tabular">{fmt(totals.vcpuAllocated)}</td>
              <td className="right tabular">{fmt(totals.memTotalGB)}</td>
              <td className="right tabular">{fmt(totals.ramAllocatedGB)}</td>
              <td className="right tabular">{Number(totals.storageTotalTB).toFixed(1)}</td>
              <td className="right tabular">{Number(totals.provisionedTB).toFixed(1)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {showRatio && <VcpuRatioModal rows={s.byVcenter} onClose={() => setShowRatio(false)} />}
      {osDrill && (
        <GuestOsVmsModal
          label={`${osDrill}${corp ? ` — ${corpName}` : ''}`}
          params={{
            family: osDrill,
            ...(corp ? { vcenterId: corp } : {}),
            ...(osPower !== 'all' ? { power: osPower } : {}),
            ...(osKind !== 'all' ? { kind: osKind } : {}),
          }}
          onClose={() => setOsDrill(null)}
        />
      )}
    </>
  );
}

function OverBar({ title, physical, physicalLabel, allocated, allocatedLabel }) {
  const max = Math.max(physical, allocated, 1);
  const ratio = physical > 0 ? allocated / physical : 0;
  return (
    <div>
      <div className="flex between" style={{ fontSize: 12, marginBottom: 6 }}>
        <b>{title}</b>
        <span className="tabular" style={{ color: ratio > 1 ? 'var(--amber)' : 'var(--text-dim)' }}>
          할당/물리 {Math.round(ratio * 100)}%
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <span className="muted" style={{ width: 56, fontSize: 11 }}>물리</span>
          <div className="usage-bar" style={{ flex: 1, height: 9 }}><span style={{ width: `${(physical / max) * 100}%`, background: 'var(--accent)' }} /></div>
          <span className="tabular" style={{ width: 92, textAlign: 'right', fontSize: 11 }}>{physicalLabel}</span>
        </div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <span className="muted" style={{ width: 56, fontSize: 11 }}>할당</span>
          <div className="usage-bar" style={{ flex: 1, height: 9 }}><span style={{ width: `${(allocated / max) * 100}%`, background: ratio > 1 ? 'var(--amber)' : 'var(--purple)' }} /></div>
          <span className="tabular" style={{ width: 92, textAlign: 'right', fontSize: 11 }}>{allocatedLabel}</span>
        </div>
      </div>
    </div>
  );
}
