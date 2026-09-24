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

/**
 * v2.603(감사 CEN2603-01): 개수 상한. 예전에는 byVm·byHost 에 상한이 없어 토큰 하나로 한 요청 50만 VM 을 계속 밀어 넣으면
 * 30분 TTL GC 가 돌기 전까지 중앙 메모리가 수 GB 로 불었다. 규칙:
 *  ① 엣지(agent 가 있는 보고)는 매 push 가 **그 엣지의 전량**이다(agent/gpuGuestPush.js) — 그 엣지의 이전 항목을 지우고 새로 넣는다
 *     (교체). 그래서 한 엣지가 차지하는 양은 자기 상한을 넘지 못한다.
 *  ② 엣지별 상한 + 전체 상한. **이미 들어 있는 다른 엣지의 항목은 밀어내지 않는다** — 넘친 새 항목을 받지 않고 개수를 돌려준다
 *     (조용한 상한 금지 — 호출부가 응답·로그에 싣는다). 검증되지 않은 이름(공유 토큰 + 중앙이 모르는 이름)은 더 작은 상한.
 *  ③ 로컬 폴러(agent='')는 vCenter 단위로 나눠 부르므로 교체하지 않는다(기존 upsert) — 전체 상한만 적용한다.
 */
const envInt = (v, d) => { const n = numOrNull(v); return n != null && n > 0 ? Math.floor(n) : d; };
export const GPU_LIMITS = {
  vmsTotal: envInt(process.env.GUEST_GPU_MAX_VMS, 50_000),
  hostsTotal: envInt(process.env.GUEST_GPU_MAX_HOSTS, 10_000),
  vmsPerAgent: envInt(process.env.GUEST_GPU_MAX_VMS_PER_AGENT, 20_000),
  hostsPerAgent: envInt(process.env.GUEST_GPU_MAX_HOSTS_PER_AGENT, 4_000),
  unverifiedFactor: 10, // 미검증 이름은 엣지별 상한의 1/10
};
const agentKeyOf = (a) => String(a || '').trim().toLowerCase();

let _trust = true;
/** 이 호출 동안의 출처 신뢰(미검증 이름이면 false) — 수신 라우트가 감싼다. 동기 호출 전용. */
export function withGpuTrust(verified, fn) { const prev = _trust; _trust = !!verified; try { return fn(); } finally { _trust = prev; } }

/** @returns {{hosts:number, vms:number, omittedHosts:number, omittedVms:number}} 실제로 넣은 개수 · 상한으로 뺀 개수 */
export function setGuestGpu({ hosts = [], vms = [], agent = '', verified = _trust }) {
  const now = Date.now();
  hosts = (Array.isArray(hosts) ? hosts : []).filter((h) => h && typeof h === 'object').map((h) => ({ ...h, utilPct: pctOrNull(h.utilPct) }));
  vms = (Array.isArray(vms) ? vms : []).filter((v) => v && typeof v === 'object').map((v) => ({ ...v, utilPct: pctOrNull(v.utilPct), memUsedPct: pctOrNull(v.memUsedPct) }));
  const ak = agentKeyOf(agent);
  // ① 엣지 보고는 교체 — 이 엣지가 넣은 이전 항목을 지운다(다른 엣지·로컬 항목은 건드리지 않는다).
  if (ak) {
    for (const [k, v] of byHost) if (agentKeyOf(v.agent) === ak) byHost.delete(k);
    for (const [k, v] of byVm) if (agentKeyOf(v.agent) === ak) byVm.delete(k);
  }
  const div = ak && !verified ? GPU_LIMITS.unverifiedFactor : 1;
  const hostCap = ak ? Math.max(1, Math.floor(GPU_LIMITS.hostsPerAgent / div)) : Infinity;
  const vmCap = ak ? Math.max(1, Math.floor(GPU_LIMITS.vmsPerAgent / div)) : Infinity;
  let nh = 0; let nv = 0; let omittedHosts = 0; let omittedVms = 0;
  // agent = 이 오버레이를 보고한 엣지(출처). 위임(central) 경로에서 어느 엣지가 넣었는지 기록해
  // 사후 추적·향후 scope 필터의 근거로 남긴다. 로컬 폴러 경로는 agent 미지정(빈 값).
  for (const h of hosts) {
    if (!(h && h.hostId != null && h.utilPct != null)) continue;
    const exists = byHost.has(h.hostId);
    // 남의 항목을 덮어쓰는 것은 개수를 늘리지 않으므로 상한과 무관하다(소유 판정은 수신 라우트가 한다).
    if (!exists && (nh >= hostCap || byHost.size >= GPU_LIMITS.hostsTotal)) { omittedHosts++; continue; }
    byHost.set(h.hostId, { utilPct: h.utilPct, at: now, source: 'guest', agent });
    nh++;
  }
  // v2.593(DATA-02): MIG(utilNA)는 사용률 없이도 싣는다 — 수집은 됐고 사용률만 GPU 단위로 없는 것이다(0% 가 아니다).
  for (const v of vms) {
    if (!(v && v.vmId != null && (v.utilPct != null || v.utilNA))) continue;
    const exists = byVm.has(v.vmId);
    if (!exists && (nv >= vmCap || byVm.size >= GPU_LIMITS.vmsTotal)) { omittedVms++; continue; }
    byVm.set(v.vmId, { utilPct: v.utilNA ? null : v.utilPct, utilNA: !!v.utilNA, memUsedPct: v.memUsedPct ?? null, at: now, host: v.host, vcenterId: v.vcenterId, agent });
    nv++;
  }
  return { hosts: nh, vms: nv, omittedHosts, omittedVms };
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

/** 테스트용 — 두 Map 을 비운다. */
export function _resetGuestGpuForTest() { byHost.clear(); byVm.clear(); }

// 독립 GC — 로컬 GPU 폴러가 꺼진 중앙(오버레이가 POST /api/central/gpu-guest-data 로만 들어오는)
// 배치에서는 poller의 pruneGuestGpu가 실행되지 않아 삭제된 VM의 stale 항목이 영구 누적된다.
// 폴러 상태와 무관하게 오래된 항목을 만료시켜 byVm/byHost Map의 무한 증가를 막는다.
const GC_TTL_MS = Number(process.env.GUEST_GPU_TTL_MS) || 30 * 60_000; // 30분 무갱신 시 만료
const _gcTimer = setInterval(() => { try { pruneGuestGpu(GC_TTL_MS); } catch { /* best effort */ } }, 5 * 60_000);
_gcTimer.unref?.();
