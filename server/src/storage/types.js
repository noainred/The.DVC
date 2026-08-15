/**
 * storage/types.js — 스토리지 모니터링 타입 카탈로그 + 정규화 스키마(v2.302).
 *
 * ── 확장 아키텍처(사용자 요구: Isilon 먼저, 이후 XtremIO·PowerStore·VMAX/PowerMax·VPLEX·
 *    Unity 480·Metro Node 추가) ─────────────────────────────────────────────────
 * 새 스토리지 타입 추가 절차(이 3곳이 전부 — 다른 파일은 몰라도 됨):
 *   1) collectors/<type>.js 를 만들고 공통 계약을 구현한다:
 *        export async function collect(device) → NormalizedSnapshot (아래 스키마)
 *      장비 API 가 무엇이든(REST/Unisphere/XMS…) 반환은 반드시 이 스키마로 정규화한다 —
 *      중앙 뷰(법인별/타입별/장비별)가 타입을 몰라도 그리게 하는 것이 이 설계의 핵심.
 *   2) 아래 STORAGE_TYPES 의 해당 항목을 implemented:true 로 바꾸고 collector 를 연결한다
 *      (poller.js 의 COLLECTORS 맵 — types.js 는 순수 카탈로그라 collector 를 직접 import 하지
 *      않는다: UI/테스트가 카탈로그만 가볍게 쓰기 위함).
 *   3) 수집 필드가 타입 고유면 extra{} 에 넣는다(스키마 확장 금지 — 공통 뷰가 깨진다).
 *
 * ── NormalizedSnapshot 스키마(전 타입 공통 — 변경 시 중앙 뷰·push·edge 전부 영향) ──
 * {
 *   deviceId, type, name,            // name = 장비가 보고한 클러스터/어레이 이름(등록명 폴백)
 *   collectedAt, ok, error,          // ok=false 면 error 에 사유(연결/인증 실패 등)
 *   version,                         // 펌웨어/OS 버전 문자열(OneFS 9.4.0 등)
 *   serial,                          // GUID/시리얼(자산 대조)
 *   capacity: { totalBytes, usedBytes, pct },
 *   nodes: { count, unhealthy },     // 노드형이 아니면 count=컨트롤러 수 등 타입 재량(0 허용)
 *   pools: [{ name, totalBytes, usedBytes, pct }],   // ≤32(뷰 상한 — 초과분은 절단 표기)
 *   accounts: [{ name, enabled, role? }],            // ≤200(관리 계정 감사용)
 *   alerts: { unresolved },          // 미해결 경보 수(없으면 0)
 *   sections: { config, capacity, nodes, accounts, alerts },  // 섹션별 'ok'|'skip'|오류문자열
 *                                    // — 부분 실패를 숨기지 않는다(정직 표기: 일부만 수집돼도
 *                                    //   어떤 섹션이 왜 비었는지 UI 가 그대로 보여줌)
 *   extra: {}                        // 타입 고유 필드(작게 — push 대역폭·중앙 저장 고려)
 * }
 */

export const STORAGE_TYPES = [
  { type: 'isilon', label: 'Isilon / PowerScale', vendor: 'Dell EMC', api: 'OneFS Platform API(REST)', implemented: true },
  // 아래는 사용자 로드맵(2026-08-15 요구) — 카탈로그에 먼저 올려 등록 UI 가 '예정'으로 보여주고,
  // 수집기가 생기면 implemented 만 뒤집는다(아키텍처가 이미 수용).
  { type: 'xtremio', label: 'XtremIO', vendor: 'Dell EMC', api: 'XMS REST', implemented: false },
  { type: 'powerstore', label: 'PowerStore', vendor: 'Dell EMC', api: 'PowerStore REST', implemented: false },
  { type: 'vmax', label: 'VMAX', vendor: 'Dell EMC', api: 'Unisphere REST', implemented: false },
  { type: 'powermax', label: 'PowerMax', vendor: 'Dell EMC', api: 'Unisphere REST', implemented: false },
  { type: 'vplex', label: 'VPLEX', vendor: 'Dell EMC', api: 'VPLEX REST', implemented: false },
  { type: 'unity480', label: 'Unity 480', vendor: 'Dell EMC', api: 'Unisphere REST', implemented: false },
  { type: 'metronode', label: 'Metro Node', vendor: 'Dell EMC', api: 'REST', implemented: false },
];

export const TYPE_LABEL = Object.fromEntries(STORAGE_TYPES.map((t) => [t.type, t.label]));
export const isImplementedType = (t) => STORAGE_TYPES.some((x) => x.type === t && x.implemented);
export const isKnownType = (t) => STORAGE_TYPES.some((x) => x.type === t);

/** 빈 스냅샷 골격 — 수집기가 여기에 채워 넣는다(스키마 이탈 방지·부분 실패 기본값). */
export function emptySnapshot(device) {
  return {
    deviceId: device.id, type: device.type, name: device.name, collectedAt: Date.now(),
    ok: false, error: '', version: '', serial: '',
    capacity: { totalBytes: 0, usedBytes: 0, pct: null },
    nodes: { count: 0, unhealthy: 0 },
    pools: [], accounts: [], alerts: { unresolved: 0 },
    sections: { config: 'skip', capacity: 'skip', nodes: 'skip', accounts: 'skip', alerts: 'skip' },
    extra: {},
  };
}
