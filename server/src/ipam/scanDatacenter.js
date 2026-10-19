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
 *   v2.744(감사 후속 FB-2): ESXi 호스트의 IP 판정은 원장과 같은 ipam/ledger.js hostLedgerIp(이름이 IP 면 이름, 아니면 관리 IP mgmtIp)를
 *   **호출자가 넘긴다**(p.hostIp). 예전에는 이름만 봐서 VMware 권장 방식(FQDN 등록)인 현장의 호스트가 전부 'IP 없음' 으로 빠졌다 —
 *   원장(v2.744 VC-01)은 같은 호스트의 관리 IP 를 올리는데 제안은 그 /24 를 내지 못했다. 이 모듈이 ledger.js 를 직접 import 하면
 *   ledger → scanDatacenterSource → scanDatacenter → ledger 순환이 생겨(arch2579 ②-b SCC 상한) 함수를 주입받는다(판정 복제 금지).
 *   주지 않으면 예전 규칙(이름이 IP 일 때만)이고 응답 hostIpRule 이 그 사실을 말한다('name-only' / 'name-or-mgmt').
 */
import { ipToNum } from '../util/ipv4.js';

// ⚠ scanStore.js `LOCAL` 과 같은 값이어야 한다 — 이 모듈은 순수(scanStore 를 import 하지 않는다)라 상수를 따로 둔다.
//   `test/ipamStore2639.test.js` 가 두 값이 같음을 고정한다(모듈 경계가 두 벌을 두는 이유 — 억지 통합 금지).
export const LOCAL_AGENT = '__local__';
const SUGGEST_MAX = 1024; // v2.639: 바깥 호출부 0건(응답의 omitted 로만 드러난다) — 내부 상수

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
 * @param {(h:object)=>({ip:string}|null)} [p.hostIp]  호스트 → IP(원장 판정 hostLedgerIp). 없으면 이름이 IP 일 때만(예전 규칙).
 * @returns {{ subnets:Array<{base,cidr,ips,vcenterIps,idracIps,vcenters:string[]}>, omitted:number, skipped:{hostsNoIp:number,idracNoIp:number}, totals, hostIpRule:'name-only'|'name-or-mgmt' }}
 *   totals.hostMgmtIps — 이름이 IP 가 아니라 관리 IP 로 센 호스트 수(hostIpRule 'name-or-mgmt' 일 때만 0 이 아닐 수 있다).
 *   skipped.hostsNoIp — 주소를 알 수 없어 뺀 호스트(이름이 IP 가 아니고, 규칙이 'name-or-mgmt' 면 쓸 수 있는 관리 IP 도 없는 것).
 *   totals.hostMgmtRejected — v2.744(회귀 검토 FX-R1): 그중 관리 IP 를 받았지만 판정이 쓰지 않은 호스트(비정규 표기·0.0.0.0) — hostsNoIp 의 부분집합.
 *     skipped 모양은 바꾸지 않는다(기존 소비자·테스트 계약). 'name-only' 규칙이면 관리 IP 를 보지 않으므로 늘 0.
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
  let hostsNoIp = 0; let idracNoIp = 0; let vmIps = 0; let hostIps = 0; let idracIps = 0; let hostMgmtIps = 0; let hostMgmtRejected = 0;
  const hostIpOf = typeof p.hostIp === 'function' ? p.hostIp : null;
  for (const vm of Array.isArray(p.vms) ? p.vms : []) {
    if (!vcSet.has(t(vm?.vcenterId))) continue;
    const ips = Array.isArray(vm.ipAddresses) && vm.ipAddresses.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
    for (const ip of ips) if (add(t(ip), 'vcenter', t(vm.vcenterId))) vmIps += 1;
  }
  for (const h of Array.isArray(p.hosts) ? p.hosts : []) {
    if (!vcSet.has(t(h?.vcenterId))) continue;
    // v2.744(감사 후속 FB-2): 원장과 같은 판정(주입) — 없으면 예전처럼 이름만.
    let ip = t(h.name); let threw = false;
    if (hostIpOf) { let hip = null; try { hip = hostIpOf(h); } catch { hip = null; threw = true; } ip = hip && typeof hip.ip === 'string' ? t(hip.ip) : ''; }
    if (ip && add(ip, 'vcenter', t(h.vcenterId))) { hostIps += 1; if (ipToNum(t(h.name)) == null) hostMgmtIps += 1; } else {
      hostsNoIp += 1;
      // v2.744(회귀 검토 FX-R1): 관리 IP 를 **받았지만** 원장 판정(hostLedgerIp — 주입)이 쓰지 않은 호스트(비정규 표기·0.0.0.0)를 따로 센다.
      //   예전에는 '관리 IP 없음' 과 한 칸이라 화면이 '관리 IP 도 수집되지 않아' 라고 말해 수집 쪽을 의심하게 했다. 판정은 복제하지 않는다 —
      //   '원값이 비어 있지 않은데 주입 판정이 IP 를 주지 않았다' 만 본다. 판정이 던졌으면 표기 탓이라 말할 수 없어 세지 않는다.
      if (hostIpOf && !threw && h.mgmtIp != null && String(h.mgmtIp).trim() !== '') hostMgmtRejected += 1;
    }
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
    skipped: { hostsNoIp, idracNoIp }, totals: { vmIps, hostIps, hostMgmtIps, hostMgmtRejected, idracIps, subnets: all.length },
    hostIpRule: hostIpOf ? 'name-or-mgmt' : 'name-only',
  };
}
