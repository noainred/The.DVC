/**
 * ipam/scanDatacenter.js — IP 스캔 결과의 데이터센터(법인) 귀속 + 에이전트가 쓰는 /24 대역 제안(v2.638).
 *
 * 사용자 요청(2026-09-28): "scan 한 데이터를 어떤 데이터센터에 포함시키는 메뉴가 없어, 할당 에이전트가 속한 데이터센터에
 * 자동으로 할당되게" · "agent 를 선택하면 해당 agent 가 속한 idrac/vcenter 에서 사용중인 ip 대역을 가져와서 선택 가능한
 * 메뉴로 · /24 단위로". 선택: **수동 지정 + 자동**.
 *
 * ── 귀속 판정(순수 — resolveAgentDatacenters) ─────────────────────────────────────────────
 *   ① 에이전트 스캔 설정의 `datacenterId` 가 있으면 그것(manual). 그 DataCenter 가 삭제됐으면 **귀속하지 않는다**
 *      (`manual-missing`) — 자동으로 조용히 바꾸면 관리자가 고른 값이 사라진 사실이 숨는다.
 *   ② 없으면 자동: 그 에이전트가 수집하는 vCenter 들의 DataCenter(설정 › DataCenter 의 vCenter 할당) + 그 에이전트와 같은
 *      이름의 수집 서버 등록의 datacenter. 후보가 **정확히 하나일 때만** 귀속한다. 0개면 `none`, 둘 이상이면 `multiple` —
 *      어느 법인 IP 인지 포탈이 알 수 없는데 하나를 고르면 그 법인 대장이 거짓이 된다.
 *   '에이전트가 수집하는 vCenter' = 등록부 collectMode 'site' 이고 remoteAgent(없으면 스냅샷 collectedBy)가 그 에이전트.
 *   '이 포탈에서 직접'(__local__) = collectMode 가 site 가 아닌 vCenter.
 *   이름 비교는 대소문자 무시이고, 수집 서버의 id·name 둘 다 그 에이전트의 별칭으로 본다(통신 지도와 같은 규칙).
 *
 * ── 대역 제안(순수 — suggestAgentSubnets) ─────────────────────────────────────────────────
 *   그 에이전트가 수집하는 vCenter 의 VM·ESXi 호스트 IP + 그 에이전트가 담당하는 iDRAC 의 관리 IP 를 /24 로 묶는다.
 *   주소가 IP 가 아닌 것(FQDN 등록 호스트·iDRAC)은 대역을 알 수 없으므로 **개수만** 밝힌다(지어내지 않는다).
 */
import { ipToNum } from '../util/ipv4.js';

export const LOCAL_AGENT = '__local__';
export const SUGGEST_MAX = 1024;
const t = (v) => (v == null ? '' : String(v).trim());
const low = (v) => t(v).toLowerCase();

/** 수집 서버 id·name → 대표 이름(소문자) 목록. 에이전트 이름은 보통 수집 서버 id(= AGENT_NAME)다. */
function aliasSetOf(agent, collectors) {
  const a = low(agent);
  const set = new Set([a]);
  for (const c of Array.isArray(collectors) ? collectors : []) {
    const id = low(c?.id); const nm = low(c?.name);
    if (a && (id === a || nm === a)) { if (id) set.add(id); if (nm) set.add(nm); }
  }
  return set;
}

/**
 * 한 에이전트가 수집하는 vCenter id 목록.
 * @param {string} agent
 * @param {{vcenters:Array, snapVcenters:Array, collectors:Array}} p
 */
export function agentVcenterIds(agent, p = {}) {
  const regs = Array.isArray(p.vcenters) ? p.vcenters : [];
  const snapById = new Map((Array.isArray(p.snapVcenters) ? p.snapVcenters : []).map((v) => [t(v?.id), v]));
  const isLocal = !t(agent) || t(agent) === LOCAL_AGENT;
  const aliases = isLocal ? null : aliasSetOf(agent, p.collectors);
  const out = [];
  const seen = new Set();
  const consider = (id, collectMode, owner) => {
    if (!id || seen.has(id)) return;
    const site = collectMode === 'site';
    if (isLocal ? !site : (site && aliases.has(low(owner)))) { seen.add(id); out.push(id); }
  };
  for (const reg of regs) {
    const id = t(reg?.id);
    if (!id || reg?.enabled === false) { if (id) seen.add(id); continue; } // 비활성 vCenter 는 판정 근거로 쓰지 않는다
    consider(id, t(reg.collectMode) === 'site' ? 'site' : 'direct', t(reg.remoteAgent) || t(snapById.get(id)?.collectedBy));
  }
  // 등록부에 없고 스냅샷에만 있는 vCenter(엣지가 올린 것) — collectedBy 로만 판정한다.
  for (const [id, s] of snapById) {
    if (!id || seen.has(id)) continue;
    consider(id, t(s?.collectSource) === 'site' ? 'site' : 'direct', t(s?.collectedBy));
  }
  return out;
}

