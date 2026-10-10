/**
 * 읽지 못해 합계에서 뺀 것을 말하는 문구(v2.733 점검 3회차 — 순수 모듈, 웹 테스트로 고정).
 *
 * ① vCenter 추정 전력(C2-02): 읽지 못한 vCenter(연결 실패로 마지막 정상 값 이월 · 엣지 보고 낡음 · 점검중)와 연결이 끊긴 호스트의
 *    powerWatts 는 몇 시간 전 값이다. 서버(`idrac/service.js vcPowerSkipReason`)가 합계에서 빼고 `vcPowerSkipped` 로
 *    `{ hosts, vcenters, byReason }` 를 싣는다. 이 문구가 없으면 화면이 '전력이 줄었다' 로 읽힌다(조용한 제외 금지).
 * ② 호스트 용량(C2-06): REST 폴백 vCenter 의 호스트는 코어·CPU·메모리 총량이 없다. 서버가 용량 합에서 빼고 `capacityUnknown`
 *    으로 센다 — 그 칸의 비율·여유는 '—' 이고, 이 문구가 이유를 말한다.
 * 사유 키는 서버 `vcPowerSkipReason` 의 반환값과 1:1 이다(테스트가 서버 소스와 대조한다).
 */

export const VC_POWER_SKIP_REASON_TEXT = Object.freeze({
  unreachable: '연결 실패(마지막 정상 값)',
  stale: '엣지 보고 낡음',
  maintenance: '점검중',
  'host-unread': '호스트 연결 끊김',
});

const countOf = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/**
 * @param {{hosts?:number, byReason?:Record<string,number>}|null|undefined} s  응답의 vcPowerSkipped
 * @returns {string|null}  뺀 것이 없으면 null
 */
export function vcPowerSkippedNote(s) {
  const n = countOf(s?.hosts);
  if (!n) return null;
  const by = s && typeof s.byReason === 'object' && s.byReason ? s.byReason : {};
  const parts = Object.entries(by)
    .filter(([, v]) => countOf(v) > 0)
    .map(([k, v]) => `${VC_POWER_SKIP_REASON_TEXT[k] || k} ${countOf(v)}`);
  return `vCenter 추정 전력 ${n}대(${parts.join(' · ') || '사유 미상'})는 지금 값이 아니라서 합계에서 뺐습니다 — 소비가 줄었다는 뜻이 아닙니다.`;
}

/**
 * @param {number|null|undefined} n  capacityUnknown(용량을 못 읽은 호스트 수)
 * @returns {string|null}
 */
export function capacityUnknownNote(n) {
  const c = countOf(n);
  if (!c) return null;
  return `용량(코어·CPU·메모리 총량)을 읽지 못한 호스트 ${c}대(REST 폴백 수집)는 총량에서 뺐고, 그 클러스터의 vCPU:코어·RAM 오버커밋·여유는 '—' 입니다.`;
}

/** 비율 표기 — 값이 없으면 '—'(0:1 이 아니다). */
export function ratioText(v) {
  return typeof v === 'number' && Number.isFinite(v) ? `${v}:1` : '—';
}
