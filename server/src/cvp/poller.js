/**
 * cvp/poller.js — CloudVision(CVP) 주기 수집(v2.608).
 * 이 노드 몫 CVP(registry.serversForThisNode — 중앙: agent 없음 · 엣지: 자기 이름)를 읽어 DB 에 적재한다.
 *
 * 폴러 규약(루트 CLAUDE.md — 전부 지킨다):
 *  - **재진입 가드**(수동 실행과 공유) · **동시성 제한**(settings.concurrency, 기본 2 — CVP 한 대가 장비 수백 대를 대신 답하므로 작게)
 *  - **CVP 당 시한이 세션을 실제로 끊는다**(withDeadline + signal — v2.417). 세션 예산은 시한보다 10초 작게(v2.528).
 *  - startAdaptiveTimer + 설정 변경 리스너(주기를 바꾸면 즉시 재무장 — v2.409) · **기본 꺼짐**
 *  - **인증 실패(401/403)는 주기 수집만 멈춘다**(util/authGuard — `cvp-auth-stops.json`). 수동 실행은 막지 않고,
 *    자격증명(토큰/비밀번호)이 바뀌면 자동 재개. 조용히 멈추지 않는다(상태의 authStopped 가 말한다).
 *  - 표본 시각은 **그 장비의 카운터를 실제로 읽은 시각**(v2.550.3 — 주기 시작 시각이 아니다).
 *  - 누적 카운터 이전값은 인메모리 — 재시작 뒤 첫 주기는 처리량이 null(첫 표본). 대상에서 빠진 CVP 의 상태는 매 주기 정리한다.
 *  - prune 스로틀 `(++tick % N) === 0`(v2.453 — 기동 첫 틱에 돌지 않게).
 */
import { config, clampIntervalMs } from '../config.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { withDeadline } from '../util/deadline.js';
import { createAuthGuard, authStopView } from '../util/authGuard.js';
import { poolSettled } from '../util/pool.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { serversForThisNode, getServerWithSecret } from './registry.js';
import { loadSettings, onSettingsChange } from './settings.js';
import { collectCvp, testCvp } from './client.js';
import { portDelta } from './parse.js';
import * as db from './db.js';
import { putStatus, getStatus, keepOnly } from './store.js';

export const cvpAuthGuard = createAuthGuard({ file: 'cvp-auth-stops.json' });
const PARTS_EVERY_MS = clampIntervalMs(Number(process.env.CVP_PARTS_EVERY_MS) || 30 * 60_000, 30 * 60_000, 5 * 60_000);
const warnLog = createChangeLogger({ windowMs: 10 * 60_000, maxKeys: 256 });

/** 정지 판정용 자격증명 모양(평문은 지문 계산에만 — util/credFingerprint). 토큰 모드는 토큰이 '비밀번호' 다. */
export const credOf = (s) => ({
  id: s?.id,
  username: s?.authMode === 'password' ? String(s?.username || '') : '(token)',
  password: s?.authMode === 'password' ? String(s?.password || '') : String(s?.token || ''),
});

let _timer = null;
let _busy = false;
let _last = { at: 0 };
const _inFlight = new Map();
const _prevCounters = new Map(); // `${cvpId}|${deviceKey}|${port}` → { at, c }
const _prefer = new Map();       // cvpId → Map(kind → 경로 후보)
const _partsAt = new Map();      // cvpId → 마지막 부품 조회 시각
const _zeroSince = new Map();    // cvpId → 인벤토리가 처음 0대로 온 시각(COL2611-05 prune 보류)
/** 장비가 있던 CVP 가 갑자기 0대를 주면 이 시간 동안 장비 행을 지우지 않는다(빈 200·스트림 조기 종료 대비 — 보류에는 반드시 시한, v2.601). */
export const ZERO_PRUNE_HOLD_MS = clampIntervalMs(Number(process.env.CVP_ZERO_PRUNE_HOLD_MS) || 60 * 60_000, 60 * 60_000, 5 * 60_000);

export const pollMs = () => loadSettings().intervalMs;

/**
 * 장비의 포트에 처리량·사용률·오류 델타를 채운다(제자리). 카운터를 못 읽었으면 전부 null.
 * slackMs(COL2611-08): 간격 한계에 더할 직전 실행 소요 — 적응 타이머는 실행이 끝난 뒤 재무장하므로 두 표본 간격은
 *   주기 + 실행 시간이다(v2.599 베어메탈 규약과 같다). 없으면 예전처럼 주기×3.
 */
