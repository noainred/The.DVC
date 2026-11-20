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

/**
 * 점검 반복 1회차 — 원격 수집 서버(엣지)가 맡은 서버인데 그 수집 서버를 등록부에서 확인하지 못했다(서버 suggestAgentOf agentUnknown).
 *   등록하면 엣지 칸이 비어 ‘중앙 직접’ 등록이 된다 — 사람이 켜기 전에 알 수 있게 상태 칸에 **짧은 한 줄**(긴 조치는 마우스를 올리면 — 표 폭을 넓히지 않게). 그 밖은 ''.
 */
export const AGENT_UNKNOWN_TEXT = Object.freeze({
  unread: '어느 엣지인지 모름(수집 서버 등록부 못 읽음)',
  'not-found': '어느 엣지인지 모름(등록부에 그 수집 서버 없음)',
});
export const AGENT_UNKNOWN_HINT = '등록하면 엣지 칸이 비어 중앙 직접으로 들어갑니다 — 켜기 전에 베어메탈 스토리지에서 엣지를 지정하세요.';
export const agentNoteOf = (r) => (r && Object.hasOwn(AGENT_UNKNOWN_TEXT, r.agentUnknown) ? AGENT_UNKNOWN_TEXT[r.agentUnknown] : '');

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

