/**
 * 게스트 GPU 수집 위임 — 현장 서버(에이전트) 측 push 워커.
 *
 * 포탈(중앙)이 ESXi 망에 직접 못 가는 환경에서, ESXi 망에 닿는 현장 agent가 게스트
 * OS(nvidia-smi)에서 수집한 GPU 사용률을 중앙의 /api/central/gpu-guest-data 로 주기적으로
 * push 한다. 중앙은 이 값을 로컬 폴러와 동일한 게스트 오버레이로 받아 표시한다.
 *
 * 전제: 이 agent에서 GPU 게스트 수집(startGpuGuestPoller)이 동작해 gpu/store.js 오버레이가
 * 채워져 있어야 한다(설정 › GPU 게스트 수집을 이 agent에서 구성). 통신은 사이트→중앙
 * 단방향 아웃바운드라 폐쇄망/NAT 사이트에 유리하다.
 */

import { config } from '../config.js';
import { getGuestGpuVms, getGuestGpuAllHosts } from '../gpu/store.js';

let timer = null;
let last = null; // { at, hosts, vms, error }

function headers() {
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function pushGpuGuestNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'push 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  const hosts = [...getGuestGpuAllHosts().entries()].map(([hostId, v]) => ({ hostId, utilPct: v.utilPct }));
  const vms = getGuestGpuVms().map((v) => ({ vmId: v.vmId, utilPct: v.utilPct, memUsedPct: v.memUsedPct ?? null, host: v.host, vcenterId: v.vcenterId }));
  if (!hosts.length && !vms.length) { last = { at: Date.now(), hosts: 0, vms: 0 }; return { ok: true, hosts: 0, vms: 0 }; }
  try {
    const res = await fetch(`${config.agent.centralUrl}/api/central/gpu-guest-data`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ agent: config.agent.name, hosts, vms }), signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`gpu-guest -> ${res.status}`);
    last = { at: Date.now(), hosts: hosts.length, vms: vms.length };
    console.log(`[gpu-guest-push] sent → ${config.agent.centralUrl} hosts=${hosts.length} vms=${vms.length}`);
    return { ok: true, hosts: hosts.length, vms: vms.length };
  } catch (e) {
    last = { at: Date.now(), hosts: 0, vms: 0, error: e.message };
    console.warn(`[gpu-guest-push] 실패: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export function gpuGuestPushStatus() {
  return { enabled: !!(config.agent.centralUrl && config.agent.centralToken), centralUrl: config.agent.centralUrl, last };
}

export function startGpuGuestPush() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return;
  // 게스트 수집(첫 폴)이 끝난 뒤 보내도록 35초 지연 후 시작, 이후 주기 반복.
  const intervalMs = Math.max(30_000, config.agent.inventoryIntervalMs || 60_000);
  setTimeout(() => pushGpuGuestNow().catch((e) => console.error('[gpu-guest-push] 실패:', e.message)), 35_000).unref?.();
  timer = setInterval(() => pushGpuGuestNow().catch(() => {}), intervalMs);
  timer.unref?.();
  console.log(`[gpu-guest-push] started → ${config.agent.centralUrl} every ${Math.round(intervalMs / 1000)}s`);
}
