/**
 * veeam/poller.js — Veeam 서버 주기 수집(v2.751). 중앙(agent '' 서버)과 엣지(자기 몫 서버) 양쪽에서 같은 모듈이 돈다.
 *
 * 규약(CLAUDE.md 운영 환경 · docs/rules/perf-db.md):
 *  · 병렬 상한(VEEAM_CONCURRENCY, 기본 4) + **서버당 시한은 세션을 실제로 끊는다**(withDeadline → signal → fetch abort).
 *  · 재진입 가드는 수동 실행과 공유하고 주기에 상한을 둔다(끝나지 않는 주기가 가드를 영원히 붙잡지 않게 — 서버 시한 × 묶음 수).
 *  · 인증 실패(401)는 주기 수집을 멈춘다(util/authGuard.js) — 자격증명이 바뀌면 자동 재개, 수동 실행은 막지 않는다. 자동 재시도 없음.
 *  · 데모 서버(id 가 mock- 로 시작)는 접속하지 않는다.
 *  · 엣지는 결과를 중앙으로 보낸다(veeam/push.js) — 0대여도 상태를 올린다(push 타이머가 한다).
 */
import { config, clampIntervalMs } from '../config.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { withDeadline, deadlineMs } from '../util/deadline.js';
import { poolSettled } from '../util/pool.js';
import { createAuthGuard, authStopView } from '../util/authGuard.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { serversForThisNode, getServerWithSecret, listServers } from './registry.js';
import { collectVeeamServer } from './client.js';
import { putResult, pruneExcept } from './store.js';

export const pollMs = () => clampIntervalMs(Number(process.env.VEEAM_POLL_MS) || 600_000, 600_000, 120_000);
const serverDeadlineMs = () => deadlineMs(process.env.VEEAM_SERVER_DEADLINE_MS, 240_000);
const concurrency = () => Math.max(1, Math.min(16, Math.floor(Number(process.env.VEEAM_CONCURRENCY) || 4)));
export const authGuard = createAuthGuard({ file: 'veeam-auth-stops.json' });
const _log = createChangeLogger({ windowMs: 10 * 60_000 });

let _timer = null;
let _running = null;       // { since, promise }
let _last = null;
const _inFlight = new Set();
const _listeners = new Set();
/** 엣지 push 가 결과 적재 직후 보내려고 듣는다. */
export function onVeeamCollected(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }

/** 서버 1대 수집 → 결과 객체(실패도 결과다). 인증 정지 판정·기록은 여기서 한다. */
export async function collectOne(server, { manual = false } = {}) {
  const full = getServerWithSecret(server.id) || server;
  if (String(full.id).startsWith('mock-')) return null;
  if (!manual) {
    const stop = authGuard.authStopFor(full);
    if (stop) return { ok: false, ts: Date.now(), ms: 0, error: `인증 실패로 주기 수집을 멈췄습니다(${stop.reason}) — 비밀번호를 고치면 자동으로 다시 읽습니다`, kind: 'auth-stopped', authStop: authStopView(stop), jobs: [], vms: [], counts: {}, notes: [] };
  }
  _inFlight.add(full.id);
  const t0 = Date.now();
  try {
    const r = await withDeadline(serverDeadlineMs(), (signal) => collectVeeamServer(full, { signal }), `Veeam ${full.name} 시한 초과`);
    authGuard.clearAuthStop(full.id);
    return r;
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 600);
    let authStop = null;
    if (e?.authFailed) authStop = authStopView(authGuard.markAuthStopped(full.id, full, msg));
    if (_log(`fail:${full.id}`, msg)) console.warn(`[veeam] ${full.name}(${full.host}) 수집 실패: ${msg}`);
    return { ok: false, ts: Date.now(), ms: Date.now() - t0, error: msg, kind: e?.authFailed ? 'auth' : (e?.kind || ''), authStop, jobs: [], vms: [], counts: {}, notes: [] };
  } finally { _inFlight.delete(full.id); }
}

/** 이 노드 몫 전체를 한 번 읽는다. 진행 중이면 그 실행을 기다린다(겹치지 않는다). */
export async function pollVeeamOnce({ manual = false, ids = null } = {}) {
  if (_running) return { skipped: true, reason: '이미 수집 중', since: _running.since };
  const run = async () => {
    const all = serversForThisNode();
    const list = ids ? all.filter((d) => ids.includes(d.id)) : all;
    const isEdge = !!config.agent.centralUrl;
    if (!isEdge && !ids) pruneExcept(listServers().map((d) => d.id));
    let ok = 0; let fail = 0;
    const res = await poolSettled(list, concurrency(), async (d) => {
      const r = await collectOne(d, { manual });
      if (!r) return;
      if (r.ok) ok++; else fail++;
      putResult(d.id, r, { via: 'local', agent: isEdge ? (config.agent.name || '') : '' });
    });
    authGuard.flush();
    const crashed = res.filter((x) => x.status === 'rejected').length;
    _last = { at: Date.now(), servers: list.length, ok, fail: fail + crashed, manual };
    for (const fn of _listeners) { try { fn(); } catch { /* */ } }
    return { ok, fail: fail + crashed, servers: list.length };
  };
  // 주기 상한: 서버 시한 × ceil(대수/동시성) + 여유. 넘기면 가드를 풀어 다음 주기가 돈다(끝나지 않는 주기 방지).
  const n = Math.max(1, serversForThisNode().length);
  const capMs = serverDeadlineMs() * Math.ceil(n / concurrency()) + 60_000;
  const since = Date.now();
  let capTimer = null;
  const p = Promise.race([run(), new Promise((resolve) => { capTimer = setTimeout(() => resolve({ timedOut: true }), capMs); })])
    .finally(() => { clearTimeout(capTimer); if (_running?.since === since) _running = null; });
  _running = { since, promise: p };
  return p;
}

export function startVeeamPoller() {
  if (_timer) return;
  _timer = startAdaptiveTimer(pollMs, () => pollVeeamOnce(), { firstDelayMs: 90_000, name: 'Veeam 백업 상태 수집' });
}

export function veeamPollerStatus() {
  return { ...(_last || {}), intervalMs: pollMs(), running: _running ? { since: _running.since } : null, inFlight: [..._inFlight], servers: serversForThisNode().length };
}
export function _resetForTest() { _running = null; _last = null; _inFlight.clear(); }
/** 테스트 전용 — 진행 중인 주기(pull 직후 백그라운드로 시작한 것 포함)의 promise. 없으면 null. */
export function _runningForTest() { return _running?.promise || null; }
