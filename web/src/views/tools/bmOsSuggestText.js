/**
 * 물리서버 OS 주소 제안 화면 문구 · 거르기(순수 — v2.993 · 설계 bm-folders §13 ②). 판정은 서버(bmfolders/osSuggest.js) — 여기는 글자와 거르기만.
 */
export const STATE_TEXT = Object.freeze({
  suggest: ['제안', 'blue', '이름이 같은 IP 하나(SSH 열림)'],
  pick: ['고르기 필요', 'amber', '같은 이름의 IP 가 둘 이상'],
  closed: ['제안 안 함', 'gray', '이름은 같지만 SSH 포트가 닫혀 있음'],
  none: ['못 찾음', 'gray', '같은 이름의 IP 가 스캔 결과에 없음'],
  noname: ['못 찾음', 'gray', 'iDRAC 이 호스트 이름을 읽지 못했음'],
  differs: ['등록된 주소와 다름', 'amber', '자동으로 바꾸지 않음'],
  registered: ['등록됨', 'green', '등록된 주소와 같음'],
  ambiguous: ['확인 필요', 'amber', '같은 이름 · 주소의 OS 등록이 여럿'],
});
export const VIA_TEXT = Object.freeze({ dns: '역방향 DNS', mdns: 'mDNS', netbios: 'NetBIOS', fwd: '정방향 DNS' });

/** 거르기 — '못 찾음' 은 이름 없음 · SSH 닫힘을 함께 묶는다(제안이 나오지 않은 행). */
export function suggestRowsOf(rows, filter) {
  const list = Array.isArray(rows) ? rows : [];
  if (filter === 'all') return list;
  if (filter === 'none') return list.filter((r) => r.state === 'none' || r.state === 'noname' || r.state === 'closed');
  return list.filter((r) => r.state === filter);
}

/** 고를 수 있는 행 — 제안 · 고르기 필요만(서버 applyPlan 과 같은 조건). */
export const pickableOf = (r) => r?.state === 'suggest' || r?.state === 'pick';

export function applyResultText(r) {
  const added = Number(r?.added) || 0;
  const refused = Array.isArray(r?.refused) ? r.refused.length : 0;
  return `${added}대의 OS 주소를 등록했습니다(주소만 · 비활성)${refused ? ` · ${refused}건은 등록하지 않았습니다(그사이 상태가 바뀜)` : ''}.`;
}

/** 처음 고를 거르기 — 제안이 있으면 제안 · 없고 고르기 필요가 있으면 그것 · 둘 다 없으면 전체(빈 화면으로 시작하지 않게). */
export function initialFilter(c = {}) {
  if (Number(c?.suggest) > 0) return 'suggest';
  if (Number(c?.pick) > 0) return 'pick';
  return 'all';
}

