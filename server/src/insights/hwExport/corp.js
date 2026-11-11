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
 * 행 → 법인 순서(makeCorpOf — 순수) — **수집한 Agent(수집 서버)의 법인이 기준**(사용자 결정 2026-11-11 'Agent 자동 판정만' — 서버마다 법인을 손으로 지정하는 길은 두지 않는다.
 *   v2.971 부터 수집 서버(Agent) ↔ 법인은 설정 › 수집 서버에서 사용자가 매칭할 수 있고, 그 결과가 아래 '수집한 Agent 의 법인' 에 이미 들어 있다):
 *   물리 서버   : 서버 분석 색인(엣지 서버 = 그 엣지(수집 서버)의 법인 · Agent 로 스캔한 대역의 서버 = 그 Agent 의 법인 · 스캔 등록 법인)
 *                 → 행의 vCenter 에 할당된 법인 → 엣지 보고분은 보고한 에이전트의 법인.
 *   가상화 호스트: 그 vCenter 에 할당된 법인.
 *   법인 할당이 없는 vCenter 의 서버는 **그 vCenter 이름으로 따로 묶는다**(id 'vc:<id>' — 아는 소속을 '미지정' 으로 버리지 않는다).
 *   아무것도 없으면 미지정('') — **왜 모르는지(why)** 를 함께 준다(지어내지 않고 아는 사실만).
 */
const t = (v) => (v == null ? '' : String(v).trim());
const low = (v) => t(v).toLowerCase();
export const VC_PREFIX = 'vc:';

/**
 * 서버 분석 목록 → { byId, byTag, whyId, whyTag } (법인 id). 같은 태그가 서로 다른 법인이면 그 태그는 뺀다(근거 없음 — corpAttribution.buildVcIndex 와 같은 태도).
 * 법인을 모르는 서버는 이유를 남긴다(why — 서버 분석 목록이 아는 사실만): 스캔 대역이 서로 다른 법인으로 겹침 · 엣지 서버인데 그 수집 서버의 법인 이름이
 * DataCenter 목록과 맞지 않음 · 그 밖(Agent 로 스캔한 대역 밖이고 vCenter 할당 없음).
 */
export function buildDcIndex(servers = [], dcOfVc = () => '') {
  const byId = new Map(); const byTag = new Map(); const conflict = new Set();
  const whyId = new Map(); const whyTag = new Map();
  for (const s of Array.isArray(servers) ? servers : []) {
    if (!s || typeof s !== 'object') continue;
    const dc = t(s.datacenterId) || t(dcOfVc(t(s.vcenterId || s.mappedVcenterId)));
    const id = t(s.id);
    const key = id ? (s.remote ? `remote:${t(s.collectorId)}:${id}` : id) : '';
    if (!dc) {
      const why = s.dcSource === 'scan-ambiguous' ? '스캔 대역이 서로 다른 법인으로 겹칩니다'
        : s.remote ? `수집 서버 ‘${t(s.collectorId) || '?'}’ 의 법인 이름이 DataCenter 목록과 맞지 않습니다`
          : 'Agent 로 스캔한 대역 밖이고 vCenter 할당도 없습니다';   // ⚠ '수집 서버 ‘' 글자는 makeCorpOf 의 whyCode 판정이 읽는다
      if (key && !whyId.has(key)) whyId.set(key, why);
      const tg = low(s.serviceTag || s.inv?.system?.serviceTag);
      if (tg && !whyTag.has(tg)) whyTag.set(tg, why);
      continue;
    }
    if (key && !byId.has(key)) byId.set(key, dc);
    const tag = low(s.serviceTag || s.inv?.system?.serviceTag);
    if (!tag || conflict.has(tag)) continue;
    const prev = byTag.get(tag);
    if (prev && prev !== dc) { byTag.delete(tag); conflict.add(tag); continue; }
    byTag.set(tag, dc);
  }
  return { byId, byTag, whyId, whyTag, conflicts: conflict.size };
}

/**
 * @param {{ index:{byId:Map,byTag:Map,whyId?:Map,whyTag?:Map}, dcOfVc:(vcId:string)=>string, dcName:(id:string)=>string, vcName:(id:string)=>string, agentDc?:(agent:string)=>string }} o
 * @returns {(row:object, kind:'bm'|'vh') => {id:string, name:string, src:string, why?:string}}  id '' = 미지정 · src = scan|vcenter|agent|vcgroup|''
 */
export function makeCorpOf({ index, dcOfVc, dcName, vcName, agentDc = () => '' }) {
  const dc = (id, src) => ({ id, name: t(dcName(id)) || id, src });
  return (row, kind) => {
    const vc = t(row?.vcenterId);
    const id = t(row?.serverId);
    const tag = low(row?.serviceTag);
    if (kind !== 'vh') {
      const hit = (t(row?.source) !== 'edge' && id && index?.byId?.get(id)) || index?.byTag?.get(tag) || '';
      if (hit) return dc(hit, 'scan');
    }
    const viaVc = vc ? t(dcOfVc(vc)) : '';
    if (viaVc) return dc(viaVc, 'vcenter');
    if (kind !== 'vh' && t(row?.remoteAgent)) { const a = t(agentDc(t(row.remoteAgent))); if (a) return dc(a, 'agent'); }
    if (vc) return { id: `${VC_PREFIX}${vc}`, name: t(vcName(vc)) || t(row?.vcenter) || vc, src: 'vcgroup' };
    if (kind === 'vh') return { id: '', name: '미지정', src: '', why: 'vCenter 를 모릅니다' };
    const why = (t(row?.remoteAgent) && `보고한 에이전트 ‘${t(row.remoteAgent)}’ 의 법인 이름이 DataCenter 목록과 맞지 않습니다`)
      || (t(row?.source) === 'ome' && 'OME 로만 수집 — 수집한 Agent 의 법인을 알 수 없습니다')
      || (id.startsWith('host:') && '수동으로 물리 분류한 ESXi 호스트 — vCenter 의 법인 할당이 없습니다')
      || (t(row?.source) !== 'edge' && id && index?.whyId?.get(id)) || index?.whyTag?.get(tag)
      || '수집한 Agent 의 법인을 알 수 없습니다';
    // v2.971: 수집 서버(Agent) ↔ 법인 매칭으로 고칠 수 있는 이유면 표지(화면이 설정 › 수집 서버 링크를 단다).
    const whyCode = /수집 서버 ‘|보고한 에이전트 ‘/.test(why) ? 'collector' : '';
    return { id: '', name: '미지정', src: '', why, ...(whyCode ? { whyCode } : {}) };
  };
}
