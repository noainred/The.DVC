import React, { useEffect, useState } from 'react';
import { postJson, getToken } from '../api.js';
import { Modal } from './ui.jsx';
import { openRemoteSession } from '../remote/sessions.js';

const FLD = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, minWidth: 0 };
const INP = { width: '100%', minWidth: 0, boxSizing: 'border-box' };

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
  const [creds, setCreds] = useState({ username: '', password: '', domain: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [probe, setProbe] = useState({ loading: true });

  const noIp = ips.length === 0;
  const guessPort = /windows/i.test(item.guestOS || '') ? 3389 : 22;
  const noteTail = (item.notes || '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-3).join('\n');

  // Pre-flight reachability check via the assigned proxy (ping + TCP port).
  useEffect(() => {
    let alive = true;
    if (noIp) { setProbe({ loading: false, ok: false, reason: '수집된 IP가 없습니다.' }); return; }
    setProbe({ loading: true });
    postJson('/remote/probe', { vcenterId: item.vcenterId, targetHost: ips[0], targetPort: guessPort })
      .then((r) => { if (alive) setProbe({ loading: false, ...r }); })
      .catch((e) => { if (alive) setProbe({ loading: false, ok: false, reason: e.message }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const probeColor = probe.loading ? null : probe.ok ? (probe.portOpen ? '#60a5fa' : '#f87171') : '#f59e0b';
  const probeTip = probe.loading ? '프록시 경유 접속 점검 중…'
    : probe.ok
      ? `프록시 '${probe.proxyName}'에서 ${ips[0]}:${guessPort} ${probe.portOpen ? '통신 OK ✓' : '통신 실패 ✗'}`
        + (probe.pingOk ? ` · ping ${probe.pingMs}ms` : ' · ping 무응답')
      : `사전 점검 불가: ${probe.reason || ''}`;
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
      } else {
        const initialCreds = creds.username
          ? (protocol === 'rdp' ? { username: creds.username, password: creds.password, domain: creds.domain } : { username: creds.username, password: creds.password })
          : null;
        openRemoteSession({ kind: protocol, mapping: { ...r.mapping, proxyName: r.proxyName }, initialCreds });
      }
      setOpen(false);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  return (
    <>
      <button className="logout-btn" style={{ padding: '8px 14px', color: probeColor || undefined, borderColor: probeColor || undefined }}
        onClick={() => { setError(null); setOpen(true); }} title={probeTip}>
        🔗 원격 접속{probe.loading ? ' …' : probe.ok ? (probe.portOpen ? ' ●' : ' ●') : ''}
      </button>

      {open && (
        <Modal title={`원격 접속 — ${item.name}`} onClose={() => setOpen(false)} width={460}>
          {noIp ? (
            <div className="muted">이 VM에 수집된 IP가 없어 접속할 수 없습니다.</div>
          ) : (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)', gap: 10 }}>
                <label style={FLD}>프로토콜
                  <select className="select" style={INP} value={protocol} onChange={(e) => { setProtocol(e.target.value); setPort(''); }}>
                    <option value="ssh">SSH</option>
                    <option value="rdp">RDP</option>
                  </select>
                </label>
                <label style={FLD}>대상 IP{ips.length > 1 ? ` (${ips.length})` : ''}
                  <select className="select" style={INP} value={ip} onChange={(e) => setIp(e.target.value)}>
                    {ips.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                </label>
                <label style={FLD}>포트(기본 {protocol === 'rdp' ? '3389' : '22'})
                  <input className="input" style={INP} type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder={protocol === 'rdp' ? '3389' : '22'} />
                </label>
              </div>

              {noteTail && (
                <div style={{ marginTop: 12 }}>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>메모(Notes)</div>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, background: 'rgba(255,255,255,.03)', borderRadius: 8, padding: '8px 10px', maxHeight: 72, overflow: 'auto' }}>{noteTail}</div>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: protocol === 'rdp' ? 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)' : 'minmax(0,1fr) minmax(0,1fr)', gap: 10, marginTop: 12 }}>
                <label style={FLD}>사용자명
                  <input className="input" style={INP} value={creds.username} onChange={(e) => setCreds({ ...creds, username: e.target.value })}
                    placeholder={protocol === 'rdp' ? 'Administrator' : 'root'}
                    onKeyDown={(e) => { if (e.key === 'Enter' && ip && creds.username) connect(); }} />
                </label>
                <label style={FLD}>비밀번호
                  <input className="input" style={INP} type="password" value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter' && ip && creds.username) connect(); }} />
                </label>
                {protocol === 'rdp' && (
                  <label style={FLD}>도메인(선택)
                    <input className="input" style={INP} value={creds.domain} onChange={(e) => setCreds({ ...creds, domain: e.target.value })} />
                  </label>
                )}
              </div>

              <div style={{ marginTop: 12 }}>
                {error && <div className="login-error" style={{ marginBottom: 8 }}>{error}</div>}
                <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy || !ip} onClick={connect}>
                  {busy ? '연결 준비 중…' : '접속'}
                </button>
                <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>
                  계정을 입력하면 바로 연결됩니다(비우면 콘솔에서 입력).
                </span>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
