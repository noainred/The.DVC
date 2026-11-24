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
 *  · v2.983 수집 부하: 본문 `load` = 대상별 최신 30초 창(보낸 뒤 비운다) · `diag.node` = 이 엣지 포탈 프로세스의 CPU · 메모리 · 이벤트 루프 지연 · 받은 양 · 중앙으로 보낸 양.
 *    중앙 응답의 `procEvery`(프로세스 표본 주기 — 중앙 설정)를 수집기에 넘긴다(옛 중앙이면 칸이 없어 기본 5초).
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
import { EDGE_TEST_CONCURRENCY } from '../focusmon/store.js';
import { createNodeSampler } from '../focusmon/load.js';
import { createAuditRunner } from '../focusmon/audit/runner.js';
import { installExec, NODE_INSTALL_CONCURRENCY } from '../focusmon/audit/install.js'; // v3.17.0 자동 설치(이 엣지의 SSH 공용 접속 키로)
import { installCredFor, credView, credSnapshot, PREP_FEATURE } from '../focusmon/audit/installCred.js';
import { prepExec } from '../focusmon/audit/prep.js'; // v3.18.0 접속 자동 준비(수집 계정 · 공개키 — 이 엣지의 SSH 공용 접속 root 키로)
import { store } from '../store.js';
const TEST_RESULTS_PER_SYNC = 50; // 중앙이 동기화당 받는 시험 결과 상한(central/focusMonEdge.js arr(b.tests, 50))과 같게 — 넘는 것은 다음 동기화에(반증 3)

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
let loads = {}; // v2.983 대상별 최신 수집 부하 창(보내면 비운다)
let txBytes = 0; let nodeLast = null; let nodePrevTx = null; let nodeSampler = null;
/**
 * v2.983 이 엣지의 노드 표본(30초마다 · 동기화 본문 diag.node 에 싣는다). 중앙으로 보낸 양(압축 뒤 본문 바이트)도 같은 창으로.
 * 반증 F2: **수집기가 돌 때만** 표본기를 만든다(쉬는 엣지에 이벤트 루프 측정기를 늘 켜 두지 않는다) · 0 이 되면 끄고 표본을 비운다.
 */
export function nodeSampleTick(now = Date.now()) {
  if (!runner.running().length) { try { nodeSampler?.stop(); } catch { /* */ } nodeSampler = null; nodeLast = null; nodePrevTx = null; return null; }
  if (!nodeSampler) nodeSampler = createNodeSampler({ sessions: () => runner.running().length });
  const x = nodeSampler.sample();
  if (!x) return nodeLast;
  const txBps = nodePrevTx && now > nodePrevTx.at ? Math.round(((txBytes - nodePrevTx.bytes) / ((now - nodePrevTx.at) / 1000)) * 100) / 100 : null;
  nodePrevTx = { at: now, bytes: txBytes };
  nodeLast = { ...x, txBps };
  return nodeLast;
}
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
    load: (id, l) => { loads[id] = l; },
  },
});

/*
 * v3.11.0 디스크 점검 — 중앙이 동기화 응답 audit.jobs 로 준 작업을 이 엣지가 돌린다(노드당 동시 1 · 대기열). 결과는 **원문**(준비 줄 · 실행 줄)으로
 * 다음 동기화 본문 audit.results 에 싣고, 중앙이 ack 한 것만 지운다(실패하면 다시 보낸다 · 최대 AUDIT_RESULTS_MAX 건 · 오래된 것부터 버리고 센다).
 * 진행 중 목록은 audit.active(작업 id · 상태 · 단계 — 보낼 결과가 남은 작업은 'sending')로 — 중앙이 같은 작업을 다시 내려보내지 않고, 시한을 잇게.
 * 이 본문에는 집중 모니터링 표본도 함께 실린다 — 점검 결과 하나 때문에 동기화가 막히면 이 엣지의 수집 전체가 멈춘다(반증 F1). 그래서:
 *  · 결과 하나의 직렬화 크기 상한 `AUDIT_RESULT_MAX_BYTES`(중앙 BIG_JSON 16MB 보다 작게) — 넘으면 원문을 빼고 'too-big' 으로 싣는다.
 *  · 결과를 실은 동기화가 실패하면 다음 한 번은 결과 없이 보낸다(표본 · 보류 시한이 먼저) · 413 이면 그 결과의 원문을 버린다.
 *  · 보관 시한 `AUDIT_HOLD_MS`(1시간 — 중앙이 'lost' 작업을 기억하는 2시간보다 짧게) — 지나면 버리고 센다(auditDropped · 콘솔 한 번).
 */
