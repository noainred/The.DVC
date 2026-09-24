/**
 * NSX-via-proxy — 다른 법인/사이트에 있어 직접 닿지 않는 NSX Manager를, 이미 등록된
 * HAProxy(중계 서버)를 통해 연결한다. SSH/RDP 원격접속과 동일한 매핑 메커니즘을 재사용:
 * 프록시에 NSX:443 TCP 패스스루 프론트엔드를 만들고, NSX 클라이언트는 그 프록시
 * frontend(proxyHost:publicPort)로 다이얼한다(TLS는 NSX와 직접 — 자가서명 허용).
 */

import { getProxyById, listMappings, addMapping } from '../proxy/registry.js';
import { provision } from '../proxy/provision.js';
import { splitHostPort } from '../util/hostPort.js';

/**
 * "https://nsx.corp:443/..." → { hostname, port }. 포트 미지정 시 443.
 * v2.603(LEFT2603-02): 예전 구현은 IPv6 를 '[fd00::1]'(대괄호 포함)로 돌려 addMapping 의 SAFE_TARGET_HOST 가
 * 거부했고 조용히 직접 연결로 떨어졌다. 공용 파서로 대괄호 없는 주소를 준다(HAProxy 설정 줄은 deploy.js 가 ipv6@ 로 쓴다).
 */
export function parseHostPort(host) {
  const hp = splitHostPort(host);
  return hp ? { hostname: hp.host, port: hp.port } : { hostname: '', port: 443 };
}

/**
 * NSX 매니저가 proxyId를 가지면, 그 프록시에 NSX:443 TCP 매핑을 보장(없으면 생성+프로비저닝)하고
 * 다이얼 주소 { proxyHost, publicPort, mappingId }를 반환한다. proxyId가 없거나 프록시에
 * frontend 주소(proxyHost)가 없으면 null(=직접 연결)로 폴백한다.
 */
export async function ensureNsxDial(mgr) {
  if (!mgr?.proxyId) return null;
  const proxy = getProxyById(mgr.proxyId);
  if (!proxy?.proxyHost) return null; // 프록시 frontend 주소 미설정 → 직접 연결
  const { hostname, port } = parseHostPort(mgr.host);
  let m = listMappings().find((x) => (x.proxyId || 'default') === proxy.id
    && x.protocol === 'nsx' && x.targetHost === hostname && Number(x.targetPort) === port);
  if (!m) {
    const r = addMapping({ name: `NSX ${hostname}:${port}`, protocol: 'nsx', targetHost: hostname, targetPort: port, proxyId: proxy.id });
    if (!r.ok) return null;
    m = r.mapping;
    try { await provision(m); } catch { /* best-effort: 다음 수집 때 재시도 */ }
  }
  return { proxyHost: proxy.proxyHost, publicPort: m.publicPort, mappingId: m.id };
}
