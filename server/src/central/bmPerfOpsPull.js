/**
 * central/bmPerfOpsPull.js — 리눅스 성능 5단계(v2.929 예정)의 **엣지 대행**: 집중 모니터링(시작 · 중지 · 목록 · 세션) · 변경 이벤트 · 베이스라인 띠 · 구간 비교 · 집중 1분 점.
 *
 * 규약(진단 스냅샷 v2.923 ⑩ 과 같다 — security-api.md v2.929):
 *   · 같은 url · 같은 토큰(pullFromEdge — 수집 서버 등록부 · tokenFirst · 4kb 본문) — 새 포트 · 새 인증 없음.
 *   · POST(시작 · 중지)는 **재전송 0**(retries 0 — 엣지 동작을 두 번 시키지 않는다). GET 은 재시도 1.
 *   · 엣지 응답은 **아는 필드만 · 상한 · enum 밖 code/상태 차단 · 엣지 시각은 수신 시각으로 자른다**(clampEdgeTs — 원본은 버린다: 화면용 조회라 보관하지 않는다).
 *   · 중앙은 받기만 한다(복제 적재 없음 — 상세는 볼 때 당긴다 · 설계 §13 ‘중앙은 요약만 봉투로’).
 * 이슈: 엣지 봉투의 발송 기록 중 ‘pending-central’(엣지 규칙이 이슈를 원함)을 **중앙의 문지기**(중앙 규칙의 같은 규칙 issue 켬 · 하루 상한 · 법인 예외)로 판단해 만든다(ingestEdgeAlertIssues).
 */
import { pullFromEdge } from './edgePull.js';
import { strOf } from '../util/coercionTrap.js';
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';
import { clampEdgeTs } from '../util/clampEdgeTs.js';
import { featureMinEdgeVersion, STAGE5_TITLE_RE, _resetFeatureMinEdgeVersionForTest } from './featureMinEdgeVersion.js';
import { BMPERF_RULE_LABEL, applyBmPerfFires } from '../issues/alertIssues.js';
import { RULE_IDS as PERF_RULE_IDS, loadPerfRules } from '../bmusage/perfRules.js';
import { parseRackKey, rackKeyOf } from '../bmusage/powerAlerts.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const TIMEOUT_MS = Math.max(5_000, Number(process.env.BMUSAGE_PULL_TIMEOUT_MS) || 20_000);
/**
 * 이 엔드포인트들을 내주기 시작한 엣지 버전 — **릴리스 노트(사실의 원천)에서 읽는다**(반증 F15 · v2.933 bmUsageMinEdgeVersion 와 같은 사고 방지).
 *   제목에 ‘리눅스 통합 성능 모니터링 5단계’ 가 든 가장 낮은 게시 번호 · 노트에 아직 없으면(개발 중 · 릴리스 직전) 지금 실행 중인 package.json 번호.
 *   다른 세션이 main 에 계속 릴리스해 최종 번호는 릴리스 순간에 정해지고, 번호 재배치 스크립트는 코드 상수를 고치지 않는다 — 그래서 손으로 맞추는 상수를 두지 않는다.
 *   ⚠ 이 값은 게이트가 아니다: 판정은 ‘그 경로가 엣지에 있는가’(구버전 엣지는 collector 라우터에 경로가 없어 401/404 → old-version)이고 이 번호는 안내 문구에만 들어간다.
 *   한 번 읽어 메모한다(노트는 프로세스 수명 동안 바뀌지 않는다 — 업그레이드는 재시작).
 */
