// ShutdownTool.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { Modal } from '../../components/ui.jsx';


/** 긴급중단 — 모든 수집을 즉시 정지. 관리자 2명이 각자 OTP로 인증해야(2인 승인) 실행/해제된다. */
export function Shutdown() {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(null); // 'stop' | 'resume' | null
  const load = () => fetchJson('/admin/emergency-stop').then(setStatus).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, []);
  const active = !!status?.active;
  return (
    <>
      <div className="card" style={{ borderColor: active ? 'var(--red)' : 'var(--accent)', padding: 28 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 44 }}>{active ? '🛑' : '🟢'}</div>
          <div style={{ fontSize: 18, fontWeight: 800, margin: '10px 0', color: active ? 'var(--red)' : 'var(--green)' }}>
            {active ? '긴급중단 상태 — 모든 수집 정지됨' : '정상 — 수집 동작 중'}
          </div>
          {active && status?.by?.length === 2 && (
            <div className="muted" style={{ fontSize: 13 }}>승인: <b>{status.by[0]}</b> + <b>{status.by[1]}</b>{status.at ? ` · ${new Date(status.at).toLocaleString('ko-KR')}` : ''}</div>
          )}
          <div className="muted" style={{ fontSize: 13, margin: '14px auto 18px', maxWidth: 600, lineHeight: 1.7 }}>
            이 기능은 법인의 <b>온도 상승·재난·PM</b> 등의 이유로 긴급하게 법인의 모든 장비를 Shutdown 해야 하는 경우, <b>사전에 정의된 정책과 절차에 따라 모든 장비를 shutdown</b> 하는 작업을 수행합니다.
            <br />매우 중요하고 위험한 작업으로 <b>2인 이상의 관리자 동의</b>가 필요합니다(관리자 2명이 각각 OTP로 인증).
          </div>
          {!active ? (
            <button className="login-btn" style={{ flex: 'none', padding: '12px 28px', background: 'var(--red)', borderColor: 'var(--red)' }} onClick={() => setOpen('stop')}>
              🛑 긴급중단 실행 (관리자 2명 OTP)
            </button>
          ) : (
            <button className="login-btn" style={{ flex: 'none', padding: '12px 28px' }} onClick={() => setOpen('resume')}>
              ▶ 긴급중단 해제 (관리자 2명 OTP)
            </button>
          )}
        </div>
      </div>
      {open && <DualOtpModal action={open} onClose={() => setOpen(null)} onDone={(s) => { setStatus(s); setOpen(null); }} />}
    </>
  );
}

/** 2인 승인 모달 — 관리자 2명의 로그인 창을 동시에 띄워 각자 ID+OTP로 인증. */
function DualOtpModal({ action, onClose, onDone }) {
  const [a, setA] = useState({ username: '', code: '' });
  const [b, setB] = useState({ username: '', code: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const stop = action === 'stop';
  const ready = a.username.trim() && b.username.trim() && /^\d{6}$/.test(a.code.trim()) && /^\d{6}$/.test(b.code.trim())
    && a.username.trim().toLowerCase() !== b.username.trim().toLowerCase();
  const submit = async () => {
    setBusy(true); setErr(null);
    const r = await postJson('/admin/emergency-stop', {
      action,
      approvals: [{ username: a.username.trim(), code: a.code.trim() }, { username: b.username.trim(), code: b.code.trim() }],
    }).catch((e) => ({ ok: false, reason: e.message }));
    setBusy(false);
    if (r.ok) onDone(r); else setErr(r.reason || '인증 실패');
  };
  const panel = (label, v, setV) => (
    <div className="card" style={{ padding: 16, flex: 1, minWidth: 220, borderColor: 'var(--accent)' }}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>🔐 {label}</div>
      <label className="muted" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>관리자 ID</label>
      <input className="input" autoComplete="off" value={v.username} placeholder="admin 계정" onChange={(e) => setV({ ...v, username: e.target.value })} />
      <label className="muted" style={{ fontSize: 12, display: 'block', margin: '10px 0 4px' }}>OTP 코드(6자리)</label>
      <input className="input" inputMode="numeric" maxLength={6} autoComplete="off" value={v.code}
        placeholder="000000" style={{ letterSpacing: 4, fontFamily: 'monospace', fontSize: 18 }}
        onChange={(e) => setV({ ...v, code: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
    </div>
  );
  return (
    <Modal title={stop ? '🛑 긴급중단 — 2인 승인' : '▶ 긴급중단 해제 — 2인 승인'} onClose={onClose} width={640}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
        서로 다른 <b>관리자 2명</b>이 각자 ID와 <b>OTP 코드</b>를 입력해야 {stop ? '긴급중단이 실행' : '긴급중단이 해제'}됩니다. (둘 다 admin 권한 · OTP 등록 필수)
      </div>
      <div className="flex gap wrap" style={{ alignItems: 'stretch' }}>
        {panel('관리자 ①', a, setA)}
        {panel('관리자 ②', b, setB)}
      </div>
      {err && <div className="badge red" style={{ display: 'block', marginTop: 14, padding: '8px 12px', fontSize: 13 }}>⚠ {err}</div>}
      <div className="flex gap" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
        <button className="logout-btn" style={{ padding: '9px 16px' }} onClick={onClose}>취소</button>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 22px', ...(stop ? { background: 'var(--red)', borderColor: 'var(--red)' } : {}) }}
          disabled={!ready || busy} onClick={submit}>{busy ? '인증 중…' : (stop ? '🛑 긴급중단 실행' : '▶ 해제')}</button>
      </div>
    </Modal>
  );
}
