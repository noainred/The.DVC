/** guacd 소켓 열기(48회차 F2) — 판정은 guacdFlags.js(순수). */
import net from 'node:net';
import tls from 'node:tls';
import { wanTlsConnectOptions } from '../util/resilientFetch.js';
import { normalizeGuacdFlags } from './guacdFlags.js';

export { normalizeGuacdFlags, isLoopbackGuacdHost, guacdPlaintextRemote, rdpIgnoreCertArg } from './guacdFlags.js';

/**
 * guacd 소켓을 연다. 반환 `{ socket, readyEvent }` — 핸드셰이크 첫 명령(select)은 readyEvent 뒤에 쓴다
 * (평문 'connect' · TLS 'secureConnect'). TLS 는 검증을 끄지 않는다(WAN_TLS_INSECURE 와 무관 — 이 구간에 RDP 비밀번호가 흐른다).
 */
export function openGuacdSocket(g, deps = {}) {
  const o = normalizeGuacdFlags(g);
  const port = Number(o.port) || 4822;
  const host = String(o.host ?? '').trim();
  if (!o.tls) return { socket: (deps.netConnect || net.connect)(port, host), readyEvent: 'connect' };
  const opts = { ...wanTlsConnectOptions({ verify: true }), host, port };
  if (!net.isIP(host)) opts.servername = host;   // SNI · 이름 검증(IP 면 IP SAN 으로 검증된다)
  return { socket: (deps.tlsConnect || tls.connect)(opts), readyEvent: 'secureConnect' };
}