export const PERF_OPS_RELEASE_TITLE_RE = STAGE5_TITLE_RE;
// 6단계: 본체는 central/featureMinEdgeVersion.js(표지별 메모 · 같은 폴백) — 5단계 이름 · 인자 · 동작은 그대로(bmPerfMinEdgeVersion2929 가 고정).
export function perfOpsMinEdgeVersion(o = {}) { return featureMinEdgeVersion(PERF_OPS_RELEASE_TITLE_RE, o); }
export function _resetPerfOpsMinEdgeVersionForTest() { _resetFeatureMinEdgeVersionForTest(PERF_OPS_RELEASE_TITLE_RE); }
const FOCUS_CODES = new Set(['ok', 'queued', 'bad-reason', 'bad-request', 'not-found', 'no-path', 'busy', 'daily-cap', 'auth-stopped', 'store-unavailable', 'settings-unreadable']);
const FOCUS_STATUS = new Set(['queued', 'running', 'done', 'stopped', 'auth', 'interrupted', 'failed']);
const VERDICTS = new Set(['bottleneck', 'saturated', 'errors', 'warn', 'ok', 'partial', 'stale', 'unknown']);
const MISS = new Set(['timeout', 'auth', 'auth-stopped', 'ssh-error', 'host-key', 'not-linux', 'no-path', 'pool-busy', 'unreachable', 'no-telemetry', 'error']);
const CHANGE_KINDS = new Set(['reboot', 'kernel', 'needs-restart', 'package', 'sysctl', 'sysctl-file', 'sysctl-all', 'cron', 'tuned', 'selinux', 'firewalld', 'units-failed', 'firmware', 'cvp-map', 'health', 'idle']);
const VAL_KEYS = new Set(['cpu_pct', 'cpu_iowait_pct', 'runq_per_core', 'disk_busy_pct', 'disk_await_ms', 'disk_aqu', 'psi_io_full10', 'mem_pct', 'swap_out_ps', 'net_pct', 'net_drop_delta', 'net_err_delta', 'power_w', 'inlet_c', 'idrac_cpu_pct', 'dmesg_err']);
const RES_KEYS = new Set(['cpu', 'mem', 'disk', 'net', 'hw']);
const ts = (v, now) => clampEdgeTs(numOrNull(v), now);
const enumOr = (v, set, def) => (typeof v === 'string' && set.has(v) ? v : def);

