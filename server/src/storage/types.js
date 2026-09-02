/**
 * storage/types.js — 스토리지 모니터링 타입 카탈로그 + 정규화 스키마(v2.302).
 *
 * ── 확장 아키텍처(사용자 요구: Isilon 먼저, 이후 XtremIO·PowerStore·VMAX/PowerMax·VPLEX·
 *    Unity·Metro Node 추가) ─────────────────────────────────────────────────
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
 *   media: { hdd:{totalBytes,usedBytes,pct}, ssd:{totalBytes,usedBytes,pct} } | null,
 *                                    // 미디어(디스크 풀)별 분리 — isi status 의 HDD/SSD 컬럼과
 *                                    // 동일 의미(2026-08-15 사용자 요구). 타입이 미디어 구분이
 *                                    // 없으면 null(뷰가 컬럼을 '—' 처리).
 *   nodes: { count, unhealthy,       // 노드형이 아니면 count=컨트롤러 수 등 타입 재량(0 허용)
 *     list: [{ id, ip, health,       // 노드별 상세(≤64 — isi status 노드 표와 동일 의미,
 *       inBps, outBps,               //   2026-08-15 사용자 요구): 외부망 처리량(bps)
 *       hdd:{usedBytes,totalBytes,pct}|null,   // 노드별 HDD 풀(무디스크 노드는 null — 'No Storage HDDs')
 *       ssd:{usedBytes,totalBytes,pct}|null,
 *       name?,                       // 노드/컨트롤러 이름(v2.310 — XtremIO SC·Unity SP·PowerStore
 *                                    //   slot 처럼 id 가 합성 순번인 타입의 유일 식별자. 있으면 뷰가
 *                                    //   '이름' 열을 추가한다. isilon 은 LNN=id 라 없음)
 *       ext?, l3Bytes? }] },         // isilon SSH 전용(v2.304~307): Ext 연결상태('C'/'N'),
 *                                    //   L3 캐시 바이트(SSD 풀 없는 노드의 SSD 셀 표기)
 *   pools: [{ name, totalBytes, usedBytes, pct }],   // ≤32(뷰 상한 — 초과분은 절단 표기)
 *   accounts: [{ name, enabled, role? }],            // ≤200(관리 계정 감사용)
 *   alerts: { unresolved },          // 미해결 경보 수(없으면 0)
 *   sections: { config, capacity, nodes, accounts, alerts },  // 섹션별 'ok'|'skip'|오류문자열
 *                                    // — 부분 실패를 숨기지 않는다(정직 표기: 일부만 수집돼도
 *                                    //   어떤 섹션이 왜 비었는지 UI 가 그대로 보여줌)
 *   extra: {}                        // 타입 고유 필드(작게 — push 대역폭·중앙 저장 고려)
 * }
 */

/**
 * 타입별 수집 방식(v2.405, 사용자 요구 — '장비별로 특화된 수집 방법을 메뉴에 표시').
 *
 * 왜 카탈로그에 두나: 예전에는 등록 폼이 isilon 일 때만 선택 메뉴를 띄우고 나머지는 서버가
 * 조용히 'api' 로 고정했다. 그래서 사용자는 **PowerStore/Unity 가 무엇으로 수집되는지 화면에서
 * 알 수 없었다**. 이제 모든 타입이 자기 방식 목록을 갖고, 폼은 그 목록을 그대로 보여준다
 * (선택지가 하나뿐이어도 무엇으로 수집되는지 보이게 — '숨김'이 아니라 '고정'으로 표시).
 *
 * value 는 저장되는 collectMethod 값이다. **첫 항목이 그 타입의 기본값**이며, 기존 데이터와
 * 어긋나지 않게 isilon 은 'ssh' 가 첫 항목이어야 한다(과거 저장분이 전부 ssh 기본).
 * ⚠ 여기에 방식을 추가하려면 반드시 그 방식의 수집기가 실제로 있어야 한다 — 목록에만 올리면
 *   사용자가 고를 수 있는데 수집은 안 되는 유령 선택지가 된다(poller.js COLLECTORS 와 짝).
 */
