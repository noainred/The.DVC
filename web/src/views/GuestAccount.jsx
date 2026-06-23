import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, usePolling } from '../api.js';
import { Loading } from '../components/ui.jsx';

/** 설정 → 게스트 계정 추가 — VMware Tools(게스트 작업)로 게스트 OS에 sudo 계정 추가. */
export default function GuestAccount() {
  const { data: vcs } = usePolling('/vcenters', {}, 60_000);
  const [vc, setVc] = useState('');
  const [vms, setVms] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [f, setF] = useState({ username: '', password: '', sudo: true, nopasswd: false, guestUser: 'root', guestPass: '' });
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (!vc) { setVms(null); setSel(new Set()); return; }
    setVms(null);
    fetchJson('/vms', { vcenterId: vc, powerState: 'POWERED_ON', limit: 1000 }).then((d) => setVms(d.items || [])).catch(() => setVms([]));
    setSel(new Set());
  }, [vc]);

  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allTools = (vms || []).filter((v) => v.toolsStatus === 'RUNNING');
  const selectAll = () => setSel(new Set(allTools.map((v) => v.id)));

  const apply = async () => {
    if (!f.username || !f.password) { setMsg('새 계정 사용자명/비밀번호를 입력하세요.'); return; }
    if (!sel.size) { setMsg('대상 VM을 선택하세요.'); return; }
    setBusy(true); setMsg(null); setRes(null);
    try {
      const r = await postJson('/admin/guest/add-user', { vcenterId: vc, vmIds: [...sel], username: f.username, password: f.password, sudo: f.sudo, nopasswd: f.nopasswd, guestUser: f.guestUser, guestPass: f.guestPass });
      setRes(r);
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="section-title" style={{ marginTop: 0 }}>👤 게스트 계정 추가 (sudo)</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        VMware Tools(게스트 작업 API)로 게스트 OS에 <b>sudo 사용자 계정</b>을 추가합니다. <b>root 게스트 자격증명</b>이 필요하며,
        비밀번호는 셸 인자가 아닌 별도 파일로 전달됩니다. ⚠️ 강력한 권한 작업 — 감사 로그에 기록됩니다.
      </p>

      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 12 }}>
          <span className="muted">vCenter</span>
          <select className="select" value={vc} onChange={(e) => setVc(e.target.value)}><option value="">선택</option>{(vcs || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
        </div>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 12, marginTop: 12 }}>
          <span className="muted"><b>새 계정</b></span>
          <input className="input" placeholder="사용자명" style={{ width: 150 }} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
          <input className="input" type="password" placeholder="비밀번호" style={{ width: 160 }} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, cursor: 'pointer' }}><input type="checkbox" checked={f.sudo} onChange={(e) => setF({ ...f, sudo: e.target.checked })} /> sudo 부여</label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, cursor: 'pointer' }} title="sudoers.d에 NOPASSWD 추가"><input type="checkbox" checked={f.nopasswd} disabled={!f.sudo} onChange={(e) => setF({ ...f, nopasswd: e.target.checked })} /> NOPASSWD</label>
        </div>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 12, marginTop: 12 }}>
          <span className="muted"><b>게스트 인증(root)</b></span>
          <input className="input" placeholder="게스트 사용자(root)" style={{ width: 150 }} value={f.guestUser} onChange={(e) => setF({ ...f, guestUser: e.target.value })} />
          <input className="input" type="password" placeholder="게스트 비밀번호" style={{ width: 160 }} value={f.guestPass} onChange={(e) => setF({ ...f, guestPass: e.target.value })} />
          <span className="muted" style={{ fontSize: 11 }}>비우면 GPU 게스트 설정의 계정 사용</span>
        </div>
      </div>

      {vc && (
        <div className="card" style={{ padding: 14, marginBottom: 14 }}>
          <div className="flex between" style={{ alignItems: 'center', marginBottom: 8 }}>
            <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>대상 VM ({sel.size} 선택)</div>
            <div className="flex gap"><button className="tab" style={{ padding: '5px 10px' }} onClick={selectAll}>Tools 가동 모두 선택</button><button className="tab" style={{ padding: '5px 10px' }} onClick={() => setSel(new Set())}>해제</button></div>
          </div>
          {!vms ? <Loading /> : vms.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>가동 중인 VM이 없습니다.</div> : (
            <div className="table-wrap" style={{ maxHeight: '40vh' }}>
              <table><thead><tr><th></th><th>VM</th><th>Guest OS</th><th>VMware Tools</th><th>호스트</th></tr></thead>
                <tbody>{vms.map((v) => (
                  <tr key={v.id} style={{ opacity: v.toolsStatus === 'RUNNING' ? 1 : 0.5 }}>
                    <td><input type="checkbox" checked={sel.has(v.id)} disabled={v.toolsStatus !== 'RUNNING'} onChange={() => toggle(v.id)} /></td>
                    <td><b>{v.name}</b></td><td className="muted" style={{ fontSize: 12 }}>{v.guestOS}</td>
                    <td><span className={`badge ${v.toolsStatus === 'RUNNING' ? 'green' : 'gray'}`}>{v.toolsStatus === 'RUNNING' ? '가동' : '미실행'}</span></td>
                    <td className="muted" style={{ fontSize: 12 }}>{v.host}</td>
                  </tr>
                ))}</tbody></table>
            </div>
          )}
        </div>
      )}

      <div className="flex gap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <button className="login-btn" style={{ padding: '9px 20px' }} disabled={busy || !vc || !sel.size} onClick={apply}>{busy ? '적용 중…' : `계정 추가 적용 (${sel.size}대)`}</button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>

      {res && (
        <div className="card" style={{ padding: 14 }}>
          <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>결과 — 성공 {res.ok} · 실패 {res.fail}</div>
          <div className="table-wrap" style={{ maxHeight: '44vh' }}>
            <table><thead><tr><th>VM</th><th>결과</th><th>상세</th></tr></thead>
              <tbody>{(res.results || []).map((r) => (
                <tr key={r.vmId}>
                  <td><b>{r.name}</b></td>
                  <td>{r.ok ? <span className="badge green">성공</span> : <span className="badge red">실패</span>}</td>
                  <td style={{ fontSize: 12 }}>{r.ok ? <span className="muted">{(r.stdout || '').split('\n').slice(-1)[0]}</span> : <span className="badge red" style={{ whiteSpace: 'normal' }}>{r.error}</span>}</td>
                </tr>
              ))}</tbody></table>
          </div>
        </div>
      )}
    </div>
  );
}
