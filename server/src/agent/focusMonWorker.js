/**
 * agent/focusMonWorker.js — 집중 모니터링 **엣지 워커**(v2.976). CENTRAL_URL 이 있는 엣지에서만 돈다.
 *
 * 백업 · 수집은 법인 로컬, 현황은 중앙(루트 CLAUDE.md 2026-11-01): 이 엣지가 자기 법인 서버에 SSH 키로 붙어 수집하고, 계산된 숫자만 중앙에 보낸다.
 *  · 동기화 = `POST /api/central/focus-mon/sync`(개별 토큰 · X-Agent-Name · gzip). 본문 = 그동안 모인 표본 · 프로세스 · 상태 · 공개키 · 시험 결과,
 *    응답 = 지금 수집할 대상 목록(큐가 아니라 **원하는 상태** — 어느 쪽이 재시작해도 다음 동기화에서 맞춰진다).
 *  · 주기: 수집 중이면 2초 · 아니면 30초. 중앙이 깨우면(collector `/focus-mon/wake`) 곧바로 한 번.
 *    v2.978: 중앙 응답에 `idleMs` 가 있으면(이 엣지가 맡은 서버가 있음) 쉬는 동안 그 주기로 조회한다 — [5초, 60초]로 자른다(`nextDelayMs`).
 *    깨우기가 닿지 않는 중계 엣지에서 '수집 시작 → 첫 값' 이 최대 30초 걸리던 것을 줄인다. 응답을 못 받으면 30초로 돌아간다.
 *  · v2.978 엣지 연결 진단: 본문 `diag` = 직전 왕복 ms · 연속 실패 수 · 쌓인/버린 표본 · 수집기 수 · 진행 중 시험 · 마지막 오류(나이 ms 로 — 엣지 시계를 보내지 않는다).
 *  · 요청은 겹치지 않는다(앞 요청이 끝나야 다음). 실패하면 표본을 버리지 않고 다음 동기화에 싣는다 — 최대 10분 · 표본 3,000개까지(넘으면 오래된 것부터 버리고 센다).
 *  · **보류에는 시한**: 마지막 성공 응답의 `validUntil`(30초)이 지나면 모든 수집기를 닫는다(중앙이 끊긴 채 대상 서버에 SSH 를 계속 열어 두지 않게).
 *  · 0건이어도 상태를 남긴다(무음 실패 금지 — `focusMonWorkerStatus` 를 edgelog/spec.js 에 등재).
 *  · 404 는 두 뜻 — 엔드포인트 없음(구버전 중앙 → 1시간 물러남) · central 꺼짐(곧 다시).
 */
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config, currentVersion } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { classifyCentral404 } from './central404.js';
import { agentHeaders, withAgentQuery } from './agentNameCarry.js';
import { createRunner } from '../focusmon/runner.js';
import { focusKeys } from '../focusmon/service.js';

const gzipAsync = promisify(zlib.gzip);
const ACTIVE_MS = 2_000;
const IDLE_MS = 30_000;
const BUF_MAX = 3000;
const BUF_AGE_MS = 10 * 60_000;
export const IDLE_MIN_MS = 5_000;
export const IDLE_MAX_MS = 60_000;

/**
 * 다음 동기화까지(순수 — 테스트 고정). 수집 중 · 깨움 직후면 2초, 아니면 중앙이 준 쉬는 주기(자름) 또는 30초.
 * @param {{active:boolean, idleHintMs?:number|null}} o
 */
export function nextDelayMs({ active, idleHintMs = null }) {
  if (active) return ACTIVE_MS;
  const h = Number(idleHintMs);
  if (idleHintMs == null || !Number.isFinite(h) || h <= 0) return IDLE_MS;
  return Math.min(IDLE_MAX_MS, Math.max(IDLE_MIN_MS, Math.round(h)));
}

const samples = []; // { id, t, s, hello }
const procs = [];   // { id, t, p }
let testResults = []; // { id, result }
let statuses = {};
let timer = null; let running = false; let validUntil = 0; let unsupportedUntil = 0; let lastTargets = 0; let wakeAsked = false;
let _last = null; let dropped = 0;
let idleHintMs = null; let fails = 0; let lastRttMs = null; let lastError = ''; let lastErrorAt = 0;
function noteFail(reason) { fails += 1; idleHintMs = null; lastError = String(reason || '').slice(0, 200); lastErrorAt = Date.now(); }
const _log = createChangeLogger({ windowMs: 10 * 60_000 });

