/**
 * VM 라이트사이징 표의 추천 칸 판정(v2.604 감사 RECENT2604-04 — 순수 모듈).
 *
 * 서버 `reports/rightsizing.js suggestSize` 는 피크를 **읽지 못한** 차원(cpu·mem)의 권고를 보류하고
 * 현재 사양을 그대로 둔 채 `held: ['cpu'|'mem']` 로 밝힌다(v2.603). 화면이 그 값을 초록 굵은 글자로
 * 그리면 '현재 사양 그대로가 추천' 이라는 **권고처럼** 보인다 — 실제로는 판단하지 않은 것이다.
 * 보류된 차원은 회색 '권고 보류(피크 미확인)' 로 말한다.
 */
export const HELD_LABEL = '권고 보류(피크 미확인)';
export const HELD_TITLE = '관측 피크를 읽지 못해 이 항목은 권고를 계산하지 않았습니다(현재 사양 유지). 0% 로 보고 줄이지 않습니다.';

/** dim: 'cpu' | 'mem'. → { held:true, label, title } 또는 { held:false, text } */
export function suggestCell(row, dim) {
  const held = Array.isArray(row?.held) && row.held.includes(dim);
  if (held) return { held: true, label: HELD_LABEL, title: HELD_TITLE };
  const v = dim === 'cpu' ? row?.suggestedVcpu : row?.suggestedRamGB;
  if (v == null || v === '') return { held: false, text: '—' };
  return { held: false, text: dim === 'cpu' ? String(v) : `${v}GB` };
}

/** 표 아래 각주 — 권고를 보류한 행이 있을 때만(없으면 ''). 개수를 밝힌다(조용히 두지 않는다). */
export function heldNote(rows) {
  const n = (Array.isArray(rows) ? rows : []).filter((r) => Array.isArray(r?.held) && r.held.length).length;
  return n ? `${n}대는 관측 피크를 읽지 못한 항목이 있어 그 항목의 권고를 보류했습니다(현재 사양을 추천으로 보지 마세요).` : '';
}
