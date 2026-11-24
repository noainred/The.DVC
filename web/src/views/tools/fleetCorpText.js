/**
 * fleetCorpText.js — 통합 서버 인벤토리의 법인(DataCenter) 표시 · 필터(v2.969 · 사용자 요청 '통합 서버 인벤토리 화면도 법인(DataCenter) 기준으로' ·
 *   '서버 분석처럼 수집한 Agent 이름에 따라 분류' — 수동 법인 지정은 두지 않는다).
 * 판정은 서버(/insights/fleet 의 corpId · corpName · corpSource — insights/hwExport/corp.js)가 한다. 여기서는 고르기 · 글자만.
 */
export const UNASSIGNED = '__none__';
/** v2.972: 수집 서버 ↔ 법인 매칭 화면(설정 › 수집 서버). */
export const COLLECTOR_DC_HREF = '#/settings/collectors';
/** 법인 판정 출처 → [짧은 표시, 설명]. 서버 makeCorpOf 의 src 값과 같은 이름. */
export const CORP_SRC = Object.freeze({
  scan: ['Agent', '수집한 Agent(수집 서버)의 법인 · 스캔 등록 법인(Physical Server 와 같은 판정)'],
  vcenter: ['vCenter', '그 서버의 vCenter 에 할당된 법인'],
  agent: ['엣지', '보고한 엣지(수집 서버)의 법인'],
  vcgroup: ['vCenter 묶음', '법인이 할당되지 않은 vCenter — vCenter 이름으로 따로 묶었습니다'],
});
/** 행이 화면 필터(법인 id · '__none__' · '')에 드는가. */
export const inCorp = (row, f) => !f || (f === UNASSIGNED ? !row?.corpId : row?.corpId === f);
/** 필터 선택지 — 서버가 준 법인 목록(서버가 있는 법인만 · 설정의 법인 순서 · 미지정 맨 뒤) 그대로, 대수를 붙여서. */
export function corpOptions(corps) {
  return (Array.isArray(corps) ? corps : []).map((c) => ({ value: c.id, label: `${c.name} (물리 ${c.bm || 0} · 가상화 ${c.vh || 0})` }));
}
