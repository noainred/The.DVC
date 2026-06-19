import React from 'react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
} from 'recharts';
import { usePolling } from '../api.js';
import { Loading, ErrorBox, usageColor } from '../components/ui.jsx';

const OS_COLORS = {
  Windows: '#3b82f6', RHEL: '#ef4444', Ubuntu: '#f59e0b', CentOS: '#a855f7',
  SUSE: '#22c55e', Debian: '#ec4899', Other: '#64748b',
};
const tipStyle = { background: '#0c1322', border: '1px solid #243049', borderRadius: 8, color: '#e6edf6', fontSize: 12 };
const itemStyle = { color: '#e6edf6' };
const labelStyle = { color: '#8b9bb4' };
const fmt = (n) => (n ?? 0).toLocaleString('en-US');

function Big({ label, value, unit, sub, accent }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className="value" style={accent ? { color: accent } : undefined}>{value}{unit && <small> {unit}</small>}</div>
      {sub && <div className="meta">{sub}</div>}
    </div>
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
  const { data: s, error, loading } = usePolling('/summary', scope, 15_000);
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

  return (
    <>
      <div className="section-title">전체 통합 합계 (모든 vCenter 자원 SUM)</div>
      <div className="kpis">
        <Big label="vCenter" value={fmt(c.vcenters)} sub={`연결 ${c.vcentersConnected} · 클러스터 ${c.clusters}`} accent="var(--accent-2)" />
        <Big label="전체 호스트(ESXi)" value={fmt(c.hosts)} sub={`정상 ${c.hostsConnected} · 점검 ${c.hostsMaintenance} · 끊김 ${c.hostsDisconnected}`} />
        <Big label="전체 가상머신(VM)" value={fmt(c.vms)} sub={`구동 ${fmt(c.vmsPoweredOn)} · 정지 ${fmt(c.vmsPoweredOff)}`} accent="var(--green)" />
        <Big label="전체 데이터스토어" value={fmt(c.datastores)} sub={`네트워크 ${fmt(c.networks)}개`} />
        <Big label="전체 CPU 코어" value={fmt(comp.cpuCores)} sub={`${fmt(comp.cpuTotalGhz)} GHz 물리 용량`} />
        <Big label="전체 메모리" value={fmt(comp.memTotalGB)} unit="GB" sub={`≈ ${(comp.memTotalGB / 1024).toFixed(1)} TB`} />
        <Big label="전체 스토리지" value={fmt(st.capacityTB)} unit="TB" sub={`여유 ${st.freeTB} TB`} />
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
        <Big label="vCPU : 물리코어 비율" value={`${al.vcpuPerCore} : 1`} sub={al.vcpuPerCore > 4 ? '높은 오버커밋' : '정상 범위'} accent={al.vcpuPerCore > 4 ? 'var(--amber)' : 'var(--green)'} />
        <Big label="할당된 RAM 합계" value={fmt(al.ramAllocatedGB)} unit="GB" sub={`물리 RAM의 ${al.ramOvercommitPct}%`} accent="var(--purple)" />
        <Big label="프로비저닝 스토리지" value={fmt(al.provisionedStorageTB)} unit="TB" sub="VM 디스크 할당 총량" accent="var(--accent-2)" />
        <Big label="호스트당 평균 VM" value={al.avgVmPerHost} sub={`전체 ${fmt(c.vms)} VM / ${fmt(c.hosts)} 호스트`} />
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="flex between" style={{ marginBottom: 6 }}>
            <b>Guest OS 분포 (전체 VM)</b>
            <button className="tab" onClick={() => onGotoTab?.('vms')}>VM 보기 →</button>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={osPie} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={60} outerRadius={95} paddingAngle={2}>
                {osPie.map((d, i) => <Cell key={i} fill={d.fill} />)}
              </Pie>
              <Tooltip contentStyle={tipStyle} itemStyle={itemStyle} labelStyle={labelStyle} formatter={(v, n) => [`${fmt(v)} VM`, n]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
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
