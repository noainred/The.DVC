/**
 * views/vcdVmList.js — VM 목록 내보내기(POST /veeam/vm-list.csv|.xlsx) 의 한 번에 보낼 수 있는 VM id 상한(v2.792).
 *
 * v2.800(사용자 지시 "vCenter 화면은 전체 VM, 백업 현황은 백업 — 분리"): 이 내보내기는 서버 › Veeam 백업 현황 › Detail 의 'CSV · 엑셀…'(백업 내보내기 창)로 옮겼다.
 *   vCenter 화면의 요청 본문 함수(vmListRequest)는 쓰는 곳이 없어 지웠다 — 백업 화면 대상은 vmListExportText.backupScreenRequest.
 */
export const VM_LIST_MAX_IDS = 20_000;   // 서버 routes/api/veeam.js 와 같은 값(넘으면 서버도 400)
