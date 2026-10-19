/**
 * 위임 iDRAC 스캔 워커 — CENTRAL_URL이 설정된 현장 에이전트에서 동작.
 *  1) 중앙에서 자기 이름(AGENT_NAME)의 온디맨드 스캔 잡을 인출하고
 *  2) 그 대역을 로컬에서 Redfish 스캔해 Dell iDRAC만 골라낸 뒤
 *  3) (autoRegister 시) 현지 레지스트리에 등록해 즉시 전력 수집을 시작하고
 *  4) 발견 목록·요약을 reqId와 함께 중앙으로 회신한다.
 * 응답성을 위해 짧은 주기(기본 5s)로 폴링하되, 대기 잡이 없으면 스캔하지 않는다.
 */

import { config, clampIntervalMs } from '../config.js';
import { resilientFetch, retryDelayMs } from '../util/resilientFetch.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { runLocalIdracScan } from '../idrac/localScan.js';
import { registerScanned } from '../idrac/registry.js';
import { pollNow } from '../idrac/poller.js';
import { tryAcquireScan, releaseScan, scanLockBusy } from '../idrac/scanPoller.js'; // v2.612 EDGE2612-01

let timer = null;
import { centralStatusOnlySupport } from './centralStatusOnly.js';
/** v2.622(감사 RECENT-03·EDGE-02): 중앙 /idrac-scan-jobs 가 ?busy=1(인출 없는 생존 폴)을 이해하는 첫 버전. */
export const IDRAC_BUSY_POLL_MIN_CENTRAL = '2.622.0';
let _busyCapImpl = null;
/** 테스트 주입용 — 중앙 버전 확인을 바꾼다(null 이면 health-probe). */
export function _setBusyPollSupportForTest(fn) { _busyCapImpl = typeof fn === 'function' ? fn : null; }
function busyPollSupport() {
  if (_busyCapImpl) return Promise.resolve(_busyCapImpl());
  return centralStatusOnlySupport({ minVersion: IDRAC_BUSY_POLL_MIN_CENTRAL });
}
import { agentNameHeader } from '../util/agentNameHeader.js'; // v2.620(RECENT2620-02)
let last = null;
// v2.599 T2599-02: 주기 env 도 [하한, MAX_TIMER_MS] 로 가둔다 — 2^31 초과·음수는 setInterval 에서 1ms 루프가 된다.
const POLL_MS = clampIntervalMs(Number(process.env.AGENT_IDRAC_SCAN_POLL_MS) || 5_000, 5_000, 1_000);

