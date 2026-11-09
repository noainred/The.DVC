/**
 * 포탈 점검 › 법인별 실환경 확인 문구(v2.938) — 순수 모듈. 판정은 서버 `server/src/fieldcheck/judge.js` 가 코드로 하고 여기서는 문장만 만든다.
 * 코드 표(STATE_TEXT · CHECK_TEXT)는 서버 FIELD_STATES · FIELD_CHECKS 와 1:1(테스트가 서버 소스와 대조한다). 문구에 백틱 금지(BoldText).
 */
export const STATE_TEXT = Object.freeze({
  confirmed: { label: '확인됨', tone: 'green' },
  failed: { label: '실패', tone: 'red' },
  pending: { label: '근거 없음', tone: 'amber' },
  na: { label: '해당 없음', tone: 'gray' },
  unknown: { label: '판정 불가', tone: 'gray' },
});
export const CHECK_TEXT = Object.freeze({
  'upgrade-push': { label: '엣지 업그레이드 push', what: '중앙이 그 법인 엣지에 업그레이드 번들을 실제로 보냈고 엣지가 받았는가(수집 서버의 마지막 업그레이드 기록)' },
  'vapi-tags': { label: 'vSphere 태그(vAPI)', what: '그 법인 vCenter 의 태그 응답을 실제로 읽었는가(인벤토리 태그 수집)' },
  'lacp-path': { label: 'vDS LACP 경로', what: 'vDS 의 LACP(LAG) 구성 경로를 실제로 읽었는가(vCenter 정보 · 포트그룹)' },
  'bareos-dir': { label: 'Bareos Director 콘솔', what: '그 법인 Bareos Director 콘솔에 실제로 접속했는가(Bareos 사전 점검)' },
  'onefs-detach': { label: '아이실론 분리 실행', what: '그 법인 엣지가 아이실론 du 를 장비에서 분리 실행(nohup)했는가(엣지 디렉터리 사용량 상태 — v2.954 이상 엣지)' },
});
export const stateOf = (c) => STATE_TEXT[c?.state] || STATE_TEXT.unknown;

/** 배너 한 줄 — 무엇을 보는지와 '근거 없음 ≠ 실패' 를 한 번만 말한다. */
export function bannerText(data) {
  const n = Number(data?.corps) || 0;
  if (!data) return '법인별 실환경 확인을 불러오는 중입니다.';
  if (!n) return '등록된 vCenter(법인)가 없습니다.';
  return `법인 **${n}곳** — 규칙 문서에 '실장비로 확인하지 못했다' 고 남은 항목을, 각 법인 엣지가 실제 장비에서 읽어 보낸 결과로 판정합니다. 엣지·장비에 새로 접속하지 않습니다(왕복 0). **근거 없음은 실패가 아닙니다** — 그 법인에서 아직 그 경로가 돈 기록이 없다는 뜻입니다.`;
}

/** KPI — 합계 = 확인됨 + 실패 + 근거 없음 + 해당 없음 + 판정 불가(겹치지 않는다). */
export function kpiOf(data) {
  const c = data?.counts || {};
  const n = (k) => Number(c[k]) || 0;
  return { total: Number(data?.total) || 0, confirmed: n('confirmed'), failed: n('failed'), pending: n('pending'), na: n('na'), unknown: n('unknown') };
}

/** 항목별 요약 — '확인됨 3 / 대상 5(해당 없음 제외)'. */
export function checkSummary(data, key) {
  const b = data?.byCheck?.[key] || {};
  const n = (k) => Number(b[k]) || 0;
  const applicable = n('confirmed') + n('failed') + n('pending') + n('unknown');
  return `확인됨 ${n('confirmed')} / 대상 ${applicable}${n('failed') ? ` · 실패 ${n('failed')}` : ''}${n('na') ? ` · 해당 없음 ${n('na')}` : ''}`;
}

/** 칸 정렬 키 — 실패가 먼저, 그다음 근거 없음 · 판정 불가 · 확인됨 · 해당 없음. */
export const SORT_RANK = Object.freeze({ failed: 0, pending: 1, unknown: 2, confirmed: 3, na: 4 });
export const rowRank = (row, checks) => Math.min(...(checks || []).map((k) => SORT_RANK[row?.cells?.[k]?.state] ?? 2));
