/**
 * focusmon/alerts.js — 서버 집중 모니터링 ‘지속 시간 조건 알림’(v3.16.0 ⑯ C1 — 시안 Alerts · 사용자 "기본값대로 모두 구현해줘").
 * 컨펌 기본값: ① 계속 수집 서버만(잠깐 보기는 알림 없음) ② 포탈의 기존 알람 · 메일 채널(alerts.enqueueNotify — 새 채널을 만들지 않는다)
 * ③ 규칙 쓰기 = 관리자 · 전체 쓰기 범위 · 감사 · 정비 창 동안은 억제 ④ 판정 — 중앙이 받은 표본으로(엣지는 이미 표본을 몇 초마다 올린다 ·
 *   엣지가 끊겨 표본이 없으면 '판정 보류' — 기본값의 '맡은 노드가 판정' 과 다르다: 같은 표본으로 같은 결과 · 엣지에 규칙을 내려보내는 새 계약을 만들지 않으려고).
 *
 *  · 규칙 = 지표 · 문턱 · 지속(분) · 대상(계속 수집 전체 | 그룹 | 서버 하나) · 심각도. 판정 코어는 `judge` 하나(순수 — 시험이 고정).
 *  · 발생 = 지속 시간 내내 문턱을 넘었다(구간을 표본이 덮었을 때만) · 해제 = 문턱보다 조금 낮은(여유 5%) 값이 같은 시간 이어졌다(오르내림마다 알림이 반복되지 않게).
 *  · 값을 못 읽은 동안(표본이 없다 · 오래됐다 · 그 지표가 null)은 정상도 발생도 아닌 **판정 보류** — 수집 끊김을 '해제' 로 알리지 않는다.
 *  · 상태는 파일에 남긴다(재시작마다 전 서버가 '새 발생' 이 되어 알림이 폭주하지 않게 — bmusage/notify.js 와 같은 이유).
 *  · 데모(목) 모드에서는 실제 채널로 보내지 않는다(기록만).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js';
import { registerStateFile } from '../util/stateFiles.js';
import { numOrNull } from '../util/numOrNull.js';

export const RULES_FILE = 'focusmon-alert-rules.json';
export const STATE_FILE = registerStateFile('focusmon-alert-state.json');
export const MAX_RULES = 50;
export const DUR_CHOICES = Object.freeze([1, 2, 5, 10, 15, 30]);
export const SEVERITIES = Object.freeze(['warn', 'crit']);
export const SCOPE_KINDS = Object.freeze(['record', 'group', 'server']);
export const RESOLVE_MARGIN = 0.05; // 해제 여유 — 문턱보다 5% 낮은(앱 수는 높은) 값이 같은 시간
export const HOLD_AFTER_MS = 60_000; // 마지막 표본이 이보다 오래되면 판정 보류
const n = numOrNull;

/**
 * 지표(시안 '규칙 만들기' 의 목록). col = 1분 묶음 열 · op = 넘음(ge) | 밑돎(lt — 필수 앱 프로세스 수) · range = 문턱 범위.
 * app 은 프로세스 표본의 앱 묶음(⑮ — 서비스 기준)에서 그 서비스의 프로세스 수.
 */
