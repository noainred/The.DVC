/**
 * veeam/em/poller.js — Enterprise Manager 주기 수집(v2.788). **중앙 전용**(엣지 노드에서는 시작하지 않는다 — 사용자 결정 '중앙 직접 수집').
 *
 * 규약(veeam/poller.js 와 같다 · docs/rules/perf-db.md):
 *  · EM 당 시한은 세션을 실제로 끊는다(withDeadline → signal → fetch abort) · 병렬 상한 2(EM 은 몇 대뿐 — 한 대가 느려도 나머지는 돈다).
 *  · 재진입 가드는 수동 실행과 공유하고 주기에 상한을 둔다.
 *  · 인증 실패(401)는 주기 수집을 멈춘다(util/authGuard.js) — 자격증명이 바뀌면 자동 재개, 수동 실행은 막지 않는다. 자동 재시도 없음.
 *  · 비밀번호가 없으면 접속하지 않는다(빈 비밀번호 로그인 1회도 계정 잠금 카운터에 쌓인다).
 *  · 데모 EM(id 가 mock- 로 시작)은 접속하지 않는다.
 *  · 수집 직후 저장소 용량을 일 단위 이력에 쌓는다(veeam/historyDb.js — v2.789 소진 예측의 재료).
 */
import { config, clampIntervalMs } from '../../config.js';
import { startAdaptiveTimer } from '../../util/adaptiveTimer.js';
import { withDeadline, deadlineMs } from '../../util/deadline.js';
import { poolSettled } from '../../util/pool.js';
import { createAuthGuard, authStopView } from '../../util/authGuard.js';
import { createChangeLogger } from '../../util/logThrottle.js';
import { emsForThisNode, getEmWithSecret, listEms, emRegistryLoadError, emFingerprint } from './registry.js';
import { collectEm } from './client.js';
import { putEmResult, pruneEmExcept } from './store.js';
import { recordRepoDaily } from '../historyDb.js';

export const emPollMs = () => clampIntervalMs(Number(process.env.VEEAM_EM_POLL_MS) || 900_000, 900_000, 300_000);
const emDeadlineMs = () => deadlineMs(process.env.VEEAM_EM_DEADLINE_MS, 240_000);
const CONCURRENCY = 2;
export const emAuthGuard = createAuthGuard({ file: 'veeam-em-auth-stops.json' });
const _log = createChangeLogger({ windowMs: 10 * 60_000 });
const isEdgeNode = () => !!String(config.agent?.centralUrl || '').trim();

let _timer = null;
let _running = null;
let _last = null;
const _inFlight = new Set();

const failResult = (extra) => ({ ok: false, ts: Date.now(), ms: 0, sections: {}, notes: [], ...extra });

/** EM 1대 수집 → 결과(실패도 결과다). 수집 도중 접속처가 바뀌면 결과·정지 기록을 버린다({discarded:true}). */
export async function collectEmOne(em, { manual = false } = {}) {
  const cur = getEmWithSecret(em.id);
  const full = { ...(cur || em) };
  if (String(full.id).startsWith('mock-')) return null;
  const target = emFingerprint(full);
  const moved = () => { if (!cur) return false; const now = getEmWithSecret(full.id); return !now || emFingerprint(now) !== target; };
  if (!full.password) return failResult({ error: '비밀번호가 없습니다(접속처를 바꿔 저장한 비밀번호를 폐기했습니다) — 설정 › Veeam 백업 서버 › Enterprise Manager 에서 다시 입력하세요', kind: 'no-password', target });
  if (!manual) {
    const stop = emAuthGuard.authStopFor(full);
    if (stop) return failResult({ error: `인증 실패로 주기 수집을 멈췄습니다(${stop.reason}) — 비밀번호를 고치면 자동으로 다시 읽습니다`, kind: 'auth-stopped', authStop: authStopView(stop), target });
  }
  _inFlight.add(full.id);
  const t0 = Date.now();
  try {
    const r = await withDeadline(emDeadlineMs(), (signal) => collectEm(full, { signal }), `Veeam EM ${full.name} 시한 초과`);
    if (moved()) return { discarded: true };
    emAuthGuard.clearAuthStop(full.id);
    return r;
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 600);
    if (moved()) return { discarded: true };
    let authStop = null;
    if (e?.authFailed) authStop = authStopView(emAuthGuard.markAuthStopped(full.id, full, msg));
    if (_log(`fail:${full.id}`, msg)) console.warn(`[veeam-em] ${full.name}(${full.host}) 수집 실패: ${msg}`);
    return { ...failResult({ error: msg, kind: e?.authFailed ? 'auth' : (e?.kind || ''), authStop, target }), ms: Date.now() - t0 };
  } finally { _inFlight.delete(full.id); }
}

