import React, { useEffect, useState } from 'react';
import { fetchJson, putJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const fmtAgo = (ts) => {
  if (!ts) return '없음';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
};

/**
 * GPU 게스트 수집 설정 — 패스쓰루 GPU는 ESXi에서 사용률을 못 보므로, 선택한 법인의
 * VM에 VMware Tools 게스트 작업으로 nvidia-smi를 실행해 사용률을 가져온다.
 */
export default function GpuGuestSettings() {
  const [data, setData] = useState(null);   // { settings, status }
  const [vcs, setVcs] = useState([]);       // [{id,name,...}]
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);   // local editable copy
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    try {
      const [d, v] = await Promise.all([
        fetchJson('/admin/gpu-guest/settings'),
        fetchJson('/admin/vcenters').catch(() => ({ vcenters: [] })),
      ]);
      setData(d); setVcs(v.vcenters || []);
      if (!form) setForm(toForm(d.settings, v.vcenters || []));
      setError(null);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); /* eslint-disable-next-line */ }, []);

  if (error) return <ErrorBox message={error} />;
  if (!data || !form) return <Loading />;

  const setVc = (id, patch) => setForm((f) => ({ ...f, vcenters: { ...f.vcenters, [id]: { ...f.vcenters[id], ...patch } } }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/admin/gpu-guest/settings', form);
      setData(r);
      setForm(toForm(r.settings, vcs, form)); // keep typed passwords cleared
      setMsg('저장되었습니다. 새 설정이 다음 주기부터 적용됩니다.');
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  const status = data.status || {};
  const last = status.lastRun;
  const monitoredCount = Object.values(form.vcenters).filter((v) => v.enabled).length;

  return (
    <div style={{ maxWidth: 820 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🎮 GPU 게스트 수집</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        패스쓰루(DirectPath I/O) GPU는 ESXi가 사용률을 보지 못합니다. 선택한 <b>법인의 VM</b>에
        VMware Tools 게스트 작업으로 <code>nvidia-smi</code>를 실행해 사용률을 수집합니다.
        <span className="badge amber" style={{ marginLeft: 6 }}>실환경 BETA</span>
      </p>

      <div className="card" style={{ padding: 16 }}>
        <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
          <b>게스트 GPU 수집 사용</b>
        </label>
        <div className="flex gap wrap" style={{ marginTop: 12 }}>
          <Field label="수집 주기(초)"><input className="input" type="number" min={10} style={{ width: 100 }}
            value={Math.round(form.pollIntervalMs / 1000)} onChange={(e) => setForm((f) => ({ ...f, pollIntervalMs: Math.max(10, Number(e.target.value) || 60) * 1000 }))} /></Field>
          <Field label="동시 실행 VM 수"><input className="input" type="number" min={1} max={32} style={{ width: 80 }}
            value={form.concurrency} onChange={(e) => setForm((f) => ({ ...f, concurrency: Number(e.target.value) || 4 }))} /></Field>
          <Field label="VM당 타임아웃(초)"><input className="input" type="number" min={3} max={120} style={{ width: 90 }}
            value={Math.round(form.timeoutMs / 1000)} onChange={(e) => setForm((f) => ({ ...f, timeoutMs: Math.max(3, Number(e.target.value) || 20) * 1000 }))} /></Field>
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginTop: 14 }}>
        <div className="flex between" style={{ alignItems: 'center', marginBottom: 8 }}>
          <b>법인(vCenter)별 모니터링 대상 · 게스트 OS 계정</b>
          <span className="muted" style={{ fontSize: 12 }}>선택됨 {monitoredCount} / {vcs.length}</span>
        </div>
        {vcs.length === 0 ? <span className="muted">등록된 vCenter가 없습니다. 먼저 vCenter를 등록하세요.</span> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%' }}>
              <thead><tr>
                <th style={{ textAlign: 'left' }}>모니터링</th>
                <th style={{ textAlign: 'left' }}>법인 / vCenter</th>
                <th style={{ textAlign: 'left' }}>게스트 계정</th>
                <th style={{ textAlign: 'left' }}>비밀번호</th>
              </tr></thead>
              <tbody>
                {vcs.map((vc) => {
                  const v = form.vcenters[vc.id] || { enabled: false, username: '', password: '', hasPassword: false };
                  return (
                    <tr key={vc.id}>
                      <td><input type="checkbox" checked={!!v.enabled} onChange={(e) => setVc(vc.id, { enabled: e.target.checked })} /></td>
                      <td><b>{vc.name || vc.id}</b><div className="muted" style={{ fontSize: 11 }}>{vc.location?.region || vc.location?.country || vc.id}</div></td>
                      <td><input className="input" style={{ width: 160 }} placeholder="administrator / root" value={v.username}
                        onChange={(e) => setVc(vc.id, { username: e.target.value })} /></td>
                      <td><input className="input" type="password" style={{ width: 160 }}
                        placeholder={v.hasPassword ? '●●●●● (변경시 입력)' : '비밀번호'} value={v.password || ''}
                        onChange={(e) => setVc(vc.id, { password: e.target.value })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          ※ 게스트 OS 안에 NVIDIA 드라이버/<code>nvidia-smi</code>가 설치돼 있어야 하며, 입력한 계정은
          게스트에서 명령 실행 권한이 있어야 합니다. 자격증명은 서버에 0600 권한으로 저장됩니다.
        </div>
      </div>

      <div className="flex gap" style={{ alignItems: 'center', marginTop: 16 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
        {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
      </div>

      <div className="card" style={{ padding: 16, marginTop: 14 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>현재 상태</div>
        <div className="flex gap wrap" style={{ fontSize: 13 }}>
          <span className="muted">상태 <b style={{ color: status.enabled ? 'var(--green)' : 'var(--text-dim)' }}>{status.enabled ? '활성' : '비활성'}</b></span>
          <span className="muted">대상 법인 <b style={{ color: 'var(--text)' }}>{status.monitored ?? 0}</b></span>
          <span className="muted">마지막 수집 <b style={{ color: 'var(--text)' }}>{fmtAgo(last?.at)}</b></span>
          {last && (last.skipped
            ? <span className="muted">({last.skipped})</span>
            : <span className="muted">[{last.mode}] 호스트 <b style={{ color: 'var(--text)' }}>{last.hosts}</b> · VM <b style={{ color: 'var(--text)' }}>{last.vms}</b>{last.errors ? ` · 오류 ${last.errors}` : ''}</span>)}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return <div><label className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>{label}</label>{children}</div>;
}

function toForm(settings, vcs, prev) {
  const vcenters = {};
  for (const vc of vcs) {
    const s = settings.vcenters?.[vc.id] || {};
    vcenters[vc.id] = { enabled: !!s.enabled, username: s.username || '', hasPassword: !!s.hasPassword, password: '' };
  }
  // carry over any vcenters in settings not in the list
  for (const [id, s] of Object.entries(settings.vcenters || {})) {
    if (!vcenters[id]) vcenters[id] = { enabled: !!s.enabled, username: s.username || '', hasPassword: !!s.hasPassword, password: '' };
  }
  return { enabled: !!settings.enabled, pollIntervalMs: settings.pollIntervalMs || 60000, concurrency: settings.concurrency || 4, timeoutMs: settings.timeoutMs || 20000, vcenters };
}
