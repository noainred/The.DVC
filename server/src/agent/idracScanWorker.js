/**
 * 위임 iDRAC 스캔 워커 — CENTRAL_URL이 설정된 현장 에이전트에서 동작.
 *  1) 중앙에서 자기 이름(AGENT_NAME)의 온디맨드 스캔 잡을 인출하고
 *  2) 그 대역을 로컬에서 Redfish 스캔해 Dell iDRAC만 골라낸 뒤
 *  3) (autoRegister 시) 현지 레지스트리에 등록해 즉시 전력 수집을 시작하고
 *  4) 발견 목록·요약을 reqId와 함께 중앙으로 회신한다.
 * 응답성을 위해 짧은 주기(기본 5s)로 폴링하되, 대기 잡이 없으면 스캔하지 않는다.
 */

import { config, clampIntervalMs } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
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

async function postResult(payload) {
  // 회신 실패를 무음 처리하면 "엣지는 완주했는데 중앙 잡만 멎는" 상황을 엣지 로그로 진단할 수 없다.
  try {
    const r = await resilientFetch(`${config.agent.centralUrl}/api/central/idrac-scan-result`, {
      method: 'POST', headers: headers(), body: JSON.stringify(payload), timeoutMs: 30_000, retries: 2,
    });
    // v2.621(감사 EDGE-01): 410 = 중앙에 그 잡이 없다(만료·중앙 재시작). 토큰·버전 문제가 아니므로 원인을 따로 말한다 —
    //   예전 중앙은 이때도 200 이라 여기서 '성공' 으로 적혔고 결과는 조용히 사라졌다.
    if (r.status === 410) { console.error(`[idrac-scan-agent] 결과 회신 거절 HTTP 410 (reqId=${payload.reqId}) — 중앙에 이 잡이 없습니다(만료되었거나 중앙이 재시작됨). 결과는 중앙에 반영되지 않았고 현지 등록은 그대로입니다.`); return '중앙에 잡이 없음(HTTP 410 — 만료·중앙 재시작) — 결과 미반영'; }
    if (!r.ok) { console.error(`[idrac-scan-agent] 결과 회신 거부 HTTP ${r.status} (reqId=${payload.reqId}) — CENTRAL_TOKEN/중앙 버전을 확인하세요.`); return `결과 회신 거부(HTTP ${r.status})`; }
    return null;
  } catch (e) {
    console.error(`[idrac-scan-agent] 결과 회신 실패: ${e.message} (reqId=${payload.reqId})`);
    return `결과 회신 실패: ${e.message}`;
  }
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
  try { return await runIdracScanWorkerInner(); } finally { running = false; }
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
          const rr = registerScanned(job.found || [], job.username, job.password, job.mode || 'merge', job.vcenterId || '', job.datacenterId || '', { ilo: job.ilo || null });
          const registered = rr.ok ? ((rr.added || 0) + (rr.updated || 0)) : 0;
          if (rr.ok) pollNow().catch(() => {});
          // v2.621(감사 EDGE-01): 등록 잡도 회신 실패(410 = 중앙에 잡 없음 등)를 상태에 싣는다 — 스캔 잡(v2.593 EDGE-4)과 같은 규칙.
          const regPostErr = await postResult({ reqId: job.reqId, agent: config.agent.name, scanned: 0, found: job.found || [], foundCount: (job.found || []).length, registered, error: rr.ok ? null : (rr.reason || '등록 실패'), durationMs: Date.now() - started });
          last = { at: Date.now(), reqId: job.reqId, registered, ...(regPostErr ? { postError: regPostErr } : {}) };
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
        last = { at: Date.now(), reqId: job.reqId, foundCount: scan.foundCount, registered: scan.registered, ...(postErr ? { postError: postErr } : {}) };
        console.log(`[idrac-scan-agent] ${config.agent.name}: ${scan.foundCount}/${scan.scanned} iDRAC, ${scan.registered} 현지 등록${job.noRegister ? ' (등록 보류)' : ''}`);
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
  return { name: config.agent.name, centralUrl: config.agent.centralUrl || null, pollMs: POLL_MS, last, lastPollAt: lastPollAt || null, lastPollError, progressError: _progressError, lastSkipBusy };
}

export function startIdracScanWorker() {
  if (!config.agent.centralUrl) return; // 중앙 미설정 → 에이전트 아님(비활성)
  timer = setInterval(() => runIdracScanWorkerOnce().catch(() => {}), POLL_MS);
  timer.unref?.();
  console.log(`[idrac-scan-agent] started (central=${config.agent.centralUrl}, name=${config.agent.name}, poll=${POLL_MS}ms)`);
}
