import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../../api.js';
import { Loading, ErrorBox, Kpi, Modal } from '../../components/ui.jsx';
import { resultSummary, ago } from './remoteCommand.js';

/**
 * 특수기능 › 통합 계정 관리(v2.419).
 *
 * RMA 가 엣지 망 안의 서버에 SSH 로 점검·명령을 실행할 때 쓰는 계정을 중앙 한 곳에서 관리한다.
 * 보안 설계(서버 security/credentialStore.js):
 *  - 비밀 값(비밀번호/개인키/패스프레이즈)은 등록·수정 요청에만 실리고, 어떤 조회 응답에도 없다(지문만).
 *  - 등록/수정/삭제는 OTP 재인증(로컬 OTP 계정) 또는 설정 소유자. 전부 감사로그.
 *  - 사용 범위: 법인(RMA)·대상 호스트 허용 목록 — 브로커가 둘 다 검사한 뒤에만 엣지에 1회 전달(메모리에서만 사용).
 */
const TONE = { ok: 'var(--green, #22c55e)', warn: 'var(--amber, #f59e0b)', bad: 'var(--red, #ef4444)', muted: 'var(--muted, #94a3b8)' };
const EMPTY = { name: '', kind: 'password', username: '', password: '', privateKey: '', passphrase: '', hosts: '', agents: '*', note: '' };

export default function CredentialManager() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [test, setTest] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchJson('/tools/credentials').then((d) => { if (alive) { setData(d); setError(null); } }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [tick]);
  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const items = data.items || [];
  const reload = () => setTick((t) => t + 1);
  return (
    <div>
      <div className="section-title">🔑 통합 계정 관리</div>
      <p className="muted" style={{ marginTop: 4 }}>
        RMA 가 엣지 망 안의 서버에 SSH 로 점검·명령을 실행할 때 쓰는 계정입니다. ID/비밀번호 또는 SSH 개인키 중 하나를 골라 저장합니다.
        비밀 값은 봉인 저장(설정 › 자격증명 저장 방식)되며 화면·API 어디에도 다시 표시되지 않습니다. 등록·수정·삭제는 OTP 재인증이 필요하고 모두 감사로그에 남습니다.
      </p>
      {error && <div className="card muted" style={{ borderColor: TONE.warn }}>일시 조회 오류: {error}</div>}
      <div className="kpis">
        <Kpi label="등록 계정" value={items.length} />
        <Kpi label="ID/비밀번호" value={items.filter((i) => i.kind === 'password').length} />
        <Kpi label="SSH 키" value={items.filter((i) => i.kind === 'key').length} />
        <Kpi label="SSH 허용 RMA 법인" value={(data.rmaAgents || []).filter((a) => a.allowSsh).length} meta="RMA_ALLOW_SSH=true 인 온라인 인스턴스" />
      </div>
      <div className="flex gap wrap" style={{ margin: '8px 0' }}>
        <button className="login-btn" onClick={() => setForm({ ...EMPTY })}>+ 계정 등록</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>이름</th><th>종류</th><th>계정</th><th>사용 가능 법인</th><th>대상 호스트</th><th>키 지문</th><th>사용</th><th>변경</th><th></th></tr></thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td><b>{c.name}</b>{c.note ? <div className="muted" style={{ fontSize: 11 }}>{c.note}</div> : null}</td>
                <td>{c.kind === 'key' ? <span className="badge blue">SSH 키{c.hasPassphrase ? ' +패스프레이즈' : ''}</span> : <span className="badge">ID/비밀번호</span>}</td>
                <td><code>{c.username}</code></td>
                <td className="muted">{(c.agents || []).join(', ')}</td>
                <td className="muted" style={{ maxWidth: 260, wordBreak: 'break-all' }}>{(c.hosts || []).join(', ')}</td>
                <td className="muted" style={{ fontSize: 11 }}>{c.fingerprint ? `${c.keyType} ${c.fingerprint}` : '—'}</td>
                <td className="muted">{c.useCount || 0}회{c.lastUsedAt ? <div style={{ fontSize: 11 }}>{ago(c.lastUsedAt)} · {c.lastUsedBy}</div> : null}</td>
                <td className="muted" style={{ fontSize: 11 }}>{c.updatedBy || c.createdBy}<div>{ago(c.updatedAt || c.createdAt)}</div></td>
                <td className="flex gap">
                  <button className="tab" onClick={() => setTest(c)}>연결 테스트</button>
                  <button className="tab" onClick={() => setForm({ ...EMPTY, ...c, hosts: (c.hosts || []).join(', '), agents: (c.agents || []).join(', '), password: '', privateKey: '', passphrase: '' })}>수정</button>
                  <button className="tab" onClick={() => setForm({ ...c, _delete: true })}>삭제</button>
                </td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={9} className="muted">등록된 계정이 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
      {form && <CredForm form={form} agents={data.agents || []} onClose={() => setForm(null)} onSaved={() => { setForm(null); reload(); }} />}
      {test && <TestModal cred={test} rmaAgents={data.rmaAgents || []} onClose={() => { setTest(null); reload(); }} />}
    </div>
  );
}

