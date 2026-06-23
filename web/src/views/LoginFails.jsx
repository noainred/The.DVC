import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import GuestScanJobs from './GuestScanJobs.jsx';

const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : '—');
const fmtHour = (ts) => new Date(ts).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit' });

/** 설정 → 로그인 실패 분석 — vCenter 이벤트 + 포탈 로그인 실패 집계 · 브루트포스 탐지. */
export default function LoginFails() {
  const [s, setS] = useState(null);
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const loadAll = async () => {
    try {
      const st = await fetchJson('/admin/security/login-fails/status');
      setS((cur) => cur || st.settings);
      const an = await fetchJson('/admin/security/login-fails');
      setD(an); setErr(null);
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { loadAll(); const t = setInterval(loadAll, 30_000); return () => clearInterval(t); }, []);
  if (err) return <ErrorBox message={err} />;
  if (!s || !d) return <Loading />;

  const save = async () => { setBusy('save'); setMsg(null); try { const r = await putJson('/admin/security/login-fails/settings', s); setS(r); setMsg('저장됨'); } catch (e) { setMsg(e.message); } finally { setBusy(''); } };
  const run = async () => { setBusy('run'); setMsg(null); try { await postJson('/admin/security/login-fails/run', {}); await loadAll(); setMsg('분석 실행됨'); } catch (e) { setMsg(e.message); } finally { setBusy(''); } };

  const sm = d.summary;
  return (
    <div style={{ maxWidth: 1080 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🔐 로그인 실패 분석</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        vCenter 이벤트 로그(장기보관)와 포탈 자체 로그인 실패를 주기적으로 수집·분석해 <b>브루트포스</b>(임계 이상 반복)를 탐지하고 알림을 보냅니다.
        vCenter 실패 분석은 <b>설정 › vCenter 로그 보관</b>이 켜져 있어야 데이터가 쌓입니다.
      </p>

      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 16 }}>
          <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> <b>모니터링</b></label>
          <span className="muted">분석 주기</span><input className="input" type="number" style={{ width: 64 }} value={s.intervalMin} onChange={(e) => setS({ ...s, intervalMin: e.target.value })} /><span className="muted">분</span>
          <span className="muted">분석 기간</span><input className="input" type="number" style={{ width: 64 }} value={s.days} onChange={(e) => setS({ ...s, days: e.target.value })} /><span className="muted">일</span>
          <span className="muted"><b>임계</b></span><input className="input" type="number" style={{ width: 56 }} value={s.threshold} onChange={(e) => setS({ ...s, threshold: e.target.value })} /><span className="muted">회</span>
          <span className="muted">활성창</span><input className="input" type="number" style={{ width: 56 }} value={s.windowMin} onChange={(e) => setS({ ...s, windowMin: e.target.value })} /><span className="muted">분</span>
          <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={s.alert} onChange={(e) => setS({ ...s, alert: e.target.checked })} /> 알림</label>
        </div>
        <div className="flex gap" style={{ marginTop: 12, alignItems: 'center' }}>
          <button className="login-btn" style={{ padding: '8px 16px' }} disabled={busy === 'save'} onClick={save}>저장</button>
          <button className="logout-btn" style={{ padding: '8px 16px' }} disabled={busy === 'run'} onClick={run}>지금 분석</button>
          {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
        </div>
      </div>

      <GuestScanJobs type="login-fails" />

      <div className="flex gap wrap" style={{ marginBottom: 12 }}>
        {[['총 실패', sm.total], ['vCenter', sm.vcenter], ['포탈', sm.portal], ['관련 계정', sm.users], ['관련 IP', sm.ips], ['브루트포스', sm.offenders, sm.offenders ? '#f59e0b' : ''], ['활성 공격', sm.active, sm.active ? '#ef4444' : '#22c55e']].map(([l, v, c]) => (
          <div key={l} className="card" style={{ padding: '10px 14px', minWidth: 96 }}><div className="muted" style={{ fontSize: 11 }}>{l}</div><div style={{ fontSize: 20, fontWeight: 700, color: c || 'inherit' }}>{v}</div></div>
        ))}
      </div>

      {d.timeline.length > 0 && (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>시간대별 로그인 실패</div>
          <ResponsiveContainer width="100%" height={170}>
            <BarChart data={d.timeline}>
              <CartesianGrid stroke="rgba(148,163,184,.15)" /><XAxis dataKey="ts" tickFormatter={fmtHour} tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip labelFormatter={fmtHour} contentStyle={{ background: '#1e293b', border: 'none', fontSize: 12 }} />
              <Bar dataKey="count" name="실패" fill="#ef4444" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {d.offenders.length > 0 && (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>브루트포스 의심 ({d.offenders.length})</div>
          <div className="table-wrap" style={{ maxHeight: '36vh' }}>
            <table><thead><tr><th>유형</th><th>대상</th><th style={{ textAlign: 'right' }}>최근창</th><th style={{ textAlign: 'right' }}>누적</th><th>상태</th><th>마지막</th></tr></thead>
              <tbody>{d.offenders.map((o) => (
                <tr key={o.label + o.key}>
                  <td>{o.label === 'user' ? '계정' : '출발지 IP'}</td><td><b>{o.key}</b></td>
                  <td style={{ textAlign: 'right' }}>{o.recent}</td><td style={{ textAlign: 'right' }}>{o.total}</td>
                  <td>{o.active ? <span className="badge red">활성</span> : <span className="badge amber">의심</span>}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{fmtTime(o.lastTs)}</td>
                </tr>
              ))}</tbody></table>
          </div>
        </div>
      )}

      <div className="flex gap wrap" style={{ alignItems: 'flex-start' }}>
        <TopList title="실패 상위 계정" rows={d.topUsers} />
        <TopList title="실패 상위 IP" rows={d.topIps} />
      </div>

      <div className="card" style={{ padding: 14, marginTop: 12 }}>
        <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>최근 로그인 실패</div>
        <div className="table-wrap" style={{ maxHeight: '40vh' }}>
          <table><thead><tr><th>시각</th><th>출처</th><th>계정</th><th>IP</th><th>유형</th></tr></thead>
            <tbody>{d.recent.map((r, i) => (
              <tr key={i}><td className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{fmtTime(r.ts)}</td><td style={{ fontSize: 12 }}>{r.source}</td><td style={{ fontSize: 12 }}>{r.user}</td><td className="muted" style={{ fontSize: 12 }}>{r.ip || '—'}</td><td className="muted" style={{ fontSize: 11 }}>{r.type}</td></tr>
            ))}</tbody></table>
        </div>
      </div>
    </div>
  );
}

function TopList({ title, rows }) {
  return (
    <div className="card" style={{ padding: 14, flex: '1 1 320px' }}>
      <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>{title}</div>
      {(rows || []).length === 0 ? <span className="muted" style={{ fontSize: 12 }}>—</span> : rows.map((r) => (
        <div key={r.key} className="flex between" style={{ fontSize: 13, padding: '2px 0' }}><span>{r.key}</span><b>{r.count}</b></div>
      ))}
    </div>
  );
}
