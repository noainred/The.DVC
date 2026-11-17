/**
 * bmusage/maint/runtime.js — 정비 창 판정의 **노드 실행 면**(8a단계): 판정기 만들기 · 억제 계수 · ‘창 끝 뒤 억제’ 점검.
 *
 * 판정은 judge.js 하나(순수)이고 여기는 입력을 모은다:
 *   · 창 = store.windowsForJudge(이 노드의 창 + 신선한 중앙 배포본)
 *   · 태그 = 이 노드의 수동 용도 태그(insights/fleetTags purposes — role · apps). 엣지는 중앙 태그가 없어 배포본의 펼친 keys 로 맞춘다.
 * 억제 계수(창마다 — 화면 ‘억제 알림 n · 창 뒤 발송 n’)는 이 노드 메모리 + 상태 파일(`maintenance-stats.json` — 원자 쓰기 · 손상 보존 · 손상이면 0 부터 · 그 사실을 표지로).
 * ⚠⚠ ‘창 끝 뒤 억제 0’ 점검(설계 안전장치 — 반증 F8 로 다시 짰다): 억제를 적용할 때마다 근거(**창마다** 창 id · 그 창 발생의 시작 since · 끝 until —
 *   judge.scopeOccOf · 점검 반복 3회차 D3)를 기록하고,
 *   **판정과 독립된 단순 기준**으로만 본다 — ① 적용 시각이 그 발생의 끝(until) 뒤 ② 발생 길이(until − since)가 창 꼴의 상한(일회 24h · 반복 12h) 초과
 *   ③ **캐시 없이 다시 읽은 파일**(store.windowFactsNoCache — 정규화 · 판정을 거치지 않는다)에서 그 창이 적용 시각 전에 지워졌거나 · 끝냈거나 · 재확인이 만료됐거나 ·
 *   배포본이면 받은 지 24시간이 지났음. 대상을 다시 판정하지 않는다(엣지 서버의 법인 창 보류 같은 정당한 보류를 결함으로 세지 않는다).
 *   ⚠ 정직 기록: 이 점검은 **창 변경 · 시한**을 잡고 **판정 규칙 자체의 결함**(예: 대상을 너무 넓게 맞춤)은 잡지 못한다 — 그것은 시험이 고정한다.
 * 계수 · 점검 결과는 bmusage 폴러 주기와 **파트 장애 폴러 주기(중앙)** 끝에 저장한다(로컬 대상 0대인 중앙에서도 남게).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync } from '../../util/atomicWrite.js';
import { makeJsonFileReader } from '../../util/jsonFileLoad.js';
import { parseJsonObject } from '../../util/jsonObject.js';
import { maintStateFor, coverIntervals, scopeOccOf, activeOccurrence, SCOPES, RECUR_CONFIRM_DAYS } from './judge.js';
import { windowsForJudge, windowFactsNoCache, DEPLOY_TTL_MS } from './store.js';
import { maxMinOf, MIN, DAY } from './schedule.js';

const STATS_FILE = () => path.join(config.configDir, 'maintenance-stats.json');
const STATS_MAX = 2_000;
const t = (v) => String(v ?? '').trim();

/**
 * 이 노드의 대상 목록 공급자 — bmusage/poller.js 가 모듈을 읽을 때 등록한다(정적 import 의 역방향을 만들지 않는다 — 파트 장애 · 대행 라우트가
 *   폴러를 import 하면 bmusage ↔ idrac ↔ partfault 순환(SCC)이 생긴다: arch2579 ②-b). 등록 전이면 빈 목록(모르는 대상은 억제하지 않는다).
 */
let _targetsProvider = null;
export function setLocalTargetsProvider(fn) { _targetsProvider = typeof fn === 'function' ? fn : null; }
export async function localTargets() {
  if (!_targetsProvider) return [];
  try { return (await _targetsProvider())?.targets || []; } catch { return []; }
}

