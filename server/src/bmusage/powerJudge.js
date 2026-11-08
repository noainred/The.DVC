/**
 * bmusage/powerJudge.js — 반증 n2 F4: 전력 · 온도 알림의 **판정 노드를 정하는 함수 하나**(순수 — 서버 하나에 판정 노드 최대 1개).
 *
 * 알림 판정 입력(powerAlerts.powerAlertItems — 각 노드의 폴러 · 시험 실행)과 중앙 전력 보기(routes/api/bmPower.js)가 같은 함수를 쓴다.
 *   판정 노드 = 그 서버를 **대상으로 갖고**(bmusage 대상 — 엣지 위임 서버는 그 엣지) **전력 원천도 가진** 노드.
 *   · 대상 노드 T: via local → 이 노드(self) · via edge → 그 엣지(s.node)
 *   · 원천: 측정 source idrac · ome = 이 보기 노드의 iDRAC 폴러 · remote = 엣지 사본(그 엣지) · 미측정 = 모름(판정은 대상 노드 — 값이 없어 보류)
 *   · 원천 ≠ 대상이면 판정 노드 없음:
 *       source-edge     이 노드 대상인데 전력이 엣지 사본뿐(엣지 iDRAC 원천 · 대상은 이 노드)
 *       source-central  엣지 대상인데 전력이 이 노드(중앙) 원천뿐 — OME 등(그 엣지에는 표본이 없다)
 *   · 중앙 보기에서 이 노드 대상 서버의 법인을 엣지가 맡으면(corpOwner — 사이트 vCenter 담당 · 엣지 보고 베어메탈) 중앙은 판정하지 않는다:
 *       그 엣지 봉투 대상에 같은 (법인, 키)가 있으면 판정 노드 = 그 엣지 · 없으면 corp-edge-owned(판정 없음 — 그 엣지 대상이 아니면 아무도 판정하지 않는다).
 *     ⚠ 반증 의심 S1(같은 물리 서버가 중앙 · 엣지 iDRAC 등록부 둘 다 → 중앙 분류는 로컬 등록을 먼저 잡아 중앙 대상 · 엣지도 자기 대상 → 두 노드가 판정)을 막는 규칙이다.
 *     법인 담당 매핑이 잠시 비면(기동 직후 · 엣지 보고 만료) 그동안 중앙도 판정할 수 있다(정직 기록 — edgeCorps.js 의 입력 규약과 같다).
 * 랙 판정 노드(rackJudgeOf): 배치 서버 전부의 판정 노드가 같을 때만 그 노드 · 목록에 없는 배치 서버(member-unknown) · 판정 노드 없는 서버(member-no-judge) · 서로 다름(members-split)은 없음.
 */
export const JUDGE_REASONS = Object.freeze(['source-edge', 'source-central', 'corp-edge-owned', 'member-unknown', 'member-no-judge', 'members-split']);
const t = (v) => String(v ?? '').trim();

/**
 * @param {{via?:string, node?:string, vcenterId?:string, key?:string, src?:string|null}} s  gatherPower 서버 기록
 * @param {{ self?:string, isEdge?:boolean, corpOwner?:(vc:string)=>string, edgeHas?:(vc:string, key:string)=>string }} ctx
 * @returns {{ node:string|null, reason:string|null, owner?:string }}
 */
export function judgeOf(s, { self = '', isEdge = false, corpOwner = () => '', edgeHas = () => '' } = {}) {
  const src = t(s?.src) || null;
  if (s?.via === 'edge') {
    if (src === 'idrac' || src === 'ome') return { node: null, reason: 'source-central' };
    return { node: t(s.node), reason: null };
  }
  if (src === 'remote') return { node: null, reason: 'source-edge' };
  if (!isEdge) {
    let owner = '';
    try { owner = t(corpOwner(t(s?.vcenterId))); } catch { owner = ''; }
    if (owner) {
      let e = '';
      try { e = t(edgeHas(t(s?.vcenterId), t(s?.key))); } catch { e = ''; }
      return e ? { node: e, reason: null } : { node: null, reason: 'corp-edge-owned', owner };
    }
  }
  return { node: t(self), reason: null };
}

/** 랙 판정 노드(순수). judges = 목록에 있는 배치 서버의 judgeOf 결과 · notTarget = 목록에 없는 배치 서버 수. */
export function rackJudgeOf(judges = [], notTarget = 0) {
  if (notTarget > 0) return { node: null, reason: 'member-unknown' };
  if (!judges.length) return { node: null, reason: 'member-unknown' };
  if (judges.some((j) => !j || j.node == null)) return { node: null, reason: 'member-no-judge' };
  const nodes = new Set(judges.map((j) => j.node));
  return nodes.size === 1 ? { node: [...nodes][0], reason: null } : { node: null, reason: 'members-split' };
}

/**
 * 이 노드의 판정 문맥 — self(이 노드 이름) · isEdge · 중앙이면 법인 담당 엣지(edgeCorps 입력 — 사이트 vCenter 담당 · 위임 인벤토리 · 스냅샷 · 엣지 보고 베어메탈).
 *   원천 하나를 못 읽으면 그 원천만 빈 값(edgeCorps.js 규약) — 매핑 전체를 못 만들면 담당 없음으로(중앙이 판정 — 정직 기록).
 */
export async function judgeContext({ edgeHas = null } = {}) {
  const { config } = await import('../config.js');
  const self = t(config.agent?.name);
  const isEdge = !!config.agent?.centralUrl;
  let corpOwner = () => '';
  if (!isEdge) {
    try { corpOwner = (await import('./edgeCorps.js')).corpOwnerSource(); } catch { corpOwner = () => ''; }
  }
  return { self, isEdge, corpOwner, ...(edgeHas ? { edgeHas } : {}) };
}
