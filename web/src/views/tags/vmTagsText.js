// v2.703(A15) — 태그·사용자 지정 속성 점검 문구. 상태 판정은 서버 tags/analyze.js tagStateOf(키 1:1 — 테스트 대조).
// 문구에 백틱·별표 금지(BoldText 는 **강조** 만 해석).
export const TAG_STATE_TEXT = Object.freeze({
  ok: { label: '읽음', tone: 'green' },
  stale: { label: '직전 값(마지막 읽기 실패)', tone: 'amber' },
  error: { label: '읽기 실패', tone: 'red' },
  unsupported: { label: '태그 API 없음', tone: 'gray' },
  'not-collected': { label: '아직 안 읽음', tone: 'gray' },
});
export const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
export const pctText = (a, b) => { const p = pct(a, b); return p == null ? '—' : `${p}%`; };

/** 확인 범위 — 태그를 못 읽은 vCenter 의 VM 은 '누락' 이 아니라 '확인 안 됨'. */
export function coverageNote(cov, vcenters) {
  if (!cov) return null;
  const parts = [];
  if (cov.uncheckedVms > 0) {
    const bad = (vcenters || []).filter((v) => v.state !== 'ok' && v.state !== 'stale');
    parts.push(`태그를 읽지 못한 vCenter ${bad.length}곳의 VM ${cov.uncheckedVms.toLocaleString()}대는 점검하지 않았습니다 — '태그가 다 붙어 있다' 가 아닙니다`);
  }
  const absent = (vcenters || []).filter((v) => Array.isArray(v.requiredAbsent) && v.requiredAbsent.length);
  if (absent.length) parts.push(`${absent.length}곳은 필수 카테고리 일부가 그 vCenter 에 아예 없어서 모든 VM 이 누락으로 보입니다(${absent.slice(0, 3).map((v) => `${v.name}: ${v.requiredAbsent.join(', ')}`).join(' · ')}${absent.length > 3 ? ' 외' : ''})`);
  return parts.length ? `${parts.join(' · ')}.` : null;
}
export function policyNote(policy) {
  if (!policy || !policy.requiredCategories?.length) return '필수 카테고리를 정하지 않아 누락 점검을 하지 않습니다 — 아래 정책에서 정하세요(관리자).';
  return null;
}
/** VM 상세 한 줄 — 상태별로 '없음' 과 '모름' 을 나눠 말한다. */
export function vmTagLine(d) {
  if (!d) return '—';
  if (d.tags == null) return d.state === 'unsupported' ? '이 vCenter 에는 태그 API 가 없습니다' : d.state === 'error' ? '태그를 읽지 못했습니다' : '태그를 아직 읽지 않았습니다';
  if (!d.tags.length) return '붙은 태그 없음';
  return d.tags.map((t) => (t.category ? `${t.category}: ${t.tag}` : t.tag)).join(' · ');
}
