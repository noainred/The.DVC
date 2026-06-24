/**
 * 위임 iDRAC 스캔 워커 — CENTRAL_URL이 설정된 현장 에이전트에서 동작.
 *  1) 중앙에서 자기 이름(AGENT_NAME)의 온디맨드 스캔 잡을 인출하고
 *  2) 그 대역을 로컬에서 Redfish 스캔해 Dell iDRAC만 골라낸 뒤
 *  3) (autoRegister 시) 현지 레지스트리에 등록해 즉시 전력 수집을 시작하고
 *  4) 발견 목록·요약을 reqId와 함께 중앙으로 회신한다.
 * 응답성을 위해 짧은 주기(기본 5s)로 폴링하되, 대기 잡이 없으면 스캔하지 않는다.
 */

import { config } from '../config.js';
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
  await fetch(`${config.agent.centralUrl}/api/central/idrac-scan-result`, {
    method: 'POST', headers: headers(), body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000),
  }).catch(() => {});
}

export async function runIdracScanWorkerOnce() {
  if (!config.agent.centralUrl) return null;
  try {
    const url = `${config.agent.centralUrl}/api/central/idrac-scan-jobs?agent=${encodeURIComponent(config.agent.name)}`;
    const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const { jobs } = await r.json();
    if (!jobs || !jobs.length) return null;
    for (const job of jobs) {
      const started = Date.now();
      try {
        const scan = await scanForIdracs({ ips: job.ips, username: job.username, password: job.password });
        let registered = 0;
        if (config.agent.autoRegister && scan.found.length) {
          const rr = registerScanned(scan.found, job.username, job.password, 'merge', job.vcenterId || '');
          if (rr.ok) { registered = (rr.added || 0) + (rr.updated || 0); pollNow().catch(() => {}); }
        }
        await postResult({ reqId: job.reqId, agent: config.agent.name, ...scan, registered, durationMs: Date.now() - started });
        last = { at: Date.now(), reqId: job.reqId, foundCount: scan.foundCount, registered };
        console.log(`[idrac-scan-agent] ${config.agent.name}: ${scan.foundCount}/${scan.scanned} iDRAC, ${registered} 현지 등록`);
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