export function applyDeltas(cvpId, dev, intervalMs, prevMap = _prevCounters, slackMs = 0) {
  if (!Array.isArray(dev.ports)) return;
  const at = dev.countersAt;
  for (const p of dev.ports) {
    const k = `${cvpId}|${dev.key}|${p.name}`;
    const c = dev.counters instanceof Map ? dev.counters.get(p.name) : null;
    if (!c || at == null) { Object.assign(p, { inBps: null, outBps: null, inUtil: null, outUtil: null, inErr: null, outErr: null }); continue; }
    const d = portDelta(prevMap.get(k) || null, { at, c }, p.speedBps, intervalMs, slackMs);
    Object.assign(p, { inBps: d.inBps, outBps: d.outBps, inUtil: d.inUtil, outUtil: d.outUtil, inErr: d.inErr, outErr: d.outErr });
    prevMap.set(k, { at, c });
  }
}

async function collectOne(srv, { periodic, settings, forceParts, slackMs = 0 }) {
  const full = getServerWithSecret(srv.id) || srv;
  if (periodic) {
    const stop = cvpAuthGuard.authStopFor(credOf(full));
    if (stop) {
      const prev = getStatus(full.id);
      putStatus(full.id, { ...(prev || {}), ok: false, name: full.name, authStopped: authStopView(stop), error: prev?.error || `인증 실패로 주기 수집을 멈췄습니다 — ${stop.reason}` });
      return 'stopped';
    }
  }
  const t0 = Date.now();
  _inFlight.set(full.id, { id: full.id, name: full.name || full.id, at: t0 });
  const prefer = _prefer.get(full.id) || new Map();
  _prefer.set(full.id, prefer);
  const partsDue = forceParts || !(_partsAt.get(full.id) > t0 - PARTS_EVERY_MS);
  const timeout = settings.deviceTimeoutMs;
  try {
    let r;
    try {
      r = await withDeadline(timeout, (signal) => collectCvp(full, { signal, budgetMs: Math.max(20_000, timeout - 10_000), partsDue, prefer }), 'CVP 수집 시한 초과');
    } catch (e) {
      const auth = !!e?.authFailed;
      const msg = e?.message || String(e);
      let authStopped = null;
      if (auth) {
        const rec = cvpAuthGuard.markAuthStopped(full.id, credOf(full), msg);
        authStopped = authStopView(rec);
        console.warn(`[cvp] ${full.name || full.id}: 인증 실패로 주기 수집 정지(${rec.attempts}회) — 토큰·비밀번호를 고치면 자동 재개합니다`);
      } else if (warnLog(full.id, msg)) console.warn(`[cvp] ${full.name || full.id}: 수집 실패 — ${msg}`);
      const prev = getStatus(full.id);
      putStatus(full.id, { name: full.name, ok: false, collectedAt: prev?.collectedAt ?? null, lastAttemptAt: Date.now(), durationMs: Date.now() - t0,
        deviceCount: prev?.deviceCount ?? null, error: msg, authStopped, usedPaths: prev?.usedPaths || {}, missing: prev?.missing || {}, seenFields: prev?.seenFields || {}, truncated: prev?.truncated || null });
      return 'failed';
    }
    if (!r.ok) {
      if (warnLog(full.id, r.error)) console.warn(`[cvp] ${full.name || full.id}: ${r.error}`);
      const prev = getStatus(full.id);
      putStatus(full.id, { name: full.name, ok: false, collectedAt: prev?.collectedAt ?? null, lastAttemptAt: Date.now(), durationMs: Date.now() - t0,
        deviceCount: prev?.deviceCount ?? null, error: r.error, authStopped: null, usedPaths: r.usedPaths, missing: r.missing, seenFields: r.seenFields, truncated: r.truncated });
      cvpAuthGuard.clearAuthStop(full.id); // 로그인은 됐다 — 자격증명 문제가 아니다
      return 'failed';
    }
    cvpAuthGuard.clearAuthStop(full.id);
    // v2.611(TIM2611-01): 부품을 **실제로 읽은 장비가 있을 때만** '부품 조회 시각' 을 올린다 — 예산·시한에 걸려 아무 장비도 못 읽은
    //   주기를 '읽었다' 로 적으면 다음 30분 동안 부품을 다시 보지 않고 화면은 partsRead 를 참으로 말한다.
    const partsReadNow = partsDue && r.devices.some((d) => Array.isArray(d.parts));
    /*
     * v2.612 RECENT2612-01: 조회 시각은 **시도했으면** 올린다(경로가 전부 404 인 CVP 도 시도다). 예전에는 읽었을 때만 올려 파트 경로가
     *   없는 CVP 에 매 주기 4종 × 장비 수만큼 헛조회를 보냈다. '이번 차례에 못 읽음' 표시(partsDueUnread)는 **예산·시한 때문에
     *   시도조차 못 한 장비**가 있을 때만 — 그때만 원인이 확인된 것이다(전부 실패는 missing 의 사유가 말한다).
     */
    const partsAttemptedNow = partsDue && r.devices.some((d) => d.partsAttempted === true);
    if (partsReadNow || partsAttemptedNow) _partsAt.set(full.id, t0);
    const partsNotTried = partsDue ? r.devices.filter((d) => d.partsAttempted !== true && d.streaming !== false
      && ['budget', 'budget-partial', 'aborted', 'pending', 'ok', 'failed'].includes(d.telemetry) && d.parts === undefined).length : 0;
    const readAt = Date.now();
    for (const d of r.devices) {
      applyDeltas(full.id, d, settings.intervalMs, _prevCounters, slackMs);
      d.ts = d.countersAt ?? readAt;
      delete d.counters;
    }
    // v2.611(TIM2611-05): 인벤토리를 온전히 읽었으면 사라진 장비의 이전 카운터를 인메모리에서도 지운다(누수 — v2.550.3).
    if (r.inventoryComplete) {
      const liveDev = new Set(r.devices.map((d) => `${full.id}|${d.key}|`));
      const pre = `${full.id}|`;
      for (const k of [..._prevCounters.keys()]) {
        if (!k.startsWith(pre)) continue;
        const dk = k.slice(0, k.indexOf('|', pre.length) + 1);
        if (!liveDev.has(dk)) _prevCounters.delete(k);
      }
    }
    // v2.611(COL2611-05): 장비가 있던 CVP 가 0대를 주면 prune 을 시한 동안 보류한다(엣지 push 도 DB 행이 남아 있으므로 0대로 가지 않는다).
    let pruneHeld = null;
    if (r.inventoryComplete && r.devices.length === 0) {
      const had = await db.deviceCount(db.LOCAL_AGENT, full.id).catch(() => null);
      if (had > 0) {
        const since = _zeroSince.get(full.id) ?? readAt;
        _zeroSince.set(full.id, since);
        if (readAt - since < ZERO_PRUNE_HOLD_MS) {
          pruneHeld = { since, untilMs: since + ZERO_PRUNE_HOLD_MS, had, reason: `직전 ${had}대가 있던 CVP 가 0대를 보고했습니다 — 빈 응답일 수 있어 ${Math.round(ZERO_PRUNE_HOLD_MS / 60_000)}분 동안 장비 목록을 지우지 않습니다` };
          if (warnLog(`${full.id}|zero`, 'held')) console.warn(`[cvp] ${full.name || full.id}: ${pruneHeld.reason}`);
        }
      }
    } else _zeroSince.delete(full.id);
    let saved = null;
    try {
      saved = await db.saveDevices({ agent: db.LOCAL_AGENT, cvpId: full.id, devices: r.devices, samples: true });
      if (r.inventoryComplete && !pruneHeld) { await db.pruneDevices(db.LOCAL_AGENT, { [full.id]: r.devices.map((d) => d.key) }); _zeroSince.delete(full.id); }
    } catch (e) { saved = { error: e.message }; console.warn(`[cvp] ${full.name || full.id}: DB 적재 실패 — ${e.message}`); }
    putStatus(full.id, {
      name: full.name, ok: true, collectedAt: readAt, lastAttemptAt: readAt, durationMs: readAt - t0, deviceCount: r.devices.length,
      error: null, authStopped: null, usedPaths: r.usedPaths, missing: r.missing, seenFields: r.seenFields, truncated: r.truncated,
      cvpVersion: r.cvpVersion, partsRead: partsReadNow, ...(partsNotTried > 0 ? { partsDueUnread: true, partsNotTried } : {}),
      ...(pruneHeld ? { pruneHeld } : {}),
      ...(saved?.unavailable ? { dbUnavailable: true } : {}), ...(saved?.error ? { dbError: saved.error } : {}),
    });
    return 'ok';
  } finally { _inFlight.delete(full.id); }
}

