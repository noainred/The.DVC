/**
 * isidu/poller.js — 아이실론 디렉터리 사용량 주기 실행(v2.736). 중앙·엣지 공용: 각 노드는 **자기 몫 대상**만 돈다.
 *   중앙: 설정의 대상 중 실행 노드가 '' 인 것(등록부 아이실론이면 그 장비의 담당 노드가 중앙인 것).
 *   엣지: 중앙이 내려준 사본(settings.edgeTargets) — 엣지가 속한 법인의 아이실론을 엣지가 직접 조사한다.
 *
 * ── 폴러 규약 ────────────────────────────────────────────────────────────────
 *  · 1분 틱(적응 타이머)이 도래한 대상을 **시작만** 한다 — du 는 수십 분이 걸릴 수 있어 한 틱이 다른 대상을 붙잡지 않게,
 *    대상마다 진행 중 표지(_inflight)를 두고 전체 동시 실행은 `ISIDU_CONCURRENCY`(기본 2)로 묶는다.
 *  · 도래: 마지막 시도가 성공이었으면 주기(intervalHours)마다, 실패였으면 min(주기, 1시간)마다(회선 장애가 하루를 통째로
 *    잃지 않게). 인증 거부는 authGuard 가 주기 수집을 멈춘다(계정 잠금 방지).
 *  · 수동 실행('지금 수집')은 같은 진행 중 표지를 공유한다(같은 대상에 du 두 개를 겹쳐 돌리지 않는다).
 *  · 보존 정리는 6시간마다(첫 틱 제외 — v2.453).
 *  · 데모(mock-) 대상은 mock 모드에서만 돈다 — live 에서는 건너뛰고 그 개수를 상태에 남긴다(v2.719).
 */
import { config } from '../config.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { isMockMode } from '../mock/demo/flags.js';
import { loadSettings, resolveTarget, edgeTargets } from './settings.js';
import { collectTarget } from './collect.js';
import * as db from './db.js';

export const TICK_MS = 60_000;
export const FAIL_RETRY_MS = 3_600_000;
const PRUNE_EVERY_MS = 6 * 3_600_000;
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.ISIDU_CONCURRENCY) || 2));
const RECENT_MAX = 60;

const _inflight = new Map();   // targetId → { since, trigger, promise }
const _lastTry = new Map();    // targetId → { ts, ok }
let _seeded = false;
let _timer = null;
let _ticking = false;
let _lastTick = null;
let _lastPrune = Date.now();
let _lastError = null;
let _demoSkipped = 0;
const _recent = [];
let _afterScan = null;         // 엣지: 적재 뒤 push 예약(push.js 가 등록 — 순환 import 방지)

export function onScanStored(fn) { _afterScan = typeof fn === 'function' ? fn : null; }

const isEdge = () => !!(config.agent.centralUrl && config.agent.centralToken);

function note(level, msg) {
  _recent.unshift({ at: Date.now(), level, msg: String(msg).slice(0, 300) });
  if (_recent.length > RECENT_MAX) _recent.length = RECENT_MAX;
  if (level === 'error') console.warn(`[isidu] ${msg}`);
}

/** 이 노드가 돌 대상(실행 정보). */
export async function targetsForThisNode() {
  if (isEdge()) return edgeTargets().targets.map((t) => ({ ...t }));
  const { listDevices } = await import('../storage/registry.js');
  const devices = listDevices();
  return loadSettings().targets.map((t) => resolveTarget(t, { devices })).filter((r) => r && !String(r.agent || '').trim());
}

/** 도래 판정(순수). */
export function isDue(t, last, now = Date.now()) {
  if (!t || t.enabled === false || t.deviceDisabled) return false;
  const iv = Math.max(1, Number(t.intervalHours) || 24) * 3_600_000;
  if (!last || !Number.isFinite(last.ts)) return true;
  const wait = last.ok ? iv : Math.min(iv, FAIL_RETRY_MS);
  return now - last.ts >= wait;
}

async function seedLastTry() {
  if (_seeded) return;
  const rows = await db.latestAll();
  if (rows == null) return; // DB 불가 — 다음 틱에 다시
  for (const r of rows) {
    if (r.agent !== '' || !r.lastTry) continue;
    if (!_lastTry.has(r.targetId)) _lastTry.set(r.targetId, { ts: r.lastTry.ts, ok: r.lastTry.ok });
  }
  _seeded = true;
}