const procs = (a) => (Array.isArray(a) ? a.slice(0, 5).filter(isObj).map((x) => ({ name: strOf(x.name, 32), cpuPct: numOrNull(x.cpuPct), readBps: numOrNull(x.readBps), writeBps: numOrNull(x.writeBps) })) : []);
function cleanVals(v) {
  const out = {};
  if (!isObj(v)) return out;
  for (const k of Object.keys(v)) {
    if (k === '_res' && isObj(v._res)) { out._res = Object.fromEntries(Object.entries(v._res).filter(([r]) => RES_KEYS.has(r)).map(([r, x]) => [r, enumOr(x, VERDICTS, 'unknown')])); continue; }
    if (!VAL_KEYS.has(k) || !isObj(v[k])) continue;
    out[k] = { avg: numOrNull(v[k].avg), ...(Object.hasOwn(v[k], 'peak') ? { peak: numOrNull(v[k].peak) } : {}) };
  }
  return out;
}
function cleanSummary(s, now) {
  if (!isObj(s)) return null;
  const maxBy = {};
  for (const [k, v] of Object.entries(isObj(s.maxBy) ? s.maxBy : {})) if (VAL_KEYS.has(k) && isObj(v)) maxBy[k] = { value: numOrNull(v.value), at: ts(v.at, now) };
  const before = {};
  for (const [k, v] of Object.entries(isObj(s.before) ? s.before : {})) if (VAL_KEYS.has(k) && isObj(v)) before[k] = { avg: numOrNull(v.avg), max: numOrNull(v.max), n: numOrNull(v.n) };
  return {
    verdicts: (Array.isArray(s.verdicts) ? s.verdicts : []).slice(0, 120).map((x) => (x == null ? null : enumOr(x, VERDICTS, 'unknown'))),
    verdictFrom: s.verdictFrom == null ? null : enumOr(s.verdictFrom, VERDICTS, 'unknown'), verdictTo: s.verdictTo == null ? null : enumOr(s.verdictTo, VERDICTS, 'unknown'),
    worst: s.worst == null ? null : enumOr(s.worst, VERDICTS, 'unknown'), focusRes: s.focusRes == null ? null : enumOr(s.focusRes, RES_KEYS, null),
    maxBy, before,
    candidates: (Array.isArray(s.candidates) ? s.candidates : []).slice(0, 3).filter(isObj).map((c) => ({ name: strOf(c.name, 32), io: numOrNull(c.io), cpu: numOrNull(c.cpu), of: numOrNull(c.of) })),
    withSnap: numOrNull(s.withSnap), missOs: numOrNull(s.missOs), missIdrac: numOrNull(s.missIdrac),
    actions: (Array.isArray(s.actions) ? s.actions : []).slice(0, 8).map((x) => strOf(x, 32)).filter((x) => /^[a-z-]{1,32}$/.test(x)),
    ...(s.error ? { error: strOf(s.error, 200) } : {}),
  };
}
export function cleanSession(s, now = Date.now()) {
  if (!isObj(s)) return null;
  return {
    id: strOf(s.id, 40), key: strOf(s.key, 256), vcenterId: strOf(s.vcenterId, 128), trigger: s.trigger === 'auto' ? 'auto' : 'manual', rule: strOf(s.rule, 32), by: strOf(s.by, 64), reason: strOf(s.reason, 300),
    created: ts(s.created, now), start: ts(s.start, now), end: ts(s.end, now), intervalS: numOrNull(s.intervalS), count: numOrNull(s.count), done: numOrNull(s.done),
    missOs: numOrNull(s.missOs), missIdrac: numOrNull(s.missIdrac), status: enumOr(s.status, FOCUS_STATUS, 'failed'),
    ...(typeof s.hasOs === 'boolean' ? { hasOs: s.hasOs } : {}), ...(typeof s.hasIdrac === 'boolean' ? { hasIdrac: s.hasIdrac } : {}),
    ...(numOrNull(s.queuePos) != null ? { queuePos: numOrNull(s.queuePos) } : {}),
    ...(isObj(s.summary) ? { summary: cleanSummary(s.summary, now) } : {}),
  };
}
export function cleanSample(x, now = Date.now()) {
  if (!isObj(x)) return null;
  const sn = isObj(x.snap) ? (x.snap.error ? { error: strOf(x.snap.error, 32) } : { cpuTop: procs(x.snap.cpuTop), ioTop: procs(x.snap.ioTop), io: strOf(x.snap.io, 16), cpu: strOf(x.snap.cpu, 16),
    ssTcp: isObj(x.snap.ssTcp) ? { total: numOrNull(x.snap.ssTcp.total), estab: numOrNull(x.snap.ssTcp.estab), timewait: numOrNull(x.snap.ssTcp.timewait) } : null }) : null;
  return { idx: numOrNull(x.idx), minuteTs: ts(x.minuteTs, now), osOk: x.osOk === true, idracOk: x.idracOk == null ? null : x.idracOk === true, verdict: x.verdict == null ? null : enumOr(x.verdict, VERDICTS, 'unknown'),
    missOs: x.missOs == null ? null : enumOr(x.missOs, MISS, 'error'), missIdrac: x.missIdrac == null ? null : enumOr(x.missIdrac, MISS, 'error'), vals: cleanVals(x.vals), snap: sn };
}
export function cleanChange(e, now = Date.now()) {
  if (!isObj(e) || !CHANGE_KINDS.has(e.kind)) return null;
  return { id: numOrNull(e.id), ts: ts(e.ts, now), kind: e.kind, item: strOf(e.item, 96), before: e.before == null ? null : strOf(e.before, 120), after: e.after == null ? null : strOf(e.after, 120) };
}
/** 집중 응답 본문 정제(시작 · 중지 · 목록 · 세션). */
export function sanitizeFocusBody(b, now = Date.now()) {
  if (!isObj(b)) return null;
  const code = enumOr(b.code, FOCUS_CODES, b.ok === true ? 'ok' : 'not-found');
  return {
    ok: b.ok === true, code, ...(b.reason != null ? { reason: strOf(b.reason, 300) } : {}),
    ...(b.id != null ? { id: strOf(b.id, 40) } : {}), ...(b.status != null ? { status: enumOr(b.status, FOCUS_STATUS, 'failed') } : {}),
    ...(numOrNull(b.queuePos) != null ? { queuePos: numOrNull(b.queuePos) } : {}), ...(numOrNull(b.intervalS) != null ? { intervalS: numOrNull(b.intervalS), count: numOrNull(b.count) } : {}),
    ...(Array.isArray(b.sessions) ? { sessions: b.sessions.slice(0, 200).map((s) => cleanSession(s, now)).filter(Boolean) } : {}),
    ...(isObj(b.session) ? { session: cleanSession(b.session, now) } : {}),
    ...(Array.isArray(b.samples) ? { samples: b.samples.slice(0, 120).map((x) => cleanSample(x, now)).filter(Boolean) } : {}),
    ...(Array.isArray(b.changes) ? { changes: b.changes.slice(0, 200).map((x) => cleanChange(x, now)).filter(Boolean) } : {}),
    ...(numOrNull(b.keepDays) != null ? { keepDays: numOrNull(b.keepDays) } : {}),
  };
}
const focusBodyOk = (b) => isObj(b) && typeof b.code === 'string';
export async function runEdgeFocus(agent, { key, reason, by } = {}) {
  const r = await pullFromEdge(agent, '/api/collector/bm-usage/focus', {
    method: 'POST', jsonBody: { key: capStr(String(key), 256), reason: capStr(String(reason), 300), by: capStr(String(by || ''), 64) }, retries: 0, timeoutMs: TIMEOUT_MS,
    minVersion: perfOpsMinEdgeVersion(), what: '집중 모니터링을 시작할', label: '엣지 집중 모니터링 응답', bodyOk: focusBodyOk, missing401: true,
  });
  if (!r.ok) return { ok: false, code: 'edge', kind: r.kind, reason: r.reason };
  return sanitizeFocusBody(r.body) || { ok: false, code: 'edge', kind: 'bad-body', reason: '엣지 응답 형식이 다릅니다.' };
}
export async function stopEdgeFocus(agent, { key, id, by } = {}) {
  const r = await pullFromEdge(agent, '/api/collector/bm-usage/focus/stop', {
    method: 'POST', jsonBody: { key: capStr(String(key), 256), id: capStr(String(id), 40), by: capStr(String(by || ''), 64) }, retries: 0, timeoutMs: TIMEOUT_MS,
    minVersion: perfOpsMinEdgeVersion(), what: '집중 모니터링을 멈출', label: '엣지 집중 모니터링 응답', bodyOk: focusBodyOk, missing401: true,
  });
  if (!r.ok) return { ok: false, code: 'edge', kind: r.kind, reason: r.reason };
  return sanitizeFocusBody(r.body) || { ok: false, code: 'edge', kind: 'bad-body', reason: '엣지 응답 형식이 다릅니다.' };
}
export async function pullEdgeFocus(agent, { key, id = '' } = {}) {
  const qs = new URLSearchParams({ key: String(key) });
  if (id) qs.set('id', String(id));
  const r = await pullFromEdge(agent, `/api/collector/bm-usage/focus?${qs.toString()}`, {
    timeoutMs: TIMEOUT_MS, retries: 1, minVersion: perfOpsMinEdgeVersion(), what: '집중 모니터링을 읽을', label: '엣지 집중 모니터링 응답', bodyOk: focusBodyOk, missing401: true,
  });
  if (!r.ok) return { ok: false, code: 'edge', kind: r.kind, reason: r.reason };
  return sanitizeFocusBody(r.body) || { ok: false, code: 'edge', kind: 'bad-body', reason: '엣지 응답 형식이 다릅니다.' };
}

