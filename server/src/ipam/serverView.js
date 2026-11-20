/**
 * ipam/serverView.js — IP 관리 '서버 보기'(서비스 태그) · '호스트명 대조'의 판정 코어(순수 · v3.6.0 재설계 묶음 다 —
 * 설계 docs/design/ipam-redesign ⑤ · ⑤-2 · ⑮ · §3.5).
 *
 * 서버 한 대 = 서비스 태그 하나. 출처를 넷으로 묶는다(장비 왕복 0 — 스냅샷 · iDRAC 등록부 · 물리서버 OS 주소 등록 · 스캔 결과만 읽는다):
 *   ESXi 호스트(스냅샷 host — vmk 전체 주소 `vmks` 는 v3.6.0 수집기부터) · 그 위 VM(스냅샷 vm.host) ·
 *   iDRAC 서버(등록부 + 인벤토리 — 태그로 호스트와 잇고, 태그가 없는 호스트는 짧은 이름이 한 서버만 가리킬 때만 잇는다) ·
 *   물리 서버(호스트와 이어지지 않은 iDRAC 서버 — OS 주소는 물리서버 OS 주소 등록에서).
 * 같은 태그를 호스트 둘 이상이 보고하면(일련번호가 비정상인 장비) 그 태그로 묶지 않는다(서로 다른 장비를 한 대로 섞지 않는다).
 *
 * 호스트명 대조: 출처 넷(iDRAC · vCenter · OS · DNS)의 이름을 비교용 이름(hostNames.nameKey — 첫 마디 · 소문자 · 15자)으로 견준다.
 *   읽은 이름이 2곳 미만이면 '비교할 수 없음' · '해당 없음'(VM 의 iDRAC · 물리 서버의 vCenter)과 '못 읽음' · '가림' 은 '다름' 으로 세지 않는다 ·
 *   여럿과 다른 곳을 표시하고 가장 큰 무리가 둘 이상이면(2:2 등) 읽은 곳 전부를 표시한다(어느 쪽이 맞는지 정하지 않는다 — 기준 없음, 사용자 결정).
 */
import { nameKey, nameValue } from './hostNames.js';
import { dnsFwdFields } from './dnsConfirm.js';
import { strictIpv4Num } from '../util/ipv4.js';
import { hostShortName } from '../idrac/hostMatch.js';
import { bmcIpOf } from '../idrac/serverForHost.js';

const t = (v) => String(v ?? '').trim();
const isIp = (v) => typeof strictIpv4Num(t(v)) === 'number';
const tagOf = (v) => t(v).toUpperCase().slice(0, 64);

export const NAME_SOURCES = Object.freeze(['idrac', 'vcenter', 'os', 'dns']);
export const VMK_LIST_MAX = 32;
export const VM_IP_MAX = 16;

/** 호스트의 vmk 주소(엣지가 보낸 값일 수 있다 — 모양 · 수를 다시 자른다). 수집기가 옛 판본이면 관리 IP 하나로 대신하고 `fromMgmt` 표시. */
export function hostVmks(h) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(h?.vmks) ? h.vmks.slice(0, VMK_LIST_MAX) : []) {
    if (!v || typeof v !== 'object' || !isIp(v.ip) || seen.has(t(v.ip))) continue;
    seen.add(t(v.ip));
    out.push({ dev: t(v.dev).slice(0, 32), ip: t(v.ip), mask: isIp(v.mask) ? t(v.mask) : '', pg: t(v.pg).slice(0, 128) });
  }
  if (!out.length && isIp(h?.mgmtIp)) out.push({ dev: '', ip: t(h.mgmtIp), mask: '', pg: '', fromMgmt: true });
  return out;
}

const vmIpsOf = (vm) => {
  const raw = Array.isArray(vm?.ipAddresses) && vm.ipAddresses.length ? vm.ipAddresses : (vm?.ipAddress ? [vm.ipAddress] : []);
  return [...new Set(raw.map(t).filter(isIp))].slice(0, VM_IP_MAX);
};

