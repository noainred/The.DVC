// ui.jsx — 공용 UI 재수출 셸(v2.295 대형 파일 분할 · 모듈화 감사 2차 확정 #2·#7).
// 구 633줄 구현은 3개 파일로 이동했고 이 파일은 **순수 재수출만** 한다 — views/ 의 86개 소비자
// import 경로가 바뀌지 않도록(SpecialTools v2.282·routes/api v2.283·svcmon v2.291·IdracAdmin
// v2.292 와 같은 '원 경로=셸 유지' 규약).
//
//  · primitives.jsx  : 표시 프리미티브(배지·KPI·DataTable·SearchBox·Loading/ErrorBox)
//  · Modal.jsx       : 모달 셸(단독 — VmRemote/VmReconfig 의 ui.jsx 역참조 순환 절단)
//  · EntityDetail.jsx: 엔티티 상세 클러스터(VmIpPing·HostVmsModal·DsBrowseSection·EntityDetail·
//                      VmLink — 상호 재귀라 반드시 한 파일. 헤더 주석 참조)
//
// ⚠ 규칙(컴팩트 후 이어받기 메모):
//  1) 여기에 새 구현을 추가하지 말 것 — 성격에 맞는 위 파일(또는 새 파일)에 만들고 여기서 재수출.
//  2) components/ 아래 파일은 이 셸이 아니라 primitives.jsx/Modal.jsx 를 직접 import 할 것 —
//     셸 역참조는 EntityDetail.jsx 경유 순환을 만든다(views/ 는 셸 사용이 정상).
//  3) 재수출 누락은 vite build 가 소비자 import 오류로 즉시 잡는다(npm run verify).
export { GpuBadge, usageColor, Kpi, UsageCell, StateBadge, SeverityBadge, DataTable, ResultCount, SearchBox, Loading, ErrorBox } from './primitives.jsx';
export { Modal } from './Modal.jsx';
export { VmIpPing, HostVmsModal, EntityDetail, VmLink } from './EntityDetail.jsx';