/* ── 변경 이벤트 · 베이스라인 · 비교 · 집중 점(GET — 보관 없음) ─────────────── */
export function sanitizeChangesBody(b, now = Date.now()) {
  if (!isObj(b)) return null;
  return { ok: b.ok === true, key: strOf(b.key, 256), from: ts(b.from, now), to: ts(b.to, now), events: (Array.isArray(b.events) ? b.events : []).slice(0, 2_000).map((e) => cleanChange(e, now)).filter(Boolean),
    ...(b.truncated === true ? { truncated: true } : {}), ...(numOrNull(b.keepDays) != null ? { keepDays: numOrNull(b.keepDays) } : {}),
    ...(Array.isArray(b.focus) ? { focus: b.focus.slice(0, 2_000).filter(isObj).map((x) => ({ t: ts(x.t, now), sessionId: strOf(x.sessionId, 40), verdict: x.verdict == null ? null : enumOr(x.verdict, VERDICTS, 'unknown'), vals: cleanVals(x.vals) })) } : {}),
    ...(b.reason ? { reason: strOf(b.reason, 200) } : {}) };
}
export function sanitizeBaselineBody(b, now = Date.now()) {
  if (!isObj(b)) return null;
  const REASONS = new Set(['no-history', 'few-weeks', 'missing']);
  return { ok: b.ok === true, key: strOf(b.key, 256), metric: strOf(b.metric, 32), from: ts(b.from, now), to: ts(b.to, now), weeks: numOrNull(b.weeks), bandPct: numOrNull(b.bandPct), minWeeks: numOrNull(b.minWeeks), maxMissingPct: numOrNull(b.maxMissingPct),
    series: (Array.isArray(b.series) ? b.series : []).slice(0, 400).filter(isObj).map((x) => (x.reason ? { t: ts(x.t, now), reason: enumOr(x.reason, REASONS, 'no-history'), weeks: numOrNull(x.weeks) } : { t: ts(x.t, now), mean: numOrNull(x.mean), lo: numOrNull(x.lo), hi: numOrNull(x.hi), weeks: numOrNull(x.weeks) })),
    outside: Array.isArray(b.outside) ? b.outside.slice(0, 2_000).filter(isObj).map((x) => ({ t: ts(x.t, now), avg: numOrNull(x.avg), out: x.out === 'below' ? 'below' : 'above' })).filter((x) => x.avg != null) : null,
    ...(b.capped === true ? { capped: true } : {}), ...(b.reason ? { reason: strOf(b.reason, 200) } : {}) };
}
export function sanitizeCompareBody(b, now = Date.now()) {
  if (!isObj(b)) return null;
  const win = (w) => (isObj(w) ? { from: ts(w.from, now), to: ts(w.to, now) } : null);
  const side = (x) => (isObj(x) ? { avg: numOrNull(x.avg), peak: numOrNull(x.peak), n: numOrNull(x.n) } : null);
  return {
    ok: b.ok === true, key: strOf(b.key, 256), res: ['5m', '1h', '1d'].includes(b.res) ? b.res : null, stepMs: numOrNull(b.stepMs), slots: numOrNull(b.slots), a: win(b.a), b: win(b.b),
    lengthAdjusted: b.lengthAdjusted === true, diffPct: numOrNull(b.diffPct), resReason: strOf(b.resReason, 32),
    metrics: (Array.isArray(b.metrics) ? b.metrics : []).slice(0, 32).filter(isObj).map((m) => ({ metric: strOf(m.metric, 32), a: side(m.a), b: side(m.b), diffAvgPct: numOrNull(m.diffAvgPct), diffPeakPct: numOrNull(m.diffPeakPct),
      out: { avg: m.out?.avg === true, peak: m.out?.peak === true }, missingA: numOrNull(m.missingA), missingB: numOrNull(m.missingB), excluded: numOrNull(m.excluded), pairs: numOrNull(m.pairs) })),
    procs: isObj(b.procs) ? { available: b.procs.available === true, a: numOrNull(b.procs.a), b: numOrNull(b.procs.b),
      rows: (Array.isArray(b.procs.rows) ? b.procs.rows : []).slice(0, 10).filter(isObj).map((r) => ({ name: strOf(r.name, 32), aIoBps: numOrNull(r.aIoBps), bIoBps: numOrNull(r.bIoBps), aCpuPct: numOrNull(r.aCpuPct), bCpuPct: numOrNull(r.bCpuPct), only: r.only === 'a' || r.only === 'b' ? r.only : null })),
      snapsA: (Array.isArray(b.procs.snapsA) ? b.procs.snapsA : []).slice(0, 200).filter(isObj).map((x) => ({ src: x.src === 'focus' ? 'focus' : 'snapshot', at: ts(x.at, now) })),
      snapsB: (Array.isArray(b.procs.snapsB) ? b.procs.snapsB : []).slice(0, 200).filter(isObj).map((x) => ({ src: x.src === 'focus' ? 'focus' : 'snapshot', at: ts(x.at, now) })) } : null,
    tuning: (Array.isArray(b.tuning) ? b.tuning : []).slice(0, 200).map((e) => cleanChange(e, now)).filter(Boolean),
    changes: (Array.isArray(b.changes) ? b.changes : []).slice(0, 500).map((e) => cleanChange(e, now)).filter(Boolean),
    ...(b.changesTruncated === true ? { changesTruncated: true } : {}), ...(b.reason ? { reason: strOf(b.reason, 200) } : {}),
  };
}
const SANITIZERS = { changes: sanitizeChangesBody, baseline: sanitizeBaselineBody, compare: sanitizeCompareBody };
/**
 * 응답 모양 판정(모드마다 — 6단계 반증 F2 정정). pullFromEdge 기본 판정은 봉투의 `{ok, node}` 라 node 가 없는 이 응답들은 v2.929(5단계) 게시 이후 성공이 전부 bad-body 였다
 *   (5단계 테스트는 구버전 401 · 404 경로만 불렀다). 회귀: server/test/bmEdgeRoundTrip.test.js(실제 collector 라우터 왕복).
 */
