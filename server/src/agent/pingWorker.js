/**
 * 위임 Ping 워커 — CENTRAL_URL이 설정된 현장 에이전트에서 동작.
 *  1) 중앙에서 자기 담당 vCenter들의 대기 ping IP를 인출하고
 *  2) 로컬에서 ICMP ping(현장 망에 닿음)
 *  3) 결과를 중앙으로 보고 → UI가 VM 상세에서 녹/적 표시.
 * 응답성을 위해 짧은 주기(기본 4s)로 폴링하되, 대기 작업이 없으면 ping을 돌리지 않는다.
 */

import { config, loadVcenterConfig } from '../config.js';
import { pingMany } from '../util/ping.js';

let timer = null;
const POLL_MS = Number(process.env.AGENT_PING_POLL_MS) || 4_000;

function headers() {
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function runPingWorkerOnce() {
  if (!config.agent.centralUrl) return null;
  const vcIds = (loadVcenterConfig().vcenters || []).map((v) => v.id).filter(Boolean);
  if (!vcIds.length) return null;
  try {
    const url = `${config.agent.centralUrl}/api/central/ping-jobs?vcenters=${encodeURIComponent(vcIds.join(','))}`;
    const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const { jobs } = await r.json();
    if (!jobs || !Object.keys(jobs).length) return null;
    for (const [vcenterId, ips] of Object.entries(jobs)) {
      if (!Array.isArray(ips) || !ips.length) continue;
      const results = await pingMany(ips, { timeoutMs: 1500, concurrency: 8 });
      await fetch(`${config.agent.centralUrl}/api/central/ping-result`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ vcenterId, results }), signal: AbortSignal.timeout(15_000),
      }).catch(() => {});
      console.log(`[ping-agent] ${vcenterId}: ${results.filter((x) => x.alive).length}/${results.length} 응답`);
    }
    return { at: Date.now() };
  } catch { return null; }
}

export function startPingWorker() {
  if (!config.agent.centralUrl) return; // 중앙 미설정 → 에이전트 아님(비활성)
  timer = setInterval(() => runPingWorkerOnce().catch(() => {}), POLL_MS);
  timer.unref?.();
  console.log(`[ping-agent] started (central=${config.agent.centralUrl}, poll=${POLL_MS}ms)`);
}
