import React, { useState, useEffect } from 'react';
import { login, getToken } from '../api.js';
import { THEMES, THEMES_CSS } from './loginThemes.jsx';

// 브라우저에 남아있는 SSO 토큰(JWT)의 payload를 디코드해 표시 이름을 추출(서명검증 아님 — 인사말 표시용).
function nameFromToken() {
  try {
    const t = getToken(); if (!t) return '';
    const p = JSON.parse(decodeURIComponent(escape(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))));
    return p?.name || p?.username || p?.sub || '';
  } catch { return ''; }
}

/**
 * 로그인 화면 — 테마(loginThemes.jsx) 중 하나가 접속(마운트)할 때마다 자동으로
 * 랜덤 표시된다(재미 요소). 우하단 🎲 버튼으로 다른 테마를 바로 뽑아볼 수도 있다.
 * 인증 로직/상태는 여기서 소유하고, 테마는 폼 바인딩(f)만 받아 시각만 담당한다.
 */
export default function Login({ onSuccess, notice, setup }) {
  const [welcome] = useState(nameFromToken);
  // 초기 구축 안내 — 아직 OTP 를 등록한 admin 이 없고 최초 비밀번호 파일이 남아 있으면
  // '서버 어디에 비번이 저장돼 있는지' 팝업으로 알려준다(경로만, 값은 절대 내려받지 않음).
  const [setupPopup, setSetupPopup] = useState(false);
  useEffect(() => { if (setup?.setupPending && setup?.initialPasswordFile) setSetupPopup(true); },
    [setup?.setupPending, setup?.initialPasswordFile]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [keep, setKeep] = useState(true);
  const [forgotInfo, setForgotInfo] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fails, setFails] = useState(0);
  const [warn, setWarn] = useState(false); // 3회 실패 경고창
  // 마운트 시 1회 자동 랜덤 선택(입력 중 리렌더로 테마가 바뀌지 않게 state 로 고정).
  const [themeIdx, setThemeIdx] = useState(() => Math.floor(Math.random() * THEMES.length));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(username.trim(), password, { keep });
      setFails(0);
      onSuccess(user);
    } catch (err) {
      setError(err.message);
      // updater 안에서 setWarn을 호출하지 않는다(React updater는 순수해야 하며 StrictMode에서
      // 이중 호출됨). 다음 실패 횟수를 밖에서 계산해 상태를 갱신한다.
      const c = fails + 1;
      setFails(c);
      if (c >= 3) setWarn(true); // 3회 연속 실패 → 법적 경고
    } finally {
      setBusy(false);
    }
  };

  // 테마에 넘길 폼 바인딩(시각 컴포넌트는 이 객체만 사용).
  const f = {
    username, setUsername, password, setPassword, showPw, setShowPw, keep, setKeep,
    forgotInfo, toggleForgot: () => setForgotInfo((v) => !v),
    error, busy, submit, welcome, notice,
  };

  const { Comp, name } = THEMES[themeIdx];
  const reshuffle = () => setThemeIdx((i) => (THEMES.length <= 1 ? i : (i + 1 + Math.floor(Math.random() * (THEMES.length - 1))) % THEMES.length));

  return (
    <>
      <style>{THEMES_CSS}</style>
      <Comp f={f} />

      <button type="button" className="lt-reshuffle" onClick={reshuffle}
        title={`현재 테마: ${name} — 클릭하면 다른 로그인 화면으로 바뀝니다`}>
        🎲 {name}
      </button>

      {setupPopup && (
        <div className="modal-overlay" style={{ zIndex: 49 }} onClick={(e) => { if (e.target === e.currentTarget) setSetupPopup(false); }}>
          <div className="modal card" style={{ maxWidth: 560, border: '1px solid var(--accent,#3b82f6)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 22 }}>🔑</span>
              <b style={{ fontSize: 16 }}>최초 설치 — 관리자 비밀번호 위치 안내</b>
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.8 }}>
              아직 OTP를 등록한 관리자가 없습니다. 최초 관리자(<b>admin</b>) 비밀번호는 설치 시
              <b> 임의 생성</b>되어 서버의 아래 파일에 저장되어 있습니다:
              <div style={{ margin: '12px 0', padding: '10px 12px', borderRadius: 6, background: 'rgba(148,163,184,.12)' }}>
                <code style={{ fontSize: 13, wordBreak: 'break-all' }}>{setup.initialPasswordFile}</code>
              </div>
              서버에서 다음 명령으로 확인하세요:
              <div style={{ margin: '8px 0 12px', padding: '10px 12px', borderRadius: 6, background: 'rgba(148,163,184,.12)' }}>
                <code style={{ fontSize: 13, wordBreak: 'break-all' }}>sudo cat {setup.initialPasswordFile}</code>
              </div>
              이 비밀번호로 로그인하면 <b>OTP 등록 화면</b>으로 이동하며, 등록을 마치면
              <b> 비밀번호는 자동으로 삭제</b>되고 이후에는 OTP 6자리로만 로그인합니다
              (이 파일도 함께 삭제됩니다).
            </div>
            <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} onClick={() => setSetupPopup(false)}>확인</button>
            </div>
          </div>
        </div>
      )}

      {warn && (
        <div className="modal-overlay" style={{ zIndex: 50 }} onClick={(e) => { if (e.target === e.currentTarget) setWarn(false); }}>
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
    </>
  );
}
