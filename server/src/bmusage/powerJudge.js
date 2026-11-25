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
 *     ⚠ 이중 판정 창(반증 n2 재확인 N3 — 고치지 않음 · 정직 기록): 엣지 담당을 **엣지 보고 베어메탈(fleet push)로만** 아는 법인(vCenter 는 중앙 직접 · iDRAC 만 엣지)은
 *     그 보고가 만료(central/fleet.js TTL 30분 무보고)되면 매핑이 비어 중앙이 다시 판정한다 — 엣지가 정말 꺼졌으면 대체 판정이라 이롭고, 엣지는 살아 있는데 push 만 끊긴
 *     동안만 같은 서버를 두 노드가 판정한다. 등록부 사이트 vCenter(collectMode site + remoteAgent)로 아는 법인은 디스크 원천이라 이 창이 없다.
 *   · 중앙 보기에서 법인을 맡은 엣지의 **봉투가 없으면**(꺼짐 · 당기기 실패 · 아직 안 당김 — edgeKnown 거짓) 판정 여부를 모른다: judge-unknown(‘없음’ 으로 단정하지 않는다 —
 *     반증 n2 재확인 N4). 폴러(봉투를 보지 않는다)에서는 corp-edge-owned 와 같다(중앙은 판정하지 않는다).
 *   · 엣지 대상인데 그 엣지 봉투에 **이 판의 표지(powerCapVer)가 없으면** 그 엣지 판에는 전력 알림 규칙이 없다: edge-old(판정 없음 — 표지는 정제가 작은 양의 정수만 남기므로
 *     값이 이상해도 표지 없음 = old-version 규약과 같다 · 반증 n2 재확인 N5). gatherPower 기록의 capState 'old-version' 이 그 표지다(edgeCapIndex — 같은 봉투 표지).
 * 랙 판정 노드(rackJudgeOf): 배치 서버 전부의 판정 노드가 같을 때만 그 노드 · 목록에 없는 배치 서버(member-unknown) · 판정 노드 없는 서버(member-no-judge) · 서로 다름(members-split)은 없음.
 */
export const JUDGE_REASONS = Object.freeze(['source-edge', 'source-central', 'corp-edge-owned', 'judge-unknown', 'edge-old', 'member-unknown', 'member-no-judge', 'members-split']);
const t = (v) => String(v ?? '').trim();

/**
 * @param {{via?:string, node?:string, vcenterId?:string, key?:string, src?:string|null}} s  gatherPower 서버 기록
 * @param {{ self?:string, isEdge?:boolean, corpOwner?:(vc:string)=>string, edgeHas?:(vc:string, key:string)=>string }} ctx
 * @returns {{ node:string|null, reason:string|null, owner?:string }}
 */
export function judgeOf(s, { self = '', isEdge = false, corpOwner = () => '', edgeHas = () => '', edgeKnown = null } = {}) {
  const src = t(s?.src) || null;
  if (s?.via === 'edge') {
    if (s?.capState === 'old-version') return { node: null, reason: 'edge-old' };
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
      if (e) return { node: e, reason: null };
      let known = true;
      if (typeof edgeKnown === 'function') { try { known = !!edgeKnown(owner); } catch { known = false; } }
      return { node: null, reason: known ? 'corp-edge-owned' : 'judge-unknown', owner };
    }
  }
  return { node: t(self), reason: null };
}

/** 랙 판정 노드(순수). judges = 목록에 있는 배치 서버의 judgeOf 결과 · notTarget = 목록에 없는 배치 서버 수. */
export function rackJudgeOf(judges = [], notTarget = 0) {
  if (notTarget > 0) return { node: null, reason: 'member-unknown' };
  if (!judges.length) return { node: null, reason: 'member-unknown' };
  if (judges.some((j) => j && j.node == null && j.reason === 'judge-unknown')) return { node: null, reason: 'judge-unknown' };
  if (judges.some((j) => !j || j.node == null)) return { node: null, reason: 'member-no-judge' };
  const nodes = new Set(judges.map((j) => j.node));
  return nodes.size === 1 ? { node: [...nodes][0], reason: null } : { node: null, reason: 'members-split' };
}

/**
 * 이 노드의 판정 문맥 — self(이 노드 이름) · isEdge · 중앙이면 법인 담당 엣지(edgeCorps 입력 — 사이트 vCenter 담당 · 위임 인벤토리 · 스냅샷 · 엣지 보고 베어메탈).
 *   원천 하나를 못 읽으면 그 원천만 빈 값(edgeCorps.js 규약) — 매핑 전체를 못 만들면 담당 없음으로(중앙이 판정 — 정직 기록).
 */
export async function judgeContext({ edgeHas = null, edgeKnown = null } = {}) {
  const { config } = await import('../config.js');
  const self = t(config.agent?.name);
  const isEdge = !!config.agent?.centralUrl;
  let corpOwner = () => '';
  if (!isEdge) {
    try { corpOwner = (await import('./edgeCorps.js')).corpOwnerSource(); } catch { corpOwner = () => ''; }
  }
  return { self, isEdge, corpOwner, ...(edgeHas ? { edgeHas } : {}), ...(edgeKnown ? { edgeKnown } : {}) };
}
