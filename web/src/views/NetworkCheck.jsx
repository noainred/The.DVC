import React, { useEffect, useState } from 'react';
import { fetchJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

// 상태 색상 — 스크린샷과 동일(정상=하늘, +20%=노랑, +50%=빨강).
const COLOR = { ok: '#38bdf8', warn: '#eab308', crit: '#ef4444', down: '#ef4444', unknown: '#6b7280' };
const RANGES = [['1d', '1일'], ['7d', '7일'], ['30d', '30일'], ['90d', '90일'], ['365d', '365일']];

const tfmt = (ts) => { const d = new Date(ts); return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ${d.toLocaleTimeString('ko-KR')}`; };

/** 서버 1대의 응답지연 산점도 — 점 색상=상태, 회색 연결선, 평소(중앙값) 점선. */
export function ScatterChart({ series = [], baseline }) {
  const W = 520, H = 200, padL = 44, padR = 10, padT = 16, padB = 26;
  const pts = series.filter((s) => s.rtt != null);
  if (!series.length) return <div className="center muted" style={{ padding: 28, fontSize: 12 }}>측정 데이터가 없습니다.</div>;
  const maxRtt = Math.max(1, baseline ? baseline * 1.6 : 1, ...pts.map((s) => s.rtt));
  const t0 = series[0].ts, t1 = series[series.length - 1].ts;
  const span = Math.max(1, t1 - t0);
  const x = (ts) => padL + (W - padL - padR) * ((ts - t0) / span);
  const y = (v) => padT + (H - padT - padB) * (1 - Math.min(v, maxRtt) / maxRtt);
  const baseY = baseline ? y(baseline) : null;
  // 연결선: 인접 유효점만 이어 그린다(무응답 구간은 끊김).
  const segs = [];
  let cur = [];
  for (const s of series) { if (s.rtt != null) cur.push(`${x(s.ts).toFixed(1)},${y(s.rtt).toFixed(1)}`); else { if (cur.length > 1) segs.push(cur.join(' ')); cur = []; } }
  if (cur.length > 1) segs.push(cur.join(' '));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
      {[0, 0.5, 1].map((f) => { const yy = padT + (H - padT - padB) * f; const v = maxRtt * (1 - f); return (
        <g key={f}><line x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="rgba(255,255,255,.07)" />{f !== 1 && <text x={padL - 6} y={yy + 3} fill="#9ca3af" fontSize="9" textAnchor="end">{v < 10 ? v.toFixed(1) : Math.round(v)}ms</text>}</g>
      ); })}
      {baseY != null && <line x1={padL} y1={baseY} x2={W - padR} y2={baseY} stroke="#94a3b8" strokeDasharray="4 3" strokeWidth="1" />}
      {segs.map((pstr, i) => <polyline key={i} points={pstr} fill="none" stroke="rgba(148,163,184,.35)" strokeWidth="0.8" />)}
      {series.map((s, i) => (s.rtt != null
        ? <circle key={i} cx={x(s.ts)} cy={y(s.rtt)} r={s.status === 'crit' ? 2.6 : (s.status === 'warn' ? 2.4 : 1.8)} fill={COLOR[s.status] || COLOR.ok}><title>{`${tfmt(s.ts)}\n${s.rtt}ms · ${s.status}`}</title></circle>
        : null))}
      <text x={padL} y={H - 8} fill="#9ca3af" fontSize="9">{tfmt(t0)}</text>
      <text x={W - padR} y={H - 8} fill="#9ca3af" fontSize="9" textAnchor="end">{tfmt(t1)}</text>
    </svg>
  );
}

function Legend() {
  const items = [['ok', '정상'], ['warn', '+20% 이상'], ['crit', '+50% 이상']];
  return (
    <div className="flex gap wrap" style={{ alignItems: 'center', fontSize: 12 }}>
      {items.map(([k, l]) => <span key={k} className="flex" style={{ alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 5, background: COLOR[k], display: 'inline-block' }} />{l}</span>)}
      <span className="flex" style={{ alignItems: 'center', gap: 5 }}><span style={{ width: 16, borderTop: '2px dashed #94a3b8', display: 'inline-block' }} />평소(중앙값)</span>
    </div>
  );
}

export default function NetworkCheck() {
  const [range, setRange] = useState('1d');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = () => { setError(null); fetchJson('/ping/edge/overview', { range }).then(setData).catch((e) => setError(e.message)); };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [range]);
  useEffect(() => { fetchJson('/auth/me').then((r) => setIsAdmin(r.user?.role === 'admin')).catch(() => {}); }, []);
  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 4000); };
  const sync = async () => { setBusy(true); const r = await postJson('/ping/edge/sync').catch((e) => ({ ok: false, reason: e.message })); setBusy(false); flash(r.ok, r.ok ? (r.added ? `엣지 노드 ${r.added}개를 추가했습니다.` : '추가할 새 엣지 노드가 없습니다.') : (r.reason || '동기화 실패')); if (r.ok && r.added) load(); };

  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  return (
    <>
      <div className="flex between wrap gap" style={{ alignItems: 'flex-start', marginBottom: 6 }}>
        <div>
          <div className="section-title" style={{ marginTop: 0, marginBottom: 4 }}>네트워크 체크 (서버 Ping)</div>
          <div className="muted" style={{ fontSize: 12.5 }}>매니저에서 각 서버로의 TCP 연결 지연(ms)을 주기적으로 측정해 1년간 누적합니다. 평소(중앙값) 대비 +20% 노랑, +50% 빨강으로 표시됩니다.</div>
        </div>
        <div className="flex gap" style={{ flexShrink: 0 }}>
          {RANGES.map(([k, l]) => <button key={k} className={range === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 11px' }} onClick={() => setRange(k)}>{l}</button>)}
          <button className="logout-btn" style={{ padding: '6px 11px' }} disabled={busy} onClick={load}>새로고침</button>
          {isAdmin && <button className="logout-btn" style={{ padding: '6px 11px' }} disabled={busy} onClick={sync} title="등록된 엣지 노드(수집 서버)를 대상으로 동기화">엣지 동기화</button>}
        </div>
      </div>
      <div style={{ margin: '10px 0 16px' }}><Legend /></div>
      {msg && <div className="card" style={{ padding: '8px 12px', marginBottom: 12, borderLeft: `3px solid var(--${msg.ok ? 'green' : 'red'})`, fontSize: 13 }}>{msg.ok ? '✓' : '⚠'} {msg.text}</div>}

      {data.groups.length === 0 && (
        <div className="card center muted" style={{ padding: 40 }}>
          측정 대상(엣지 노드)이 없습니다. {isAdmin ? "우측 상단 '엣지 동기화'로 등록된 수집 서버를 대상으로 추가하세요." : '관리자에게 엣지 노드 등록을 요청하세요.'}
        </div>
      )}
      {data.groups.map((g) => (
        <div key={g.id || 'none'} style={{ marginBottom: 22 }}>
          <div style={{ fontWeight: 700, fontSize: 15, borderBottom: '1px solid rgba(255,255,255,.12)', paddingBottom: 6, marginBottom: 12 }}>{g.name}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
            {g.items.map((s) => (
              <div key={s.id} className="card" style={{ padding: '12px 14px' }}>
                <div className="flex between" style={{ alignItems: 'baseline', marginBottom: 6 }}>
                  <b style={{ fontSize: 14, color: COLOR[s.status] || undefined }}>{s.name}</b>
                  <span className="muted" style={{ fontSize: 12 }}>평소(중앙값) {s.baseline != null ? `${s.baseline} ms` : '—'}</span>
                </div>
                <ScatterChart series={s.series} baseline={s.baseline} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
