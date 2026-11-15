/**
 * veeam/summaryRegion.js — Backup 현황 · Summary 의 **리전 범위**(v3.10.17 · 가상화 플랫폼 점검 5회차).
 *  - 가상화 플랫폼 허브에서 리전만 고른 채 백업 KPI 카드를 누르면 Summary 가 그 리전 법인만 센다(VM · 스토리지 추이 도구의 ?region= 과 같은 규약 — v3.10.15).
 *  - 리전은 **사용자 범위(scopedVcenterIds) 교집합 뒤**에 거른다 — 범위 밖 vCenter 는 리전으로도 보이지 않는다. 모르는 리전이면 빈 목록(지어내지 않는다).
 *  - 숫자 줄 · 두 카드 · 트리 · CSV · 용량과 일정 · 에러 로그 · 백업 안 된 VM 찾기가 같은 함수로 거른다('리전 합계가 제목뿐이지 않게' — v3.10.15 교훈).
 */
export const regionOf = (vc) => String(vc?.location?.region || '').trim();
/** 요청 쿼리의 리전(글자 · 64자 상한 · 공백 제거). */
export const regionQuery = (q) => (typeof q?.region === 'string' ? q.region.trim().slice(0, 64) : '');
/** 목록의 리전(빈 값 제외 · 한국어 정렬) — 화면 Select 의 선택지. */
export function regionsOf(vcs) {
  return [...new Set((Array.isArray(vcs) ? vcs : []).map(regionOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
}
/** 리전 안 vCenter — 리전이 비면 전부. */
export function inRegion(vcs, region) {
  const list = Array.isArray(vcs) ? vcs : [];
  const r = String(region || '').trim();
  return r ? list.filter((v) => regionOf(v) === r) : list;
}
