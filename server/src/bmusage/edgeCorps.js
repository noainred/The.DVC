/**
 * bmusage/edgeCorps.js — '중앙에서 켜기'(v2.927)의 엣지별 법인 매핑 입력을 모은다(중앙 전용 · 가볍다).
 *
 * 판정은 `targets.js edgeCorpIndex` 하나다 — 여기는 입력만 고른다:
 *  · vCenter 등록부(`loadVcenterConfig`) — 사이트 vCenter 의 `remoteAgent`(관리자가 선언한 담당 엣지).
 *  · 위임 인벤토리 소유(`central/inventory.js listInventory`) — 그 vCenter 인벤토리를 올린 엣지(디스크에 남는다).
 *  · 메모리 스냅샷(`store.get().vcenters`) — 관측 collectedBy(첫 병합 전 골격 · 점검중 · 비활성 행에는 없다 — 그래서 ①·② 가 먼저다).
 *  · 엣지 보고 베어메탈(`central/fleet.js getEdgeFleetServers`) — vCenter 는 중앙이 직접 수집하고 iDRAC 만 엣지에 맡긴 법인.
 *
 * ⚠⚠ 이 매핑은 **저장 때** 쓴다(반증 F2·F3 결정): 관리자가 확인 상자에서 본 법인 목록을 `perEdge[agent].corps` 로 저장하고, 엣지 인출은
 *   **저장 목록을 그대로** 보낸다. 매핑이 일시적으로 비거나(점검중 · 비활성 · push 전 · fleet 만료 · 중앙 재기동) 바뀌어도 엣지 수집을 끄지 않는다.
 *   지금 매핑은 화면이 '법인 매핑이 바뀜 — 다시 확인 필요' 를 가르는 데만 쓴다(엣지 인출 경로에는 들어가지 않는다).
 */
import { store } from '../store.js';
import { loadVcenterConfig } from '../config.js';
import { listInventory } from '../central/inventory.js';
import { getEdgeFleetServers } from '../central/fleet.js';
import { edgeCorpIndex, edgeCorpIds } from './targets.js';

/**
 * 지금 입력으로 매핑 조회 함수를 만든다 — 입력은 처음 물을 때 한 번만 모은다(한 요청 안에서 행마다 다시 모으지 않는다).
 * 원천 하나를 못 읽으면 그 원천만 빈 값으로 둔다(다른 원천으로 판정을 이어 간다 — 결과는 확인 상자가 이름으로 보여 준다).
 * @returns {(agent:string) => string[]}
 */
export function edgeCorpsSource() {
  let idx = null;
  return (agent) => {
    if (!idx) {
      const safe = (fn) => { try { const v = fn(); return Array.isArray(v) ? v : []; } catch { return []; } };
      idx = edgeCorpIndex({
        registry: safe(() => loadVcenterConfig().vcenters),
        inventory: safe(() => listInventory()),
        vcenters: safe(() => store.get()?.vcenters),
        bareMetal: safe(() => getEdgeFleetServers()),
      });
    }
    return edgeCorpIds({ agent }, idx);
  };
}
