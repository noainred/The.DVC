/**
 * 성능점검 › 엣지 위임 카드의 판정·문구(v2.630 UI2630-03).
 *
 * 서버는 v2.630 부터 '배정만 있고 (중앙 기동 후) 한 번도 보고하지 않은 엣지' 를 edges 에 행으로 싣는다 —
 * 예전에는 edgeSummary 가 인메모리 보고만 돌아 중앙 재시작 뒤 죽어 있는 엣지가 카드 목록에서 **통째로 사라졌다**.
 * 그 행의 표지는 `noReport:true` 또는 `assignedOnly:true`(둘 중 무엇이 오든 받는다 — 서버 필드 이름에 묶이지 않게).
 * 그 행은 counts·rows 가 없을 수 있다 — 0 으로 지어내지 않는다('—').
 * 합계는 `edgeTotals.assignedNoReport` 가 오면 별도 축으로 말한다(정상·실패에 섞지 않는다).
 */

/** 카드 종류: 'no-report'(배정만 · 기동 후 보고 없음) | 'silent'(보고하다 끊김) | 'live'. */
export function edgeCardKind(e) {
  if (!e || typeof e !== 'object') return 'no-report';
  if (e.noReport === true || e.assignedOnly === true) return 'no-report';
  if (e.silent) return 'silent';
  return 'live';
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const secText = (ms) => { const n = num(ms); return n == null ? '—' : `${Math.round(n / 1000)}초`; };

/** 경고 줄. live 면 null. */
export function edgeCardWarn(e) {
  const k = edgeCardKind(e);
  if (k === 'no-report') {
    return '배정됨 · 중앙 기동 후 보고 없음 — 이 엣지 담당 점검의 현재 상태를 알 수 없습니다(정상도 장애도 아닙니다).';
  }
  if (k === 'silent') {
    const rows = num(e.rows);
    return `무보고 ${secText(e.ageMs)} — 담당 점검 ${rows == null ? '—' : rows}개의 현재 상태를 알 수 없습니다.`;
  }
  return null;
}

/** 카드 아래 메타 줄. */
export function edgeCardMeta(e) {
  const items = num(e?.items), rows = num(e?.rows);
  const age = e?.lastAt ? `${secText(e.ageMs)} 전` : '보고 기록 없음';
  return `항목 ${items == null ? '—' : items} · 보고 ${rows == null ? '—' : rows}행 · ${age}`;
}

/** 합계 줄 뒤에 붙일 '배정만 있고 보고 없음 N곳'. 없으면 ''. edges 로 세어 서버 필드가 없어도 동작한다. */
export function edgeNoReportTotal(totals, edges) {
  const t = num(totals?.assignedNoReport);
  const n = t != null ? t : (Array.isArray(edges) ? edges.filter((e) => edgeCardKind(e) === 'no-report').length : 0);
  return n > 0 ? ` · 배정만 있고 보고 없음 ${n}` : '';
}
