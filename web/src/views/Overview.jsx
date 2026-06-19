import React from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { usePolling } from '../api.js';
import { Kpi, Loading, ErrorBox, SeverityBadge } from '../components/ui.jsx';
import WorldMap from '../components/WorldMap.jsx';

const REGION_COLORS = { Americas: '#3b82f6', EMEA: '#a855f7', APAC: '#22d3ee', Unknown: '#64748b' };

export default function Overview({ onSelectSite, onGotoTab }) {
  const { data: ov, error, loading } = usePolling('/overview', {}, 15_000);
  const { data: alarmData } = usePolling('/alarms', { severity: undefined }, 15_000);

  if (loading && !ov) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  if (!ov) return null;

  const g = ov.global;
  const regions = ov.byRegion || [];
  const sites = ov.sites || [];
  const alarms = (alarmData?.items || []).slice(0, 8);

  const fmt = (n) => n?.toLocaleString('en-US');

  // VM 분포 by 법인(vCenter)
  const corpVmData = sites.map((s) => ({
    name: s.id || s.name,
    VM: s.metrics?.vms || 0,
    On: s.metrics?.vmsPoweredOn || 0,
  }));
  const capacityData = [
    { name: 'CPU', used: g.cpuUsagePct },
    { name: 'Memory', used: g.memUsagePct },
    { name: 'Storage', used: g.storageUsagePct },
  ];
  const osPie = regions.map((r) => ({ name: r.key, value: r.vms, fill: REGION_COLORS[r.key] || '#64748b' }));

  return (
    <>
      <div className="section-title">글로벌 현황</div>
      <div className="kpis">
        <Kpi label="vCenter" value={`${g.vcentersConnected}/${g.vcenters}`} meta={`${g.vcenters - g.vcentersConnected}개 연결 불가`} accent="var(--accent-2)" />
        <Kpi label="ESXi 호스트" value={fmt(g.hosts)} meta={`정상 ${g.hostsConnected} · 점검 ${g.hostsMaintenance} · 끊김 ${g.hostsDisconnected}`} />
        <Kpi label="가상머신" value={fmt(g.vms)} meta={`구동중 ${fmt(g.vmsPoweredOn)} · 정지 ${fmt(g.vmsPoweredOff)}`} accent="var(--green)" />
        <Kpi label="CPU 사용률" value={`${g.cpuUsagePct}%`} pct={g.cpuUsagePct} meta={`${g.cpuUsedGhz} / ${g.cpuTotalGhz} GHz · ${fmt(g.cpuCores)} cores`} />
        <Kpi label="메모리 사용률" value={`${g.memUsagePct}%`} pct={g.memUsagePct} meta={`${fmt(g.memUsedGB)} / ${fmt(g.memTotalGB)} GB`} />
        <Kpi label="스토리지 사용률" value={`${g.storageUsagePct}%`} pct={g.storageUsagePct} meta={`${g.storageUsedTB} / ${g.storageTotalTB} TB · ${g.datastores} DS`} />
        <Kpi label="네트워크" value={fmt(g.networks)} meta="포트그룹 / 분산스위치" />
        <Kpi label="알람" value={fmt(g.alarms)} accent={g.alarmsCritical ? 'var(--red)' : 'var(--amber)'} meta={`위험 ${g.alarmsCritical} · 경고 ${g.alarmsWarning}`} />
      </div>

      <div className="section-title">전세계 데이터센터 분포</div>
      <WorldMap sites={sites} onSelect={onSelectSite} />

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="flex between" style={{ marginBottom: 12 }}>
            <b>법인별 VM 분포</b>
            <span className="muted" style={{ fontSize: 12 }}>전원 On / 전체</span>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={corpVmData} margin={{ top: 5, right: 10, left: -10, bottom: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#243049" />
              <XAxis dataKey="name" stroke="#8b9bb4" fontSize={10} interval={0} angle={-30} textAnchor="end" height={60} />
              <YAxis stroke="#8b9bb4" fontSize={12} />
              <Tooltip contentStyle={tipStyle} cursor={{ fill: 'rgba(59,130,246,.08)' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="VM" fill="#334b7a" radius={[4, 4, 0, 0]} />
              <Bar dataKey="On" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <b>글로벌 리소스 사용률</b>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart layout="vertical" data={capacityData} margin={{ top: 14, right: 20, left: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#243049" horizontal={false} />
              <XAxis type="number" domain={[0, 100]} stroke="#8b9bb4" fontSize={12} unit="%" />
              <YAxis type="category" dataKey="name" stroke="#8b9bb4" fontSize={12} width={70} />
              <Tooltip contentStyle={tipStyle} cursor={{ fill: 'rgba(59,130,246,.08)' }} formatter={(v) => `${v}%`} />
              <Bar dataKey="used" radius={[0, 4, 4, 0]}>
                {capacityData.map((d, i) => (
                  <Cell key={i} fill={d.used >= 90 ? '#ef4444' : d.used >= 75 ? '#f59e0b' : '#22c55e'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="flex between" style={{ marginBottom: 6 }}>
            <b>최근 알람</b>
            <button className="tab" onClick={() => onGotoTab?.('alarms')}>전체 보기 →</button>
          </div>
          {alarms.length === 0 && <div className="muted" style={{ padding: 16 }}>활성 알람이 없습니다.</div>}
          {alarms.map((a) => (
            <div className="alarm-row" key={a.id}>
              <div className={`alarm-sev ${a.severity}`} />
              <div className="alarm-body">
                <div className="alarm-msg">{a.message}</div>
                <div className="alarm-meta">{a.entity} · {a.vcenterId} · {new Date(a.time).toLocaleString('ko-KR')}</div>
              </div>
              <SeverityBadge severity={a.severity} />
            </div>
          ))}
        </div>

        <div className="card">
          <b>리전별 워크로드 비중</b>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={osPie} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={3}>
                {osPie.map((d, i) => <Cell key={i} fill={d.fill} />)}
              </Pie>
              <Tooltip contentStyle={tipStyle} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}

const tipStyle = {
  background: '#0c1322', border: '1px solid #243049', borderRadius: 8, color: '#e6edf6', fontSize: 12,
};