// 50회차 R1(재현): 4건 상한은 v3.11 디스크 점검(동시 1) 기준이었다 — v3.17 설치 · v3.18 접속 준비는 동시 4 · 중앙이 한 번에 20건까지 내려보내
//   빨리 끝난 결과(예: 같은 root 키 3대 거부 뒤 'key-stopped')가 5건째부터 소리 없이 밀려나 중앙에 'lost' 로 남았다. 개수는 일괄 규모 이상으로,
//   메모리는 바이트 상한(AUDIT_QUEUE_MAX_BYTES)으로 묶고, 버리면 콘솔에 남긴다.
const AUDIT_RESULTS_MAX = 64;
export const AUDIT_QUEUE_MAX_BYTES = 32 * 1024 * 1024;
const AUDIT_BYTES_PER_SYNC = 6 * 1024 * 1024;
/** 동기화 한 번에 싣는 결과 수 — 중앙 focusmon/audit/service.js RESULTS_PER_SYNC 와 같게(넘는 것은 다음 동기화에). */
export const AUDIT_RESULTS_PER_SYNC = 8;
export const AUDIT_RESULT_MAX_BYTES = 10 * 1024 * 1024;
const AUDIT_TOO_BIG_ON_413 = 1024 * 1024;   // 51회차 #5
export const AUDIT_HOLD_MS = 60 * 60_000;
let auditResults = []; let auditDropped = 0; let auditSkipNext = false;
const tooBig = (result, size) => ({ mode: result?.mode === 'check' ? 'check' : 'run', ok: false, ran: result?.ran === true, kind: 'too-big', ready: Array.isArray(result?.ready) ? result.ready.slice(0, 200) : [], out: [], outBytes: result?.outBytes || 0, truncated: true, code: result?.code ?? null, stderr: '', ms: result?.ms || 0, error: `결과가 너무 커서(${Math.round(size / 2 ** 20)}MB) 원문을 보내지 못했습니다.` });
/** 결과 하나를 보낼 줄에 세운다(크기 · 개수 상한). 시험에서도 부른다. */
export function queueAuditResult(runId, result, now = Date.now()) {
  let r = result; let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(r)); } catch { size = Infinity; }
  if (size > AUDIT_RESULT_MAX_BYTES) { r = tooBig(result, size); size = Buffer.byteLength(JSON.stringify(r)); }
  auditResults.push({ runId: String(runId), result: r, size, at: now });
  let dropped = 0;
  while (auditResults.length > AUDIT_RESULTS_MAX) { auditResults.shift(); dropped += 1; }
  // 51회차 #6: 바이트 상한을 넘으면 **가장 큰 것부터** 버린다(오래된 것부터 버리면 큰 결과 하나 자리를 만드느라 작은 설치 · 준비 결과 수십 건이 사라졌다)
  while (auditResults.length > 1 && auditResults.reduce((a, x) => a + (x.size || 0), 0) > AUDIT_QUEUE_MAX_BYTES) {
    let big = 0; for (let i = 1; i < auditResults.length; i++) if ((auditResults[i].size || 0) > (auditResults[big].size || 0)) big = i;
    auditResults.splice(big, 1); dropped += 1;
  }
  if (dropped) { auditDropped += dropped; console.warn(`[focus-mon] 보낼 점검 · 설치 · 준비 결과 ${dropped}건을 버렸습니다(대기열 상한 ${AUDIT_RESULTS_MAX}건 · ${AUDIT_QUEUE_MAX_BYTES / 2 ** 20}MB) — 중앙에는 'lost' 로 남습니다`); }
}
const auditRunner = createAuditRunner({
  keys: focusKeys,
  onResult: (job, result) => { queueAuditResult(job.runId, result); schedule(0); },
});
/**
 * v3.17.0 자동 설치 — 중앙이 준 'install' 작업을 이 엣지가 자기 SSH 공용 접속의 키로 돌린다(키는 법인 밖으로 나가지 않는다 · 동시 NODE_INSTALL_CONCURRENCY).
 * 설치 계정 상태(비밀 없음 — 상태 · 계정 이름 · 키 이름)는 중앙이 알려 준 맡은 서버 목록(audit.known)으로 60초에 한 번 audit.cred 에 싣는다 —
 * 중앙은 이 보고가 있는(이 판 이상인) 엣지에만 설치 작업을 내려보낸다.
 */
