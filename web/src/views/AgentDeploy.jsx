import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../api.js';
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
  const [targets, setTargets] = useState([]);
  const [pkg, setPkg] = useState(null);
  const [dl, setDl] = useState({ kind: 'installer', version: '', busy: false });
  const [pkgCfg, setPkgCfg] = useState(null); // { baseUrl, dir } editable

  const loadInstaller = () => fetchJson('/admin/agent-deploy/installer').then(setInstaller).catch(() => setInstaller({ available: false }));
  const loadPkg = () => fetchJson('/admin/packages').then((p) => { setPkg(p); setPkgCfg({ baseUrl: p.baseUrl || '', dir: p.dir || '' }); }).catch(() => setPkg(null));
  const savePkgCfg = async () => {
    const r = await putJson('/admin/packages/settings', pkgCfg).catch((e) => ({ ok: false, reason: e.message }));
    setResult({ kind: 'pkgcfg', ok: !!r.ok, reason: r.reason });
    await loadPkg();
  };
  const loadTargets = () => fetchJson('/admin/agent-deploy/targets').then((d) => setTargets(d.targets)).catch(() => {});
  useEffect(() => { loadInstaller(); loadTargets(); loadPkg(); }, []);

  const downloadPkg = async () => {
    setDl((d) => ({ ...d, busy: true })); setResult(null);
    const r = await postJson('/admin/packages/download', { kind: dl.kind, version: dl.version || undefined }).catch((e) => ({ ok: false, reason: e.message }));
    setResult({ kind: 'pkg', ...r });
    await loadPkg(); await loadInstaller();
    setDl((d) => ({ ...d, busy: false }));
  };
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const saveTarget = async () => {
    const r = await postJson('/admin/agent-deploy/targets', { id: f.id, ...f }).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { await loadTargets(); setResult({ kind: 'save', ok: true, reason: '대상을 저장했습니다.' }); }
    else setResult({ kind: 'save', ok: false, reason: r.reason });
  };
  const editTarget = (t) => setF({ ...EMPTY, ...t, password: '', privateKey: '' });
  const removeTarget = async (t) => { if (window.confirm(`'${t.host}' 대상을 삭제할까요?`)) { await delJson(`/admin/agent-deploy/targets/${t.id}`).catch(() => {}); await loadTargets(); } };
  const deployTarget = async (t) => {
    if (!window.confirm(`${t.host} 에 배포할까요?`)) return;
    setBusy(true); setResult(null);
    const r = await postJson(`/admin/agent-deploy/targets/${t.id}/deploy`, {}).catch((e) => ({ ok: false, reason: e.message }));
    setResult({ kind: 'deploy', ...r }); await loadTargets(); setBusy(false);
  };
  const deployAll = async () => {
    if (!window.confirm(`저장된 활성 대상 전체에 배포할까요? (순차 진행)`)) return;
    setBusy(true); setResult(null);
    const r = await postJson('/admin/agent-deploy/deploy-all', {}).catch((e) => ({ ok: false, reason: e.message }));
    setResult({ kind: 'deploy-all', ...r }); await loadTargets(); setBusy(false);
  };

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

      <div className="card" style={{ marginBottom: 12 }}>
        <b style={{ fontSize: 14 }}>설치 패키지 자동 다운로드</b>
        <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
          저장소에서 패키지를 받아 저장 경로에 보관합니다(SHA-256 검증). 폐쇄망은 아래 <b>저장소 URL</b>을 사내 미러로 바꾸세요(웹에서 바로 수정 가능).
        </div>
        {pkgCfg && (
          <div className="card" style={{ margin: '0 0 10px', padding: '10px 12px', background: 'rgba(255,255,255,.02)' }}>
            <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
              <label style={{ flex: 2, minWidth: 320, fontSize: 12 }}>저장소 URL (versions.json 위치)
                <input className="input" value={pkgCfg.baseUrl} onChange={(e) => setPkgCfg({ ...pkgCfg, baseUrl: e.target.value })} placeholder="https://mirror.corp/vmware-portal/download" />
              </label>
              <label style={{ flex: 1, minWidth: 220, fontSize: 12 }}>저장 경로
                <input className="input" value={pkgCfg.dir} onChange={(e) => setPkgCfg({ ...pkgCfg, dir: e.target.value })} placeholder="/etc/vmware-portal/packages" />
              </label>
              <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={savePkgCfg}>저장</button>
              <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={loadPkg}>새로고침</button>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              비워두면 환경변수 기본값을 사용합니다(기본 URL: <code>{pkg?.settings?.defaults?.baseUrl}</code>). {pkg?.settings?.overridden?.baseUrl ? '· 현재 웹에서 지정한 URL 사용 중' : ''}
            </div>
          </div>
        )}
        <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12 }}>종류
            <select className="select" value={dl.kind} onChange={(e) => setDl({ ...dl, kind: e.target.value })}>
              <option value="installer">설치 패키지(Rocky 9 offline)</option>
              <option value="installer_cent9">설치 패키지(CentOS Stream 9 offline)</option>
              <option value="bundle">업그레이드 번들(app)</option>
              <option value="windows">Windows zip</option>
            </select>
          </label>
          <label style={{ fontSize: 12 }}>버전(비우면 latest{pkg?.remote?.latest ? ` ${pkg.remote.latest}` : ''})
            <input className="input" value={dl.version} onChange={(e) => setDl({ ...dl, version: e.target.value })} placeholder={pkg?.remote?.latest || '1.x.y'} />
          </label>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} disabled={dl.busy} onClick={downloadPkg}>{dl.busy ? '다운로드 중…' : '다운로드'}</button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          저장소: <code>{pkg?.baseUrl}</code>{pkg?.remote?.error ? ` · ⚠ 원격 조회 실패: ${pkg.remote.error}` : (pkg?.remote?.latest ? ` · 원격 latest ${pkg.remote.latest}` : '')}
        </div>
        {pkg?.local?.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>보유 패키지</div>
            {pkg.local.map((p) => <div key={p.name} style={{ fontSize: 12 }}><code>{p.name}</code> <span className="muted">({(p.sizeBytes / 1048576).toFixed(1)} MB)</span></div>)}
          </div>
        )}
      </div>

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

      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        <button className="logout-btn" style={{ padding: '9px 16px' }} disabled={busy || !f.host} onClick={test}>SSH 테스트</button>
        <button className="logout-btn" style={{ padding: '9px 16px' }} disabled={busy || !f.host} onClick={saveTarget}>{f.id ? '대상 수정' : '대상 저장'}</button>
        {f.id && <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => setF(EMPTY)}>새 대상</button>}
        <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy || !f.host || !installer.available} onClick={deploy}>{busy ? '진행 중…' : '배포 + 설치'}</button>
      </div>

      {targets.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
            <b style={{ fontSize: 14 }}>저장된 대상 ({targets.length})</b>
            <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy || !installer.available} onClick={deployAll}>전체 배포</button>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>호스트</th><th>에이전트</th><th>중앙</th><th>마지막 결과</th><th style={{ textAlign: 'right' }}>작업</th></tr></thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.id}>
                    <td><b>{t.host}</b>:{t.port || 22} <span className="muted" style={{ fontSize: 11 }}>{t.username}</span></td>
                    <td>{t.agentName || '—'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{t.centralUrl || '—'}</td>
                    <td>{t.lastResult ? <span className={`badge ${t.lastResult.ok ? 'green' : 'red'}`}>{t.lastResult.ok ? t.lastResult.active || 'ok' : '실패'}</span> : <span className="muted">—</span>}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="login-btn" style={{ flex: 'none', padding: '6px 12px' }} disabled={busy || !installer.available} onClick={() => deployTarget(t)}>배포</button>{' '}
                      <button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => editTarget(t)}>편집</button>{' '}
                      <button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => removeTarget(t)}>삭제</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && (
        <div className="card" style={{ borderColor: result.ok ? 'var(--green)' : 'var(--red)' }}>
          <b style={{ color: result.ok ? 'var(--green)' : 'var(--red)' }}>
            {result.ok ? '성공' : '실패'} — {{ test: 'SSH 테스트', save: '대상 저장', 'deploy-all': '전체 배포', pkg: '패키지 다운로드' }[result.kind] || '배포'}
          </b>
          <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.7 }}>
            {result.reason && <div style={{ color: result.ok ? 'var(--green)' : 'var(--red)' }}>{result.reason}</div>}
            {result.os && <div>OS: {result.os} · root: {result.isRoot ? '예' : '아니오'} · systemd: {result.systemd ? '예' : '아니오'}</div>}
            {result.active && <div>서비스 상태: <b>{result.active}</b> · 설치 패키지: {result.installer}</div>}
            {result.kind === 'pkg' && result.ok && <div>저장: <code>{result.file}</code> ({(result.sizeBytes / 1048576).toFixed(1)} MB) · v{result.version}{result.verified ? ' · SHA-256 검증됨' : ''}</div>}
            {result.kind === 'deploy-all' && <div>{result.deployed}/{result.total} 성공
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {(result.results || []).map((x) => <li key={x.id} style={{ color: x.ok ? 'var(--green)' : 'var(--red)' }}>{x.host} · {x.agentName || ''} — {x.ok ? (x.active || 'ok') : x.reason}</li>)}
              </ul>
            </div>}
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
