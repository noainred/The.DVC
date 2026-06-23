import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const PRESETS = [
  { label: '30초', s: 30 }, { label: '1분', s: 60 }, { label: '5분', s: 300 },
  { label: '10분', s: 600 }, { label: '30분', s: 1800 }, { label: '1시간', s: 3600 },
];

/** GPU 수집 설정 — vCenter 성능 카운터(gpu.utilization) 호스트 사용률 수집 on/off·주기 + 지금 수집. */
export default function GpuSettings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [sec, setSec] = useState(60);
  const [busy, setBusy] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    try {
      const d = await fetchJson('/admin/metrics/settings');
      setData(d);
      setEnabled(d.settings.gpuUtilEnabled !== false);
      setSec(d.settings.gpuUtilIntervalSec ?? 60);
      setError(null);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/admin/metrics/settings', { gpuUtilEnabled: enabled, gpuUtilIntervalSec: Number(sec) || 60 });
      setData(r); setSec(r.settings.gpuUtilIntervalSec ?? 60);
      setMsg('저장되었습니다. 새 주기가 즉시 적용됩니다.');
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };
  const collectNow = async () => {
    setCollecting(true); setMsg(null);
    try { await postJson('/admin/gpu/collect-util', {}); setMsg('지금 수집을 실행했습니다. GPU 인벤토리에서 사용률을 확인하세요.'); }
    catch (e) { setMsg(`오류: ${e.message}`); } finally { setCollecting(false); }
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🎮 GPU 수집</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        vCenter 성능 카운터(<code>gpu.utilization</code>)로 GPU 호스트 사용률을 주기적으로 수집합니다.
        vGPU/vSGA는 ESXi가 사용률을 보고하며, 순수 패스쓰루는 <b>설정 › GPU 게스트 수집</b>으로 보완됩니다.
      </p>

      <div className="card" style={{ padding: 16 }}>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 14 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> GPU 호스트 사용률 수집 사용
        </label>

        <label className="muted" style={{ fontSize: 12, display: 'block', marginTop: 16 }}>수집 주기</label>
        <div className="flex gap wrap" style={{ margin: '6px 0 10px' }}>
          {PRESETS.map((p) => (
            <button key={p.s} className={sec === p.s ? 'login-btn' : 'tab'} disabled={!enabled}
              style={{ flex: 'none', padding: '6px 12px' }} onClick={() => setSec(p.s)}>{p.label}</button>
          ))}
        </div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <input className="input" type="number" min={20} max={86400} value={sec} disabled={!enabled}
            onChange={(e) => setSec(Number(e.target.value))} style={{ width: 120 }} />
          <span className="muted">초 (20초 ~ 24시간)</span>
        </div>

        <div className="flex gap wrap" style={{ alignItems: 'center', marginTop: 18 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
          <button className="logout-btn" style={{ padding: '8px 14px' }} disabled={collecting} onClick={collectNow}>{collecting ? '수집 중…' : '⟳ 지금 수집'}</button>
          {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginTop: 14 }}>
        <div className="muted" style={{ fontSize: 12 }}>현재 적용</div>
        <div className="flex gap wrap" style={{ fontSize: 13, marginTop: 6 }}>
          <span className="muted">사용 <b style={{ color: 'var(--text)' }}>{data.settings.gpuUtilEnabled !== false ? '켜짐' : '꺼짐'}</b></span>
          <span className="muted">주기 <b style={{ color: 'var(--text)' }}>{data.settings.gpuUtilIntervalSec ?? 60}초</b></span>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          ※ GPU 사용률 5년 추이는 <b>지표 수집</b> 주기로 시계열 저장됩니다. 호스트/드라이버가 <code>gpu.utilization</code> 카운터를 노출하지 않으면 사용률이 비어 있을 수 있습니다.
        </div>
      </div>
    </div>
  );
}
