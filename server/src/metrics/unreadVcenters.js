/**
 * metrics/unreadVcenters.js — '지금 값' 으로 쓰지 않는 vCenter 와 그 사유(순수 leaf — import 0).
 *
 * v2.733(점검 3회차 C2-02): 이 판정은 v2.621 부터 `metrics/sampler.js` 안에 있었다. 그런데 vCenter 추정 전력 적재
 *   (`store.js persistVcenterPower`)와 전력 합산(`idrac/service.js allMeasuredPower`)도 **같은 판정**이 필요하고, 두 모듈은
 *   sampler 를 import 할 수 없다(sampler 가 store 를 import 한다 — store → sampler 는 순환 SCC 가 하나 늘어난다,
 *   server/test/arch2579.test.js ②-b). 그래서 판정 본체를 import 가 없는 이 파일로 옮긴다 — 판정은 여기 하나다.
 *   ⚠ sampler.js 는 이 함수를 재수출해야 한다(사본을 두지 말 것 — server/test/audit2733d.test.js 가 두 결과를 대조한다).
 *
 * 사유:
 *   · `maintenance` — 점검중. store.js 가 직전 캐시를 **기한 없이** 이어 서빙하고 stale 표시도 붙이지 않는다.
 *   · `unreachable` — 수집 실패 이월(LASTGOOD) 또는 최소 항목.
 *   · `stale` — 위임(site) push 가 낡았다(상태는 엣지가 준 값 그대로라 stale 표시로만 안다).
 *   ⚠ `pending`(첫 수집 중)은 넣지 않는다 — 적재할 데이터가 없어 제외 효과가 없고, 넣으면 영영 push 가 오지 않는 site
 *     vCenter 하나가 전체('') 합계를 **영원히** 막는다(v2.621 RECENT-03 · v2.622 RECENT-01).
 * @returns {Map<string,'maintenance'|'unreachable'|'stale'>}
 */
export function unreadVcenterReasons(snap) {
  const out = new Map();
  for (const vc of snap?.vcenters || []) {
    if (!vc || vc.id == null) continue;
    const reason = (vc.status === 'maintenance' || vc.maintenance === true) ? 'maintenance'
      : vc.status === 'unreachable' ? 'unreachable'
        : vc.stale === true ? 'stale' : null;
    if (reason) out.set(String(vc.id), reason);
  }
  return out;
}