export const METRICS = Object.freeze({
  cpu: { label: 'CPU 사용률', unit: '%', col: 'c.pct', op: 'ge', range: [1, 100] },
  iow: { label: 'I/O 대기(iowait)', unit: '%', col: 'c.iow', op: 'ge', range: [1, 100] },
  mem: { label: '메모리 사용률', unit: '%', col: 'm.pct', op: 'ge', range: [1, 100] },
  disk: { label: '디스크 사용률(%util — 가장 바쁜)', unit: '%', col: 's.disk', op: 'ge', range: [1, 100] },
  wa: { label: '디스크 쓰기 지연', unit: 'ms', col: 's.wa', op: 'ge', range: [1, 100_000] },
  fs: { label: '파일시스템 사용률(가장 높은)', unit: '%', col: 's.fs', op: 'ge', range: [1, 100] },
  rt: { label: 'TCP 재전송률', unit: '%', col: 'p.rt', op: 'ge', range: [0.1, 100] },
  procD: { label: 'D 상태 프로세스 수', unit: '개', col: 'q.D', op: 'ge', range: [1, 100_000] },
  swap: { label: '스왑 입출력(들어옴 + 나감)', unit: '페이지/s', cols: ['v.si', 'v.so'], op: 'ge', range: [1, 10_000_000] },
  app: { label: '필수 앱 프로세스 수(서비스)', unit: '개', op: 'lt', range: [1, 10_000] },
});
export const METRIC_KEYS = Object.freeze(Object.keys(METRICS));
const APP_RE = /^(?!.*\.\.)[A-Za-z0-9@_:-][A-Za-z0-9@._:-]{0,95}\.(service|scope)$/;
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,60}$/; // eslint-disable-line no-control-regex
const GROUP_RE = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._ -]{0,31}$/;

/** 규칙 정제(쓰기 · 읽기 공통). 잘못이면 { ok:false, code, reason } — 쓰기는 거절, 읽기는 그 규칙을 버린다. */
export function normalizeRule(r, { id = null, by = '', now = Date.now() } = {}) {
  if (!r || typeof r !== 'object') return { ok: false, code: 'bad-rule', reason: '규칙 모양이 아닙니다.' };
  const name = String(r.name ?? '').trim();
  if (!NAME_RE.test(name)) return { ok: false, code: 'bad-name', reason: '이름은 1~60자입니다(제어 글자 제외).' };
  const metric = String(r.metric ?? '');
  const M = METRICS[metric];
  if (!M) return { ok: false, code: 'bad-metric', reason: '모르는 지표입니다.' };
  const th = n(r.threshold);
  if (th == null || th < M.range[0] || th > M.range[1]) return { ok: false, code: 'bad-threshold', reason: `문턱은 ${M.range[0]} ~ ${M.range[1]} 입니다.` };
  const dur = Number(r.durMin);
  if (!DUR_CHOICES.includes(dur)) return { ok: false, code: 'bad-dur', reason: `지속은 ${DUR_CHOICES.join(' · ')}분 중 하나입니다.` };
  const sev = SEVERITIES.includes(r.severity) ? r.severity : null;
  if (!sev) return { ok: false, code: 'bad-severity', reason: '심각도는 주의 · 위험입니다.' };
  const sc = r.scope && typeof r.scope === 'object' ? r.scope : {};
  const kind = SCOPE_KINDS.includes(sc.kind) ? sc.kind : null;
  if (!kind) return { ok: false, code: 'bad-scope', reason: '대상은 계속 수집 전체 · 그룹 · 서버 하나입니다.' };
  const scope = { kind };
  if (kind === 'group') { const g = String(sc.group ?? '').trim(); if (!GROUP_RE.test(g)) return { ok: false, code: 'bad-scope', reason: '그룹 이름이 올바르지 않습니다.' }; scope.group = g; }
  if (kind === 'server') { const t = String(sc.target ?? ''); if (!/^fm-[a-f0-9]{8,16}$/.test(t)) return { ok: false, code: 'bad-scope', reason: '서버를 고르세요.' }; scope.target = t; }
  let app = null;
  if (metric === 'app') { app = String(r.app ?? '').trim(); if (!APP_RE.test(app)) return { ok: false, code: 'bad-app', reason: '필수 앱은 서비스 이름(…service · …scope)입니다.' }; }
  const rid = id || (typeof r.id === 'string' && /^ar-[0-9a-f]{12}$/.test(r.id) ? r.id : `ar-${crypto.randomBytes(6).toString('hex')}`);
  return { ok: true, rule: { id: rid, name, metric, threshold: th, durMin: dur, severity: sev, scope, ...(app ? { app } : {}), enabled: r.enabled !== false,
    createdBy: String(r.createdBy ?? by ?? '').slice(0, 64), createdAt: Number(r.createdAt) > 0 ? Number(r.createdAt) : now, updatedAt: now } };
}

