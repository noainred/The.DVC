/**
 * test/_fakeBareosDirector.js — 테스트용 **가짜 Bareos Director**(콘솔 쪽 서버).
 *
 * 클라이언트 코드(src/bareos/console.js)를 베끼지 않고 Director C++ 원본의 순서를 따로 옮겼다 — 같은 실수를 두 번 하지 않게:
 *  - socket_server.cc: 인증 성공 → `1000 OK: <dir> Version …`(SendResponseMessage: 코드 + 0x1E + 본문) → `1002`(안내).
 *  - cram_md5.cc: Director 가 먼저 `auth cram-md5 <chal> ssl=N` 을 보내고, 응답이 Bareos/호환 base64 둘 중 하나와 같으면
 *    `1000 OK auth`, 아니면 `1999 Authorization failed.`. 이어서 상대의 챌린지에 응답한다(compatible_ = 'cram-md5c' 일 때만).
 *  - hello.cc: `Hello %127s calling version %127s` — 18.2 미만이면 거부.
 *  - ua_server.cc: API 모드면 명령마다 앞서 BNET_MAIN_PROMPT, 아니면 명령 뒤 BNET_EOD.
 *  - base64.cc BinToBase64: uint32 레지스터 — 아래 refBase64 는 BigInt 로 그대로 옮긴 **독립 참조 구현**이다.
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const DIG = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const U32 = (1n << 32n) - 1n;

/** core/src/lib/base64.cc BinToBase64 를 BigInt(uint32 마스크)로 옮긴 참조 구현. */
export function refBase64(bin, compatible) {
  let reg = 0n; let rem = 0; let out = '';
  for (let i = 0; i < bin.length;) {
    if (rem < 6) {
      reg = (reg << 8n) & U32;
      const b = bin[i++];
      if (compatible) reg |= BigInt(b);
      else reg = (reg | (BigInt(b >= 128 ? b - 256 : b) & U32)) & U32; // (int8_t) → uint32 부호 확장
      rem += 8;
    }
    const save = reg;
    reg >>= BigInt(rem - 6);
    out += DIG[Number(reg & 0x3fn)];
    reg = save;
    rem -= 6;
  }
  if (rem) {
    const mask = (1n << BigInt(rem)) - 1n;
    out += compatible ? DIG[Number((reg & mask) << BigInt(6 - rem))] : DIG[Number(reg & mask)];
  }
  return out;
}

const md5hex = (pw) => crypto.createHash('md5').update(Buffer.from(pw, 'utf8')).digest('hex');
const hmac = (chal, key) => crypto.createHmac('md5', Buffer.from(key, 'ascii')).update(Buffer.from(chal, 'utf8')).digest();

function frame(s) {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8');
  const h = Buffer.allocUnsafe(4); h.writeInt32BE(b.length, 0);
  return Buffer.concat([h, b]);
}
function signal(code) { const h = Buffer.allocUnsafe(4); h.writeInt32BE(code, 0); return h; }

/**
 * @param {object} o
 * @param {string} o.name           콘솔 이름
 * @param {string} o.password       콘솔 비밀번호(평문)
 * @param {boolean} [o.tls=true]    TLS-PSK 로 받는다
 * @param {(cmd:string, st:object) => (object|string|null|{raw:Buffer[]})} o.handle  명령 처리(JSON 객체면 JSON-RPC result 로 감싼다)
 * @param {string} [o.mode]         'ok' | 'wrong-dir-secret'(역챌린지 응답을 틀리게 — 가짜 Director) | 'pam' | 'silent-after-hello' | 'no-info' | 'drip'
 * @returns {Promise<{ port:number, close:()=>Promise<void>, log:string[], hellos:string[], identities:string[] }>}
 */
