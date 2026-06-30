import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson } from '../api.js';
import { Loading, ErrorBox, StateBadge } from '../components/ui.jsx';

function Row({ label, children }) {
  return (
    <div className="flex between" style={{ padding: '8px 0', borderBottom: '1px solid rgba(36,48,73,.4)' }}>
      <span className="muted">{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  );
}

const blankForm = (s) => ({
  enabled: !!s.enabled,
  installDir: s.installDir || '',
  watchDir: s.watchDir || '',
  remoteBase: s.remoteBase || '',
  token: '',
  pollMinutes: s.pollIntervalMs ? Math.round(s.pollIntervalMs / 60000) : 60,
  autoApply: !!s.autoApply,
});

export default function Upgrade() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [form, setForm] = useState(null);

  const load = async () => {
    try {
      const s = await fetchJson('/upgrade/status');
      setStatus(s);
      setForm((f) => f || blankForm(s));
      setError(null);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const run = async (action, fn) => {
    setBusy(action); setMsg(null);
    try { const r = await fn(); setMsg({ action, r }); await load(); }
    catch (e) { setMsg({ action, r: { ok: false, reason: e.message } }); }
    finally { setBusy(null); }
  };

  const saveSettings = async () => {
    setBusy('save'); setMsg(null);
    try {
      const body = {
        enabled: form.enabled,
        installDir: form.installDir.trim(),
        watchDir: form.watchDir.trim(),
        remoteBase: form.remoteBase.trim(),
        pollIntervalMs: Math.max(0, Number(form.pollMinutes) || 0) * 60000,
        autoApply: form.autoApply,
      };
      if (form.token) body.token = form.token;
      const r = await putJson('/upgrade/settings', body);
      setMsg({ action: 'save', r: { ok: r.ok, version: undefined } });
      setForm((f) => ({ ...f, token: '' }));
      await load();
    } catch (e) { setMsg({ action: 'save', r: { ok: false, reason: e.message } }); }
    finally { setBusy(null); }
  };

  if (error) return <ErrorBox message={error} />;
  if (!status || !form) return <Loading />;

  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setChk = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.checked }));

  const check = status.lastCheck;
  const result = status.lastResult;
  const newer = check && (check.watch?.available || check.remote?.available);

  return (
    <>
      <div className="section-title">시스템 자동 업그레이드 (관리자)</div>

      {/* Editable settings */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="flex between" style={{ marginBottom: 12 }}>
          <b>업그레이드 설정</b>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={form.enabled} onChange={setChk('enabled')} />
            <span>자동 업그레이드 사용</span>
          </label>
        </div>

        <div className="spec-grid">
          <label style={{ gridColumn: '1 / -1' }}>설치 경로 (installDir) *
            <input className="input" value={form.installDir} onChange={setF('installDir')} placeholder="/opt/vmware-portal/app" />
          </label>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">🌐 인터넷 업그레이드 (원격 모니터링)</div>
          <div className="spec-grid">
            <label style={{ gridColumn: '1 / -1' }}>원격 소스 URL (versions.json 디렉터리)
              <input className="input" value={form.remoteBase} onChange={setF('remoteBase')}
                placeholder="https://raw.githubusercontent.com/noainred/The.DVC/main/download" />
            </label>
            <label>토큰 (사설 레포)
              <input className="input" type="password" value={form.token} onChange={setF('token')}
                placeholder={status.hasToken ? '저장됨 (비우면 유지)' : '선택'} />
            </label>
            <label>확인 주기 (분, 0=끔)
              <input className="input" type="number" min="0" value={form.pollMinutes} onChange={setF('pollMinutes')} />
            </label>
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">📁 수동 업그레이드 (로컬 감시 폴더)</div>
          <div className="spec-grid">
            <label style={{ gridColumn: '1 / -1' }}>감시 폴더 (watchDir) — 여기에 <code>vmware-portal-&lt;버전&gt;.tar.gz</code> 를 넣으면 적용
              <input className="input" value={form.watchDir} onChange={setF('watchDir')} placeholder="/opt/vmware-portal/incoming" />
            </label>
          </div>
        </div>

        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, marginTop: 10 }}>
          <input type="checkbox" checked={form.autoApply} onChange={setChk('autoApply')} />
          <span>새 버전 발견 시 <b>자동 적용 + 재시작</b> (끄면 확인만 하고 수동 적용)</span>
        </label>

        <div className="flex gap" style={{ marginTop: 14 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '10px 18px' }} disabled={busy} onClick={saveSettings}>
            {busy === 'save' ? '저장 중…' : '설정 저장'}
          </button>
          <button className="logout-btn" style={{ padding: '10px 18px' }} disabled={busy || !form.enabled}
            onClick={() => run('check', () => postJson('/upgrade/check'))}>
            {busy === 'check' ? '확인 중…' : '새 버전 확인'}
          </button>
          <button className="login-btn" style={{ flex: 'none', padding: '10px 18px', background: newer ? 'linear-gradient(135deg,var(--green),#16a34a)' : undefined }}
            disabled={busy || !form.enabled || !newer} onClick={() => run('apply', () => postJson('/upgrade/apply', { source: 'auto', restart: true }))}>
            {busy === 'apply' ? '적용 중…' : '업그레이드 적용 + 재시작'}
          </button>
          <button className="logout-btn" style={{ padding: '10px 18px' }} disabled={busy}
            onClick={() => run('restart', () => postJson('/upgrade/restart'))}>
            {busy === 'restart' ? '재시작 중…' : '프로세스 재시작'}
          </button>
        </div>

        {msg && (
          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 8,
            background: msg.r.ok ? 'rgba(34,197,94,.12)' : 'rgba(245,158,11,.12)',
            color: msg.r.ok ? '#4ade80' : '#fbbf24', fontSize: 13 }}>
            <b>{msg.action}</b> · {msg.r.ok
              ? `성공${msg.r.version ? ` — v${msg.r.from || '?'} → v${msg.r.version}` : ''}${msg.r.backup ? ` (백업: ${msg.r.backup})` : ''}${msg.r.restarting ? ' · 재시작 중' : ''}`
              : (msg.r.reason || '실패')}
          </div>
        )}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <b>현재 상태</b>
          <div style={{ marginTop: 10 }}>
            <Row label="활성화"><StateBadge state={status.enabled ? 'CONNECTED' : 'POWERED_OFF'} /></Row>
            <Row label="현재 버전"><b className="tabular">v{status.version}</b></Row>
            <Row label="설치 경로">{status.installDir || <span className="muted">미설정</span>}</Row>
            <Row label="감시 대상(versions.json)">
              {status.remoteVersionsUrl
                ? <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, wordBreak: 'break-all' }}>{status.remoteVersionsUrl}</span>
                : <span className="muted">미설정</span>}
            </Row>
            <Row label="감시 폴더">{status.watchDir || <span className="muted">미설정</span>}</Row>
            <Row label="자동 적용">{status.autoApply ? '예' : '아니오'}{status.pollIntervalMs ? ` · ${Math.round(status.pollIntervalMs / 60000)}분 주기` : ''}</Row>
          </div>
        </div>

        <div className="card">
          <b>최근 확인 결과</b>
          {!check && <div className="muted" style={{ padding: 12 }}>아직 확인하지 않았습니다.</div>}
          {check && (
            <div style={{ marginTop: 10 }}>
              <Row label="확인 시각">{new Date(check.at).toLocaleString('ko-KR')}</Row>
              {check.watch && <Row label="감시 폴더">{check.watch.available
                ? <b style={{ color: 'var(--green)' }}>새 버전 v{check.watch.version}</b>
                : <span className="muted">최신</span>}</Row>}
              {check.remote && <Row label="원격(GitHub)">{check.remote.available
                ? <b style={{ color: 'var(--green)' }}>새 버전 v{check.remote.latest}</b>
                : <span className="muted">{check.remote.error ? `오류: ${check.remote.error}` : `최신 (v${check.remote.latest || '?'})`}</span>}</Row>}
              <Row label="업그레이드 가능">{newer ? <span className="badge green">예</span> : <span className="badge gray">아니오</span>}</Row>
            </div>
          )}
        </div>
      </div>

      {result && (
        <div className="card" style={{ marginTop: 16 }}>
          <b>최근 적용 결과</b>
          <pre style={{ marginTop: 10, fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}

      <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>
        적용 후 새 코드를 로드하려면 재시작이 필요합니다(자동 적용 시 자동 재시작). 더 새 버전만 적용되며 기존 코드는 자동 백업되어 롤백할 수 있습니다.
      </div>
    </>
  );
}
