import React, { useEffect, useState } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { fetchJson } from '../api.js';
import EscClose from './EscClose.jsx';
import BoldText from './boldText.jsx';
import { metricErrorState, metricAuthStopText } from './vmMetricsText.js';
import { metricStats } from './vmMetricStats.js'; // v2.598 VC2598-02 — 결측 점을 0 으로 더하지 않는다

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

// Humanize a KBps value to KB/s · MB/s · GB/s so axis labels stay short.
function fmtRate(kbps) {
  if (kbps == null) return '—';
  if (kbps >= 1024 * 1024) return `${(kbps / 1024 / 1024).toFixed(1)} GB/s`;
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} MB/s`;
  return `${Math.round(kbps)} KB/s`;
}
const fmtVal = (v, unit) => (v == null ? '—' : unit === 'KBps' ? fmtRate(v) : `${v}${unit}`); // v2.598: 결측(null)은 단위 없이 '—'(null% 금지)

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
      {open && <MetricModal metricsPath={`/vms/${encodeURIComponent(vmId)}/metrics`} name={vmName} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Button that opens the on-demand ESXi host performance viewer. */
export function HostMetricButton({ hostId, hostName }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="login-btn" style={{ flex: 'none', padding: '8px 14px' }} onClick={() => setOpen(true)}>📈 성능 그래프 보기</button>
      {open && <MetricModal metricsPath={`/hosts/${encodeURIComponent(hostId)}/metrics`} name={hostName} onClose={() => setOpen(false)} />}
    </>
  );
}

function MetricModal({ metricsPath, name, onClose }) {
  const [type, setType] = useState('cpu');
  const [interval, setIntv] = useState('realtime');
  const [range, setRange] = useState({ start: '', end: '' }); // applied range
  const [draft, setDraft] = useState({ start: '', end: '' });  // date-picker inputs
  const [state, setState] = useState({ loading: true });
  const [retry, setRetry] = useState(0);   // '다시 조회'(수동) 횟수 — 바뀌면 manual=1 로 1회 조회한다

  useEffect(() => {
    let active = true;
    let timer = null;
    const base = { type, interval, ...(range.start ? { start: range.start } : {}), ...(range.end ? { end: range.end } : {}) };
    const fetchOnce = (manual) => {
      fetchJson(metricsPath, manual ? { ...base, manual: '1' } : base)
        .then((d) => { if (active) setState({ loading: false, data: d }); })
        .catch((e) => {
          if (!active) return;
          // v2.591(감사 F6): vCenter 가 인증 실패로 멈춰 있으면 자동 갱신을 멈춘다 — 20초마다 같은 계정으로 로그인하면
          //   계정이 잠긴다. 사유를 말하고 사람이 누르는 '다시 조회' 만 남긴다.
          const st = metricErrorState(e);
          if (st.authStopped && timer) { clearInterval(timer); timer = null; }
          setState({ loading: false, error: st.message, authStopped: st.authStopped });
        });
    };
    setState({ loading: true });
    fetchOnce(retry > 0);
    // 실시간 + 기간 미지정일 때만 20초마다 자동 갱신
    const live = interval === 'realtime' && !range.start && !range.end;
    timer = live ? setInterval(() => fetchOnce(false), 20_000) : null;
    return () => { active = false; if (timer) clearInterval(timer); };
  }, [metricsPath, type, interval, range.start, range.end, retry]);

  const { loading, data, error, authStopped } = state;
  const cfg = TYPES.find((t) => t.k === type);
  const pts = (data?.points || []).map((p) => ({ t: p.t, v: p.v }));
  // v2.598 VC2598-02: 결측(null) 점은 요약에서 빼고, 차트는 그 구간에서 선을 끊는다(connectNulls 없음).
  const { last, avg, peak } = metricStats(pts);
  const unit = data?.unit || '';

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal card" style={{ maxWidth: 900, width: '92%' }}>
        <div className="flex between" style={{ marginBottom: 12 }}>
          <b style={{ fontSize: 15 }}>📈 성능 — {name}</b>
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

        {/* 기간(날짜) 지정 — 비우면 최근 구간 자동 */}
        <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center', fontSize: 12 }}>
          <span className="muted">기간 지정</span>
          <input className="input" type="datetime-local" style={{ padding: '5px 8px', width: 'auto' }} value={draft.start} onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))} />
          <span className="muted">~</span>
          <input className="input" type="datetime-local" style={{ padding: '5px 8px', width: 'auto' }} value={draft.end} onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value }))} />
          <button className="tab" onClick={() => setRange({ start: draft.start, end: draft.end })}>적용</button>
          {(range.start || range.end) && <button className="tab" onClick={() => { setDraft({ start: '', end: '' }); setRange({ start: '', end: '' }); }}>최근으로</button>}
          {(range.start || range.end) ? <span className="badge blue">기간 조회</span> : <span className="muted">최근 구간</span>}
        </div>

        {!loading && !error && pts.length > 0 && (
          <div className="flex gap" style={{ marginBottom: 8, gap: 24 }}>
            <span className="muted" style={{ fontSize: 12 }}>현재 <b style={{ color: 'var(--text)' }}>{fmtVal(last, unit)}</b></span>
            <span className="muted" style={{ fontSize: 12 }}>평균 <b style={{ color: 'var(--text)' }}>{fmtVal(avg, unit)}</b></span>
            <span className="muted" style={{ fontSize: 12 }}>최대 <b style={{ color: 'var(--text)' }}>{fmtVal(peak, unit)}</b></span>
            {data?.mock && <span className="badge gray" style={{ fontSize: 11 }}>데모 데이터</span>}
          </div>
        )}

        <div style={{ height: 340 }}>
          {loading && <div className="muted" style={{ padding: 40, textAlign: 'center' }}>vCenter에서 불러오는 중…</div>}
          {error && !authStopped && <div className="error-box" style={{ margin: 8 }}>조회 실패: {error}</div>}
          {authStopped && (
            <div className="error-box" style={{ margin: 8 }}>
              <BoldText text={metricAuthStopText(authStopped)} />
              <div style={{ marginTop: 8 }}><button className="tab" onClick={() => setRetry((n) => n + 1)}>다시 조회</button></div>
            </div>
          )}
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
                <YAxis stroke="#8b9bb4" fontSize={11} width={unit === 'KBps' ? 72 : 48}
                  tickFormatter={(v) => fmtVal(v, unit)} domain={type === 'cpu' || type === 'mem' ? [0, 100] : [0, 'auto']} />
                <Tooltip contentStyle={tipStyle} labelFormatter={(t) => new Date(t).toLocaleString('ko-KR')} formatter={(v) => [fmtVal(v, unit), cfg.label]} />
                <Area type="monotone" dataKey="v" stroke={cfg.color} strokeWidth={2} fill="url(#vmMetricFill)" isAnimationActive={false} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          이 데이터는 평소 수집하지 않으며, 이 창을 열 때 vCenter에서 직접 조회합니다. 실시간은 20초마다 자동 갱신됩니다{authStopped ? '(인증 실패로 멈춤)' : ''}.
        </div>
      </div>
    </div>
  );
}
