/**
 * Insights 화면 판정 표기(순수 — audit2783d.test.js 가 고정).
 *
 * v2.783(점검 Q4 P-B2): 보안 자세 badge 는 critical/warning 이 아니면 전부 녹색 '정상' 이었다 — 서버가 'unknown'(버전·빌드·수명 데이터 미상)을
 *   보내도 화면은 정상으로 그렸다. 'ok' 일 때만 정상이고, 그 밖(unknown·없음·모르는 값)은 회색 '미확인'.
 * v2.783(점검 Q4 P-I1): 이상 탐지 계열이 조회에 실패했거나 평가한 엔티티가 0 이면 '0건(초록)' 이 아니라 회색 '평가 못 함'.
 * v2.783(점검 Q4 P-B1): 인시던트 타임라인의 'notify' 는 같은 장애 안의 재발송·재시도다(발생으로 세지 않는다).
 */

const GREEN = '#34d399';
const RED = '#f87171';
const GRAY = '#94a3b8';

export function securityBadge(worst, reason) {
  if (worst === 'critical') return { cls: 'red', text: '위험', title: reason || undefined };
  if (worst === 'warning') return { cls: 'amber', text: '주의', title: reason || undefined };
  if (worst === 'ok') return { cls: 'green', text: '정상', title: undefined };
  return { cls: 'gray', text: '미확인', title: reason || '버전·빌드를 읽지 못했거나 내장 데이터셋에 없는 버전입니다' };
}

/** evaluated 필드가 있는 응답에서 '평가 못 함' 인 계열인가(구버전 응답은 판정하지 않는다). */
const unevaluated = (fam) => !!fam && (!!fam.error || (typeof fam.evaluated === 'number' && fam.evaluated === 0 && !(fam.count > 0)));

export function anomalyFamilyBadge(fam) {
  const count = Number(fam?.count) || 0;
  if (fam?.error) return { cls: 'gray', text: '평가 못 함', title: `조회 오류: ${fam.error}` };
  if (count > 0) return { cls: 'red', text: `${count}건`, title: undefined };
  if (unevaluated(fam)) {
    const n = Number(fam.insufficient) || 0;
    return { cls: 'gray', text: '평가 못 함', title: n ? `표본 부족 ${n}개(평가에 필요한 시계열이 아직 쌓이지 않았습니다)` : '평가할 시계열이 없습니다' };
  }
  return { cls: 'green', text: '0건', title: typeof fam?.evaluated === 'number' ? `평가 ${fam.evaluated}개` : undefined };
}

export function anomalyKpi(d) {
  const fams = Array.isArray(d?.families) ? d.families : [];
  const total = Number(d?.total) || 0;
  const bad = fams.filter(unevaluated).length;
  if (total > 0) return { value: total, color: RED, sub: bad ? `평가 못 함 ${bad}계열` : undefined };
  if (fams.length && bad === fams.length) return { value: `평가 못 함 ${bad}`, color: GRAY, sub: '표본 부족·조회 오류로 평가한 계열이 없습니다' };
  if (bad) return { value: 0, color: GRAY, sub: `평가 못 함 ${bad}계열` };
  return { value: total, color: GREEN, sub: undefined };
}

export function incidentKindText(kind) {
  if (kind === 'resolved') return '해소';
  if (kind === 'notify') return '재발송';
  return '발생';
}
