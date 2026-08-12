import React, { useEffect, useState } from 'react';
import { fetchJson, putJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

/**
 * 설정 → 세션 보안 — 유휴 자동 로그아웃 시간 설정. 변경 시 본인 OTP 재인증이 필요하며,
 * 누가 언제 바꿨는지 감사 로그(설정 › 감사 로그)에 기록된다.
 */
export default function SessionSecurity() {
  const [s, setS] = useState(null);
  const [otp, setOtp] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = () => fetchJson('/admin/security/session').then((r) => { setS({ ...r, settingsOwners: (r.settingsOwners || []).join(', ') }); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (err) return <ErrorBox message={err} />;
  if (!s) return <Loading />;

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const owners = String(s.settingsOwners || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
      const r = await putJson('/admin/security/session', { idleLogoutEnabled: s.idleLogoutEnabled, idleLogoutMin: Number(s.idleLogoutMin) || 30, settingsOwners: owners, loginPolicy: s.loginPolicy || undefined, singleSession: !!s.singleSession, otp: otp.trim() });
      if (r && r.ok === false) { setMsg(`오류: ${r.reason || '저장 실패'}`); }
      else { const ns = r.settings || s; setS({ ...ns, settingsOwners: (ns.settingsOwners || []).join(', ') }); setOtp(''); setMsg('저장되었습니다. 변경 내역은 감사 로그에 기록됩니다.'); }
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🔒 세션 보안</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        로그인 후 지정한 시간 동안 입력(마우스·키보드·클릭)이 없으면 자동 로그아웃합니다.
        이 설정 변경에는 <b>본인 OTP 재인증</b>이 필요하며, 변경 내역(누가·이전→이후)은 <b>설정 › 감사 로그</b>에 남습니다.
      </p>

      <div className="card" style={{ padding: 16 }}>
        <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer', marginBottom: 12 }}>
          <input type="checkbox" checked={s.idleLogoutEnabled} onChange={(e) => setS({ ...s, idleLogoutEnabled: e.target.checked })} /> <b>유휴 자동 로그아웃 사용</b>
        </label>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 12 }}>
          <span className="muted">유휴 시간</span>
          <input className="input" type="number" min={1} max={1440} style={{ width: 100 }} disabled={!s.idleLogoutEnabled}
            value={s.idleLogoutMin} onChange={(e) => setS({ ...s, idleLogoutMin: e.target.value })} />
          <span className="muted">분 (1~1440)</span>
        </div>

        <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', marginTop: 16, paddingTop: 14 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}><b>설정 메뉴 접근 계정</b> — 이 계정으로 로그인했을 때만 '설정'이 보입니다(쉼표/공백 구분, 최소 1개).</div>
          <input className="input" style={{ width: '100%', maxWidth: 480 }} placeholder="noainred, admin" value={s.settingsOwners || ''}
            onChange={(e) => setS({ ...s, settingsOwners: e.target.value })} />
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>⚠ 본인 계정을 빼면 다음부터 설정에 못 들어올 수 있으니 주의하세요.</div>
          {(s.autoOwners || []).length > 0 && (
            <div className="muted" style={{ fontSize: 11, marginTop: 6, color: 'var(--accent-2,#22d3ee)' }}>
              ＋ 자동 포함(중앙 배포 admin): <b>{(s.autoOwners || []).join(', ')}</b> — 중앙에서 이 엣지로 배포한 관리자 계정은 설정에 접근할 수 있습니다(여기서 지우지 않아도 됨. 중앙에서 제거하면 자동 해제).
            </div>
          )}
        </div>

        <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', marginTop: 16, paddingTop: 14 }}>
          <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer', marginBottom: 6 }}>
            <input type="checkbox" checked={!!s.singleSession} onChange={(e) => setS({ ...s, singleSession: e.target.checked })} />
            <b>단일 세션만 허용 (ID 공유 방지)</b>
          </label>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
            켜면 한 계정으로 <b>동시에 한 곳에서만</b> 로그인할 수 있습니다. 같은 계정으로 다른 기기에서
            새로 로그인하면 <b>이전 로그인은 자동으로 로그아웃</b>됩니다(최신 로그인 우선). 로컬·AD 계정 모두 적용됩니다.
            <div style={{ marginTop: 4 }}>⚠ 이 옵션을 <b>처음 켜는 순간</b> 현재 접속 중인 모든 세션은 한 번 재로그인이 필요합니다(세션 확립).</div>
          </div>
        </div>

        <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', marginTop: 16, paddingTop: 14 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}><b>로그인 방식</b> — 로컬 계정(비밀번호/OTP)에 적용됩니다. AD 계정은 AD 인증을 따르며 이 설정의 영향을 받지 않습니다.</div>
          {(() => {
            const OPTS = [
              { v: 'otp_only', label: 'OTP 전용', desc: '모든 로컬 계정이 OTP 6자리로만 로그인합니다(미등록 계정은 최초 로그인 후 OTP 등록을 강제하고, 등록을 마치면 비밀번호는 삭제됩니다). 가장 안전합니다.' },
              { v: 'otp_or_password', label: 'OTP + 비밀번호 (혼용)', desc: '계정마다 비밀번호 또는 OTP 중 하나로 로그인합니다. admin·operator 도 비밀번호 로그인이 허용됩니다(OTP 강제 없음).' },
              { v: 'password_only', label: '비밀번호 전용', desc: '비밀번호로만 로그인합니다. admin·operator 를 포함한 전 계정에서 OTP 2차 방어가 사라집니다.', warn: true },
            ];
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {OPTS.map((o) => (
                  <label key={o.v} className="card" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', cursor: 'pointer', borderColor: s.loginPolicy === o.v ? (o.warn ? 'var(--red,#ef4444)' : 'var(--accent,#3b82f6)') : undefined }}>
                    <input type="radio" name="loginPolicy" style={{ marginTop: 3 }} checked={s.loginPolicy === o.v} onChange={() => setS({ ...s, loginPolicy: o.v })} />
                    <span>
                      <b>{o.label}</b>{o.warn && <span style={{ color: 'var(--red,#ef4444)', marginLeft: 6, fontSize: 12 }}>⚠ 권장하지 않음</span>}
                      <div className="muted" style={{ fontSize: 12, marginTop: 3, lineHeight: 1.6 }}>{o.desc}</div>
                    </span>
                  </label>
                ))}
                {!s.loginPolicy && <div className="muted" style={{ fontSize: 11 }}>현재: <b>기본</b> — admin·operator 는 OTP 전용, 그 외(viewer)는 혼용입니다. 위에서 하나를 골라 저장하면 전 계정에 그 정책이 적용됩니다.</div>}
                {(s.loginPolicy === 'password_only' || s.loginPolicy === 'otp_or_password') && (
                  <div className="muted" style={{ fontSize: 11, color: 'var(--red,#ef4444)', lineHeight: 1.6 }}>
                    ⚠ 이 선택은 admin·operator 의 <b>OTP 전용 강제</b>(감사 하드닝)를 해제합니다 — 고권한 계정도 비밀번호로 로그인하게 되어 계정 탈취 위험이 커집니다. 꼭 필요한 경우에만 사용하고, 가능하면 <b>OTP 전용</b>을 유지하세요.
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', marginTop: 16, paddingTop: 14 }}>
          <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10 }}>
            <span className="muted">변경 확인 — <b>OTP 6자리</b></span>
            <input className="input" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" maxLength={6} style={{ width: 120, letterSpacing: 3 }}
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy || otp.length !== 6} onClick={save}>{busy ? '저장 중…' : '저장(OTP 확인)'}</button>
            {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>※ OTP가 등록되지 않은 계정은 먼저 <b>설정 › 사용자 관리</b>에서 OTP를 등록해야 변경할 수 있습니다.</div>
        </div>
      </div>
    </div>
  );
}