/* ── 규칙 저장(원자 쓰기 · 손상 보존 — 손상이면 쓰기 거절) ─────────────────── */
let rulesCache = null;
const loadErr = makeLoadError();
const rulesPath = () => path.join(config.configDir, RULES_FILE);
export function rulesLoadError() { loadRules(); return loadErr.get(); }
export function loadRules() {
  if (rulesCache) return rulesCache;
  loadErr.clear();
  let raw = null;
  try { raw = fs.readFileSync(rulesPath(), 'utf8'); } catch (e) { if (e?.code !== 'ENOENT') loadErr.set(e); rulesCache = []; return rulesCache; }
  try {
    const j = JSON.parse(raw);
    const list = Array.isArray(j?.rules) ? j.rules : [];
    rulesCache = list.map((r) => normalizeRule(r, { id: typeof r?.id === 'string' && /^ar-[0-9a-f]{12}$/.test(r.id) ? r.id : null, now: Number(r?.updatedAt) || Date.now() }))
      .filter((x) => x.ok).map((x) => ({ ...x.rule, updatedAt: x.rule.updatedAt })).slice(0, MAX_RULES);
  } catch (e) { preserveCorrupt(rulesPath()); loadErr.set(e); rulesCache = []; }
  return rulesCache;
}
function saveRules(list) {
  atomicWriteFileSync(rulesPath(), `${JSON.stringify({ rules: list }, null, 1)}\n`);
  try { fs.chmodSync(rulesPath(), 0o600); } catch { /* */ }
  rulesCache = list;
}
/** 규칙 쓰기 — op = create | update | delete. 등록부 손상이면 거절(빈 목록으로 덮지 않는다). */
export function writeRule(op, input, { by = '', now = Date.now() } = {}) {
  const list = loadRules();
  if (loadErr.get()) return { ok: false, code: 'rules-unreadable', reason: '알림 규칙 파일을 읽지 못했습니다 — 손상 보존본을 확인하세요.' };
  if (op === 'delete') {
    const i = list.findIndex((r) => r.id === input?.id);
    if (i < 0) return { ok: false, code: 'not-found', reason: '없는 규칙입니다.' };
    const gone = list[i];
    saveRules(list.filter((_, k) => k !== i));
    forgetRuleState(gone.id);
    return { ok: true, rule: gone };
  }
  if (op === 'update') {
    const i = list.findIndex((r) => r.id === input?.id);
    if (i < 0) return { ok: false, code: 'not-found', reason: '없는 규칙입니다.' };
    const r = normalizeRule({ ...list[i], ...input, createdBy: list[i].createdBy, createdAt: list[i].createdAt }, { id: list[i].id, now });
    if (!r.ok) return r;
    const next = list.slice(); next[i] = r.rule;
    saveRules(next);
    // 조건이 바뀌면 그 규칙의 상태를 지운다(옛 조건의 발생을 새 조건으로 해제하지 않게 — 다음 판정부터 새로)
    const a = list[i]; if (a.metric !== r.rule.metric || a.threshold !== r.rule.threshold || a.durMin !== r.rule.durMin || JSON.stringify(a.scope) !== JSON.stringify(r.rule.scope) || a.app !== r.rule.app) forgetRuleState(a.id);
    return { ok: true, rule: r.rule };
  }
  if (list.length >= MAX_RULES) return { ok: false, code: 'too-many', reason: `규칙은 ${MAX_RULES}개까지입니다.` };
  const r = normalizeRule(input, { by, now });
  if (!r.ok) return r;
  saveRules([...list, r.rule]);
  return { ok: true, rule: r.rule };
}

/* ── 판정 코어(순수) ───────────────────────────────────────────────────── */
/**
 * 한 (규칙, 서버)의 다음 상태.
 * @param {Array<[number, number|null]>} pts  [시각, 값] 시각 순 — 지속 구간과 그 앞을 덮는 표본(값 null = 못 읽음)
 * @param {{op, threshold, durMin}} rule
 * @param {{state, since}} prev  'ok' | 'firing' | 'hold' (없으면 ok)
 * @returns {{state, since, event: null|'fire'|'resolve'|'hold'|'unhold', value}}
 */
