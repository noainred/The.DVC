/**
 * bmusage/logs/view.js — 7a단계 로그 분석 **조회 조립**(서버 1대 상세 · 이 노드 함대 요약). 라우트(routes/api/bmLogs.js)와 엣지 대행(collector /bm-usage/logs)이 같은 함수를 쓴다.
 *
 * ⚠⚠ 결측을 0 으로 채우지 않는다: 시간 칸은 그 시간에 **읽은 기록**(#read 행)이 있을 때만 0 이고, 읽은 기록이 없으면 null(‘못 읽음’ — 막대 없음 · 점선).
 *   KPI 는 기간 안 읽은 줄 기준(분류 · 패턴 수 · 줄 수) — 읽지 못한 출처는 sources 의 status 가 말한다.
 * ⚠ 연계(설계 §17 ‘±5분 시각 매칭 · 인과 아님’): 같은 노드 DB 의 변경 이벤트 · 집중 세션만 시각으로 맞춘다(읽기만). 플레이북 · 점검 소모품 · 교차 판정 · 장애 기록은
 *   규칙이 가리키는 **표지**(rules.js corr — 시각 매칭 아님)다. 부품 장애(장애 기록 탭)는 중앙 DB 에 있어 이 노드가 시각으로 맞추지 못한다 — 탭 링크만(정직 기록).
 * ⚠ 보안 상위(IP · 계정)는 여기서 가리지 않는다 — 가림은 응답을 사람에게 내주는 라우트가 관리자 판본 판정(isAdminDetailUser)으로 한다(엣지 → 중앙은 토큰 경로).
 */
import { config } from '../../config.js';
import { SEVERITY_RANK } from '../../loganalysis/rules.js';
import { LOG_CLASSES, CLASS_LABEL, logRuleById, logRuleCatalog, LOG_EVIDENCE, LOG_SOURCES } from './rules.js';
import { LOG_SECTIONS, FIRST_SINCE_MIN, FIRST_FILE_LINES, LINE_WIDTH, APP_LOGS } from './command.js';
import { logServerQuery, logFleetQuery } from './store.js';
import { HOUR } from './classify.js';

export const RANGES = Object.freeze({ '1h': 1, '24h': 24, '7d': 168 });
export const CORR_MS = 5 * 60_000;
export const TOP_MAX = 8;
const rangeOf = (v) => (Object.hasOwn(RANGES, String(v)) ? String(v) : '24h');
const sevRank = (s) => SEVERITY_RANK[s] || 0;
const emptyCls = () => Object.fromEntries(LOG_CLASSES.map((c) => [c, { patterns: 0, lines: 0 }]));
const lastSample = (j) => { try { const a = JSON.parse(j || '[]'); return Array.isArray(a) && a.length ? a[a.length - 1] : null; } catch { return null; } };
const samplesOf = (j) => { try { const a = JSON.parse(j || '[]'); return Array.isArray(a) ? a.slice(-5) : []; } catch { return []; } };

/** 수집 방식 설명(화면 ‘수집 방식’ 카드 — 숫자는 이 값에서만). */
export function logMethod(cfg = {}) {
  return {
    sections: LOG_SECTIONS.filter((x) => x !== 'END'), lineCap: cfg.lineCap ?? null, keepDays: cfg.keepDays ?? null, burst: { count: cfg.burstCount ?? null, windowMin: cfg.burstWindowMin ?? null },
    firstSinceMin: FIRST_SINCE_MIN, firstFileLines: FIRST_FILE_LINES, lineWidth: LINE_WIDTH, sources: LOG_SOURCES,
    apps: APP_LOGS.map((a) => ({ id: a.id, dirs: a.dirs, glob: a.glob })),
  };
}

/**
 * 서버 1대 상세(이 노드 DB). range = 1h · 24h · 7d(정시 경계).
 * @returns {Promise<object>} { ok, … } — DB 없음이면 { ok:false, reason }
 */
