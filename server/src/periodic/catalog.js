/**
 * periodic/catalog.js — 정기 점검 보고의 **점검 항목 카탈로그**(순수 · 진실의 원천 — 화면 '점검 항목' 탭과 리더 표가 이 목록을 쓴다).
 * 설계 docs/design/periodic-report §4.3(54항목) + 구현 때 main 에 새로 생긴 분야별 정기 보고 3종을 항목으로 더했다(SAN 스토리지 성능 · PowerScale 점검 · 디스크 배드 섹터 —
 * 그 보고는 그대로 따로 나가고 여기에는 판정 요약만 싣는다 · §7). IP 관리 정기 보고는 기존 'IP 관리' 항목이 같은 원천을 읽는다.
 *
 * 항목 모양:
 *   key    — 영소문자 · 숫자 · 하이픈(설정 저장 키 · 리더 키). **바꾸지 않는다**(저장된 주기 재정의 · 보관된 회차가 이 키를 가리킨다).
 *   axis   — infra(인프라) | service(서비스) | facility(설비)
 *   kinds  — 기본으로 실리는 주기(일일 · 주간 · 월간 · 분기 — 관리자가 바꿀 수 있다)
 *   tool   — 바로가기 도구 키(`#/tools/<k>` — 화면 링크) · null 이면 링크 없음
 *   info   — true 면 판정 없이 수치만(종합 수에 넣지 않는다)
 *   fleet  — true 면 법인(vCenter) 행이 없는 항목(포탈 자체 · 전 법인 합계) — 범위 계정에는 싣지 않는다
 *   rule   — 판정 기준(그 기능의 판정 함수 · 임계 그대로 — 화면 '점검 항목' 표 · 보고서 부록)
 *   source — 원천(도구 · 모듈 · 저장소)
 */

export const AXES = Object.freeze([
  Object.freeze({ key: 'infra', label: '인프라', desc: 'vCenter · 스토리지 · 네트워크' }),
  Object.freeze({ key: 'service', label: '서비스', desc: '백업 · 엣지 · 포탈 · 운영 서비스' }),
  Object.freeze({ key: 'facility', label: '설비', desc: '물리 서버 · 전력 · 온도 · GPU · 파일' }),
]);
export const AXIS_LABEL = Object.freeze(Object.fromEntries(AXES.map((a) => [a.key, a.label])));

const D = 'daily'; const W = 'weekly'; const M = 'monthly'; const Q = 'quarterly';
const it = (o) => Object.freeze({ info: false, fleet: false, tool: null, fix: '', ...o, kinds: Object.freeze(o.kinds) });

