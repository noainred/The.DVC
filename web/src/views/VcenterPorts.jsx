import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { ScatterChart } from './NetworkCheck.jsx';

const COLOR = { ok: '#38bdf8', warn: '#eab308', crit: '#ef4444', down: '#ef4444', unknown: '#6b7280' };
const RANGES = [['1d', '1일'], ['7d', '7일'], ['30d', '30일'], ['90d', '90일'], ['365d', '365일']];
const COMMON = [443, 902, 5480, 8080, 5988, 5989]; // vCenter/ESXi 흔한 포트(빠른 추가용)

export default function VcenterPorts() {
  const [range, setRange] = useState('1d');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [portInput, setPortInput] = useState('');

  const load = () => { setError(null); fetchJson('/ping/vcport/overview', { range }).then((d) => { setData(d); if (portInput === '') setPortInput((d.ports || []).join(', ')); }).catch((e) => setError(e.message)); };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [range]);
  useEffect(() => { fetchJson('/auth/me').then((r) => setIsAdmin(r.user?.role === 'admin')).catch(() => {}); }, []);
  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 4000); };

  const savePorts = async () => {
    const ports = portInput.split(/[,\s]+/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
    setBusy(true);
    const r = await putJson('/ping/vcport/ports', { ports }).catch((e) => ({ ok: false, reason: e.message }));
    setBusy(false);
    if (r.ok) { flash(true, `포트 ${r.ports.join(', ') || '(없음)'} 저장 — 대상 ${r.targets}개`); setPortInput((r.ports || []).join(', ')); load(); }
    else flash(false, r.reason || '저장 실패');
  };
  const syncVc = async () => { setBusy(true); const r = await postJson('/ping/vcport/sync').catch((e) => ({ ok: false, reason: e.message })); setBusy(false); flash(r.ok, r.ok ? `동기화 완료 — 대상 ${r.targets}개` : (r.reason || '동기화 실패')); if (r.ok) load(); };
  const addPort = (p) => { const set = new Set(portInput.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)); set.add(String(p)); setPortInput([...set].join(', ')); };

  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  return (
    <>
      <div className="flex between wrap gap" style={{ alignItems: 'flex-start', marginBottom: 6 }}>
        <div>
          <div className="section-title" style={{ marginTop: 0, marginBottom: 4 }}>vCenter 포트 응답속도</div>
          <div className="muted" style={{ fontSize: 12.5 }}>각 vCenter의 지정한 포트에 대한 TCP 응답속도(ms)를 주기적으로 측정해 누적합니다. 평소(중앙값) 대비 +20% 노랑, +50% 빨강으로 표시됩니다.</div>
        </div>
        <div className="flex gap" style={{ flexShrink: 0 }}>
          {RANGES.map(([k, l]) => <button key={k} className={range === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 11px' }} onClick={() => setRange(k)}>{l}</button>)}
          <button className="logout-btn" style={{ padding: '6px 11px' }} onClick={load}>새로고침</button>
        </div>
      </div>
      {msg && <div className="card" style={{ padding: '8px 12px', margin: '10px 0', borderLeft: `3px solid var(--${msg.ok ? 'green' : 'red'})`, fontSize: 13 }}>{msg.ok ? '✓' : '⚠'} {msg.text}</div>}

      {isAdmin && (
        <div className="card" style={{ padding: 14, margin: '10px 0 16px' }}>
          <b style={{ fontSize: 13 }}>측정 포트 지정</b>
          <div className="muted" style={{ fontSize: 12, margin: '4px 0 10px' }}>쉼표로 구분해 입력하세요. 지정한 포트를 모든 vCenter에 공통 적용합니다(각 vCenter × 포트 조합을 측정).</div>
          <div className="flex gap wrap" style={{ alignItems: 'center' }}>
            <input className="input" style={{ minWidth: 260, flex: 1 }} value={portInput} onChange={(e) => setPortInput(e.target.value)} placeholder="예: 443, 902, 5480" />
            <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy} onClick={savePorts}>저장</button>
            <button className="logout-btn" style={{ padding: '8px 14px' }} disabled={busy} onClick={syncVc} title="vCenter 추가/삭제를 대상에 반영">vCenter 동기화</button>
          </div>
          <div className="flex gap wrap" style={{ marginTop: 8, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 11 }}>빠른 추가:</span>
            {COMMON.map((p) => <button key={p} className="tab" style={{ padding: '3px 9px', fontSize: 12 }} onClick={() => addPort(p)}>{p}</button>)}
          </div>
        </div>
      )}

      {data.groups.length === 0 && (
        <div className="card center muted" style={{ padding: 40 }}>
          측정 대상이 없습니다. {isAdmin ? '위에서 측정할 포트를 지정하고 저장하세요(등록된 vCenter에 자동 적용).' : '관리자가 측정 포트를 지정하면 표시됩니다.'}
        </div>
      )}
      {data.groups.map((g) => (
        <div key={g.id || 'none'} style={{ marginBottom: 22 }}>
          <div style={{ fontWeight: 700, fontSize: 15, borderBottom: '1px solid rgba(255,255,255,.12)', paddingBottom: 6, marginBottom: 12 }}>{g.name}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
            {g.items.map((s) => (
              <div key={s.id} className="card" style={{ padding: '12px 14px' }}>
                <div className="flex between" style={{ alignItems: 'baseline', marginBottom: 6 }}>
                  <b style={{ fontSize: 14, color: COLOR[s.status] || undefined }}>포트 {s.port}</b>
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
