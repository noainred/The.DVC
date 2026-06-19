import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const EMPTY = { agent: '', ips: '', username: 'root', password: '', enabled: true };

const SAMPLE_CSV = `agent,ips,username,password,enabled
Seoul-DC1,10.0.0.0/24;10.0.1.0/24,root,P@ssw0rd,true
HQ,10.1.0.1-10.1.0.50,root,P@ssw0rd,true
Busan-DC2,10.2.0.0/24,root,P@ssw0rd,false`;

export default function AgentScans() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [replaceMode, setReplaceMode] = useState(false);
  const [importMsg, setImportMsg] = useState(null);
  const fileRef = useRef(null);

  const downloadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'agent-assignments-sample.csv';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) { setCsvText(await file.text()); setCsvOpen(true); }
  };

  const submitImport = async () => {
    setBusy(true); setImportMsg(null);
    try {
      const r = await postJson('/admin/assignments/import', { csv: csvText, mode: replaceMode ? 'replace' : 'merge' });
      setImportMsg(r.ok
        ? { ok: true, text: `가져오기 완료 — 추가 ${r.added}, 갱신 ${r.updated}, 건너뜀 ${r.skipped.length} (총 ${r.total})`, skipped: r.skipped }
        : { ok: false, text: r.reason });
      if (r.ok) { await load(); setCsvOpen(false); setCsvText(''); }
    } catch (e) { setImportMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const load = async () => {
    try { setData(await fetchJson('/admin/assignments')); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const openAdd = () => { setEditing(false); setForm({ ...EMPTY }); setMsg(null); };
  const openEdit = (a) => { setEditing(true); setForm({ ...EMPTY, ...a, password: '' }); setMsg(null); };
  const close = () => { setForm(null); setMsg(null); };
  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = editing ? await putJson(`/admin/assignments/${encodeURIComponent(form.agent)}`, form) : await postJson('/admin/assignments', form);
      if (r.ok) { await load(); close(); } else setMsg({ ok: false, text: r.reason });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const remove = async (a) => {
    if (!window.confirm(`'${a.agent}' 작업 할당을 삭제할까요?`)) return;
    try { await delJson(`/admin/assignments/${encodeURIComponent(a.agent)}`); await load(); }
    catch (e) { setError(e.message); }
  };

  const list = data.assignments || [];
  const results = data.results || {};

  return (
    <>
      <div className="flex between wrap gap" style={{ marginBottom: 6 }}>
        <div className="section-title" style={{ margin: '6px 0' }}>에이전트 작업 — IP 할당 스캔 (관리자)</div>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={onFile} />
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => { setCsvText(''); setImportMsg(null); setCsvOpen(true); }}>CSV 가져오기</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={downloadSample}>샘플 CSV 다운로드</button>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} onClick={openAdd}>+ 작업 추가</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12, padding: '10px 14px' }}>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>
          에이전트 이름별로 <b>IP 대역 + iDRAC 계정</b>을 할당하면, 각 에이전트가 자기 이름의 할당을 읽어
          <b> 로컬에서 스캔</b>하고 발견한 iDRAC를 자동 등록한 뒤 결과를 여기로 보고합니다.
          {!data.centralEnabled && <span style={{ color: 'var(--amber)' }}> ⚠ 이 서버에 <code>CENTRAL_TOKEN</code>이 설정되어야 에이전트가 접속할 수 있습니다.</span>}
          <br />에이전트 설정(각 DC 서버): <code>AGENT_NAME=Seoul-DC1 CENTRAL_URL=http://중앙:4000 CENTRAL_TOKEN=…</code>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>에이전트</th><th>IP 대역</th><th>계정</th><th>상태</th><th>마지막 스캔</th><th>발견</th><th className="right">작업</th>
          </tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 28 }}>할당이 없습니다. “+ 작업 추가”로 에이전트에 IP를 할당하세요.</td></tr>}
            {list.map((a) => {
              const r = results[a.agent];
              return (
                <React.Fragment key={a.agent}>
                  <tr>
                    <td><b>{a.agent}</b></td>
                    <td className="muted" style={{ maxWidth: 260, whiteSpace: 'pre-wrap', fontSize: 12 }}>{a.ips}</td>
                    <td className="muted">{a.username}</td>
                    <td>{a.enabled === false ? <span className="badge gray">중지</span> : <span className="badge green">on</span>}</td>
                    <td className="muted">{r?.at ? new Date(r.at).toLocaleString('ko-KR') : <span className="muted">미보고</span>}{r?.error && <span className="badge red" style={{ marginLeft: 6 }} title={r.error}>오류</span>}</td>
                    <td className="tabular">
                      {r && !r.error ? <>
                        <b style={{ color: 'var(--green)' }}>{r.foundCount}</b> / {r.scanned}
                        {r.found?.length > 0 && <button className="tab" style={{ marginLeft: 6 }} onClick={() => setExpanded(expanded === a.agent ? null : a.agent)}>{expanded === a.agent ? '접기' : '보기'}</button>}
                      </> : '—'}
                    </td>
                    <td className="right nowrap">
                      <button className="tab" onClick={() => openEdit(a)}>수정</button>
                      <button className="tab" style={{ color: 'var(--red)' }} onClick={() => remove(a)}>삭제</button>
                    </td>
                  </tr>
                  {expanded === a.agent && r?.found?.length > 0 && (
                    <tr><td colSpan={7} style={{ background: 'rgba(12,19,34,.5)' }}>
                      <div style={{ maxHeight: 220, overflowY: 'auto', fontSize: 12 }}>
                        <table><thead><tr><th>IP</th><th>서비스태그</th><th>호스트명</th><th>모델</th></tr></thead>
                          <tbody>
                            {r.found.map((f) => (
                              <tr key={f.ip}><td><b>{f.ip}</b></td><td className="muted">{f.serviceTag || '—'}</td><td className="muted">{f.hostName || '—'}</td><td className="muted">{[f.manufacturer, f.model].filter(Boolean).join(' ') || '—'}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>미응답 {r.unreachable} · 타장비 {r.notIdrac} · 인증실패 {r.authFailed}{r.durationMs ? ` · ${(r.durationMs / 1000).toFixed(0)}s` : ''}</div>
                    </td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="modal card" style={{ maxWidth: 640 }}>
            <div className="flex between" style={{ marginBottom: 12 }}>
              <b style={{ fontSize: 15 }}>{editing ? `작업 수정 — ${form.agent}` : '새 에이전트 작업 할당'}</b>
              <button className="logout-btn" onClick={close}>닫기</button>
            </div>
            <div className="spec-grid">
              <label>에이전트 이름 *<input className="input" value={form.agent} onChange={setF('agent')} disabled={editing} placeholder="Seoul-DC1" /></label>
              <label>수집 여부
                <select className="select" value={form.enabled ? '1' : '0'} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.value === '1' }))}>
                  <option value="1">활성</option><option value="0">중지</option>
                </select>
              </label>
              <label>iDRAC 계정 *<input className="input" value={form.username} onChange={setF('username')} placeholder="root" /></label>
              <label>iDRAC 비밀번호 {editing && <span className="muted">(비우면 유지)</span>}<input className="input" type="password" value={form.password} onChange={setF('password')} /></label>
              <label style={{ gridColumn: '1 / -1' }}>IP 대역 (한 줄에 하나 · 범위 · CIDR)
                <textarea className="input" style={{ width: '100%', minHeight: 120, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
                  value={form.ips} onChange={setF('ips')} placeholder={'10.0.0.0/24\n10.0.5.1 - 10.0.5.50'} />
              </label>
            </div>
            {msg && (
              <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 8, fontSize: 13,
                background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</div>
            )}
            <div className="flex gap" style={{ marginTop: 16 }}>
              <button className="login-btn" style={{ flex: 'none', padding: '10px 18px' }} disabled={busy} onClick={save}>
                {busy ? '저장 중…' : (editing ? '저장' : '등록')}
              </button>
            </div>
            <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              에이전트 이름은 각 DC 서버의 <code>AGENT_NAME</code>과 일치해야 합니다. 자격증명은 중앙 서버
              <code> $CONFIG_DIR/agent-assignments.json</code>(0600)에만 저장됩니다.
            </div>
          </div>
        </div>
      )}

      {csvOpen && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setCsvOpen(false); }}>
          <div className="modal card" style={{ maxWidth: 760 }}>
            <div className="flex between" style={{ marginBottom: 10 }}>
              <b style={{ fontSize: 15 }}>CSV로 에이전트 작업 가져오기</b>
              <button className="logout-btn" onClick={() => setCsvOpen(false)}>닫기</button>
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.8 }}>
              컬럼: <code>agent,ips,username,password,enabled</code> · 첫 줄 헤더는 선택입니다.
              <b> ips</b> 칸에 여러 대역은 <code>;</code> 로 구분(쉼표는 CSV 구분자라 사용 불가).
              예) <code>10.0.0.0/24;10.0.1.0/24</code>
            </div>

            <div className="card" style={{ background: 'rgba(12,19,34,.6)', padding: 10, marginBottom: 10 }}>
              <div className="flex between" style={{ marginBottom: 6 }}>
                <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>샘플 CSV</span>
                <div className="flex gap">
                  <button className="tab" onClick={() => setCsvText(SAMPLE_CSV)}>샘플 채우기</button>
                  <button className="tab" onClick={downloadSample}>다운로드</button>
                </div>
              </div>
              <pre style={{ margin: 0, fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>{SAMPLE_CSV}</pre>
            </div>

            <div className="flex gap" style={{ marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={() => fileRef.current?.click()}>파일 선택…</button>
              <span className="muted" style={{ fontSize: 12 }}>또는 아래에 붙여넣기</span>
            </div>
            <textarea className="input" style={{ width: '100%', minHeight: 180, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
              value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder={SAMPLE_CSV} />

            {importMsg && (
              <div style={{ marginTop: 10, padding: '9px 12px', borderRadius: 8, fontSize: 13,
                background: importMsg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: importMsg.ok ? '#4ade80' : '#f87171' }}>
                {importMsg.text}
                {importMsg.skipped?.length > 0 && (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--amber)' }}>
                    {importMsg.skipped.slice(0, 8).map((s, i) => <li key={i}>{s.agent}: {s.reason}</li>)}
                  </ul>
                )}
              </div>
            )}

            <div className="flex gap" style={{ marginTop: 12, alignItems: 'center' }}>
              <button className="login-btn" style={{ flex: 'none', padding: '10px 18px' }} disabled={busy || !csvText.trim()} onClick={submitImport}>
                {busy ? '가져오는 중…' : '가져오기'}
              </button>
              <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12 }}>
                <input type="checkbox" checked={replaceMode} onChange={(e) => setReplaceMode(e.target.checked)} /> 전체 교체
              </label>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
