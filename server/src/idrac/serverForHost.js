/**
 * idrac/serverForHost.js — ESXi 호스트 → iDRAC 서버 복합 매칭(순수, v2.676).
 *
 * 사용자 요청: "호스트 상세에서 '통합 성능 모니터링' 을 누르면 그 서버의 iDRAC 통합 추이가 나오게 — hostname, TAG 넘버, IP 등으로
 * 복합 조회해서 확실하게 연결". 기존 idrac/hostMatch.js 는 서버 → 호스트(한 방향, 태그 → 짧은 이름) 이고, 여기는 반대 방향이며
 * 규칙 넷을 **각각** 판정해 근거를 남긴다:
 *   ① serviceTag — ESXi 하드웨어 일련번호(host.serviceTag) == iDRAC 서비스태그(등록값 → 인벤토리 system.serviceTag). Dell 은 같은 값이다.
 *   ② hostname   — 짧은 이름(도메인 제거·대소문자 무시 — hostMatch.hostShortName, IP 는 이름이 아니다)
 *                  ESXi host.name ↔ iDRAC 등록 이름·hostName·인벤토리 system.hostName·hostNames(엣지 별칭).
 *   ③ ip         — ESXi 관리 IP(host.mgmtIp · host.name 이 IP 면 그것) ↔ iDRAC 쪽이 아는 **OS 쪽 IP**(등록 이름·hostName·hostNames 중 IPv4).
 *                  ⚠ iDRAC 자체(BMC) 주소 s.host·인벤토리 network(BMC NIC)는 넣지 않는다 — BMC 와 ESXi 관리 IP 는 다른 주소다.
 *   ④ mac        — ESXi 물리 NIC MAC(host.nics[].mac) ↔ iDRAC 인벤토리 NIC 포트 MAC(inv.nics[].ports[].mac).
 *
 * 판정(지어내지 않는다):
 *  · 규칙 하나가 서버 둘 이상을 가리키면 그 규칙은 근거가 아니다(ambiguous). 단, 후보 중 **이 호스트의 vCenter 에 귀속된** 서버가
 *    하나뿐이면 그것으로 좁힌다(narrowedBy:'vcenter').
 *  · 단독으로 가리킨 규칙들이 모두 같은 서버면 연결. 서로 다르면 — 서비스태그가 있으면 태그를 따른다(기존 kindOf 와 같은 우선순위)
 *    하되 어긋난 규칙을 conflicts 로 밝히고, 태그가 없으면 **연결하지 않는다**(reason 'conflict').
 *  · confidence: 태그·MAC 일치 또는 규칙 2개 이상 일치 = 'high', 이름·IP 하나만 = 'medium'.
 */
import { hostShortName } from './hostMatch.js';
import { strictIpv4Num } from '../util/ipv4.js';

export const MATCH_RULES = Object.freeze(['serviceTag', 'hostname', 'ip', 'mac']);
const STRONG = new Set(['serviceTag', 'mac']);
const CANDIDATE_MAX = 10;

