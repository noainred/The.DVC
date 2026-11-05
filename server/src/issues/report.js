/**
 * issues/report.js — 이슈 리포트(v2.908 · 기능 추천 7 · 시안 docs/design/wiki-issues ⑪ '리포트'). 순수 — 라우트가 범위를 건 재료(store.reportSource)를 넘긴다.
 *
 *  · 주(포탈 날짜 기준 월요일 0시 ~)마다 생성 · 완료 수 — 최근 weeks 주(기본 12 · 1~52). 이번 주는 진행 중인 주다(화면이 그렇게 적는다).
 *  · 기간 요약: 생성 · 완료 · 평균 해결 시간(완료만 · 보류 시간 제외 · 달력 시간 — 에픽 제외) · 중앙값 · 자동 등록 비율(파트 장애 · 다른 알람).
 *  · SLA 준수율 — 기간 안에 완료된 SLA 대상 이슈의 해결 단계 met / (met + late). 응답 단계도 같이. SLA 가 꺼져 있으면 null(0% 로 적지 않는다).
 *  · 법인별: 지금 열린 수 · 기간 생성 · 완료. 담당자별: 지금 열린 수 · 기간 완료(담당자 기준) · 기간 작업 기록 분(기록한 사람 기준).
 *  · 유형별 기간 생성 수. 값이 없으면 null — 화면 · CSV 는 '—' · 빈 칸으로(0 과 섞지 않는다).
 */
import { dayIndex, dayStartMs, dayLabel, localStamp } from '../util/dayKey.js';
import { csvLine, CSV_BOM } from '../util/csv.js';
import { TYPE_TEXT } from './exportCsv.js';

export const REPORT_WEEKS = Object.freeze({ min: 1, max: 52, def: 12 });
const WEEK_DAYS = 7;
/** 그 시각이 든 주의 월요일(포탈 날짜 번호). 1970-01-01 은 목요일. */
export function weekStartDay(ms) { const d = dayIndex(ms); return d - (((d + 3) % 7) + 7) % 7; }

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const hours = (min) => (min == null ? null : Math.round((min / 60) * 10) / 10);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

/**
 * @param {object[]} rows  store.reportSource
 * @param {{ weeks?: number, now?: number, vcName?: (id:string)=>string }} [o]
 */