export async function localLogView({ key, range = '24h', agent = config.agent?.name || '', now = Date.now(), cfg = {}, ops = null } = {}) {
  const rg = rangeOf(range);
  const to = Math.floor(now / HOUR) * HOUR;
  const from = to - (RANGES[rg] - 1) * HOUR;
  const q = await logServerQuery({ agent, key, from, to });
  if (!q) return { ok: false, code: 'store-unavailable', reason: '이 노드의 베어메탈 DB 를 열지 못했습니다.' };
  // 시간 칸 · 읽은 양 · 패턴 기간 횟수
  const slots = new Map();
  for (let h = from; h <= to; h += HOUR) slots.set(h, { t: h, read: false, fault: 0, perf: 0, sec: 0, issue: 0 });
  const winCount = new Map(); const winFirst = new Map(); const winLast = new Map();
  let lines = 0; let truncated = 0; let none = 0;
  const bySrc = {};
  for (const r of q.hourRows) {
    const s = slots.get(Number(r.hour)); const c = Number(r.count) || 0;
    if (r.cls === 'read') { if (s) s.read = true; lines += c; const src = String(r.sig).slice(6); (bySrc[src] ||= { read: 0, truncated: 0, none: 0 }).read += c; continue; }
    if (r.cls === 'trunc') { truncated += c; const src = String(r.sig).slice(7); (bySrc[src] ||= { read: 0, truncated: 0, none: 0 }).truncated += c; continue; }
    if (r.cls === 'none') { none += c; const src = String(r.sig).slice(6); (bySrc[src] ||= { read: 0, truncated: 0, none: 0 }).none += c; continue; }
    if (s && LOG_CLASSES.includes(r.cls)) s[r.cls] += c;
    winCount.set(r.sig, (winCount.get(r.sig) || 0) + c);
    if (!winFirst.has(r.sig)) winFirst.set(r.sig, Number(r.hour));
    winLast.set(r.sig, Number(r.hour));
  }
  const hourly = [...slots.values()].map((s) => (s.read || s.fault || s.perf || s.sec || s.issue ? { t: s.t, fault: s.fault, perf: s.perf, sec: s.sec, issue: s.issue } : { t: s.t, fault: null, perf: null, sec: null, issue: null }));
  const kpi = emptyCls();
  const changes = ops?.changes || []; const focus = ops?.focus || [];
  const patterns = [];
  for (const [sig, n] of winCount) {
    const m = q.metas.get(sig);
    const rule = logRuleById(m?.rule_id);
    const cls = m?.cls || rule?.cls || 'issue';
    if (kpi[cls]) { kpi[cls].patterns += 1; kpi[cls].lines += n; }
    const first = Math.max(Number(m?.first) || winFirst.get(sig) || from, from); const last = Math.min(Number(m?.last) || winLast.get(sig) || to, now);
    const near = (ts) => Math.abs(ts - first) <= CORR_MS || Math.abs(ts - last) <= CORR_MS;
    patterns.push({
      sig, cls, severity: m?.severity || rule?.severity || 'info', ruleId: m?.rule_id || '', title: rule?.title || (String(sig).startsWith('#over:') ? '서명 수 상한 초과(묶음)' : ''),
      grade: rule?.grade || null, evidence: rule?.evidence || [], src: m?.src || '', unit: m?.unit || '', tmpl: m?.tmpl || '', count: n, total: Number(m?.count) || null,
      first: Number(m?.first) || null, last: Number(m?.last) || null, samples: samplesOf(m?.samples_json),
      corr: {
        changes: changes.filter((e) => Number.isFinite(e.ts) && near(e.ts)).slice(0, 3).map((e) => ({ ts: e.ts, kind: e.kind, item: e.item })),
        focus: focus.filter((s) => Number.isFinite(s.start) && s.start <= last + CORR_MS && (s.end ?? s.start) >= first - CORR_MS).slice(0, 3).map((s) => ({ id: s.id, start: s.start, end: s.end, status: s.status })),
        ...(rule?.corr || {}),
      },
    });
  }
  patterns.sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || b.count - a.count || (b.last || 0) - (a.last || 0));
  const st = q.cursor?.status || null;
  // 보안 합계 — 보안 줄이 오는 출처(secure · audit · journald) 중 하나라도 이 기간에 읽었으면 없는 종류는 0(읽었고 없음), 하나도 못 읽었으면 null(모름 — 0 아님).
  const secRead = ['secure', 'audit', 'journal'].some((s0) => bySrc[s0]?.read != null);
  const secTotals = Object.fromEntries(['fail_ip', 'fail_user', 'ok', 'root', 'sudo', 'sudofail', 'acct', 'avc'].map((k) => [k, q.secTotals?.[k] ?? (secRead ? 0 : null)]));
  return {
    ok: true, key, range: rg, from, to: to + HOUR - 1, agent,
    kpi, classLabel: CLASS_LABEL,
    read: { lines, truncated, none, bySrc, at: q.cursor?.at ?? null, lineCap: st?.lineCap ?? cfg.lineCap ?? null, sources: st?.sources || null, ended: st ? st.ended !== false : null, cut: st?.cut || null,
      ...(st?.cursorReset ? { cursorReset: st.cursorReset } : {}), ...(q.cursor?.corruptKept ? { corruptKept: true } : {}), ...(q.cursor ? {} : { never: true }) },
    hourly,
    security: { ...q.sec, totals: secTotals, bursts: Array.isArray(st?.bursts) ? st.bursts : [], auditd: st?.sources?.audit?.svc ?? null, auditStatus: st?.sources?.audit?.status ?? null, secureStatus: st?.sources?.secure?.status ?? null },
    patterns: patterns.slice(0, 300), patternsOmitted: Math.max(0, patterns.length - 300),
    rules: logRuleCatalog(), evidence: LOG_EVIDENCE, method: logMethod(cfg),
    corrWindowMs: CORR_MS, corrSource: { changes: changes.length, focus: focus.length },
  };
}

