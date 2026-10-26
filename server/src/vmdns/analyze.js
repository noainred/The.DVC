/**
 * vmdns/analyze.js — 특수 기능 'VM DNS 설정 확인'(도구 키 `vm-dns`, v2.696)의 **판정 단일 소스**(순수 — I/O 없음).
 *
 * 입력은 인벤토리 스냅샷의 VM `dns` 필드(v2.695 `vcenter/soapClient.js vmDns`)다. vCenter·게스트 왕복은 0 이다.
 *   vm.dns = null                     → VMware Tools 가 보고하지 않음 = **모름**(unknown)
 *   'dns' in vm === false             → 그 VM 을 보낸 수집기가 2.695 이전이거나(REST 폴백 포함) 필드를 싣지 않음 = **미수집**(notCollected)
 *   vm.dns = { servers, stack, nics } → 보고함(reported)
 * 모름·미수집을 '정상' 에도 '이상' 에도 넣지 않는다 — 따로 센다.
 *
 * ── 판정 ─────────────────────────────────────────────────────────────────────
 *  · VM 별 서버 목록: `dns.stack.servers` 가 있으면 그것(OS 가 실제로 쓰는 값), 없으면 `dns.servers`.
 *  · 정체: 잘 알려진 공인 DNS 표 → VM(스냅샷 ipAddresses) → ESXi 호스트(mgmtIp·IP 이름) → IP 대장 분류기(공인/사설) → 그 밖 unknown.
 *    v2.785(GN N-B1): 공인 표가 VM·호스트 소유보다 먼저다(애니캐스트 공인 resolver 를 법인 VM 이 '소유' 할 일은 없다) ·
 *    미수집 VM(dns 키 없음 — 2.695 이전 엣지)은 대표 IP(ipAddress)만 소유로 본다(그 수집기는 dnsConfig 의 DNS 주소까지 ipAddresses 에 실었다).
 *    루프백·링크 로컬 등 특수 주소는 소유 색인에 넣지 않는다.
 *    지어내지 않는다 — 소유자를 못 찾으면 unknown 이다. 범위 밖 법인의 소유 VM·호스트 이름은 가린다(who.name = null).
 *  · 다른 법인 DNS: 서버 주소의 소유 VM·호스트 vCenter 집합에 그 DNS 를 쓰는 VM 의 vCenter 가 없다.
 *  · 정책(`vm-dns-policy.json`): IPv6 서버는 unsupported(정책 항목이 IPv4·CIDR 만이라 판정할 수 없다 — v2.785 GN N-B2) →
 *    그 법인의 승인 목록에 맞으면 approved(명시 승인이 이긴다) → 공인이고 publicUnapproved 면
 *    unapproved → 목록이 비면 none(판정 안 함) → 그 밖 unapproved.
 *  · 로컬 스텁(v2.785 GN N-I2): 쓰는 서버가 전부 루프백(127.0.0.53 · ::1 등 — systemd-resolved 같은 게스트 안 스텁)인 VM 은
 *    실제 상위 DNS 를 모른다 → 'local-stub' 으로 따로 세고 판정은 local(위반 아님) · DNS 1개·매트릭스에서 뺀다.
 *  · NIC ≠ OS: 스택 서버 집합과 NIC 서버 합집합이 다르다(둘 다 1개 이상일 때만).
 *  · DHCP: 스택 dhcp, 없으면 NIC 중 하나라도 true → true, 전부 false 로 읽혔으면 false, 그 밖 null(모름).
 */
import net from 'node:net';
import { ipToNum, numToIp, strictIpv4Num, cidrMatch } from '../util/ipv4.js';

/** 잘 알려진 공인 DNS — 이름은 사실만(운영 주체). */
export const PUBLIC_DNS = Object.freeze({
  '8.8.8.8': 'Google Public DNS', '8.8.4.4': 'Google Public DNS',
  '1.1.1.1': 'Cloudflare', '1.0.0.1': 'Cloudflare',
  '9.9.9.9': 'Quad9', '149.112.112.112': 'Quad9',
  '208.67.222.222': 'OpenDNS', '208.67.220.220': 'OpenDNS',
  '168.126.63.1': 'KT', '168.126.63.2': 'KT',
  '164.124.101.2': 'LG U+', '164.124.107.9': 'LG U+',
  '210.220.163.82': 'SK브로드밴드', '219.250.36.130': 'SK브로드밴드',
});

export const SERVERS_MAX = 300;      // 응답 서버 목록 상한(사용 VM 많은 순)
export const MATRIX_COLS = 8;        // 법인 × DNS 매트릭스 열 수
export const TOP_NAMES = 12;         // 도메인·검색 접미사 상위
export const FIRST_VMS = 3;          // 서버마다 예시 VM 이름 수
const LIST_MAX = 8;                  // VM 하나의 서버 주소 상한(수집기와 같다)

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (v, n = 253) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const COLL = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => COLL.compare(String(a ?? ''), String(b ?? ''));

/**
 * 주소 정규화 — IPv4 는 정규형(`010.0.0.1` → `10.0.0.1`), IPv6 는 소문자. 주소 모양이 아니면 null.
 * ⚠ IPv6 판정은 글자 집합·길이만 본다(수집기 vmDns 와 같은 기준).
 */
