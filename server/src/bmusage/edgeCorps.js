/**
 * bmusage/edgeCorps.js — '중앙에서 켜기'(v2.927)의 엣지별 법인 매핑 입력을 모은다(중앙 전용 · 가볍다).
 *
 * 판정은 `targets.js edgeCorpIndex` 하나다(사이트 위임 vCenter 규칙은 resolveTargets 와 같은 siteAgentByVcenter) — 여기는 입력만 고른다:
 *  · vCenter 목록: 메모리 스냅샷(`store.get().vcenters`) — 사이트 vCenter 에 그 엣지 이름(collectedBy)이 붙어 있다.
 *  · 엣지 보고 베어메탈: `central/fleet.js getEdgeFleetServers()`(엣지 push 캐시 — 정제·TTL 은 그 모듈) — 분류 전체(getFleetInventory)를
 *    엣지 인출마다 돌리지 않는다(28곳 × 10분 주기 인출 경로다). 엣지 대상 거름(corps[vc])은 **엣지 쪽 귀속**으로 하므로 엣지가 보고한
 *    vcenterId 가 그 거름에 가까운 값이다(중앙의 수동 지정은 엣지 대상 판정에 쓰이지 않는다). ⚠ 정직 기록: 엣지 bm-usage 는 빈 귀속을
 *    `attributeBareMetalFromSnap` 으로 더 채우는데 fleet push 행에는 그 보충이 없을 수 있다 — 그런 서버의 법인은 ①(사이트 vCenter)로만 잡힌다.
 *
 * ⚠⚠ **매핑 준비 전에는 판정하지 않는다**(`ready:false`): 중앙 기동 직후 첫 병합 전 스냅샷(골격 · `initial`)에는 사이트 vCenter 의
 *   collectedBy 가 없다 — 그때 '법인 0' 으로 답하면 켜 둔 엣지가 사본을 지워 꺼졌다가 다음 인출에 다시 켜진다(재시작마다 깜빡임).
 *   준비 전 인출은 라우트가 503 으로 답하고(엣지는 마지막 사본 유지), 보류에는 시한(`MAPPING_HOLD_MAX_MS`)을 둔다 — 첫 병합이
 *   끝내 오지 않아도 시한이 지나면 있는 값으로 판정한다(보류에는 반드시 시한 — 루트 CLAUDE.md).
 */
import { store } from '../store.js';
import { getEdgeFleetServers } from '../central/fleet.js';
import { edgeCorpIndex, edgeCorpIds } from './targets.js';

const STARTED_AT = Date.now();
/** 기동 뒤 첫 병합을 기다리는 최대 시간. 엣지 인출 기본 주기(10분)보다 조금 길게 — 그 안에 한 번은 503 을 받고 사본을 유지한다. */
export const MAPPING_HOLD_MAX_MS = 15 * 60_000;

let _override = null;

/**
 * 지금 입력으로 매핑 조회 함수를 만든다(한 요청 안에서 한 번 — 행마다 다시 모으지 않는다).
 * @returns {(agent:string) => {ready:boolean, ids:string[]}}
 */
export function edgeCorpsSource({ now = Date.now() } = {}) {
  if (_override) return _override;
  // 입력은 처음 물을 때 한 번만 모은다(중앙 켜기가 없는 인출에서는 아무것도 하지 않는다).
  let ready = false; let idx = null;
  return (agent) => {
    if (!idx) {
      const snap = store.get();
      // 골격(initial) · 첫 수집 전 빈 스냅샷(rollups 없음)은 '아직 모른다' 다.
      const merged = !!snap && snap.initial !== true && snap.rollups != null;
      ready = merged || now - STARTED_AT > MAPPING_HOLD_MAX_MS;
      let bareMetal = [];
      try { bareMetal = getEdgeFleetServers(); } catch { bareMetal = []; }
      idx = edgeCorpIndex({ vcenters: Array.isArray(snap?.vcenters) ? snap.vcenters : [], bareMetal });
    }
    return { ready, ids: edgeCorpIds({ agent }, idx) };
  };
}

/** 테스트 전용 — 매핑 조회 함수를 바꿔 끼운다(null 이면 원래대로). */
export function _setEdgeCorpsSourceForTest(fn) { _override = typeof fn === 'function' ? fn : null; }