/** 이 엣지가 맡은 법인 = 이 엣지 스냅샷의 vCenter 들(반증 S2 — 공통 계정을 그 법인 것만 쓴다 · bmOnboardPull 과 같은 출처). */
export function edgeVcs() {
  try { return (store.get()?.vcenters || []).filter((v) => v && v.id).slice(0, 100).map((v) => String(v.id)); } catch { return []; }
}
const installRunner = createAuditRunner({
  keys: focusKeys, concurrency: NODE_INSTALL_CONCURRENCY, exec: installExec({ edge: true, edgeVcs }), kind: 'install',
  onResult: (job, result) => { queueAuditResult(job.runId, result); schedule(0); },
});
/** v3.18.0 접속 준비 줄(설치 줄과 따로 — 같은 동시 상한). 준비 뒤 연결 시험은 이 엣지의 집중 모니터링 키로 · 고르면 디스크 점검 설치까지. */
const prepRunner = createAuditRunner({
  keys: focusKeys, concurrency: NODE_INSTALL_CONCURRENCY, exec: prepExec({ edge: true, edgeVcs }), kind: 'prep',
  onResult: (job, result) => { queueAuditResult(job.runId, result); schedule(0); },
});
/** 이 엣지가 돌릴 줄 아는 작업 종류(매 동기화에 싣는다 — 중앙은 이번 본문의 표시만 믿는다 · v3.17.0 반증 S1). */
export const EDGE_AUDIT_CAPS = Object.freeze(['install', 'prep']);
const CRED_EVERY_MS = 60_000;
let knownTargets = []; let credDueAt = 0; let lastPrepReport = null;
/** 이번 동기화에 실을 설치 계정 상태(60초에 한 번 · 맡은 서버 목록을 받았을 때만). 시험에서도 부른다. v3.18.0: 접속 준비 계정도 같이 만든다(credPrepReport). */
export function credReport(now = Date.now(), credOf = installCredFor) {
  if (!knownTargets.length || now < credDueAt) return null;
  credDueAt = now + CRED_EVERY_MS;
  const out = {}; const prep = {}; const corpVcs = edgeVcs();
  const snap = credSnapshot();   // 50회차 R2(측정): 대상 × 기능마다 등록부 전량을 복사해 500 대상 · 1,000 서버에서 매 60초 2초 넘게 막았다
  for (const t of knownTargets) {
    out[t.id] = credView(credOf(t, { edge: true, corpVcs, ...snap }));
    prep[t.id] = credView(credOf(t, { edge: true, corpVcs, feature: PREP_FEATURE, ...snap }));
  }
  lastPrepReport = prep;
  return out;
}
/** credReport 가 같이 만든 접속 준비 계정 상태(같은 동기화에 싣고 비운다). */
export function credPrepReport() { const p = lastPrepReport; lastPrepReport = null; return p; }
export function _setKnownForTest(list) { knownTargets = list; credDueAt = 0; lastPrepReport = null; }
/** 이번 동기화에 실을 결과(바이트 상한 — 큰 보고서 둘을 한 본문에 싣지 않는다 · 하나는 늘 싣는다 — 하나는 AUDIT_RESULT_MAX_BYTES 이하다). */
export function auditResultsToSend() {
  if (auditSkipNext) return [];
  const out = []; let bytes = 0;
  for (const r of auditResults) {
    const b = r.size || 0;
    if (out.length && bytes + b > AUDIT_BYTES_PER_SYNC) break;
    out.push(r); bytes += b;
    if (out.length >= AUDIT_RESULTS_PER_SYNC) break;
  }
  return out;
}
/** 결과를 실은 동기화가 실패했을 때(sent = 실은 결과 · status = HTTP 상태). 시험에서도 부른다. */
export function auditSendFailed(sent, status, now = Date.now()) {
  if (!sent.length) return;
  auditSkipNext = true;
  if (status === 413) {
    // 51회차 #5(재현): 413 원인이 표본 · 프로세스여도 실린 결과 전부(이제 최대 8건)를 too-big 으로 바꿔, 성공한 설치 · 준비가 중앙에 'unreachable' 로 남았다 —
    //   원문이 큰 결과(1MB 넘음)는 곧바로, 작은 결과는 413 을 두 번 함께 맞았을 때만 원문을 뺀다(같은 본문으로 영원히 막히지 않게 — 첫 번은 한 번 건너뛴 뒤 그대로 다시).
    const ids = new Set(sent.map((r) => r.runId));
    auditResults = auditResults.map((r) => {
      if (!ids.has(r.runId) || r.result.kind === 'too-big') return r;
      const hits = (r.hits413 || 0) + 1;
      return r.size > AUDIT_TOO_BIG_ON_413 || hits >= 2 ? { ...r, result: tooBig(r.result, r.size), size: 4096, hits413: hits } : { ...r, hits413: hits };
    });
  }
  expireAuditResults(now);
}
/** 보관 시한이 지난 결과를 버린다(센다). */
export function expireAuditResults(now = Date.now()) {
  const before = auditResults.length;
  auditResults = auditResults.filter((r) => now - (r.at || now) <= AUDIT_HOLD_MS);
  const n = before - auditResults.length;
  if (n) { auditDropped += n; if (_log('audit-drop', String(n))) console.warn(`[focusmon-edge] 디스크 점검 결과 ${n}건을 ${AUDIT_HOLD_MS / 60_000}분 안에 중앙에 보내지 못해 버렸습니다.`); }
}
export function _auditForTest() { return { get results() { return auditResults; }, get dropped() { return auditDropped; }, get skipNext() { return auditSkipNext; }, reset() { auditResults = []; auditDropped = 0; auditSkipNext = false; } }; }