/** 이 노드의 수동 용도 태그 → ['role:<역할>', 'app:<용도>' …](없으면 []). 키 규칙은 bmusage/purposeKey.js 하나(서비스태그 키 · 아니면 (법인, 키) 쌍 → 예전 키 — 반증 F2). */
export async function tagsReader() {
  let FT = null; let PK = null;
  try { FT = await import('../../insights/fleetTags.js'); PK = await import('../purposeKey.js'); } catch { FT = null; }
  return (target) => {
    if (!FT || !PK || !target) return [];
    let p = null;
    try { p = PK.purposeOfTargetSync((k) => FT.fleetPurposeOf(k), target, t(target.key)); } catch { p = null; }
    if (!p) return [];
    return [...(p.role ? [`role:${String(p.role).toLowerCase()}`] : []), ...(Array.isArray(p.apps) ? p.apps.map((a) => `app:${String(a).toLowerCase()}`) : [])];
  };
}

/**
 * 판정기 — 한 주기 · 한 요청에 한 번 만든다(서버마다 파일을 다시 읽지 않게).
 * @returns {Promise<{ stateFor:(target)=>object, cover:(target,from,to,scope?)=>Array, windows:Array, meta:object }>}
 */
export async function maintJudge({ now = Date.now(), windowsOf = windowsForJudge, tagsOf = null } = {}) {
  const w = windowsOf(now);
  const tg = tagsOf || await tagsReader();
  // 점검 반복 5회차 D4: 창의 발생은 대상과 무관하다 — 같은 시각(at)에는 창마다 activeOccurrence 를 한 번만 센다(대상 1,000대 × 창 90개 전수가 같은 발생을 다시 셌다).
  //   시각이 바뀌면 비운다(최근 한 시각만 — 기억이 쌓이지 않게). 판정기의 창 목록은 이 판정기 동안 그대로다.
  let memoAt = null; let memo = null;
  const occOf = (win, at) => {
    if (memoAt !== at) { memoAt = at; memo = new Map(); }
    if (!memo.has(win)) memo.set(win, activeOccurrence(win, at));
    return memo.get(win);
  };
  return {
    windows: w.windows,
    meta: { localUnreadable: !!w.localUnreadable, deployed: w.deployed, n: w.windows.filter((x) => !x.deleted && !x.history).length },
    stateFor: (target, at = now) => maintStateFor(w.windows, target, at, { tagsOf: tg, occOf }),
    /** 구간(합집합 · 지운 창은 지운 시각까지). only(w) — 이 계정에 보이는 창만 같은 거르기. */
    cover: (target, from, to, scope = null, { only = null } = {}) => coverIntervals(w.windows, target, from, to, { scope, tagsOf: tg, only }),
  };
}

/**
 * ⑤ 제외 구간 공급자 — 베이스라인 롤업 · 용량 예측이 쓴다. targetOf(key) → 대상(법인 · 태그 판정용 — 없으면 키만).
 *   sig = 창 세대(id:rev · 끝내기 · 지우기) — 메모(베이스라인 슬롯 · 띠)가 지난 창으로 남지 않게 키에 넣는다.
 */
export function exclusionFor(judge, targetOf = () => null) {
  const sig = judge ? judge.windows.filter((w) => w.scopes?.exclude).map((w) => `${w.id}:${w.rev}:${w.endedAt || ''}:${w.origin || ''}`).sort().join(',') : '';
  return {
    sig: sig.length > 200 ? `${sig.length}:${sig.slice(0, 64)}:${sig.slice(-64)}` : sig,
    exclOf: (key, from, to) => (judge ? judge.cover(targetOf(key) || { key }, from, to, 'exclude') : []),
  };
}