const runner = createRunner({
  keys: focusKeys,
  sink: {
    sample: (id, t, s, hello) => { samples.push({ id, t, s, hello }); trim(samples); },
    procs: (id, t, p) => { procs.push({ id, t, p }); trim(procs); },
    status: (id, st) => { statuses[id] = st; },
  },
});

function trim(buf) {
  const cut = Date.now() - BUF_AGE_MS;
  let k = 0; while (k < buf.length && (buf[k].t < cut || buf.length - k > BUF_MAX)) k += 1;
  if (k) { buf.splice(0, k); dropped += k; }
}

export function focusMonWorkerStatus() {
  return { enabled: !!config.agent.centralUrl, running: runner.running().length, buffered: samples.length, dropped, validUntil, idleMs: nextDelayMs({ active: false, idleHintMs }), fails, ...(_last || {}) };
}

/** 중앙에 보내는 연결 진단(v2.978) — 비밀 없음(주소 · 토큰 · 키 없음). */
export function diagBody(now = Date.now()) {
  return {
    rttMs: lastRttMs, fails, buffered: samples.length, dropped, collectors: runner.running().length, testsBusy: testsInFlight.size,
    idleMs: nextDelayMs({ active: false, idleHintMs }), lastError: lastError || null, lastErrorAgoMs: lastError ? Math.max(0, now - lastErrorAt) : null,
  };
}

/** 중앙이 깨웠다(collector 라우트). */
export function wakeFocusMon() { wakeAsked = true; schedule(0); return true; }

function schedule(ms) { clearTimeout(timer); if (!config.agent.centralUrl) return; timer = setTimeout(() => { syncOnce().catch(() => {}); }, ms); timer.unref?.(); }

/** 보류 시한(validUntil)이 지났으면 수집기를 모두 닫는다. */
function expireIfStale() {
  if (Date.now() > validUntil && runner.running().length) { runner.reconcile([]); statuses = {}; }
}
const testsInFlight = new Set(); // 진행 중인 연결 시험 — 같은 시험을 겹쳐 띄우지 않는다(반증 5번)

