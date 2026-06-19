import React, { useEffect, useState } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { fetchJson } from '../api.js';

const TYPES = [
  { k: 'cpu', label: 'CPU 사용률', color: '#3b82f6' },
  { k: 'mem', label: '메모리 사용률', color: '#a855f7' },
  { k: 'disk', label: '디스크 I/O', color: '#22d3ee' },
  { k: 'net', label: '네트워크 I/O', color: '#22c55e' },
];
const INTERVALS = [
  { k: 'realtime', label: '실시간' },
  { k: 'day', label: '일 평균' },
  { k: 'week', label: '주 평균' },
  { k: 'month', label: '월 평균' },
  { k: 'year', label: '년 평균' },
];
const tipStyle = { background: '#0c1322', border: '1px solid #243049', borderRadius: 8, color: '#e6edf6', fontSize: 12 };

function fmtTick(t, interval) {
  const d = new Date(t);
  if (interval === 'realtime' || interval === 'day') return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  if (interval === 'year' || interval === 'month') return d.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' });
  return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit' });
}

/** Button that opens the on-demand VM performance viewer (a new window/modal). */
export function VmMetricButton({ vmId, vmName }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="login-btn" style={{ flex: 'none', padding: '8px 14px' }} onClick={() => setOpen(true)}>📈 성능 그래프 보기</button>
      {open && <VmMetricModal vmId={vmId} vmName={vmName} onClose={() => setOpen(false)} />}
    </>
  );
}

function VmMetricModal({ vmId, vmName, onClose }) {
  const [type, setType] = useState('cpu');
  const [interval, setIntv] = useState('realtime');
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let active = true;
    const fetchOnce = () => {
      fetchJson(`/vms/${encodeURIComponent(vmId)}/metrics`, { type, interval })
        .then((d) => { if (active) setState({ loading: false, data: d }); })
        .catch((e) => { if (active) setState({ loading: false, error: e.message }); });
    };
    setState({ loading: true });
    fetchOnce();
    // 실시간일 때만 20초마다 자동 갱신
    const timer = interval === 'realtime' ? setInterval(fetchOnce, 20_000) : null;
    return () => { active = false; if (timer) clearInterval(timer); };
  }, [vmId, type, interval]);

  const { loading, data, error } = state;
  const cfg = TYPES.find((t) => t.k === type);
  const pts = (data?.points || []).map((p) => ({ t: p.t, v: p.v }));
  const last = pts.length ? pts[pts.length - 1].v : null;
  const avg = pts.length ? Math.round((pts.reduce((a, p) => a + p.v, 0) / pts.length) * 10) / 10 : null;
  const peak = pts.length ? Math.max(...pts.map((p) => p.v)) : null;
  const unit = data?.unit || '';

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal card" style={{ maxWidth: 900, width: '92%' }}>
        <div className="flex between" style={{ marginBottom: 12 }}>
          <b style={{ fontSize: 15 }}>📈 성능 — {vmName}</b>
          <button className="logout-btn" onClick={onClose}>닫기</button>
        </div>

        <div className="flex gap wrap" style={{ marginBottom: 12 }}>
          <div className="flex gap" style={{ flexWrap: 'wrap' }}>
            {TYPES.map((t) => (
              <button key={t.k} className={type === t.k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 13px' }} onClick={() => setType(t.k)}>{t.label}</button>
            ))}
          </div>
          <div className="flex gap" style={{ marginLeft: 'auto', flexWrap: 'wrap' }}>
            {INTERVALS.map((iv) => (
              <button key={iv.k} className={interval === iv.k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 13px' }} onClick={() => setIntv(iv.k)}>{iv.label}</button>
            ))}
          </div>
        </div>

        {!loading && !error && pts.length > 0 && (
          <div className="flex gap" style={{ marginBottom: 8, gap: 24 }}>
            <span className="muted" style={{ fontSize: 12 }}>현재 <b style={{ color: 'var(--text)' }}>{last}{unit}</b></span>
            <span className="muted" style={{ fontSize: 12 }}>평균 <b style={{ color: 'var(--text)' }}>{avg}{unit}</b></span>
            <span className="muted" style={{ fontSize: 12 }}>최대 <b style={{ color: 'var(--text)' }}>{peak}{unit}</b></span>
            {data?.mock && <span className="badge gray" style={{ fontSize: 11 }}>데모 데이터</span>}
          </div>
        )}

        <div style={{ height: 340 }}>
          {loading && <div className="muted" style={{ padding: 40, textAlign: 'center' }}>vCenter에서 불러오는 중…</div>}
          {error && <div className="error-box" style={{ margin: 8 }}>조회 실패: {error}</div>}
          {!loading && !error && pts.length === 0 && <div className="muted" style={{ padding: 40, textAlign: 'center' }}>데이터가 없습니다.</div>}
          {!loading && !error && pts.length > 0 && (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={pts} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="vmMetricFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={cfg.color} stopOpacity={0.45} />
                    <stop offset="100%" stopColor={cfg.color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#243049" />
                <XAxis dataKey="t" stroke="#8b9bb4" fontSize={11} minTickGap={40} tickFormatter={(t) => fmtTick(t, interval)} />
                <YAxis stroke="#8b9bb4" fontSize={11} width={48} unit={unit} domain={type === 'cpu' || type === 'mem' ? [0, 100] : [0, 'auto']} />
                <Tooltip contentStyle={tipStyle} labelFormatter={(t) => new Date(t).toLocaleString('ko-KR')} formatter={(v) => [`${v}${unit}`, cfg.label]} />
                <Area type="monotone" dataKey="v" stroke={cfg.color} strokeWidth={2} fill="url(#vmMetricFill)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          이 데이터는 평소 수집하지 않으며, 이 창을 열 때 vCenter에서 직접 조회합니다. 실시간은 20초마다 자동 갱신됩니다.
        </div>
      </div>
    </div>
  );
}
