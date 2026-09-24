/**
 * 게스트 OS에서 수집한 GPU 사용률 오버레이(인메모리). 패스쓰루 GPU는 ESXi가
 * 사용률을 못 보므로, 게스트 폴러가 채운 값을 호스트/ VM 단위로 보관한다.
 * /tools/gpu 와 metrics 샘플러가 이 값을 읽어 표시·시계열화한다.
 */

let byHost = new Map(); // hostId -> { utilPct, at, source:'guest' }
let byVm = new Map();   // vmId   -> { utilPct, memUsedPct, at, host, vcenterId }

import { numOrNull } from '../util/numOrNull.js';

/**
 * v2.600(CEN2600-01 2차 방어): 사용률은 0~100 유한수만 싣는다. 예전에는 원소 값을 그대로 저장해 객체 하나가 지표 샘플러의
 * 배치 적재(metrics/db.js insertMany — 트랜잭션 1회)를 bind 오류로 **통째로 롤백**시켰다(그 분 전 지표 소실).
 * 수신 라우트(routes/central.js narrowGpuRow)가 1차로 좁히고, 이 함수가 모든 입력 경로(로컬 폴러 포함)를 다시 좁힌다.
 */
export const pctOrNull = (v) => { const n = numOrNull(v); return n != null && n >= 0 && n <= 100 ? n : null; };

export function setGuestGpu({ hosts = [], vms = [], agent = '' }) {
  const now = Date.now();
  hosts = (Array.isArray(hosts) ? hosts : []).filter((h) => h && typeof h === 'object').map((h) => ({ ...h, utilPct: pctOrNull(h.utilPct) }));
  vms = (Array.isArray(vms) ? vms : []).filter((v) => v && typeof v === 'object').map((v) => ({ ...v, utilPct: pctOrNull(v.utilPct), memUsedPct: pctOrNull(v.memUsedPct) }));
  // agent = 이 오버레이를 보고한 엣지(출처). 위임(central) 경로에서 어느 엣지가 넣었는지 기록해
  // 사후 추적·향후 scope 필터의 근거로 남긴다. 로컬 폴러 경로는 agent 미지정(빈 값).
  for (const h of hosts) if (h && h.hostId != null && h.utilPct != null) byHost.set(h.hostId, { utilPct: h.utilPct, at: now, source: 'guest', agent });
  // v2.593(DATA-02): MIG(utilNA)는 사용률 없이도 싣는다 — 수집은 됐고 사용률만 GPU 단위로 없는 것이다(0% 가 아니다).
  for (const v of vms) if (v && v.vmId != null && (v.utilPct != null || v.utilNA)) byVm.set(v.vmId, { utilPct: v.utilNA ? null : v.utilPct, utilNA: !!v.utilNA, memUsedPct: v.memUsedPct ?? null, at: now, host: v.host, vcenterId: v.vcenterId, agent });
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

// 독립 GC — 로컬 GPU 폴러가 꺼진 중앙(오버레이가 POST /api/central/gpu-guest-data 로만 들어오는)
// 배치에서는 poller의 pruneGuestGpu가 실행되지 않아 삭제된 VM의 stale 항목이 영구 누적된다.
// 폴러 상태와 무관하게 오래된 항목을 만료시켜 byVm/byHost Map의 무한 증가를 막는다.
const GC_TTL_MS = Number(process.env.GUEST_GPU_TTL_MS) || 30 * 60_000; // 30분 무갱신 시 만료
const _gcTimer = setInterval(() => { try { pruneGuestGpu(GC_TTL_MS); } catch { /* best effort */ } }, 5 * 60_000);
_gcTimer.unref?.();
