/**
 * 분산 에이전트의 IP 스캔 워커. CENTRAL_URL이 설정되면 동작:
 *  1) 중앙에서 자기 이름(AGENT_NAME)의 IP 스캔 할당을 읽어오고
 *  2) 그 대역을 로컬에서 TCP 커넥트 스캔한 뒤
 *  3) 결과를 중앙으로 보고 → 중앙이 IP 대장에 병합한다.
 * 실패는 격리되고 이벤트 루프를 막지 않는다.
 */

import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { scanRanges } from '../ipam/scan.js';

let timer = null;
let last = null;
let running = false; // 재진입 가드 — 대역 스캔이 인터벌을 넘기면 중첩 실행돼 이중 스캔/보고

function headers() {
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function runIpScanAgentOnce() {
  if (!config.agent.centralUrl) return null;
  if (running) return last; // 이전 주기 진행 중이면 이번 틱 건너뜀
  running = true;
  try {
    const url = `${config.agent.centralUrl}/api/central/ip-scan-assignment?agent=${encodeURIComponent(config.agent.name)}`;
    const aRes = await resilientFetch(url, { headers: headers(), timeoutMs: 20_000, retries: 2 });
    if (!aRes.ok) throw new Error(`assignment ${aRes.status}`);
    const a = await aRes.json();
    if (!a?.assigned) { last = { at: Date.now(), assigned: false }; return last; }
    const { alive, scanned } = await scanRanges(a.ranges, {
      ports: a.ports, concurrency: a.concurrency, timeoutMs: a.timeoutMs, reverseDns: a.reverseDns,
    });
    await resilientFetch(`${config.agent.centralUrl}/api/central/ip-scan-result`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ agent: config.agent.name, alive, scanned }), timeoutMs: 30_000, retries: 2,
    });
    last = { at: Date.now(), assigned: true, scanned, alive: alive.length };
    return last;
  } catch (e) { last = { at: Date.now(), error: e.message }; return last; }
  finally { running = false; }
}

export function startIpScanAgent() {
  if (!config.agent.centralUrl) return; // 중앙 미설정 → 에이전트 스캔 비활성
  setTimeout(() => runIpScanAgentOnce().catch(() => {}), 40_000).unref?.();
  timer = setInterval(() => runIpScanAgentOnce().catch(() => {}), config.agent.scanIntervalMs);
  timer.unref?.();
  console.log(`[ipscan-agent] started (central=${config.agent.centralUrl}, name=${config.agent.name})`);
}