export function buildIssueReport(rows, { weeks = REPORT_WEEKS.def, now = Date.now(), vcName = (id) => id } = {}) {
  const w = Math.max(REPORT_WEEKS.min, Math.min(REPORT_WEEKS.max, Math.trunc(Number(weeks)) || REPORT_WEEKS.def));
  const lastWeek = weekStartDay(now);
  const firstWeek = lastWeek - (w - 1) * WEEK_DAYS;
  const from = dayStartMs(firstWeek);
  const list = Array.isArray(rows) ? rows : [];
  const trend = [];
  const idxOf = (ms) => { const k = (weekStartDay(ms) - firstWeek) / WEEK_DAYS; return Number.isInteger(k) && k >= 0 && k < w ? k : -1; };
  for (let k = 0; k < w; k += 1) trend.push({ week: dayLabel(firstWeek + k * WEEK_DAYS), created: 0, closed: 0, current: k === w - 1 });

  const inRange = (ms) => Number.isFinite(ms) && ms >= from && ms <= now;
  let created = 0; let closed = 0; let auto = 0;
  const resolve = [];
  const sla = { respond: { met: 0, late: 0 }, resolve: { met: 0, late: 0 }, breachedOpen: 0, any: false, business: false };
  const corp = new Map(); const people = new Map(); const types = {};
  const corpOf = (id) => { let c = corp.get(id); if (!c) { c = { vcenterId: id, name: id ? (vcName(id) || id) : '공용', open: 0, created: 0, closed: 0 }; corp.set(id, c); } return c; };
  const personOf = (u) => { let p = people.get(u); if (!p) { p = { user: u, open: 0, closed: 0, loggedMin: 0 }; people.set(u, p); } return p; };

  for (const r of list) {
    const c = corpOf(r.vcenterId || '');
    if (r.status !== 'done') { c.open += 1; if (r.assignee) personOf(r.assignee).open += 1; }
    if (r.sla) { sla.any = true; if (r.sla.calendar) sla.business = true; if (r.status !== 'done' && r.sla.state === 'breached') sla.breachedOpen += 1; }
    if (inRange(r.createdAt)) {
      created += 1; c.created += 1;
      if (r.auto) auto += 1;
      types[r.type] = (types[r.type] || 0) + 1;
      const k = idxOf(r.createdAt); if (k >= 0) trend[k].created += 1;
    }
    if (r.closedAt != null && inRange(r.closedAt)) {
      closed += 1; c.closed += 1;
      if (r.assignee) personOf(r.assignee).closed += 1;
      const k = idxOf(r.closedAt); if (k >= 0) trend[k].closed += 1;
      if (r.resolveMin != null) resolve.push(r.resolveMin);
      for (const st of ['respond', 'resolve']) { const s0 = r.sla?.[st]?.state; if (s0 === 'met' || s0 === 'late') sla[st][s0] += 1; }
    }
    for (const wl of r.worklog || []) if (wl.by && inRange(wl.at)) personOf(wl.by).loggedMin += wl.minutes;
  }
  const avg = resolve.length ? resolve.reduce((a, b) => a + b, 0) / resolve.length : null;
  const slaOut = sla.any || sla.respond.met + sla.respond.late + sla.resolve.met + sla.resolve.late
    ? {
      respondPct: pct(sla.respond.met, sla.respond.met + sla.respond.late), resolvePct: pct(sla.resolve.met, sla.resolve.met + sla.resolve.late),
      respond: sla.respond, resolve: sla.resolve, breachedOpen: sla.breachedOpen, business: sla.business,
    }
    : null;
  return {
    weeks: w, from, to: now, fromText: dayLabel(firstWeek), toText: localStamp(now) || '',
    summary: { created, closed, avgResolveHours: hours(avg), medianResolveHours: hours(median(resolve)), resolvedCount: resolve.length, autoPct: pct(auto, created), auto },
    trend, sla: slaOut,
    byCorp: [...corp.values()].filter((c) => c.open || c.created || c.closed).sort((a, b) => b.open - a.open || b.created - a.created || a.name.localeCompare(b.name)),
    byAssignee: [...people.values()].filter((p) => p.open || p.closed || p.loggedMin).sort((a, b) => b.open - a.open || b.closed - a.closed || a.user.localeCompare(b.user)),
    byType: Object.entries(types).map(([type, n]) => ({ type, label: TYPE_TEXT[type] || type, created: n })).sort((a, b) => b.created - a.created),
  };
}

/** 리포트 CSV — 표마다 머리글 한 줄 · 표 사이 빈 줄(엑셀에서 표별로 보인다). 값이 없으면 빈 칸. */
export function issueReportCsv(r) {
  const v = (x) => (x == null ? '' : x);
  const lines = [csvLine([`이슈 리포트 — ${r.fromText} ~ ${r.toText} (${r.weeks}주)`])];
  lines.push('', csvLine(['요약', '생성', '완료', '평균 해결(시간 · 보류 제외)', '중앙값 해결(시간)', '자동 등록 비율(%)', 'SLA 응답 준수(%)', 'SLA 해결 준수(%)', 'SLA 초과 중(열린)']));
  lines.push(csvLine(['기간', r.summary.created, r.summary.closed, v(r.summary.avgResolveHours), v(r.summary.medianResolveHours), v(r.summary.autoPct), v(r.sla?.respondPct), v(r.sla?.resolvePct), v(r.sla?.breachedOpen)]));
  lines.push('', csvLine(['주(월요일)', '생성', '완료', '비고']));
  for (const t of r.trend) lines.push(csvLine([t.week, t.created, t.closed, t.current ? '진행 중인 주' : '']));
  lines.push('', csvLine(['법인', '열림(지금)', '생성', '완료']));
  for (const c of r.byCorp) lines.push(csvLine([c.name, c.open, c.created, c.closed]));
  lines.push('', csvLine(['담당자', '열림(지금)', '완료', '작업 기록(분)']));
  for (const p of r.byAssignee) lines.push(csvLine([p.user, p.open, p.closed, p.loggedMin]));
  lines.push('', csvLine(['유형', '생성']));
  for (const t of r.byType) lines.push(csvLine([t.label, t.created]));
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}
