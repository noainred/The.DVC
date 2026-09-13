/**
 * 보안 자가진단 표시 판정·문구(v2.500) — 순수 함수. 웹 테스트는 node 환경(DOM 없음)이라
 * 컴포넌트 렌더 테스트가 불가하므로 판정·문구를 여기서 회귀로 고정한다(루트 CLAUDE.md 규약).
 *
 * 문구 원칙(정직):
 *  · `risk` 를 '위험' 이라고 부르지 않는다 — **'보호 꺼짐'** 이다. 운영상 필요해서 켠 스위치일 수
 *    있고, 단정하면 사용자가 장애로 오해한다.
 *  · `unknown` 은 '문제 없음' 도 '문제' 도 아니다 — **'확인 못 함'** 으로 쓰고 이유를 함께 보인다.
 *  · 점수·등급을 만들지 않는다. 개수와 항목만 보인다.
 */

/** 상태 → 배지 색(공용 badge 클래스). unknown 은 회색(경고색을 쓰면 경고로 읽힌다). */
export function statusColor(status) {
  if (status === 'risk') return 'red';
  if (status === 'warn') return 'amber';
  if (status === 'ok') return 'green';
  return 'gray';
}

/** 상태 → 한글 라벨. */
export function statusLabel(status) {
  if (status === 'risk') return '보호 꺼짐';
  if (status === 'warn') return '점검 권장';
  if (status === 'ok') return '정상';
  return '확인 못 함';
}

/** 표·목록 정렬 순서 — 조치가 필요한 것부터. unknown 은 warn 뒤(모르는 것을 앞세우지 않는다). */
export const STATUS_ORDER = { risk: 0, warn: 1, unknown: 2, ok: 3 };
export function sortChecks(checks = []) {
  return [...checks].sort((a, b) => {
    const d = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (d) return d;
    return String(a.group || '').localeCompare(String(b.group || ''), 'ko')
      || String(a.title || '').localeCompare(String(b.title || ''), 'ko');
  });
}

/**
 * 요약 한 줄. 점수 대신 '무엇이 몇 개'만 말한다.
 * 조치 대상이 없을 때도 "안전합니다" 라고 단정하지 않는다 — 이 화면이 보는 범위가 설정뿐이므로.
 */
export function summaryText(summary) {
  if (!summary || !summary.total) return '점검 항목이 없습니다.';
  const { risk = 0, warn = 0, unknown = 0, ok = 0, total } = summary;
  const parts = [];
  if (risk) parts.push(`보호 꺼짐 ${risk}건`);
  if (warn) parts.push(`점검 권장 ${warn}건`);
  if (unknown) parts.push(`확인 못 함 ${unknown}건`);
  if (!parts.length) return `점검한 ${total}개 항목이 모두 기본 보호 상태입니다(이 화면은 설정·파일 권한·환경변수만 봅니다).`;
  return `${parts.join(' · ')} — 나머지 ${ok}건은 기본 보호 상태입니다(점검 ${total}건).`;
}

/** 그룹별로 묶는다(표시 순서는 checks 등장 순서를 따른다 — 서버가 의미 순으로 넣는다). */
export function groupChecks(checks = []) {
  const out = [];
  const idx = new Map();
  for (const c of checks) {
    const g = c.group || '기타';
    if (!idx.has(g)) { idx.set(g, out.length); out.push({ group: g, items: [] }); }
    out[idx.get(g)].items.push(c);
  }
  return out;
}

/**
 * 과거 스냅샷 보고서에 붙일 안내. 2026-08-08 점검 결과를 현재 상태로 오해하지 않게 한다.
 * auditDate 는 'YYYYMMDD' 또는 'YYYY-MM-DD'.
 */
export function snapshotNotice(auditDate, todayIso = '') {
  const d = String(auditDate || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  if (!d) return '이 보고서는 과거 점검 시점의 기록입니다 — 현재 상태가 아닙니다.';
  const today = String(todayIso || '').slice(0, 10);
  const tail = today && today !== d ? ` 오늘(${today})의 상태는 '보안 자가진단' 에서 확인하세요.` : '';
  return `이 보고서는 ${d} 점검 시점의 기록입니다 — 그 뒤 수정된 항목이 있어 현재 상태가 아닙니다.${tail}`;
}

/** 과거 지적의 현재 처리 상태 라벨(상수 보고서에 `resolved` 를 붙여 표시할 때). */
export function resolutionLabel(resolved) {
  if (resolved === true || resolved === 'fixed') return { label: '해결됨', color: 'green' };
  if (resolved === 'partial') return { label: '부분 해결', color: 'amber' };
  if (resolved === false || resolved === 'open') return { label: '유효', color: 'red' };
  return { label: '미확인', color: 'gray' };
}