export const COLLECT_METHODS = {
  isilon: [
    { value: 'ssh', label: 'SSH (isi status 파싱 — 권장)', hint: '장비에 SSH 로 접속해 isi status 출력을 파싱합니다(운영자 화면과 같은 소스).' },
    { value: 'api', label: 'REST API (OneFS Platform)', hint: 'OneFS Platform API(/platform/*)를 호출합니다.' },
  ],
  powerstore: [
    { value: 'api', label: 'REST API (PowerStore REST)', hint: '/api/rest/* + metrics/generate 로 용량·인벤토리·성능을 수집합니다.' },
    { value: 'ssh', label: 'SSH (pstcli)', hint: '클러스터 관리 IP 에 SSH 로 접속해 pstcli 를 실행합니다(-output json 우선).' },
  ],
  unity480: [
    { value: 'api', label: 'REST API (Unisphere REST)', hint: 'Unisphere REST(/api/*, X-EMC-REST-CLIENT 헤더)로 수집합니다.' },
    { value: 'ssh', label: 'SSH (uemcli)', hint: 'SP 에 SSH 로 접속해 uemcli 를 실행합니다(-output csv 우선).' },
  ],
  xtremio: [
    { value: 'api', label: 'REST API (XMS REST)', hint: 'XMS(XtremIO Management Server) REST 로 수집합니다.' },
    { value: 'ssh', label: 'SSH (xmcli)', hint: 'XMS 에 SSH 로 접속해 xmcli(show-clusters 등)를 실행합니다.' },
  ],
  vmax: [{ value: 'api', label: 'REST API (Unisphere for PowerMax)', hint: 'Unisphere for PowerMax REST 로 수집합니다. (symcli 는 별도 SYMAPI 호스트가 필요해 장비 SSH 로는 불가)' }],
  powermax: [{ value: 'api', label: 'REST API (Unisphere for PowerMax)', hint: 'Unisphere for PowerMax REST 로 수집합니다. (symcli 는 별도 SYMAPI 호스트가 필요해 장비 SSH 로는 불가)' }],
  vplex: [
    { value: 'api', label: 'REST API (VPLEX Element Manager)', hint: 'VPLEX Element Manager REST 로 수집합니다.' },
    { value: 'ssh', label: 'SSH (vplexcli)', hint: '관리 서버에 SSH 로 접속해 vplexcli(health-check·ll /clusters 등)를 실행합니다.' },
  ],
  metronode: [
    { value: 'api', label: 'REST API (Metro Node, VPLEX v2 계열)', hint: 'Metro Node REST(VPLEX v2 계열)로 수집합니다.' },
    { value: 'ssh', label: 'SSH (vplexcli)', hint: '관리 서버에 SSH 로 접속해 vplexcli 를 실행합니다(VPLEX 와 동일 수집기).' },
  ],
};

/** 타입이 지원하는 수집 방식 목록(미등록 타입은 API 단일로 간주 — 수집기 계약이 그렇다). */
export function collectMethodsFor(type) {
  return COLLECT_METHODS[String(type || '')] || [{ value: 'api', label: 'REST API', hint: '' }];
}
/** 그 타입의 기본 수집 방식(목록 첫 항목). */
export const defaultCollectMethod = (type) => collectMethodsFor(type)[0].value;
/** 입력값이 그 타입에서 허용되는 방식인지 — 아니면 기본값으로 보정한다(유령 값 저장 방지). */
export function normalizeCollectMethod(type, value) {
  const list = collectMethodsFor(type);
  return list.some((m) => m.value === value) ? value : list[0].value;
}

export const STORAGE_TYPES = [
  { type: 'isilon', label: 'Isilon / PowerScale', vendor: 'Dell EMC', api: 'OneFS Platform API(REST)', implemented: true },
  // 아래는 사용자 로드맵(2026-08-15 요구) — 카탈로그에 먼저 올려 등록 UI 가 '예정'으로 보여주고,
  // 수집기가 생기면 implemented 만 뒤집는다(아키텍처가 이미 수용).
  { type: 'xtremio', label: 'XtremIO', vendor: 'Dell EMC', api: 'XMS REST', implemented: true }, // v2.310
  { type: 'powerstore', label: 'PowerStore', vendor: 'Dell EMC', api: 'PowerStore REST', implemented: true }, // v2.309
  { type: 'vmax', label: 'VMAX', vendor: 'Dell EMC', api: 'Unisphere REST', implemented: true }, // v2.310(powermax.js 공용)
  { type: 'powermax', label: 'PowerMax', vendor: 'Dell EMC', api: 'Unisphere REST', implemented: true }, // v2.310
  { type: 'vplex', label: 'VPLEX', vendor: 'Dell EMC', api: 'VPLEX REST', implemented: true }, // v2.311(vplex.js — metronode 공용)
  // 라벨은 'Unity'(모델 번호 제거 — 사용자 요구 2026-09-02). ⚠ type 키 'unity480' 은 바꾸지 말 것:
  // 이미 등록된 장비의 storage-devices.json 에 그 값이 들어 있어, 키를 바꾸면 기존 장비가
  // '알 수 없는 타입'이 되어 수집이 멈춘다(라벨만 표시용).
  { type: 'unity480', label: 'Unity', vendor: 'Dell EMC', api: 'Unisphere REST', implemented: true }, // v2.309
  { type: 'metronode', label: 'Metro Node', vendor: 'Dell EMC', api: 'REST(VPLEX v2 계열)', implemented: true }, // v2.311
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
    media: null,
    nodes: { count: 0, unhealthy: 0, list: [] },
    pools: [], accounts: [], alerts: { unresolved: 0 },
    sections: { config: 'skip', capacity: 'skip', nodes: 'skip', accounts: 'skip', alerts: 'skip' },
    extra: {},
  };
}
