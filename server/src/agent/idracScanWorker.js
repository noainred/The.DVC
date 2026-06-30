/**
 * 위임 iDRAC 스캔 워커 — CENTRAL_URL이 설정된 현장 에이전트에서 동작.
 *  1) 중앙에서 자기 이름(AGENT_NAME)의 온디맨드 스캔 잡을 인출하고
 *  2) 그 대역을 로컬에서 Redfish 스캔해 Dell iDRAC만 골라낸 뒤
 *  3) (autoRegister 시) 현지 레지스트리에 등록해 즉시 전력 수집을 시작하고
 *  4) 발견 목록·요약을 reqId와 함께 중앙으로 회신한다.
 * 응답성을 위해 짧은 주기(기본 5s)로 폴링하되, 대기 잡이 없으면 스캔하지 않는다.
 */

import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { scanForIdracs } from '../idrac/scan.js';
import { registerScanned } from '../idrac/registry.js';
import { pollNow } from '../idrac/poller.js';

let timer = null;
let last = null;
const POLL_MS = Number(process.env.AGENT_IDRAC_SCAN_POLL_MS) || 5_000;

function headers() {
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

async function postResult(payload) {
  await resilientFetch(`${config.agent.centralUrl}/api/central/idrac-scan-result`, {
    method: 'POST', headers: headers(), body: JSON.stringify(payload), timeoutMs: 30_000, retries: 2,
  }).catch(() => {});
}

async function postProgress(reqId, scanned, total, found) {
  await resilientFetch(`${config.agent.centralUrl}/api/central/idrac-scan-progress`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ reqId, scanned, total, found }), timeoutMs: 10_000, retries: 2,
  }).catch(() => {});
}

export async function runIdracScanWorkerOnce() {
  if (!config.agent.centralUrl) return null;
  try {
    const url = `${config.agent.centralUrl}/api/central/idrac-scan-jobs?agent=${encodeURIComponent(config.agent.name)}`;
    const r = await resilientFetch(url, { headers: headers(), timeoutMs: 15_000, retries: 2 });
    if (!r.ok) return null;
    const { jobs } = await r.json();
    if (!jobs || !jobs.length) return null;
    for (const job of jobs) {
      const started = Date.now();
      try {
        // '등록' 잡: UI가 스캔에서 확인한 found 목록을 현지 레지스트리에 등록.
        if (job.action === 'register') {
          const rr = registerScanned(job.found || [], job.username, job.password, job.mode || 'merge', job.vcenterId || '');
          const registered = rr.ok ? ((rr.added || 0) + (rr.updated || 0)) : 0;
          if (rr.ok) pollNow().catch(() => {});
          await postResult({ reqId: job.reqId, agent: config.agent.name, scanned: 0, found: job.found || [], foundCount: (job.found || []).length, registered, error: rr.ok ? null : (rr.reason || '등록 실패'), durationMs: Date.now() - started });
          last = { at: Date.now(), reqId: job.reqId, registered };
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
        const scan = await scanForIdracs({ ips: job.ips, username: job.username, password: job.password, onProgress });
        // noRegister면 스캔만(UI에서 확인 후 별도 '등록' 잡으로 등록). 그 외엔 기존처럼 자동등록.
        let registered = 0;
        if (!job.noRegister && config.agent.autoRegister && scan.found.length) {
          const rr = registerScanned(scan.found, job.username, job.password, 'merge', job.vcenterId || '');
          if (rr.ok) { registered = (rr.added || 0) + (rr.updated || 0); pollNow().catch(() => {}); }
        }
        await postResult({ reqId: job.reqId, agent: config.agent.name, ...scan, registered, durationMs: Date.now() - started });
        last = { at: Date.now(), reqId: job.reqId, foundCount: scan.foundCount, registered };
        console.log(`[idrac-scan-agent] ${config.agent.name}: ${scan.foundCount}/${scan.scanned} iDRAC, ${registered} 현지 등록${job.noRegister ? ' (등록 보류)' : ''}`);
      } catch (e) {
        await postResult({ reqId: job.reqId, agent: config.agent.name, error: e.message });
        last = { at: Date.now(), reqId: job.reqId, error: e.message };
      }
    }
    return last;
  } catch { return null; }
}

export function getIdracScanWorkerStatus() {
  return { name: config.agent.name, centralUrl: config.agent.centralUrl || null, pollMs: POLL_MS, last };
}

export function startIdracScanWorker() {
  if (!config.agent.centralUrl) return; // 중앙 미설정 → 에이전트 아님(비활성)
  timer = setInterval(() => runIdracScanWorkerOnce().catch(() => {}), POLL_MS);
  timer.unref?.();
  console.log(`[idrac-scan-agent] started (central=${config.agent.centralUrl}, name=${config.agent.name}, poll=${POLL_MS}ms)`);
}
