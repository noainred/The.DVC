/**
 * Browser SSH console gateway. A WebSocket at /api/remote/ssh bridges an
 * xterm.js terminal in the browser to an ssh2 connection that dials the target
 * THROUGH the proxy (proxyHost:publicPort of the mapping), since the portal can
 * only reach targets via the global proxy.
 *
 * Protocol (text frames, JSON for control):
 *   client → {type:'auth', mappingId, username, password}
 *   client → {type:'data', data}         keystrokes
 *   client → {type:'resize', cols, rows}
 *   server → {type:'status', text} | raw stdout chunks (binary/text)
 */

import { WebSocketServer } from 'ws';
import { Client as SSHClient } from 'ssh2';
import { verifyToken } from '../auth/auth.js';
import { getMapping, getProxyById, touchMapping } from './registry.js';
import { config } from '../config.js';

export function attachSshGateway(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/remote/ssh') return; // let other upgrade handlers run
    // Auth via token query param (browsers can't set WS headers).
    if (config.auth.enabled) {
      const token = url.searchParams.get('token');
      if (!verifyToken(token)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws));
  });
}

// 동시 원격 SSH 세션 상한 + 유휴 타임아웃 — 무제한 세션이 포탈 서버 메모리/FD를 고갈시켜
// 리붓되는 것을 막는다. 환경변수로 조정.
const MAX_SESSIONS = Number(process.env.REMOTE_MAX_SESSIONS) || 80;
const IDLE_MS = Number(process.env.REMOTE_IDLE_TIMEOUT_MS) || 30 * 60_000;
let activeSessions = 0;