export function judge(pts, rule, prev = null, now = Date.now(), { holdAfterMs = HOLD_AFTER_MS } = {}) {
  const st = prev?.state || 'ok';
  const durMs = rule.durMin * 60_000;
  const last = pts.length ? pts[pts.length - 1] : null;
  const lastVal = last ? last[1] : null;
  // 보류 — 표본이 없거나 오래됐거나 지금 값을 못 읽었다
  if (!last || now - last[0] > holdAfterMs || lastVal == null) {
    if (st === 'hold') return { state: 'hold', since: prev.since, event: null, value: null, was: prev.was };
    return { state: 'hold', since: now, event: 'hold', value: null, was: st };
  }
  const from = now - durMs;
  const win = pts.filter(([t]) => t >= from);
  // 구간을 표본이 덮었는가 — 첫 표본이 구간 시작 근처(지속의 10% 또는 30초 안)에 있고, 사이에 큰 틈(60초 넘게)이 없다
  const covered = win.length > 0 && win[0][0] - from <= Math.max(30_000, durMs * 0.1) && win.every(([t], i) => i === 0 || t - win[i - 1][0] <= 60_000);
  const over = (v) => v != null && (rule.op === 'lt' ? v < rule.threshold : v >= rule.threshold);
  const calm = (v) => v != null && (rule.op === 'lt' ? v >= rule.threshold * (1 + RESOLVE_MARGIN) || v >= rule.threshold + 1 : v < rule.threshold * (1 - RESOLVE_MARGIN));
  const base = st === 'hold' ? (prev?.was || 'ok') : st; // 보류에서 돌아오면 보류 전 상태에서 이어서(보류를 해제로 치지 않는다)
  if (base === 'firing') {
    if (covered && win.every(([, v]) => calm(v))) return { state: 'ok', since: now, event: 'resolve', value: lastVal };
    return { state: 'firing', since: st === 'hold' ? prev?.firedAt ?? now : prev?.since ?? now, event: st === 'hold' ? 'unhold' : null, value: lastVal, firedAt: prev?.firedAt ?? prev?.since ?? now };
  }
  if (covered && win.every(([, v]) => over(v))) return { state: 'firing', since: now, event: 'fire', value: lastVal, firedAt: now };
  return { state: 'ok', since: st === 'ok' ? prev?.since ?? now : now, event: st === 'hold' ? 'unhold' : null, value: lastVal };
}

/**
 * ‘지난 24시간에 걸었다면’(추정 — 시안 C1 미리 보기). 1분 요약 평균(칸마다 하나)을 같은 규칙으로 흘려 발생했을 구간을 센다.
 * 요약이 없는 분은 빼고 센다(그 분에서 이어짐이 끊긴다 — 0 이 아니다).
 * @param {Array<[number, number|null]>} mins  [분 시작 시각, 평균] 시각 순
 */
export function preview(mins, rule) {
  const out = []; let run = 0; let fireStart = null; let calmRun = 0; let firing = false; let covered = 0;
  const over = (v) => (rule.op === 'lt' ? v < rule.threshold : v >= rule.threshold);
  const calm = (v) => (rule.op === 'lt' ? v >= rule.threshold * (1 + RESOLVE_MARGIN) || v >= rule.threshold + 1 : v < rule.threshold * (1 - RESOLVE_MARGIN));
  let prevT = null;
  for (const [t, v] of mins) {
    const gap = prevT != null && t - prevT > 60_000;
    prevT = t;
    if (v == null) { run = 0; calmRun = 0; continue; }
    covered += 1;
    if (gap) { run = 0; calmRun = 0; }
    if (!firing) {
      run = over(v) ? run + 1 : 0;
      if (run >= rule.durMin) { firing = true; fireStart = t - (rule.durMin - 1) * 60_000; calmRun = 0; }
    } else {
      calmRun = calm(v) ? calmRun + 1 : 0;
      if (calmRun >= rule.durMin) { out.push([fireStart, t + 60_000]); firing = false; run = 0; }
    }
  }
  if (firing) out.push([fireStart, null]);
  return { intervals: out, count: out.length, coveredMin: covered };
}

