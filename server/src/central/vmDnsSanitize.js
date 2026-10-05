/**
 * v2.695: 엣지가 올린 VM `dns` 필드(soapClient.vmDns 모양)를 아는 필드만 담아 좁힌다.
 *
 * 인벤토리 정제(`routes/central.js sanitizeInventoryList`)는 모르는 필드를 그대로 통과시킨다 — 새 필드를 화면이 읽기
 * 시작하면 그 필드가 객체·글자 혼합으로 와도 화면이 죽지 않게 여기서 모양을 고정한다(v2.611 CEN2611-01 규약).
 * 모양이 아니면 null(모름)이다 — 빈 배열('DNS 없음')로 바꾸지 않는다.
 */
import { capStr } from '../util/capStr.js';

const LIST_MAX = 8;
const NIC_MAX = 8;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const isAddr = (v) => typeof v === 'string' && v.length <= 45 && (IPV4.test(v) || (/^[0-9a-f:.]+$/i.test(v) && v.includes(':')));
const str = (v) => (typeof v === 'string' && v.trim() ? capStr(v.trim(), 253) : null);
const bool = (v) => (v === true || v === false ? v : null);
const addrs = (v) => (Array.isArray(v) ? [...new Set(v.filter(isAddr))].slice(0, LIST_MAX) : []);
const names = (v) => (Array.isArray(v) ? [...new Set(v.map(str).filter(Boolean))].slice(0, LIST_MAX) : []);
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

function cfg(x) {
  if (!isObj(x)) return null;
  return { servers: addrs(x.servers), domain: str(x.domain), search: names(x.search), dhcp: bool(x.dhcp), hostName: str(x.hostName) };
}

/** @returns {object|null} 좁힌 값(null = 모름) */
export function sanitizeVmDns(d) {
  if (!isObj(d)) return null;
  const stack = cfg(d.stack);
  const nics = (Array.isArray(d.nics) ? d.nics : []).slice(0, NIC_MAX).filter(isObj).map((n) => ({
    network: str(n.network), mac: str(n.mac), servers: addrs(n.servers), domain: str(n.domain), search: names(n.search), dhcp: bool(n.dhcp),
  }));
  const servers = addrs(d.servers);
  if (!stack && !nics.length && !servers.length) return null;
  return { servers, stack, nics };
}
