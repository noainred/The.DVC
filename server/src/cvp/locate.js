/**
 * cvp/locate.js — ① MAC · IP · 이름으로 위치 찾기(순수, v3.38 — docs/design/cvp-network-features §3 · §8 정정).
 *
 * 데이터는 이미 있다: MAC 테이블(v2.924 l2_fdb) · CVP EndpointLocation(v2.935 ep_loc) · LLDP · vCenter 인벤토리(VM vNIC MAC · IP).
 *   IP → MAC 은 **vCenter 인벤토리로만** 푼다(스위치 ARP 표는 수집하지 않는다 — 화면이 밝힌다).
 * 답은 '가장자리 포트'(이웃이 CVP 스위치가 아닌 포트)에서 본 MAC 이다. 스위치 사이 포트(업링크 · 피어 링크)는 '지나는 곳' 으로 따로 둔다.
 *   포트 채널처럼 LLDP 로 가를 수 없는 포트는 그 포트가 배운 MAC 수가 manyMacs 이상이면 업링크로 본다(추정 — basis 로 밝힌다).
 * 찾지 못함 ≠ 없음 — 호출자가 MAC 테이블을 못 읽은 장비 수를 함께 싣는다.
 */
import { normPort } from './topology.js';

export const MANY_MACS = 64;
export const LOCATE_NAME_MAX = 20;
const hex12 = (s) => String(s ?? '').toLowerCase().slice(0, 64).replace(/[^0-9a-f]/g, '');

/** 질의 종류 — MAC(구분자 : - . 또는 붙인 12자리) · IPv4 · 이름(2자 이상). */
export function parseQuery(q) {
  const t = String(q ?? '').trim().slice(0, 128);
  if (!t) return { kind: 'empty' };
  if (/^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i.test(t) || /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(t) || /^[0-9a-f]{12}$/i.test(t)) return { kind: 'mac', mac: hex12(t) };
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(t);
  if (m) {
    if (m.slice(1).some((x) => Number(x) > 255 || (x.length > 1 && x[0] === '0'))) return { kind: 'bad', reason: 'IPv4 형식이 아닙니다(앞자리 0 · 255 초과).' };
    return { kind: 'ip', ip: t };
  }
  if (t.length < 2) return { kind: 'bad', reason: '이름은 2자 이상 넣어 주세요.' };
  return { kind: 'name', name: t.toLowerCase() };
}

/**
 * vCenter 인벤토리에서 질의에 맞는 VM · 호스트와 그 MAC.
 * @param {{ vms:Array, hosts:Array }} snap
 * @returns {{ subjects:Array<{type:'vm'|'host', id, name, vcenterId, host?:string, ips:string[], macs:string[]}>, truncated:boolean }}
 */
export function subjectsOf(query, snap = {}) {
  const out = []; let truncated = false;
  const vmMacs = (v) => [...new Set((v.dev?.nics || []).map((n) => hex12(n?.mac)).filter((x) => x.length === 12))];
  const hostMacs = (h) => [...new Set((Array.isArray(h.nics) ? h.nics : []).map((n) => hex12(n?.mac)).filter((x) => x.length === 12))];
  const vmIps = (v) => [...new Set([...(Array.isArray(v.ipAddresses) ? v.ipAddresses : []), v.ipAddress].filter(Boolean).map(String))];
  const add = (x) => { if (out.length >= LOCATE_NAME_MAX) { truncated = true; return; } out.push(x); };
  for (const v of snap.vms || []) {
    if (!v) continue;
    const ips = vmIps(v); const macs = vmMacs(v);
    const hit = query.kind === 'ip' ? ips.includes(query.ip)
      : query.kind === 'mac' ? macs.includes(query.mac)
        : query.kind === 'name' ? String(v.name || '').toLowerCase().includes(query.name) || String(v.guestHostName || '').toLowerCase().includes(query.name) : false;
    if (hit) add({ type: 'vm', id: v.id, name: v.name || '', vcenterId: v.vcenterId, host: v.host || '', ips: ips.slice(0, 8), macs });
  }
  for (const h of snap.hosts || []) {
    if (!h) continue;
    const macs = hostMacs(h);
    const ips = [h.mgmtIp, h.ip].filter(Boolean).map(String);
    const hit = query.kind === 'ip' ? ips.includes(query.ip)
      : query.kind === 'mac' ? macs.includes(query.mac)
        : query.kind === 'name' ? String(h.name || '').toLowerCase().includes(query.name) : false;
    if (hit) add({ type: 'host', id: h.id, name: h.name || '', vcenterId: h.vcenterId, ips: ips.slice(0, 4), macs });
  }
  return { subjects: out, truncated };
}

/**
 * MAC 테이블 · CVP 위치 행 → 가장자리 답 / 지나는 곳.
 * @param {{ fdb:Array<{agent,cvpId,key,hostname,mac,vlan,port,ts}>, ep:Array<{agent,cvpId,key,hostname,mac,port,vlan,at,likelihood}>,
 *   uplinks:Map<string,Set<string>>, macCount:Map<string,Map<string,number>>, hostPorts?:Map<string,Set<string>> }} a  uplinks/macCount/hostPorts 키 = agent␀cvp␀key
 */
export function placeRows({ fdb = [], ep = [], uplinks = new Map(), macCount = new Map(), manyMacs = MANY_MACS, hostPorts = new Map() } = {}) {
  const edge = []; const transit = [];
  const seen = new Map();   // 키 → 행(같은 포트 · MAC 을 두 근거가 보면 근거만 더한다)
  const classify = (r) => {
    const dk = `${r.agent}\u0000${r.cvpId}\u0000${r.key}`;
    if (uplinks.get(dk)?.has(normPort(r.port))) return { up: true, basis: 'lldp' };
    const n = macCount.get(dk)?.get(r.port);
    // v3.42(A1-13): LLDP 이웃이 가상화 호스트인 포트는 MAC 이 많아도 가장자리(VM 이 많은 호스트)
    if (hostPorts.get(dk)?.has(normPort(r.port))) return { up: false, basis: 'lldp', macs: n ?? null };
    if (n != null && n >= manyMacs) return { up: true, basis: 'macs', macs: n };
    return { up: false, basis: uplinks.has(dk) ? 'lldp' : 'nolldp', macs: n ?? null };
  };
  for (const [src, rows] of [['fdb', fdb], ['cvp', ep]]) {
    for (const r of Array.isArray(rows) ? rows : []) {
      const k = `${r.agent}\u0000${r.cvpId}\u0000${r.key}\u0000${r.port}\u0000${r.mac}`;
      if (seen.has(k)) { const e = seen.get(k); if (!e.sources.includes(src)) e.sources.push(src); continue; }
      const c = classify(r);
      const row = { k, agent: r.agent, cvpId: r.cvpId, key: r.key, hostname: r.hostname || r.key, port: r.port, mac: r.mac, vlan: r.vlan ?? null,
        at: r.ts ?? r.at ?? null, sources: [src], basis: c.basis, portMacs: c.macs ?? null, likelihood: r.likelihood || null };
      seen.set(k, row);
      (c.up ? transit : edge).push(row);
    }
  }
  const strip = (x) => { const { k, ...rest } = x; return rest; };
  return { edge: edge.map(strip), transit: transit.map(strip) };
}
