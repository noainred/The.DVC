/**
 * fleetCorpText.js — 통합 서버 인벤토리의 법인(DataCenter) 표시 · 필터(v2.969 · 사용자 요청 '통합 서버 인벤토리 화면도 법인(DataCenter) 기준으로').
 * 판정은 서버(/insights/fleet 의 corpId · corpName · corpSource — insights/hwExport/corp.js)가 한다. 여기서는 고르기 · 글자만.
 */
export const UNASSIGNED = '__none__';
/** 법인 판정 출처 → [짧은 표시, 설명]. 서버 makeCorpOf 의 src 값과 같은 이름. */
export const CORP_SRC = Object.freeze({
  manual: ['수동', '이 화면에서 법인(DataCenter)을 직접 지정했습니다'],
  scan: ['스캔', 'iDRAC 스캔 대역 · 등록의 법인(서버 분석과 같은 판정)'],
  vcenter: ['vCenter', '그 서버의 vCenter 에 할당된 법인'],
  agent: ['엣지', '보고한 엣지(수집 서버)의 법인'],
  vcgroup: ['vCenter 묶음', '법인이 할당되지 않은 vCenter — vCenter 이름으로 따로 묶었습니다'],
});
/** 행이 화면 필터(법인 id · '__none__' · '')에 드는가. */
export const inCorp = (row, f) => !f || (f === UNASSIGNED ? !row?.corpId : row?.corpId === f);
/** 필터 선택지 — 서버가 준 법인 목록(서버가 있는 법인만 · 설정의 법인 순서 · 미지정 맨 뒤) 그대로, 대수를 붙여서. */
export function corpOptions(corps) {
  return (Array.isArray(corps) ? corps : []).map((c) => ({ value: c.id, label: `${c.name} (물리 ${c.bm || 0} · 가상화 ${c.vh || 0})` }));
}
/** 일괄 지정 확인 문구. mode: 'dc' | 'vc'. */
export function bulkConfirmText(n, mode, targetName) {
  const what = mode === 'dc' ? '법인(DataCenter)' : 'vCenter';
  return targetName ? `선택한 ${n}대의 ${what}을(를) '${targetName}'(으)로 지정할까요?` : `선택한 ${n}대의 ${what} 지정을 해제할까요?${mode === 'dc' ? '(자동 판정으로 돌아갑니다)' : ''}`;
}
/** 법인 지정 응답 → 완료 문구. 실패 본문은 던진다(숫자를 지어내지 않는다). */
export function dcAssignDoneText(r) {
  if (!r || r.ok === false) throw new Error(r?.reason || '법인 지정에 실패했습니다.');
  const c = Number.isFinite(r.changed) ? r.changed : null; const t = Number.isFinite(r.total) ? r.total : null;
  if (c == null || t == null) return '법인 지정 요청을 서버가 받았습니다(처리 대수는 응답에 없습니다).';
  return `${t}대 중 ${c}대의 법인 지정을 바꿨습니다${c < t ? '(나머지는 이미 같은 값)' : ''}.`;
}