/** buf 에서 sent 에 든 원소(같은 객체)만 뺀다 — 제자리 · O(n). */
function dropSent(buf, sent) {
  if (!sent.length || !buf.length) return;
  const s = new Set(sent);
  let w = 0;
  for (let i = 0; i < buf.length; i++) if (!s.has(buf[i])) buf[w++] = buf[i];
  buf.length = w;
}
export const _dropSentForTest = dropSent;

function trim(buf) {
  const cut = Date.now() - BUF_AGE_MS;
  let k = 0; while (k < buf.length && (buf[k].t < cut || buf.length - k > BUF_MAX)) k += 1;
  if (k) { buf.splice(0, k); dropped += k; }
}

export function focusMonWorkerStatus() {
  return { enabled: !!config.agent.centralUrl, running: runner.running().length, buffered: samples.length, dropped, validUntil, idleMs: nextDelayMs({ active: false, idleHintMs }), fails, audits: auditRunner.size(), auditResults: auditResults.length, auditDropped, ...(_last || {}) };
}

/** 중앙에 보내는 연결 진단(v2.978) — 비밀 없음(주소 · 토큰 · 키 없음). */
export function diagBody(now = Date.now()) {
  return {
    rttMs: lastRttMs, fails, buffered: samples.length, dropped, collectors: runner.running().length, testsBusy: testsInFlight.size,
    idleMs: nextDelayMs({ active: false, idleHintMs }), lastError: lastError || null, lastErrorAgoMs: lastError ? Math.max(0, now - lastErrorAt) : null,
    ...(nodeLast ? { node: { windowS: nodeLast.windowS, cpuPct: nodeLast.cpuPct, fmPct: nodeLast.fmPct, rssBytes: nodeLast.rssBytes, elMaxMs: nodeLast.elMaxMs, eluPct: nodeLast.eluPct, rxBps: nodeLast.rxBps, sessions: nodeLast.sessions, txBps: nodeLast.txBps } } : {}),
  };
}

/** 중앙이 깨웠다(collector 라우트). */
export function wakeFocusMon() { wakeAsked = true; schedule(0); return true; }

let nodeTimer = null;
function schedule(ms) {
  clearTimeout(timer); if (!config.agent.centralUrl) return; timer = setTimeout(() => { syncOnce().catch(() => {}); }, ms); timer.unref?.();
  if (!nodeTimer) { nodeSampleTick(); nodeTimer = setInterval(() => { try { nodeSampleTick(); } catch { /* */ } }, 30_000); nodeTimer.unref?.(); }
}

