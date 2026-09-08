import React, { useEffect, useRef, useState } from 'react';
import { getToken, setToken, postJson } from '../api.js';

/**
 * 세션 만료 경고 + 연장(v2.428).
 *
 * 토큰 수명(기본 8시간)이 끝나면 작업 중이어도 예고 없이 로그아웃된다. 만료 N분 전에
 * "계속 사용 중이신가요?"를 띄우고, [접속 중입니다]를 누르면 서버가 만료를 M분 미룬 새 토큰을 준다.
 *
 * 설계 메모:
 *  - 만료 시각은 **토큰 자체(JWT exp)** 에서 읽는다. 별도 상태를 두면 연장·재로그인·다른 탭
 *    로그인과 어긋난다. JWT 페이로드는 서명된 값이라 클라이언트가 고쳐도 서버가 거부한다
 *    (여기서 읽는 건 '언제 물어볼지'를 정하기 위한 표시용일 뿐).
 *  - 1초 틱으로 남은 시간을 다시 계산한다. setTimeout 한 번으로 잡으면 **노트북 절전/탭 정지**
 *    구간에서 타이머가 밀려 경고를 건너뛰고 그대로 만료된다(실측되는 흔한 실패).
 *  - 유휴 자동 로그아웃(App.jsx)과는 **별개 축**이다. 저쪽은 '입력이 없으면', 이쪽은 '세션 수명이
 *    다 되면'. 둘 다 켜져 있어도 서로 간섭하지 않는다.
 */

/** JWT payload 의 exp(ms). 실패하면 null — 호출부가 '만료 개념 없음'으로 다룬다. */
export function tokenExpiresAt(token) {
  try {
    const p = String(token || '').split('.')[1];
    if (!p) return null;
    const json = JSON.parse(decodeURIComponent(escape(atob(p.replace(/-/g, '+').replace(/_/g, '/')))));
    return json?.exp ? json.exp * 1000 : null;
  } catch { return null; }
}

const fmtLeft = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}분 ${String(s % 60).padStart(2, '0')}초` : `${s}초`;
};

export default function SessionExpiryGuard({ cfg, onExpire }) {
  const [leftMs, setLeftMs] = useState(null); // null = 경고 창 밖(모달 숨김)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const firedRef = useRef(false); // 만료 처리 1회만

  const enabled = !!cfg?.authEnabled && cfg?.sessionWarnEnabled !== false;
  const warnMs = Math.max(1, Number(cfg?.sessionWarnMin) || 10) * 60_000;
  const extendMin = Math.max(1, Number(cfg?.sessionExtendMin) || 60);

  useEffect(() => {
    if (!enabled) return undefined;
    const tick = () => {
      const exp = tokenExpiresAt(getToken());
      if (!exp) { setLeftMs(null); return; }
      const left = exp - Date.now();
      if (left <= 0) {
        // 만료 — 서버가 이미 거부하지만, 화면을 그대로 두면 사용자가 '멈춘 화면'을 본다.
        if (!firedRef.current) { firedRef.current = true; setLeftMs(null); onExpire?.(); }
        return;
      }
      firedRef.current = false;
      setLeftMs(left <= warnMs ? left : null);
    };
    tick();
    const t = setInterval(tick, 1000); // 절전 복귀 후에도 남은 시간을 다시 계산한다
    return () => clearInterval(t);
  }, [enabled, warnMs, onExpire]);

  if (!enabled || leftMs == null) return null;

  const extend = async () => {
    setBusy(true); setErr('');
    try {
      const r = await postJson('/auth/extend', {});
      if (r?.token) {
        // 기존 저장 방식(로컬/세션)을 유지해야 '이 탭만 로그인' 선택이 뒤집히지 않는다.
        setToken(r.token, { persist: !!localStorage.getItem('vmportal.token') });
        setLeftMs(null);
        if (r.capped) setErr(''); // 상한까지만 연장된 경우도 성공 — 남은 시간은 다음 틱에 반영된다
      } else {
        setErr(r?.reason || '연장하지 못했습니다.');
      }
    } catch (e) {
      setErr(e?.message || '연장 요청이 실패했습니다.');
    } finally { setBusy(false); }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(2,6,23,.62)', backdropFilter: 'blur(2px)',
    }}>
      <div className="card" style={{ padding: 24, maxWidth: 460, width: 'calc(100% - 40px)', textAlign: 'center', borderColor: 'var(--amber,#f59e0b)' }}>
        <div style={{ fontSize: 38 }}>⏳</div>
        <div style={{ fontSize: 17, fontWeight: 800, margin: '10px 0 6px' }}>계속 사용 중이신가요?</div>
        <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.7 }}>
          접속 시간이 만료되어 <b style={{ color: 'var(--amber,#f59e0b)' }}>{fmtLeft(leftMs)}</b> 후 자동으로 로그아웃됩니다.<br />
          계속 사용하시려면 아래 버튼을 눌러 <b>{extendMin}분</b> 연장하세요.
        </div>
        {err && <div className="error-box" style={{ padding: 10, marginTop: 12, fontSize: 13 }}>{err}</div>}
        <button className="login-btn" style={{ flex: 'none', padding: '12px 28px', marginTop: 16, fontSize: 15 }}
          disabled={busy} onClick={extend}>
          {busy ? '연장 중…' : '✅ 접속 중입니다 — 연장'}
        </button>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          연장하지 않으면 저장하지 않은 작업이 사라질 수 있습니다.
        </div>
      </div>
    </div>
  );
}
