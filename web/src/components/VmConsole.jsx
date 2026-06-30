import React, { useState } from 'react';
import { fetchJson } from '../api.js';
import EscClose from './EscClose.jsx';

/**
 * VM remote-console launcher (원격 콘솔), mirroring the vSphere Client:
 *  - LAUNCH REMOTE CONSOLE → VMRC desktop app (vmrc:// URL)
 *  - LAUNCH WEB CONSOLE     → HTML5 web console in a new tab
 * URLs are fetched on demand (one-time clone ticket from vCenter).
 */
export function VmConsoleButton({ vmId, vmName }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={() => setOpen(true)}>🖥️ 원격 콘솔</button>
      {open && <VmConsoleModal vmId={vmId} vmName={vmName} onClose={() => setOpen(false)} />}
    </>
  );
}

function VmConsoleModal({ vmId, vmName, onClose }) {
  const [state, setState] = useState({ loading: true });

  React.useEffect(() => {
    let active = true;
    fetchJson(`/vms/${encodeURIComponent(vmId)}/console`)
      .then((d) => { if (active) setState({ loading: false, data: d }); })
      .catch((e) => { if (active) setState({ loading: false, error: e.message }); });
    return () => { active = false; };
  }, [vmId]);

  const { loading, data, error } = state;

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal card" style={{ maxWidth: 460 }}>
        <div className="flex between" style={{ marginBottom: 14 }}>
          <b style={{ fontSize: 15 }}>🖥️ 원격 콘솔 — {vmName}</b>
          <button className="logout-btn" onClick={onClose}>닫기</button>
        </div>

        {loading && <div className="muted" style={{ padding: 20, textAlign: 'center' }}>콘솔 티켓 발급 중…</div>}
        {error && <div className="error-box" style={{ marginBottom: 12 }}>콘솔 준비 실패: {error}</div>}
        {data?.mock && <div className="card" style={{ borderColor: 'var(--amber)', marginBottom: 12, fontSize: 13 }}>{data.reason}</div>}

        {data && !data.mock && data.missing?.length > 0 && (
          <div className="card" style={{ borderColor: 'var(--red)', marginBottom: 12, fontSize: 12, lineHeight: 1.6 }}>
            ⚠ 누락된 콘솔 파라미터: <b style={{ color: 'var(--red)' }}>{data.missing.join(', ')}</b>
            <div className="muted" style={{ marginTop: 4 }}>
              {data.missing.includes('thumbprint') && '· thumbprint 없음: 포탈 서버가 vCenter:443 인증서를 읽지 못했습니다(방화벽/네트워크 확인). '}
              {data.missing.includes('sessionTicket') && '· 티켓 발급 실패(권한 확인). '}
            </div>
          </div>
        )}

        {data && !data.mock && (
          <div className="muted" style={{ fontSize: 11, marginBottom: 10, lineHeight: 1.7 }}>
            host <b style={{ color: 'var(--text)' }}>{data.host}</b> · serverGuid {data.serverGuid ? '✓' : '✗'} · 티켓 {data.ticketIssued ? '✓' : '✗'} · thumbprint {data.thumbprint ? '✓' : '✗'}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button className="logout-btn" style={{ padding: '12px', fontWeight: 700, opacity: data?.vmrcUrl ? 1 : 0.5 }}
            disabled={!data?.vmrcUrl}
            onClick={() => { if (data?.vmrcUrl) window.location.href = data.vmrcUrl; }}>
            LAUNCH REMOTE CONSOLE
            <div className="muted" style={{ fontSize: 11, fontWeight: 400, marginTop: 2 }}>VMware Remote Console (VMRC) 앱 필요</div>
          </button>
          <button className="login-btn" style={{ flex: 'none', padding: '12px', fontWeight: 700, opacity: data?.webConsoleUrl ? 1 : 0.5 }}
            disabled={!data?.webConsoleUrl}
            onClick={() => { if (data?.webConsoleUrl) window.open(data.webConsoleUrl, '_blank', 'noopener'); }}>
            LAUNCH WEB CONSOLE
            <div style={{ fontSize: 11, fontWeight: 400, marginTop: 2, opacity: 0.85 }}>브라우저 HTML5 콘솔 (새 탭)</div>
          </button>
        </div>

        {data?.webConsoleUrl && (
          <button className="tab" style={{ marginTop: 10 }} onClick={() => navigator.clipboard?.writeText(data.webConsoleUrl)}>웹 콘솔 URL 복사</button>
        )}

        <div className="muted" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.7 }}>
          <b>필요 포트(사용자 PC 기준)</b><br />
          · 브라우저/VMRC → vCenter: <b>TCP 443</b><br />
          · 웹 콘솔(WebMKS) → 해당 ESXi 호스트: <b>TCP 443</b><br />
          · VMRC 앱 → 해당 ESXi 호스트: <b>TCP 902</b> (MKS) + 443<br />
          접속은 포탈이 아니라 <b>사용자 PC ↔ vCenter/ESXi</b>로 직접 연결됩니다. 자체서명 인증서는 경고를 수락해야 합니다.
        </div>
      </div>
    </div>
  );
}