export async function startFakeDirector(o) {
  const key = md5hex(o.password);
  const log = []; const hellos = []; const identities = [];
  const mode = o.mode || 'ok';
  const onConn = (sock) => {
    let buf = Buffer.alloc(0);
    const q = []; let waiter = null;
    const st = { api: false, step: 'hello', sock };
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const h = buf.readInt32BE(0);
        if (h <= 0) { buf = buf.subarray(4); q.push({ sig: h }); continue; }
        if (buf.length < 4 + h) break;
        q.push({ data: buf.subarray(4, 4 + h).toString('utf8') }); buf = buf.subarray(4 + h);
      }
      while (q.length && waiter) { const w = waiter; waiter = null; w(q.shift()); }
    });
    const next = () => new Promise((r) => { if (q.length) r(q.shift()); else waiter = r; });
    (async () => {
      const hello = await next();
      hellos.push(hello.data || '');
      const hm = /^Hello (\S+) calling version (\S+)/.exec(hello.data || '');
      if (!hm || hm[1].replace(/\x01/g, ' ') !== o.name) { sock.write(frame('1999 You are not authorized.\n')); sock.end(); return; }
      const [maj, min] = hm[2].split('.').map(Number);
      if (!(maj > 18 || (maj === 18 && min >= 2))) { sock.end(); return; }
      if (mode === 'silent-after-hello') return; // 응답하지 않는다(시한 시험)
      // ① Director 챌린지
      const chal = `<${crypto.randomInt(1e9, 2e9)}.${Math.floor(Date.now() / 1000)}@bareos-dir>`;
      sock.write(frame(`auth cram-md5 ${chal} ssl=2\n`));
      const resp = (await next()).data || '';
      const d = hmac(chal, key);
      if (resp !== refBase64(d, true) && resp !== refBase64(d, false)) {
        sock.write(frame('1999 Authorization failed.\n')); sock.write(signal(-4)); sock.end(); log.push('auth-failed'); return;
      }
      sock.write(frame('1000 OK auth\n'));
      // ② 상대 챌린지에 응답
      const cm = /^auth cram-md5(c?) (\S+) ssl=(\d+)/.exec((await next()).data || '');
      if (!cm) { sock.end(); return; }
      const compat = cm[1] === 'c';
      let answer = refBase64(hmac(cm[2], key), compat);
      if (mode === 'wrong-dir-secret') answer = refBase64(hmac(cm[2], md5hex('other-secret')), compat);
      sock.write(frame(Buffer.concat([Buffer.from(answer, 'ascii'), Buffer.from([0])])));
      const ack = (await next()).data || '';
      if (ack !== '1000 OK auth\n') { log.push('client-rejected-director'); sock.end(); return; }
      if (mode === 'pam') { sock.write(frame('1001\x1e')); return; }
      sock.write(frame('1000\x1eOK: bareos-dir Version: 25.0.4 (01 July 2026)\n'));
      if (mode !== 'no-info') sock.write(frame('1002\x1eBareos community build (UNSUPPORTED)\nYou are logged in as: portal'));
      // ③ 명령 루프
      for (;;) {
        if (st.api) sock.write(signal(-18)); // BNET_MAIN_PROMPT
        const f = await next();
        if (f.sig === -4) { sock.end(); return; }
        if (f.sig !== undefined) continue;
        const cmd = f.data;
        log.push(cmd);
        if (cmd.startsWith('.api json')) { st.api = true; continue; }
        if (mode === 'drip') { // 개행 없이 조금씩 계속 보낸다(절대 시한 시험)
          const t = setInterval(() => { try { sock.write(frame('x')); } catch { clearInterval(t); } }, 50);
          sock.on('close', () => clearInterval(t));
          return;
        }
        const r = await o.handle(cmd, st);
        if (r && r.raw) { for (const b of r.raw) sock.write(b); }
        else if (r && r.error) sock.write(frame(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: 1, message: 'failed', data: { result: {}, messages: { error: [].concat(r.error) } } } })));
        else if (r !== undefined && r !== null) sock.write(frame(typeof r === 'string' ? r : JSON.stringify({ jsonrpc: '2.0', id: null, result: r })));
        if (!st.api) sock.write(signal(-1));
      }
    })().catch(() => { try { sock.destroy(); } catch { /* */ } });
  };
  const useTls = o.tls !== false;
  const server = useTls
    ? tls.createServer({
      pskCallback: (_s, identity) => { identities.push(identity); return identity === `R_CONSOLE\x1e${o.name}` ? Buffer.from(key, 'ascii') : null; },
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384:PSK-AES256-GCM-SHA384:PSK-AES128-GCM-SHA256:PSK-CHACHA20-POLY1305',
      minVersion: 'TLSv1.2',
    }, onConn)
    : net.createServer(onConn);
  server.on('tlsClientError', () => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port, log, hellos, identities,
    close: () => new Promise((r) => { server.close(() => r()); setTimeout(r, 200).unref?.(); }),
  };
}

/** 테스트 공용: 루프백 허용 의존성(실제 코드는 ssrfLookup·ipBlockReason 을 쓴다). */
export const LOOPBACK_DEPS = Object.freeze({ blockReason: () => null, lookup: undefined });