/**
 * 서버 1대 상세 + 연계 원천(같은 노드 DB 의 변경 이벤트 · 집중 세션 — 읽기만) + 설정. 라우트(이 노드 대상) · 엣지 대행이 같은 함수.
 */
export async function logViewFor({ key, range = '24h', agent = config.agent?.name || '', now = Date.now() } = {}) {
  let cfg = {};
  try { cfg = (await import('../perfRules.js')).loadPerfRules().logs || {}; } catch { cfg = {}; }
  const rg = rangeOf(range);
  const to = Math.floor(now / HOUR) * HOUR + HOUR;
  const from = to - RANGES[rg] * HOUR;
  let ops = { changes: [], focus: [] };
  try {
    const O = await import('../opsDb.js');
    const ch = await O.changeEventsRange({ key, agent, from: from - CORR_MS, to: to + CORR_MS, limit: 2_000 });
    const fs = await O.focusList({ key, agent, since: from - HOUR, limit: 200 });
    ops = { changes: ch?.rows || [], focus: fs || [] };
  } catch { /* 연계 원천을 못 읽으면 연계만 빈다(corrSource 0) */ }
  return localLogView({ key, range: rg, agent, now, cfg, ops });
}

/* ── 함대 요약(주기마다 한 번 — 메모리) ──────────────────────────────────────── */
let _sum = null; let _computing = null;
export function _resetLogViewForTest() { _sum = null; _computing = null; }
/** 이 노드의 서버별 24시간 요약을 다시 만든다(주기 끝 · 정리 뒤). */
export async function refreshLogSummary({ agent = config.agent?.name || '', now = Date.now() } = {}) {
  const since = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
  const q = await logFleetQuery({ agent, since });
  if (!q) { _sum = { at: now, since, list: null, error: 'db-unavailable' }; return _sum; }
  const byKey = new Map();
  const get = (k) => { if (!byKey.has(k)) byKey.set(k, { key: k, cls: emptyCls(), none: 0, read: 0, trunc: 0, secHigh: 0, top: [], at: null, status: null }); return byKey.get(k); };
  const meta = new Map(q.metas.map((m) => [`${m.key}|${m.sig}`, m]));
  const sigN = new Map();
  for (const r of q.rows) {
    const e = get(r.key); const c = Number(r.c) || 0;
    if (r.cls === 'read') { e.read += c; continue; }
    if (r.cls === 'trunc') { e.trunc += c; continue; }
    if (r.cls === 'none') { e.none += c; continue; }
    if (!e.cls[r.cls]) continue;
    e.cls[r.cls].patterns += 1; e.cls[r.cls].lines += c;
    const m = meta.get(`${r.key}|${r.sig}`);
    if (r.cls === 'sec' && ['high', 'critical'].includes(m?.severity)) e.secHigh += c;
    sigN.set(`${r.key}|${r.sig}`, { c, h: Number(r.h) || null });
  }
  for (const m of q.metas) {
    const n = sigN.get(`${m.key}|${m.sig}`);
    if (!n) continue;
    const e = get(m.key);
    const smp = lastSample(m.samples_json);
    e.top.push({ sig: m.sig, ruleId: m.rule_id || '', cls: m.cls, severity: m.severity || 'info', count: n.c, last: Number(m.last) || n.h, src: m.src || '', unit: m.unit || '', tmpl: m.tmpl || '', sample: smp ? smp.text : '' });
  }
  for (const c of q.curs) { const e = get(c.key); e.at = c.at; e.status = c.status ? { sources: Object.fromEntries(Object.entries(c.status.sources || {}).map(([s, x]) => [s, x?.status || null])), ended: c.status.ended !== false } : null; }
  for (const e of byKey.values()) { e.top.sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || b.count - a.count); e.top = e.top.slice(0, TOP_MAX); }
  _sum = { at: now, since, list: [...byKey.values()] };
  return _sum;
}
/** 함대 요약(메모리) — 아직 없으면 한 번 만든다(동시 호출은 같은 계산을 기다린다). */
export async function logSummaryNow({ agent = config.agent?.name || '', now = Date.now() } = {}) {
  if (_sum) return _sum;
  if (!_computing) _computing = refreshLogSummary({ agent, now }).finally(() => { _computing = null; });
  return _computing;
}

