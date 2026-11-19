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
  // 76회차 F4: '[fd00::5]' 처럼 대괄호로 적은 IPv6 는 벗긴다 — net/tls.connect 는 대괄호째 이름으로 찾아 ENOTFOUND 였다
  //   (설정 화면 경고 판정 isLoopbackGuacdHost 는 대괄호를 벗겨 '[::1]' 을 같은 호스트로 보는데 접속은 실패했다).
  const raw = String(o.host ?? '').trim();
  const inner = /^\[(.+)\]$/.exec(raw)?.[1];
  const host = inner && net.isIP(inner) === 6 ? inner : raw;
  if (!o.tls) return { socket: (deps.netConnect || net.connect)(port, host), readyEvent: 'connect' };
  const opts = { ...wanTlsConnectOptions({ verify: true }), host, port };
  if (!net.isIP(host)) opts.servername = host;   // SNI · 이름 검증(IP 면 IP SAN 으로 검증된다)
  return { socket: (deps.tlsConnect || tls.connect)(opts), readyEvent: 'secureConnect' };
}