export async function syncOnce(now = Date.now()) {
  if (!config.agent.centralUrl || !config.agent.centralToken) return null;
  if (running) return null;
  if (now < unsupportedUntil) {
    // 중앙이 이 기능을 모른다(404) — 그래도 보류 시한은 지킨다. 예전에는 이 이른 return 이 아래 finally 의 정리를 건너뛰어
    // 수집기가 중앙 연락 없이 최대 1시간 대상 SSH 를 붙잡았다(반증 7번).
    expireIfStale();
    schedule(nextDelayMs({ active: false, idleHintMs: null })); return null;
  }
  running = true;
  const t0 = Date.now();
  const sendS = samples.slice(); const sendP = procs.slice(); const sendT = testResults.slice();
  try {
    const keyView = focusKeys.publicKeyView();
    const body = JSON.stringify({ v: 1, version: currentVersion(), sentAt: Date.now(), key: keyView, samples: sendS, procs: sendP, status: statuses, tests: sendT, diag: diagBody() });
    let payload = body; let hdrs = { 'Content-Type': 'application/json' };
    try { payload = await gzipAsync(Buffer.from(body)); hdrs = { ...hdrs, 'Content-Encoding': 'gzip' }; } catch { /* 원문 */ }
    const r = await resilientFetch(withAgentQuery(`${config.agent.centralUrl}/api/central/focus-mon/sync`, config.agent.name), {
      method: 'POST', headers: { ...hdrs, ...agentHeaders(config.agent.name), 'X-Central-Token': config.agent.centralToken },
      body: payload, timeoutMs: 20_000, retries: 0,
    });
    if (r.status === 404) {
      const c = await classifyCentral404(r);
      if (c.kind === 'no-endpoint') unsupportedUntil = Date.now() + 3_600_000;
      _last = { at: Date.now(), ok: false, status: 404, kind: c.kind, reason: c.reason }; noteFail(`HTTP 404 — ${c.reason}`);
      if (_log('sync', `404 ${c.kind}`)) console.warn(`[focusmon-edge] 중앙 동기화 실패: ${c.reason}`);
      return _last;
    }
    let data = null; try { data = await r.json(); } catch { data = null; }
    if (!r.ok || !data || data.ok !== true) {
      _last = { at: Date.now(), ok: false, status: r.status, reason: String(data?.reason || '').slice(0, 200) }; noteFail(`HTTP ${r.status}${_last.reason ? ` — ${_last.reason}` : ''}`);
      if (_log('sync', `${r.status} ${_last.reason}`)) console.warn(`[focusmon-edge] 중앙 동기화 실패: HTTP ${r.status}${_last.reason ? ` — ${_last.reason}` : ''}`);
      return _last;
    }
    // 보낸 만큼만 지운다(보내는 동안 새로 쌓인 것은 남긴다)
    samples.splice(0, sendS.length); procs.splice(0, sendP.length); testResults = testResults.slice(sendT.length);
    validUntil = Date.now() + Math.min(60_000, Math.max(5_000, Number(data.validUntil) - Number(data.now) || 30_000));
    const targets = Array.isArray(data.targets) ? data.targets.slice(0, 200) : [];
    lastTargets = targets.length;
    lastRttMs = Date.now() - t0; fails = 0;
    idleHintMs = Number.isFinite(Number(data.idleMs)) && Number(data.idleMs) > 0 ? Number(data.idleMs) : null;
    if (data.ensureKey === true) { try { focusKeys.ensureKey(); } catch (e) { if (_log('key', e.message)) console.warn(`[focusmon-edge] SSH 키를 만들지 못했습니다: ${e.message}`); } }
    runner.reconcile(targets.map((t) => ({ id: String(t.id), host: String(t.host), port: Number(t.port) || 22, username: String(t.username), interval: Number(t.interval) || 2 })));
    const byId = new Map(targets.map((t) => [String(t.id), { id: String(t.id), host: String(t.host), port: Number(t.port) || 22, username: String(t.username) }]));
    // v2.978: 중앙이 retryTargets(접속 정보)를 주면 수집 중이 아닌 대상도 정지를 푼다 — 이어 오는 시험(tests)이 한 번 접속한다(retries 를 tests 보다 먼저 처리).
    for (const t of Array.isArray(data.retryTargets) ? data.retryTargets.slice(0, 50) : []) {
      if (t && typeof t === 'object' && !byId.has(String(t.id))) byId.set(String(t.id), { id: String(t.id), host: String(t.host), port: Number(t.port) || 22, username: String(t.username) });
    }
    for (const id of Array.isArray(data.retries) ? data.retries.slice(0, 50) : []) runner.retry(String(id), byId.get(String(id)) || null);
    for (const t of Array.isArray(data.tests) ? data.tests.slice(0, 20) : []) {
      const id = String(t.id);
      if (testsInFlight.has(id)) continue;
      testsInFlight.add(id);
      runner.test({ id, host: String(t.host), port: Number(t.port) || 22, username: String(t.username) })
        .then((result) => { testResults.push({ id, result }); schedule(0); })
        .catch(() => {})
        .finally(() => { testsInFlight.delete(id); });
    }
    _last = { at: Date.now(), ok: true, ms: Date.now() - t0, sent: sendS.length, targets: lastTargets, note: lastTargets ? '' : '수집할 대상이 없습니다.' };
    return _last;
  } catch (e) {
    _last = { at: Date.now(), ok: false, status: 0, reason: String(e?.message || e).slice(0, 200) }; noteFail(_last.reason);
    if (_log('sync', _last.reason)) console.warn(`[focusmon-edge] 중앙 동기화 실패: ${_last.reason}`);
    return _last;
  } finally {
    running = false;
    expireIfStale();
    const active = lastTargets > 0 || wakeAsked;
    wakeAsked = false;
    schedule(nextDelayMs({ active, idleHintMs }));
  }
}

export function startFocusMonWorker() {
  if (!config.agent.centralUrl) return;
  schedule(5_000);
  console.log(`[focusmon-edge] started (central=${config.agent.centralUrl})`);
}

export function stopFocusMonWorker() { clearTimeout(timer); runner.stopAll(); }
export function _resetForTest() { testsInFlight.clear(); samples.length = 0; procs.length = 0; testResults = []; statuses = {}; validUntil = 0; unsupportedUntil = 0; lastTargets = 0; _last = null; dropped = 0; running = false; idleHintMs = null; fails = 0; lastRttMs = null; lastError = ''; lastErrorAt = 0; runner.stopAll(); }
export const _runnerForTest = runner;