/**
 * 서버 색인.
 * @param {object} p
 * @param {object[]} p.hosts   범위 안 스냅샷 호스트
 * @param {object[]} p.vms     범위 안 스냅샷 VM
 * @param {object[]} [p.servers]  iDRAC 서버(관리자 판본만 넘긴다 — 아니면 [])
 * @param {(s:object)=>object|null} [p.invOf]  iDRAC 인벤토리
 * @param {(s:object)=>{host:string,name?:string}|null} [p.osEntryOf]  물리 서버의 OS 주소 등록
 * @param {boolean} [p.bareMetal=true]  호스트와 이어지지 않은 iDRAC 서버를 물리 서버로 넣을지(범위 계정은 false)
 * @param {Record<string,string>} [p.vcName]
 */
export function buildServerIndex({ hosts = [], vms = [], servers = [], invOf = () => null, osEntryOf = () => null, bareMetal = true, vcName = {} } = {}) {
  const recs = new Map();
  const byIp = new Map();
  const addIp = (ip, ref) => { if (!isIp(ip)) return; const l = byIp.get(ip); if (l) { if (!l.some((x) => x.key === ref.key && x.role === ref.role && x.vm === ref.vm)) l.push(ref); } else byIp.set(ip, [ref]); };
  // iDRAC 서버 → 태그 · 짧은 이름 색인
  const inv = new Map();
  const srvByTag = new Map();
  const srvByShort = new Map();
  for (const s of Array.isArray(servers) ? servers : []) {
    if (!s || typeof s !== 'object' || s.id == null) continue;
    let i = null; try { i = invOf(s) || null; } catch { i = null; }
    inv.set(s, i);
    const tag = tagOf(s.serviceTag || i?.system?.serviceTag);
    if (tag) { const l = srvByTag.get(tag) || []; l.push(s); srvByTag.set(tag, l); }
    for (const n of new Set([s.name, s.hostName, i?.system?.hostName].map(hostShortName).filter(Boolean))) {
      const l = srvByShort.get(n) || []; if (!l.includes(s)) l.push(s); srvByShort.set(n, l);
    }
  }
  const idracOf = (s) => {
    const i = inv.get(s);
    return { id: String(s.id), ip: bmcIpOf(s.host), name: t(s.name), sysName: t(s.hostName || i?.system?.hostName), osName: t(i?.system?.osName),
      model: t(i?.system?.model || s.model), vendor: t(i?.system?.manufacturer || s.vendor) };
  };
  // 호스트 태그가 겹치면(둘 이상) 그 태그로 묶지 않는다.
  const hostTagN = new Map();
  for (const h of hosts) { const g = tagOf(h?.serviceTag); if (g) hostTagN.set(g, (hostTagN.get(g) || 0) + 1); }
  const linked = new Set();
  const hostKeyByName = new Map(); // `${vcenterId}\0${name}` → key
  for (const h of Array.isArray(hosts) ? hosts : []) {
    if (!h || typeof h !== 'object') continue;
    const tag0 = tagOf(h.serviceTag);
    const tag = tag0 && hostTagN.get(tag0) === 1 ? tag0 : '';
    const key = tag ? `st:${tag}` : `h:${t(h.id) || `${t(h.vcenterId)}:${t(h.name)}`}`;
    let idrac = null; let linkBy = '';
    const cand = tag ? (srvByTag.get(tag) || []) : [];
    if (cand.length === 1) { idrac = idracOf(cand[0]); linkBy = 'tag'; linked.add(cand[0]); }
    else if (cand.length > 1) { idrac = { ambiguous: cand.length }; for (const s of cand) linked.add(s); }
    else if (tag0 && !tag) {
      // 같은 태그를 호스트 여럿이 보고했다 — 그 태그의 iDRAC 가운데 짧은 이름이 이 호스트와 같은 것이 하나뿐일 때만 잇는다.
      const short = hostShortName(h.name);
      const byName = short ? (srvByTag.get(tag0) || []).filter((s) => [s.name, s.hostName, inv.get(s)?.system?.hostName].map(hostShortName).includes(short)) : [];
      if (byName.length === 1) { idrac = idracOf(byName[0]); linkBy = 'name'; linked.add(byName[0]); }
    } else if (!tag0) {
      const short = hostShortName(h.name);
      // 이름 연결은 다른 호스트가 태그로 가져갈 수 없는 서버(태그 없음 · 어느 호스트도 보고하지 않은 태그)만 — 순서에 따라 결과가 바뀌지 않게.
      const byName = short ? (srvByShort.get(short) || []).filter((s) => { const g = tagOf(s.serviceTag || inv.get(s)?.system?.serviceTag); return !g || !hostTagN.has(g); }) : [];
      if (byName.length === 1) { idrac = idracOf(byName[0]); linkBy = 'name'; linked.add(byName[0]); }
    }
    const rec = {
      key, kind: 'esxi', tag: tag0, tagShared: !!(tag0 && !tag), name: t(h.name), model: t(h.model) || t(idrac?.model), vendor: t(h.vendor) || t(idrac?.vendor),
      vcenterId: t(h.vcenterId), vcenterName: vcName[h.vcenterId] || t(h.vcenterId), cluster: t(h.cluster), hostId: t(h.id), power: t(h.powerState),
      osHostName: typeof h.osHostName === 'string' ? h.osHostName : null, osDomain: typeof h.osDomain === 'string' ? h.osDomain : null,
      idrac, linkBy, vmks: hostVmks(h), osAddr: null, vms: [],
    };
    recs.set(key, rec);
    hostKeyByName.set(`${t(h.vcenterId)}\u0000${t(h.name)}`, key);
    if (idrac?.ip) addIp(idrac.ip, { key, role: 'idrac' });
    for (const v of rec.vmks) addIp(v.ip, { key, role: 'vmk' });
  }
  for (const vm of Array.isArray(vms) ? vms : []) {
    if (!vm || typeof vm !== 'object') continue;
    const key = hostKeyByName.get(`${t(vm.vcenterId)}\u0000${t(vm.host)}`);
    if (!key) continue;
    const ips = vmIpsOf(vm);
    const name = t(vm.name);
    recs.get(key).vms.push({ id: t(vm.id), name, power: t(vm.powerState), ips, guestHost: t(vm?.dns?.stack?.hostName) || null, vcenterId: t(vm.vcenterId) });
    for (const ip of ips) addIp(ip, { key, role: 'vm', vm: name });
  }
  if (bareMetal) {
    for (const s of servers) {
      if (!s || typeof s !== 'object' || s.id == null || linked.has(s)) continue;
      const d = idracOf(s);
      const tag = tagOf(s.serviceTag || inv.get(s)?.system?.serviceTag);
      // 그 태그를 보고한 ESXi 호스트가 있다 — 물리(비가상화) 서버가 아니라 어느 호스트인지 못 고른 것이다. 물리 서버로 세지 않는다.
      if (tag && hostTagN.has(tag)) continue;
      const tagUsed = tag && (srvByTag.get(tag) || []).length === 1 && !recs.has(`st:${tag}`);
      const key = tagUsed ? `st:${tag}` : `i:${String(s.id)}`;
      let os = null; try { os = osEntryOf(s) || null; } catch { os = null; }
      const osIp = os && isIp(os.host) ? t(os.host) : '';
      const rec = {
        key, kind: 'bm', tag, tagShared: !!(tag && !tagUsed), name: d.sysName || d.name, model: d.model, vendor: d.vendor,
        vcenterId: t(s.vcenterId), vcenterName: s.vcenterId ? (vcName[s.vcenterId] || t(s.vcenterId)) : '', cluster: '', hostId: '', power: '',
        osHostName: null, osDomain: null, idrac: d, linkBy: '', vmks: [], osAddr: osIp ? { ip: osIp, name: t(os.name) } : null, osName: d.osName, vms: [],
      };
      recs.set(key, rec);
      if (d.ip) addIp(d.ip, { key, role: 'idrac' });
      if (osIp) addIp(osIp, { key, role: 'os' });
    }
  }
  return { recs, byIp };
}