/**
 * @param {{ manual?:boolean, only?:string[]|null, trigger?:string }} [opts] manual — 사람이 누른 실행(꺼져 있어도, 인증 정지여도 1회 시도).
 */
export async function pollCvpOnce({ manual = false, only = null, trigger = manual ? 'manual' : 'timer' } = {}) {
  const settings = loadSettings();
  if (!settings.enabled && !manual) {
    // v2.611(DB2611-05·RECENT2611-07): 보존 정리는 수집 켜짐과 무관하게 돈다 — 중앙은 꺼져 있어도 엣지 push 를 적재하고
    //   (CVP_SETTINGS_LOCAL=1 엣지·꺼진 상태의 수동 요청), 꺼진 뒤 남은 행도 보존일은 지켜야 한다(guestdisk/poller.js 와 같은 규약).
    db.maybePrune(settings).catch(() => {});
    return { ok: false, skipped: true, reason: 'CVP 수집이 꺼져 있습니다(설정 › CVP 수집)' };
  }
  if (_busy) return { ok: false, busy: true, reason: '이전 수집 진행 중(겹침 방지)' };
  _busy = true;
  const t0 = Date.now();
  try {
    const all = serversForThisNode();
    const ids = Array.isArray(only) ? new Set(only.map(String)) : null;
    const servers = ids ? all.filter((s) => ids.has(String(s.id))) : all;
    if (!ids) {
      // 대상에서 빠진 CVP 의 인메모리 상태·이전 카운터를 정리한다(누수 + 몇 시간 전 카운터와 비교하는 거짓 방지 — v2.550.3).
      const live = new Set(all.map((s) => String(s.id)));
      keepOnly(live);
      for (const k of [..._prevCounters.keys()]) if (!live.has(k.split('|')[0])) _prevCounters.delete(k);
      for (const m of [_prefer, _partsAt, _zeroSince]) for (const k of [...m.keys()]) if (!live.has(k)) m.delete(k);
      try { await db.pruneDevices(db.LOCAL_AGENT, {}, { cvpIds: [...live] }); } catch { /* DB 불가 — 다음 주기 */ }
    }
    const slackMs = Math.max(0, Number(_last.durationMs) || 0); // 직전 실행 소요(COL2611-08)
    const res = await poolSettled(servers, settings.concurrency, (s) => collectOne(s, { periodic: !manual, settings, forceParts: manual, slackMs }));
    const count = (v) => res.filter((x) => x.status === 'fulfilled' && x.value === v).length;
    const crashed = res.filter((x) => x.status === 'rejected');
    for (const c of crashed) console.warn(`[cvp] 수집 중 예외: ${c.reason?.message || c.reason}`);
    _last = { at: Date.now(), trigger, total: servers.length, collected: count('ok'), failed: count('failed') + crashed.length, authStopped: count('stopped'), durationMs: Date.now() - t0 };
    db.maybePrune(settings).catch(() => {}); // maybePrune 가 실패를 콘솔에 남긴다
    if (config.agent.centralUrl && servers.length) {
      import('./push.js').then((m) => m.pushCvpNow()).catch((e) => console.warn(`[cvp] 수집 뒤 push 실패: ${e.message}`));
    }
    return { ok: true, ..._last };
  } finally { _busy = false; }
}