export const ITEMS = Object.freeze([
  /* ── 인프라 ── */
  it({ key: 'vc-reach', axis: 'infra', label: 'vCenter 도달성', kinds: [D, W, M, Q], tool: 'daily-health',
    rule: '수집 실패(unreachable)는 이상 · 첫 수집 중 · 엣지 보고 낡음 · 점검중은 확인 불가(일일 헬스체크와 같은 판정)', source: '인벤토리 스냅샷(중앙 직접 + 엣지 push)' }),
  it({ key: 'host-state', axis: 'infra', label: '호스트 연결 · 상태', kinds: [D, W, M, Q], tool: 'daily-health',
    rule: '연결 끊김 · 응답 없음 호스트가 있으면 이상(일일 헬스체크 hosts 절 그대로)', source: '인벤토리 스냅샷' }),
  it({ key: 'ds-usage', axis: 'infra', label: '데이터스토어 사용률', kinds: [D, W, M, Q], tool: 'daily-health',
    rule: '일일 리포트 설정의 주의 · 이상 기준 그대로 · 용량을 못 읽은 데이터스토어는 따로 셈', source: '인벤토리 스냅샷' }),
  it({ key: 'snapshot-age', axis: 'infra', label: '오래된 스냅샷', kinds: [D, W, M], tool: 'snapshot-age',
    rule: '일일 리포트 설정의 스냅샷 나이 기준을 넘으면 주의', source: '인벤토리 스냅샷' }),
  it({ key: 'vc-alarms', axis: 'infra', label: 'vCenter 알람(트리거됨)', kinds: [D], tool: 'daily-health',
    rule: '위험(critical) 알람이 있으면 이상 · 경보를 조회하지 않은 vCenter 는 확인 불가', source: '인벤토리 스냅샷' }),
  it({ key: 'vm-tools', axis: 'infra', label: 'VMware Tools 상태', kinds: [W, M], tool: 'vmtools',
    rule: '전원 켜진 VM 의 Tools 미실행은 주의 · 상태를 못 읽은 VM 이 있으면 확인 불가(일일 헬스체크 tools 절)', source: '인벤토리 스냅샷' }),
  it({ key: 'zombies', axis: 'infra', label: '고아 VM · 좀비 리소스', kinds: [W, M], tool: 'zombie-vms',
    rule: '고아 · 접근 불가 VM 이 있으면 이상(일일 헬스체크 orphaned 절) · 근거에 전원 꺼진 VM · 회수 가능 용량', source: '인벤토리 스냅샷' }),
  it({ key: 'host-hygiene', axis: 'infra', label: 'ESXi 호스트 구성 점검', kinds: [W, M], tool: 'host-hygiene',
    rule: '호스트 구성 점검의 심각도 그대로(높음 이상 · 중간 주의) · 못 읽은 vCenter 는 확인 불가', source: '호스트 구성 캐시(중앙) · 엣지 push' }),
  it({ key: 'vm-hygiene', axis: 'infra', label: 'VM 구성 점검', kinds: [W, M], tool: 'vm-hygiene',
    rule: 'VM 구성 점검의 심각도 그대로', source: 'VM 구성 캐시 · 인벤토리 스냅샷' }),
  it({ key: 'cluster-check', axis: 'infra', label: '클러스터 HA · DRS · N+1', kinds: [W, M, Q], tool: 'cluster-check',
    rule: '클러스터 HA · DRS 점검의 심각도 그대로', source: '인벤토리 스냅샷' }),
  it({ key: 'storage-paths', axis: 'infra', label: '데이터스토어 경로 · vSAN', kinds: [W, M], tool: 'storage-paths',
    rule: '데이터스토어 · 경로 점검의 심각도 그대로', source: '인벤토리 스냅샷' }),
  it({ key: 'contention', axis: 'infra', label: 'CPU 경합 · 디스크 지연', kinds: [D, W], tool: 'contention',
    rule: 'CPU 경합 · 디스크 지연 점검의 심각도 그대로 · 오래된 표본은 확인 불가', source: '경합 표본(메모리)' }),
  it({ key: 'vm-count', axis: 'infra', label: 'VM 수량 추이', kinds: [W, M, Q], tool: 'vm-track', info: true,
    rule: '판정 없음 — 기간 시작 · 끝 VM 수와 증감', source: 'VM 수량 추이 DB(00 · 12시 슬롯)' }),
  it({ key: 'array-health', axis: 'infra', label: '스토리지 어레이 상태 · 사용률', kinds: [D, W, M], tool: 'storage-mon',
    rule: '비정상 노드는 이상 · 미해결 경보는 주의 · 용량 80% 주의 · 90% 이상(스토리지 사용량 보고 기준) · 수집 실패 · 6시간 넘은 값은 확인 불가', source: '스토리지 모니터링 스냅샷(중앙 직접 + 엣지 push)' }),
  it({ key: 'storage-growth', axis: 'infra', label: '스토리지 증가량 · 소진 예상', kinds: [W, M, Q], tool: 'storage-growth',
    rule: '8주 안 90% 도달 전망은 주의 · 이미 90% 이상은 이상(스토리지 사용량 보고 조치 규칙) · 7일 미수집은 확인 불가', source: '스토리지 용량 일 롤업(5년)' }),
  it({ key: 'san-ports', axis: 'infra', label: 'SAN 스위치 포트 오류 · 광량', kinds: [D, W, M], tool: 'san-switch',
    rule: 'SAN 월간 점검의 포트 판정(기준선 이후 신규 오류 · 광량 기준) 그대로 · 기준선 없음은 적음', source: 'SAN 스위치 스냅샷(엣지 push)' }),
  it({ key: 'san-monthly', axis: 'infra', label: 'SAN 스위치 월간 점검(4단계)', kinds: [M], tool: 'san-switch',
    rule: '하드웨어 · 환경 · 포트 · 에러 · 로그 — 장비 센서 상태 기준 · 확인 못 한 항목은 확인 불가(정상으로 흡수하지 않음)', source: 'SAN 스위치 스냅샷' }),
  it({ key: 'san-storage-perf', axis: 'infra', label: 'SAN 스토리지 성능(월간 보고 판정)', kinds: [M], tool: 'san-storage',
    rule: 'SAN 스토리지 성능 월간 보고서의 어레이 판정 그대로', source: 'SAN 스토리지 성능 DB' }),
  it({ key: 'ps-inspect', axis: 'infra', label: 'PowerScale 장비 점검', kinds: [W, M], tool: 'ps-inspect',
    rule: 'PowerScale 주간 점검 20항목의 장비 종합 판정 그대로(정상 · 주의 · 이상 · 확인 불가)', source: 'PowerScale 점검 이력' }),
  it({ key: 'cvp', axis: 'infra', label: '네트워크 스위치(CVP) 상태 · 장애', kinds: [D, W, M], tool: 'cvp',
    rule: 'CVP 장비 상태 판정(bad 이상 · warn 주의 · 스트리밍 끊김 · 오래됨은 확인 불가) · 열린 장애', source: 'CVP DB(엣지 push)' }),
  it({ key: 'ipam', axis: 'infra', label: 'IP 관리(중복 · 대역 사용률)', kinds: [W, M], tool: 'ipam',
    rule: '중복 IP · 가득 찬 대역(IP 관리 정기 보고의 기준)은 주의 · 스캔 공백만 있으면 확인 불가(IP 관리 정기 보고와 같은 모델)', source: 'IP 원장 · 스냅샷' }),
  it({ key: 'vm-dns', axis: 'infra', label: 'VM DNS 설정 확인', kinds: [W, M], tool: 'vm-dns',
    rule: '승인 안 된 DNS 서버를 쓰는 VM 이 있으면 주의 · 보고한 VM 이 없는 법인은 확인 불가(VM DNS 설정 확인과 같은 분석)', source: 'VM DNS DB' }),
  it({ key: 'capacity-eta', axis: 'infra', label: '용량 고갈 예측', kinds: [M, Q], tool: 'capacity-forecast',
    rule: '용량 고갈 예측의 남은 일수 구간 그대로(30일 안 이상 · 90일 안 주의)', source: '용량 표본 롤업' }),
  it({ key: 'compliance', axis: 'infra', label: '버전 · 패치 준수', kinds: [M, Q], tool: 'compliance-report',
    rule: '버전/패치 준수 리포트의 판정 그대로(지원 종료 ESXi 는 이상)', source: '인벤토리 스냅샷' }),
  it({ key: 'license-expiry', axis: 'infra', label: '라이선스 만료', kinds: [W, M, Q], tool: 'license-expiry',
    rule: '만료는 이상 · 30일 안 이상 · 90일 안 주의 · 라이선스를 못 읽은 vCenter 는 확인 불가', source: 'vCenter 라이선스(스냅샷)' }),
  it({ key: 'cert-expiry', axis: 'infra', label: '인증서 만료(vCenter · NSX)', kinds: [D, W, M, Q], tool: 'cert-expiry',
    rule: '만료 · 30일 안은 이상 · 90일 안은 주의 · 확인 못 한 인증서는 확인 불가', source: '인증서 감시 캐시' }),
  it({ key: 'core-license', axis: 'infra', label: '코어 라이선스 산정', kinds: [Q], tool: 'core-license', info: true,
    rule: '판정 없음 — 산정 코어 수 · 못 읽은 vCenter', source: '인벤토리 스냅샷' }),

  /* ── 서비스 ── */
  it({ key: 'svcmon', axis: 'service', label: '서비스 모니터 상태', kinds: [D, W, M], tool: 'svcmon-config',
    rule: '성능 점검 판정 그대로(bad 이상 · warn 주의) — 이 포탈 점검 + 엣지 보고 합계 · 회차 시점 상태(이력 표 없음)', source: '서비스 점검 결과(메모리 · 엣지 push)' , fleet: true}),
  it({ key: 'veeam', axis: 'service', label: 'Veeam 백업 판정', kinds: [D, W, M], tool: 'backup-summary',
    rule: '연속 2회 이상 실패한 VM · 마지막 백업이 7일 넘은 VM 은 이상 · 한 번 실패 · 3일 넘음은 주의 · 결과를 못 읽었거나 일부만 읽은 법인은 확인 불가(VM 마다 Backup 현황 Detail 과 같은 결과 · 연속 여부는 백업 적재로)', source: 'Veeam 결과(엣지 push) · 백업 적재' }),
  it({ key: 'bareos', axis: 'service', label: 'Bareos 백업 · 사전 점검', kinds: [D, W, M], tool: 'bareos-summary',
    rule: '사전 점검 판정(불가 이상 · 경고 주의)과 백업 결과(연속 2회 이상 실패 · 마지막 성공 7일 넘음은 이상 · 한 번 실패 · 3일 넘음은 주의) 중 나쁜 쪽 · 조회하지 못한 법인은 확인 불가 · Director 호출 없음', source: 'Bareos 상태 파일 · 백업 원장(엣지 대행)' }),
  it({ key: 'unprotected', axis: 'service', label: '미보호 VM(백업 공백)', kinds: [W, M], tool: 'unprotected-vms',
    rule: '미보호 VM 리포트 판정 그대로 — 이벤트를 모으지 않는 vCenter(엣지 법인)는 확인 불가', source: 'vCenter 이벤트 DB(직접 수집분만)', fix: '엣지 법인은 2단계(엣지 요약 push) 전까지 확인 불가입니다 — 특수 기능 › 미보호 VM 에서 연합 조회로 확인하세요' }),
  it({ key: 'vm-clone', axis: 'service', label: 'VM 복제(백업식) 실패 · RPO', kinds: [D, W], tool: 'vm-clone',
    rule: '연속 2회 이상 실패 · 마지막 성공 7일 넘음은 이상 · 한 번 실패 · 마지막 성공 3일 넘음은 주의(다른 백업과 같은 기준) · 위임 잡을 담당 엣지가 지금 보고하지 않으면 확인 불가', source: 'VM 복제 잡 기록(위임 잡은 지금 담당 엣지의 보고)' }),
  it({ key: 'link-check', axis: 'service', label: '중앙 ↔ 엣지 통신 점검', kinds: [D, W, M], tool: 'link-check',
    rule: '통신 점검 판정 그대로(실패 단계) · 기능이 꺼져 있으면 확인 불가', source: '통신 점검 DB', fix: '설정 › 통신 점검을 켜면 다음 회차부터 실립니다' }),
  it({ key: 'edge-fresh', axis: 'service', label: '엣지 보고 신선도', kinds: [D, W, M], tool: 'portal-check',
    rule: '엣지가 올리는 인벤토리가 기준보다 오래되면 주의(위임 vCenter)', source: '인벤토리 스냅샷(엣지 수신 시각)' }),
  it({ key: 'xfer-speed', axis: 'service', label: '법인 간 전송 속도', kinds: [W, M, Q], tool: 'xfer-speed', info: true,
    rule: '판정 없음 — 엣지마다 마지막 판정(정상 · 느림 · 실패 · 오래됨)', source: '전송 속도 일 요약(5년)' , fleet: true}),
  it({ key: 'relaycheck', axis: 'service', label: 'HAProxy 경로 점검', kinds: [D, W], tool: 'relaycheck', fleet: true,
    rule: '경로 점검 실패는 주의 — 회차 시점 상태(메모리)', source: '경로 점검 결과(메모리)' }),
  it({ key: 'portal-services', axis: 'service', label: '포탈 내부 서비스 · 폴러', kinds: [D, W], tool: null, fleet: true,
    rule: '포탈 서비스 점검 판정 그대로(down 이상 · warn 주의 · unknown 확인 불가)', source: '포탈 서비스 점검' }),
  it({ key: 'portal-db', axis: 'service', label: '포탈 DB 상태', kinds: [M, Q], tool: 'portaldb', fleet: true,
    rule: '디스크가 30일 안에 찰 전망이면 이상 · 90일 안이면 주의(크기 · 하루 증가)', source: '포탈 DB 점검' }),
  it({ key: 'login-fails', axis: 'service', label: 'vCenter 로그인 실패', kinds: [W, M], tool: 'login-fails',
    rule: '지금 진행 중인 반복 시도가 있으면 주의 · 이벤트를 모으지 않는 vCenter 는 확인 불가', source: 'vCenter 이벤트 DB(직접 수집분만)' }),
  it({ key: 'horizon', axis: 'service', label: 'Horizon 세션', kinds: [W, M], tool: 'curuser', info: true, fleet: true,
    rule: '판정 없음 — 기간 중 최대 동시 세션 · 사용 앱 수', source: 'Horizon 세션 DB' }),
  it({ key: 'capacity-advisor', axis: 'service', label: '포탈 서버 리소스 적정성', kinds: [M, Q], tool: 'capacity-advisor', fleet: true,
    rule: '늘려야 함(scale up) 판정이 있으면 주의 · 표본이 부족하면 확인 불가(리소스 적정성 진단 그대로)', source: '포탈 서버 실측' }),

  /* ── 설비 ── */
  it({ key: 'part-faults', axis: 'facility', label: '서버 파트 장애', kinds: [D, W, M], tool: 'part-faults',
    rule: '열린 장애 중 장애(fault)는 이상 · 경고는 주의 · 감시가 꺼져 있고 기록도 없으면 확인 불가', source: '파트 장애 DB' }),
  it({ key: 'disk-bad', axis: 'facility', label: '디스크 배드 섹터 새 기록', kinds: [D, W, M], tool: 'disk-bad',
    rule: '기간 중 새로 나온 배드 섹터 계열 기록이 있으면 주의', source: '디스크 배드 섹터 DB' }),
  it({ key: 'inlet-temp', axis: 'facility', label: '서버 흡기 온도', kinds: [D, W, M], tool: 'esxitemp',
    rule: 'ASHRAE 구간 — hot 이상 · warn · cold 주의 · 표본이 없으면 확인 불가', source: '서버 온도(iDRAC)' }),
  it({ key: 'pdu', axis: 'facility', label: 'PDU 상태', kinds: [D, W, M], tool: 'pdu',
    rule: 'PDU 임계 판정 그대로(critical 이상 · warning 주의) · 수집 실패 · 낡은 보고는 확인 불가', source: 'PDU 스냅샷(엣지 push)' }),
  it({ key: 'power', axis: 'facility', label: '소비 전력', kinds: [W, M, Q], tool: 'power-total', info: true,
    rule: '판정 없음 — 지금 측정 전력 합계 · 측정 서버 수', source: '전력 합계(iDRAC)' }),
  it({ key: 'bm-usage', axis: 'facility', label: '베어메탈 사용률', kinds: [W, M], tool: 'bm-usage',
    rule: '병목 · 포화는 이상 · 오류 · 주의는 주의 · 오래된 값은 확인 불가 · 이 포탈이 직접 수집한 서버만(엣지 법인 값은 엣지에)', source: '베어메탈 사용률(엣지)', fix: '특수 기능 › 베어메탈 사용률에서 법인 수집을 켜면 다음 회차부터 실립니다' }),
  it({ key: 'bm-storage', axis: 'facility', label: '베어메탈 스토리지', kinds: [M], tool: 'bm-storage', info: true,
    rule: '판정 없음 — 서버 수 · 사용량 합계', source: '베어메탈 스토리지 이력' }),
  it({ key: 'gpu', axis: 'facility', label: 'GPU 활동', kinds: [W, M, Q], tool: 'gpu', info: true,
    rule: '판정 없음 — GPU VM 의 활동(바쁨 · 붙들림 · 유휴)', source: 'GPU 인벤토리' }),
  it({ key: 'isilon-dirusage', axis: 'facility', label: '아이실론 디렉터리 사용량 조사', kinds: [W, M], tool: 'isilon-dirusage',
    rule: '조사 상태 그대로(실패 · 인증 정지는 주의 · 오래됨 · 기록 없음은 확인 불가 · 꺼둔 대상은 정상)', source: '아이실론 디렉터리 DB(엣지 push)' }),
  it({ key: 'guest-partition', axis: 'facility', label: '게스트 파티션 사용률', kinds: [W, M], tool: 'guest-partition',
    rule: '게스트 파티션 임계 초과는 주의 · 95% 이상은 이상 · 수집 실패는 따로 셈', source: '게스트 파티션(엣지 push)' }),
  it({ key: 'dir-usage', axis: 'facility', label: '폴더 사용량 Top-N', kinds: [M], tool: 'dir-usage', info: true, fleet: true,
    rule: '판정 없음 — 대상 수 · 마지막 리포트', source: '폴더 사용량 DB' }),
  it({ key: 'fleet-change', axis: 'facility', label: '서버 인벤토리', kinds: [M, Q], tool: 'fleet', info: true,
    rule: '판정 없음 — 등록 서버 수(가상화 · 베어메탈)', source: '통합 서버 인벤토리' }),
]);

export const ITEM_BY_KEY = Object.freeze(Object.fromEntries(ITEMS.map((x) => [x.key, x])));
export const ITEM_KEYS = Object.freeze(new Set(ITEMS.map((x) => x.key)));

/**
 * 그 주기에 실리는 항목(설정의 항목 재정의 반영) — 순서는 카탈로그 순서.
 * @param {string} kind
 * @param {Record<string,{enabled?:boolean,kinds?:string[]}>} overrides
 */
export function itemsForKind(kind, overrides = {}) {
  return ITEMS.filter((x) => {
    const o = overrides?.[x.key] || {};
    if (o.enabled === false) return false;
    return (Array.isArray(o.kinds) ? o.kinds : x.kinds).includes(kind);
  });
}

/** 화면 '점검 항목' 탭용 — 재정의를 반영한 주기 · 켜짐. */
export function catalogView(overrides = {}) {
  return ITEMS.map((x) => {
    const o = overrides?.[x.key] || {};
    return { ...x, kinds: Array.isArray(o.kinds) ? [...o.kinds] : [...x.kinds], defaultKinds: [...x.kinds], enabled: o.enabled !== false, overridden: !!(o.kinds || o.enabled === false) };
  });
}
