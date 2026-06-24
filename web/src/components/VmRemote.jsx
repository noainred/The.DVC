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
  // Guest OS로 Windows/Linux를 인식해 기본 프로토콜·포트를 자동 선택(Windows→RDP/3389, 그 외→SSH/22).
  const isWindows = /windows|win32|win64|microsoft/i.test(item.guestOS || '');
  const [open, setOpen] = useState(false);
  const [protocol, setProtocol] = useState(isWindows ? 'rdp' : 'ssh');
  const [autoProto, setAutoProto] = useState(true); // 사용자가 직접 바꾸기 전까지는 자동 선택 유지
  const [ip, setIp] = useState(ips[0] || '');
  const [port, setPort] = useState('');
  const [creds, setCreds] = useState({ username: '', password: '', domain: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [probe, setProbe] = useState({ loading: true });

  const noIp = ips.length === 0;
  const guessPort = isWindows ? 3389 : 22;
  // 브라우저 비밀번호 관리자가 'VM 이름'으로 저장/자동입력하도록 비번 필드 id/name을 VM 이름 기반으로.
  const pwFieldName = `vmpw_${String(item.name || 'vm').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
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
            <form autoComplete="on" onSubmit={(e) => { e.preventDefault(); if (ip) connect(); }}>
              {/* 브라우저가 비밀번호를 'VM 이름' 기준으로 저장/자동입력하도록 숨은 username 필드(포탈에 저장하는 게 아님) */}
              <input type="text" name="vmname" autoComplete="username" value={item.name} readOnly aria-hidden="true" tabIndex={-1}
                style={{ position: 'absolute', width: 1, height: 1, padding: 0, border: 0, opacity: 0, pointerEvents: 'none' }} />
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)', gap: 10 }}>
                <label style={FLD}>프로토콜{autoProto ? <span className="muted" style={{ fontWeight: 400 }}> · {isWindows ? 'Windows' : 'Linux'} 자동</span> : ''}
                  <select className="select" style={INP} value={protocol} onChange={(e) => { setProtocol(e.target.value); setPort(''); setAutoProto(false); }}>
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
                    autoComplete="off" placeholder={protocol === 'rdp' ? 'Administrator' : 'root'} />
                </label>
                <label style={FLD}>비밀번호
                  <input className="input" style={INP} type="password" name={pwFieldName} id={pwFieldName} autoComplete="current-password"
                    value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })} />
                </label>
                {protocol === 'rdp' && (
                  <label style={FLD}>도메인(선택)
                    <input className="input" style={INP} value={creds.domain} onChange={(e) => setCreds({ ...creds, domain: e.target.value })} />
                  </label>
                )}
              </div>

              <div style={{ marginTop: 12 }}>
                {error && <div className="login-error" style={{ marginBottom: 8 }}>{error}</div>}
                <button type="submit" className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy || !ip}>
                  {busy ? '연결 준비 중…' : '접속'}
                </button>
                <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>
                  계정을 입력하면 바로 연결됩니다(비우면 콘솔에서 입력). 비밀번호는 브라우저에 'VM 이름'으로 저장돼 다음 접속 시 자동입력됩니다.
                </span>
              </div>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
