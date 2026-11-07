/**
 * central/bmLogsPull.js — 리눅스 성능 7a단계 **로그 분석의 중앙 쪽**: 엣지 봉투 요약(logSummary) 정제 · 엣지 대행 상세(GET /api/collector/bm-usage/logs) 당김 · 정제.
 *
 * 규약(edge.md ‘엣지가 보낸 것은 정제한다’ · 5 · 6단계 대행과 같다):
 *   · 아는 필드만 · 객체만 · 상한(서버 2,000 · 패턴 8/300 · 표본 5 · 보안 항목 15) · 문자열 수치는 수로(numOrNull — 못 읽으면 null, 0 으로 두지 않는다) ·
 *     **규칙 id 는 카탈로그(LOG_RULE_IDS)에 있는 것만** · 분류 · 심각도 · 출처 상태는 열거 밖이면 버린다 · 서명은 16진 16자 · 글자는 길이 상한 + 제어문자 제거 ·
 *     엣지 시각은 수신 시각으로 자른다(clampEdgeTs) · 서버 키는 **그 엣지가 같은 봉투로 보고한 대상 목록**에 있는 것만(남의 서버 행을 끼워 넣지 못한다).
 *   · 같은 url · 같은 토큰(pullFromEdge — 새 포트 · 새 인증 없음) · GET 재시도 1 · 보관 없음(중앙은 받기만 — 상세는 볼 때 당긴다 · 원문은 법인 밖으로 나가지 않는다).
 *   · ⚠⚠ 6단계 반증 F2: pullFromEdge 의 기본 본문 판정은 봉투(`{ok, node}`)라 이 응답(node 없음)에 **bodyOk 를 명시**한다 — 회귀 bmLogs7aRoundTrip.test.js(실제 collector 라우터 왕복).
 *   · 구버전 엣지(경로 없음 → 401/404)는 old-version — 최소 버전 문구는 릴리스 노트의 7a단계 첫 게시 번호(featureMinEdgeVersion — 숫자를 박지 않는다).
 */
