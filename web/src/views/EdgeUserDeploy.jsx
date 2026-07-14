import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, delJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const ROLES = ['viewer', 'operator', 'admin'];
const ROLE_LABEL = { viewer: '조회', operator: '운영', admin: '관리자' };
const ALL = '*'; // 글로벌(모든 엣지) 대상 키

const fmtAgo = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
};

/**
 * 중앙 → 엣지 사용자 배포 관리. 복수 엣지 선택 또는 '모든 엣지(전체)' 배포를 지원한다.
 * '모든 엣지'는 글로벌('*') 목록으로 저장되어 모든 엣지가 자기 목록과 합쳐 적용하므로,
 * 나중에 추가된 엣지도 자동으로 이 사용자를 받는다.
 */
export default function EdgeUserDeploy() {
  const [agents, setAgents] = useState(null); // [{agent, users, at}]
  const [global, setGlobal] = useState({ users: 0, at: 0 });
  const [viewTarget, setViewTarget] = useState(ALL); // 목록 보기 대상('*' 또는 엣지명)
  const [users, setUsers] = useState([]);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ username: '', name: '', role: 'viewer', password: '' });
  const [allEdges, setAllEdges] = useState(true);         // 배포 대상: 모든 엣지
  const [selEdges, setSelEdges] = useState(() => new Set()); // 배포 대상: 선택 엣지들

  const loadAgents = async () => {
    try { const r = await fetchJson('/admin/edge-users/agents'); setAgents(r.agents || []); setGlobal(r.global || { users: 0, at: 0 }); setError(null); }
    catch (e) { setError(e.message); }
  };
  const loadUsers = async (t) => {
    try { const r = await fetchJson(`/admin/edge-users/${encodeURIComponent(t)}`); setUsers(r.users || []); }
    catch (e) { setMsg(`오류: ${e.message}`); }
  };
  useEffect(() => { loadAgents(); }, []);
  useEffect(() => { loadUsers(viewTarget); setMsg(null); }, [viewTarget]);

  const toggleEdge = (a) => setSelEdges((s) => { const n = new Set(s); n.has(a) ? n.delete(a) : n.add(a); return n; });

  const deploy = async () => {
    if (!form.username) { setMsg('사용자 ID를 입력하세요.'); return; }
    const targets = allEdges ? [ALL] : [...selEdges];
    if (!targets.length) { setMsg('배포할 엣지를 선택하거나 "모든 엣지"를 선택하세요.'); return; }
    setBusy(true); setMsg(null);
    const r = await postJson('/admin/edge-users-bulk', { targets, ...form }).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) {
      setForm({ username: '', name: '', role: 'viewer', password: '' });
      const where = allEdges ? '모든 엣지(전체)' : `${r.applied.length}개 엣지`;
      setMsg(`'${form.username}' 사용자를 ${where}에 배포했습니다${r.failed?.length ? ` · 실패 ${r.failed.length}` : ''}. 각 엣지가 다음 pull 주기(약 1분)에 반영합니다.`);
      loadAgents(); loadUsers(viewTarget);
    } else setMsg(`오류: ${r.reason || (r.failed && r.failed.map((f) => `${f.agent}:${f.reason}`).join(', '))}`);
    setBusy(false);
  };
  const removeUser = async (u) => {
    const label = viewTarget === ALL ? '모든 엣지(전체)' : viewTarget;
    if (!confirm(`'${u.username}' 사용자를 [${label}] 배포에서 제거할까요? (엣지에서도 다음 pull에 삭제)`)) return;
    const r = await delJson(`/admin/edge-users/${encodeURIComponent(viewTarget)}/${encodeURIComponent(u.username)}`).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { setUsers(r.users || []); setMsg(`'${u.username}' 제거됨.`); loadAgents(); }
    else setMsg(`오류: ${r.reason}`);
  };

  if (error) return <ErrorBox message={error} />;
  if (agents === null) return <Loading />;

  return (
    <div style={{ maxWidth: 1040 }}>
      <div className="section-title" style={{ margin: '6px 0' }}>📡 엣지 사용자 배포 (중앙 → 엣지)</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0, lineHeight: 1.6 }}>
        원격 엣지 포탈에 접속(설정 열람 등)할 수 있는 사용자를 중앙에서 지정합니다. <b>복수 엣지 선택</b> 또는
        <b> 모든 엣지(전체)</b> 배포를 지원합니다. '모든 엣지'는 글로벌 목록으로 저장되어 <b>나중에 추가되는 엣지도
        자동 포함</b>됩니다. 지정한 사용자는 각 엣지가 주기적으로 가져가(pull) 자기 로컬 계정에 반영합니다(폐쇄망/NAT 엣지도 동작).
        <br />엣지의 <b>로컬 계정은 건드리지 않으며</b>, 배포에서 빼면 엣지에서도 삭제됩니다(마지막 관리자는 보호).
        비밀번호는 중앙에서 해시로 변환해 배포하며 평문 미보관. OTP(2FA)는 각 엣지에서 등록합니다.
      </p>

      {/* 사용자 추가/배포 */}
      <div className="card" style={{ padding: 16 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>사용자 추가 / 배포 (같은 ID면 갱신)</div>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12 }}>사용자 ID<br /><input className="input" style={{ width: 150 }} value={form.username} placeholder="edgeadmin" onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} /></label>
          <label style={{ fontSize: 12 }}>이름<br /><input className="input" style={{ width: 130 }} value={form.name} placeholder="(선택)" onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></label>
          <label style={{ fontSize: 12 }}>역할<br /><select className="select" style={{ width: 110 }} value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></label>
          <label style={{ fontSize: 12 }}>비밀번호<br /><input className="input" type="password" style={{ width: 170 }} value={form.password} placeholder="8자 이상 (수정 시 비우면 유지)" onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} /></label>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} disabled={busy || !form.username} onClick={deploy}>{busy ? '배포 중…' : '배포'}</button>
        </div>

        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>배포 대상</div>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={allEdges} onChange={(e) => setAllEdges(e.target.checked)} />
            <b>🌐 모든 엣지(전체)</b>
            <span className="muted" style={{ fontSize: 12 }}>{global.users ? `· 현재 전체 배포 ${global.users}명` : ''} — 신규 엣지도 자동 포함</span>
          </label>
          {!allEdges && (
            <div className="flex gap wrap" style={{ gap: 8, marginLeft: 22 }}>
              {agents.length === 0 && <span className="muted" style={{ fontSize: 12 }}>후보 엣지가 없습니다 — 엣지가 수집 서버로 등록되었거나 중앙에 데이터를 보낸 뒤 표시됩니다.</span>}
              {agents.map((a) => (
                <label key={a.agent} className="flex gap" style={{ alignItems: 'center', fontSize: 12, border: '1px solid rgba(148,163,184,.25)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', background: selEdges.has(a.agent) ? 'rgba(34,211,238,.08)' : 'transparent' }}>
                  <input type="checkbox" checked={selEdges.has(a.agent)} onChange={() => toggleEdge(a.agent)} />
                  📡 {a.agent}{a.users ? ` · ${a.users}명` : ''}
                </label>
              ))}
              {agents.length > 0 && (
                <button className="tab" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setSelEdges(new Set(selEdges.size === agents.length ? [] : agents.map((a) => a.agent)))}>
                  {selEdges.size === agents.length ? '전체 해제' : '전체 선택'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 대상별 배포 사용자 목록 */}
      <div className="card" style={{ padding: 16, marginTop: 12 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
          <b style={{ fontSize: 13 }}>배포된 사용자 보기</b>
          <select className="select" style={{ minWidth: 260 }} value={viewTarget} onChange={(e) => setViewTarget(e.target.value)}>
            <option value={ALL}>🌐 모든 엣지(전체){global.users ? ` · ${global.users}명` : ''}</option>
            {agents.map((a) => <option key={a.agent} value={a.agent}>📡 {a.agent}{a.users ? ` · ${a.users}명` : ''}{a.at ? ` · ${fmtAgo(a.at)}` : ''}</option>)}
          </select>
          {viewTarget !== ALL && <span className="muted" style={{ fontSize: 12 }}>이 엣지 전용 목록 — 실제 적용은 여기 + 🌐 모든 엣지 목록을 합쳐 반영됩니다.</span>}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th style={{ textAlign: 'left' }}>사용자 ID</th><th style={{ textAlign: 'left' }}>이름</th><th style={{ textAlign: 'left' }}>역할</th><th style={{ textAlign: 'left' }}>비밀번호</th><th style={{ textAlign: 'right' }}>관리</th></tr></thead>
            <tbody>
              {users.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 14, textAlign: 'center' }}>이 대상에 배포된 사용자가 없습니다.</td></tr>}
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
      </div>

      {msg && <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>{msg}</div>}
    </div>
  );
}