function runOne(t, trigger, manual) {
  const cur = _inflight.get(t.id);
  if (cur) return cur.promise;
  const promise = (async () => {
    try {
      const rec = await collectTarget(t, { trigger, manual });
      const saved = await db.insertScan(rec);
      if (!saved.ok) note('error', `${t.label || t.id}: 결과를 저장하지 못했습니다 — ${saved.error}`);
      _lastTry.set(t.id, { ts: rec.ts, ok: rec.ok });
      if (rec.ok) note('info', `${t.label || t.id}: 폴더 ${rec.count.toLocaleString()}개 조사 (${Math.round(rec.durationMs / 1000)}초)${rec.errLines ? ` · 권한 오류 ${rec.errLines}줄` : ''}`);
      else note('error', `${t.label || t.id}: ${rec.error}`);
      if (saved.ok && _afterScan) { try { _afterScan(); } catch { /* push 예약 실패는 다음 주기 */ } }
      return { ok: rec.ok, saved: saved.ok, kind: rec.kind || null, error: rec.error || null };
    } catch (e) {
      note('error', `${t.label || t.id}: 실행 오류 — ${e.message}`);
      _lastTry.set(t.id, { ts: Date.now(), ok: false });
      return { ok: false, error: e.message };
    } finally {
      _inflight.delete(t.id);
    }
  })();
  _inflight.set(t.id, { since: Date.now(), trigger, promise });
  return promise;
}

async function tick() {
  if (_ticking) return;
  _ticking = true;
  try {
    _lastTick = Date.now();
    if (isMockMode()) {
      try { await (await import('../mock/demo/isidu.js')).ensureIsiduDemo(); } catch (e) { note('error', `데모 시드 실패: ${e.message}`); }
    }
    await seedLastTry();
    const all = await targetsForThisNode();
    let demoSkipped = 0;
    const due = [];
    for (const t of all) {
      if (String(t.id).startsWith('mock-') && !isMockMode()) { demoSkipped++; continue; }
      if (_inflight.has(t.id)) continue;
      if (isDue(t, _lastTry.get(t.id))) due.push(t);
    }
    _demoSkipped = demoSkipped;
    for (const t of due) {
      if (_inflight.size >= CONCURRENCY) break;
      runOne(t, 'schedule', false);
    }
    if (Date.now() - _lastPrune >= PRUNE_EVERY_MS) {
      _lastPrune = Date.now();
      const days = isEdge() ? edgeTargets().retentionDays : loadSettings().retentionDays;
      db.prune(Date.now() - Math.max(30, Number(days) || 400) * 86_400_000).catch((e) => note('error', `보존 정리 실패: ${e.message}`));
    }
    _lastError = null;
  } catch (e) {
    _lastError = { at: Date.now(), message: e.message };
    note('error', `틱 실패: ${e.message}`);
  } finally { _ticking = false; }
}

/**
 * 지금 수집 — 이 노드 몫 대상 중 고른 것(없으면 전부). 기다리지 않는다(du 는 오래 걸린다) — 화면은 상태로 진행을 본다.
 * @returns {Promise<{started:string[], busy:string[], notHere:string[]}>}
 */
export async function runNow(ids = null, { trigger = 'manual' } = {}) {
  const all = await targetsForThisNode();
  const want = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  const started = []; const busy = []; const notHere = [];
  if (want) for (const id of want) if (!all.some((t) => t.id === id)) notHere.push(id);
  for (const t of all) {
    if (want && !want.has(t.id)) continue;
    if (String(t.id).startsWith('mock-') && !isMockMode()) { notHere.push(t.id); continue; }
    if (_inflight.has(t.id)) { busy.push(t.id); continue; }
    runOne(t, trigger, true);
    started.push(t.id);
  }
  return { started, busy, notHere };
}

/** 진행 중인 대상이 끝날 때까지(테스트·데모 백필용). */
export async function waitIdle() { await Promise.all([..._inflight.values()].map((x) => x.promise.catch(() => {}))); }

export function isiduPollerStatus() {
  return {
    role: isEdge() ? 'edge' : 'central',
    tickMs: TICK_MS, concurrency: CONCURRENCY, lastTick: _lastTick, lastError: _lastError,
    running: [..._inflight.entries()].map(([id, v]) => ({ targetId: id, since: v.since, trigger: v.trigger })),
    ...(_demoSkipped ? { demoSkipped: _demoSkipped } : {}),
    recent: _recent.slice(0, 30),
  };
}

export function startIsiduPoller() {
  if (_timer) return;
  _timer = startAdaptiveTimer(() => TICK_MS, () => tick(), { firstDelayMs: 90_000, name: '아이실론 디렉터리 사용량' });
}

export function _resetForTest() { _inflight.clear(); _lastTry.clear(); _seeded = false; _recent.length = 0; _lastError = null; _demoSkipped = 0; }
export { tick as _tickForTest };
