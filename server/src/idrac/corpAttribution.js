/**
 * idrac/corpAttribution.js — 물리 서버의 **법인(vCenter) 귀속을 한 곳에서** 정한다(v2.626).
 *
 * 사용자 신고(2026-09-27, v2.625 화면): '법인별 서버 사용량' 의 물리 서버가 전 법인 '— 서버 없음'.
 * 원인(코드로 확인): 사용률(`bmusage`)·법인별 사용량(`corpusage`)은 `insights/fleetInventory.js resolveVc` 로
 * 법인을 정하는데 그 판정은 ① 등록부 vcenterId ② 수동 지정만 본다. 개요(v2.583)는 여기에
 * 호스트명·서비스태그·**법인(DataCenter)의 vCenter 가 하나뿐이면 그 vCenter** 를 더 쓴다(`serverByCorp.js`).
 * 이 현장의 물리 전용 서버(약 500대)는 ⑤ 로만 귀속되므로 사용률 쪽에서는 전부 '법인 귀속 없음' 이 되어
 * 수집 대상에서도 법인 합계에서도 빠졌다.
 *
 * 규칙: **판정을 복제하지 않는다** — `serversByCorp` 를 그대로 돌려 `onAttributed(s, vc)` 로 받은 귀속을
 * 서버 id·서비스태그 색인으로 만든다. 이미 법인이 있는 베어메탈은 **바꾸지 않는다**(빈 칸만 채운다 —
 * 기존 귀속·전력 화면과 어긋나지 않게). 채운 것은 `vcSource:'corp-rule'` 로 밝힌다.
 *
 * `allPhysicalServers`·`corpAttribution` 은 `routes/api/overviewNsx.js` 에서 옮겼다(개요와 같은 입력을 쓰게).
 */
import { loadRegistry as loadIdracRegistry } from './registry.js';
import { remoteServersResolved } from '../insights/analysisServers.js';
import { serversByCorp } from './serverByCorp.js';
import { loadFleetAssign } from '../insights/fleetAssign.js';
import { listDatacenters, getDatacenterAssign } from '../datacenter/store.js';

const t = (v) => String(v ?? '').trim();
const norm = (v) => t(v).toLowerCase();

/** iDRAC 가 인식한 모든 물리 서버(중앙 직접 등록 + 위임 법인 원격, OME 엔트리 제외, id 중복은 중앙 우선). */
export function allPhysicalServers() {
  const local = loadIdracRegistry().filter((s) => s.type !== 'ome');
  const seen = new Set(local.map((s) => String(s.id)));
  let remote = [];
  try { remote = remoteServersResolved(); } catch { remote = []; }
  return local.concat(remote.filter((s) => !seen.has(String(s.id))));
}

/**
 * v2.583 보조 귀속 재료 — 관리자 지정(fleet-assign) · 법인(DataCenter) → vCenter 목록 · 살아 있는 vCenter.
 * 법인 id 는 대소문자를 무시해 맞춘다. 이름도 함께 준다(화면의 행 이름).
 */
export function corpAttribution(vcenters) {
  const known = new Set((vcenters || []).map((v) => String(v.id)));
  const byLower = new Map();
  for (const id of known) byLower.set(id.toLowerCase(), id);
  const dcVcenters = new Map();
  for (const [vcRaw, dc] of Object.entries(getDatacenterAssign() || {})) {
    const vc = byLower.get(String(vcRaw).trim().toLowerCase());
    const k = String(dc || '').trim().toLowerCase();
    if (!vc || !k) continue;
    const arr = dcVcenters.get(k) || [];
    if (!arr.includes(vc)) arr.push(vc);
    dcVcenters.set(k, arr);
  }
  const dcNames = {};
  for (const d of listDatacenters() || []) if (d?.id) dcNames[String(d.id)] = String(d.name || d.id);
  let fleetAssign = {};
  try { fleetAssign = loadFleetAssign() || {}; } catch { fleetAssign = {}; }
  return { opts: { fleetAssign, dcVcenters, knownVcenters: known }, dcNames };
}

/**
 * 물리 서버 → 법인 색인(순수에 가깝게 — 입력을 받는다). `serversByCorp` 의 귀속을 그대로 담는다.
 * 같은 서비스태그가 서로 다른 법인으로 귀속되면 그 태그는 **색인에서 뺀다**(어느 쪽인지 근거가 없다).
 */
export function buildVcIndex(servers = [], hosts = [], opts = {}) {
  const byId = new Map();
  const byTag = new Map();
  const conflict = new Set();
  serversByCorp(servers, hosts, {
    ...opts,
    onAttributed: (s, vc) => {
      if (!vc) return;
      const id = t(s?.id);
      if (id && !byId.has(id)) byId.set(id, vc);
      const tag = norm(s?.serviceTag || s?.inv?.system?.serviceTag);
      if (!tag || conflict.has(tag)) return;
      const prev = byTag.get(tag);
      if (prev && prev !== vc) { byTag.delete(tag); conflict.add(tag); return; }
      byTag.set(tag, vc);
    },
  });
  return { byId, byTag, conflicts: conflict.size };
}

/**
 * 베어메탈 목록의 **빈 법인만** 색인으로 채운다(순수). 이미 있는 귀속은 바꾸지 않는다.
 * 원천이 엣지 보고(`source:'edge'`)면 서버 id 가 `agent+fleetId` 라 id 는 맞지 않는다 — 서비스태그로만 찾는다.
 * @returns {{ bareMetal: object[], filled: number }}
 */
export function attributeBareMetal(bareMetal = [], index = null, vcName = null) {
  if (!index) return { bareMetal: bareMetal || [], filled: 0 };
  let filled = 0;
  const out = (bareMetal || []).map((b) => {
    if (!b || t(b.vcenterId)) return b;
    const vc = (b.source !== 'edge' && index.byId.get(t(b.serverId))) || index.byTag.get(norm(b.serviceTag)) || '';
    if (!vc) return b;
    filled += 1;
    return { ...b, vcenterId: vc, vcenter: (vcName && vcName.get(vc)) || vc, vcSource: 'corp-rule' };
  });
  return { bareMetal: out, filled };
}

/** 스냅샷 기준 한 번에 — 입력 수집 + 색인 + 채우기. 실패하면 원본을 그대로 돌려준다(개수로 밝힌다). */
export function attributeBareMetalFromSnap(bareMetal = [], snap = null) {
  try {
    const vcenters = snap?.vcenters || [];
    const { opts } = corpAttribution(vcenters);
    const index = buildVcIndex(allPhysicalServers(), snap?.hosts || [], opts);
    const vcName = new Map(vcenters.map((v) => [String(v.id), v.name || v.id]));
    return { ...attributeBareMetal(bareMetal, index, vcName), conflicts: index.conflicts };
  } catch (e) {
    return { bareMetal: bareMetal || [], filled: 0, error: String(e?.message || e).slice(0, 200) };
  }
}
