/**
 * ipam/vcRangeSuggest.js — vCenter별 스캔 대역 편집기의 '/24 대역 가져오기' 계산(순수, v2.690).
 *
 * 사용자 요청: 대역·스캔 페이지의 vCenter 선택 옆에 버튼 두 개 —
 *   ① iDRAC 대역: 그 vCenter 가 속한 DataCenter(또는 고른 DataCenter)의 **iDRAC 스캔 대역**(idrac-scan-ranges.json)을 /24 로 쪼갠다.
 *   ② VM 대역: 그 vCenter 의 VM 이 가진 IPv4 주소를 /24 로 묶는다.
 * 계산만 한다 — 스냅샷과 설정 파일만 읽는 라우트가 입력을 넘긴다(장비 왕복 0). 텍스트 박스에 이미 있는지·다른 vCenter 와
 * 겹치는지는 **저장하지 않은 입력**까지 봐야 하므로 웹(vcRangeImportText.js)이 판정한다.
 *
 * 대역 문법은 rangeSyntax.checkRangeSpec 하나다(스캔·저장과 같은 판정 — 저장이 거부할 줄을 제안하지 않게).
 */
import { checkRangeSpec } from './rangeSyntax.js';
import { ipToNum } from '../util/ipv4.js';

/** /24 개수 상한 — /16 하나가 256개다. 넘으면 앞에서 자르고 `omitted` 로 밝힌다. */
export const SUBNET_MAX = 1024;

const t = (v) => String(v ?? '').trim();
const cidrOfBase = (b) => `${Math.floor(b / 65536) % 256}.${Math.floor(b / 256) % 256}.${b % 256}.0/24`;

/**
 * VM 주소에서 뺄 것 — 스캔해도 뜻이 없는 주소다. 사설 대역(컨테이너 기본망 172.17 등)은 임의로 빼지 않는다
 * (그 대역을 실제로 쓰는 현장이 있다 — 확인 창에서 VM 수를 보고 사람이 해제한다).
 * @returns {string|null} 사유 키(loopback|link-local|unspecified|multicast|reserved) 또는 null
 */
export function excludedIpReason(n) {
  const a = Math.floor(n / 16777216);
  const b = Math.floor(n / 65536) % 256;
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 0) return 'unspecified';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  return null;
}

/**
 * 대역 한 줄 → 그 줄이 걸치는 /24 의 base(상위 24비트 정수) 목록. 못 읽으면 { ok:false, reason }.
 * 범위가 /24 경계에 걸쳐 일부만 덮어도 그 /24 를 넣는다(스캔 대역 편집기가 /24 단위로 받기로 한 요청이다).
 */
export function specTo24(spec, cap = SUBNET_MAX) {
  const r = checkRangeSpec(spec, { reversed: 'error' });
  if (!r.ok) return { ok: false, reason: r.reason };
  const lo = Math.floor(r.lo / 256);
  const hi = Math.floor(r.hi / 256);
  const bases = [];
  for (let b = lo; b <= hi && bases.length < cap; b += 1) bases.push(b);
  return { ok: true, bases, total: hi - lo + 1 };
}

/**
 * ① iDRAC 스캔 대역 → /24. entries 는 listScanRanges() 모양({ id, datacenterId, service, ranges, enabled }).
 * 그 DataCenter 의 엔트리만 쓴다. 꺼진(enabled:false) 엔트리도 '입력한 대역' 이므로 쓰고 표시만 한다.
 * @returns {{ subnets: Array<{cidr, sources:string[], disabledOnly:boolean}>, entries: Array<{id, service, ranges, enabled, subnets, invalid}>, invalid: Array<{service, value, reason}>, omitted: number }}
 */