/* ── 억제 계수 · 점검 ─────────────────────────────────────────────── */
let _stats = null;   // { v, byWindow: { id: { alerts, after, hold, focus, collect, collectFail, at } }, leak: { n, last, at } , unreadable? }
let _cycle = [];     // 이번 주기에 적용한 억제 [{ scope, key, until, since, at, windowIds }]
/** 파일 글 → 계수 상태(형식 검사 포함 — 던지면 손상: jsonFileLoad 가 보존본으로 옮긴다). */
function parseStats(text) {
  const o = parseJsonObject(text);
  const bw = {};
  for (const [id, x] of Object.entries(o.byWindow && typeof o.byWindow === 'object' ? o.byWindow : {}).slice(0, STATS_MAX)) {
    if (!/^mw-[a-z0-9]{6,32}$/.test(id) || !x || typeof x !== 'object') continue;
    bw[id] = Object.fromEntries(['alerts', 'after', 'hold', 'focus', 'collect', 'collectFail', 'at'].map((k) => [k, Number.isFinite(Number(x[k])) ? Number(x[k]) : 0]));
  }
  const lk = o.leak && typeof o.leak === 'object' ? o.leak : {};
  // 점검 묶음별 결과(7회차 C1 — leakBy: 'cycle' · 'hold'). 없으면(옛 파일) 합친 값 하나만 있는 것으로 본다.
  const by = {};
  for (const [g, x] of Object.entries(o.leakBy && typeof o.leakBy === 'object' ? o.leakBy : {}).slice(0, 8)) {
    if (!AUDIT_GROUPS.includes(g) || !x || typeof x !== 'object' || !Number(x.at)) continue;
    by[g] = { n: Number(x.n) || 0, last: Number(x.last) || 0, at: Number(x.at) || 0 };
  }
  // 점검한 적이 없으면 n 은 null(‘0 = 정상’ 이 아니다 — 화면은 ‘아직 점검한 주기가 없습니다’)
  return { v: 1, byWindow: bw, leakBy: by, leak: { n: Number(lk.at) ? (Number(lk.n) || 0) : null, last: Number(lk.last) || 0, at: Number(lk.at) || 0 } };
}
/**
 * 77회차 F5(재현): 읽기 오류(EACCES · EIO · EISDIR)는 손상이 아니다 — 예전에는 catch 하나로 받아 원본을 보존본으로 옮기고 0 부터 세어 다음 저장이 0 으로 덮었다.
 *   판정은 공용 util/jsonFileLoad.js: 읽기 오류면 원본을 옮기지도 **덮지도 않고**(saveStats 건너뜀) 메모리 계수로 돌며 30초 간격으로 다시 읽는다 — 읽히면 파일 값으로 돌아간다
 *   (그동안 메모리에 센 것은 버린다 — 계수 · 점검 결과일 뿐이고, 원본을 0 으로 덮는 것보다 낫다). 손상은 예전과 같다(보존 + 0 부터 · unreadable 표지).
 */
const _statsReader = makeJsonFileReader(STATS_FILE, { tag: 'maintenance-stats', parse: parseStats });
let _statsReadErr = false;
function loadStats() {
  if (_stats && !_statsReadErr) return _stats;
  const r = _statsReader.read();
  if (r.kind === 'read-error') {
    if (!_stats) _stats = { v: 1, byWindow: {}, leak: { n: null, last: 0, at: 0 }, unreadable: Date.now(), readError: true };
    _statsReadErr = true;
    return _stats;
  }
  _statsReadErr = false;
  if (r.kind === 'ok') _stats = r.value;
  else if (r.kind === 'missing') _stats = { v: 1, byWindow: {}, leak: { n: null, last: 0, at: 0 } };
  else _stats = { v: 1, byWindow: {}, leak: { n: null, last: 0, at: 0 }, unreadable: Date.now() };
  return _stats;
}
/** 억제 한 건을 센다(창마다). kind: alerts(발송 막음) · after(창 뒤 1회 발송) · hold(전이 보류) · focus(자동 집중 막음) · collect(수집 건너뜀) · collectFail(창 안 수집 실패). */
export function countSuppression(kind, windowIds = [], { now = Date.now() } = {}) {
  const st = loadStats();
  for (const id of [...new Set((windowIds || []).map(t))].filter(Boolean)) {
    const c = (st.byWindow[id] ||= { alerts: 0, after: 0, hold: 0, focus: 0, collect: 0, collectFail: 0, at: 0 });
    c[kind] = (Number(c[kind]) || 0) + 1; c.at = now;
  }
}
/**
 * 억제를 적용했다는 기록(점검용) — 시한(until — 그 범위의 억제 끝) · 적용 시각 · **창마다의 발생 occ**(judge.scopeOccOf — 창 id · 그 창 발생의 시작 · 끝).
 *   ⚠ 점검 반복 3회차 D3: occ 없이 since(창들 시작의 최소)와 until(끝의 최대)을 한 쌍으로 보면 겹친 창 둘(12h 반복 + 10h 일회)이 20시간 발생으로 보여 거짓 over-cap 이었다.
 *   occ 를 주지 않은 호출(옛 꼴)은 windowIds 마다 since · until 을 그대로 쓴다.
 */
