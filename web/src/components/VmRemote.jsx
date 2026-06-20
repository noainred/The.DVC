import React, { useState } from 'react';
import { postJson, getToken } from '../api.js';
import { Modal } from './ui.jsx';
import { SshTerminal, RdpConsole } from '../views/RemoteAccess.jsx';

/**
 * VM 상세에서 HAProxy 경유 원격 접속을 시작하는 버튼.
 * 프로토콜(SSH/RDP)·IP(다중 IP 선택)·포트를 고른 뒤 매핑을 만들고(또는 재사용)
 * 브라우저 SSH 터미널 / RDP 웹 콘솔(없으면 .rdp 다운로드)을 띄운다.
 */
export function VmRemoteButton({ item }) {
  const ips = item.ipAddresses?.length ? item.ipAddresses : (item.ipAddress ? [item.ipAddress] : []);
  const [open, setOpen] = useState(false);
  const [protocol, setProtocol] = useState('ssh');
  const [ip, setIp] = useState(ips[0] || '');
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null); // { kind:'ssh'|'rdp', mapping }

  const noIp = ips.length === 0;
  const connect = async () => {
    setBusy(true); setError(null);
    try {
      const r = await postJson('/remote/quick-connect', {
        protocol, targetHost: ip, targetPort: port || undefined, name: item.name, vcenterId: item.vcenterId,
      });
      if (!r.ok) throw new Error(r.reason || '매핑 생성 실패');
      if (protocol === 'rdp' && !r.guacdConfigured) {
        // no guacd → download .rdp pointing at proxy:publicPort
        const res = await fetch(`/api/remote/rdp/${r.mapping.id}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
        const blob = await res.blob(); const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `${item.name}.rdp`; a.click(); URL.revokeObjectURL(url);
        setOpen(false);
      } else {
        setSession({ kind: protocol, mapping: r.mapping });
        setOpen(false);
      }
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  return (
    <>
      <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={() => { setError(null); setOpen(true); }} title="HAProxy 경유 SSH/RDP">
        🔗 원격 접속
      </button>

      {open && (
        <Modal title={`원격 접속 — ${item.name}`} onClose={() => setOpen(false)} width={460}>
          {noIp ? (
            <div className="muted">이 VM에 수집된 IP가 없어 접속할 수 없습니다.</div>
          ) : (
            <div className="spec-grid">
              <label>프로토콜
                <select className="select" value={protocol} onChange={(e) => { setProtocol(e.target.value); setPort(''); }}>
                  <option value="ssh">SSH</option>
                  <option value="rdp">RDP</option>
                </select>
              </label>
              <label>대상 IP{ips.length > 1 ? ` (${ips.length})` : ''}
                <select className="select" value={ip} onChange={(e) => setIp(e.target.value)}>
                  {ips.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </label>
              <label>포트(비우면 기본 {protocol === 'rdp' ? '3389' : '22'})
                <input className="input" type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder={protocol === 'rdp' ? '3389' : '22'} />
              </label>
              <div style={{ gridColumn: '1 / -1' }}>
                {error && <div className="login-error" style={{ marginBottom: 8 }}>{error}</div>}
                <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy || !ip} onClick={connect}>
                  {busy ? '연결 준비 중…' : '접속'}
                </button>
                <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>
                  HAProxy 매핑을 만들고 {protocol === 'ssh' ? '브라우저 터미널' : 'RDP 웹콘솔/.rdp'}로 연결합니다.
                </span>
              </div>
            </div>
          )}
        </Modal>
      )}

      {session?.kind === 'ssh' && <SshTerminal mapping={session.mapping} onClose={() => setSession(null)} />}
      {session?.kind === 'rdp' && <RdpConsole mapping={session.mapping} onClose={() => setSession(null)} />}
    </>
  );
}