/** 보류 시한(validUntil)이 지났으면 수집기를 모두 닫는다. */
function expireIfStale() {
  if (Date.now() > validUntil && runner.running().length) { runner.reconcile([]); statuses = {}; loads = {}; }
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
  const sendS = samples.slice(); const sendP = procs.slice(); const sendT = testResults.slice(0, TEST_RESULTS_PER_SYNC);
  const sendL = loads; loads = {}; let sentOk = false; // v2.983 — 실패하면 finally 에서 되돌린다(그사이 새 창이 왔으면 새 것이 이긴다)
  let sentAudit = []; let failStatus = 0;
  try {
    const keyView = focusKeys.publicKeyView();
    const sendA = auditResultsToSend();
    auditSkipNext = false; // 한 번만 건너뛴다
    sentAudit = sendA;
    const auditActive = [...auditRunner.list(), ...installRunner.list(), ...prepRunner.list()].map((j) => ({ runId: j.runId, state: j.state, phase: j.phase || null })).concat(auditResults.map((r) => ({ runId: r.runId, state: 'sending', phase: null })));
    const cred = credReport(); const credPrep = cred ? credPrepReport() : null;
    // v3.17.0 반증 S1: 설치를 돌릴 줄 아는 엣지라고 **매 동기화** 알린다(caps) — 중앙은 이번 본문에 이 표시가 있을 때만 설치 작업을 내려보낸다
    //   (설치 계정 보고가 10분 안에 있었다는 것만으로는 그사이 옛 판으로 내려간 엣지를 가르지 못한다)
    const auditBody = { audit: { active: auditActive, results: sendA.map((r) => ({ runId: r.runId, result: r.result })), caps: [...EDGE_AUDIT_CAPS], ...(cred ? { cred } : {}), ...(credPrep ? { credPrep } : {}) } };
    const body = JSON.stringify({ v: 1, version: currentVersion(), sentAt: Date.now(), key: keyView, samples: sendS, procs: sendP, status: statuses, tests: sendT, load: sendL, diag: diagBody(), ...auditBody });
    let payload = body; let hdrs = { 'Content-Type': 'application/json' };
    try { payload = await gzipAsync(Buffer.from(body)); hdrs = { ...hdrs, 'Content-Encoding': 'gzip' }; } catch { /* 원문 */ }
    txBytes += payload.length;
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
      failStatus = r.status;
      _last = { at: Date.now(), ok: false, status: r.status, reason: String(data?.reason || '').slice(0, 200) }; noteFail(`HTTP ${r.status}${_last.reason ? ` — ${_last.reason}` : ''}`);
      if (_log('sync', `${r.status} ${_last.reason}`)) console.warn(`[focusmon-edge] 중앙 동기화 실패: HTTP ${r.status}${_last.reason ? ` — ${_last.reason}` : ''}`);
      return _last;
    }
    // 보낸 것만 지운다(보내는 동안 새로 쌓인 것은 남긴다). 전체 점검 15회차(A-2): 개수가 아니라 원소로 — 기다리는 동안 trim 이 보낸 앞쪽을 이미 지웠으면
    //   splice(0, 보낸 개수)가 보내지 않은 새 표본까지 지웠다(고RTT · 버퍼 상한 · 중앙이 끊겼다 돌아온 직후)
    dropSent(samples, sendS); dropSent(procs, sendP); testResults = testResults.slice(sendT.length);
    sentOk = true;
    validUntil = Date.now() + Math.min(60_000, Math.max(5_000, Number(data.validUntil) - Number(data.now) || 30_000));
    const targets = Array.isArray(data.targets) ? data.targets.slice(0, 200) : [];
    lastTargets = targets.length;
    lastRttMs = Date.now() - t0; fails = 0;
    idleHintMs = Number.isFinite(Number(data.idleMs)) && Number(data.idleMs) > 0 ? Number(data.idleMs) : null;
    if (data.ensureKey === true) { try { focusKeys.ensureKey(); } catch (e) { if (_log('key', e.message)) console.warn(`[focusmon-edge] SSH 키를 만들지 못했습니다: ${e.message}`); } }
    runner.reconcile(targets.map((t) => ({ id: String(t.id), host: String(t.host), port: Number(t.port) || 22, username: String(t.username), interval: Number(t.interval) || 2, procEvery: Number(t.procEvery) || 5 })));
    const byId = new Map(targets.map((t) => [String(t.id), { id: String(t.id), host: String(t.host), port: Number(t.port) || 22, username: String(t.username) }]));
    // v2.978: 중앙이 retryTargets(접속 정보)를 주면 수집 중이 아닌 대상도 정지를 푼다 — 이어 오는 시험(tests)이 한 번 접속한다(retries 를 tests 보다 먼저 처리).
    for (const t of Array.isArray(data.retryTargets) ? data.retryTargets.slice(0, 50) : []) {
      if (t && typeof t === 'object' && !byId.has(String(t.id))) byId.set(String(t.id), { id: String(t.id), host: String(t.host), port: Number(t.port) || 22, username: String(t.username) });
    }
    for (const id of Array.isArray(data.retries) ? data.retries.slice(0, 50) : []) runner.retry(String(id), byId.get(String(id)) || null);
    for (const t of Array.isArray(data.tests) ? data.tests.slice(0, 20) : []) {
      const id = String(t.id);
      if (testsInFlight.has(id)) continue;
      if (testsInFlight.size >= EDGE_TEST_CONCURRENCY) break; // 동시 상한(반증 1) — 중앙은 diag.testsBusy 로 덜 보낸다. 넘친 것은 중앙이 60초 뒤 다시 배달
      testsInFlight.add(id);
      runner.test({ id, host: String(t.host), port: Number(t.port) || 22, username: String(t.username) })
        .then((result) => { testResults.push({ id, result }); schedule(0); })
        .catch(() => {})
        .finally(() => { testsInFlight.delete(id); });
    }
    // v3.11.0 디스크 점검 — 받은 결과는 지우고(ack) 새 작업을 줄에 세운다(같은 작업 · 결과가 아직 남은 작업은 건너뛴다)
    const au = data.audit && typeof data.audit === 'object' ? data.audit : null;
    if (au) {
      const acked = new Set((Array.isArray(au.ack) ? au.ack : []).map(String));
      if (acked.size) auditResults = auditResults.filter((r) => !acked.has(r.runId));
      // 중앙이 모르는 작업(접속처 변경 · 대상 삭제) — 줄에서 기다리는 것은 뺀다(도는 중인 것은 끝까지 — 결과는 중앙이 버린다)
      for (const id of Array.isArray(au.cancel) ? au.cancel.slice(0, 50) : []) { auditRunner.cancel(String(id)); installRunner.cancel(String(id)); prepRunner.cancel(String(id)); }
      // v3.17.0: 맡은 서버 목록(설치 계정 상태를 알려 주려고) — 받으면 다음 동기화에 바로 보고한다
      if (Array.isArray(au.known)) { knownTargets = au.known.slice(0, 500).filter((t) => t && typeof t.id === 'string').map((t) => ({ id: String(t.id), name: String(t.name || ''), host: String(t.host || ''), port: Number(t.port) || 22 })); credDueAt = 0; }
      for (const j of Array.isArray(au.jobs) ? au.jobs.slice(0, 20) : []) {
        if (!j || typeof j.runId !== 'string' || auditRunner.has(j.runId) || installRunner.has(j.runId) || prepRunner.has(j.runId) || auditResults.some((r) => r.runId === j.runId)) continue;
        const ex = j.expect && typeof j.expect === 'object' ? j.expect : {};
        // 기대 판본 · 후보 디렉터리 · 설치 값은 글자 모양만 맞춰 넘긴다 — 디렉터리 검사(bundle.dirIssue)는 runner · install 이 다시 한다
        const expect = { program: String(ex.program || ''), wrapper: String(ex.wrapper || ''),
          ...(Array.isArray(ex.cands) ? { cands: ex.cands.slice(0, 3).map((d) => (typeof d === 'string' ? d : '')) } : {}),
          ...(ex.wrappers && typeof ex.wrappers === 'object' && !Array.isArray(ex.wrappers) ? { wrappers: Object.fromEntries(Object.entries(ex.wrappers).slice(0, 3).map(([k, v]) => [String(k), String(v)])) } : {}),
          ...(j.mode === 'install' || j.mode === 'prep' ? { dir: typeof ex.dir === 'string' ? ex.dir : '', oldDirs: Array.isArray(ex.oldDirs) ? ex.oldDirs.slice(0, 3).map((d) => (typeof d === 'string' ? d : '')) : [], pick: typeof ex.pick === 'string' ? ex.pick : null } : {}),
          // v3.18.0 접속 준비 — 참거짓 · 정해 둔 값만(중앙이 보낸 법인 목록은 쓰지 않는다 — 엣지 스냅샷 vCenter)
          ...(j.mode === 'prep' ? { from: ex.from === true, age: ex.age === 'default' ? 'default' : 'never', audit: ex.audit === true } : {}) };
        const tgt = { id: String(j.id), name: String(j.name || ''), host: String(j.host), port: Number(j.port) || 22, username: String(j.username) };
        const sub = j.mode === 'install'
          ? installRunner.submit({ runId: j.runId, mode: 'install', target: tgt, expect })
          : j.mode === 'prep'
            ? prepRunner.submit({ runId: j.runId, mode: 'prep', target: tgt, expect })
            : auditRunner.submit({ runId: j.runId, mode: j.mode === 'check' ? 'check' : 'run', target: tgt, expect });
        // 받지 못한 작업은 결과로 알린다(반증 F3 — 예전에는 소리 없이 버려 중앙이 3번 다시 보낸 뒤 'lost' 로 지웠다)
        if (!sub.ok) queueAuditResult(j.runId, { mode: j.mode === 'check' ? 'check' : j.mode === 'install' ? 'install' : j.mode === 'prep' ? 'prep' : 'run', ...(j.mode === 'install' ? { install: { code: 'unreachable', step: 0 } } : {}), ...(j.mode === 'prep' ? { prep: { code: sub.code === 'queue-full' ? 'queue-full' : 'busy', step: 0 } } : {}), ok: false, kind: sub.code === 'queue-full' ? 'queue-full' : 'busy', ready: [], out: [], outBytes: 0, truncated: false, code: null, stderr: '', ms: 0, error: sub.code === 'queue-full' ? '엣지 점검 대기열이 가득 찼습니다.' : '이 엣지에서 같은 서버의 이전 점검 작업이 아직 끝나지 않았습니다.' });
      }
    }
    _last = { at: Date.now(), ok: true, ms: Date.now() - t0, sent: sendS.length, targets: lastTargets, note: lastTargets ? '' : '수집할 대상이 없습니다.' };
    return _last;
  } catch (e) {
    _last = { at: Date.now(), ok: false, status: 0, reason: String(e?.message || e).slice(0, 200) }; noteFail(_last.reason);
    if (_log('sync', _last.reason)) console.warn(`[focusmon-edge] 중앙 동기화 실패: ${_last.reason}`);
    return _last;
  } finally {
    if (!sentOk) { loads = { ...sendL, ...loads }; auditSendFailed(sentAudit, failStatus); } else expireAuditResults();
    running = false;
    expireIfStale();
    const active = lastTargets > 0 || wakeAsked || auditRunner.size() > 0 || installRunner.size() > 0 || prepRunner.size() > 0 || auditResults.length > 0;
    wakeAsked = false;
    schedule(nextDelayMs({ active, idleHintMs }));
  }
}

export function startFocusMonWorker() {
  if (!config.agent.centralUrl) return;
  schedule(5_000);
  console.log(`[focusmon-edge] started (central=${config.agent.centralUrl})`);
}

export function stopFocusMonWorker() { clearTimeout(timer); clearInterval(nodeTimer); nodeTimer = null; try { nodeSampler?.stop(); } catch { /* */ } nodeSampler = null; runner.stopAll(); }
/** v2.983 시험용 — 수집 부하 창을 넣는다(실수집 없이 동기화 본문을 시험). */
export function _putLoadForTest(id, l) { loads[id] = l; }
export function _loadsForTest() { return { ...loads }; }
export function _resetForTest() { auditResults = []; auditDropped = 0; loads = {}; txBytes = 0; nodeLast = null; nodePrevTx = null; testsInFlight.clear(); samples.length = 0; procs.length = 0; testResults = []; statuses = {}; validUntil = 0; unsupportedUntil = 0; lastTargets = 0; _last = null; dropped = 0; running = false; idleHintMs = null; fails = 0; lastRttMs = null; lastError = ''; lastErrorAt = 0; runner.stopAll(); }
export const _runnerForTest = runner;