export const PERF_OPS_BODY_OK = Object.freeze({
  changes: (b) => isObj(b) && b.ok === true && Array.isArray(b.events),
  baseline: (b) => isObj(b) && b.ok === true && Array.isArray(b.series),
  compare: (b) => isObj(b) && b.ok === true && Array.isArray(b.metrics),
});
/** GET 한 번(보관 없음). mode: changes · baseline · compare. */
export async function pullEdgePerfOps(agent, mode, { key, query = {} } = {}) {
  if (!SANITIZERS[mode]) return { ok: false, kind: 'bad-request', reason: 'mode' };
  const qs = new URLSearchParams({ key: String(key) });
  for (const k of ['from', 'to', 'metric', 'aFrom', 'aTo', 'bFrom', 'bTo', 'res', 'focus']) if (query?.[k] != null && query[k] !== '') qs.set(k, capStr(String(query[k]), 64));
  const r = await pullFromEdge(agent, `/api/collector/bm-usage/${mode}?${qs.toString()}`, {
    timeoutMs: TIMEOUT_MS, retries: 1, minVersion: perfOpsMinEdgeVersion(), what: '성능 기록을 읽을', label: '엣지 성능 기록 응답', bodyOk: PERF_OPS_BODY_OK[mode],
    missing401: true,   // 경로가 없는 구버전 엣지는 사용자 인증 미들웨어로 떨어져 401 — 토큰 문제가 아니라 버전 문제다(스냅샷 대행과 같은 판정)
  });
  if (!r.ok) return { ok: false, kind: r.kind, reason: r.reason };
  const body = SANITIZERS[mode](r.body);
  return body ? { ok: true, body } : { ok: false, kind: 'bad-body', reason: '엣지 응답 형식이 다릅니다.' };
}

