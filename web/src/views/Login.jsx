import React, { useState } from 'react';
import { login } from '../api.js';

export default function Login({ onSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(username.trim(), password);
      onSuccess(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card card" onSubmit={submit}>
        <div className="brand" style={{ justifyContent: 'center', marginBottom: 6 }}>
          <div className="logo">V</div>
          <div>
            <h1 className="brand-title" style={{ fontSize: 20 }}>The Davinci<br />Virtual Platform</h1>
            <div className="sub">다빈치 프로젝트 분석 플랫폼</div>
          </div>
        </div>
        <div className="login-title">로그인</div>

        <label className="login-field">
          <span>아이디</span>
          <input className="input" autoFocus autoComplete="username" value={username}
            onChange={(e) => setUsername(e.target.value)} placeholder="admin" />
        </label>
        <label className="login-field">
          <span>비밀번호</span>
          <input className="input" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </label>

        {error && <div className="login-error">{error}</div>}

        <button className="login-btn" type="submit" disabled={busy || !username || !password}>
          {busy ? '인증 중…' : '로그인'}
        </button>

        <div className="login-hint muted">
          기본 데모 계정: <code>admin</code> / <code>admin123</code>
        </div>
      </form>
    </div>
  );
}