import { pullFromEdge } from './edgePull.js';
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';
import { clampEdgeTs } from '../util/clampEdgeTs.js';
import { reqTimeoutMs } from '../agent/envTimeout.js';
import { stage7aMinEdgeVersion } from './featureMinEdgeVersion.js';
import { LOG_RULE_IDS, LOG_CLASSES, LOG_SOURCES, SEC_KINDS, LOG_EVIDENCE, CLASS_LABEL, logRuleCatalog } from '../bmusage/logs/rules.js';
import { STATUS, PERM_SCOPES } from '../bmusage/logs/parse.js';
import { LOG_SECTIONS, APP_LOGS, AUTH_IDENTS } from '../bmusage/logs/command.js';
import { maskStoredTmpl } from '../bmusage/logs/classify.js';
import { SEC_TOTAL_KEYS } from '../bmusage/logs/view.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const TIMEOUT_MS = reqTimeoutMs(process.env.BMUSAGE_PULL_TIMEOUT_MS, 20_000, { min: 5_000 });
const RULES = new Set(LOG_RULE_IDS);
const CLS = new Set(LOG_CLASSES);
const SEV = new Set(['critical', 'high', 'medium', 'low', 'info']);
const SRC = new Set(LOG_SOURCES);
const STAT = new Set(STATUS);
const SECK = new Set(['fail_ip', 'fail_user', ...SEC_KINDS.filter((k) => k !== 'fail')]);
const SIG_RE = /^(?:[0-9a-f]{16}|#over:(?:fault|perf|sec|issue))$/;
const N = numOrNull;
/** 엣지 글자 → 표시용(길이를 먼저 자르고 제어문자 제거 — 선형). */
export const txt = (v, n = 200) => capStr(typeof v === 'string' ? v : '', n).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
const ts = (v, now) => clampEdgeTs(N(v), now);
const enumOr = (v, set, def = null) => (typeof v === 'string' && set.has(v) ? v : def);

function clsMap(x) {
  const out = {};
  for (const c of LOG_CLASSES) { const v = isObj(x) ? x[c] : null; out[c] = isObj(v) ? { patterns: N(v.patterns), lines: N(v.lines) } : { patterns: null, lines: null }; }
  return out;
}
function topOf(p, now) {
  if (!isObj(p) || !RULES.has(p.ruleId) && p.ruleId !== '') return null;
  const sig = typeof p.sig === 'string' && SIG_RE.test(p.sig) ? p.sig : null;
  if (!sig) return null;
  return { sig, ruleId: RULES.has(p.ruleId) ? p.ruleId : '', cls: enumOr(p.cls, CLS, 'issue'), severity: enumOr(p.severity, SEV, 'info'), count: N(p.count), last: ts(p.last, now),
    src: enumOr(p.src, SRC, ''), unit: txt(p.unit, 64), tmpl: maskStoredTmpl(p.cls, txt(p.tmpl, 200)), sample: txt(p.sample, 300) };
}
/**
 * 봉투 logSummary → 중앙 보관 모양(순수). targetKeys = 그 엣지가 같은 봉투로 보고한 대상 키 집합(없으면 전부 버린다).
 * @returns {{list:Array, dropped:number}}
 */
export function sanitizeLogSummary(list, { targetKeys = new Set(), now = Date.now() } = {}) {
  const arr = Array.isArray(list) ? list : [];
  let dropped = 0; const out = [];
  for (const x of arr.slice(0, 2_000)) {
    if (!isObj(x) || typeof x.key !== 'string' || !targetKeys.has(x.key)) { dropped += 1; continue; }
    const st = isObj(x.status) && isObj(x.status.sources) ? { sources: Object.fromEntries(LOG_SOURCES.map((s) => [s, enumOr(x.status.sources[s], STAT, null)])), ended: x.status.ended !== false } : null;
    out.push({
      key: capStr(x.key, 256), at: ts(x.at, now), wasRead: x.wasRead === true, ...(typeof x.secRead === 'boolean' ? { secRead: x.secRead } : {}), cls: clsMap(x.cls), none: N(x.none), read: N(x.read), trunc: N(x.trunc), secHigh: N(x.secHigh),
      ...(N(x.undated) != null ? { undated: N(x.undated) } : {}),
      top: (Array.isArray(x.top) ? x.top : []).slice(0, 8).map((p) => topOf(p, now)).filter(Boolean), status: st,
    });
  }
  dropped += Math.max(0, arr.length - 2_000);
  return { list: out, dropped };
}

const APP_IDS = new Set(APP_LOGS.map((a) => a.id));
const PSCOPE = new Set(PERM_SCOPES);
const AUTHSRC = new Set(['secure', 'jsec', 'audit']);
/** 출처 상태 하나(아는 필드만 — 화면이 쓰는 칩 · 권한 안내 · 첫 읽기 · 부분 · 시각 모름이 엣지 대행에서도 같게: 반증 F9). */
function srcStatus(s) {
  if (!isObj(s)) return null;
  const nOpt = (k) => (N(s[k]) != null ? { [k]: N(s[k]) } : {});
  return { status: enumOr(s.status, STAT, 'missing'), n: N(s.n), emitted: N(s.emitted), truncated: N(s.truncated), ...(typeof s.mode === 'string' && /^(first|inc|shrink|rot)$/.test(s.mode) ? { mode: s.mode } : {}),
    ...(s.rotated === true ? { rotated: true } : {}), ...(s.lost === true ? { lost: true } : {}), ...(s.shrunk === true ? { shrunk: true } : {}), ...(s.rebooted === true ? { rebooted: true } : {}),
    ...(s.cursorReset === true ? { cursorReset: true } : {}), ...(s.first === true ? { first: true } : {}), ...(s.nofiles === true ? { nofiles: true } : {}), ...(s.toolMsg === true ? { toolMsg: true } : {}),
    ...(Object.hasOwn(s, 'svc') ? { svc: typeof s.svc === 'string' && /^[a-z-]{1,16}$/.test(s.svc) ? s.svc : null } : {}),
    ...(PSCOPE.has(s.scope) ? { scope: s.scope } : {}), ...(s.tool === 'absent' ? { tool: 'absent' } : {}),
    ...(typeof s.reason === 'string' && /^[a-z-]{1,16}$/.test(s.reason) ? { reason: s.reason } : {}),
    ...(s.partial === 'timeout' ? { partial: 'timeout' } : N(s.partial) != null ? { partial: N(s.partial) } : {}),
    ...(AUTHSRC.has(s.dupOf) ? { dupOf: s.dupOf } : {}), ...(Array.isArray(s.groups) ? { groups: s.groups.filter((g) => /^(?:systemd-journal|adm|wheel)$/.test(g)).slice(0, 3) } : {}),
    ...nOpt('rc'), ...nOpt('older'), ...nOpt('authSkipped'), ...nOpt('undated'), ...nOpt('skew'), ...nOpt('dup'), ...nOpt('uid'), ...nOpt('skippedBytes'), ...nOpt('jsonCut') };
}
const secList = (a) => (Array.isArray(a) ? a.slice(0, 15).filter(isObj).map((x) => ({ item: txt(x.item, 128), count: N(x.count) })).filter((x) => x.item) : []);
/** 엣지 대행 상세 본문 정제(순수 · 아는 필드만). */
export function sanitizeLogView(b, now = Date.now()) {
  if (!isObj(b)) return null;
  const rd = isObj(b.read) ? b.read : {};
  const sources = isObj(rd.sources) ? Object.fromEntries(LOG_SOURCES.map((s) => [s, srcStatus(rd.sources[s])]).filter(([, v]) => v)) : null;
  const bySrc = {};
  if (isObj(rd.bySrc)) for (const s of LOG_SOURCES) if (isObj(rd.bySrc[s])) bySrc[s] = { read: N(rd.bySrc[s].read), truncated: N(rd.bySrc[s].truncated), none: N(rd.bySrc[s].none),
    ...(rd.bySrc[s].wasRead === true ? { wasRead: true } : {}), ...(N(rd.bySrc[s].undated) != null ? { undated: N(rd.bySrc[s].undated) } : {}) };
  const sec = {};
  const S = isObj(b.security) ? b.security : {};
  for (const k of SECK) if (Array.isArray(S[k])) sec[k] = secList(S[k]);
  const patterns = (Array.isArray(b.patterns) ? b.patterns : []).slice(0, 300).filter(isObj).map((p) => {
    const sig = typeof p.sig === 'string' && SIG_RE.test(p.sig) ? p.sig : null;
    if (!sig) return null;
    const c = isObj(p.corr) ? p.corr : {};
    return {
      sig, cls: enumOr(p.cls, CLS, 'issue'), severity: enumOr(p.severity, SEV, 'info'), ruleId: RULES.has(p.ruleId) ? p.ruleId : '', title: txt(p.title, 120), grade: ['●', '◐', '○'].includes(p.grade) ? p.grade : null,
      evidence: (Array.isArray(p.evidence) ? p.evidence : []).slice(0, 6).filter((e) => typeof e === 'string' && Object.hasOwn(LOG_EVIDENCE, e)),
      src: enumOr(p.src, SRC, ''), unit: txt(p.unit, 64), tmpl: maskStoredTmpl(p.cls, txt(p.tmpl, 200)), count: N(p.count), total: N(p.total), first: ts(p.first, now), last: ts(p.last, now),
      samples: (Array.isArray(p.samples) ? p.samples : []).slice(-5).filter(isObj).map((x) => ({ ts: ts(x.ts, now), text: txt(x.text, 300) })),
      corr: {
        changes: (Array.isArray(c.changes) ? c.changes : []).slice(0, 3).filter(isObj).map((e) => ({ ts: ts(e.ts, now), kind: txt(e.kind, 24), item: txt(e.item, 96) })),
        focus: (Array.isArray(c.focus) ? c.focus : []).slice(0, 3).filter(isObj).map((x) => ({ id: txt(x.id, 40), start: ts(x.start, now), end: ts(x.end, now), status: txt(x.status, 16) })),
        ...(typeof c.playbook === 'string' && /^[a-z]{2,8}:[\w.-]{1,40}$/.test(c.playbook) ? { playbook: c.playbook } : {}),
        ...(typeof c.health === 'string' && /^[a-z]{2,8}$/.test(c.health) ? { health: c.health } : {}),
        ...(typeof c.cross === 'string' && /^[a-z-]{2,32}$/.test(c.cross) ? { cross: c.cross } : {}),
        ...(c.faults === true ? { faults: true } : {}),
      },
    };
  }).filter(Boolean);
  const hourly = (Array.isArray(b.hourly) ? b.hourly : []).slice(0, 200).filter(isObj).map((h) => ({ t: ts(h.t, now), fault: N(h.fault), perf: N(h.perf), sec: N(h.sec), issue: N(h.issue) })).filter((h) => h.t != null);
  const tw = isObj(S.totalsWhy) ? S.totalsWhy : {};
  const totalsWhy = {};
  for (const k of SEC_TOTAL_KEYS) {
    const w = tw[k];
    if (!isObj(w)) continue;
    const carriers = (Array.isArray(w.carriers) ? w.carriers : []).filter((c) => SRC.has(c)).slice(0, 4);
    totalsWhy[k] = { carriers, states: Object.fromEntries(carriers.map((c) => [c, enumOr(isObj(w.states) ? w.states[c] : null, STAT, null)])),
      scopes: Object.fromEntries(carriers.map((c) => [c, isObj(w.scopes) && PSCOPE.has(w.scopes[c]) ? w.scopes[c] : null]).filter(([, x]) => x)), ...(N(w.partial) != null ? { partial: N(w.partial) } : {}) };
  }
  const M = isObj(b.method) ? b.method : null;
  const cs = isObj(b.corrSource) ? b.corrSource : {};
  return {
    ok: b.ok === true, key: capStr(typeof b.key === 'string' ? b.key : '', 256), agent: txt(b.agent, 128), range: ['1h', '24h', '7d'].includes(b.range) ? b.range : '24h', from: ts(b.from, now), to: N(b.to),
    kpi: clsMap(b.kpi), classLabel: CLASS_LABEL, hourly,
    read: { lines: N(rd.lines), truncated: N(rd.truncated), none: N(rd.none), undated: N(rd.undated), bySrc, authSrc: AUTHSRC.has(rd.authSrc) ? rd.authSrc : null, at: ts(rd.at, now), lineCap: N(rd.lineCap), sources, ended: rd.ended === false ? false : rd.ended === true ? true : null,
      cut: typeof rd.cut === 'string' && /^[A-Z]{1,16}$/.test(rd.cut) ? rd.cut : null, ...(rd.cursorReset ? { cursorReset: 'corrupt' } : {}), ...(rd.corruptKept === true ? { corruptKept: true } : {}), ...(rd.never === true ? { never: true } : {}) },
    security: { ...sec, totals: isObj(S.totals) ? Object.fromEntries(SEC_TOTAL_KEYS.filter((k) => Object.hasOwn(S.totals, k)).map((k) => [k, N(S.totals[k])])) : {}, totalsWhy,
      bursts: (Array.isArray(S.bursts) ? S.bursts : []).slice(0, 16).filter(isObj).map((x) => ({ ip: txt(x.ip, 64), count: N(x.count), from: ts(x.from, now), to: ts(x.to, now) })),
      auditd: typeof S.auditd === 'string' && /^[a-z-]{1,16}$/.test(S.auditd) ? S.auditd : null, auditStatus: enumOr(S.auditStatus, STAT, null), secureStatus: enumOr(S.secureStatus, STAT, null) },
    patterns, patternsOmitted: N(b.patternsOmitted),
    // 규칙 카탈로그 · 근거는 중앙 자기 것(정적 — 엣지가 보낸 정규식 글자를 화면에 싣지 않는다 · 반증 F9: 엣지 대행 화면의 ‘규칙’ 표가 비었다)
    rules: logRuleCatalog(), rulesFrom: 'central', evidence: LOG_EVIDENCE,
    method: M ? {
      sections: (Array.isArray(M.sections) ? M.sections : []).filter((x) => typeof x === 'string' && LOG_SECTIONS.includes(x) && x !== 'END').slice(0, 12),
      lineCap: N(M.lineCap), keepDays: N(M.keepDays), burst: isObj(M.burst) ? { count: N(M.burst.count), windowMin: N(M.burst.windowMin) } : null, intervalMs: N(M.intervalMs),
      firstSinceMin: N(M.firstSinceMin), firstFileLines: N(M.firstFileLines), firstFileBytes: N(M.firstFileBytes), lineWidth: N(M.lineWidth), srcBytes: N(M.srcBytes), freshMin: N(M.freshMin),
      sources: (Array.isArray(M.sources) ? M.sources : []).filter((x) => SRC.has(x)).slice(0, 12),
      authIdents: (Array.isArray(M.authIdents) ? M.authIdents : []).filter((x) => AUTH_IDENTS.includes(x)).slice(0, 24),
      apps: (Array.isArray(M.apps) ? M.apps : []).filter((a) => isObj(a) && APP_IDS.has(a.id)).slice(0, 4).map((a) => ({ id: a.id,
        dirs: (Array.isArray(a.dirs) ? a.dirs : []).filter((d) => typeof d === 'string' && /^\/[\w./-]{1,160}$/.test(d)).slice(0, 8), glob: typeof a.glob === 'string' && /^[\w.*-]{1,40}$/.test(a.glob) ? a.glob : '' })),
    } : null,
    corrWindowMs: N(b.corrWindowMs), corrSource: { changes: N(cs.changes), focus: N(cs.focus) },
  };
}
/** 응답 모양 판정(명시 — 6단계 반증 F2: 기본 판정은 봉투 `{ok, node}` 다). */
export const logViewBodyOk = (b) => isObj(b) && b.ok === true && Array.isArray(b.patterns) && Array.isArray(b.hourly);
/** 엣지 위임 서버 1대의 로그 상세(보관 없음). */
export async function pullEdgeLogs(agent, { key, range = '24h' } = {}) {
  const qs = new URLSearchParams({ key: capStr(String(key), 256), range: ['1h', '24h', '7d'].includes(range) ? range : '24h' });
  const r = await pullFromEdge(agent, `/api/collector/bm-usage/logs?${qs.toString()}`, {
    timeoutMs: TIMEOUT_MS, retries: 1, minVersion: stage7aMinEdgeVersion(), what: '로그 분석을 읽을', label: '엣지 로그 분석 응답', bodyOk: logViewBodyOk,
    missing401: true,   // 경로가 없는 구버전 엣지는 사용자 인증 미들웨어로 떨어져 401 — 토큰이 아니라 버전 문제다(5 · 6단계와 같은 판정)
  });
  if (!r.ok) return { ok: false, kind: r.kind, reason: r.reason, ms: r.ms };
  const body = sanitizeLogView(r.body);
  return body && body.ok ? { ok: true, body, ms: r.ms } : { ok: false, kind: 'bad-body', reason: '엣지 응답 형식이 다릅니다.' };
}
