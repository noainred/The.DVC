import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { postJson } from '../api.js';

/**
 * 강제 OTP 등록 화면 — admin/operator 가 OTP 미등록 상태로(비밀번호로) 로그인하면 이 화면에
 * 고정된다. 서버도 `requireEnrolled` 로 등록 외 모든 API 를 차단하므로 우회할 수 없다.
 * 등록을 확정하면 서버가 **비밀번호를 삭제**하고 토큰을 폐기하므로, 이후에는 OTP 로만 로그인한다.
 */
export default function ForceOtpEnroll({ user, onExit }) {
  const [data, setData] = useState(null);   // { secret, otpauthURL, qr }
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await postJson('/auth/totp/begin', {});
        if (!r.ok) throw new Error(r.reason || 'OTP 등록을 시작하지 못했습니다.');
        const qr = await QRCode.toDataURL(r.otpauthURL, { width: 210, margin: 1 }).catch(() => null);
        if (alive) setData({ ...r, qr });
      } catch (e) { if (alive) setError(e.message); }
    })();
    return () => { alive = false; };
  }, []);

  const confirm = async (e) => {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await postJson('/auth/totp/confirm', { code });
      if (!r.ok) throw new Error(r.reason || 'OTP 코드가 일치하지 않습니다.');
      setDone(true); // 이 시점에 서버가 비밀번호 삭제 + 토큰 폐기 → 반드시 재로그인
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="login-screen">
      <div className="card" style={{ maxWidth: 470, width: '100%', padding: 28 }}>
        <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 6 }}>🔐 OTP 등록이 필요합니다</div>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.8, marginBottom: 18 }}>
          <b>{user?.name || user?.username}</b>({user?.role}) 계정은 <b>OTP 전용</b>입니다.
          지금 인증 앱에 등록해야 포탈을 사용할 수 있습니다. 등록을 마치면 <b>비밀번호는 삭제되고</b>,
          이후에는 6자리 코드로만 로그인합니다.
        </div>

        {done ? (
          <>
            <div style={{ padding: '14px 16px', borderRadius: 8, background: 'rgba(34,197,94,.12)', color: '#4ade80', fontSize: 14, lineHeight: 1.7 }}>
              ✅ OTP 등록이 완료되었습니다.<br />
              비밀번호가 삭제되었으니 이제 <b>인증 앱의 6자리 코드</b>로 다시 로그인하세요.
            </div>
            <button className="login-btn" style={{ width: '100%', marginTop: 18, padding: 12 }} onClick={() => onExit(true)}>
              로그인 화면으로
            </button>
          </>
        ) : !data ? (
          <div className="muted" style={{ padding: 20, textAlign: 'center' }}>{error || '등록 정보를 준비하는 중…'}</div>
        ) : (
          <form onSubmit={confirm}>
            <div style={{ textAlign: 'center' }}>
              {data.qr
                ? <img src={data.qr} alt="OTP QR" style={{ width: 210, height: 210, background: '#fff', borderRadius: 8, padding: 6 }} />
                : <div className="muted">QR 생성 실패 — 아래 키를 수동 입력하세요.</div>}
            </div>
            <div className="muted" style={{ fontSize: 12, margin: '12px 0 4px' }}>수동 입력 키(설정 키)</div>
            <code style={{ fontSize: 13, wordBreak: 'break-all', display: 'block' }}>{data.secret}</code>

            <div className="muted" style={{ fontSize: 12, margin: '16px 0 6px' }}>
              Google Authenticator(또는 MS Authenticator/Authy)로 QR을 스캔한 뒤, 표시된 6자리 코드를 입력하세요.
            </div>
            <input className="input" value={code} maxLength={6} inputMode="numeric" autoFocus
              onChange={(ev) => { setCode(ev.target.value.replace(/\D/g, '')); setError(null); }}
              placeholder="000000"
              style={{ textAlign: 'center', fontSize: 22, letterSpacing: 6, width: '100%', boxSizing: 'border-box' }} />
            {error && <div className="login-error" style={{ marginTop: 10 }}>{error}</div>}
            <button className="login-btn" type="submit" style={{ width: '100%', marginTop: 16, padding: 12 }}
              disabled={busy || code.length < 6}>
              {busy ? '확인 중…' : '등록 완료'}
            </button>
            <button type="button" className="logout-btn" style={{ width: '100%', marginTop: 10, padding: 10 }} onClick={() => onExit(false)}>
              로그아웃
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
