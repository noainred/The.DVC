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

function handleConnection(ws) {
  let ssh = null;
  let stream = null;
  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* closed */ } };

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'auth') {
      const m = getMapping(msg.mappingId);
      if (!m || m.protocol !== 'ssh') return send({ type: 'status', text: 'SSH 매핑을 찾을 수 없습니다.' }) || ws.close();
      touchMapping(m.id); // reset the 1-day ephemeral expiry clock on use
      const proxyHost = getProxyById(m.proxyId).proxyHost;
      const host = proxyHost || m.targetHost;     // dial through the assigned proxy frontend
      const port = proxyHost ? m.publicPort : m.targetPort;
      send({ type: 'status', text: `연결 중 ${host}:${port} (대상 ${m.targetHost}:${m.targetPort})…` });

      ssh = new SSHClient();
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
        tryKeyboard: true,
        readyTimeout: 20000, keepaliveInterval: 15000,
      });
    } else if (msg.type === 'data' && stream) {
      stream.write(msg.data);
    } else if (msg.type === 'resize' && stream) {
      try { stream.setWindow(msg.rows, msg.cols, 0, 0); } catch { /* ignore */ }
    }
  });

  ws.on('close', () => { try { stream?.end(); } catch { /* */ } try { ssh?.end(); } catch { /* */ } });
}
