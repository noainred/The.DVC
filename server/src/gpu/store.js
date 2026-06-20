/**
 * 게스트 OS에서 수집한 GPU 사용률 오버레이(인메모리). 패스쓰루 GPU는 ESXi가
 * 사용률을 못 보므로, 게스트 폴러가 채운 값을 호스트/ VM 단위로 보관한다.
 * /tools/gpu 와 metrics 샘플러가 이 값을 읽어 표시·시계열화한다.
 */

let byHost = new Map(); // hostId -> { utilPct, at, source:'guest' }
let byVm = new Map();   // vmId   -> { utilPct, memUsedPct, at, host, vcenterId }

export function setGuestGpu({ hosts = [], vms = [] }) {
  const now = Date.now();
  for (const h of hosts) if (h.hostId != null && h.utilPct != null) byHost.set(h.hostId, { utilPct: h.utilPct, at: now, source: 'guest' });
  for (const v of vms) if (v.vmId != null && v.utilPct != null) byVm.set(v.vmId, { utilPct: v.utilPct, memUsedPct: v.memUsedPct ?? null, at: now, host: v.host, vcenterId: v.vcenterId });
}

export function getGuestGpuHost(hostId) { return byHost.get(hostId) || null; }
export function getGuestGpuAllHosts() { return byHost; }
export function getGuestGpuVms() { return [...byVm.entries()].map(([vmId, v]) => ({ vmId, ...v })); }

/** 오래된(staleMs 초과) 항목 제거. */
export function pruneGuestGpu(staleMs) {
  const cut = Date.now() - staleMs;
  for (const [k, v] of byHost) if (v.at < cut) byHost.delete(k);
  for (const [k, v] of byVm) if (v.at < cut) byVm.delete(k);
}

export function guestGpuCounts() { return { hosts: byHost.size, vms: byVm.size }; }