function headers() {
  return { 'Content-Type': 'application/json', ...agentNameHeader(config.agent.name), ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

/*
 * v2.742(감사 EDGE-03): 결과 회신은 **호출 안에서 같은 본문을 다시 보내지 않는다**(retries 0). 예전에는 resilientFetch 의 retries:2 로
 *   중앙의 503·5xx 에 400·800ms 간격으로 같은 큰 본문(발견 목록·IP 목록)을 3번 올렸다 — 지속형 오류면 세 번 다 같은 결과다.
 *   대신 보내지 못한 회신을 **미전송 목록**에 두고 다음 폴 주기(기본 5초)부터 간격을 두 배씩 늘려(상한 5분, Retry-After 가 더 길면 그것)
 *   다시 보낸다 — 이 회신은 1회성이라(주기 재전송이 따로 없다) 버리면 중앙 잡이 '진행 중' 으로 남다가 만료된다. 중앙은 늦은 결과·같은 결과의
 *   재전송을 받는다(v2.621 EDGE-07 멱등). 재시도 대상은 일시 상태(408·425·429·500·502·503·504)와 연결 오류뿐이고, 410(중앙에 잡이 없음)·
 *   그 밖의 4xx(토큰·버전)는 다시 보내도 같은 결과라 버린다. 처음 보낸 뒤 30분이 지나면 버리고 콘솔·상태에 남긴다(조용한 소실 금지).
 * v2.744(감사 TIMING-01 — 재현): 예전에는 '최대 6번' 이 30분보다 먼저 걸렸다 — 백오프가 5·10·20·40·80초라 처음 보낸 뒤 **약 2.6분**
 *   (+5·+15·+35·+75·+155초)에 버렸다. 중앙은 마지막 활동 뒤 약 20분(잡 만료 10분 + 완료 보존 10분) 동안 늦은 결과를 받으므로
 *   3~15분 회선 단절·지속형 503 이면 받을 수 있는 결과를 엣지가 먼저 버렸다. 이제 버리는 기준은 **나이**(UNSENT_MAX_AGE_MS)다 —
 *   폴 주기 5초·백오프 상한 5분이면 +5·+15·+35·+75·+155·+315·+615·+915·+1215·+1515초에 다시 보내고 마지막 시도는 정확히
 *   +1800초(나이 상한에 맞춰 당긴다)다 — 처음 포함 약 12번. 시도 횟수 상한(UNSENT_MAX_ATTEMPTS)은 나이보다 먼저 걸리지 않게
 *   폭주 방지용으로만 둔다(폴 주기 하한 1초에서도 30분 안 시도는 15번 안팎이다). 미전송 보관 상한 8건은 그대로다.
 */
const RESULT_RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const UNSENT_MAX = 8;                 // 미전송 회신 보관 상한(넘치면 가장 오래된 것부터 버리고 밝힌다)
const UNSENT_MAX_ATTEMPTS = 40;       // v2.744(TIMING-01): 폭주 방지용 안전 상한 — 실제로 버리는 기준은 나이다(위 주석)
const UNSENT_MAX_AGE_MS = 30 * 60_000;   // 중앙이 늦은 결과를 받는 창(만료 10분 + 보존 10분)보다 짧지 않게
const UNSENT_BACKOFF_MAX_MS = 5 * 60_000;
let _unsent = [];                     // [{ payload, attempts, firstAt, nextAt, lastError }]
let _unsentDropped = null;            // 마지막으로 버린 회신 { at, reqId, attempts, reason }
const backoffMs = (attempts) => Math.min(UNSENT_BACKOFF_MAX_MS, POLL_MS * 2 ** Math.max(0, attempts - 1));
/** v2.744(TIMING-01): 테스트가 창을 계산할 수 있게 상수를 내보낸다. */
export const UNSENT_RETRY_WINDOW = Object.freeze({ maxAgeMs: UNSENT_MAX_AGE_MS, backoffMaxMs: UNSENT_BACKOFF_MAX_MS, maxAttempts: UNSENT_MAX_ATTEMPTS, keep: UNSENT_MAX, pollMs: POLL_MS });

/** 한 번 보낸다(재시도 없음). { ok } · { retry, status?, retryAfter?, error } · { drop, error } */
async function postResultOnce(payload) {
  try {
    const r = await resilientFetch(`${config.agent.centralUrl}/api/central/idrac-scan-result`, {
      method: 'POST', headers: headers(), body: JSON.stringify(payload), timeoutMs: 30_000, retries: 0,
    });
    if (r.ok) return { ok: true };
    try { await r.body?.cancel?.(); } catch { /* 응답 본문은 읽지 않는다 */ }
    // v2.621(감사 EDGE-01): 410 = 중앙에 그 잡이 없다(만료·중앙 재시작). 토큰·버전 문제가 아니므로 원인을 따로 말한다 —
    //   예전 중앙은 이때도 200 이라 여기서 '성공' 으로 적혔고 결과는 조용히 사라졌다.
    if (r.status === 410) {
      console.error(`[idrac-scan-agent] 결과 회신 거절 HTTP 410 (reqId=${payload.reqId}) — 중앙에 이 잡이 없습니다(만료되었거나 중앙이 재시작됨). 결과는 중앙에 반영되지 않았고 현지 등록은 그대로입니다.`);
      return { drop: true, error: '중앙에 잡이 없음(HTTP 410 — 만료·중앙 재시작) — 결과 미반영' };
    }
    if (RESULT_RETRY_STATUS.has(r.status)) return { retry: true, status: r.status, retryAfter: r.headers?.get?.('retry-after') ?? null, error: `HTTP ${r.status}` };
    console.error(`[idrac-scan-agent] 결과 회신 거부 HTTP ${r.status} (reqId=${payload.reqId}) — CENTRAL_TOKEN/중앙 버전을 확인하세요.`);
    return { drop: true, error: `결과 회신 거부(HTTP ${r.status})` };
  } catch (e) {
    return { retry: true, error: String(e?.message || e) };
  }
}

function deferResult(payload, res, attempts, firstAt, now = Date.now()) {
  const want = Math.max(backoffMs(attempts), res.status ? retryDelayMs(res.status, res.retryAfter, 0) : 0);
  // v2.744(TIMING-01): 다음 시도가 나이 상한을 넘기면 상한 시각으로 당긴다 — 마지막 시도를 30분 창의 끝에 한 번 더 한다(그 뒤에 버린다).
  const nextAt = Math.max(now + 1, Math.min(now + want, firstAt + UNSENT_MAX_AGE_MS));
  const wait = nextAt - now;
  _unsent = _unsent.filter((x) => x.payload?.reqId !== payload.reqId); // 같은 잡의 회신은 하나만(나중 것이 이긴다)
  _unsent.push({ payload, attempts, firstAt, nextAt, lastError: res.error || null });
  while (_unsent.length > UNSENT_MAX) {
    const old = _unsent.shift();
    _unsentDropped = { at: now, reqId: old.payload?.reqId || null, attempts: old.attempts, reason: `미전송 회신 보관 상한(${UNSENT_MAX}건) 초과` };
    console.error(`[idrac-scan-agent] 보내지 못한 결과 회신을 버렸습니다(reqId=${_unsentDropped.reqId}) — 미전송 보관 상한 ${UNSENT_MAX}건 초과. 중앙 잡은 만료로 끝납니다.`);
  }
  return wait;
}

async function postResult(payload) {
  // 회신 실패를 무음 처리하면 "엣지는 완주했는데 중앙 잡만 멎는" 상황을 엣지 로그로 진단할 수 없다.
  const res = await postResultOnce(payload);
  if (res.ok) return null;
  if (res.drop) return res.error;
  const wait = deferResult(payload, res, 1, Date.now());
  console.warn(`[idrac-scan-agent] 결과 회신 보류(${res.error}, reqId=${payload.reqId}) — 같은 본문을 바로 다시 보내지 않고 ${Math.round(wait / 1000)}초 뒤 다음 주기에 다시 보냅니다.`);
  return `결과 회신 보류(${res.error}) — 다음 주기에 다시 보냅니다`;
}

/**
 * 미전송 회신 중 때가 된 것을 다시 보낸다(폴 주기마다). 테스트는 now 를 넘겨 '때' 를 앞당긴다.
 * @returns {Promise<{ sent:number, dropped:number, pending:number }>}
 */
export async function flushUnsentResults(now = Date.now()) {
  let sent = 0; let dropped = 0;
  const due = _unsent.filter((x) => x.nextAt <= now);
  for (const item of due) {
    const res = await postResultOnce(item.payload);
    _unsent = _unsent.filter((x) => x !== item);
    if (res.ok) { sent++; if (last && last.reqId === item.payload.reqId && last.postError) last = { ...last, postError: null, postedLate: Date.now() }; continue; }
    const attempts = item.attempts + 1;
    if (res.drop || attempts >= UNSENT_MAX_ATTEMPTS || now - item.firstAt >= UNSENT_MAX_AGE_MS) {
      dropped++;
      _unsentDropped = { at: Date.now(), reqId: item.payload?.reqId || null, attempts, ageMs: Math.max(0, now - item.firstAt), reason: res.error || '실패' };
      if (!res.drop) console.error(`[idrac-scan-agent] 결과 회신을 ${Math.round(Math.max(0, now - item.firstAt) / 60_000)}분 동안 ${attempts}번 보냈지만 받지 않아 버렸습니다(reqId=${_unsentDropped.reqId}, 마지막 ${res.error}) — 중앙 잡은 만료로 끝납니다. 현지 등록은 그대로입니다.`);
      continue;
    }
    deferResult(item.payload, res, attempts, item.firstAt, now);
  }
  return { sent, dropped, pending: _unsent.length };
}

// v2.594(감사 EDGE2-04): 진행 보고의 거부(HTTP 오류)·실패를 삼키지 않는다 — 첫 진행 보고가 중앙에서는 인출 확인(ack)이라
//   조용히 실패하면 화면이 '대기' 로 남는 이유를 알 수 없다. 같은 사유는 10분에 한 줄(스캔 중 반복 호출).
const _progressLog = createChangeLogger({ windowMs: 10 * 60_000 });
const progressWarn = (sig, msg) => { if (_progressLog('progress', sig)) console.warn(`[idrac-scan-agent] ${msg}`); };
async function postProgress(reqId, scanned, total, found) {
  try {
    const r = await resilientFetch(`${config.agent.centralUrl}/api/central/idrac-scan-progress`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ reqId, scanned, total, found }), timeoutMs: 10_000, retries: 2,
    });
    if (r.status === 410) { _progressError = '진행 보고 거절(HTTP 410 — 중앙에 이 잡이 없음: 만료·중앙 재시작)'; progressWarn('progress-410', `진행 보고 거절 HTTP 410 (reqId=${reqId}) — 중앙에 이 잡이 없습니다(만료되었거나 중앙이 재시작됨)`); } // v2.621(EDGE-01)
    else if (!r.ok) { _progressError = `진행 보고 거부(HTTP ${r.status})`; progressWarn(`progress-${r.status}`, `진행 보고 거부 HTTP ${r.status} (reqId=${reqId})`); }
    else _progressError = null;
  } catch (e) {
    _progressError = `진행 보고 실패: ${e.message}`;
    progressWarn('progress-fail', `진행 보고 실패: ${e.message} (reqId=${reqId})`);
  }
}
let _progressError = null;

