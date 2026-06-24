import React, { useEffect, useState } from 'react';
import { fetchJson, putJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

/**
 * 설정 → 이상동작 탐지 — 짧은 시간(직전 수집 주기) 안에 다수 VM이 동시에 전원 OFF 되면
 * 위험 알림. 전역 기본 임계 + vCenter별 임계를 따로 지정할 수 있다(호스트/스토리지/클러스터
 * 장애 조기 감지). 실제 통지는 설정 › 알림의 Slack/Webhook 채널로 나간다.
 */
export default function AnomalyDetection() {
  const [s, setS] = useState(null);          // { enabled, threshold, perVcenter, intervalSec }
  const [vcs, setVcs] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    try {
      const [a, v] = await Promise.all([
        fetchJson('/admin/anomaly'),
        fetchJson('/admin/vcenters').catch(() => ({ vcenters: [] })),
      ]);
      setS(a); setVcs(v.vcenters || []); setError(null);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);
  if (error) return <ErrorBox message={error} />;
  if (!s) return <Loading />;

  const setPer = (id, val) => setS((cur) => {
    const per = { ...cur.perVcenter };
    if (val === '' || val == null) delete per[id];
    else per[id] = Number(val);
    return { ...cur, perVcenter: per };
  });

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/admin/anomaly', { enabled: s.enabled, threshold: Number(s.threshold) || 10, perVcenter: s.perVcenter || {} });
      setS(r.settings || r); setMsg('저장되었습니다. 다음 탐지 주기부터 적용됩니다.');
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 920 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🚨 이상동작 탐지</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        직전 수집 이후 <b>다수 VM이 동시에 전원 OFF</b> 되면(호스트·스토리지·클러스터 장애 징후) 위험 알림을 보냅니다.
        탐지는 약 <b>{s.intervalSec || 60}초</b>마다(알림 주기) 직전 상태와 비교합니다. 통지는 <b>설정 › 알림</b>의 Slack/Webhook 채널로 나갑니다.
      </p>

      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 18 }}>
          <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> <b>동시 다운 탐지 사용</b>
          </label>
          <span className="muted">전역 기본 임계</span>
          <input className="input" type="number" min={2} style={{ width: 90 }} value={s.threshold}
            onChange={(e) => setS({ ...s, threshold: e.target.value })} />
          <span className="muted">대 이상 동시 OFF</span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          아래에서 vCenter별 임계를 따로 지정할 수 있습니다. 비워두면 전역 기본값(<b>{s.threshold}</b>대)을 사용합니다.
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <b style={{ fontSize: 14 }}>vCenter별 임계</b>
        {vcs.length === 0 ? <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>등록된 vCenter가 없습니다.</div> : (
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table><thead><tr><th>법인 / vCenter</th><th>지역</th><th style={{ textAlign: 'right' }}>동시 다운 임계(대)</th></tr></thead>
              <tbody>{vcs.map((vc) => (
                <tr key={vc.id}>
                  <td><b>{vc.name || vc.id}</b><div className="muted" style={{ fontSize: 11 }}>{vc.id}</div></td>
                  <td className="muted" style={{ fontSize: 12 }}>{vc.location?.region || vc.location?.country || '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <input className="input" type="number" min={1} style={{ width: 96 }}
                      placeholder={`기본 ${s.threshold}`}
                      value={s.perVcenter?.[vc.id] ?? ''}
                      onChange={(e) => setPer(vc.id, e.target.value)} />
                  </td>
                </tr>
              ))}</tbody></table>
          </div>
        )}
      </div>

      <div className="flex gap" style={{ alignItems: 'center' }}>
        <button className="login-btn" style={{ padding: '8px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
        {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
      </div>
    </div>
  );
}
