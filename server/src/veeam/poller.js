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
import { serversForThisNode, getServerWithSecret, listServers, registryLoadError, accessFingerprint } from './registry.js';
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

/**
 * 서버 1대 수집 → 결과 객체(실패도 결과다). 인증 정지 판정·기록은 여기서 한다.
 * v2.762(G2): 등록부 원소는 saveServer 가 제자리에서 바꾸고 엣지 pull 은 통째로 바꾼다 — 시작 시점의 **사본**과 접속처 지문으로 끝까지 읽고,
 *   끝났을 때 등록부 항목이 없거나 지문이 다르면(수집 도중 접속처 변경) 결과·인증 정지 해제·정지 기록을 모두 버린다({discarded:true}).
 *   그러지 않으면 B4 가 지운 옛 접속처 결과가 되살아나고, 옛 host 의 401 이 새 host 의 주기 수집을 멈춘다(credHash 는 계정·비밀번호만 본다).
 */
export async function collectOne(server, { manual = false } = {}) {
  const cur = getServerWithSecret(server.id);
  const full = { ...(cur || server) };
  if (String(full.id).startsWith('mock-')) return null;
  const target = accessFingerprint(full);
  // 시작 때 등록부에 있던 서버만 대조한다(등록부 밖 원소로 부른 호출은 예전 그대로).
  const moved = () => { if (!cur) return false; const now = getServerWithSecret(full.id); return !now || accessFingerprint(now) !== target; };
  // v2.763(V1-I1): 비밀번호가 없으면(접속처 변경으로 폐기 · 배정에 실리지 않음) 접속하지 않는다 — 빈 비밀번호 로그인 1회가 AD 잠금 카운터에 쌓이고
  //   인증 정지로 이어졌다. 로그인 시도 자체가 없으므로 정지 기록도 남기지 않는다(수동 실행도 같다).
  if (!full.password) {
    return { ok: false, ts: Date.now(), ms: 0, error: '비밀번호가 없습니다(접속처를 바꿔 저장한 비밀번호를 폐기했거나 배정에 실리지 않았습니다) — 설정 › Veeam 백업 서버에서 비밀번호를 다시 입력하세요', kind: 'no-password', target, jobs: [], vms: [], counts: {}, notes: [] };
  }
  if (!manual) {
    const stop = authGuard.authStopFor(full);
    if (stop) return { ok: false, ts: Date.now(), ms: 0, error: `인증 실패로 주기 수집을 멈췄습니다(${stop.reason}) — 비밀번호를 고치면 자동으로 다시 읽습니다`, kind: 'auth-stopped', authStop: authStopView(stop), target, jobs: [], vms: [], counts: {}, notes: [] };
  }
  _inFlight.add(full.id);
  const t0 = Date.now();
  const discard = (what) => {
    if (_log(`moved:${full.id}`, what)) console.warn(`[veeam] ${full.name}(${full.host}) 수집 도중 접속처가 바뀌어 이전 접속처의 ${what}를 버렸습니다`);
    return { discarded: true };
  };
  try {
    const r = await withDeadline(serverDeadlineMs(), (signal) => collectVeeamServer(full, { signal }), `Veeam ${full.name} 시한 초과`);
    if (moved()) return discard('결과');
    authGuard.clearAuthStop(full.id);
    return r;
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 600);
    if (moved()) return discard(e?.authFailed ? '인증 실패(정지 기록 안 함)' : '실패 결과');
    let authStop = null;
    if (e?.authFailed) authStop = authStopView(authGuard.markAuthStopped(full.id, full, msg));
    if (_log(`fail:${full.id}`, msg)) console.warn(`[veeam] ${full.name}(${full.host}) 수집 실패: ${msg}`);
    return { ok: false, ts: Date.now(), ms: Date.now() - t0, error: msg, kind: e?.authFailed ? 'auth' : (e?.kind || ''), authStop, target, jobs: [], vms: [], counts: {}, notes: [] };
  } finally { _inFlight.delete(full.id); }
}

/** 이 노드 몫 전체를 한 번 읽는다. 진행 중이면 그 실행을 기다린다(겹치지 않는다). */
export async function pollVeeamOnce({ manual = false, ids = null } = {}) {
  if (_running) return { skipped: true, reason: '이미 수집 중', since: _running.since };
  const run = async () => {
    const all = serversForThisNode();
    const list = ids ? all.filter((d) => ids.includes(d.id)) : all;
    const isEdge = !!config.agent.centralUrl;
    // v2.762(F4b): 등록부를 못 읽었으면(빈 목록) 지우지 않는다 — 저장된 결과를 전부 지우고 파일까지 덮는다(못 읽은 상태로 지우지 않는다).
    if (!isEdge && !ids && !registryLoadError()) pruneExcept(listServers().map((d) => d.id));
    let ok = 0; let fail = 0; let discarded = 0; let gone = 0;
    const res = await poolSettled(list, concurrency(), async (d) => {
      // v2.763(V3-1): 대기열에서 차례가 왔을 때 다시 본다 — 그 사이 삭제·수집 끄기·담당 변경(엣지 pull 의 빠짐 포함)된 서버는 주기 시작 때의
      //   원소(비밀번호 포함)로 로그인하지 않는다(결과·인증 정지 기록이 되살아났다). serversForThisNode 가 enabled·이 노드 몫을 함께 본다.
      if (!serversForThisNode().some((x) => x.id === d.id)) { gone++; return; }
      const r = await collectOne(d, { manual });
      if (!r) return;
      if (r.discarded) { discarded++; return; }
      if (r.ok) ok++; else fail++;
      putResult(d.id, r, { via: 'local', agent: isEdge ? (config.agent.name || '') : '' });
    });
    authGuard.flush();
    const crashed = res.filter((x) => x.status === 'rejected').length;
    _last = { at: Date.now(), servers: list.length, ok, fail: fail + crashed, manual };
    for (const fn of _listeners) { try { fn(); } catch { /* */ } }
    return { ok, fail: fail + crashed, servers: list.length, ...(discarded ? { discarded } : {}), ...(gone ? { gone } : {}) };
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
