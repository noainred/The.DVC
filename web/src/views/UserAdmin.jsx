import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { fetchJson, postJson, patchJson, delJson } from '../api.js';
import { Loading, ErrorBox, Modal } from '../components/ui.jsx';

const ROLES = ['viewer', 'operator', 'admin'];

/** 설정 → 사용자 관리: 계정 CRUD + Google OTP(TOTP) 등록/해제. */
export default function UserAdmin() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ username: '', name: '', role: 'viewer' });
  const [enroll, setEnroll] = useState(null); // { username, secret, otpauthURL, qr, code, error }

  const load = async () => {
    try { setData(await fetchJson('/admin/users')); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 4000); };

  const addUser = async () => {
    const r = await postJson('/admin/users', form).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { setAdding(false); setForm({ username: '', name: '', role: 'viewer' }); await load(); flash(true, '사용자를 추가했습니다. OTP를 등록해 주세요.'); }
    else flash(false, r.reason);
  };

  const changeRole = async (u, role) => {
    const r = await patchJson(`/admin/users/${encodeURIComponent(u.username)}`, { role }).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) await load(); else flash(false, r.reason);
  };

  const remove = async (u) => {
    if (!window.confirm(`'${u.username}' 계정을 삭제할까요?`)) return;
    const r = await delJson(`/admin/users/${encodeURIComponent(u.username)}`).catch((e) => ({ ok: false, reason: e.message }));
    if (r?.ok !== false) await load(); else flash(false, r.reason);
  };

  const startEnroll = async (u) => {
    const r = await postJson(`/admin/users/${encodeURIComponent(u.username)}/totp/begin`, {}).catch((e) => ({ ok: false, reason: e.message }));
    if (!r.ok) return flash(false, r.reason);
    const qr = await QRCode.toDataURL(r.otpauthURL, { width: 200, margin: 1 }).catch(() => null);
    setEnroll({ username: u.username, secret: r.secret, otpauthURL: r.otpauthURL, qr, code: '', error: null });
  };

  const confirmEnroll = async () => {
    const r = await postJson(`/admin/users/${encodeURIComponent(enroll.username)}/totp/confirm`, { code: enroll.code }).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { setEnroll(null); await load(); flash(true, 'OTP 등록 완료 — 이제 이 계정은 OTP로만 로그인합니다.'); }
    else setEnroll((s) => ({ ...s, error: r.reason }));
  };

  const disableTotp = async (u) => {
    if (!window.confirm(`'${u.username}'의 OTP를 해제할까요? (다시 비밀번호/재등록 필요)`)) return;
    const r = await postJson(`/admin/users/${encodeURIComponent(u.username)}/totp/disable`, {}).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { await load(); flash(true, 'OTP를 해제했습니다.'); } else flash(false, r.reason);
  };

  return (
    <>
      <div className="flex between wrap gap" style={{ marginBottom: 10 }}>
        <div className="section-title" style={{ margin: '6px 0' }}>사용자 관리 (관리자)</div>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} onClick={() => setAdding((v) => !v)}>+ 사용자 추가</button>
      </div>

      {msg && (
        <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</div>
      )}

      {adding && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="spec-grid">
            <label>사용자 ID<input className="input" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} placeholder="alice" /></label>
            <label>이름<input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Alice" /></label>
            <label>역할
              <select className="select" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          </div>
          <div className="muted" style={{ fontSize: 12, margin: '8px 0' }}>비밀번호 없이 생성되며, 아래 목록에서 <b>OTP 등록</b> 후 QR을 사용자에게 전달하면 됩니다.</div>
          <div className="flex gap">
            <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!form.username} onClick={addUser}>추가</button>
            <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={() => setAdding(false)}>취소</button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead><tr><th>사용자 ID</th><th>이름</th><th>역할</th><th>로그인 방식</th><th style={{ textAlign: 'right' }}>관리</th></tr></thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.username}>
                <td><b>{u.username}</b></td>
                <td>{u.name}</td>
                <td>
                  <select className="select" value={u.role} onChange={(e) => changeRole(u, e.target.value)} style={{ maxWidth: 130 }}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td>
                  {u.totpEnabled
                    ? <span className="badge green">OTP 전용</span>
                    : <span className="badge amber">{u.hasPassword ? '비밀번호' : '미설정'}</span>}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {u.totpEnabled
                    ? <button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => disableTotp(u)}>OTP 해제</button>
                    : <button className="login-btn" style={{ flex: 'none', padding: '6px 12px' }} onClick={() => startEnroll(u)}>OTP 등록</button>}
                  {' '}
                  <button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => remove(u)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.7 }}>
        Google Authenticator(또는 MS Authenticator/Authy)로 QR을 스캔해 등록합니다.
        등록을 마치면 해당 계정의 비밀번호는 제거되어 <b>OTP 6자리로만</b> 로그인됩니다.
        AD 계정은 AD 비밀번호로 로그인하며 여기서 관리하지 않습니다.
      </div>

      {enroll && (
        <Modal title={`OTP 등록 — ${enroll.username}`} onClose={() => setEnroll(null)} width={420}>
          <div style={{ textAlign: 'center' }}>
            {enroll.qr
              ? <img src={enroll.qr} alt="OTP QR" style={{ width: 200, height: 200, background: '#fff', borderRadius: 8, padding: 6 }} />
              : <div className="muted">QR 생성 실패 — 아래 키를 수동 입력하세요.</div>}
            <div className="muted" style={{ fontSize: 12, margin: '10px 0 4px' }}>수동 입력 키</div>
            <code style={{ fontSize: 13, wordBreak: 'break-all' }}>{enroll.secret}</code>
            <div className="muted" style={{ fontSize: 12, margin: '14px 0 6px' }}>앱에 표시된 6자리 코드를 입력해 확인하세요.</div>
            <input className="input" value={enroll.code} maxLength={6} inputMode="numeric"
              onChange={(e) => setEnroll((s) => ({ ...s, code: e.target.value.replace(/\D/g, ''), error: null }))}
              placeholder="000000" style={{ textAlign: 'center', fontSize: 20, letterSpacing: 4, maxWidth: 180, margin: '0 auto' }} />
            {enroll.error && <div className="login-error" style={{ marginTop: 8 }}>{enroll.error}</div>}
            <div className="flex gap" style={{ justifyContent: 'center', marginTop: 14 }}>
              <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={enroll.code.length < 6} onClick={confirmEnroll}>확인 및 활성화</button>
              <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => setEnroll(null)}>취소</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
