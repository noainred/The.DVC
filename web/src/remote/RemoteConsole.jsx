import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import Guacamole from 'guacamole-common-js';
import '@xterm/xterm/css/xterm.css';
import { getToken } from '../api.js';

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Browser SSH console body (fills its container). Connects on credential submit. */
export function SshConsole({ mapping, initialCreds, onCreds, onHostname }) {
  const elRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const timerRef = useRef(null);
  const fitRef = useRef(null);
  const roRef = useRef(null);
  const phaseRef = useRef('form');
  const [creds, setCreds] = useState(initialCreds && initialCreds.username ? initialCreds : { username: '', password: '' });
  const [phase, setPhaseState] = useState('form'); // form | connecting | live | error
  const [status, setStatus] = useState('');
  const [ticks, setTicks] = useState(0);
  const [formErr, setFormErr] = useState(''); // 폼 상단 안내(인증 실패 사유 등)

  const setPhase = (p) => { phaseRef.current = p; setPhaseState(p); };
  const stopTimer = () => { try { clearInterval(timerRef.current); } catch { /* */ } timerRef.current = null; };
  useEffect(() => () => { stopTimer(); try { roRef.current?.disconnect(); } catch { /* */ } try { wsRef.current?.close(); } catch { /* */ } try { termRef.current?.dispose(); } catch { /* */ } }, []);
  // Auto-connect when duplicated (credentials carried over).
  useEffect(() => { if (initialCreds && initialCreds.username) connect(); /* eslint-disable-next-line */ }, []);

  const refit = () => {
    try {
      fitRef.current?.fit();
      const ws = wsRef.current, term = termRef.current;
      if (ws && ws.readyState === 1 && term) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    } catch { /* */ }
  };

  const connect = () => {
    onCreds?.(creds);
    setFormErr('');
    setPhase('connecting'); setStatus('프록시에 WebSocket 연결 중…'); setTicks(0);
    stopTimer(); const t0 = Date.now();
    timerRef.current = setInterval(() => setTicks(Math.floor((Date.now() - t0) / 200)), 200);
    setTimeout(() => {
      const term = new Terminal({ fontSize: 13, cursorBlink: true, theme: { background: '#0b1020' } });
      const fit = new FitAddon(); term.loadAddon(fit);
      term.open(elRef.current); fit.fit(); term.focus(); termRef.current = term; fitRef.current = fit;
      try { roRef.current = new ResizeObserver(() => refit()); roRef.current.observe(elRef.current); } catch { /* */ }
      term.write('\x1b[90m연결을 준비하는 중입니다…\x1b[0m\r\n');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/remote/ssh?token=${encodeURIComponent(getToken() || '')}`);
      wsRef.current = ws;
      ws.onopen = () => { setStatus('인증 중… (자격증명 전송)'); ws.send(JSON.stringify({ type: 'auth', mappingId: mapping.id, username: creds.username, password: creds.password, cols: term.cols, rows: term.rows })); };
      ws.onmessage = (e) => {
        const s = typeof e.data === 'string' ? e.data : '';
        try {
          const j = JSON.parse(s);
          if (j && j.type === 'hostname') { onHostname?.(j.name); return; }
          if (j && j.type === 'status') {
            setStatus(j.text); term.write(`\r\n\x1b[33m${j.text}\x1b[0m\r\n`);
            // 인증 실패면 자격증명 폼으로 되돌려 비밀번호를 다시 입력하게 한다(빈/오타 비번 재입력).
            if (/authentication|인증|permission denied|auth/i.test(j.text) && phaseRef.current !== 'live') {
              setFormErr(`인증 실패: 사용자명/비밀번호를 확인하세요. (${j.text})`);
              setCreds((c) => ({ ...c, password: '' }));
              setPhase('form'); stopTimer();
              try { wsRef.current?.close(); } catch { /* */ }
            }
            return;
          }
        } catch { /* raw */ }
        if (phaseRef.current !== 'live') { setPhase('live'); stopTimer(); }
        term.write(s);
      };
      ws.onerror = () => { if (phaseRef.current !== 'live') { setPhase('error'); setStatus('WebSocket 연결 실패 — 포탈/프록시 경로 또는 인증을 확인하세요.'); } stopTimer(); };
      ws.onclose = () => { term.write('\r\n\x1b[31m[연결 종료]\x1b[0m\r\n'); if (phaseRef.current !== 'live') { setPhase('error'); setStatus((x) => x || '연결이 종료되었습니다.'); } stopTimer(); };
      term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: d })); });
    }, 0);
  };

  const elapsed = Math.floor(ticks * 0.2);
  const slow = phase === 'connecting' && elapsed >= 20;

  if (phase === 'form') {
    return (
      <div style={{ padding: 14 }}>
        {formErr && <div className="login-error" style={{ marginBottom: 10 }}>{formErr}</div>}
        <div className="spec-grid">
          <label>사용자명<input className="input" autoFocus value={creds.username} onChange={(e) => setCreds({ ...creds, username: e.target.value })} placeholder="root" /></label>
          <label>비밀번호<input className="input" type="password" value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && creds.username && connect()} /></label>
          <div style={{ gridColumn: '1 / -1' }}>
            <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={!creds.username} onClick={connect}>접속</button>
            <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>{mapping.proxyName ? `프록시 '${mapping.proxyName}' 경유로 ` : '프록시 경유로 '}{mapping.targetHost}:{mapping.targetPort} 에 연결합니다.</span>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 10, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '6px 10px', borderRadius: 8, fontSize: 13,
        background: phase === 'live' ? 'rgba(34,197,94,.12)' : phase === 'error' ? 'rgba(239,68,68,.12)' : 'rgba(59,130,246,.12)',
        color: phase === 'live' ? '#4ade80' : phase === 'error' ? '#f87171' : '#93c5fd' }}>
        {phase === 'connecting' && <><span style={{ fontFamily: 'monospace' }}>{SPIN[ticks % SPIN.length]}</span><span>{status}</span><span className="muted" style={{ marginLeft: 'auto' }}>{elapsed}s</span></>}
        {phase === 'live' && <span>● 연결됨</span>}
        {phase === 'error' && <><span>⚠ {status}</span>
          <button className="logout-btn" style={{ padding: '4px 12px', marginLeft: 'auto' }} onClick={() => { setCreds((c) => ({ ...c, password: '' })); setFormErr(status || ''); setPhase('form'); }}>🔑 자격증명 입력</button>
          <button className="logout-btn" style={{ padding: '4px 12px' }} onClick={connect}>재시도</button></>}
      </div>
      {slow && <div className="muted" style={{ fontSize: 12, marginBottom: 8, color: 'var(--amber)' }}>응답 지연({elapsed}s) — 프록시 매핑/대상 SSH 포트·방화벽·경로 확인. 계속 시도 중입니다.</div>}
      <div ref={elRef} style={{ flex: 1, minHeight: 120, background: '#0b1020', borderRadius: 8, padding: 6 }} />
    </div>
  );
}

/** Browser RDP console body via guacd. `active` gates keyboard so background tabs don't capture keys. */
export function RdpConsole({ mapping, active, initialCreds, onCreds }) {
  const elRef = useRef(null);
  const clientRef = useRef(null);
  const activeRef = useRef(active);
  const [creds, setCreds] = useState(initialCreds && initialCreds.username ? initialCreds : { username: '', password: '', domain: '' });
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => () => { try { clientRef.current?.disconnect(); } catch { /* */ } }, []);
  useEffect(() => { if (initialCreds && initialCreds.username) connect(); /* eslint-disable-next-line */ }, []);

  const connect = () => {
    onCreds?.(creds);
    setConnected(true);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const tunnel = new Guacamole.WebSocketTunnel(`${proto}://${location.host}/api/remote/rdp`);
    const client = new Guacamole.Client(tunnel);
    clientRef.current = client;
    setTimeout(() => {
      elRef.current.appendChild(client.getDisplay().getElement());
      client.onstatechange = (s) => setStatus(['초기화', '연결 중', '대기', '연결됨', '연결 종료', '오류'][s] || String(s));
      client.onerror = (e) => setStatus(`오류: ${e.message || e}`);
      const w = Math.max(800, elRef.current.clientWidth || 1024);
      const h = Math.max(600, elRef.current.clientHeight || 768);
      const q = new URLSearchParams({ token: getToken() || '', mappingId: mapping.id, username: creds.username, password: creds.password, domain: creds.domain, width: String(w), height: String(h) }).toString();
      client.connect(q);
      const display = client.getDisplay().getElement();
      const mouse = new Guacamole.Mouse(display);
      mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (st) => { if (activeRef.current) client.sendMouseState(st); };
      const kbd = new Guacamole.Keyboard(document);
      kbd.onkeydown = (k) => { if (activeRef.current) client.sendKeyEvent(1, k); };
      kbd.onkeyup = (k) => { if (activeRef.current) client.sendKeyEvent(0, k); };
    }, 0);
  };

  if (!connected) {
    return (
      <div style={{ padding: 14 }}>
        <div className="spec-grid">
          <label>사용자명<input className="input" autoFocus value={creds.username} onChange={(e) => setCreds({ ...creds, username: e.target.value })} placeholder="Administrator" /></label>
          <label>비밀번호<input className="input" type="password" value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })} /></label>
          <label>도메인(선택)<input className="input" value={creds.domain} onChange={(e) => setCreds({ ...creds, domain: e.target.value })} /></label>
          <div style={{ gridColumn: '1 / -1' }}>
            <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} onClick={connect}>접속</button>
            <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>guacd 게이트웨이 경유로 RDP에 연결합니다.</span>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 10, boxSizing: 'border-box' }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>상태: {status}</div>
      <div ref={elRef} style={{ flex: 1, background: '#000', borderRadius: 8, overflow: 'auto' }} tabIndex={0} />
    </div>
  );
}