export function idracSubnets({ entries, datacenterId, cap = SUBNET_MAX } = {}) {
  const dc = t(datacenterId).toLowerCase();
  const by = new Map(); // base → { sources:Set, enabledAny:boolean }
  const outEntries = [];
  const invalid = [];
  let totalBases = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object' || !dc || t(e.datacenterId).toLowerCase() !== dc) continue;
    const name = t(e.service) || '(서비스 이름 없음)';
    const enabled = e.enabled !== false;
    let n = 0;
    const bad = [];
    for (const raw of Array.isArray(e.ranges) ? e.ranges : []) {
      const spec = t(raw);
      if (!spec) continue;
      const s = specTo24(spec, cap + 1);
      if (!s.ok) { bad.push({ value: spec.slice(0, 80), reason: s.reason }); continue; }
      for (const b of s.bases) {
        let x = by.get(b);
        if (!x) { x = { sources: new Set(), enabledAny: false }; by.set(b, x); totalBases += 1; }
        x.sources.add(name); if (enabled) x.enabledAny = true;
        n += 1;
      }
      // 한 줄이 상한보다 크면(/8 등) 뒤는 세지 않았다 — 개수로 밝힌다.
      if (s.total > s.bases.length) totalBases += s.total - s.bases.length;
    }
    for (const b of bad) invalid.push({ service: name, ...b });
    outEntries.push({ id: t(e.id), service: name, ranges: (e.ranges || []).map(t).filter(Boolean), enabled, subnets: n, invalid: bad.length });
  }
  const all = [...by.entries()].sort((a, b) => a[0] - b[0])
    .map(([b, x]) => ({ cidr: cidrOfBase(b), sources: [...x.sources].sort(), disabledOnly: !x.enabledAny }));
  return { subnets: all.slice(0, cap), entries: outEntries, invalid, omitted: Math.max(0, totalBases - Math.min(all.length, cap)) };
}

/**
 * ② vCenter 의 VM IPv4 → /24. vms 는 스냅샷 VM(vcenterId, name, ipAddresses|ipAddress).
 * @returns {{ subnets: Array<{cidr, vms:number, ips:number, sample:string[]}>, totals: {vms, vmsWithIp, vmsNoIp, ips, ipv6, excluded:{...}}, omitted: number }}
 */
export function vmSubnets({ vms, vcenterId, cap = SUBNET_MAX } = {}) {
  const vc = t(vcenterId);
  const by = new Map(); // base → { vms:Set, ips:Set, sample:[] }
  const excluded = { loopback: 0, 'link-local': 0, unspecified: 0, multicast: 0, reserved: 0 };
  let total = 0; let withIp = 0; let ipv6 = 0; let ipCount = 0;
  for (const vm of Array.isArray(vms) ? vms : []) {
    if (!vm || typeof vm !== 'object' || t(vm.vcenterId) !== vc) continue;
    total += 1;
    const raw = Array.isArray(vm.ipAddresses) && vm.ipAddresses.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
    const key = t(vm.id) || t(vm.name) || `#${total}`;
    let used = false;
    for (const ipRaw of raw) {
      const ip = t(ipRaw);
      if (!ip) continue;
      if (ip.includes(':')) { ipv6 += 1; continue; }
      const n = ipToNum(ip);
      if (n == null) continue;
      const why = excludedIpReason(n);
      if (why) { excluded[why] += 1; continue; }
      const b = Math.floor(n / 256);
      let x = by.get(b);
      if (!x) { x = { vms: new Set(), ips: new Set(), sample: [] }; by.set(b, x); }
      if (!x.ips.has(n)) { x.ips.add(n); ipCount += 1; }
      if (!x.vms.has(key)) { x.vms.add(key); if (x.sample.length < 3) x.sample.push(t(vm.name) || key); }
      used = true;
    }
    if (used) withIp += 1;
  }
  const all = [...by.entries()].sort((a, b) => a[0] - b[0])
    .map(([b, x]) => ({ cidr: cidrOfBase(b), vms: x.vms.size, ips: x.ips.size, sample: x.sample }));
  return {
    subnets: all.slice(0, cap), omitted: Math.max(0, all.length - cap),
    totals: { vms: total, vmsWithIp: withIp, vmsNoIp: total - withIp, ips: ipCount, ipv6, excluded },
  };
}

