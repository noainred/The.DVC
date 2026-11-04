/**
 * issues/exportCsv.js — 이슈 목록 CSV(v2.885 · C-2). 순수 — 라우트가 범위 · 필터 · 검색식을 건 행(summary)만 넘긴다.
 *
 *  · 칸마다 util/csv.js csvCell(수식 주입 가드 — '=' '+' '-' '@' 로 시작하는 글은 작은따옴표를 붙인다 · 따옴표 · 줄바꿈).
 *  · 시각은 포탈 시각(localStamp — 화면과 같은 기준), 값이 없으면 빈 칸(0 이나 '—' 로 채우지 않는다 — 엑셀 합계가 틀리지 않게).
 *  · 분 값(예상 · 기록)은 숫자 그대로(엑셀에서 더할 수 있게) — 머리글에 단위를 적는다.
 *  · 엑셀이 한글을 깨뜨리지 않게 BOM 을 앞에 붙인다.
 */
import { csvLine, CSV_BOM } from '../util/csv.js';
import { localStamp } from '../util/dayKey.js';

export const STATUS_TEXT = Object.freeze({ backlog: '백로그', todo: '할 일', progress: '진행 중', review: '검토', done: '완료' });
export const TYPE_TEXT = Object.freeze({ incident: '장애', task: '작업', request: '요청', improve: '개선', epic: '에픽' });
export const PRIORITY_TEXT = Object.freeze({ p0: '긴급', p1: '높음', p2: '보통', p3: '낮음' });
export const SLA_STATE_TEXT = Object.freeze({ breached: '초과', late: '늦게 지킴', warning: '임박', paused: '멈춤(보류)', running: '진행', met: '지킴', off: '' });

export const CSV_HEADER = Object.freeze([
  '키', '유형', '제목', '상태', '우선순위', '법인', '담당자', '보고자', '라벨', '컴포넌트', '에픽', '상위', '스프린트', '진행률(%)',
  '보류 사유', '기한', '만든 시각', '갱신 시각', '완료 시각', '예상(분)', '기록(분)', '수정 버전', '영향 버전', 'SLA',
]);

const ts = (v) => (Number.isFinite(v) && v > 0 ? localStamp(v) || '' : '');
/**
 * @param {object[]} rows  store.summary 행
 * @param {{ vcName?: (id:string)=>string, sprintName?: (id:string)=>string }} [o]
 * @returns {string} BOM + CRLF 줄
 */
export function issuesCsv(rows, { vcName = (id) => id, sprintName = (id) => id } = {}) {
  const lines = [csvLine(CSV_HEADER)];
  for (const r of Array.isArray(rows) ? rows : []) {
    lines.push(csvLine([
      r.key, TYPE_TEXT[r.type] || r.type, r.title, STATUS_TEXT[r.status] || r.status, PRIORITY_TEXT[r.priority] || r.priority,
      r.vcenterId ? (vcName(r.vcenterId) || r.vcenterId) : '공용', r.assignee || '', r.reporter || '', (r.labels || []).join(' '), r.component || '',
      r.epicKey || '', r.parentKey || '', r.sprintId ? (sprintName(r.sprintId) || r.sprintId) : '', Number.isInteger(r.progress) ? r.progress : '',
      r.blocked?.reason || '', ts(r.dueAt), ts(r.createdAt), ts(r.updatedAt), ts(r.closedAt),
      Number.isInteger(r.estimateMin) ? r.estimateMin : '', Number.isInteger(r.spentMin) && r.worklogCount ? r.spentMin : '',
      r.fixVersion || '', r.affectsVersion || '', r.sla ? (SLA_STATE_TEXT[r.sla.state] ?? r.sla.state) : '',
    ]));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}