/** DataCenter 이름/ID → id(없으면 null). 수집 서버 datacenter 칸은 이름이 들어 있는 경우가 많다. */
function dcIdOf(v, datacenters) {
  const s = t(v);
  if (!s) return null;
  const list = Array.isArray(datacenters) ? datacenters : [];
  const byId = list.find((d) => t(d?.id) === s) || list.find((d) => low(d?.id) === low(s));
  if (byId) return t(byId.id);
  const byName = list.find((d) => low(d?.name) === low(s));
  return byName ? t(byName.id) : null;
}

/**
 * 에이전트 → 데이터센터 판정(순수).
 * @param {object} p
 * @param {string[]} p.agents               판정할 에이전트 이름(스캔 설정·스캔 결과에 나오는 이름)
 * @param {Record<string,object>} p.settings 에이전트 이름 → 스캔 설정({datacenterId})
 * @param {Array} p.vcenters p.snapVcenters p.collectors p.datacenters
 * @param {Record<string,string>} p.assign   vCenter id → DataCenter id
 * @returns {Map<string, {agent, datacenterId, datacenterName, source:'manual'|'auto'|null, reason, candidates, vcenters, collectors}>} 키 = 소문자 이름
 */
export function resolveAgentDatacenters(p = {}) {
  const datacenters = Array.isArray(p.datacenters) ? p.datacenters : [];
  const dcName = new Map(datacenters.map((d) => [t(d?.id), t(d?.name) || t(d?.id)]));
  const assign = p.assign && typeof p.assign === 'object' ? p.assign : {};
  const settings = p.settings && typeof p.settings === 'object' ? p.settings : {};
  const settingOf = (agent) => {
    if (Object.hasOwn(settings, agent)) return settings[agent];
    const k = Object.keys(settings).find((x) => low(x) === low(agent));
    return k ? settings[k] : null;
  };
  const out = new Map();
  for (const agent of new Set((Array.isArray(p.agents) ? p.agents : []).map(t).filter(Boolean))) {
    const vcIds = agentVcenterIds(agent, p);
    const cand = new Map(); // dcId → { vcenters:[], collectors:[] }
    const bump = (dc, key, val) => { if (!dc) return; if (!cand.has(dc)) cand.set(dc, { vcenters: [], collectors: [] }); cand.get(dc)[key].push(val); };
    const unassignedVcenters = [];
    for (const vc of vcIds) {
      const dc = t(assign[vc]);
      if (dc && dcName.has(dc)) bump(dc, 'vcenters', vc); else unassignedVcenters.push(vc);
    }
    if (agent !== LOCAL_AGENT) {
      const aliases = aliasSetOf(agent, p.collectors);
      for (const c of Array.isArray(p.collectors) ? p.collectors : []) {
        if (!aliases.has(low(c?.id)) && !aliases.has(low(c?.name))) continue;
        bump(dcIdOf(c?.datacenter, datacenters), 'collectors', t(c?.id) || t(c?.name));
      }
    }
    const candidates = [...cand.entries()].map(([id, v]) => ({ id, name: dcName.get(id) || id, vcenters: v.vcenters, collectors: v.collectors }));
    const base = { agent, candidates, vcenters: vcIds, unassignedVcenters };
    const manual = t(settingOf(agent)?.datacenterId);
    if (manual) {
      if (dcName.has(manual)) out.set(low(agent), { ...base, datacenterId: manual, datacenterName: dcName.get(manual), source: 'manual', reason: 'manual' });
      else out.set(low(agent), { ...base, datacenterId: null, datacenterName: null, source: null, reason: 'manual-missing', manualId: manual });
      continue;
    }
    if (candidates.length === 1) out.set(low(agent), { ...base, datacenterId: candidates[0].id, datacenterName: candidates[0].name, source: 'auto', reason: 'auto' });
    else out.set(low(agent), { ...base, datacenterId: null, datacenterName: null, source: null, reason: candidates.length ? 'multiple' : 'none' });
  }
  return out;
}