/* ── 상태(파일) ─────────────────────────────────────────────────────────── */
let stateCache = null;
const statePath = () => path.join(config.configDir, STATE_FILE);
export function loadState() {
  if (stateCache) return stateCache;
  try { const j = JSON.parse(fs.readFileSync(statePath(), 'utf8')); stateCache = j && typeof j.s === 'object' && !Array.isArray(j.s) ? j.s : {}; } catch { stateCache = {}; } // 재생성 가능한 캐시(손상이면 빈 상태 — 한 주기 늦게 알릴 뿐)
  return stateCache;
}
export function saveState(next) {
  stateCache = next;
  try { atomicWriteFileSync(statePath(), `${JSON.stringify({ s: next, at: Date.now() })}\n`); fs.chmodSync(statePath(), 0o600); } catch { /* best effort */ }
}
function forgetRuleState(ruleId) {
  const s = loadState(); let changed = false;
  for (const k of Object.keys(s)) if (k.startsWith(`${ruleId}|`)) { delete s[k]; changed = true; }
  if (changed) saveState(s);
}
export function _resetForTest() { rulesCache = null; stateCache = null; loadErr.clear(); }

/* ── 판정 주기(중앙만 — 서비스 1분 틱) ─────────────────────────────────── */
export const MAX_SEND = 20; // 주기당 보내는 상한(넘친 것은 다음 주기 — 잘린 수를 상태에 남긴다)
const isEdgeNode = () => !!String(process.env.CENTRAL_URL || '').trim();
const fmtVal = (m, v) => (v == null ? '—' : `${Math.round(v * 10) / 10}${METRICS[m].unit === '%' ? '%' : ` ${METRICS[m].unit}`}`);
const condText = (r) => `${METRICS[r.metric].label}${r.app ? `(${r.app})` : ''} ${METRICS[r.metric].op === 'lt' ? '<' : '≥'} ${fmtVal(r.metric, r.threshold)} · ${r.durMin}분`;
export { condText };

/** 규칙이 덮는 서버(계속 수집 중인 것만 — 컨펌 ①). */
export function ruleTargets(rule, targets, recordIds) {
  return targets.filter((t) => recordIds.has(t.id) && (rule.scope.kind === 'record' || (rule.scope.kind === 'group' && String(t.group || '').toLowerCase() === rule.scope.group.toLowerCase()) || (rule.scope.kind === 'server' && t.id === rule.scope.target)));
}

/** 서버 하나의 [시각, 값] — 메모리의 최근 묶음(31분)에서. app 은 프로세스 표본의 앱 묶음(서비스 기준). */
export function pointsFor(store, rule, id, now) {
  const from = now - rule.durMin * 60_000 - 120_000;
  const out = [];
  if (rule.metric === 'app') {
    for (const [, list] of store.memProcs(id)) for (const s of list) {
      if (!(s.t >= from) || !s.apps) continue;
      if (!Array.isArray(s.apps.sv)) { out.push([s.t, null]); continue; } // 서비스 지도 없음 — 모름
      const a = s.apps.sv.find((x) => x.k === rule.app);
      // 상위 20 에 없으면: 그 서비스의 프로세스가 0 이거나(죽음) 상위 밖(아주 조용함) — 목록이 20개 미만이면 0 으로 확정, 꽉 찼으면 모름
      out.push([s.t, a ? a.n : (s.apps.sv.length < 20 ? 0 : null)]);
    }
    return out.sort((x, y) => x[0] - y[0]);
  }
  const M = METRICS[rule.metric];
  for (const b of store.memBlocks(id)) {
    if ((b.minute + 1) * 60_000 < from) continue;
    const get = (k, i) => { const a = b.cols.get(k); const v = a ? a[i] : null; return v == null || Number.isNaN(v) ? null : v; };
    for (let i = 0; i < b.ts.length; i++) {
      const t = b.ts[i]; if (t < from) continue;
      let v;
      if (M.cols) { const xs = M.cols.map((k) => get(k, i)); v = xs.some((x) => x == null) ? null : xs.reduce((a, x) => a + x, 0); } else v = get(M.col, i);
      out.push([t, v]);
    }
  }
  return out;
}