let running = false; // 재진입 방지(긴 Redfish 스캔이 다음 폴 틱과 겹쳐 별개 잡이 동시 실행되는 것 차단)
export async function runIdracScanWorkerOnce() {
  if (!config.agent.centralUrl) return null;
  if (running) return null;
  running = true;
  try {
    // v2.742(감사 EDGE-03): 지난 주기에 보내지 못한 결과 회신부터(때가 된 것만).
    if (_unsent.length) { try { await flushUnsentResults(); } catch { /* 회신 재전송 실패가 잡 인출을 막지 않는다 */ } }
    return await runIdracScanWorkerInner();
  } finally { running = false; }
}

async function runIdracScanWorkerInner() {
  try {
    // v2.612 EDGE2612-01: 이 엣지에서 스캔(중앙 PUSH·주기)이 도는 중이면 잡을 인출하지 않는다 — 인출하면 겹쳐 돌거나
    //   '이미 수행 중' 으로 끝난다. 인출하지 않은 잡은 중앙 대기열에 남아 다음 폴에 가져간다.
    const busy = scanLockBusy();
    // v2.622(감사 RECENT-03·EDGE-02): 잠금 중에도 **인출 없는 생존 폴**(?busy=1)을 보낸다 — 예전에는 폴 자체를 건너뛰어 중앙의 폴
    //   시각이 멈췄고, 잠금이 10분을 넘기면(큰 대역 스캔) 이 엣지의 대기 잡이 '오프라인' 으로 보여 gc 로 사라졌다.
    //   ⚠ busy 를 모르는 구버전 중앙은 ?busy=1 을 무시하고 잡을 **인출해 준다** — 받은 잡은 잠금 때문에 실행할 수 없고 되돌릴 길도
    //   없어 '이미 수행 중' 오류로 끝난다(예전의 '10분 뒤 만료' 보다 나쁘다). 그래서 health-probe 로 중앙 버전을 확인했을 때만 보내고,
    //   모르면 예전처럼 폴하지 않는다(사유는 상태에 남긴다).
    let busyPoll = false;
    if (busy) {
      const cap = await busyPollSupport();
      if (!cap.ok) { lastSkipBusy = { at: Date.now(), by: busy.by, heartbeat: false, reason: `${cap.reason || 'central-version-unknown'} — 중앙 v${cap.version || '미상'} 이 생존 폴(v${IDRAC_BUSY_POLL_MIN_CENTRAL} 이상)을 모르거나 버전을 읽지 못해 잠금 중에는 폴하지 않습니다` }; return null; }
      busyPoll = true;
    }
    const url = `${config.agent.centralUrl}/api/central/idrac-scan-jobs?agent=${encodeURIComponent(config.agent.name)}${busyPoll ? '&busy=1' : ''}`;
    const r = await resilientFetch(url, { headers: headers(), timeoutMs: 15_000, retries: busyPoll ? 0 : 2 });
    if (!r.ok) {
      // v2.582 BUG-1: 예전에는 여기서 조용히 null — 중앙이 403(개별 토큰 아님·엣지 이름 불일치)이나 5xx 를
      // 돌려줘도 상태 객체·콘솔에 아무것도 남지 않아 '엣지 로그' 화면에서 진단할 길이 없었다
      // (v2.549·v2.561·v2.574 가 형제 워커 6개에 적용한 규약의 누락 지점).
      noteFail(r.status === 403 ? 'auth' : 'http', `HTTP ${r.status}`);
      return null;
    }
    const body = await r.json();
    const jobs = body?.jobs;
    lastPollAt = Date.now(); lastPollError = null; failStreak = 0;
    if (busyPoll) {
      lastSkipBusy = { at: Date.now(), by: busy.by, heartbeat: body?.busyAck === true };
      if (body?.busyAck === true) return null;
      // busyAck 없이 잡이 왔다 = 버전 확인이 빗나간 중앙. 받은 잡은 아래에서 잠금에 막혀 '이미 수행 중' 으로 회신된다(대기로 매달리지 않게).
      if (jobs?.length) console.warn(`[idrac-scan-agent] 중앙이 생존 폴(busy)을 이해하지 못하고 잡 ${jobs.length}건을 넘겼습니다 — 스캔 잠금 중이라 '이미 수행 중' 으로 회신합니다.`);
    }
    if (!jobs || !jobs.length) return null;
    for (const job of jobs) {
      const started = Date.now();
      try {
        // '등록' 잡: UI가 스캔에서 확인한 found 목록을 현지 레지스트리에 등록.
        if (job.action === 'register') {
          // v2.742(감사 DEV-01): 등록 잡에는 대역이 없다 — 엔트리 id 가 오면 표지만 싣고, 교체 범위는 그 표지로만 정한다(대역 미상이면 표지 없는 항목은 지우지 않는다).
          // v2.744(감사 EDGE-03): 자동 경로(auto) — 이 엣지의 iDRAC 등록부를 읽지 못했으면 저장하지 않고 사유를 회신한다(registry.js 주석).
          const rr = registerScanned(job.found || [], job.username, job.password, job.mode || 'merge', job.vcenterId || '', job.datacenterId || '', { ilo: job.ilo || null, scanRangeId: String(job.rangeId || ''), auto: true });
          const registered = rr.ok ? ((rr.added || 0) + (rr.updated || 0)) : 0;
          if (rr.ok) pollNow().catch(() => {});
          if (rr.code === 'registry-unreadable') console.warn(`[idrac-scan-agent] ${config.agent.name}: 등록 잡 ${job.reqId} — ${rr.reason}`);
          // v2.621(감사 EDGE-01): 등록 잡도 회신 실패(410 = 중앙에 잡 없음 등)를 상태에 싣는다 — 스캔 잡(v2.593 EDGE-4)과 같은 규칙.
          const regPostErr = await postResult({ reqId: job.reqId, agent: config.agent.name, scanned: 0, found: job.found || [], foundCount: (job.found || []).length, registered, error: rr.ok ? null : (rr.reason || '등록 실패'), durationMs: Date.now() - started });
          last = { at: Date.now(), reqId: job.reqId, registered, ...(rr.code === 'registry-unreadable' ? { registerError: rr.reason, registryUnreadable: rr.registryUnreadable } : {}), ...(regPostErr ? { postError: regPostErr } : {}) };
          console.log(`[idrac-scan-agent] ${config.agent.name}: 등록 잡 — ${registered}대 현지 등록`);
          continue;
        }
        // 진행률을 중앙에 보고(최소 1.5s 간격으로 스로틀) → UI 프로세스 바. found=현재까지 발견 수.
        let lastSent = 0;
        const onProgress = (scanned, total, found) => {
          const now = Date.now();
          if (now - lastSent < 1500 && scanned < total) return;
          lastSent = now;
          postProgress(job.reqId, scanned, total, found);
        };
        // 스캔+현지등록 코어는 PUSH 엔드포인트와 공유(runLocalIdracScan). durationMs는 헬퍼가 계산.
        // v2.591(감사 F3): 중앙이 싣는 trigger·rangeId — 주기 잡이면 인증 정지 IP 를 건너뛴다(구버전 중앙은 필드가 없어 수동=전부 시도).
        // v2.612 EDGE2612-01: 인출 뒤 스캔 직전에도 잠금을 잡는다(인출과 스캔 사이에 PUSH 가 시작됐을 수 있다).
        //   못 잡으면 겹쳐 돌지 않고 '이미 수행 중' 사유로 회신한다(중앙 잡이 '대기' 로 매달리지 않게).
        const lock = tryAcquireScan('delegated');
        if (!lock.ok) {
          const postErr = await postResult({ reqId: job.reqId, agent: config.agent.name, error: `이미 수행 중: ${lock.reason}`, busy: true });
          last = { at: Date.now(), reqId: job.reqId, error: '이미 수행 중', busy: true, ...(postErr ? { postError: postErr } : {}) };
          console.warn(`[idrac-scan-agent] ${config.agent.name}: 다른 스캔이 진행 중이라 잡 ${job.reqId} 를 실행하지 않았습니다`);
          continue;
        }
        let scan;
        try {
          scan = await runLocalIdracScan({ ips: job.ips, username: job.username, password: job.password, ilo: job.ilo || null, noRegister: job.noRegister, vcenterId: job.vcenterId || '', datacenterId: job.datacenterId || '', mode: job.mode || 'merge', onProgress, trigger: job.trigger === 'periodic' ? 'periodic' : 'manual', rangeId: String(job.rangeId || '') });
        } finally { releaseScan(); }
        // v2.593(감사 EDGE-4): 회신 실패를 콘솔뿐 아니라 상태에도 싣는다 — 엣지 로그 화면이 '성공 모양' 으로 보이지 않게.
        const postErr = await postResult({ reqId: job.reqId, agent: config.agent.name, ...scan });
        last = { at: Date.now(), reqId: job.reqId, foundCount: scan.foundCount, registered: scan.registered, ...(scan.registerError ? { registerError: scan.registerError } : {}), ...(postErr ? { postError: postErr } : {}) };
        console.log(`[idrac-scan-agent] ${config.agent.name}: ${scan.foundCount}/${scan.scanned} iDRAC, ${scan.registered} 현지 등록${job.noRegister ? ' (등록 보류)' : ''}${scan.registerError ? ` — ${scan.registerError}` : ''}`);
      } catch (e) {
        const postErr = await postResult({ reqId: job.reqId, agent: config.agent.name, error: e.message });
        last = { at: Date.now(), reqId: job.reqId, error: e.message, ...(postErr ? { postError: postErr } : {}) };
      }
    }
    return last;
  } catch (e) {
    noteFail(/timeout|abort/i.test(e?.message || '') ? 'timeout' : 'unreachable', e?.message || String(e));
    return null;
  }
}

