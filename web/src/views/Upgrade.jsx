import React, { useEffect, useState } from 'react';
import { fetchJson, postJson } from '../api.js';
import { Loading, ErrorBox, StateBadge } from '../components/ui.jsx';

function Row({ label, children }) {
  return (
    <div className="flex between" style={{ padding: '8px 0', borderBottom: '1px solid rgba(36,48,73,.4)' }}>
      <span className="muted">{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  );
}

export default function Upgrade() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    try { setStatus(await fetchJson('/upgrade/status')); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const run = async (action, fn) => {
    setBusy(action); setMsg(null);
    try { const r = await fn(); setMsg({ action, r }); await load(); }
    catch (e) { setMsg({ action, r: { ok: false, reason: e.message } }); }
    finally { setBusy(null); }
  };

  if (error) return <ErrorBox message={error} />;
  if (!status) return <Loading />;

  const disabled = !status.enabled;
  const check = status.lastCheck;
  const result = status.lastResult;
  const newer = check && (check.watch?.available || check.remote?.available);

  return (
    <>
      <div className="section-title">시스템 자동 업그레이드 (관리자)</div>

      {disabled && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--amber)' }}>
          <b style={{ color: 'var(--amber)' }}>⚠ 자동 업그레이드가 비활성화되어 있습니다.</b>
          <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
            옵트인 기능입니다. 서버에서 <code>UPGRADE_ENABLED=true</code> 와 <code>UPGRADE_WATCH_DIR</code>
            (또는 <code>UPGRADE_REMOTE_BASE</code>), <code>UPGRADE_INSTALL_DIR</code> 를 설정하면 활성화됩니다.
          </div>
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <b>현재 상태</b>
          <div style={{ marginTop: 10 }}>
            <Row label="활성화"><StateBadge state={status.enabled ? 'CONNECTED' : 'POWERED_OFF'} /></Row>
            <Row label="현재 버전"><b className="tabular">v{status.version}</b></Row>
            <Row label="감시 폴더">{status.watchDir || <span className="muted">미설정</span>}</Row>
            <Row label="설치 경로">{status.installDir || <span className="muted">미설정</span>}</Row>
            <Row label="원격 소스">{status.remoteConfigured ? '설정됨' : <span className="muted">미설정</span>}</Row>
            <Row label="자동 적용">{status.autoApply ? '예' : '아니오'}{status.pollIntervalMs ? ` · ${status.pollIntervalMs / 1000}s 주기` : ''}</Row>
            <Row label="엣지 푸시 대상">{status.edges?.length ? `${status.edges.length}곳` : <span className="muted">없음</span>}</Row>
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
              {check.remote && <Row label="원격 소스">{check.remote.available
                ? <b style={{ color: 'var(--green)' }}>새 버전 v{check.remote.latest}</b>
                : <span className="muted">{check.remote.error ? `오류: ${check.remote.error}` : '최신'}</span>}</Row>}
              <Row label="업그레이드 가능">{newer
                ? <span className="badge green">예</span>
                : <span className="badge gray">아니오</span>}</Row>
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="flex gap wrap">
          <button className="login-btn" style={{ flex: 'none', padding: '10px 18px' }}
            disabled={disabled || busy} onClick={() => run('check', () => postJson('/upgrade/check'))}>
            {busy === 'check' ? '확인 중…' : '새 버전 확인'}
          </button>
          <button className="login-btn" style={{ flex: 'none', padding: '10px 18px', background: newer ? 'linear-gradient(135deg,var(--green),#16a34a)' : undefined }}
            disabled={disabled || busy || !newer} onClick={() => run('apply', () => postJson('/upgrade/apply', { source: 'auto', restart: false }))}>
            {busy === 'apply' ? '적용 중…' : '업그레이드 적용'}
          </button>
          <button className="logout-btn" style={{ padding: '10px 18px' }}
            disabled={disabled || busy} onClick={() => run('restart', () => postJson('/upgrade/restart'))}>
            {busy === 'restart' ? '재시작 중…' : '프로세스 재시작'}
          </button>
        </div>

        {msg && (
          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 8,
            background: msg.r.ok ? 'rgba(34,197,94,.12)' : 'rgba(245,158,11,.12)',
            color: msg.r.ok ? '#4ade80' : '#fbbf24', fontSize: 13 }}>
            <b>{msg.action}</b> · {msg.r.ok
              ? `성공${msg.r.version ? ` — v${msg.r.from || '?'} → v${msg.r.version}` : ''}${msg.r.backup ? ` (백업: ${msg.r.backup})` : ''}`
              : (msg.r.reason || '실패')}
          </div>
        )}
        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          적용 후 새 코드를 로드하려면 <b>프로세스 재시작</b>이 필요합니다. 더 새 버전만 적용되며, 기존 코드는 자동 백업되어 롤백할 수 있습니다.
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
    </>
  );
}
