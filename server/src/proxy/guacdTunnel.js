/**
 * guacd (Apache Guacamole proxy daemon) WebSocket tunnel for browser RDP.
 *
 * The browser runs guacamole-common-js (Guacamole.Client) over a WebSocket at
 * /api/remote/rdp. This server performs the guacd handshake (select → args →
 * size/audio/video/image → connect → ready) using connection settings derived
 * from the mapping (host = proxyHost:publicPort) and the user's RDP credentials,
 * then relays the protocol stream between the browser and guacd.
 *
 * Requires a reachable guacd (configured under remote-access → guacd). Untested
 * without a live guacd — verify in your environment.
 */

import net from 'node:net';
import { WebSocketServer } from 'ws';
import { verifyToken } from '../auth/auth.js';
import { getMapping, getProxyById, touchMapping } from './registry.js';
import { config } from '../config.js';

// Encode a Guacamole instruction: each element is "<charLen>.<value>", comma
// separated, terminated by ';'.
function enc(...els) {
  return els.map((e) => { const s = String(e); return `${[...s].length}.${s}`; }).join(',') + ';';
}

// Parse one complete instruction starting at `start`; returns {opcode,args,end} or null.
function parseInstruction(str, start) {
  let i = start; const els = [];
  while (i < str.length) {
    const dot = str.indexOf('.', i);
    if (dot < 0) return null;
    const len = parseInt(str.slice(i, dot), 10);
    if (Number.isNaN(len)) return null;
    const vEnd = dot + 1 + len;
    if (vEnd > str.length) return null;
    els.push(str.slice(dot + 1, vEnd));
    const sep = str[vEnd];
    if (sep === ';') return { opcode: els[0], args: els.slice(1), end: vEnd + 1 };
    if (sep === ',') { i = vEnd + 1; continue; }
    return null;
  }
  return null;
}

export function attachRdpGateway(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/remote/rdp') return;
    if (config.auth.enabled && !verifyToken(url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => handle(ws, url.searchParams));
  });
}

function handle(ws, params) {
  const m = getMapping(params.get('mappingId'));
  if (!m || m.protocol !== 'rdp') { ws.close(1011, 'rdp mapping not found'); return; }
  touchMapping(m.id); // reset the 1-day ephemeral expiry clock on use
  const proxy = getProxyById(m.proxyId);
  if (!proxy.guacd?.host) { ws.close(1011, 'guacd not configured'); return; }

  const host = proxy.proxyHost || m.targetHost;
  const port = proxy.proxyHost ? m.publicPort : m.targetPort;
  const settings = {
    hostname: host, port: String(port),
    username: params.get('username') || '', password: params.get('password') || '', domain: params.get('domain') || '',
    width: params.get('width') || '1024', height: params.get('height') || '768', dpi: '96',
    security: params.get('security') || 'any', 'ignore-cert': 'true', 'resize-method': 'display-update',
  };

  const guacd = net.connect(proxy.guacd.port || 4822, proxy.guacd.host);
  // guacd 호스트가 방화벽/미도달이면 SYN_SENT로 OS 타임아웃(~2분)까지 ws가 열린 채 쌓인다 →
  // 연결 타임아웃을 명시(핸드셰이크 완료 전만; ready 후에는 정상 유휴 대비 해제).
  guacd.setTimeout(20_000, () => { if (!ready) { try { ws.close(1011, 'guacd 연결 타임아웃'); } catch { /* */ } try { guacd.destroy(); } catch { /* */ } } });
  let ready = false;
  let buf = '';
  const MAX_HANDSHAKE_BUF = 256 * 1024; // 핸드셰이크 중 파싱 불가 데이터가 무한 누적되는 것 차단

  guacd.on('connect', () => guacd.write(enc('select', 'rdp')));

  guacd.on('data', (data) => {
    if (ready) { if (ws.readyState === ws.OPEN) ws.send(data.toString('utf8')); return; }
    buf += data.toString('utf8');
    let inst;
    while ((inst = parseInstruction(buf, 0))) {
      if (inst.opcode === 'args') {
        const names = inst.args; // [version, name1, name2, ...]
        guacd.write(enc('size', settings.width, settings.height, settings.dpi));
        guacd.write(enc('audio'));
        guacd.write(enc('video'));
        guacd.write(enc('image'));
        const values = names.map((n, i) => (i === 0 ? n : (settings[n] ?? ''))); // echo version at index 0
        guacd.write(enc('connect', ...values));
        buf = buf.slice(inst.end);
      } else if (inst.opcode === 'ready') {
        ready = true;
        guacd.setTimeout(0); // 핸드셰이크 완료 — 연결 타임아웃 해제(정상 세션은 오래 유휴 가능)
        // forward 'ready' + anything buffered after it to the browser client
        if (ws.readyState === ws.OPEN) ws.send(buf);
        buf = '';
        break;
      } else if (inst.opcode === 'error') {
        // guacd가 핸드셰이크 중 error를 보내면(연결 실패 등) 조용히 무시하면 ws가 영영 hang한다.
        // 브라우저에 알리고 종료한다.
        try { ws.close(1011, `guacd: ${(inst.args && inst.args[0]) || 'error'}`); } catch { /* */ }
        try { guacd.destroy(); } catch { /* */ }
        return;
      } else {
        buf = buf.slice(inst.end); // ignore other handshake instructions
      }
    }
    // 파싱 가능한 명령이 없는데 버퍼가 상한을 넘으면(오작동/오염 스트림) 무한 증식 차단.
    if (!ready && buf.length > MAX_HANDSHAKE_BUF) {
      try { ws.close(1011, 'guacd 핸드셰이크 오류(버퍼 초과)'); } catch { /* */ }
      try { guacd.destroy(); } catch { /* */ }
    }
  });

  guacd.on('error', (err) => { try { ws.close(1011, `guacd: ${err.message}`); } catch { /* */ } });
  guacd.on('close', () => { try { ws.close(); } catch { /* */ } });

  ws.on('message', (msg) => { try { guacd.write(msg.toString()); } catch { /* */ } });
  ws.on('close', () => { try { guacd.end(); } catch { /* */ } });
  ws.on('error', () => { try { guacd.destroy(); } catch { /* */ } }); // ws 오류에도 소켓 정리
}
