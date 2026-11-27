/**
 * 물리서버 원격 전원 조작 · 위치 LED 켜기 설정(v3.52 · 시안 ⑦ ⑥) — 전체 범위 관리자(서버 게이트와 같은 표지 canFleet). 기본 꺼짐.
 *  · 켜기 · 강제 동작 허용(강제 재시작 · 강제 끄기)을 따로 연다 · 켜기를 끄면 강제 허용도 함께 꺼진다(서버가 정한다).
 *  · 저장 = 본인 OTP(인증이 켜진 포탈) · 감사. 파일을 못 읽으면 저장을 잠근다(서버 409 와 같은 판정을 화면도 따른다).
 *  · 엣지에 배포하지 않는다 — 중앙이 판단해 엣지에 한 건씩 보낸다(엣지는 env 로 따로 막을 수 있다).
 */
import React, { useEffect, useState } from 'react';
import { Modal } from '../../../components/Modal.jsx';
import { fetchJson, putJson } from '../../../api.js';
import { opErrorText } from '../bmFoldersText.js';
import { FORCE_NOTE } from './powerText.js';

export default function RemotePowerSettings({ onClose, initial = null }) {
  const [d, setD] = useState(initial);
  const [err, setErr] = useState('');
  const [f, setF] = useState(initial?.settings ? { enabled: !!initial.settings.enabled, allowForce: !!initial.settings.allowForce, otp: '' } : null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    if (initial) return;
    fetchJson('/admin/bm-power').then((x) => { setD(x); setF({ enabled: !!x.settings?.enabled, allowForce: !!x.settings?.allowForce, otp: '' }); }).catch((e) => setErr(opErrorText(e)));
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const otpOk = !d?.otpRequired || /^\d{6}$/.test(f?.otp || '');
  const changed = !!(d && f && (f.enabled !== !!d.settings?.enabled || (f.enabled && f.allowForce) !== !!d.settings?.allowForce));
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/admin/bm-power', { enabled: f.enabled, allowForce: f.enabled && f.allowForce, otp: f.otp });
      if (!r || r.ok === false) throw new Error(r?.reason || '저장하지 못했습니다.');
      setD({ ...d, settings: r.settings }); setF({ enabled: !!r.settings.enabled, allowForce: !!r.settings.allowForce, otp: '' });
      setMsg({ ok: true, text: r.settings.enabled ? `저장했습니다 — 원격 전원 · LED 켜짐${r.settings.allowForce ? ' · 강제 동작 허용' : ''}.` : '저장했습니다 — 원격 전원 · LED 꺼짐.' });
    } catch (e) { setMsg({ ok: false, text: opErrorText(e) }); setF((x) => ({ ...x, otp: '' })); } finally { setBusy(false); }
  };
  return (
    <Modal title="원격 전원 · 위치 LED 설정" onClose={() => { if (!busy) onClose(); }} width={560}>
      <div className="bmd-al">
        <div className="muted bmd-note">
          켜면 Bare Metal Server 서버 상세에서 전체 범위 관리자가 전원(켜기 · 정상 종료 · 정상 재시작 — 서버 이름 다시 입력 · 사유 · 본인 OTP(인증을 켠 포탈))을, 그 서버 법인의 쓰기 범위가 있는 운영자 이상이 위치 LED 를 다룰 수 있습니다. 모두 감사 로그에 남습니다.
          엣지가 맡은 서버는 그 엣지가 장비에 보냅니다(엣지 쪽에서 따로 막을 수 있습니다).
        </div>
        {err ? <div className="bmd-note" style={{ color: 'var(--red)' }}>설정을 읽지 못했습니다 — {err}</div>
          : !d || !f ? <div className="muted bmd-note">읽는 중…</div>
            : (
              <>
                {d.unreadable ? <div className="bmd-note" style={{ color: 'var(--amber)' }} role="alert">설정 파일을 읽지 못했습니다(서비스 점검에서 확인) — 꺼짐으로 보고 저장이 막힙니다.</div> : null}
                <fieldset className="pfe-fs" disabled={busy}>
                  <label className="pfe-on"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked, allowForce: e.target.checked ? f.allowForce : false })} /> 원격 전원 · 위치 LED 켜기</label>
                  <label className="pfe-on"><input type="checkbox" checked={f.enabled && f.allowForce} disabled={!f.enabled} onChange={(e) => setF({ ...f, allowForce: e.target.checked })} /> 강제 재시작 · 강제 끄기 허용</label>
                  <div className="muted bmd-note">{FORCE_NOTE}</div>
                  {d.otpRequired ? <label className="muted bmd-pw-f">본인 OTP(6자리)<input className="input" inputMode="numeric" autoComplete="one-time-code" value={f.otp} onChange={(e) => setF({ ...f, otp: e.target.value.replace(/\D/g, '').slice(0, 6) })} aria-label="OTP" /></label> : null}
                </fieldset>
                <div className="flex wrap gap" style={{ alignItems: 'center' }}>
                  <button type="button" className="login-btn bmd-btn" disabled={busy || !!d.unreadable || !changed || !otpOk} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
                  <button type="button" className="logout-btn" disabled={busy} onClick={onClose}>닫기</button>
                  {msg ? <span className={msg.ok ? 'muted' : 'pfe-bad'} role={msg.ok ? 'status' : 'alert'} style={{ minWidth: 0 }}>{msg.text}</span> : null}
                  {!msg && changed && !otpOk ? <span className="muted" style={{ fontSize: 12 }}>본인 OTP 6자리를 입력하십시오.</span> : null}
                </div>
              </>
            )}
      </div>
    </Modal>
  );
}
