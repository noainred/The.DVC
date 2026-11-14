/**
 * ipam/scanSchedule.js — '주기 스캔 일정' 시간표(순수 · v3.7.0 IP 관리 재설계 묶음 라 — 설계 docs/design/ipam-redesign ⑭ ScanSchedule).
 *
 * 에이전트(이 포탈 · 엣지)마다 오늘(포탈 날짜 — util/dayKey DAY_OFFSET_MIN) 스캔 기록을 시간표 조각으로 바꾼다. 출처는 스캔 로그 하나다:
 *   이 포탈 — start · finish(걸린 시간) · fail · skip · busy, 엣지 — report(엣지가 보낸 걸린 시간 · 없으면 점) · reject · skip.
 * 다음 예정은 '마지막 완료 + 주기' 의 어림이다(엣지는 몇 분마다 배정을 다시 읽어 그 뒤 첫 틱에 돈다 · 쉬는 시간이면 그 회차를 건너뛴다).
 * 마지막 완료가 주기의 2배보다 오래됐으면 '늦음'(놓친 회차 — 몰아서 다시 돌지 않는다). 기록이 없으면 '기록 없음'(0회가 아니라 모름).
 * 걸린 시간이 주기보다 길면 다음 회차가 겹치지 않고 건너뛴다(재진입 가드 — 화면이 그 사실을 안내한다: overrun).
 */
import { DAY_OFFSET_MIN, DAY_MS, dayIndex, dayStartMs } from '../util/dayKey.js';
import { numOrNull } from '../util/numOrNull.js';
import { quietText, cleanQuiet, quietLongestMs } from './scanQuiet.js';

export const RUNS_PER_AGENT_MAX = 200;
const RUN_EVENTS = new Set(['start', 'finish', 'fail', 'skip', 'busy', 'report', 'reject', 'interrupted', 'resume']);

/**
 * @param {object} p
 * @param {Array<{name:string, enabled:boolean, intervalMs:number, quiet?:object[], ranges?:string[]}>} p.agents
 * @param {object[]} p.log  listScanLog 결과(최신 → 과거 어느 순서든)
 * @param {Record<string,{at?:number}>} [p.reports]  getAgentReports — 마지막 완료(대소문자 그대로의 키)
 * @param {number} [p.now]
 * @param {number} [p.offsetMin]
 */
export function buildScanSchedule({ agents = [], log = [], reports = {}, now = Date.now(), offsetMin = DAY_OFFSET_MIN } = {}) {
  const day = dayIndex(now, offsetMin);
  const t0 = dayStartMs(day, offsetMin);
  const t1 = t0 + DAY_MS;
  const minOf = (ms) => Math.max(0, Math.min(1440, Math.round((ms - t0) / 60_000)));
  const byAgent = new Map();
  const key = (a) => String(a || '__local__').toLowerCase();
  for (const e of Array.isArray(log) ? log : []) {
    if (!e || !RUN_EVENTS.has(e.event)) continue;
    const at = numOrNull(e.at); if (at == null) continue;
    const last = numOrNull(e.lastAt) ?? at;
    if (last < t0 - DAY_MS || at >= t1) continue;
    const l = byAgent.get(key(e.agent)) || []; l.push(e); byAgent.set(key(e.agent), l);
  }
  const rows = [];
  for (const a of agents) {
    const evs = (byAgent.get(key(a.name)) || []).sort((x, y) => x.at - y.at);
    const runs = [];
    let open = null;
    for (const e of evs) {
      const dur = numOrNull(e.durationMs);
      if (e.event === 'start' || e.event === 'resume') { open = e; continue; }
      if (e.event === 'finish' || e.event === 'report') {
        const end = e.at; const start = dur != null && dur >= 0 ? end - dur : (open ? open.at : end);
        open = null;
        if (end < t0) continue;
        runs.push({ kind: 'done', fromMin: minOf(start), toMin: Math.max(minOf(start) + 1, minOf(end)), at: end, durationMs: dur, scanned: numOrNull(e.scanned), alive: numOrNull(e.alive) });
      } else if (e.event === 'fail' || e.event === 'interrupted' || e.event === 'reject') {
        const start = open ? open.at : e.at; open = null;
        if (e.at < t0) continue;
        runs.push({ kind: 'fail', fromMin: minOf(start), toMin: Math.max(minOf(start) + 1, minOf(e.at)), at: e.at, message: String(e.message || '').slice(0, 160) });
      } else if (e.event === 'skip' || e.event === 'busy') {
        const last = numOrNull(e.lastAt) ?? e.at;
        if (last < t0) continue;
        runs.push({ kind: 'skip', fromMin: minOf(Math.max(e.at, t0)), toMin: minOf(Math.max(e.at, t0)) + 1, at: last, count: numOrNull(e.count) ?? 1, message: String(e.message || '').slice(0, 160) });
      }
    }
    if (open && open.at >= t0 - DAY_MS) runs.push({ kind: 'running', fromMin: minOf(open.at), toMin: minOf(now), at: open.at });
    const iv = numOrNull(a.intervalMs);
    const rep = Object.entries(reports || {}).find(([k]) => k.toLowerCase() === key(a.name))?.[1];
    const lastDoneAt = numOrNull(rep?.at);
    const lastDone = [...runs].reverse().find((r) => r.kind === 'done');
    const lastDur = lastDone?.durationMs ?? null;
    // v3.8.1: '늦음' = 주기의 2배 + 가장 긴 쉬는 시간(쉬는 동안은 주기 회차를 건너뛴다 — 밤마다 '늦음' 이 뜨지 않게). 알림(instantAlerts)과 같은 여유.
    const quietMs = quietLongestMs(a.quiet);
    const state = !a.enabled ? 'off' : lastDoneAt == null ? 'none' : iv && now - lastDoneAt > 2 * iv + quietMs ? 'late' : 'ok';
    rows.push({
      agent: a.name, enabled: !!a.enabled, intervalMs: iv, ranges: Array.isArray(a.ranges) ? a.ranges.length : null,
      quiet: cleanQuiet(a.quiet).map(quietText),
      lastDoneAt, nextAt: a.enabled && lastDoneAt != null && iv ? Math.max(now, lastDoneAt + iv) : null,
      lastDurationMs: lastDur, overrun: !!(iv && lastDur != null && lastDur > iv),
      state, runs: runs.slice(-RUNS_PER_AGENT_MAX), runsOmitted: Math.max(0, runs.length - RUNS_PER_AGENT_MAX),
      counts: { done: runs.filter((r) => r.kind === 'done').length, fail: runs.filter((r) => r.kind === 'fail').length, skip: runs.filter((r) => r.kind === 'skip').reduce((n, r) => n + (r.count || 1), 0) },
    });
  }
  return { dayStart: t0, nowMin: minOf(now), offsetMin, rows };
}