/**
 * 공통 원인 후보(순수 · 판정은 서버 — 웹은 그리기만): 같은 규칙이 **여러 서버에서 같은 시간대**(마지막 발생이 서로 1시간 안)면 후보.
 *   rows = [{ key, name, vcenterId, agent, top:[{ruleId, cls, severity, count, last}] }] · 반환 [{ ruleId, cls, servers:[{key,name,last,count}], from, to }].
 *   ⚠ ‘후보’ 다 — 같은 규칙이 동시에 뜬 것은 원인이 같다는 증거가 아니다(화면이 말한다).
 */
export const COMMON_WINDOW_MS = HOUR;
export function commonCauseCandidates(rows = [], { windowMs = COMMON_WINDOW_MS, minServers = 2 } = {}) {
  const byRule = new Map();
  for (const r of rows) for (const p of r?.top || []) {
    // 후보는 medium 이상만 — info · low(성공 로그인 · sudo 실행 · 체크포인트)는 평소 활동이라 ‘공통 원인’ 으로 묶으면 소음이다.
    if (!p?.ruleId || !Number.isFinite(p.last) || sevRank(p.severity) < SEVERITY_RANK.medium) continue;
    if (!byRule.has(p.ruleId)) byRule.set(p.ruleId, []);
    byRule.get(p.ruleId).push({ key: r.key, name: r.name || r.key, agent: r.agent || '', vcenterId: r.vcenterId || '', last: p.last, count: p.count, cls: p.cls, severity: p.severity });
  }
  const out = [];
  for (const [ruleId, list] of byRule) {
    list.sort((a, b) => b.last - a.last);
    // 가장 최근 발생 기준 창 안의 서버들(서버당 한 번)
    const head = list[0].last;
    const inWin = []; const seen = new Set();
    for (const x of list) { if (head - x.last > windowMs) break; if (seen.has(x.key)) continue; seen.add(x.key); inWin.push(x); }
    if (inWin.length >= minServers) out.push({ ruleId, cls: inWin[0].cls, severity: inWin[0].severity, servers: inWin.slice(0, 50), count: inWin.length, from: inWin.at(-1).last, to: head });
  }
  return out.sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || b.count - a.count);
}
