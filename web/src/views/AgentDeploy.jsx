import React, { useEffect, useState } from 'react';
import { fetchJson, postJson } from '../api.js';
import { Loading } from '../components/ui.jsx';

const EMPTY = {
  host: '', port: 22, username: 'root', password: '', privateKey: '',
  agentName: '', centralUrl: '', centralToken: '', collectorToken: '', collectorDatacenter: '',
  installerPath: '', portalPort: 4000,
};

/** 설정 → 에이전트 배포: 새 Rocky9 호스트에 SSH로 수집 에이전트 자동 설치. */
export default function AgentDeploy() {
  const [f, setF] = useState(EMPTY);
  const [installer, setInstaller] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => { fetchJson('/admin/agent-deploy/installer').then(setInstaller).catch(() => setInstaller({ available: false })); }, []);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const test = async () => {
    setBusy(true); setResult(null);
    const r = await postJson('/admin/agent-deploy/test', f).catch((e) => ({ ok: false, reason: e.message }));
    setResult({ kind: 'test', ...r }); setBusy(false);
  };
  const deploy = async () => {
    if (!window.confirm(`${f.host} 에 수집 에이전트를 설치/재시작할까요? (root 권한 필요)`)) return;
    setBusy(true); setResult(null);
    const r = await postJson('/admin/agent-deploy', f).catch((e) => ({ ok: false, reason: e.message }));
    setResult({ kind: 'deploy', ...r }); setBusy(false);
  };

  if (!installer) return <Loading />;

  return (
    <>
      <div className="section-title" style={{ margin: '6px 0 10px' }}>에이전트 자동배포 (SSH 설치)</div>

      <div className="card" style={{ marginBottom: 12, borderColor: installer.available ? undefined : 'var(--red)' }}>
        {installer.available
          ? <span className="muted" style={{ fontSize: 13 }}>설치 패키지: <code>{installer.name}</code> ({(installer.sizeBytes / 1048576).toFixed(1)} MB) — 중앙 서버에서 SFTP 전송됩니다.</span>
          : <span style={{ color: 'var(--red)', fontSize: 13 }}>설치 패키지를 찾을 수 없습니다. 중앙 서버 <code>download/</code> 에 offline tarball을 두거나 아래 경로를 지정하세요.</span>}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <b style={{ fontSize: 14 }}>대상 호스트 (SSH)</b>
        <div className="spec-grid" style={{ marginTop: 8 }}>
          <label>호스트(IP)<input className="input" value={f.host} onChange={set('host')} placeholder="10.30.0.21" /></label>
          <label>SSH 포트<input className="input" type="number" value={f.port} onChange={set('port')} /></label>
          <label>사용자(root 권장)<input className="input" value={f.username} onChange={set('username')} /></label>
          <label>비밀번호<input className="input" type="password" value={f.password} onChange={set('password')} placeholder="(키 사용 시 비움)" /></label>
          <label style={{ gridColumn: '1 / -1' }}>개인키(PEM, 선택)<textarea className="input" rows={2} value={f.privateKey} onChange={set('privateKey')} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }} /></label>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <b style={{ fontSize: 14 }}>에이전트 설정 (포탈 env에 주입)</b>
        <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>iDRAC 스캔 에이전트는 <b>에이전트 이름 + 중앙 URL + 토큰</b>을, 전력수집 에이전트는 <b>수집 토큰</b>을 채우세요.</div>
        <div className="spec-grid">
          <label>에이전트 이름(AGENT_NAME)<input className="input" value={f.agentName} onChange={set('agentName')} placeholder="Seoul-DC1" /></label>
          <label>중앙 URL(CENTRAL_URL)<input className="input" value={f.centralUrl} onChange={set('centralUrl')} placeholder="http://central:4000" /></label>
          <label>중앙 토큰(CENTRAL_TOKEN)<input className="input" value={f.centralToken} onChange={set('centralToken')} /></label>
          <label>전력수집 토큰(COLLECTOR_TOKEN, 선택)<input className="input" value={f.collectorToken} onChange={set('collectorToken')} /></label>
          <label>수집 DC명(COLLECTOR_DATACENTER, 선택)<input className="input" value={f.collectorDatacenter} onChange={set('collectorDatacenter')} /></label>
          <label>포탈 포트<input className="input" type="number" value={f.portalPort} onChange={set('portalPort')} /></label>
          <label style={{ gridColumn: '1 / -1' }}>설치 패키지 경로(비우면 자동)<input className="input" value={f.installerPath} onChange={set('installerPath')} placeholder="(중앙 서버의 tarball 경로)" /></label>
        </div>
      </div>

      <div className="flex gap" style={{ marginBottom: 14 }}>
        <button className="logout-btn" style={{ padding: '9px 16px' }} disabled={busy || !f.host} onClick={test}>SSH 테스트</button>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy || !f.host || !installer.available} onClick={deploy}>{busy ? '진행 중…' : '배포 + 설치'}</button>
      </div>

      {result && (
        <div className="card" style={{ borderColor: result.ok ? 'var(--green)' : 'var(--red)' }}>
          <b style={{ color: result.ok ? 'var(--green)' : 'var(--red)' }}>
            {result.ok ? '성공' : '실패'} — {result.kind === 'test' ? 'SSH 테스트' : '배포'}
          </b>
          <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.7 }}>
            {result.reason && <div style={{ color: 'var(--red)' }}>{result.reason}</div>}
            {result.os && <div>OS: {result.os} · root: {result.isRoot ? '예' : '아니오'} · systemd: {result.systemd ? '예' : '아니오'}</div>}
            {result.active && <div>서비스 상태: <b>{result.active}</b> · 설치 패키지: {result.installer}</div>}
          </div>
          {Array.isArray(result.log) && result.log.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>실행 로그 ({result.log.length})</summary>
              <pre style={{ fontSize: 11, maxHeight: 240, overflow: 'auto', background: '#0b1020', padding: 10, borderRadius: 6, marginTop: 6 }}>
                {result.log.map((l, i) => `$ ${l.command}\n${(l.stdout || '') + (l.stderr || '')}`.trim()).join('\n\n')}
              </pre>
            </details>
          )}
        </div>
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.7 }}>
        동작: 중앙 서버의 오프라인 설치 패키지를 대상 호스트로 SFTP 전송 → <code>install.sh</code> 실행 →
        portal.env에 에이전트 설정 주입 → <code>vmware-portal</code> 서비스 재시작. 설치 후 설정 → 수집 서버/에이전트 작업에서 등록·확인하세요.
      </div>
    </>
  );
}
