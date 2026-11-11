/**
 * insights/hwExport/corp.js — 내보내기의 '법인' = **법인(DataCenter)** (v2.968).
 *
 * 사용자 신고(2026-11-11, v2.967 화면): 서버 분석 › 상태 보드는 베어메탈 503대가 법인(OC2 · NJ · WA …)으로 나뉘는데
 *   내보내기 창의 법인 칩은 전부 0대였다. 원인(코드로 확인): v2.967 은 법인을 **vCenter id**(통합 서버 인벤토리 행의 vcenterId)로 나눴다.
 *   이 현장의 물리 전용 서버는 vCenter 가 없고(법인에 vCenter 가 둘 — 'AZ' · 'AZ-IRS' — 이라 '법인의 vCenter 가 하나뿐이면 그 vCenter' 규칙도
 *   닿지 않는다) 법인(DataCenter)으로만 귀속돼 있어 전부 '미지정' 이 됐다.
 *
 * 규칙: **판정을 복제하지 않는다** — 서버 분석과 같은 목록(`analysisServersWithRemote` — mappedVcenterId · 스캔 대역 법인까지 채운 것)에서
 *   `datacenterId || assign[vcenterId || mappedVcenterId]`(= analysisScope.js serverInScope 의 dcOf)로 서버 id · 서비스태그 색인을 만든다.
 *
 * 행 → 법인 순서(makeCorpOf — 순수):
 *   (v2.969) 물리 서버의 수동 법인 지정(insights/fleetDcAssign.js — 통합 서버 인벤토리 화면에서 고친 값)이 가장 먼저. 없는 법인 id 를 가리키면 무시.
 *   가상화 호스트: 그 vCenter 에 할당된 법인.
 *   물리 서버   : 색인(서버 id → 서비스태그) → 행의 vCenter 에 할당된 법인 → 엣지 보고분은 그 에이전트(수집 서버)의 법인.
 *   법인 할당이 없는 vCenter 의 서버는 **그 vCenter 이름으로 따로 묶는다**(id 'vc:<id>' — 아는 소속을 '미지정' 으로 버리지 않는다).
 *   아무것도 없으면 미지정('').
 */
const t = (v) => (v == null ? '' : String(v).trim());
const low = (v) => t(v).toLowerCase();
export const VC_PREFIX = 'vc:';

/** 서버 분석 목록 → { byId, byTag } (법인 id). 같은 태그가 서로 다른 법인이면 그 태그는 뺀다(근거 없음 — corpAttribution.buildVcIndex 와 같은 태도). */
export function buildDcIndex(servers = [], dcOfVc = () => '') {
  const byId = new Map(); const byTag = new Map(); const conflict = new Set();
  for (const s of Array.isArray(servers) ? servers : []) {
    if (!s || typeof s !== 'object') continue;
    const dc = t(s.datacenterId) || t(dcOfVc(t(s.vcenterId || s.mappedVcenterId)));
    if (!dc) continue;
    const id = t(s.id);
    if (id) {
      const key = s.remote ? `remote:${t(s.collectorId)}:${id}` : id;
      if (!byId.has(key)) byId.set(key, dc);
    }
    const tag = low(s.serviceTag || s.inv?.system?.serviceTag);
    if (!tag || conflict.has(tag)) continue;
    const prev = byTag.get(tag);
    if (prev && prev !== dc) { byTag.delete(tag); conflict.add(tag); continue; }
    byTag.set(tag, dc);
  }
  return { byId, byTag, conflicts: conflict.size };
}

/**
 * @param {{ index:{byId:Map,byTag:Map}, dcOfVc:(vcId:string)=>string, dcName:(id:string)=>string, vcName:(id:string)=>string, agentDc?:(agent:string)=>string,
 *           manual?:Object<string,string>, knownDc?:Set<string>|null }} o
 * @returns {(row:object, kind:'bm'|'vh') => {id:string, name:string, src:string}}  id '' = 미지정 · src = manual|scan|vcenter|agent|vcgroup|''
 */
export function makeCorpOf({ index, dcOfVc, dcName, vcName, agentDc = () => '', manual = null, knownDc = null }) {
  const dc = (id, src) => ({ id, name: t(dcName(id)) || id, src });
  // 반증 F1(2026-11-11 — 재현): 이름(name)으로는 찾지 않는다 — 태그 없는 iDRAC 은 IP 로 등록돼 이름이 사설 IP 이고 IP 는 법인끼리 겹친다
  //   (server/CLAUDE.md 8a '서버 대상 = (법인, 키) 쌍'). 저장 키는 화면이 보내는 tagKey 하나(서비스태그 우선, 없으면 서버 id — 서버 id 는
  //   등록부 id · 'remote:<수집>:<id>' 로 법인 사이에 겹치지 않는다). 객체 조회는 자기 키만(Object.hasOwn — 'constructor' 같은 키).
  const manualOf = (row) => {
    if (!manual) return '';
    const k = low(row?.tagKey);
    if (!k || !Object.hasOwn(manual, k)) return '';
    const v = t(manual[k]);
    return v && (!knownDc || knownDc.has(v)) ? v : '';
  };
  return (row, kind) => {
    const vc = t(row?.vcenterId);
    if (kind !== 'vh') {
      const m = manualOf(row);
      if (m) return dc(m, 'manual');
      const id = t(row?.serverId);
      const hit = (t(row?.source) !== 'edge' && id && index?.byId?.get(id)) || index?.byTag?.get(low(row?.serviceTag)) || '';
      if (hit) return dc(hit, 'scan');
    }
    const viaVc = vc ? t(dcOfVc(vc)) : '';
    if (viaVc) return dc(viaVc, 'vcenter');
    if (kind !== 'vh' && t(row?.remoteAgent)) { const a = t(agentDc(t(row.remoteAgent))); if (a) return dc(a, 'agent'); }
    if (vc) return { id: `${VC_PREFIX}${vc}`, name: t(vcName(vc)) || t(row?.vcenter) || vc, src: 'vcgroup' };
    return { id: '', name: '미지정', src: '' };
  };
}