function handleConnection(ws) {
  let ssh = null;
  let stream = null;
  let counted = false;
  let idleTimer = null;
  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* closed */ } };
  const bumpIdle = () => { if (!IDLE_MS) return; clearTimeout(idleTimer); idleTimer = setTimeout(() => { send({ type: 'status', text: `\r\n[유휴 ${Math.round(IDLE_MS / 60000)}분 — 세션을 닫습니다]` }); try { ws.close(); } catch { /* */ } }, IDLE_MS); };

  ws.on('message', (raw) => {
    bumpIdle();
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'auth') {
      const m = getMapping(msg.mappingId);
      if (!m || m.protocol !== 'ssh') return send({ type: 'status', text: 'SSH 매핑을 찾을 수 없습니다.' }) || ws.close();
      if (!counted && activeSessions >= MAX_SESSIONS) {
        send({ type: 'status', text: `동시 원격 세션 한도(${MAX_SESSIONS})를 초과했습니다. 사용하지 않는 세션을 닫고 잠시 후 다시 시도하세요.` });
        return ws.close();
      }
      if (!counted) { activeSessions++; counted = true; }
      touchMapping(m.id); // reset the 1-day ephemeral expiry clock on use
      const proxyHost = getProxyById(m.proxyId).proxyHost;
      const host = proxyHost || m.targetHost;     // dial through the assigned proxy frontend
      const port = proxyHost ? m.publicPort : m.targetPort;
      // 보안상 프록시 주소는 노출하지 않고 '대상'만 표시한다.
      send({ type: 'status', text: `연결 중 ${m.targetHost}:${m.targetPort}…` });

      // ssh -v 스타일 진행 로그(단계별 1회씩) — 접속이 지루하지 않게 과정을 보여준다.
      // 프록시 주소·IP 등 내부 정보는 노출하지 않도록 문구를 가공한다.
      const vshown = new Set();
      const vsend = (key, text) => { if (vshown.has(key)) return; vshown.add(key); send({ type: 'status', text: `🔹 ${text}` }); };
      const onDebug = (line) => {
        const s = String(line || '');
        if (/Trying|Connecting to|socket/i.test(s)) vsend('tcp', '대상에 TCP 연결 중…');
        else if (/Remote ident|remote software|server.*version/i.test(s)) { const v = (s.match(/SSH-[\w.\-@ ]+/) || [])[0]; vsend('ident', `서버 식별 수신${v ? `: ${v.trim()}` : ''}`); }
        else if (/KEXINIT|key exchange|\bKEX\b/i.test(s)) vsend('kex', '키 교환(KEX) 협상 중…');
        else if (/NEWKEYS|encrypt|cipher/i.test(s)) vsend('enc', '암호화 채널 수립…');
        else if (/keyboard-interactive/i.test(s)) vsend('kbd', '인증 시도: keyboard-interactive…');
        else if (/userauth.*password|password auth|Trying password/i.test(s)) vsend('pw', '인증 시도: password…');
        else if (/userauth|authenticat/i.test(s)) vsend('auth', '인증 협상 중…');
      };

      ssh = new SSHClient();
      ssh.on('banner', (b) => vsend('banner', `서버 배너: ${String(b).replace(/\s+/g, ' ').trim().slice(0, 120)}`));
      ssh.on('handshake', (n) => vsend('hs', `핸드셰이크 완료 · 암호화 ${(n && (n.kex || n.serverHostKey)) || 'OK'}`));
      ssh.on('ready', () => {
        send({ type: 'status', text: '인증 성공. 셸을 엽니다…' });
        // Fetch the remote hostname so the tab can be labelled by the actual server.
        try {
          ssh.exec('hostname', (e, hs) => {
            if (e || !hs) return;
            let out = '';
            hs.on('data', (d) => { out += d.toString(); });
            hs.on('close', () => { const h = out.trim().split(/\s+/)[0]; if (h) send({ type: 'hostname', name: h }); });
          });
        } catch { /* optional */ }
        ssh.shell({ term: 'xterm-256color', cols: msg.cols || 80, rows: msg.rows || 24 }, (err, s) => {
          if (err) { send({ type: 'status', text: `셸 오류: ${err.message}` }); return ws.close(); }
          stream = s;
          s.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d.toString('utf8')); });
          s.on('close', () => { send({ type: 'status', text: '\r\n[세션 종료]' }); ws.close(); });
          s.stderr?.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d.toString('utf8')); });
        });
      });
      // 일부 서버(하드닝된 Linux/네트워크 장비/Windows OpenSSH 등)는 password 대신
      // keyboard-interactive 만 허용한다. ssh2는 명시적으로 켜지 않으면 이 방식을
      // 시도하지 않아 'All configured authentication methods failed' 로 끝난다.
      // 같은 비밀번호로 모든 프롬프트에 응답해 password/keyboard-interactive 양쪽을 지원.
      ssh.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
        finish(prompts.map(() => msg.password || ''));
      });
      ssh.on('error', (err) => {
        const hint = /All configured authentication methods failed|authentication/i.test(err.message)
          ? ' — 아이디/비밀번호를 확인하세요. (계정이 맞다면 대상 서버가 비밀번호 로그인을 막아둔 경우일 수 있습니다)'
          : '';
        send({ type: 'status', text: `연결 실패: ${err.message}${hint}` });
        ws.close();
      });
      ssh.on('close', () => ws.close());
      ssh.connect({
        host, port, username: msg.username, password: msg.password,
        tryKeyboard: true, debug: onDebug,
        // 고RTT(800ms+) + 프록시 경유 + keyboard-interactive 인증의 다중 왕복을 고려해 상향(20s→60s).
        readyTimeout: Number(process.env.SSH_READY_TIMEOUT_MS) || 60000, keepaliveInterval: 15000,
      });
    } else if (msg.type === 'data' && stream) {
      stream.write(msg.data);
    } else if (msg.type === 'resize' && stream) {
      try { stream.setWindow(msg.rows, msg.cols, 0, 0); } catch { /* ignore */ }
    }
  });

  ws.on('close', () => {
    clearTimeout(idleTimer);
    if (counted) { activeSessions = Math.max(0, activeSessions - 1); counted = false; }
    try { stream?.end(); } catch { /* */ } try { ssh?.end(); } catch { /* */ }
  });
}

/** 현재 동시 SSH 세션 수(상태/진단용). */
export function activeSshSessionCount() { return activeSessions; }