/** 판정 결과의 지문 — 대장 캐시 키에 쓴다(귀속이 바뀌면 대장이 바로 다시 만들어지게). */
export function datacenterMapSig(map) {
  const parts = [];
  for (const [k, v] of map || []) parts.push(`${k}=${v?.datacenterId || ''}`);
  return parts.sort().join(',');
}

const baseOf = (n) => `${Math.floor(n / 16777216) % 256}.${Math.floor(n / 65536) % 256}.${Math.floor(n / 256) % 256}`;
/** 'https://10.0.0.5:443/' → '10.0.0.5'(IP 가 아니면 null). */
export function ipOfHost(h) {
  let s = t(h).replace(/^https?:\/\//i, '');
  s = s.split('/')[0];
  if (s.startsWith('[')) return null; // IPv6 — /24 제안 대상 아님
  s = s.replace(/:\d+$/, '');
  return ipToNum(s) != null ? s : null;
}

/**
 * 에이전트가 쓰는 /24 대역(순수).
 * @param {object} p
 * @param {string[]} p.vcenterIds  그 에이전트가 수집하는 vCenter
 * @param {Array} p.vms p.hosts    스냅샷
 * @param {Array} p.idrac          그 에이전트 담당 iDRAC 서버({host,name,id})
 * @param {Record<string,string>} [p.vcName]
 * @returns {{ subnets:Array<{base,cidr,ips,vcenterIps,idracIps,vcenters:string[]}>, omitted:number, skipped:{hostsNoIp:number,idracNoIp:number}, totals }}
 */
export function suggestAgentSubnets(p = {}) {
  const vcSet = new Set((Array.isArray(p.vcenterIds) ? p.vcenterIds : []).map(t));
  const vcName = p.vcName && typeof p.vcName === 'object' ? p.vcName : {};
  const by = new Map(); // base → { ips:Set, vc:Set, idrac:Set, vcenters:Set }
  const add = (ip, kind, vc) => {
    const n = ipToNum(ip); if (n == null) return false;
    const b = baseOf(n);
    let e = by.get(b); if (!e) { e = { ips: new Set(), vc: new Set(), idrac: new Set(), vcenters: new Set() }; by.set(b, e); }
    e.ips.add(ip); (kind === 'idrac' ? e.idrac : e.vc).add(ip);
    if (vc) e.vcenters.add(vcName[vc] || vc);
    return true;
  };
  let hostsNoIp = 0; let idracNoIp = 0; let vmIps = 0; let hostIps = 0; let idracIps = 0;
  for (const vm of Array.isArray(p.vms) ? p.vms : []) {
    if (!vcSet.has(t(vm?.vcenterId))) continue;
    const ips = Array.isArray(vm.ipAddresses) && vm.ipAddresses.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
    for (const ip of ips) if (add(t(ip), 'vcenter', t(vm.vcenterId))) vmIps += 1;
  }
  for (const h of Array.isArray(p.hosts) ? p.hosts : []) {
    if (!vcSet.has(t(h?.vcenterId))) continue;
    if (add(t(h.name), 'vcenter', t(h.vcenterId))) hostIps += 1; else hostsNoIp += 1;
  }
  for (const s of Array.isArray(p.idrac) ? p.idrac : []) {
    const ip = ipOfHost(s?.host) || ipOfHost(s?.id);
    if (ip && add(ip, 'idrac', '')) idracIps += 1; else idracNoIp += 1;
  }
  const all = [...by.entries()].map(([b, e]) => ({
    base: b, cidr: `${b}.0/24`, ips: e.ips.size, vcenterIps: e.vc.size, idracIps: e.idrac.size, vcenters: [...e.vcenters].sort(),
  })).sort((a, b) => b.ips - a.ips || (ipToNum(`${a.base}.0`) - ipToNum(`${b.base}.0`)));
  return {
    subnets: all.slice(0, SUGGEST_MAX), omitted: Math.max(0, all.length - SUGGEST_MAX),
    skipped: { hostsNoIp, idracNoIp }, totals: { vmIps, hostIps, idracIps, subnets: all.length },
  };
}
