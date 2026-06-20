import React, { useEffect, useState } from 'react';
import { fetchJson, putJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

// Common presets for the temperature/metrics sampling interval.
const PRESETS = [
  { label: '30초', ms: 30_000 },
  { label: '1분', ms: 60_000 },
  { label: '5분', ms: 300_000 },
  { label: '10분', ms: 600_000 },
  { label: '30분', ms: 1_800_000 },
  { label: '1시간', ms: 3_600_000 },
];

const fmtAgo = (ts) => {
  if (!ts) return '없음';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
};

/** 지표 수집(ESXi 온도/데이터스토어 용량/GPU) 주기·보존기간 설정. */
export default function MetricsSettings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [intervalSec, setIntervalSec] = useState(60);
  const [retentionDays, setRetentionDays] = useState(1830);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    try {
      const d = await fetchJson('/admin/metrics/settings');
      setData(d);
      setIntervalSec(Math.round((d.settings.sampleIntervalMs || 60000) / 1000));
      setRetentionDays(d.settings.retentionDays ?? 1830);
      setError(null);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000); // refresh "마지막 수집" 상태
    return () => clearInterval(t);
  }, []);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const limits = data.limits || { minIntervalMs: 10000, maxIntervalMs: 86400000 };
  const minSec = Math.round(limits.minIntervalMs / 1000);
  const maxSec = Math.round(limits.maxIntervalMs / 1000);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const ms = Math.max(limits.minIntervalMs, Math.min(limits.maxIntervalMs, intervalSec * 1000));
      const r = await putJson('/admin/metrics/settings', { sampleIntervalMs: ms, retentionDays: Number(retentionDays) || 0 });
      setData(r);
      setIntervalSec(Math.round(r.settings.sampleIntervalMs / 1000));
      setMsg('저장되었습니다. 새 주기가 즉시 적용됩니다.');
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  const status = data.status || {};
  const last = status.lastRun;

  return (
    <div style={{ maxWidth: 640 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🌡️ 지표 수집 주기</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        ESXi 온도 · 데이터스토어 사용량 · GPU 사용률을 주기적으로 수집해 시계열로 저장합니다.
        기본값은 <b>1분</b>이며 아래에서 변경할 수 있습니다.
      </p>

      <div className="card" style={{ padding: 16 }}>
        <label className="muted" style={{ fontSize: 12 }}>수집 주기</label>
        <div className="flex gap wrap" style={{ margin: '6px 0 10px' }}>
          {PRESETS.map((p) => (
            <button key={p.ms} className={intervalSec * 1000 === p.ms ? 'login-btn' : 'tab'}
              style={{ flex: 'none', padding: '6px 12px' }} onClick={() => setIntervalSec(p.ms / 1000)}>{p.label}</button>
          ))}
        </div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <input className="input" type="number" min={minSec} max={maxSec} value={intervalSec}
            onChange={(e) => setIntervalSec(Number(e.target.value))} style={{ width: 120 }} />
          <span className="muted">초 ({minSec}~{maxSec}초 허용)</span>
        </div>

        <label className="muted" style={{ fontSize: 12, display: 'block', marginTop: 16 }}>보존 기간 (일, 0=무제한)</label>
        <div className="flex gap" style={{ alignItems: 'center', marginTop: 6 }}>
          <input className="input" type="number" min={0} value={retentionDays}
            onChange={(e) => setRetentionDays(Number(e.target.value))} style={{ width: 120 }} />
          <span className="muted">일 (기본 1830일 ≈ 5년)</span>
        </div>

        <div className="flex gap" style={{ alignItems: 'center', marginTop: 18 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={save}>
            {busy ? '저장 중…' : '저장'}
          </button>
          {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginTop: 14 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>현재 상태</div>
        <div className="flex gap wrap" style={{ fontSize: 13 }}>
          <span className="muted">적용 주기 <b style={{ color: 'var(--text)' }}>{Math.round((status.intervalMs || 0) / 1000)}초</b></span>
          <span className="muted">보존 <b style={{ color: 'var(--text)' }}>{status.retentionDays}일</b></span>
          <span className="muted">마지막 수집 <b style={{ color: 'var(--text)' }}>{fmtAgo(last?.at)}</b></span>
          {last && <span className="muted">온도 보고 호스트 <b style={{ color: 'var(--text)' }}>{last.hostsWithTemp}</b> · 행 <b style={{ color: 'var(--text)' }}>{last.rows}</b></span>}
        </div>
      </div>
    </div>
  );
}
