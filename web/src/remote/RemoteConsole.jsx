import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import Guacamole from 'guacamole-common-js';
import '@xterm/xterm/css/xterm.css';
import { getToken, postJson } from '../api.js';
import { sshDataFrames, sshCloseReasonText, remoteCloseReasonText } from './sshSend.js';
import { onTokenRenewed, tokenAckText } from './tokenRenew.js';
import { isSshAuthFailText, canConnect, retryAction, RETRY_NEEDS_PASSWORD, holdsPhaseOnClose, releaseConsole } from './sshConsoleState.js'; // v2.732 B5-07

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Browser SSH console body (fills its container). Connects on credential submit. */
export function SshConsole({ mapping, initialCreds, onCreds, onHostname }) {
  const elRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const timerRef = useRef(null);
  const connTimerRef = useRef(null); // WS 연결/인증 타임아웃(고RTT에서 무한 '연결 중' 방지)
  const fitRef = useRef(null);
  const roRef = useRef(null);
  const attemptRef = useRef(0); // v2.732(B5-07): 시도 번호 — 그사이 새 시도·언마운트가 있으면 늦게 도는 setTimeout 이 터미널을 만들지 않는다
  const phaseRef = useRef('form');
  const [creds, setCreds] = useState(initialCreds && initialCreds.username ? initialCreds : { username: '', password: '' });
  const [phase, setPhaseState] = useState('form'); // form | connecting | live | error | closed(사유 없는 정상 종료 — v2.731)
  const [status, setStatus] = useState('');
  const [ticks, setTicks] = useState(0);
  const [formErr, setFormErr] = useState(''); // 폼 상단 안내(인증 실패 사유 등)

  const setPhase = (p) => { phaseRef.current = p; setPhaseState(p); };
  const stopTimer = () => { try { clearInterval(timerRef.current); } catch { /* */ } timerRef.current = null; try { clearTimeout(connTimerRef.current); } catch { /* */ } connTimerRef.current = null; };
  // 2026-10-09 S-04: 세션 연장 토큰을 열린 연결에 보낸다(서버가 옛 토큰 만료 시각에 닫지 않게). 연결이 없으면 아무것도 안 한다.
  useEffect(() => onTokenRenewed((token) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'token', token })); } catch { /* 닫히는 중 */ } }
  }), []);
  useEffect(() => () => { attemptRef.current += 1; stopTimer(); releaseConsole({ ws: wsRef.current, term: termRef.current, ro: roRef.current }); }, []);
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
    // v2.732(B5-07): 빈 비밀번호로는 대상 서버에 로그인하지 않는다(게이트웨이는 빈 값을 거르지 않아 대상 계정에 실패 로그인이 쌓인다).
    //   사용자명만 실어 자동 접속(복제·VM 원격 접속)한 경우도 폼에서 비밀번호를 받는다.
    if (!canConnect(creds)) { stopTimer(); setPhase('form'); return; }
    // 이전 시도의 소켓·터미널·관찰자를 먼저 정리한다 — 예전에는 재시도마다 xterm 이 같은 칸에 쌓였고(1→4),
    //   늦게 닫힌 옛 소켓의 onclose 가 새 시도의 단계·타이머를 바꿨다. 핸들러를 뗀 뒤 닫는다(releaseConsole).
    releaseConsole({ ws: wsRef.current, term: termRef.current, ro: roRef.current, el: elRef.current });
    wsRef.current = null; termRef.current = null; roRef.current = null; fitRef.current = null;
    const attempt = ++attemptRef.current;
    onCreds?.(creds);
    setFormErr('');
    setPhase('connecting'); setStatus('프록시에 WebSocket 연결 중…'); setTicks(0);
    stopTimer(); const t0 = Date.now();
    timerRef.current = setInterval(() => setTicks(Math.floor((Date.now() - t0) / 200)), 200);
    setTimeout(() => {
      if (attempt !== attemptRef.current || !elRef.current) return; // 그사이 새 시도가 시작됐거나 창이 닫혔다
      const term = new Terminal({ fontSize: 13, cursorBlink: true, theme: { background: '#0b1020' } });
      const fit = new FitAddon(); term.loadAddon(fit);
      term.open(elRef.current); fit.fit(); term.focus(); termRef.current = term; fitRef.current = fit;
      try { roRef.current = new ResizeObserver(() => refit()); roRef.current.observe(elRef.current); } catch { /* */ }
      term.write('\x1b[90m연결을 준비하는 중입니다…\x1b[0m\r\n');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/remote/ssh?token=${encodeURIComponent(getToken() || '')}`);
      wsRef.current = ws;
      // 고RTT/반열림 연결에서 브라우저가 무한 '연결 중'으로 멈추는 것 방지 — 일정 시간 내
      // 라이브 전환이 없으면 명확한 타임아웃 오류로 종료(SSH 협상+프록시 지연 고려해 45s 기본).
      // v2.732(B5-07): 아래 핸들러는 전부 '이 시도의 소켓' 일 때만 상태를 바꾼다(wsRef.current === ws).
      const mine = () => wsRef.current === ws;
      connTimerRef.current = setTimeout(() => {
        if (!mine()) return;
        if (phaseRef.current !== 'live') {
          setPhase('error');
          setStatus('연결 타임아웃 — 고지연/프록시 지연 또는 네트워크를 확인하세요. 다시 시도하세요.');
          try { ws.close(); } catch { /* */ }
          stopTimer();
        }
      }, 45000);
      ws.onopen = () => { if (!mine()) return; setStatus('인증 중… (자격증명 전송)'); ws.send(JSON.stringify({ type: 'auth', mappingId: mapping.id, username: creds.username, password: creds.password, cols: term.cols, rows: term.rows })); };
      ws.onmessage = (e) => {
        if (!mine()) return;
        const s = typeof e.data === 'string' ? e.data : '';
        try {
          const j = JSON.parse(s);
          if (j && j.type === 'hostname') { onHostname?.(j.name); return; }
          // 2026-10-09 S-04: 토큰 교체 응답 — 터미널 출력으로 흘리지 않는다. 거부면 사유를 한 줄로 알린다.
          if (j && j.type === 'token-ack') { const w = tokenAckText(j); if (w) { setStatus(w); term.write(`\r\n\x1b[33m${w}\x1b[0m\r\n`); } return; }
          if (j && j.type === 'status') {
            setStatus(j.text); term.write(`\r\n\x1b[33m${j.text}\x1b[0m\r\n`);
            const t = j.text || '';
            // 인증 '성공'/셸 열림 = 진행 중 → 라이브로 전환(터미널 사용 가능). 절대 오류 처리 금지.
            if (/성공|셸을 엽|shell/i.test(t)) { if (phaseRef.current !== 'live') { setPhase('live'); stopTimer(); } return; }
            // 진짜 인증 '실패'일 때만 자격증명 폼으로 되돌린다('성공'은 위에서 이미 제외).
            const isAuthFail = isSshAuthFailText(t);
            if (isAuthFail && phaseRef.current !== 'live') {
              setFormErr(`인증 실패: 사용자명/비밀번호를 확인하세요. (${t})`);
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
      ws.onerror = () => { if (!mine() || holdsPhaseOnClose(phaseRef.current)) return; if (phaseRef.current !== 'live') { setPhase('error'); setStatus('WebSocket 연결 실패 — 포탈/프록시 경로 또는 인증을 확인하세요.'); } stopTimer(); };
      // v2.632(AX1-2632-07): 닫힘 코드가 사유를 말하면(1009 = 프레임 상한 초과) 그것을 함께 보인다 — 사유 없는 '[연결 종료]' 금지.
      // v2.731(A5-02·A1-03): 서버가 보낸 사유(ev.reason)가 먼저다 — 4403 은 권한·매핑 삭제·대상 변경·호스트키 거부가 함께 쓰는 코드라
      //   코드 문구만 쓰면 호스트키 거부를 '권한·범위가 바뀌어' 로 덮었다.
      ws.onclose = (ev) => {
        if (!mine()) return;
        const why = remoteCloseReasonText(ev?.reason) || sshCloseReasonText(ev?.code);
        term.write(`\r\n\x1b[31m[연결 종료]${why ? ` ${why}` : ''}\x1b[0m\r\n`);
        // v2.732(B5-07): 인증 실패로 자격증명 폼에 돌아왔으면 뒤이은 닫힘(게이트웨이 1011)이 폼을 오류 막대로 덮지 않는다.
        //   예전에는 여기서 'error' 로 바꿔 폼이 사라지고, 그 '재시도' 가 빈 비밀번호로 로그인했다.
        if (holdsPhaseOnClose(phaseRef.current)) { stopTimer(); return; }
        if (why) setStatus(why);
        // v2.731(A1-03): 열린 세션이 닫히면(매핑 삭제·대상 변경·권한·유휴 등) 상태줄이 '● 연결됨' 으로 남지 않게 한다 —
        //   사유가 있으면 오류(사유 표시), 사유 없는 정상 종료(exit 등)는 '연결 종료'.
        if (phaseRef.current === 'live') { setPhase(why ? 'error' : 'closed'); if (!why) setStatus('연결이 종료되었습니다.'); }
        else { setPhase('error'); setStatus((x) => why || x || '연결이 종료되었습니다.'); }
        stopTimer();
      };
      // v2.632(AX1-2632-07): 붙여넣기 전량을 한 프레임으로 보내면 256KB 상한(서버 1009)에 걸려 세션이 끊긴다 — 조각으로 나눠 보낸다.
      term.onData((d) => { if (ws.readyState === 1) for (const fr of sshDataFrames(d)) ws.send(fr); });
    }, 0);
  };

  // v2.732(B5-07): 오류 막대의 '재시도' — 비밀번호가 비었으면(인증 실패 뒤 지운 경우 등) 같은 빈 값으로 로그인하지 않고 폼으로 보낸다.
  const retry = () => {
    if (retryAction(creds) === 'form') { stopTimer(); setFormErr(RETRY_NEEDS_PASSWORD); setPhase('form'); return; }
    connect();
  };

  const elapsed = Math.floor(ticks * 0.2);
  const slow = phase === 'connecting' && elapsed >= 20;

  if (phase === 'form') {
    return (
      <div style={{ padding: 14 }}>
        {formErr && <div className="login-error" style={{ marginBottom: 10 }}>{formErr}</div>}
        <div className="spec-grid">
          <label>사용자명<input className="input" autoFocus value={creds.username} onChange={(e) => setCreds({ ...creds, username: e.target.value })} placeholder="root" /></label>
          <label>비밀번호<input className="input" type="password" value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && canConnect(creds) && connect()} /></label>
          <div style={{ gridColumn: '1 / -1' }}>
            <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={!canConnect(creds)}
              title={canConnect(creds) ? '' : '사용자명과 비밀번호를 입력하세요(빈 비밀번호로는 접속하지 않습니다).'} onClick={connect}>접속</button>
            <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>{mapping.proxyName ? `프록시 '${mapping.proxyName}' 경유로 ` : '프록시 경유로 '}{mapping.targetHost}:{mapping.targetPort} 에 연결합니다.</span>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 10, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '6px 10px', borderRadius: 8, fontSize: 13,
        background: phase === 'live' ? 'rgba(34,197,94,.12)' : phase === 'error' ? 'rgba(239,68,68,.12)' : phase === 'closed' ? 'rgba(148,163,184,.12)' : 'rgba(59,130,246,.12)',
        color: phase === 'live' ? '#4ade80' : phase === 'error' ? '#f87171' : phase === 'closed' ? '#cbd5e1' : '#93c5fd' }}>
        {phase === 'connecting' && <><span style={{ fontFamily: 'monospace' }}>{SPIN[ticks % SPIN.length]}</span><span>{status}</span><span className="muted" style={{ marginLeft: 'auto' }}>{elapsed}s</span></>}
        {phase === 'live' && <span>● 연결됨</span>}
        {phase === 'closed' && <span>■ {status}</span>}
        {phase === 'error' && <><span>⚠ {status}</span>
          <button className="logout-btn" style={{ padding: '4px 12px', marginLeft: 'auto' }} onClick={() => { setCreds((c) => ({ ...c, password: '' })); setFormErr(status || ''); setPhase('form'); }}>🔑 자격증명 입력</button>
          <button className="logout-btn" style={{ padding: '4px 12px' }} onClick={retry}>재시도</button></>}
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
  const tunnelRef = useRef(null); // 2026-10-09 S-04: 세션 연장 토큰을 보낼 터널
  const kbdRef = useRef(null); // document 전역 키보드 핸들러 — 언마운트 시 반드시 해제(리스너 누수 방지, 감사 M21)
  const activeRef = useRef(active);
  const [creds, setCreds] = useState(initialCreds && initialCreds.username ? initialCreds : { username: '', password: '', domain: '' });
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => { activeRef.current = active; }, [active]);
  // 2026-10-09 S-04: 세션 연장 토큰을 RDP 터널에도 보낸다(서버가 'dvc-token' 명령을 소비 — guacd 로 넘기지 않는다).
  useEffect(() => onTokenRenewed((token) => {
    const t = tunnelRef.current;
    if (t && clientRef.current) { try { t.sendMessage('dvc-token', token); } catch { /* 닫히는 중 */ } }
  }), []);
  useEffect(() => () => {
    try { clientRef.current?.disconnect(); } catch { /* */ }
    // Guacamole.Keyboard는 document에 직접 addEventListener하므로 disconnect로는 제거되지 않는다 —
    // 핸들러를 끊어 콘솔을 여닫을 때마다 죽은 리스너가 쌓이는 것을 방지.
    if (kbdRef.current) { kbdRef.current.onkeydown = null; kbdRef.current.onkeyup = null; kbdRef.current = null; }
  }, []);
  useEffect(() => { if (initialCreds && initialCreds.username) connect(); /* eslint-disable-next-line */ }, []);

  const connect = async () => {
    onCreds?.(creds);
    // 자격증명을 URL 쿼리스트링에 싣지 않기 위해(감사 H18) 접속 직전 1회용 티켓을 발급받아
    // 쿼리엔 티켓 ID만 싣는다. 게이트웨이가 티켓으로만 자격증명을 조회하므로(쿼리 폴백 제거),
    // 티켓 발급이 실패하면 **접속을 중단**한다 — 쿼리에 비번을 싣던 폴백은 상위 프록시 로그·
    // 브라우저 히스토리에 자격증명을 남기는 경로라 제거했다(감사 M16).
    let ticket = '';
    try { const r = await postJson('/remote/rdp-ticket', { username: creds.username, password: creds.password, domain: creds.domain }); ticket = r?.ticket || ''; }
    catch (e) { setStatus(`티켓 발급 실패: ${e?.message || e} — 다시 시도하세요.`); return; }
    if (!ticket) { setStatus('접속 티켓을 발급받지 못했습니다 — 다시 시도하세요.'); return; }
    setStatus('');
    setConnected(true);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const tunnel = new Guacamole.WebSocketTunnel(`${proto}://${location.host}/api/remote/rdp`);
    const client = new Guacamole.Client(tunnel);
    clientRef.current = client;
    tunnelRef.current = tunnel;
    // v2.731(A5-02·A1-03): 서버가 연결을 닫은 사유(매핑 삭제·대상 변경·권한·세션 폐기)를 보인다 — Guacamole 터널은 WebSocket 닫힘 사유를
    //   상태 메시지로 넘기는데 Client 는 그것을 onerror 로 올리지 않아 화면이 아무 말 없이 멈춰 있었다. 모르는 사유는 건드리지 않는다.
    tunnel.onerror = (st) => { const t = remoteCloseReasonText(st?.message); if (t) setStatus(t); };
    setTimeout(() => {
      elRef.current.appendChild(client.getDisplay().getElement());
      client.onstatechange = (s) => setStatus(['초기화', '연결 중', '대기', '연결됨', '연결 종료', '오류'][s] || String(s));
      client.onerror = (e) => setStatus(`오류: ${e.message || e}`);
      const w = Math.max(800, elRef.current.clientWidth || 1024);
      const h = Math.max(600, elRef.current.clientHeight || 768);
      // 자격증명은 쿼리에서 제외 — 게이트웨이가 티켓으로 조회한다(쿼리 폴백 제거, 감사 M16).
      const q = new URLSearchParams({ token: getToken() || '', mappingId: mapping.id, width: String(w), height: String(h), ticket }).toString();
      client.connect(q);
      const display = client.getDisplay().getElement();
      const mouse = new Guacamole.Mouse(display);
      mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (st) => { if (activeRef.current) client.sendMouseState(st); };
      const kbd = new Guacamole.Keyboard(document);
      kbdRef.current = kbd;
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
            {status && <div style={{ fontSize: 12, marginTop: 8, color: 'var(--red,#ef4444)' }}>⚠ {status}</div>}
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