const ROLE_ORDER = { idrac: 0, vmk: 1, os: 2, vm: 3 };

/** IP 하나의 이름 정보(스캔 결과 — 범위 계정은 호출부가 null 을 넘긴다). */
export function ipNameInfo(sc) {
  if (!sc || typeof sc !== 'object') return { scanned: false };
  const dns = nameValue(sc.names?.dns); const nb = nameValue(sc.names?.netbios); const md = nameValue(sc.names?.mdns);
  return { scanned: true, ...(dns ? { dns } : {}), ...(nb ? { netbios: nb } : {}), ...(md ? { mdns: md } : {}), ...dnsFwdFields(sc) };
}

/**
 * 서버 보기 응답(순수). ip 또는 key 로 찾는다.
 * @param {{recs:Map,byIp:Map}} index
 * @param {{ip?:string,key?:string,scanOf?:(ip:string)=>object|null,overrideOf?:(ip:string)=>object|null,purposeOf?:(ip:string)=>string}} q
 */
export function serverViewFor(index, { ip = '', key = '', scanOf = () => null, overrideOf = () => null, purposeOf = () => '' } = {}) {
  let rec = key ? index.recs.get(String(key)) : null;
  let clicked = null; let others = [];
  if (!rec && ip) {
    const refs = [...(index.byIp.get(t(ip)) || [])].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
    if (refs.length) {
      rec = index.recs.get(refs[0].key) || null;
      clicked = { ip: t(ip), role: refs[0].role, ...(refs[0].vm ? { vm: refs[0].vm } : {}) };
      others = [...new Set(refs.map((r) => r.key))].filter((k) => k !== refs[0].key).slice(0, 10);
    }
  }
  if (!rec) return { found: false, ip: t(ip), key: t(key) };
  // 주소마다 '설정한 이름'(관리상태의 호스트명 > 그 주소의 주인 이름) ↔ 역DNS 이름 → nameCheck(same · diff · nodns · unscanned · noname). 판정은 nameKey 하나.
  const info = (a, owner) => {
    const ov = overrideOf(a) || null;
    const n = ipNameInfo(scanOf(a));
    const setName = t(ov?.hostnameOverride) || t(owner);
    const nameCheck = !setName ? 'noname' : !n.scanned ? 'unscanned' : !n.dns ? 'nodns' : nameKey(setName) === nameKey(n.dns) ? 'same' : 'diff';
    return { ...n, ...(setName ? { setName } : {}), ...(ov?.hostnameOverride ? { setNameSrc: 'manual' } : {}), nameCheck,
      purpose: t(ov?.purpose), subnetPurpose: t(purposeOf(a)) };
  };
  const ips = [];
  if (rec.idrac?.ip) ips.push({ ip: rec.idrac.ip, role: 'idrac', label: 'iDRAC', ...info(rec.idrac.ip, rec.idrac.name) });
  for (const v of rec.vmks) ips.push({ ip: v.ip, role: 'vmk', label: v.dev || '관리', dev: v.dev, pg: v.pg, mask: v.mask, ...(v.fromMgmt ? { fromMgmt: true } : {}), ...info(v.ip, rec.name) });
  if (rec.osAddr) ips.push({ ip: rec.osAddr.ip, role: 'os', label: 'OS', ...info(rec.osAddr.ip, rec.osAddr.name || rec.name) });
  const vms = rec.vms.map((v) => ({ name: v.name, power: v.power, guestHost: v.guestHost, ips: v.ips.map((a) => ({ ip: a, ...info(a, v.name) })) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const { vms: _v, vmks: _k, ...head } = rec;
  return { found: true, server: { ...head, vmCount: rec.vms.length }, clicked, others, ips, vms };
}

/** 이름 한 칸. state: ok(읽음) · na(해당 없음) · unread(못 읽음) · hidden(권한 · 범위로 가림) · addr(이름이 아니라 주소). */
const cell = (state, v = '', note = '') => ({ state, ...(v ? { v } : {}), ...(note ? { note } : {}) });

/**
 * 네 출처 비교(순수). 반환: { verdict:'same'|'diff'|'cmp-none', odd:string[], partial:boolean, readN:number }
 * @param {Record<string,{state:string,v?:string}>} cells
 */
export function compareNames(cells) {
  const read = NAME_SOURCES.filter((k) => cells?.[k]?.state === 'ok' && nameKey(cells[k].v));
  const applicable = NAME_SOURCES.filter((k) => cells?.[k] && cells[k].state !== 'na');
  const partial = read.length < applicable.length;
  if (read.length < 2) return { verdict: 'cmp-none', odd: [], partial, readN: read.length };
  const groups = new Map();
  for (const k of read) { const g = nameKey(cells[k].v); groups.set(g, [...(groups.get(g) || []), k]); }
  if (groups.size === 1) return { verdict: 'same', odd: [], partial, readN: read.length };
  const max = Math.max(...[...groups.values()].map((l) => l.length));
  const top = [...groups.values()].filter((l) => l.length === max);
  const odd = top.length > 1 ? read : read.filter((k) => !top[0].includes(k));
  return { verdict: 'diff', odd, partial, readN: read.length };
}

/**
 * 호스트명 대조 행(순수). ESXi · VM · 물리 서버 한 대가 한 행.
 * @param {{recs:Map}} index
 * @param {{ admin?:boolean, scoped?:boolean, scanOf?:(ip:string)=>object|null }} o
 */
export function hostNameRows(index, { admin = false, scoped = false, scanOf = () => null } = {}) {
  const dnsCell = (ip) => {
    if (scoped) return cell('hidden', '', '범위 계정');
    if (!ip) return cell('unread', '', '대표 주소 없음');
    const sc = scanOf(ip);
    const v = nameValue(sc?.names?.dns);
    if (v) return cell('ok', v);
    return cell('unread', '', sc ? '역DNS 응답 없음' : '스캔 결과 없음');
  };
  const idracCell = (r) => {
    if (!admin) return cell('hidden', '', '관리자 전용');
    if (r.idrac?.ambiguous) return cell('unread', '', `같은 태그의 iDRAC ${r.idrac.ambiguous}대 — 어느 것인지 모름`);
    if (!r.idrac) return cell('unread', '', '연결된 iDRAC 없음');
    return r.idrac.sysName ? cell('ok', r.idrac.sysName, r.linkBy === 'name' ? '이름으로 연결' : '') : cell('unread', '', 'iDRAC 이 이름을 보고하지 않음');
  };
  const rows = [];
  for (const r of index.recs.values()) {
    if (r.kind === 'esxi') {
      const mgmt = r.vmks[0]?.ip || '';
      const vc = isIp(r.name) ? cell('addr', r.name, '이름이 아니라 주소로 등록') : cell('ok', r.name);
      const os = r.osHostName ? cell('ok', r.osDomain ? `${r.osHostName}.${r.osDomain}` : r.osHostName) : cell('unread', '', 'ESXi 가 보고하지 않음(수집 서버 v3.6.0 이전 포함)');
      const cells = { idrac: idracCell(r), vcenter: vc, os, dns: dnsCell(mgmt) };
      rows.push({ key: r.key, kind: 'esxi', name: r.name, vcenterName: r.vcenterName, ip: mgmt, cells, ...compareNames(cells) });
      for (const vm of r.vms) {
        const ip = vm.ips[0] || '';
        const cellsV = { idrac: cell('na'), vcenter: cell('ok', vm.name), os: vm.guestHost ? cell('ok', vm.guestHost) : cell('unread', '', 'VMware Tools 미보고'), dns: dnsCell(ip) };
        rows.push({ key: r.key, kind: 'vm', name: vm.name, host: r.name, vcenterName: r.vcenterName, ip, cells: cellsV, ...compareNames(cellsV) });
      }
    } else if (r.kind === 'bm') {
      const ip = r.osAddr?.ip || '';
      const sc = ip && !scoped ? scanOf(ip) : null;
      const nb = nameValue(sc?.names?.netbios);
      const os = scoped ? cell('hidden', '', '범위 계정')
        : nb ? cell('ok', nb, 'NetBIOS(스캔) — Windows')
          : cell('unread', '', ip ? 'Linux OS 이름은 아직 모으지 않음' : 'OS 주소 미등록');
      const cells = { idrac: idracCell(r), vcenter: cell('na'), os, dns: dnsCell(ip) };
      rows.push({ key: r.key, kind: 'bm', name: r.name || r.idrac?.name || r.key, vcenterName: r.vcenterName, ip, cells, ...compareNames(cells) });
    }
  }
  return rows;
}

/** 요약 — 대조한 장비 · 같음 · 다름 · 비교할 수 없음 · 출처별 '다름' 표시 수. */
export function hostNameSummary(rows) {
  const s = { total: 0, same: 0, diff: 0, cmpNone: 0, partial: 0, oddBy: { idrac: 0, vcenter: 0, os: 0, dns: 0 }, byKind: { esxi: 0, vm: 0, bm: 0 } };
  for (const r of rows || []) {
    s.total += 1; s.byKind[r.kind] = (s.byKind[r.kind] || 0) + 1;
    if (r.verdict === 'same') s.same += 1; else if (r.verdict === 'diff') s.diff += 1; else s.cmpNone += 1;
    if (r.partial && r.verdict === 'same') s.partial += 1;
    for (const k of r.odd || []) s.oddBy[k] += 1;
  }
  return s;
}