export function noteApplied(scope, key, until, windowIds = [], at = Date.now(), { since = null, occ = null } = {}) {
  if (_cycle.length >= 20_000) return;
  const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const o = Array.isArray(occ) ? occ.filter((x) => x && t(x.id)).slice(0, 8).map((x) => ({ id: t(x.id), since: num(x.since), until: num(x.until) })) : null;
  _cycle.push({ scope, key: t(key), until: Number(until), since: num(since), at, windowIds: o ? o.map((x) => x.id) : (windowIds || []).slice(0, 8), ...(o ? { occ: o } : {}) });
}
/** 판정 결과(maintStateFor)에서 그 범위의 발생 시작(최소). 랙 교집합(perfAlerts.groupMaintState)의 시작을 정할 때 쓴다 — 점검 기록은 scopeOccOf(창마다). */
export const sinceOf = (ms, scope) => { const s = (ms?.windows || []).filter((w) => (w.scopes || []).includes(scope)).map((w) => Number(w.start)).filter(Number.isFinite); return s.length ? Math.min(...s) : null; };
/** 창마다의 발생 — judge.scopeOccOf 그대로(호출처가 judge 를 따로 import 하지 않게 다시 내보낸다 · 판정 코어 하나). */
export { scopeOccOf };
/**
 * 적용 기록 하나가 ‘창 끝 뒤 억제’ 인가(순수 — 판정과 독립된 단순 기준 · 머리말 ①~③). facts = windowFactsNoCache().byId.
 *   창마다 **그 창 발생의** 시작 · 끝으로 본다(occ — 3회차 D3). ① 적용 시각이 억제 끝(until — 그 범위를 켠 창들 끝의 최대) 뒤 ② 그 창 발생 길이가 그 창 꼴의 상한 초과
 *   ③ 파일 사실(지움 · 끝냄(그 창 발생의 시작으로 맞춘다) · 재확인 만료 · 배포본 시한).
 * @returns {string|null} 사유(leak) 또는 null
 */
export function leakReason(x, facts = new Map()) {
  if (!(Number.isFinite(x?.until) && x.at < x.until)) return 'after-end';
  const occ = Array.isArray(x.occ) ? x.occ : (x.windowIds || []).map((id) => ({ id, since: x.since, until: x.until }));
  for (const o of occ) {
    const f = facts.get(String(o?.id));
    if (!f) continue;   // 파일에 없다(그 사이 정리 · 새 배포본) — 사실로 반박할 수 없어 세지 않는다(unverified)
    const cap = maxMinOf({ kind: f.kind }) * MIN;
    if (o.since != null && Number.isFinite(o.until) && o.until - o.since > cap + MIN) return 'over-cap';
    if (f.deleted != null && f.deleted <= x.at) return 'deleted';
    if (f.endedAt != null && f.endedAt <= x.at && (f.kind === 'once' || (o.since != null && f.endedOccStart === o.since))) return 'ended';
    if (f.kind !== 'once' && f.confirmedAt != null && f.confirmedAt + RECUR_CONFIRM_DAYS * DAY <= x.at) return 'expired';
    if (f.deployedAt != null && x.at - f.deployedAt > DEPLOY_TTL_MS) return 'deploy-stale';
  }
  return null;
}
/**
 * 주기 끝 점검(‘창 끝 뒤 억제 0’) — 이번 주기에 적용한 억제마다 leakReason. 결과는 leak 수(0 이어야 정상)와 함께 상태 파일에 남긴다.
 *   적용 기록이 없는 주기는 지난 점검 결과를 덮지 않는다(다른 폴러가 찾은 leak 를 0 으로 지우지 않게) — 계수만 저장한다.
 * @returns {Promise<{checked:number, leak:number, unverified:number, reasons:object}>}
 */
/**
 * ⚠ 점검 반복 7회차 C1: 적용 기록 버퍼는 **점검 묶음별로** 비운다 — 예전에는 먼저 부른 쪽이 통째로 가져가, 파트 장애 폴러(10분)가 bmusage 주기 도중
 *   auditCycle 을 부르면 그 주기의 collect · alerts 기록을 가져가 bmusage 주기 끝 점검이 checked 0 · leak 0 이었다(수집 건강 ‘0 · 정상’ ↔ 저장값 leak 1).
 *   묶음: 'cycle' = bmusage 주기(collect · alerts · focus — 주기가 비운다) · 'hold' = 파트 장애 보류(그 폴러가 비운다). 범위를 주지 않으면 전부(옛 호출 · 시험).
 *   저장 결과도 묶음별(leakBy)로 두고 합친 값(leak)을 화면 · 봉투에 준다 — 한 묶음의 점검이 다른 묶음이 찾은 leak 을 0 으로 덮지 않게.
 */