function CredForm({ form, agents, onClose, onSaved }) {
  const [f, setF] = useState(form);
  const [otp, setOtp] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [fp, setFp] = useState(null);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const inspect = async () => {
    setErr(''); setFp(null);
    try { const r = await postJson('/tools/credentials/inspect-key', { privateKey: f.privateKey, passphrase: f.passphrase }); setFp(r.ok ? `${r.type} ${r.fingerprint}${r.comment ? ` (${r.comment})` : ''}` : `오류: ${r.reason}`); }
    catch (e) { setErr(e.message); }
  };
  const submit = async () => {
    setErr(''); setBusy(true);
    try {
      if (f._delete) { await delJson(`/tools/credentials/${encodeURIComponent(f.id)}?otp=${encodeURIComponent(otp)}`); onSaved(); return; }
      const body = { name: f.name, kind: f.kind, username: f.username, hosts: f.hosts, agents: f.agents, note: f.note, otp,
        ...(f.kind === 'password' ? { password: f.password } : { privateKey: f.privateKey, passphrase: f.passphrase }) };
      if (f.id) await putJson(`/tools/credentials/${encodeURIComponent(f.id)}`, body); else await postJson('/tools/credentials', body);
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  if (f._delete) {
    return (
      <Modal title={`계정 삭제 — ${f.name}`} onClose={onClose} width={520}>
        <div>이 계정을 삭제하면 이 계정을 쓰는 RMA 점검 스케줄은 '계정 인출 실패'로 실패합니다.</div>
        <div className="flex gap" style={{ marginTop: 10, alignItems: 'flex-end' }}>
          <label>OTP 코드(재인증)<br /><input className="input" style={{ width: 120 }} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} placeholder="6자리" /></label>
          <button className="login-btn" disabled={busy} onClick={submit} style={{ color: TONE.bad }}>삭제</button>
        </div>
        {err && <div className="error-box" style={{ marginTop: 8 }}>{err}</div>}
      </Modal>
    );
  }
  return (
    <Modal title={f.id ? `계정 수정 — ${form.name}` : '계정 등록'} onClose={onClose} width={760}>
      <div className="flex gap wrap">
        <label>이름 *<br /><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="예: 리눅스 운영 계정(서울)" /></label>
        <label>종류 *<br />
          <select className="input" value={f.kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="password">ID / 비밀번호</option>
            <option value="key">SSH 개인키 (+ 패스프레이즈)</option>
          </select>
        </label>
        <label>계정(ID) *<br /><input className="input" value={f.username} onChange={(e) => set('username', e.target.value)} placeholder="root / svc-monitor" /></label>
      </div>
      {f.kind === 'password' ? (
        <div style={{ marginTop: 6 }}>
          <label>비밀번호 {f.id ? '(비우면 기존 값 유지)' : '*'}<br /><input className="input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => set('password', e.target.value)} style={{ minWidth: 320 }} /></label>
        </div>
      ) : (
        <div style={{ marginTop: 6 }}>
          <label>SSH 개인키 (PEM/OpenSSH) {f.id ? '(비우면 기존 키 유지)' : '*'}<br />
            <textarea className="input" rows={6} style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }} value={f.privateKey} onChange={(e) => set('privateKey', e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
          </label>
          <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
            <label>패스프레이즈(키가 암호화된 경우)<br /><input className="input" type="password" autoComplete="new-password" value={f.passphrase} onChange={(e) => set('passphrase', e.target.value)} /></label>
            <button className="tab" disabled={!f.privateKey} onClick={inspect}>키 검증(지문 확인)</button>
            {fp && <span className="muted" style={{ fontSize: 12 }}>{fp}</span>}
          </div>
        </div>
      )}
      <div className="section-title" style={{ marginTop: 10 }}>사용 범위 (브로커가 둘 다 검사)</div>
      <div className="flex gap wrap">
        <label>사용 가능 법인(RMA) *<br /><input className="input" list="cred-agents" value={f.agents} onChange={(e) => set('agents', e.target.value)} placeholder="* 또는 Seoul,Poland" style={{ minWidth: 260 }} /></label>
        <datalist id="cred-agents">{agents.map((a) => <option key={a} value={a} />)}</datalist>
        <label>대상 호스트 허용 *<br /><input className="input" value={f.hosts} onChange={(e) => set('hosts', e.target.value)} placeholder="10.10.0.0/16, db01.corp, *.corp.local (전체 *)" style={{ minWidth: 320 }} /></label>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>범위를 좁게 두세요 — 엣지 1대가 침해돼도 그 법인에 허용된 계정을, 허용된 대상에만 쓸 수 있습니다.</div>
      <div style={{ marginTop: 6 }}><label>메모<br /><input className="input" style={{ width: '100%' }} value={f.note} onChange={(e) => set('note', e.target.value)} /></label></div>
      <div className="flex gap" style={{ marginTop: 10, alignItems: 'flex-end' }}>
        <label>OTP 코드(재인증) *<br /><input className="input" style={{ width: 120 }} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} placeholder="6자리" /></label>
        <button className="login-btn" disabled={busy} onClick={submit}>{f.id ? '수정 저장' : '등록'}</button>
        <span className="muted" style={{ fontSize: 12 }}>OTP 가 없는 계정(AD 등)은 설정 소유자만 저장할 수 있습니다.</span>
      </div>
      {err && <div className="error-box" style={{ marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}

function TestModal({ cred, rmaAgents, onClose }) {
  const candidates = rmaAgents.filter((a) => (cred.agents || []).some((x) => x === '*' || x.toLowerCase() === a.agent.toLowerCase()));
  const [agent, setAgent] = useState(candidates[0]?.agent || '');
  const [host, setHost] = useState((cred.hosts || []).find((h) => !h.includes('*') && !h.includes('/')) || '');
  const [port, setPort] = useState('22');
  const [state, setState] = useState(null);
  const pollRef = useRef(null);
  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);
  const run = async () => {
    setState({ phase: 'submit' });
    try {
      const r = await postJson(`/tools/credentials/${encodeURIComponent(cred.id)}/test`, { agent, host, port: Number(port) || 22 });
      setState({ phase: 'wait', reqId: r.reqId });
      const started = Date.now();
      const poll = async () => {
        try {
          const j = await fetchJson(`/tools/rma/jobs/${encodeURIComponent(r.reqId)}`);
          if (j.state === 'done') { setState({ phase: 'done', job: j }); return; }
          if (j.state === 'unknown') { setState({ err: '잡을 찾을 수 없습니다.' }); return; }
        } catch (e) { setState({ err: e.message }); return; }
        if (Date.now() - started < 5 * 60_000) pollRef.current = setTimeout(poll, 1500);
      };
      poll();
    } catch (e) { setState({ err: e.message }); }
  };
  const res = state?.job?.result;
  const s = res ? resultSummary(res) : null;
  return (
    <Modal title={`연결 테스트 — ${cred.name} (${cred.username})`} onClose={onClose} width={720}>
      <div className="muted" style={{ fontSize: 12 }}>선택한 법인의 RMA 가 대상 서버에 이 계정으로 SSH 접속해 <code>echo RMA-CRED-OK; id -un; uname -n</code> 을 실행합니다. 비밀은 브로커로 RMA 메모리에만 전달됩니다. 엣지 <code>RMA_ALLOW_SSH=true</code> 가 필요합니다.</div>
      <div className="flex gap wrap" style={{ marginTop: 8, alignItems: 'flex-end' }}>
        <label>법인(RMA)<br /><select className="input" value={agent} onChange={(e) => setAgent(e.target.value)}>{candidates.map((a) => <option key={a.agent} value={a.agent}>{a.agent}{a.online ? '' : ' (오프라인)'}{a.allowSsh ? '' : ' (SSH 미허용)'}</option>)}</select></label>
        <label>대상 호스트<br /><input className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.10.1.5" /></label>
        <label>포트<br /><input className="input" style={{ width: 70 }} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} /></label>
        <button className="login-btn" disabled={!agent || !host || (state && state.phase && state.phase !== 'done')} onClick={run}>테스트</button>
      </div>
      {!candidates.length && <div className="error-box" style={{ marginTop: 8 }}>이 계정을 쓸 수 있는 RMA 법인이 온라인이 아닙니다(사용 가능 법인·RMA 배포 확인).</div>}
      {state?.phase && state.phase !== 'done' && <div className="muted" style={{ marginTop: 8 }}>실행 중…</div>}
      {state?.err && <div className="error-box" style={{ marginTop: 8 }}>{state.err}</div>}
      {res && (
        <div style={{ marginTop: 10 }}>
          <div style={{ color: TONE[s.tone] }}>{s.text}</div>
          {res.stdout ? <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{res.stdout}</pre> : null}
          {res.stderr ? <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: TONE.warn }}>{res.stderr}</pre> : null}
        </div>
      )}
    </Modal>
  );
}