/**
 * v2.692: '/24 가져오기' 후보에 IPMS 설정을 적용한다(순수).
 *   ① 무시 대역 — 전체(global) + 관련 vCenter 의 무시 목록. /24 의 **호스트 주소(.1~.254)가 전부** 무시 대역에 들어가면 후보에서 뺀다
 *      (그 IP 는 대장에서 숨겨지므로 스캔해도 보이지 않는다). 일부만 걸치면 빼지 않고 `ignore:'partial'` 로 표시한다(나머지는 보인다).
 *   ② 공인/사설 — IPMS ③ 판정(classifier.num — 명시 사설 > 명시 공인 > RFC1918). /24 안에서 갈리면 'mixed'.
 * @param {Array<{cidr:string}>} subnets
 * @param {{ ignore?: { global?: Array<{lo,hi}>, vcenters?: Record<string, Array<{lo,hi}>> }, vcenterIds?: string[], classify?: (n:number)=>string, vcName?: Record<string,string> }} opt
 * @returns {{ subnets: Array<object>, ignored: { count:number, bySource: Record<string,number>, sample:string[] }, sources: Array<{key,label}> }}
 */
export function annotateSubnets(subnets, { ignore = {}, vcenterIds = [], classify = null, vcName = {} } = {}) {
  const tagged = [];
  for (const r of Array.isArray(ignore.global) ? ignore.global : []) if (r) tagged.push({ ...r, src: 'global' });
  const vcs = ignore.vcenters && typeof ignore.vcenters === 'object' ? ignore.vcenters : {};
  for (const id of [...new Set(vcenterIds || [])]) for (const r of Array.isArray(vcs[id]) ? vcs[id] : []) if (r) tagged.push({ ...r, src: `vc:${id}` });
  const sources = [{ key: 'global', label: '전체(모든 vCenter)' }, ...[...new Set(vcenterIds || [])].map((id) => ({ key: `vc:${id}`, label: `vCenter ${vcName[id] || id}` }))];
  const out = [];
  const ignored = { count: 0, bySource: {}, sample: [] };
  for (const s of Array.isArray(subnets) ? subnets : []) {
    const base = baseOfCidr(s?.cidr);
    if (base == null) { out.push(s); continue; }
    const lo = base * 256 + 1; const hi = base * 256 + 254;
    const hits = tagged.filter((r) => r.hi >= lo && r.lo <= hi);
    let ignoreState = null;
    if (hits.length) {
      const iv = hits.map((r) => [Math.max(r.lo, lo), Math.min(r.hi, hi)]).sort((a, b) => a[0] - b[0]);
      let covered = 0; let curLo = iv[0][0]; let curHi = iv[0][1];
      for (const [a, b] of iv.slice(1)) { if (a <= curHi + 1) curHi = Math.max(curHi, b); else { covered += curHi - curLo + 1; curLo = a; curHi = b; } }
      covered += curHi - curLo + 1;
      ignoreState = covered >= hi - lo + 1 ? 'full' : 'partial';
    }
    const by = [...new Set(hits.map((r) => r.src))];
    if (ignoreState === 'full') {
      ignored.count += 1;
      for (const k of by) ignored.bySource[k] = (ignored.bySource[k] || 0) + 1;
      if (ignored.sample.length < 20) ignored.sample.push(s.cidr);
      continue;
    }
    let cls = null;
    if (typeof classify === 'function') {
      let pub = 0; let priv = 0;
      for (let n = lo; n <= hi; n += 1) { if (classify(n) === 'public') pub += 1; else priv += 1; if (pub && priv) break; }
      cls = pub && priv ? 'mixed' : pub ? 'public' : 'private';
    }
    out.push({ ...s, cls, ...(ignoreState ? { ignore: ignoreState, ignoreBy: by } : {}) });
  }
  return { subnets: out, ignored, sources };
}

function baseOfCidr(cidr) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.0\/24$/.exec(String(cidr || ''));
  if (!m) return null;
  const n = ipToNum(`${m[1]}.${m[2]}.${m[3]}.0`);
  return n == null ? null : Math.floor(n / 256);
}