let lastPollAt = 0; let lastPollError = null; let failStreak = 0;
let lastSkipBusy = null; // v2.612 EDGE2612-01: 잠금 때문에 인출을 미룬 마지막 시각
function noteFail(kind, detail) {
  failStreak++;
  lastPollError = { at: Date.now(), kind, detail: String(detail).slice(0, 300), streak: failStreak };
  // 무음 실패 금지 — 첫 실패와 그 뒤 매 20회(5초 폴이면 ~100초)마다 한 줄.
  if (failStreak === 1 || failStreak % 20 === 0) console.warn(`[idrac-scan-agent] 중앙 잡 인출 실패(${kind}) ${lastPollError.detail} — ${failStreak}회 연속. 개별 CENTRAL_TOKEN·엣지 이름·중앙 URL 을 확인하세요.`);
}

export function getIdracScanWorkerStatus() {
  // lastPollAt: 마지막 성공 인출 · lastPollError: 마지막 실패(성공하면 null · streak 는 연속 실패 수)
  return { name: config.agent.name, centralUrl: config.agent.centralUrl || null, pollMs: POLL_MS, last, lastPollAt: lastPollAt || null, lastPollError, progressError: _progressError, lastSkipBusy,
    // v2.742(EDGE-03): 보내지 못해 다음 주기에 다시 보낼 결과 회신 · 끝내 버린 회신
    unsentResults: _unsent.map((x) => ({ reqId: x.payload?.reqId || null, attempts: x.attempts, nextAt: x.nextAt, lastError: x.lastError })),
    unsentDropped: _unsentDropped };
}

export function startIdracScanWorker() {
  if (!config.agent.centralUrl) return; // 중앙 미설정 → 에이전트 아님(비활성)
  timer = setInterval(() => runIdracScanWorkerOnce().catch(() => {}), POLL_MS);
  timer.unref?.();
  console.log(`[idrac-scan-agent] started (central=${config.agent.centralUrl}, name=${config.agent.name}, poll=${POLL_MS}ms)`);
}
