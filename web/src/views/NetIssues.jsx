import React, { useEffect, useState } from 'react';
import { fetchJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import GuestScanJobs from './GuestScanJobs.jsx';

const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : '—');
const fmtHour = (ts) => new Date(ts).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit' });

/** 설정 → 네트워크 이슈 분석 — 게스트 OS 인터페이스 카운터의 패킷드랍/에러 증가분을 주기 수집·분석. */
export default function NetIssues() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);

  const load = async () => {
    try { const an = await fetchJson('/admin/security/net-issues'); setD(an); setErr(null); } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);
  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;

  const sm = d.summary;
  return (
    <div style={{ maxWidth: 1080 }}>
      <div className="section-title" style={{ marginTop: 0 }}>📉 네트워크 이슈 분석</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        게스트 OS의 인터페이스 카운터(패킷 드롭·에러)를 주기적으로 수집해 직전 대비 <b>증가분(델타)</b>을 산출하고,
        드롭/에러가 늘어난 VM·인터페이스를 찾아 분석합니다. 아래에서 vCenter별·OS별 조사 주기를 등록하세요.
      </p>

      <GuestScanJobs type="net-issues" />

      <div className="flex gap wrap" style={{ marginBottom: 12 }}>
        {[['이슈 건수', sm.total], ['관련 VM', sm.vms], ['드롭 합', sm.drops, sm.drops ? '#f59e0b' : ''], ['에러 합', sm.errors, sm.errors ? '#ef4444' : '']].map(([l, v, c]) => (
          <div key={l} className="card" style={{ padding: '10px 14px', minWidth: 110 }}><div className="muted" style={{ fontSize: 11 }}>{l}</div><div style={{ fontSize: 20, fontWeight: 700, color: c || 'inherit' }}>{v}</div></div>
        ))}
      </div>

      {d.timeline.length > 0 && (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>시간대별 드롭·에러</div>
          <ResponsiveContainer width="100%" height={170}>
            <BarChart data={d.timeline}>
              <CartesianGrid stroke="rgba(148,163,184,.15)" /><XAxis dataKey="ts" tickFormatter={fmtHour} tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip labelFormatter={fmtHour} contentStyle={{ background: '#1e293b', border: 'none', fontSize: 12 }} />
              <Bar dataKey="drop" name="드롭" stackId="a" fill="#f59e0b" radius={[3, 3, 0, 0]} />
              <Bar dataKey="err" name="에러" stackId="a" fill="#ef4444" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {d.topVms.length > 0 && (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>이슈 상위 VM ({d.topVms.length})</div>
          <div className="table-wrap" style={{ maxHeight: '38vh' }}>
            <table><thead><tr><th>VM</th><th>vCenter</th><th>OS</th><th style={{ textAlign: 'right' }}>드롭</th><th style={{ textAlign: 'right' }}>에러</th><th style={{ textAlign: 'right' }}>이벤트</th><th style={{ textAlign: 'right' }}>최대드롭률</th></tr></thead>
              <tbody>{d.topVms.map((v) => (
                <tr key={v.key}>
                  <td><b>{v.vm}</b></td><td style={{ fontSize: 12 }}>{v.vcenterId}</td><td style={{ fontSize: 12 }}>{v.os || '—'}</td>
                  <td style={{ textAlign: 'right', color: v.drop ? '#f59e0b' : 'inherit' }}>{v.drop}</td>
                  <td style={{ textAlign: 'right', color: v.err ? '#ef4444' : 'inherit' }}>{v.err}</td>
                  <td style={{ textAlign: 'right' }}>{v.events}</td>
                  <td style={{ textAlign: 'right' }}>{v.maxRate ? `${v.maxRate}%` : '—'}</td>
                </tr>
              ))}</tbody></table>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 14, marginBottom: 12 }}>
        <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>인터페이스별 누적</div>
        {d.byIface.length === 0 ? <span className="muted" style={{ fontSize: 12 }}>—</span> : d.byIface.map((r) => (
          <div key={r.key} className="flex between" style={{ fontSize: 13, padding: '2px 0' }}><span>{r.key}</span><b>{r.count}</b></div>
        ))}
      </div>

      <div className="card" style={{ padding: 14 }}>
        <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>최근 이슈</div>
        <div className="table-wrap" style={{ maxHeight: '40vh' }}>
          <table><thead><tr><th>시각</th><th>VM</th><th>인터페이스</th><th style={{ textAlign: 'right' }}>드롭</th><th style={{ textAlign: 'right' }}>에러</th><th style={{ textAlign: 'right' }}>드롭률</th></tr></thead>
            <tbody>{d.recent.map((r, i) => (
              <tr key={i}><td className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{fmtTime(r.ts)}</td><td style={{ fontSize: 12 }}>{r.vm}</td><td style={{ fontSize: 12 }}>{r.iface}</td><td style={{ textAlign: 'right' }}>{r.newDrop}</td><td style={{ textAlign: 'right' }}>{r.newErr}</td><td className="muted" style={{ textAlign: 'right', fontSize: 12 }}>{r.dropRate != null ? `${r.dropRate}%` : '—'}</td></tr>
            ))}</tbody></table>
        </div>
      </div>
    </div>
  );
}
