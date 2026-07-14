import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, delJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const ROLES = ['viewer', 'operator', 'admin'];
const ROLE_LABEL = { viewer: '조회', operator: '운영', admin: '관리자' };

const fmtAgo = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
};

/**
 * 중앙 → 엣지 사용자 배포 관리. 원격 엣지 포탈에 접속(설정 열람 등)할 수 있는 사용자를 중앙에서
 * 지정하면, 엣지가 주기적으로 pull해 자기 로컬 users.json에 반영한다(managed 계정). 엣지의
 * 로컬(비managed) 계정은 건드리지 않는다.
 */
export default function EdgeUserDeploy() {
  const [agents, setAgents] = useState(null);
  const [agent, setAgent] = useState('');
  const [users, setUsers] = useState([]);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ username: '', name: '', role: 'viewer', password: '' });

  const loadAgents = async () => {
    try { const r = await fetchJson('/admin/edge-users/agents'); setAgents(r.agents || []); setError(null); }
    catch (e) { setError(e.message); }
  };
  const loadUsers = async (a) => {
    if (!a) { setUsers([]); return; }
    try { const r = await fetchJson(`/admin/edge-users/${encodeURIComponent(a)}`); setUsers(r.users || []); }
    catch (e) { setMsg(`오류: ${e.message}`); }
  };
  useEffect(() => { loadAgents(); }, []);
  useEffect(() => { loadUsers(agent); setMsg(null); }, [agent]);

  const addUser = async () => {
    if (!agent) { setMsg('먼저 대상 엣지를 선택하세요.'); return; }
    setBusy(true); setMsg(null);
    const r = await postJson(`/admin/edge-users/${encodeURIComponent(agent)}`, form).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { setUsers(r.users || []); setForm({ username: '', name: '', role: 'viewer', password: '' }); setMsg('배포 사용자를 저장했습니다. 엣지가 다음 pull 주기(약 1분)에 반영합니다.'); loadAgents(); }
    else setMsg(`오류: ${r.reason}`);
    setBusy(false);
  };
  const removeUser = async (u) => {
    if (!confirm(`'${u.username}' 사용자를 이 엣지 배포에서 제거할까요? (엣지에서도 다음 pull에 삭제됩니다)`)) return;
    const r = await delJson(`/admin/edge-users/${encodeURIComponent(agent)}/${encodeURIComponent(u.username)}`).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { setUsers(r.users || []); setMsg(`'${u.username}' 제거됨 — 엣지에서도 다음 pull에 삭제됩니다.`); loadAgents(); }
    else setMsg(`오류: ${r.reason}`);
  };

  if (error) return <ErrorBox message={error} />;
  if (agents === null) return <Loading />;

  return (
    <div style={{ maxWidth: 980 }}>
      <div className="section-title" style={{ margin: '6px 0' }}>📡 엣지 사용자 배포 (중앙 → 엣지)</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0, lineHeight: 1.6 }}>
        원격 엣지 포탈에 접속(설정 열람 등)할 수 있는 사용자를 중앙에서 지정합니다. 지정한 사용자는 그 엣지가
        주기적으로 가져가(<b>pull</b>) 자기 로컬 계정에 반영합니다(폐쇄망/NAT 엣지도 동작). 엣지의 <b>로컬 계정은
        건드리지 않으며</b>, 배포 목록에서 빼면 엣지에서도 삭제됩니다(마지막 관리자는 보호).
        <br />비밀번호는 중앙에서 해시로 변환해 배포하며 평문으로 보관하지 않습니다. OTP(2FA)는 각 엣지에서 등록합니다.
      </p>

      <div className="card" style={{ padding: 16 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <b style={{ fontSize: 13 }}>대상 엣지</b>
          <select className="select" style={{ minWidth: 280 }} value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">엣지(agent)를 선택하세요</option>
            {agents.map((a) => <option key={a.agent} value={a.agent}>📡 {a.agent}{a.users ? ` · 배포 ${a.users}명` : ''}{a.at ? ` · ${fmtAgo(a.at)}` : ''}</option>)}
          </select>
          {agents.length === 0 && <span className="muted" style={{ fontSize: 12 }}>후보 엣지가 없습니다 — 엣지가 수집 서버로 등록되었거나 한 번이라도 중앙에 데이터를 보낸 뒤 표시됩니다.</span>}
        </div>

        {agent && (
          <>
            <div style={{ marginTop: 14 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>사용자 추가 / 수정 (같은 ID면 갱신)</div>
              <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
                <label style={{ fontSize: 12 }}>사용자 ID<br /><input className="input" style={{ width: 150 }} value={form.username} placeholder="edgeadmin" onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} /></label>
                <label style={{ fontSize: 12 }}>이름<br /><input className="input" style={{ width: 130 }} value={form.name} placeholder="(선택)" onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></label>
                <label style={{ fontSize: 12 }}>역할<br /><select className="select" style={{ width: 110 }} value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></label>
                <label style={{ fontSize: 12 }}>비밀번호<br /><input className="input" type="password" style={{ width: 160 }} value={form.password} placeholder="8자 이상 (수정 시 비우면 유지)" onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} /></label>
                <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} disabled={busy || !form.username} onClick={addUser}>{busy ? '저장 중…' : '저장/배포'}</button>
              </div>
            </div>

            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table>
                <thead><tr><th style={{ textAlign: 'left' }}>사용자 ID</th><th style={{ textAlign: 'left' }}>이름</th><th style={{ textAlign: 'left' }}>역할</th><th style={{ textAlign: 'left' }}>비밀번호</th><th style={{ textAlign: 'right' }}>관리</th></tr></thead>
                <tbody>
                  {users.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 14, textAlign: 'center' }}>이 엣지에 배포된 사용자가 없습니다.</td></tr>}
                  {users.map((u) => (
                    <tr key={u.username}>
                      <td><b>{u.username}</b></td>
                      <td className="muted">{u.name || '—'}</td>
                      <td><span className={`badge ${u.role === 'admin' ? 'red' : u.role === 'operator' ? 'amber' : 'blue'}`}>{ROLE_LABEL[u.role] || u.role}</span></td>
                      <td className="muted" style={{ fontSize: 12 }}>{u.hasPassword ? '설정됨' : '없음'}</td>
                      <td style={{ textAlign: 'right' }}><button className="tab" style={{ padding: '4px 10px' }} onClick={() => removeUser(u)}>제거</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {msg && <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>{msg}</div>}
    </div>
  );
}
