/**
 * views/vcdVmList.js — vCenter › VM 및 폴더 'VM 목록 CSV' 요청 본문(순수, v2.792).
 *
 * 사용자 요청: "vm list export 할때 Veeam 백업여부, 백업여부 판단할 수 있는 snapshot 포함여부 포함해서 csv export" · 선택 '화면 기준 전체'.
 *  · 화면이 보이는 VM 그대로 — 검색어가 있으면 일치 VM, 없으면 트리의 VM(‘Off VM 포함’ 해제면 꺼진 VM 제외 = visibleVms).
 *  · 서버는 받은 id 를 그 vCenter 의 지금 인벤토리와 교집합한다(routes/api/veeam.js POST /veeam/vm-list.csv). Veeam·스냅샷 판정은 서버가 한다.
 *  · id 가 상한(서버 VM_LIST_MAX_IDS)을 넘으면 검색이 없을 때만 id 없이 전원 조건(power)을 보낸다 — 서버가 같은 조건으로 고른다.
 *    검색 결과가 상한을 넘으면 잘라 보내지 않고 거절한다(일부만 담긴 파일을 '검색 결과 전체' 로 내보내지 않는다).
 *  · view(search · all · noOff)는 표시용 이름표다 — 서버가 파일 이름·엑셀 요약의 '화면 조건' 에만 쓰고 대상은 ids/power 로 고른다.
 *  · 같은 본문을 CSV(POST /veeam/vm-list.csv)와 엑셀(POST /veeam/vm-list.xlsx — 폴더 트리, 시안 승인)이 함께 쓴다.
 */
export const VM_LIST_MAX_IDS = 20_000;   // 서버 routes/api/veeam.js 와 같은 값(넘으면 서버도 400)

/**
 * @param {{ query?:string, matches?:Array<{v:{id:string}}>, visibleVms?:Array<{id:string}>, inclPoweredOff?:boolean, max?:number }} a
 * @returns {{ body: object|null, count: number, error?: string }}
 */
export function vmListRequest({ query = '', matches = [], visibleVms = [], inclPoweredOff = true, max = VM_LIST_MAX_IDS } = {}) {
  const searching = !!String(query || '').trim();
  const list = searching ? (matches || []).map((m) => m.v).filter(Boolean) : (visibleVms || []);
  const view = searching ? 'search' : inclPoweredOff ? 'all' : 'noOff';
  if (list.length <= max) return { body: { ids: list.map((v) => v.id), view }, count: list.length };
  if (searching) return { body: null, count: list.length, error: `검색 결과가 ${list.length}대라 한 번에 내보낼 수 있는 ${max}대를 넘습니다 — 검색어를 좁혀 주세요.` };
  return { body: { power: inclPoweredOff ? 'all' : 'noOff', view }, count: list.length };
}