// 같은 주소가 VM 수천 대에 반복된다 — 파싱 결과를 기억한다(상한을 넘으면 비운다: 메모리 상한 · 정확성 영향 없음).
const _canon = new Map();
const CANON_MAX = 50_000;
export function canonAddr(v) {
  if (typeof v !== 'string') return null;
  const hit = _canon.get(v);
  if (hit !== undefined) return hit;
  const s = v.trim();
  let out = null;
  if (s && s.length <= 45) {
    const n = ipToNum(s);
    if (n != null) out = numToIp(n);
    else if (s.includes(':') && /^[0-9a-f:.]+$/i.test(s)) out = s.toLowerCase();
  }
  if (v.length <= 64) { if (_canon.size >= CANON_MAX) _canon.clear(); _canon.set(v, out); }
  return out;
}

/**
 * IPv6 문자열 → 16비트 8개(형식이 아니면 null). 끝의 점 표기 IPv4(`::ffff:1.2.3.4`)도 받는다. 순수(I/O 없음).
 * v2.785(GN N-B4): 특수 주소 판정을 글자 일치가 아니라 값으로 하려고 둔다.
 */
function v6Words(ip) {
  let s = String(ip).toLowerCase();
  if (s.length > 45 || net.isIP(s) !== 6) return null;
  const tail = s.slice(s.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const n = ipToNum(tail);
    if (n == null) return null;
    s = `${s.slice(0, s.length - tail.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const words = (x) => (x ? x.split(':').map((h) => parseInt(h, 16)) : []);
  const a = words(halves[0]);
  if (halves.length === 1) return a.length === 8 ? a : null;
  const b = words(halves[1]);
  const fill = 8 - a.length - b.length;
  if (fill < 1) return null;
  const out = [...a, ...new Array(fill).fill(0), ...b];
  return out.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? out : null;
}

/** 특수 주소 — 'loopback' | 'link-local' | 'unspecified' | 'multicast' | 'reserved' | 'ipv6' | null. */
// v2.785(GN N-B4): IPv6 는 값으로 판정한다 — 예전엔 '::1'·'::' 글자 일치와 fe8x~febx 만 봐서 '0:0:0:0:0:0:0:1'·'::ffff:127.0.0.1'
//   (IPv4 사상 루프백)이 'ipv6' 가 되어 도달성 점검의 'local' 건너뜀을 우회했다(듀얼스택 중앙이 자기 루프백 53 에 질의).
//   IPv4 사상(::ffff:a.b.c.d)은 IPv4 판정을 따르고(특수가 아니면 'ipv6'), ff00::/8 은 멀티캐스트다.
export function specialOf(ip) {
  if (typeof ip !== 'string') return null;
  if (ip.includes(':')) {
    const w = v6Words(ip);
    if (!w) return 'ipv6';     // 형식 밖 — 예전처럼 일반 IPv6 로 둔다(점검 대상 판정은 바뀌지 않는다)
    if (w.every((x) => x === 0)) return 'unspecified';
    if (w[7] === 1 && w.slice(0, 7).every((x) => x === 0)) return 'loopback';
    if (w[5] === 0xffff && w.slice(0, 5).every((x) => x === 0)) return specialOf(numToIp(w[6] * 65536 + w[7])) || 'ipv6';
    if ((w[0] & 0xffc0) === 0xfe80) return 'link-local';
    if ((w[0] & 0xff00) === 0xff00) return 'multicast';
    return 'ipv6';
  }
  const n = ipToNum(ip);
  if (n == null) return null;
  const a = n >>> 24;
  if (a === 127) return 'loopback';
  if (a === 0) return 'unspecified';
  if ((n >>> 16) === ((169 << 8) | 254)) return 'link-local';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  return null;
}

/** 주소 목록 정규화(중복 제거·상한·순서 보존). */
function addrList(v) {
  const out = [];
  for (const x of Array.isArray(v) ? v : []) {
    const a = canonAddr(x);
    if (a && !out.includes(a) && out.length < LIST_MAX) out.push(a);
  }
  return out;
}
function nameList(v) {
  const out = [];
  for (const x of Array.isArray(v) ? v : []) {
    const s = str(x);
    if (s && !out.includes(s) && out.length < LIST_MAX) out.push(s);
  }
  return out;
}

/**
 * VM 한 대의 DNS 상태 — 판정 입력. 스냅샷 원소를 직접 믿지 않고 모양을 좁힌다(엣지 정제를 통과하지 않은 경로 대비).
 * @returns {{state:'reported'|'unknown'|'notCollected', servers:string[], osServers:string[]|null, nicServers:string[]|null,
 *   domain:string|null, search:string[], dhcp:boolean|null, mismatch:boolean, nics:object[]}}
 */
export function vmDnsInfo(vm) {
  const empty = { servers: [], osServers: null, nicServers: null, domain: null, search: [], dhcp: null, mismatch: false, nics: [] };
  if (!vm || typeof vm !== 'object' || !Object.hasOwn(vm, 'dns')) return { state: 'notCollected', ...empty };
  const d = vm.dns;
  if (!isObj(d)) return { state: 'unknown', ...empty };
  const stack = isObj(d.stack) ? d.stack : null;
  const nics = (Array.isArray(d.nics) ? d.nics : []).filter(isObj).slice(0, 8).map((n) => ({
    network: str(n.network), mac: str(n.mac, 64), servers: addrList(n.servers), domain: str(n.domain), search: nameList(n.search),
    dhcp: n.dhcp === true || n.dhcp === false ? n.dhcp : null,
  }));
  const osServers = stack ? addrList(stack.servers) : null;
  const nicUnion = [];
  for (const n of nics) for (const a of n.servers) if (!nicUnion.includes(a) && nicUnion.length < LIST_MAX) nicUnion.push(a);
  const nicServers = nics.length ? nicUnion : null;
  const servers = osServers && osServers.length ? osServers : addrList(d.servers);
  const domain = (stack && str(stack.domain)) || (nics[0] && nics[0].domain) || null;
  const search = [];
  for (const s of [...(stack ? nameList(stack.search) : []), ...nics.flatMap((n) => n.search)]) {
    if (!search.includes(s) && search.length < LIST_MAX) search.push(s);
  }
  let dhcp = stack && (stack.dhcp === true || stack.dhcp === false) ? stack.dhcp : null;
  if (dhcp == null && nics.length) {
    if (nics.some((n) => n.dhcp === true)) dhcp = true;
    else if (nics.every((n) => n.dhcp === false)) dhcp = false;
  }
  const mismatch = !!(osServers && osServers.length && nicServers && nicServers.length
    && (osServers.length !== nicServers.length || osServers.some((a) => !nicServers.includes(a))));
  return { state: 'reported', servers, osServers, nicServers, domain, search, dhcp, mismatch, nics };
}

/** VM 의 '쓰는 서버' 목록(변경 이력 비교용). 모름·미수집이면 null — '빈 DNS 로 바뀜' 으로 기록하지 않게. */
export function effectiveServers(vm) {
  const i = vmDnsInfo(vm);
  return i.state === 'reported' ? i.servers : null;
}

/** 정책 항목(정규형 IPv4 또는 CIDR) 과 서버 주소의 일치. IPv6 서버는 IPv4 항목과 맞지 않는다. */
export function policyEntryMatches(ip, entry) {
  const n = strictIpv4Num(ip);
  if (typeof n !== 'number') return false;
  return cidrMatch(n, entry) === true;
}

/**
 * 한 VM(vCenter V)이 서버 S 를 쓸 때의 정책 판정.
 * 명시 승인이 먼저다 — 관리자가 공인 주소를 그 법인 목록에 넣었다면 그 의도를 따른다.
 */
export function policyVerdict(policy, vcenterId, server) {
  // v2.785(GN N-B2): IPv6 서버는 판정하지 않는다('unsupported' — 위반으로 세지 않음). 정책 항목은 IPv4·CIDR 만 받으므로(policy.js
  //   checkPolicyEntry · 웹 사본) 예전처럼 '목록 있음 → unapproved' 로 두면 관리자가 해소할 방법 없이 늘 비승인이었다.
  if (typeof strictIpv4Num(server?.ip) !== 'number') return 'unsupported';
  const list = (policy && isObj(policy.corps) && Object.hasOwn(policy.corps, vcenterId) && Array.isArray(policy.corps[vcenterId]))
    ? policy.corps[vcenterId] : [];
  if (list.length && list.some((e) => policyEntryMatches(server.ip, e))) return 'approved';
  if (server.kind === 'public' && policy?.publicUnapproved !== false) return 'unapproved';
  if (!list.length) return 'none';
  return 'unapproved';
}

// v2.785(GN N-B2·N-I2): 판정하지 않은 값(local · unsupported)은 판정한 값이 하나라도 있으면 서버 집계에서 뺀다
//   ('비승인 + 로컬 스텁' 을 '법인마다 다름' 으로 적지 않게 — 그 문구는 승인·비승인이 섞였다는 뜻이다).
const NOT_JUDGED = new Set(['local', 'unsupported']);
const aggPolicy = (set) => {
  const all = [...set];
  const judged = all.filter((x) => !NOT_JUDGED.has(x));
  const use = judged.length ? judged : all;
  return use.length === 0 ? 'none' : use.length === 1 ? use[0] : 'mixed';
};

/** v2.785(GN N-I2): 쓰는 서버가 전부 루프백인가(게스트 안 로컬 DNS 스텁 — 실제 상위 DNS 는 보이지 않는다). */
export function isLocalStub(info) {
  return !!info && info.state === 'reported' && Array.isArray(info.servers) && info.servers.length > 0
    && info.servers.every((ip) => specialOf(ip) === 'loopback');
}

/** 주소 → 소유 VM·호스트 색인(스냅샷 전체 — 범위 밖도 포함. 가림은 표시 단계에서). */
function ownerIndex(snap) {
  const vms = new Map();
  const hosts = new Map();
  for (const vm of Array.isArray(snap?.vms) ? snap.vms : []) {
    if (!vm || typeof vm !== 'object') continue;
    const ips = new Set();
    // v2.785(GN N-B1): 미수집 VM(dns 키 없음)은 2.695 이전 수집기가 보낸 것이다 — 그 수집기는 GuestNicInfo.dnsConfig 의 DNS 서버 주소까지
    //   ipAddresses 에 실었다(ipam.md v2.695). 그 목록을 소유로 쓰면 8.8.8.8·사내 물리 AD 가 엉뚱한 VM 의 것이 되어 공인·비승인 판정이
    //   사라지고 '다른 법인 DNS' 거짓 양성이 났다. 대표 IP(ipAddress = 첫 NIC IP — 스키마상 ipAddress 가 dnsConfig 보다 앞)만 쓴다.
    const src = Object.hasOwn(vm, 'dns') ? [vm.ipAddress, ...(Array.isArray(vm.ipAddresses) ? vm.ipAddresses : [])] : [vm.ipAddress];
    for (const x of src) {
      const a = canonAddr(x);
      if (a && !a.includes(':') && !specialOf(a)) ips.add(a);   // 루프백·링크 로컬은 어느 VM 의 것도 아니다
    }
    for (const a of ips) { const l = vms.get(a); if (l) l.push(vm); else vms.set(a, [vm]); }
  }
  for (const h of Array.isArray(snap?.hosts) ? snap.hosts : []) {
    if (!h || typeof h !== 'object') continue;
    const ips = new Set();
    for (const x of [h.mgmtIp, h.name]) { const a = canonAddr(x); if (a && !a.includes(':') && !specialOf(a)) ips.add(a); }
    for (const a of ips) { const l = hosts.get(a); if (l) l.push(h); else hosts.set(a, [h]); }
  }
  return { vms, hosts };
}

/**
 * 공통 색인 — VM 별 판정과 서버 별 집계. 화면 API 셋이 같은 결과를 쓴다(판정 복제 금지).
 * @param {object} o
 * @param {object} o.snap        인벤토리 스냅샷
 * @param {object} o.policy      { corps:{vcId:[...]}, publicUnapproved }
 * @param {Function} [o.classify] IPv4 문자열 → 'public'|'private'(IP 대장 분류기). 없으면 RFC1918 만 사설로 본다.
 * @param {Set|null} [o.allowed] 범위(scopedVcenterIds) — null 이면 전체
 * @param {string} [o.vcenterId] 화면의 vCenter 필터
 * @param {Function} [o.ledgerOf] ip → { scanned, hostname, port53, manual, deviceType } | null (전체 범위에만 넘긴다)
 */
export function buildDnsIndex({ snap, policy = {}, classify = null, allowed = null, vcenterId = '', ledgerOf = null } = {}) {
  const vcList = (Array.isArray(snap?.vcenters) ? snap.vcenters : []).filter((v) => v && typeof v === 'object' && v.id != null);
  const vcName = new Map(vcList.map((v) => [String(v.id), String(v.name || v.id)]));
  const inScope = (id) => !allowed || allowed.has(String(id));
  const vcFilter = typeof vcenterId === 'string' && vcenterId ? vcenterId : '';
  const owners = ownerIndex(snap);
  const cls = (ip) => {
    if (specialOf(ip)) return 'other';
    if (typeof classify === 'function') { try { return classify(ip) === 'public' ? 'public' : 'private'; } catch { /* 폴백 */ } }
    const n = ipToNum(ip);
    if (n == null) return 'other';
    const a = n >>> 24; const b = (n >>> 16) & 255;
    return (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) ? 'private' : 'public';
  };

  // ── VM 단위 ─────────────────────────────────────────────────────────────
  const vms = [];                         // 범위 안 · 필터 안 · 템플릿 제외
  const perVc = new Map();                // 범위 안 vCenter 별 개수(필터와 무관 — 선택기용)
  for (const v of vcList) if (inScope(v.id)) perVc.set(String(v.id), { vms: 0, reported: 0, unknown: 0, notCollected: 0 });
  for (const vm of Array.isArray(snap?.vms) ? snap.vms : []) {
    if (!vm || typeof vm !== 'object' || vm.template === true) continue;
    const vc = String(vm.vcenterId ?? '');
    if (!inScope(vc)) continue;
    const info = vmDnsInfo(vm);
    const c = perVc.get(vc) || (perVc.set(vc, { vms: 0, reported: 0, unknown: 0, notCollected: 0 }), perVc.get(vc));
    c.vms += 1; c[info.state] += 1;
    if (vcFilter && vc !== vcFilter) continue;
    vms.push({ vm, vc, info });
  }

  // ── 서버 단위 ───────────────────────────────────────────────────────────
  const servers = new Map();
  const serverOf = (ip) => {
    let s = servers.get(ip);
    if (s) return s;
    // v2.785(GN N-B1): 잘 알려진 공인 DNS 표를 VM·호스트 소유보다 먼저 본다 — 공인 resolver 는 법인 소유가 아니므로 소유 집합도 비운다
    //   (예전 순서 VM → 호스트 → 공인 표에서는 오염된 스냅샷 IP 하나로 8.8.8.8 이 'VM' · '다른 법인 DNS' 가 되었다).
    const known = Object.hasOwn(PUBLIC_DNS, ip);
    const ownVms = known ? [] : (owners.vms.get(ip) || []);
    const ownHosts = known ? [] : (owners.hosts.get(ip) || []);
    const special = specialOf(ip);
    let kind = 'unknown'; let who = null; let publicName = null; let owner = null; let ownerKind = null;
    const pick = (list) => list.find((x) => inScope(x.vcenterId) && x.powerState === 'POWERED_ON') || list.find((x) => inScope(x.vcenterId)) || list[0];
    if (known) { kind = 'public'; publicName = PUBLIC_DNS[ip]; }
    else if (ownVms.length) { kind = 'vm'; owner = pick(ownVms); ownerKind = 'VM'; }
    else if (ownHosts.length) { kind = 'host'; owner = pick(ownHosts); ownerKind = 'ESXi 호스트'; }
    const c = cls(ip);
    if (kind === 'unknown' && c === 'public') kind = 'public';
    if (owner) {
      const ovc = String(owner.vcenterId ?? '');
      who = inScope(ovc)
        ? { name: String(owner.name || ''), vcenterId: ovc, vcenterName: vcName.get(ovc) || ovc, label: ownerKind }
        : { name: null, vcenterId: null, vcenterName: null, label: `다른 법인 ${ownerKind}` };
    }
    const ownerVcs = new Set([...ownVms, ...ownHosts].map((x) => String(x.vcenterId ?? '')));
    let ledger = null;
    if (kind === 'unknown' && typeof ledgerOf === 'function' && !special) { try { ledger = ledgerOf(ip) || null; } catch { ledger = null; } }
    s = {
      ip, kind, who, publicName, cls: c, special,
      vms: 0, stubVms: 0, firstVms: [], corps: [], policy: 'none', unapprovedVms: 0, otherCorpVms: 0,
      owners: ownVms.length || ownHosts.length,
      ...(ledger ? { ledger } : {}),
      _ownerVcs: ownerVcs, _corps: new Map(), _verdicts: new Set(), _users: [],
    };
    servers.set(ip, s);
    return s;
  };

  for (const r of vms) {
    if (r.info.state !== 'reported') continue;
    r.verdicts = [];
    r.stub = isLocalStub(r.info);   // v2.785(GN N-I2): 로컬 스텁만 — 판정하지 않는다(local)
    for (let i = 0; i < r.info.servers.length; i++) {
      const ip = r.info.servers[i];
      const s = serverOf(ip);
      const verdict = r.stub ? 'local' : policyVerdict(policy, r.vc, s);
      const otherCorp = !r.stub && s._ownerVcs.size > 0 && !s._ownerVcs.has(r.vc);
      r.verdicts.push({ ip, verdict, otherCorp, public: !r.stub && s.kind === 'public', position: i + 1 });
      s.vms += 1;
      if (r.stub) s.stubVms += 1;
      if (s.firstVms.length < FIRST_VMS) s.firstVms.push(String(r.vm.name || r.vm.id || ''));
      s._corps.set(r.vc, (s._corps.get(r.vc) || 0) + 1);
      s._verdicts.add(verdict);
      if (verdict === 'unapproved') s.unapprovedVms += 1;
      if (otherCorp) s.otherCorpVms += 1;
      s._users.push(r);
    }
    r.flags = vmFlags(r);
  }
  for (const s of servers.values()) {
    s.policy = aggPolicy(s._verdicts);
    s.corps = [...s._corps.entries()].map(([id, n]) => ({ id, name: vcName.get(id) || id, vms: n }))
      .sort((a, b) => b.vms - a.vms || byName(a.name, b.name));
  }
  return { vms, servers, perVc, vcName, vcList, inScope, vcFilter };
}

/** VM 단위 표지(어느 서버든) — 'public' | 'unapproved' | 'other-corp' | 'mismatch' | 'single' | 'local-stub'. */
// v2.785(GN N-I2): 로컬 스텁만 쓰는 VM 은 'single'(그 서버가 내려가면 해석이 멈춤) 대신 'local-stub'(상위 DNS 모름)이다.
function vmFlags(r) {
  const f = [];
  const v = r.verdicts || [];
  if (v.some((x) => x.public)) f.push('public');
  if (v.some((x) => x.verdict === 'unapproved')) f.push('unapproved');
  if (v.some((x) => x.otherCorp)) f.push('other-corp');
  if (r.info.mismatch) f.push('mismatch');
  if (r.stub) f.push('local-stub');
  else if (r.info.servers.length === 1) f.push('single');
  return f;
}

/** 서버 원소 → 응답 모양(내부 필드 제거 + 점검 결과). */
export function serverOut(s, probeOf = null) {
  let probe = null;
  if (typeof probeOf === 'function') { try { probe = probeOf(s.ip) || null; } catch { probe = null; } }
  const out = {
    ip: s.ip, kind: s.kind, who: s.who, publicName: s.publicName, cls: s.cls, special: s.special,
    vms: s.vms, firstVms: s.firstVms, corps: s.corps, policy: s.policy,
    unapprovedVms: s.unapprovedVms, otherCorpVms: s.otherCorpVms, owners: s.owners, probe,
  };
  if (s.ledger) out.ledger = s.ledger;
  return out;
}

const topCounts = (m, n) => [...m.entries()].map(([name, vms]) => ({ name, vms }))
  .sort((a, b) => b.vms - a.vms || byName(a.name, b.name)).slice(0, n);

/**
 * GET /tools/vm-dns 본문.
 * @param {object} o  buildDnsIndex 인자 + { probeOf, probeState, changes, now }
 */
export function analyzeVmDns(o = {}) {
  const idx = o.index || buildDnsIndex(o);
  const { vms, servers, perVc, vcName, vcList, inScope } = idx;
  const policy = o.policy || {};

  // 법인(vCenter)별 비승인 VM 수 — 정책 화면의 '위반 N대'. 판정한 VM(필터 안)으로만 센다:
  //   vcenterId 필터가 걸렸으면 다른 vCenter 는 이번 응답에서 판정하지 않았으므로 null(0 이 아니다).
  const unapprovedByVc = new Map();
  for (const r of vms) {
    if (!unapprovedByVc.has(r.vc)) unapprovedByVc.set(r.vc, 0);
    if (r.info.state === 'reported' && (r.flags || []).includes('unapproved')) unapprovedByVc.set(r.vc, unapprovedByVc.get(r.vc) + 1);
  }
  const vcenters = vcList.filter((v) => inScope(v.id)).map((v) => {
    const c = perVc.get(String(v.id)) || { vms: 0, reported: 0, unknown: 0, notCollected: 0 };
    const site = v.collectSource === 'site' || v.collectMode === 'site';
    const rest = v.collectSource === 'rest' || v.collectMethod === 'rest';
    const judged = !idx.vcFilter || idx.vcFilter === String(v.id);
    return { id: String(v.id), name: vcName.get(String(v.id)), ...c, collect: site ? 'site' : 'direct', rest,
      unapprovedVms: judged ? (unapprovedByVc.get(String(v.id)) ?? 0) : null };
  }).sort((a, b) => byName(a.name, b.name));

  const k = { vms: 0, reported: 0, unknown: 0, notCollected: 0, servers: servers.size, serversByKind: { vm: 0, host: 0, public: 0, unknown: 0 },
    unapprovedVms: 0, publicVms: 0, mismatchVms: 0, otherCorpVms: 0, singleDnsVms: 0, localStubVms: 0, dhcpVms: 0, staticVms: 0, policyCorps: 0 };
  const domains = new Map(); const search = new Map();
  for (const r of vms) {
    k.vms += 1; k[r.info.state] += 1;
    if (r.info.state !== 'reported') continue;
    const fl = r.flags || [];
    if (fl.includes('unapproved')) k.unapprovedVms += 1;
    if (fl.includes('public')) k.publicVms += 1;
    if (fl.includes('mismatch')) k.mismatchVms += 1;
    if (fl.includes('other-corp')) k.otherCorpVms += 1;
    if (fl.includes('single')) k.singleDnsVms += 1;
    if (fl.includes('local-stub')) k.localStubVms += 1;
    if (r.info.dhcp === true) k.dhcpVms += 1; else if (r.info.dhcp === false) k.staticVms += 1;
    const dn = r.info.domain || '(도메인 없음)';
    domains.set(dn, (domains.get(dn) || 0) + 1);
    for (const s of r.info.search) search.set(s, (search.get(s) || 0) + 1);
  }
  for (const s of servers.values()) k.serversByKind[s.kind] = (k.serversByKind[s.kind] || 0) + 1;
  const corps = isObj(policy.corps) ? policy.corps : {};
  for (const v of vcenters) if (Object.hasOwn(corps, v.id) && Array.isArray(corps[v.id]) && corps[v.id].length) k.policyCorps += 1;

  const sorted = [...servers.values()].sort((a, b) => b.vms - a.vms || byName(a.ip, b.ip));
  const list = sorted.slice(0, SERVERS_MAX).map((s) => serverOut(s, o.probeOf));

  // 법인 × DNS 서버 — 열 = 사용 VM 상위 8개 서버.
  // v2.785(GN N-I2): 로컬 스텁만 쓰는 VM 은 행에 넣지 않고, 그런 VM 만 쓰는 주소는 열이 되지 않는다.
  // v2.785(GN N-B3): 행마다 칸별 otherCorp(그 법인이 그 서버의 소유 vCenter 집합에 없음)를 싣는다 — 웹이 대표 소유자 1명으로
  //   다시 판정하면 같은 사설 주소를 여러 법인이 가진 경우 KPI(0)와 다른 'amber' 를 칠했다. 범위 밖 vCenter id 는 싣지 않는다(불리언만).
  const cols = sorted.filter((s) => s.vms - s.stubVms > 0).slice(0, MATRIX_COLS);
  const colIdx = new Map(cols.map((s, i) => [s.ip, i]));
  const rowMap = new Map();
  for (const r of vms) {
    if (r.info.state !== 'reported' || !r.info.servers.length || r.stub) continue;
    let row = rowMap.get(r.vc);
    if (!row) {
      row = { vcenterId: r.vc, name: vcName.get(r.vc) || r.vc, cells: cols.map(() => 0), other: 0, total: 0,
        otherCorp: cols.map((s) => s._ownerVcs.size > 0 && !s._ownerVcs.has(r.vc)) };
      rowMap.set(r.vc, row);
    }
    row.total += 1;
    let outside = false;
    for (const ip of r.info.servers) { const i = colIdx.get(ip); if (i == null) outside = true; else row.cells[i] += 1; }
    if (outside) row.other += 1;
  }
  const matrix = { cols: cols.map((s) => ({ ip: s.ip, kind: s.kind, policy: s.policy })), rows: [...rowMap.values()].sort((a, b) => byName(a.name, b.name)) };

  const allVcIds = vcList.map((v) => String(v.id));
  return {
    generatedAt: o.snap?.generatedAt ?? null,
    initial: o.snap?.initial === true,
    // omittedOutOfScope = 범위 밖이라 보이지 않는 **vCenter 수**(VM 수를 주면 다른 법인 규모가 드러난다).
    scope: { scoped: !!o.allowed, omittedOutOfScope: o.allowed ? allVcIds.filter((id) => !inScope(id)).length : 0 },
    vcenters,
    kpis: k,
    servers: list,
    serversTotal: servers.size,
    serversOmitted: Math.max(0, servers.size - list.length),
    matrix,
    domains: topCounts(domains, TOP_NAMES),
    search: topCounts(search, TOP_NAMES),
    checks: { mismatch: k.mismatchVms, otherCorp: k.otherCorpVms, singleDns: k.singleDnsVms },
    changes: o.changes || { available: false, recent: [] },
    probe: o.probeState || { running: false, lastRunAt: null, summary: null },
    policy: { publicUnapproved: policy.publicUnapproved !== false, rev: policy.rev ?? null, corps: k.policyCorps },
  };
}

/** VM 한 행(서버 상세·VM 상세·CSV 공용). `serverIp` 를 주면 표지는 그 서버 기준(mismatch·single 은 VM 기준). */
export function vmRow(r, vcName, serverIp = null) {
  const v = r.verdicts || [];
  let flags = r.flags || [];
  let position = null;
  if (serverIp) {
    const hit = v.find((x) => x.ip === serverIp);
    position = hit ? hit.position : null;
    flags = [];
    if (hit?.public) flags.push('public');
    if (hit?.verdict === 'unapproved') flags.push('unapproved');
    if (hit?.otherCorp) flags.push('other-corp');
    if (r.info.mismatch) flags.push('mismatch');
    if (r.stub) flags.push('local-stub');
    else if (r.info.servers.length === 1) flags.push('single');
  }
  return {
    id: String(r.vm.id ?? ''), name: String(r.vm.name ?? ''), vcenterId: r.vc, vcenterName: vcName.get(r.vc) || r.vc,
    powerState: typeof r.vm.powerState === 'string' ? r.vm.powerState : null,
    dnsState: r.info.state,
    servers: r.info.servers, osServers: r.info.osServers, nicServers: r.info.nicServers,
    domain: r.info.domain, search: r.info.search, dhcp: r.info.dhcp, position, flags, nics: r.info.nics,
    // v2.785(GN N-B3): 이 VM 이 쓰는 서버 중 '다른 법인 DNS' 인 주소 — 웹 주소 칩 색이 대표 소유자로 다시 판정하지 않게.
    otherCorpIps: v.filter((x) => x.otherCorp).map((x) => x.ip),
  };
}

/** GET /tools/vm-dns/server 본문 — 그 서버를 쓰는 범위 안 VM. 서버가 없으면 null(404). */
export function serverDetail(o = {}, { ip, limit = 500, offset = 0 } = {}) {
  const target = canonAddr(ip);
  if (!target) return null;
  const idx = o.index || buildDnsIndex(o);
  const s = idx.servers.get(target);
  if (!s) return null;
  const users = [...s._users].sort((a, b) => byName(idx.vcName.get(a.vc), idx.vcName.get(b.vc)) || byName(a.vm.name, b.vm.name));
  const page = users.slice(offset, offset + limit).map((r) => vmRow(r, idx.vcName, target));
  return { ip: target, server: serverOut(s, o.probeOf), vms: page, total: users.length, truncated: offset + page.length < users.length };
}

/** GET /tools/vm-dns/vm 의 vm 부분 — 범위 밖·없음·템플릿이면 null. 서버마다 정체·판정을 함께 싣는다. */
export function vmDetail(o = {}, id) {
  const want = typeof id === 'string' ? id : '';
  if (!want) return null;
  const idx = o.index || buildDnsIndex({ ...o, vcenterId: '' });
  const r = idx.vms.find((x) => String(x.vm.id ?? '') === want);
  if (!r) return null;
  const row = vmRow(r, idx.vcName);
  row.serverInfo = (r.verdicts || []).map((x) => {
    const s = idx.servers.get(x.ip);
    return { ip: x.ip, position: x.position, kind: s?.kind ?? 'unknown', who: s?.who ?? null, publicName: s?.publicName ?? null,
      cls: s?.cls ?? 'other', policy: x.verdict, otherCorp: x.otherCorp, probe: typeof o.probeOf === 'function' ? (o.probeOf(x.ip) || null) : null };
  });
  return row;
}

/** CSV 행(범위 안 · 템플릿 제외 · 필터 적용) — 판정 글자는 서버가 만든다(백틱·별표 없음). */
// v2.783(점검 Q5 — N-I1): 'none' = 보고는 했지만 DNS 서버가 0개(웹 vmDnsText ipsText 의 '(DNS 없음)' 과 같은 뜻). **CSV 전용 표지**다 —
//   vmFlags(화면·KPI·필터가 읽는 flags)에는 넣지 않는다(웹 flagChips 가 모르는 표지를 원문 회색 칩으로 보이게 되므로 화면 쪽은 별건).
export const FLAG_TEXT = Object.freeze({ none: 'DNS 없음', public: '공인 DNS', unapproved: '비승인', 'other-corp': '다른 법인 DNS', mismatch: 'NIC≠OS', single: 'DNS 1개',
  'local-stub': '로컬 스텁만(상위 DNS 모름)' });
export const STATE_TEXT = Object.freeze({ reported: '보고함', unknown: '모름(VMware Tools 미보고)', notCollected: '미수집(수집기가 DNS 를 싣지 않음)' });
export function csvRows(o = {}) {
  const idx = o.index || buildDnsIndex(o);
  const rows = idx.vms.slice().sort((a, b) => byName(idx.vcName.get(a.vc), idx.vcName.get(b.vc)) || byName(a.vm.name, b.vm.name));
  return rows.map((r) => {
    const x = vmRow(r, idx.vcName);
    // v2.783(점검 Q5 — N-I1): 보고했지만 서버 0개인 VM 을 '이상 없음' 으로 적지 않는다(예전엔 OS/NIC 칸도 null 과 같은 빈 칸이라 구분이 없었다).
    const flags = x.dnsState === 'reported' && !(Array.isArray(x.servers) && x.servers.length) ? ['none', ...x.flags] : x.flags;
    const verdict = x.dnsState !== 'reported' ? STATE_TEXT[x.dnsState]
      : (flags.length ? flags.map((f) => FLAG_TEXT[f] || f).join(' · ') : '이상 없음');
    return [x.vcenterName, x.name, x.powerState || '', x.osServers ? x.osServers.join(' ') : '', x.nicServers ? x.nicServers.join(' ') : '',
      x.domain || '', x.dhcp === true ? 'DHCP' : x.dhcp === false ? '고정' : '', verdict];
  });
}

/** 도메인을 DNS 질의 이름으로 쓸 수 있는가(라벨 1~63 · 전체 253 · 글자 [A-Za-z0-9_-]). */
export function queryNameOf(domain) {
  const d = typeof domain === 'string' ? domain.trim().replace(/\.$/, '') : '';
  if (!d || d.length > 253) return null;
  const labels = d.split('.');
  if (labels.some((l) => !l || l.length > 63 || !/^[A-Za-z0-9_-]+$/.test(l))) return null;
  return d;
}

/**
 * 도달성 점검 대상(POST /tools/vm-dns/probe) — **스냅샷 전체**에서 계산한다(요청 본문에서 주소를 받지 않는다).
 *  · 그 서버를 쓰는 VM 이 전부 엣지 위임(site) vCenter → skip 'edge-only'(중앙에서 닿지 않는 것이 정상이다 — 실패로 세지 않는다)
 *  · 전부 목(데모) vCenter → skip 'mock'(없는 응답을 지어내지 않는다)
 *  · 루프백·링크 로컬·멀티캐스트 등 → skip 'local'(중앙에서 물으면 중앙 자신의 값이다 — IPv4 사상·비축약 IPv6 표기 포함, v2.785 GN N-B4)
 * 사용 VM 많은 순 — 시간 예산에 걸리면 덜 쓰는 서버가 빠진다.
 * @param {Function} [isMockVc] vcenter → boolean
 */
export function probeTargets(snap, { isMockVc = null } = {}) {
  const vcById = new Map((Array.isArray(snap?.vcenters) ? snap.vcenters : []).filter((v) => v && v.id != null).map((v) => [String(v.id), v]));
  const acc = new Map();
  for (const vm of Array.isArray(snap?.vms) ? snap.vms : []) {
    if (!vm || typeof vm !== 'object' || vm.template === true) continue;
    const info = vmDnsInfo(vm);
    if (info.state !== 'reported') continue;
    const vc = String(vm.vcenterId ?? '');
    for (const ip of info.servers) {
      let a = acc.get(ip);
      if (!a) { a = { ip, vms: 0, vcs: new Set(), domains: new Map() }; acc.set(ip, a); }
      a.vms += 1; a.vcs.add(vc);
      const q = queryNameOf(info.domain);
      if (q) a.domains.set(q, (a.domains.get(q) || 0) + 1);
    }
  }
  const out = [];
  for (const a of acc.values()) {
    const vcs = [...a.vcs].map((id) => vcById.get(id)).filter(Boolean);
    const site = (v) => v.collectSource === 'site' || v.collectMode === 'site';
    let skip = null;
    if (specialOf(a.ip) && specialOf(a.ip) !== 'ipv6') skip = 'local';
    else if (vcs.length && vcs.every(site)) skip = 'edge-only';
    else if (vcs.length && typeof isMockVc === 'function' && vcs.every((v) => { try { return !!isMockVc(v); } catch { return false; } })) skip = 'mock';
    const qname = [...a.domains.entries()].sort((x, y) => y[1] - x[1] || byName(x[0], y[0]))[0]?.[0] || '.';
    out.push({ ip: a.ip, vms: a.vms, qname, skip });
  }
  return out.sort((x, y) => y.vms - x.vms || byName(x.ip, y.ip));
}