const tagOf = (v) => String(v ?? '').trim().toLowerCase();
const isIp = (v) => typeof strictIpv4Num(String(v ?? '').trim()) === 'number'; // false(비정규 표기)·null(이름)은 IP 가 아니다
const ipOf = (v) => { const s = String(v ?? '').trim(); return isIp(s) ? s : ''; };
/** MAC 정규화 — 구분자 제거·소문자. 12자리 16진이 아니거나 전부 0 이면 '' (근거가 아니다). */
export function macKey(v) {
  const h = String(v ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (h.length !== 12 || /^0+$/.test(h) || /^f+$/.test(h)) return '';
  return h;
}

/** 서버 한 대의 식별 키(순수). inv = iDRAC 인벤토리(없으면 null). */
export function serverKeys(s, inv = null) {
  const names = [s?.name, s?.hostName, inv?.system?.hostName, ...(Array.isArray(s?.hostNames) ? s.hostNames : [])];
  const tag = tagOf(s?.serviceTag || inv?.system?.serviceTag);
  const shorts = new Set(names.map(hostShortName).filter(Boolean));
  const ips = new Set(names.map(ipOf).filter(Boolean));
  const macs = new Set();
  for (const n of Array.isArray(inv?.nics) ? inv.nics : []) {
    for (const p of Array.isArray(n?.ports) ? n.ports : []) { const k = macKey(p?.mac); if (k) macs.add(k); }
  }
  return { tag, shorts, ips, macs };
}

/** 호스트의 식별 키(순수). */
export function hostKeys(h) {
  const ips = new Set([ipOf(h?.mgmtIp), ipOf(h?.name)].filter(Boolean));
  const macs = new Set();
  for (const n of Array.isArray(h?.nics) ? h.nics : []) { const k = macKey(n?.mac); if (k) macs.add(k); }
  return { tag: tagOf(h?.serviceTag), short: hostShortName(h?.name), ips, macs };
}

/**
 * @param {object} host  스냅샷 호스트({id,name,vcenterId,serviceTag,mgmtIp,nics})
 * @param {object[]} servers  범위 안 iDRAC 서버 목록
 * @param {{invOf?:(s)=>object|null, vcOf?:(s)=>string}} opt  invOf: 인벤토리 · vcOf: 서버가 귀속된 vCenter id(좁히기용)
 */
export function resolveServerForHost(host, servers = [], { invOf = () => null, vcOf = () => '' } = {}) {
  const hk = hostKeys(host || {});
  const hits = { serviceTag: [], hostname: [], ip: [], mac: [] };
  const values = { serviceTag: '', hostname: '', ip: '', mac: '' };
  for (const s of Array.isArray(servers) ? servers : []) {
    if (!s || typeof s !== 'object' || s.id == null) continue;
    let inv = null;
    try { inv = invOf(s) || null; } catch { inv = null; }
    const k = serverKeys(s, inv);
    if (hk.tag && k.tag === hk.tag) { hits.serviceTag.push(s); values.serviceTag = hk.tag.toUpperCase(); }
    if (hk.short && k.shorts.has(hk.short)) { hits.hostname.push(s); values.hostname = hk.short; }
    const ip = [...hk.ips].find((x) => k.ips.has(x));
    if (ip) { hits.ip.push(s); values.ip = ip; }
    const mac = [...hk.macs].find((x) => k.macs.has(x));
    if (mac) { hits.mac.push(s); values.mac = mac.replace(/(..)(?=.)/g, '$1:'); }
  }
  const rules = {};   // 규칙별 판정 { state:'match'|'ambiguous'|'none'|'no-key', serverId?, count?, narrowedBy? }
  const picks = {};   // 규칙 → 서버 id
  const hostVc = String(host?.vcenterId || '');
  for (const r of MATCH_RULES) {
    const keyless = r === 'serviceTag' ? !hk.tag : r === 'hostname' ? !hk.short : r === 'ip' ? !hk.ips.size : !hk.macs.size;
    const uniq = [...new Map(hits[r].map((s) => [String(s.id), s])).values()];
    if (keyless) { rules[r] = { state: 'no-key' }; continue; }
    if (!uniq.length) { rules[r] = { state: 'none' }; continue; }
    if (uniq.length === 1) { rules[r] = { state: 'match', serverId: String(uniq[0].id), value: values[r] }; picks[r] = String(uniq[0].id); continue; }
    const inVc = hostVc ? uniq.filter((s) => String(vcOf(s) || '') === hostVc) : [];
    if (inVc.length === 1) {
      rules[r] = { state: 'match', serverId: String(inVc[0].id), value: values[r], narrowedBy: 'vcenter', count: uniq.length };
      picks[r] = String(inVc[0].id);
    } else {
      rules[r] = { state: 'ambiguous', count: uniq.length, value: values[r] };
    }
  }
  const pickedIds = [...new Set(Object.values(picks))];
  const candidateMap = new Map();
  for (const r of MATCH_RULES) for (const s of hits[r]) {
    const id = String(s.id);
    const c = candidateMap.get(id) || { id, name: s.name || id, serviceTag: String(s.serviceTag || '').toUpperCase(), by: [] };
    if (!c.by.includes(r)) c.by.push(r);
    candidateMap.set(id, c);
  }
  const allCandidates = [...candidateMap.values()].sort((a, b) => b.by.length - a.by.length || String(a.name).localeCompare(String(b.name)));
  const candidates = allCandidates.slice(0, CANDIDATE_MAX);
  const base = { rules, candidates, candidatesOmitted: Math.max(0, allCandidates.length - CANDIDATE_MAX) };
  if (!pickedIds.length) {
    const anyAmb = MATCH_RULES.some((r) => rules[r].state === 'ambiguous');
    return { ...base, serverId: null, matchedBy: [], conflicts: [], confidence: null, reason: anyAmb ? 'ambiguous' : 'no-match' };
  }
  let chosen = pickedIds[0];
  if (pickedIds.length > 1) {
    if (!picks.serviceTag) return { ...base, serverId: null, matchedBy: [], conflicts: Object.keys(picks), confidence: null, reason: 'conflict' };
    chosen = picks.serviceTag;
  }
  const matchedBy = MATCH_RULES.filter((r) => picks[r] === chosen);
  const conflicts = MATCH_RULES.filter((r) => picks[r] && picks[r] !== chosen);
  const confidence = matchedBy.some((r) => STRONG.has(r)) || matchedBy.length >= 2 ? 'high' : 'medium';
  return { ...base, serverId: chosen, matchedBy, conflicts, confidence, reason: conflicts.length ? 'conflict-tag-wins' : 'ok' };
}

/**
 * GPU 카드 요약(순수, v2.676 — 사용자 요청 "GPU 어떤 카드가 몇 장 꽂혀 있는지"). 모델별 장수.
 *  · ESXi: 스냅샷 host.gpus(물리 GPU 한 장당 한 항목 — vGPU/vSGA 는 graphicsInfo, 패스쓰루는 pciPassthruInfo. 이중 집계는 수집기가 막는다).
 *  · iDRAC: 인벤토리 inv.gpus(Processors 중 GPU/Accelerator).
 * 모르면 null(목록을 못 읽음) — 빈 배열 [] 은 '읽었고 0장'. 둘 다 보여 주고 어긋나면 화면이 말한다(패스쓰루 GPU 는 iDRAC 에 안 보일 수 있다).
 */
export function gpuCardsOf(list) {
  if (!Array.isArray(list)) return null;
  const by = new Map();
  for (const g of list) {
    if (!g || typeof g !== 'object') continue;
    const model = String(g.model || g.name || '').trim() || '(모델 미상)';
    const c = by.get(model) || { model, count: 0, modes: [] };
    c.count += 1;
    const mode = g.mode || (g.vgpuMode ? 'vgpu' : '');
    if (mode && !c.modes.includes(mode)) c.modes.push(mode);
    by.set(model, c);
  }
  const cards = [...by.values()].sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
  return { cards, total: cards.reduce((a, c) => a + c.count, 0) };
}