/** 연결 테스트(저장하지 않는다). */
export async function testServerConnection(server, { timeoutMs = 60_000 } = {}) {
  const r = await withDeadline(timeoutMs, (signal) => testCvp(server, { signal }), '테스트 시한 초과').catch((e) => ({ ok: false, reason: e.message }));
  // 저장 비밀로 한 테스트가 성공하면 정지를 푼다(고쳤는지 확인할 길 — v2.590).
  if (r.ok && server?.id) cvpAuthGuard.clearAuthStop(server.id);
  return r;
}

export function isPollerBusy() { return _busy; }

export function startCvpPoller() {
  if (_timer) return;
  _timer = startAdaptiveTimer(pollMs, () => pollCvpOnce({ trigger: 'timer' }), { firstDelayMs: 45_000, name: 'CVP 수집', subscribe: onSettingsChange });
}

export function cvpPollerStatus() {
  const s = loadSettings();
  return {
    ..._last, lastRun: _last.at || null, running: _busy, busy: _busy, enabled: s.enabled, intervalMs: s.intervalMs, concurrency: s.concurrency,
    inFlight: [..._inFlight.values()], partsEveryMs: PARTS_EVERY_MS,
  };
}

export function _resetForTest() { _busy = false; _last = { at: 0 }; _inFlight.clear(); _prevCounters.clear(); _prefer.clear(); _partsAt.clear(); _zeroSince.clear(); }
export const _prevCountersForTest = _prevCounters;