/** 저장소 용량을 일 단위 이력으로(EM 보고서·저장소 목록 중 있는 것). 실패는 수집을 막지 않는다. */
function recordHistory(em, r) {
  if (!r?.ok) return;
  const rows = [];
  for (const x of r.repositories || []) if (x.capacity != null || x.free != null) rows.push({ key: `${x.server || ''}|${x.name}`, capacity: x.capacity, free: x.free, backupSize: null });
  if (!rows.length) for (const x of r.repoReport || []) rows.push({ key: `|${x.name}`, capacity: x.capacity, free: x.free, backupSize: x.backupSize });
  try { recordRepoDaily(`em:${em.id}`, rows, r.ts); } catch (e) { if (_log('hist', String(e?.message || e))) console.warn(`[veeam-em] 저장소 이력 기록 실패: ${e?.message || e}`); }
}

export async function pollEmOnce({ manual = false, ids = null } = {}) {
  if (isEdgeNode()) return { skipped: true, reason: '엣지 노드는 Enterprise Manager 를 읽지 않습니다(중앙 전용)' };
  if (_running) return { skipped: true, reason: '이미 수집 중', since: _running.since };
  const run = async () => {
    const all = emsForThisNode();
    const list = ids ? all.filter((d) => ids.includes(d.id)) : all;
    if (!ids && !emRegistryLoadError()) pruneEmExcept(listEms().map((d) => d.id));
    let ok = 0; let fail = 0; let discarded = 0;
    const res = await poolSettled(list, CONCURRENCY, async (d) => {
      if (!emsForThisNode().some((x) => x.id === d.id)) return;
      const r = await collectEmOne(d, { manual });
      if (!r) return;
      if (r.discarded) { discarded++; return; }
      if (r.ok) ok++; else fail++;
      if (putEmResult(d.id, r, { expectTarget: emFingerprint(getEmWithSecret(d.id) || d) })) recordHistory(d, r);
    });
    emAuthGuard.flush();
    const crashed = res.filter((x) => x.status === 'rejected').length;
    _last = { at: Date.now(), ems: list.length, ok, fail: fail + crashed, manual };
    return { ok, fail: fail + crashed, ems: list.length, ...(discarded ? { discarded } : {}) };
  };
  const n = Math.max(1, emsForThisNode().length);
  const capMs = emDeadlineMs() * Math.ceil(n / CONCURRENCY) + 60_000;
  const since = Date.now();
  let capTimer = null;
  const p = Promise.race([run(), new Promise((resolve) => { capTimer = setTimeout(() => resolve({ timedOut: true }), capMs); })])
    .finally(() => { clearTimeout(capTimer); if (_running?.since === since) _running = null; });
  _running = { since, promise: p };
  return p;
}

export function startEmPoller() {
  if (_timer) return;
  if (isEdgeNode()) { console.log('[veeam-em] 엣지 노드 — Enterprise Manager 수집은 중앙에서만 합니다'); return; }
  _timer = startAdaptiveTimer(emPollMs, () => pollEmOnce(), { firstDelayMs: 120_000, name: 'Veeam Enterprise Manager 수집' });
}

export function emPollerStatus() {
  return { ...(_last || {}), intervalMs: emPollMs(), running: _running ? { since: _running.since } : null, inFlight: [..._inFlight] };
}
export function _resetEmPollerForTest() { _running = null; _last = null; _inFlight.clear(); }
