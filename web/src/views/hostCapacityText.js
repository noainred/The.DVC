/**
 * hostCapacityText.js — '용량을 모르는 호스트' 를 총량 옆에 말하는 문구(v2.742 LEFT-06, 순수 모듈 — 웹 테스트로 고정).
 *
 * 서버 롤업(store.js)은 v2.733(C2-06)부터 코어·CPU·메모리 총량을 **읽은 호스트만** 더하고, 못 읽은 호스트(REST 폴백 수집)는
 * `hostsCapacityUnknown` 으로 센다(전역 rollups.global · vCenter 카드의 metrics · 리전 묶음 모두). 그런데 웹 어디에서도 이 값을
 * 읽지 않아 부분 합인 총량이 '전체' 처럼 보였다(조용한 제외 — CLAUDE.md '뺀 것은 반드시 밝힌다').
 *
 * 규칙: 칸 옆에는 **짧은 표지**만(`hostCapShort`), 왜 빠졌는지는 화면당 **한 번** 각주로(`hostCapFootnote`) — 행·칸마다 긴 문장을
 * 반복하면 같은 말이 화면을 덮는다(v2.509 규약). 문구에 백틱·별표 두 개를 쓰지 않는다(BoldText 규약 — 평문으로도 그린다).
 * 클러스터 칸의 비율 문구는 readGapText.capacityUnknownNote 가 따로 소유한다(뜻이 다르다: 그쪽은 '비율을 계산하지 않았다').
 */

/** 개수 읽기 — 양의 유한수만(null·문자열·음수는 0 = 표시 없음). */
export function hostCapCount(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** 총량 옆 짧은 표지 — 없으면 null. 예: '3대 용량 모름 — 합계 제외' */
export function hostCapShort(n) {
  const c = hostCapCount(n);
  return c ? `${c.toLocaleString('en-US')}대 용량 모름 — 합계 제외` : null;
}

/** 화면당 한 번 쓰는 각주 — 없으면 null. */
export function hostCapFootnote(n) {
  const c = hostCapCount(n);
  if (!c) return null;
  return `용량(코어·CPU·메모리 총량)을 읽지 못한 호스트 ${c.toLocaleString('en-US')}대(REST 폴백 수집)는 총량 합계에서 뺐습니다 — 표시된 총량은 부분 합이고, 그 호스트가 없다는 뜻이 아닙니다.`;
}

/**
 * vCenter 목록(`/vcenters` 의 sites[].metrics)에서 용량 모름 호스트 합 — 비교 매트릭스·vCenter 화면의 각주에 쓴다.
 * @param {Array<{metrics?:{hostsCapacityUnknown?:number}}>} sites
 */
export function hostCapTotal(sites) {
  let t = 0;
  for (const s of Array.isArray(sites) ? sites : []) t += hostCapCount(s?.metrics?.hostsCapacityUnknown);
  return t;
}

/** 비교 매트릭스 vCenter 축에서 이 표지를 붙일 지표(총량 — 사용률은 읽은 호스트만이라 해당 없음). */
export const HOST_CAP_METRICS = Object.freeze(['cpuTotalGhz', 'memTotalGB']);
