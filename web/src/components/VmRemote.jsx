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
  const [probes, setProbes] = useState({}); // ip -> { loading, ok, portOpen, pingOk, pingMs, proxyName, reason }

  const noIp = ips.length === 0;
  const guessPort = isWindows ? 3389 : 22;
  const probePort = protocol === 'rdp' ? 3389 : 22; // 선택 프로토콜의 기본 포트로 도달성 확인
  // 브라우저 비밀번호 관리자가 'VM 이름'으로 저장/자동입력하도록 비번 필드 id/name을 VM 이름 기반으로.
  const pwFieldName = `vmpw_${String(item.name || 'vm').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const noteTail = (item.notes || '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-3).join('\n');

  // 사전 도달성 확인 — 다수 IP를 '모두' 프록시 경유로 ping+TCP 포트 점검(어느 IP로 붙을지 판단).
  useEffect(() => {
    let alive = true;
    if (noIp) return;
    setProbes(Object.fromEntries(ips.map((ip) => [ip, { loading: true }])));
    ips.forEach((ip) => {
      postJson('/remote/probe', { vcenterId: item.vcenterId, targetHost: ip, targetPort: probePort })
        .then((r) => { if (alive) setProbes((p) => ({ ...p, [ip]: { loading: false, ...r } })); })
        .catch((e) => { if (alive) setProbes((p) => ({ ...p, [ip]: { loading: false, ok: false, reason: e.message } })); });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, protocol]);

  // 포트가 열린(접속 가능) IP가 있으면 그 IP를 자동 선택(현재 선택이 도달 불가일 때).
  const openIps = ips.filter((x) => probes[x]?.portOpen);
  useEffect(() => {
    if (openIps.length && !probes[ip]?.portOpen) setIp(openIps[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(openIps)]);

  const anyLoading = ips.some((x) => probes[x]?.loading);
  const anyOpen = openIps.length > 0;
  const probeColor = noIp ? '#f59e0b' : anyLoading ? null : anyOpen ? '#22c55e' : '#f87171';
  const probeTip = noIp ? '수집된 IP가 없습니다.'
    : anyLoading ? '프록시 경유 접속 점검 중…'
      : anyOpen ? `접속 가능 IP: ${openIps.join(', ')} (:${probePort})`
        : `모든 IP 접속 불가(:${probePort}) — 방화벽/포트/프록시 경로 확인`;
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
        🔗 원격 접속{anyLoading ? ' …' : ' ●'}
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

              {/* 어떤 IP로 접속할지 확인 — 모든 IP를 프록시 경유로 도달성 점검(포트 열림=녹색). 선택한 IP로 접속. */}
              <div style={{ marginTop: 10 }}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>접속할 IP 확인 — {protocol.toUpperCase()} :{probePort} 도달성{ips.length > 1 ? ' (라디오로 선택)' : ''}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {ips.map((x) => {
                    const p = probes[x] || { loading: true };
                    const st = p.loading ? 'pending' : p.portOpen ? 'up' : (p.pingOk ? 'warn' : 'down');
                    const c = st === 'up' ? '#22c55e' : st === 'down' ? '#ef4444' : st === 'warn' ? '#f59e0b' : '#9ca3af';
                    const label = p.loading ? '확인 중…' : p.portOpen ? `접속 가능 · 포트 열림${p.pingOk ? ` · ping ${p.pingMs}ms` : ''}` : p.pingOk ? '포트 닫힘(ping만 응답)' : '도달 불가';
                    return (
                      <label key={x} title={label} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '4px 8px', borderRadius: 6,
                        border: ip === x ? '1px solid var(--accent,#2563eb)' : '1px solid transparent', background: ip === x ? 'rgba(37,99,235,.08)' : 'transparent' }}>
                        <input type="radio" name="remoteip" checked={ip === x} onChange={() => setIp(x)} />
                        <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: c, boxShadow: st === 'up' ? '0 0 6px #22c55e' : 'none', flex: '0 0 auto', animation: st === 'pending' ? 'pulse 1.2s infinite' : 'none' }} />
                        <span style={{ fontFamily: 'ui-monospace, monospace', color: c, fontWeight: 600 }}>{x}</span>
                        <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }}>{label}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  {anyLoading ? '도달성 확인 중…' : anyOpen ? `✅ 접속 가능 IP: ${openIps.join(', ')} — 선택한 IP로 접속합니다.` : '⚠ 열린 포트가 없습니다. 그래도 선택한 IP로 접속을 시도할 수 있습니다.'}
                </div>
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
