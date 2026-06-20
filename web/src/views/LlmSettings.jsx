import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

/** 설정 → AI 검색: 자연어 검색용 로컬 LLM(Ollama) 구성 + 연결 테스트. */
export default function LlmSettings() {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

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

      <div className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>
        폐쇄망에서는 별도 서버에 <b>Ollama</b>를 설치하고 모델을 받아 두세요 (예: <code>ollama pull llama3.1</code>).
        포탈은 사용자의 자연어 질문을 <b>검색조건(JSON)으로 변환</b>할 때만 LLM을 호출하며, 실제 데이터(VM/호스트/IP)는
        포탈 내부에서만 검색되어 외부로 나가지 않습니다. 미설정/오류 시 규칙기반 검색으로 자동 폴백합니다.
        사용은 특수기능 → <b>AI 검색</b>.
      </div>
    </>
  );
}
