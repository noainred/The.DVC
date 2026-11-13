// ipamFilterText.js — IP 주소 탭의 필터 한 줄(v3.4.0 재설계 묶음 가). 예전 '출처 대조' 버튼(최대 13개)과 KPI 카드 클릭 필터를 고르기 두 개로 바꾼다.
// 키는 예전과 같다(IpamCore 의 reconFilter · rowFilter 판정을 바꾸지 않는다) — '현황' 탭의 숫자도 같은 키로 이 화면을 연다.
// count = IpamCore recon 집계(또는 /tools/ipam 응답)의 키. conditional = 0 이면 목록에서 뺀다(고른 상태면 남긴다 — 예전 버튼과 같다).

export const RECON_OPTIONS = Object.freeze([
  { k: '', label: '전체' },
  { k: 'vcenter', label: 'vCenter 만', count: 'vcenter' },
  { k: 'both', label: 'vCenter + 스캔', count: 'both' },
  { k: 'scan', label: '스캔만(수동 확인)', count: 'scan' },
  { k: 'manual', label: '수동 등록', count: 'manual' },
  { k: 'conflict', label: '충돌', count: 'conflict' },
  { k: 'macalert', label: '충돌 의심 · MAC 변경', count: 'macAlert', conditional: true },
  { k: 'dnsbad', label: 'DNS 불일치', count: 'dnsBad', conditional: true },
  { k: 'reserved', label: '예약 만료 · 임박', count: 'reserved' },
  { k: 'managed', label: '관리상태 지정됨', count: 'managed' },
  { k: 'unmanaged', label: '관리상태 미지정', count: 'unmanaged' },
  { k: 'noname', label: '호스트명 없음(스캔 IP)', count: 'noname' },
  { k: 'vnic', label: '미등록 가상 NIC', count: 'vnic', conditional: true },
]);

/** 분류 — count 는 /tools/ipam 응답의 키(멀티홈 → 2026-11-13 사용자 결정으로 '복수IP'). */
export const ROW_OPTIONS = Object.freeze([
  { k: '', label: '분류 전체' },
  { k: 'duplicate', label: '중복', count: 'duplicateIps' },
  { k: 'multihomed', label: '복수IP', count: 'multiHomed' },
  { k: 'public', label: '공인', count: 'publicIps' },
  { k: 'private', label: '사설', count: 'privateIps' },
]);

/** 고르기 항목 글자 — '이름 (n)'. 수를 못 읽으면 이름만(0 으로 적지 않는다). */
export function reconLabel(opt, n) {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : null;
  return v == null ? opt.label : `${opt.label} (${v.toLocaleString()})`;
}
