// DsTrendModal(v2.354) — 개별 데이터스토어의 사용량 추이 모달. 스토리지 탭·특수기능 어디서든
// dsId 하나로 띄운다. 차트는 '스토리지 사용량 추이'와 같은 형식: 총 용량 한도선(라인) +
// 슬롯(00/12시)별 사용량 막대 + 사용률(%) 점선. 데이터는 vm-track.db 의 diff-압축 시계열
// (GET /tools/vm-track/ds-series — 서버가 step 으로 펼쳐 줌). 첫 관측 이전 슬롯은 공백.
import React, { useEffect, useState } from 'react';
import { ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { fetchJson } from '../../api.js';
import { Loading } from '../../components/ui.jsx';
import EscClose from '../../components/EscClose.jsx';
import { tb, gbTb, slotLabel } from './storageTrack.js';

const DAY_OPTS = [7, 30, 90, 365];
const pctColor = (p) => (p >= 90 ? 'var(--red)' : p >= 75 ? 'var(--amber)' : 'var(--green)');

export default function DsTrendModal({ dsId, name, vcenterId, type, onClose }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    setData(null);
    fetchJson('/tools/vm-track/ds-series', { dsId, days })
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(e.message));
  }, [dsId, days]);

  const pts = data?.points || [];
  // 개별 DS 는 용량이 수백 GB~수천 TB 로 편차가 커 축 단위를 자동 선택(10TB 이상이면 TB).
  const maxCap = pts.reduce((m, p) => Math.max(m, p.capGB || 0), 0);
  const useTb = maxCap >= 10_240;
  const unit = useTb ? 'TB' : 'GB';
  const u = (gb) => (gb == null ? null : (useTb ? tb(gb) : Math.round(gb * 10) / 10));
  const chart = pts.map((p) => ({ label: slotLabel(p.slot), cap: u(p.capGB), used: u(p.usedGB), pct: p.usagePct }));
  const obs = pts.filter((p) => p.usedGB != null);
  const first = obs[0] || null;
  const last = obs[obs.length - 1] || null;
  const delta = first && last ? Math.round(((last.usedGB || 0) - (first.usedGB || 0)) * 10) / 10 : 0;

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal card" style={{ maxWidth: 900 }}>
        <div className="flex between wrap" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>📈 {name || dsId} — 사용량 추이</h3>
          <span className="flex gap">
            {DAY_OPTS.map((d) => (
              <button key={d} className={days === d ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 10px', fontSize: 12 }} onClick={() => setDays(d)}>{d}일</button>
            ))}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
          {vcenterId || data?.vcenterId || ''}{type ? ` · ${type}` : ''} · 매일 00시·12시 스냅샷 기준
          {last && (
            <span style={{ marginLeft: 8, color: 'var(--text)' }}>
              현재 <b>{gbTb(last.usedGB)}</b> / {gbTb(last.capGB)}
              {last.usagePct != null && <b style={{ marginLeft: 4, color: pctColor(last.usagePct) }}>({last.usagePct}%)</b>}
              <span className="muted"> · {days}일 증감 </span>
              <b style={{ color: delta > 0 ? 'var(--amber)' : delta < 0 ? 'var(--green)' : undefined }}>{delta > 0 ? '+' : ''}{gbTb(delta)}</b>
            </span>
          )}
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>⚠ {err}</div>}
        {!data && !err && <Loading />}
        {data && (obs.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, padding: '24px 0', textAlign: 'center' }}>
            아직 이 데이터스토어의 관측 스냅샷이 없습니다.<br />
            개별 추적은 v2.353 설치 후 첫 00시·12시 스냅샷부터 쌓입니다(과거 값은 소급하지 않음).
          </div>
        ) : (
          <div style={{ width: '100%', height: 280, marginTop: 10 }}>
            <ResponsiveContainer>
              <ComposedChart data={chart} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.18)" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="v" tick={{ fontSize: 11 }} domain={[0, 'auto']} />
                <YAxis yAxisId="pct" orientation="right" tick={{ fontSize: 11 }} domain={[0, 100]} unit="%" />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(148,163,184,.3)', fontSize: 12 }}
                  formatter={(v, n) => [n === 'pct' ? `${v}%` : `${Number(v).toLocaleString()} ${unit}`,
                    n === 'cap' ? '총 용량' : n === 'used' ? '사용량' : '사용률']} />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => (v === 'cap' ? `총 용량(${unit})` : v === 'used' ? `사용량(${unit})` : '사용률(%)')} />
                <Bar yAxisId="v" dataKey="used" fill="#f59e0b" fillOpacity={0.85} maxBarSize={26} />
                <Line yAxisId="v" type="monotone" dataKey="cap" stroke="#60a5fa" strokeWidth={2} dot={false} />
                <Line yAxisId="pct" type="monotone" dataKey="pct" stroke="#a78bfa" strokeWidth={1.2} strokeDasharray="2 2" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ))}
        <div className="flex gap" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="login-btn" style={{ padding: '8px 18px' }} onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}