export const AUDIT_GROUPS = Object.freeze(['cycle', 'hold']);
const GROUP_SCOPES = Object.freeze({ cycle: ['collect', 'alerts', 'focus'], hold: ['hold'] });
export async function auditCycle({ now = Date.now(), factsOf = windowFactsNoCache, group = null } = {}) {
  const scopes = group && GROUP_SCOPES[group] ? GROUP_SCOPES[group] : null;
  let list;
  if (scopes) { list = _cycle.filter((x) => scopes.includes(x.scope)); _cycle = _cycle.filter((x) => !scopes.includes(x.scope)); }
  else { list = _cycle; _cycle = []; }
  let leak = 0; let unverified = 0; const reasons = {};
  if (list.length) {
    let facts = { ok: false, byId: new Map() };
    try { facts = factsOf(); } catch { facts = { ok: false, byId: new Map() }; }
    for (const x of list) {
      if ((x.windowIds || []).every((id) => !facts.byId.has(String(id)))) unverified += 1;
      const r = leakReason(x, facts.byId);
      if (r) { leak += 1; reasons[r] = (reasons[r] || 0) + 1; }
    }
    const st = loadStats();
    const prevN = st.leak?.n;
    const cur = { n: leak, last: list.length, at: now, ...(unverified ? { unverified } : {}), ...(leak ? { reasons } : {}) };
    if (scopes) {
      st.leakBy = { ...(st.leakBy || {}), [group]: cur };
      const gs = Object.values(st.leakBy);
      const sum = (k) => gs.reduce((a, g) => a + (Number(g[k]) || 0), 0);
      const rs = {}; for (const g of gs) for (const [k, v] of Object.entries(g.reasons || {})) rs[k] = (rs[k] || 0) + v;
      const n = sum('n'); const uv = sum('unverified');
      st.leak = { n, last: sum('last'), at: Math.max(...gs.map((g) => Number(g.at) || 0)), ...(uv ? { unverified: uv } : {}), ...(n ? { reasons: rs, since: prevN ? (st.leak.since || now) : now } : {}) };
    } else {
      st.leakBy = {};
      st.leak = { ...cur, ...(leak ? { since: prevN ? (st.leak.since || now) : now } : {}) };
    }
  }
  saveStats();
  return { checked: list.length, leak, unverified, reasons };
}
function saveStats() {
  const st = loadStats();
  if (_statsReadErr) return;   // 77회차 F5: 읽기 오류 중에는 원본(못 읽었을 뿐 온전할 수 있다)을 메모리 계수로 덮지 않는다
  const ids = Object.keys(st.byWindow);
  if (ids.length > STATS_MAX) for (const id of ids.sort((a, b) => (st.byWindow[a].at || 0) - (st.byWindow[b].at || 0)).slice(0, ids.length - STATS_MAX)) delete st.byWindow[id];
  try { atomicWriteFileSync(STATS_FILE(), JSON.stringify({ v: 1, byWindow: st.byWindow, leak: st.leak, ...(st.leakBy && Object.keys(st.leakBy).length ? { leakBy: st.leakBy } : {}), at: Date.now() }), { mode: 0o600 }); } catch { /* 다음 주기에 다시 */ }
}
/** 화면 · 봉투용 사본. */
export function maintStats() {
  const st = loadStats();
  return { byWindow: JSON.parse(JSON.stringify(st.byWindow)), leak: { ...st.leak }, ...(st.unreadable ? { unreadable: st.unreadable } : {}), ...(st.readError ? { readError: true } : {}) };
}
export function flushMaintStats() { saveStats(); }
export function _resetMaintRuntimeForTest({ unlink = true } = {}) { _stats = null; _cycle = []; _statsReadErr = false; _statsReader.reset(); if (unlink) { try { fs.unlinkSync(STATS_FILE()); } catch { /* */ } } }
export { SCOPES };
