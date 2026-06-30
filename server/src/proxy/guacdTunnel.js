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
  let ready = false;
  let buf = '';

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
        // forward 'ready' + anything buffered after it to the browser client
        if (ws.readyState === ws.OPEN) ws.send(buf);
        buf = '';
        break;
      } else {
        buf = buf.slice(inst.end); // ignore other handshake instructions
      }
    }
  });

  guacd.on('error', (err) => { try { ws.close(1011, `guacd: ${err.message}`); } catch { /* */ } });
  guacd.on('close', () => { try { ws.close(); } catch { /* */ } });

  ws.on('message', (msg) => { try { guacd.write(msg.toString()); } catch { /* */ } });
  ws.on('close', () => { try { guacd.end(); } catch { /* */ } });
}