/* ── 봉투 요약 정제(central/bmPerfSanitize.js 가 부른다) ─────────────────── */
// 규칙 id 는 규칙 목록 하나(perfRules.RULE_IDS)에서 — ⚠ 정정(다음 점검 ②): 손으로 적은 목록에 8a ‘capacity’ 가 빠져 엣지의 용량 예측 발송 건이 중앙 이력 · 이슈에서 ‘use’(USE 판정 변화)로 바뀌었다.
const RULES = new Set(PERF_RULE_IDS);
const RESULTS = new Set(['queued', 'sent', 'failed', 'suppressed', 'no-channel', 'no-channel-config', 'daily-cap', 'maintenance', 'error', '']);
const ISSUE = new Set(['pending-central', 'daily-cap', 'created', 'commented', 'dup', 'error', 'skipped']);
export function sanitizeFocusSummary(list, now = Date.now()) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 200).filter(isObj).map((s) => ({
    id: strOf(s.id, 40), key: strOf(s.key, 256), vcenterId: strOf(s.vcenterId, 128), trigger: s.trigger === 'auto' ? 'auto' : 'manual', status: enumOr(s.status, FOCUS_STATUS, 'failed'),
    created: ts(s.created, now), start: ts(s.start, now), end: ts(s.end, now), intervalS: numOrNull(s.intervalS), count: numOrNull(s.count), done: numOrNull(s.done),
    missOs: numOrNull(s.missOs), missIdrac: numOrNull(s.missIdrac), ...(numOrNull(s.queuePos) != null ? { queuePos: numOrNull(s.queuePos) } : {}),
    verdictFrom: s.verdictFrom == null ? null : enumOr(s.verdictFrom, VERDICTS, 'unknown'), verdictTo: s.verdictTo == null ? null : enumOr(s.verdictTo, VERDICTS, 'unknown'), candidate: s.candidate == null ? null : strOf(s.candidate, 32),
  })).filter((s) => s.id && s.key);
}
export function sanitizeAlertSent(list, now = Date.now()) {
  if (!Array.isArray(list)) return null;
  return list.slice(-200).filter(isObj).map((r) => ({
    id: strOf(r.id, 16), at: ts(r.at, now), rule: enumOr(r.rule, RULES, 'use'), key: strOf(r.key, 256), name: strOf(r.name, 120), vcenterId: strOf(r.vcenterId, 128), title: strOf(r.title, 200),
    channels: (Array.isArray(r.channels) ? r.channels : []).slice(0, 4).filter((c) => ['email', 'webhook', 'slack', 'teams'].includes(c)),
    result: enumOr(r.result, RESULTS, ''), issue: r.issue == null ? null : enumOr(r.issue, ISSUE, 'skipped'), autoFocus: r.autoFocus == null ? null : strOf(r.autoFocus, 40),
  })).filter((r) => r.id && r.key);
}

