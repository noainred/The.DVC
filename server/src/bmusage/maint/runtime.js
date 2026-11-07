/**
 * bmusage/maint/runtime.js — 정비 창 판정의 **노드 실행 면**(8a단계): 판정기 만들기 · 억제 계수 · ‘창 끝 뒤 억제’ 점검.
 *
 * 판정은 judge.js 하나(순수)이고 여기는 입력을 모은다:
 *   · 창 = store.windowsForJudge(이 노드의 창 + 신선한 중앙 배포본)
 *   · 태그 = 이 노드의 수동 용도 태그(insights/fleetTags purposes — role · apps). 엣지는 중앙 태그가 없어 배포본의 펼친 keys 로 맞춘다.
 * 억제 계수(창마다 — 화면 ‘억제 알림 n · 창 뒤 발송 n’)는 이 노드 메모리 + 상태 파일(`maintenance-stats.json` — 원자 쓰기 · 손상 보존 · 손상이면 0 부터 · 그 사실을 표지로).
 * ⚠⚠ ‘창 끝 뒤 억제 0’ 점검(설계 안전장치): 억제를 적용할 때마다 그 근거 시한(until)을 기록하고, **캐시 없이 파일을 다시 읽은 판정**으로 다시 본다 —
 *   적용 시각이 시한을 넘었거나 새로 읽은 판정이 억제가 아니라고 하면 leak 로 센다(수집 건강 보드 ‘창 끝 뒤 억제’ 행 · 0 이어야 정상).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';
import { maintStateFor, coverIntervals, SCOPES } from './judge.js';
import { windowsForJudge } from './store.js';

const STATS_FILE = () => path.join(config.configDir, 'maintenance-stats.json');
const STATS_MAX = 2_000;
const t = (v) => String(v ?? '').trim();

/** 이 노드의 수동 용도 태그 → ['role:<역할>', 'app:<용도>' …](없으면 []). 서비스 태그(소문자) 우선 · 아니면 서버 키(fleet-tags 키 규약). */
export async function tagsReader() {
  let FT = null;
  try { FT = await import('../../insights/fleetTags.js'); } catch { FT = null; }
  return (target) => {
    if (!FT || !target) return [];
    let p = null;
    try { p = FT.fleetPurposeOf(t(target.serviceTag)) || FT.fleetPurposeOf(t(target.key)); } catch { p = null; }
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
  return {
    windows: w.windows,
    meta: { localUnreadable: !!w.localUnreadable, deployed: w.deployed, n: w.windows.length },
    stateFor: (target, at = now) => maintStateFor(w.windows, target, at, { tagsOf: tg }),
    cover: (target, from, to, scope = null) => coverIntervals(w.windows, target, from, to, { scope, tagsOf: tg }),
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
let _cycle = [];     // 이번 주기에 적용한 억제 [{ scope, key, until, at, windowIds }]
function loadStats() {
  if (_stats) return _stats;
  try {
    if (!fs.existsSync(STATS_FILE())) { _stats = { v: 1, byWindow: {}, leak: { n: 0, last: 0, at: 0 } }; return _stats; }
    const o = JSON.parse(fs.readFileSync(STATS_FILE(), 'utf8'));
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('객체가 아닙니다');
    const bw = {};
    for (const [id, x] of Object.entries(o.byWindow && typeof o.byWindow === 'object' ? o.byWindow : {}).slice(0, STATS_MAX)) {
      if (!/^mw-[a-z0-9]{6,32}$/.test(id) || !x || typeof x !== 'object') continue;
      bw[id] = Object.fromEntries(['alerts', 'after', 'hold', 'focus', 'collect', 'collectFail', 'at'].map((k) => [k, Number.isFinite(Number(x[k])) ? Number(x[k]) : 0]));
    }
    const lk = o.leak && typeof o.leak === 'object' ? o.leak : {};
    _stats = { v: 1, byWindow: bw, leak: { n: Number(lk.n) || 0, last: Number(lk.last) || 0, at: Number(lk.at) || 0 } };
  } catch (e) {
    preserveCorrupt(STATS_FILE(), String(e?.message || e));
    _stats = { v: 1, byWindow: {}, leak: { n: 0, last: 0, at: 0 }, unreadable: Date.now() };
  }
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
/** 억제를 적용했다는 기록(점검용) — 시한(until)과 적용 시각. */
export function noteApplied(scope, key, until, windowIds = [], at = Date.now()) {
  if (_cycle.length < 20_000) _cycle.push({ scope, key: t(key), until: Number(until), at, windowIds: (windowIds || []).slice(0, 8) });
}
/**
 * 주기 끝 점검(‘창 끝 뒤 억제 0’) — 이번 주기에 적용한 억제마다 ① 적용 시각이 시한 안이었나 ② 캐시 없이 다시 읽은 판정도 억제인가.
 *   targetsByKey: 키 → 대상(법인 · 태그 판정에 쓴다). 결과는 leak 수(0 이어야 정상)와 함께 상태 파일에 남긴다.
 * @returns {Promise<{checked:number, leak:number}>}
 */
export async function auditCycle({ targetsByKey = new Map(), now = Date.now(), windowsOf = windowsForJudge, tagsOf = null } = {}) {
  const list = _cycle; _cycle = [];
  let leak = 0;
  if (list.length) {
    const fresh = await maintJudge({ now, windowsOf, tagsOf });
    for (const x of list) {
      if (!(Number.isFinite(x.until) && x.at < x.until)) { leak += 1; continue; }
      const tg = targetsByKey.get(x.key) || { key: x.key };
      const s = fresh.stateFor(tg, x.at);
      if (!s.scopes[x.scope]) leak += 1;
    }
  }
  const st = loadStats();
  st.leak = { n: leak, last: list.length, at: now, ...(leak ? { since: st.leak?.n ? (st.leak.since || now) : now } : {}) };
  saveStats();
  return { checked: list.length, leak };
}
function saveStats() {
  const st = loadStats();
  const ids = Object.keys(st.byWindow);
  if (ids.length > STATS_MAX) for (const id of ids.sort((a, b) => (st.byWindow[a].at || 0) - (st.byWindow[b].at || 0)).slice(0, ids.length - STATS_MAX)) delete st.byWindow[id];
  try { atomicWriteFileSync(STATS_FILE(), JSON.stringify({ v: 1, byWindow: st.byWindow, leak: st.leak, at: Date.now() }), { mode: 0o600 }); } catch { /* 다음 주기에 다시 */ }
}
/** 화면 · 봉투용 사본. */
export function maintStats() {
  const st = loadStats();
  return { byWindow: JSON.parse(JSON.stringify(st.byWindow)), leak: { ...st.leak }, ...(st.unreadable ? { unreadable: st.unreadable } : {}) };
}
export function flushMaintStats() { saveStats(); }
export function _resetMaintRuntimeForTest({ unlink = true } = {}) { _stats = null; _cycle = []; if (unlink) { try { fs.unlinkSync(STATS_FILE()); } catch { /* */ } } }
export { SCOPES };
