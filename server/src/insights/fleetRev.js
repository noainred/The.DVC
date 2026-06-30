/**
 * 플릿 분류/귀속 변경 리비전 카운터.
 *
 * 태그(fleet-tags)·소속 법인(fleet-assign)·레지스트리 vcenterId가 바뀌면 GET /insights/fleet의
 * snapMemo 캐시가 즉시 무효화되어야 한다. 과거엔 변경마다 store.refresh()로 '전체 vCenter 재폴링'을
 * 요청 처리 안에서 await 했는데(고RTT·30개 환경에서 UI 블로킹·부하 증폭), 분류는 스냅샷 재폴링과
 * 무관하므로 가벼운 인메모리 리비전만 올려 캐시 키에 섞는다(파일 읽기 없이 즉시 반영).
 */

let rev = 0;

export function bumpFleetRev() { rev += 1; }
export function fleetRev() { return rev; }
