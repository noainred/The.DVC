import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

/** 설정 → AI 검색: 자연어 검색용 로컬 LLM(Ollama) 구성 + 연결 테스트. */
export default function LlmSettings() {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dep, setDep] = useState({ host: '', port: 22, username: 'root', password: '', privateKey: '', mode: 'online', binaryPath: '', model: 'llama3.1', applyToPortal: true });
  const [depResult, setDepResult] = useState(null);

  useEffect(() => { fetchJson('/admin/llm-config').then((d) => setCfg(d.config)).catch((e) => setError(e.message)); }, []);
  if (error) return <ErrorBox message={error} />;
  if (!cfg) return <Loading />;

  const set = (k) => (e) => setCfg((c) => ({ ...c, [k]: e.target.value }));
  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 5000); };

  const save = async () => {
    setBusy(true);
    const r = await putJson('/admin/llm-config', cfg).catch((e) => ({ ok: false, reason: e.message }));
    if (r.config) setCfg(r.config);
    flash(!!r.config, r.config ? '저장했습니다.' : (r.reason || '저장 실패')); setBusy(false);
  };
  const test = async () => {
    setBusy(true);
    const r = await postJson('/admin/llm-test', cfg).catch((e) => ({ ok: false, reason: e.message }));
    flash(r.ok, r.ok ? `연결 성공 (${r.ms}ms) · 모델 ${r.models?.length || 0}개${r.hasModel ? ` · '${cfg.model}' 있음` : ` · '${cfg.model}' 없음(설치 필요)`}` : `실패: ${r.reason}`);
    setBusy(false);
  };

  const setD = (k) => (e) => setDep((d) => ({ ...d, [k]: e.target.value }));
  const testDep = async () => {
    setBusy(true); setDepResult(null);
    const r = await postJson('/admin/ollama-deploy/test', dep).catch((e) => ({ ok: false, reason: e.message }));
    setDepResult({ kind: 'test', ...r }); setBusy(false);
  };
  const installDep = async () => {
    if (!window.confirm(`${dep.host} 에 Ollama를 ${dep.mode === 'offline' ? '오프라인' : '온라인'} 설치할까요? (root 필요)`)) return;
    setBusy(true); setDepResult(null);
    const r = await postJson('/admin/ollama-deploy', dep).catch((e) => ({ ok: false, reason: e.message }));
    setDepResult({ kind: 'install', ...r });
    if (r.ok) fetchJson('/admin/llm-config').then((d) => setCfg(d.config)).catch(() => {});
    setBusy(false);
  };

  return (
    <>
      <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <div className="section-title" style={{ margin: '6px 0' }}>AI 자연어 검색 (로컬 LLM)</div>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} /> 사용
        </label>
      </div>

      {msg && <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13, background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</div>}

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="spec-grid">
          <label>Ollama 주소<input className="input" value={cfg.url} onChange={set('url')} placeholder="http://localhost:11434" /></label>
          <label>모델<input className="input" value={cfg.model} onChange={set('model')} placeholder="llama3.1" /></label>
          <label>타임아웃(ms)<input className="input" type="number" value={cfg.timeoutMs} onChange={set('timeoutMs')} /></label>
        </div>
        <div className="flex gap" style={{ marginTop: 10 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy} onClick={save}>저장</button>
          <button className="logout-btn" style={{ padding: '8px 14px' }} disabled={busy} onClick={test}>연결 테스트</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <b style={{ fontSize: 14 }}>Ollama 서버 자동설치 (SSH)</b>
        <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>별도 서버에 SSH로 접속해 Ollama를 설치하고 0.0.0.0:11434로 노출, (선택)모델 pull 후 위 설정에 자동 연결합니다. root 권한 필요.</div>
        <div className="spec-grid">
          <label>SSH 호스트<input className="input" value={dep.host} onChange={setD('host')} placeholder="10.40.0.9" /></label>
          <label>포트<input className="input" type="number" value={dep.port} onChange={setD('port')} /></label>
          <label>사용자(root)<input className="input" value={dep.username} onChange={setD('username')} /></label>
          <label>비밀번호<input className="input" type="password" value={dep.password} onChange={setD('password')} placeholder="(키 사용 시 비움)" /></label>
          <label>설치 모드
            <select className="select" value={dep.mode} onChange={setD('mode')}>
              <option value="online">온라인 (공식 스크립트, 인터넷 필요)</option>
              <option value="offline">오프라인 (tgz 전송)</option>
            </select>
          </label>
          <label>모델 pull(선택)<input className="input" value={dep.model} onChange={setD('model')} placeholder="llama3.1 (인터넷 필요)" /></label>
          {dep.mode === 'offline' && <label style={{ gridColumn: '1 / -1' }}>Ollama tgz 경로(중앙 서버)<input className="input" value={dep.binaryPath} onChange={setD('binaryPath')} placeholder="/root/ollama-linux-amd64.tgz" /></label>}
          <label style={{ gridColumn: '1 / -1' }}>개인키(PEM, 선택)<textarea className="input" rows={2} value={dep.privateKey} onChange={setD('privateKey')} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }} /></label>
        </div>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, marginTop: 8 }}>
          <input type="checkbox" checked={dep.applyToPortal} onChange={(e) => setDep({ ...dep, applyToPortal: e.target.checked })} /> 설치 후 이 포탈의 LLM 주소로 자동 설정
        </label>
        <div className="flex gap" style={{ marginTop: 10 }}>
          <button className="logout-btn" style={{ padding: '8px 14px' }} disabled={busy || !dep.host} onClick={testDep}>SSH 테스트</button>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy || !dep.host} onClick={installDep}>{busy ? '진행 중…' : 'Ollama 설치'}</button>
        </div>
        {depResult && (
          <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, fontSize: 13, background: depResult.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: depResult.ok ? '#4ade80' : '#f87171' }}>
            {depResult.ok
              ? (depResult.kind === 'test'
                  ? `SSH 성공 · ${depResult.os || ''} · root ${depResult.isRoot ? 'O' : 'X'} · systemd ${depResult.systemd ? 'O' : 'X'}`
                  : `설치 성공 · ${depResult.version || ''} · ${depResult.url}${depResult.pulled ? ` · 모델 ${depResult.pulled.ok ? 'pull OK' : 'pull 실패'}` : ''}${depResult.appliedToPortal ? ' · 포탈 연결됨' : ''}`)
              : `실패: ${depResult.reason}`}
          </div>
        )}
      </div>

      <div className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>
        폐쇄망에서는 위 <b>오프라인 모드</b>로 Ollama tgz를 전송 설치하세요. 모델은 인터넷이 없으면 <code>ollama pull</code> 대신 미리 받아둔 모델을 사용하세요.
        포탈은 사용자의 자연어 질문을 <b>검색조건(JSON)으로 변환</b>할 때만 LLM을 호출하며, 실제 데이터(VM/호스트/IP)는
        포탈 내부에서만 검색되어 외부로 나가지 않습니다. 미설정/오류 시 규칙기반 검색으로 자동 폴백합니다.
        사용은 특수기능 → <b>AI 검색</b>.
      </div>
    </>
  );
}