/** 엣지 문자열 → 표시용 이름(URL 제거 · 공백 정리 · 상한 — 길이를 먼저 자르고 선형 치환). */
const URL_RE = /\b(?:https?|ftp|file):\/\/[^\s]{0,400}/gi;
export function safeEdgeName(v, n = 80) {
  return capStr(capStr(v, 400).replace(URL_RE, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/ {2,}/g, ' ').trim(), n);
}
/**
 * 엣지 봉투의 발송 기록을 **중앙 기준으로 다시 세운다**(반증 F9 — 엣지 봉투의 법인 · 서버 키 · 제목을 그대로 이슈 · 범위에 쓰지 않는다):
 *   · 서버 키는 **그 엣지가 같은 봉투로 보고한 대상 목록**(snap.targets)에 있는 것만 — 없으면 버리고 개수만 센다(dropped).
 *   · 법인은 **중앙이 정한다** — 파트 장애 자동 등록과 같은 함수(issues/autoCreate.js resolveIssueVcenter: 서비스 태그 → ESXi 호스트의 vCenter ·
 *     아니면 그 엣지가 수집하는 vCenter 중 대상이 보고한 것(엣지 주장 ∩ 중앙이 아는 그 엣지 담당) · 아니면 담당이 하나일 때만 · 아니면 공용 — 지어내지 않는다).
 *   · 제목 · 이름은 중앙이 code 로 다시 만든다(규칙 이름 + 대상 이름 — URL 제거 · 상한). 엣지가 보낸 title 문자열은 쓰지 않는다.
 */