/**
 * 한 주기 — 모든 켜진 규칙 × 덮는 서버. 사건(fm_event 'alert')을 남기고, 정비 창이 아니면 포탈 알람 · 메일로 보낸다(목 모드는 보내지 않는다).
 * @param {{store, targets, recordIds, send, maintState, mock, now}} o  send(alert) → Promise · maintState(target) → {scopes:{alerts}} | null
 */
let lastCycleAt = null;
/** 마지막 판정 시각(화면 — 기동 직후 '판정 전' 을 '덮는 서버 없음' 과 가른다). */
export function lastCycle() { return lastCycleAt; }
export async function alertCycle({ store, targets = [], recordIds = new Set(), send = null, maintState = null, mock = false, now = Date.now() } = {}) {
  if (isEdgeNode()) return { skipped: 'edge' };
  lastCycleAt = now;
  const rules = loadRules().filter((r) => r.enabled);
  const prev = loadState();
  const next = {};
  const fires = [];
  for (const r of rules) {
    for (const t of ruleTargets(r, targets, recordIds)) {
      const key = `${r.id}|${t.id}`;
      const j = judge(pointsFor(store, r, t.id, now), { ...r, op: METRICS[r.metric].op }, prev[key] || null, now);
      next[key] = { state: j.state, since: j.since, ...(j.firedAt ? { firedAt: j.firedAt } : {}), ...(j.state === 'hold' ? { was: j.was ?? prev[key]?.was ?? 'ok' } : {}), value: j.value, at: now };
      if (j.event === 'fire' || j.event === 'resolve' || j.event === 'hold') fires.push({ r, t, j });
    }
  }
  // 덮지 않게 된(규칙을 끄거나 수집이 끝난) 짝은 상태에서 뺀다 — 다시 덮이면 '새로' 판정한다
  saveState(next);
  let sent = 0; let suppressed = 0; let cut = 0;
  for (const { r, t, j } of fires) {
    const kindText = j.event === 'fire' ? '발생' : j.event === 'resolve' ? '해제' : '판정 보류';
    const text = `${r.name} — ${condText(r)} · ${kindText}${j.value != null ? ` · 값 ${fmtVal(r.metric, j.value)}` : ' · 값을 못 읽음(수집 끊김 · 엣지 응답 없음)'}`;
    store.queueEvent(t.id, 'alert', text.slice(0, 300), now, { id: `al:${r.id}:${j.event}:${now}`, scope: 'server' });
    if (j.event === 'hold') continue; // 보류는 기록만(알림으로 보내지 않는다 — 수집 끊김은 수집 화면이 말한다)
    const ms = maintState ? maintState(t) : null;
    if (ms?.scopes?.alerts) { suppressed += 1; continue; }
    if (mock || !send) continue;
    if (sent >= MAX_SEND) { cut += 1; continue; }
    sent += 1;
    const sev = r.severity === 'crit' ? 'critical' : 'warning';
    try {
      await send({ key: `focusmon:${r.id}:${t.id}:${j.event}`, severity: j.event === 'resolve' ? 'info' : sev,
        title: `${j.event === 'resolve' ? '[해제] ' : ''}${t.name} — ${r.name}`.slice(0, 180),
        detail: `${condText(r)}${j.value != null ? ` · 지금 ${fmtVal(r.metric, j.value)}` : ''} · 서버 집중 모니터링 › 알림에서 확인하세요.` });
    } catch { /* 발송 실패는 alerts 대기열이 센다 */ }
  }
  return { rules: rules.length, fires: fires.length, sent, suppressed, cut };
}
