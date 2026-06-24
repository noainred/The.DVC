import React, { useState } from 'react';
import { login } from '../api.js';

export default function Login({ onSuccess, notice }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fails, setFails] = useState(0);
  const [warn, setWarn] = useState(false); // 3회 실패 경고창

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(username.trim(), password);
      setFails(0);
      onSuccess(user);
    } catch (err) {
      setError(err.message);
      setFails((n) => {
        const c = n + 1;
        if (c >= 3) setWarn(true); // 3회 연속 실패 → 법적 경고
        return c;
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      {warn && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setWarn(false); }}>
          <div className="modal card" style={{ maxWidth: 460, border: '1px solid var(--red,#ef4444)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 22 }}>⚠️</span>
              <b style={{ fontSize: 16, color: 'var(--red,#ef4444)' }}>접근 경고</b>
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.7 }}>
              로그인이 <b>{fails}회</b> 실패했습니다.<br />
              <b>인가되지 않은 접근은 법적인 책임이 있습니다.</b><br />
              접속하신 <b>IP</b> 와 <b>SSO 계정</b>은 기록됩니다.
            </div>
            <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} onClick={() => setWarn(false)}>확인</button>
            </div>
          </div>
        </div>
      )}
      <form className="login-card card" onSubmit={submit}>
        <div className="brand" style={{ justifyContent: 'center', marginBottom: 6 }}>
          <div className="logo">V</div>
          <div>
            <h1 className="brand-title" style={{ fontSize: 20 }}>The Davinci<br />Virtual Platform</h1>
            <div className="sub">다빈치 프로젝트 분석 플랫폼</div>
          </div>
        </div>
        <div className="login-title">로그인</div>

        {notice && <div className="login-hint" style={{ color: 'var(--amber,#f59e0b)', textAlign: 'center', marginBottom: 8 }}>{notice}</div>}

        <label className="login-field">
          <span>아이디</span>
          <input className="input" autoFocus autoComplete="username" value={username}
            onChange={(e) => setUsername(e.target.value)} placeholder="admin" />
        </label>
        <label className="login-field">
          <span>비밀번호 또는 OTP 코드</span>
          <input className="input" type="password" autoComplete="one-time-code" value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="비밀번호 또는 6자리 OTP" />
        </label>

        {error && <div className="login-error">{error}</div>}

        <button className="login-btn" type="submit" disabled={busy || !username || !password}>
          {busy ? '인증 중…' : '로그인'}
        </button>

        <div className="login-hint muted">
          OTP를 등록한 계정은 <b>Google OTP 6자리 코드</b>로 로그인합니다.
        </div>
      </form>
    </div>
  );
}