export async function centralizeEdgeSent(agent, snap, deps = {}) {
  const sent = Array.isArray(snap?.perfAlertSent) ? snap.perfAlertSent : [];
  const targets = new Map((Array.isArray(snap?.targets) ? snap.targets : []).filter(isObj).map((t) => [String(t.key || ''), t]).filter(([k]) => k));
  const resolve = deps.resolveVc || (async (p, ctx) => (await import('../issues/autoCreate.js')).resolveIssueVcenter(p, ctx));
  const ctx = {}; const list = []; let dropped = 0;
  const ag = capStr(String(agent ?? ''), 64);
  for (const r of sent) {
    if (!isObj(r)) { dropped += 1; continue; }
    // 6단계 수집 건강 — 서버가 아니라 그 수집 노드 한 칸(key '__node__'): 대상 목록과 대지 않고 법인은 공용(''), 이름은 중앙이 아는 엣지 이름으로.
    if (r.rule === 'collect' && String(r.key || '') === '__node__') {
      const nm = safeEdgeName(`수집 노드 ${capStr(String(agent ?? ''), 64)}`, 80);
      list.push({ ...r, key: '__node__', name: nm, vcenterId: '', title: capStr(`${nm} — ${BMPERF_RULE_LABEL.collect}`, 200) });
      continue;
    }
    /*
     * 다음 점검 ② 랙 여유 — 서버가 아니라 랙 한 칸(키 rack:<법인>|<랙>): 대상 목록과 대지 않는다. 랙 이름은 엣지 글자라 형식(perfRules 랙 규칙 — 1~32자 · 쉼표 · 제어문자 없음)을
     *   통과한 것만 받고 표시용으로 다시 정리한다. 법인은 **중앙이 정한다**(키 안의 법인 = 엣지 주장 → 그 엣지 담당 vCenter 일 때만 · 아니면 담당 하나 · 아니면 공용) —
     *   키도 중앙이 정한 법인으로 다시 만든다(엣지가 다른 법인 이름을 키에 넣어 그 법인 이력 · 이슈에 끼워 넣지 못한다).
     */
    if (r.rule === 'rack') {
      const rk = parseRackKey(r.key);
      if (!rk || !/^[^\u0000-\u001f\u007f,]{1,32}$/.test(rk.rack)) { dropped += 1; continue; }
      let vc = null;
      try { vc = await resolve({ agent: ag, scope: 'idrac', deviceKeyKind: '', deviceKey: '', claimedVcenterId: strOf(rk.vcenterId, 128) }, ctx); } catch { vc = null; }
      const vcId = String(vc?.id || '');
      const nm = safeEdgeName(`랙 ${rk.rack}`, 80);
      list.push({ ...r, key: rackKeyOf(vcId, rk.rack), name: nm, vcenterId: vcId, title: capStr(`${nm} — ${BMPERF_RULE_LABEL.rack}(수집 노드 ${ag})`, 200) });
      continue;
    }
    const tg = targets.get(String(r.key || ''));
    if (!tg) { dropped += 1; continue; }
    const tag = strOf(tg.serviceTag, 64);
    let vc = null;
    try { vc = await resolve({ agent: ag, scope: 'idrac', deviceKeyKind: tag ? 'serviceTag' : '', deviceKey: tag || strOf(tg.key, 256), claimedVcenterId: strOf(tg.vcenterId, 128) }, ctx); } catch { vc = null; }
    const name = safeEdgeName(tg.name || tg.key, 80) || safeEdgeName(tg.key, 80);
    const label = BMPERF_RULE_LABEL[r.rule] || '성능 규칙';
    list.push({ ...r, key: strOf(tg.key, 256), name, vcenterId: String(vc?.id || ''), title: capStr(`${name} — ${label}(수집 노드 ${ag})`, 200) });
  }
  return { list, dropped };
}

/**
 * 엣지 봉투의 ‘pending-central’ 발송 건 → 중앙 이슈(중앙 규칙의 같은 규칙에 issue 가 켜져 있을 때만 · 법인 예외 — 중앙이 정한 법인으로 · 법인별 하루 상한). 같은 건은 두 번 만들지 않는다.
 *   중앙이 봉투를 당길 때(사람이 화면을 열 때 — 상시 push 없음) 돈다: 엣지 발송과 이슈 사이에 그만큼 늦을 수 있다(정직 기록).
 */
export async function ingestEdgeAlertIssues(agent, snap, deps = {}) {
  const pend = (Array.isArray(snap?.perfAlertSent) ? snap.perfAlertSent : []).filter((r) => isObj(r) && r.issue === 'pending-central');
  if (!pend.length) return { created: 0, dropped: 0 };
  const D = {
    rules: async () => loadPerfRules(),
    apply: async (fires, o) => applyBmPerfFires(fires, o),
    ...deps,
  };
  const { list, dropped } = await centralizeEdgeSent(agent, { ...snap, perfAlertSent: pend }, deps);
  const rules = await D.rules();
  const fires = list.filter((r) => rules.rules?.[r.rule]?.on && rules.rules[r.rule].issue === true && !(rules.rules[r.rule].corpsOff || []).includes(r.vcenterId))
    .map((r) => ({ ...r, id: `${capStr(String(agent), 48)}:${r.id}`, agent: capStr(String(agent), 64) }));
  if (!fires.length) return { created: 0, dropped };
  const res = await D.apply(fires, { dailyMax: rules.daily?.issues ?? 20 });
  return { created: Object.values(res?.byId || {}).filter((x) => x === 'created').length, byId: res?.byId || {}, dropped };
}
