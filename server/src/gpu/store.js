/**
 * 게스트 OS에서 수집한 GPU 사용률 오버레이(인메모리). 패스쓰루 GPU는 ESXi가
 * 사용률을 못 보므로, 게스트 폴러가 채운 값을 호스트/ VM 단위로 보관한다.
 * /tools/gpu 와 metrics 샘플러가 이 값을 읽어 표시·시계열화한다.
 */

let byHost = new Map(); // hostId -> { utilPct, at, source:'guest' }
let byVm = new Map();   // vmId   -> { utilPct, memUsedPct, memUsedMB, memTotalMB, tempC, gpus, at, host, vcenterId }

import { numOrNull } from '../util/numOrNull.js';
import { loadGpuGuestSettings } from './settings.js'; // v2.742(VC-01): 독립 GC 가 실행할 때 폴 주기를 읽는다
import { getAllGpuGuestDiag } from '../central/gpuGuestDiag.js'; // v2.743(LEFT-02): 엣지 항목 TTL — 그 엣지가 보고한 push 주기(잎 모듈 — util 만 import)

/**
 * v2.600(CEN2600-01 2차 방어): 사용률은 0~100 유한수만 싣는다. 예전에는 원소 값을 그대로 저장해 객체 하나가 지표 샘플러의
 * 배치 적재(metrics/db.js insertMany — 트랜잭션 1회)를 bind 오류로 **통째로 롤백**시켰다(그 분 전 지표 소실).
 * 수신 라우트(routes/central.js narrowGpuRow)가 1차로 좁히고, 이 함수가 모든 입력 경로(로컬 폴러 포함)를 다시 좁힌다.
 */
export const pctOrNull = (v) => { const n = numOrNull(v); return n != null && n >= 0 && n <= 100 ? n : null; };
/** v2.650: GPU 메모리(MB) — 0 이상 유한수(상한 64TB — GPU 여러 장 합이라 넉넉히). 밖이면 null. */
export const mbOrNull = (v) => { const n = numOrNull(v); return n != null && n >= 0 && n <= 64 * 1024 * 1024 ? n : null; };
/** v2.650: GPU 온도(℃) — 센서 오류값(-30 이하·150 이상)은 null(0 으로 두면 '꺼진 GPU' 로 읽힌다). */
export const tempOrNull = (v) => { const n = numOrNull(v); return n != null && n > -30 && n < 150 ? n : null; };
const cntOrNull = (v) => { const n = numOrNull(v); return n != null && n >= 0 && n <= 64 ? Math.floor(n) : null; };

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
  vms = (Array.isArray(vms) ? vms : []).filter((v) => v && typeof v === 'object').map((v) => ({ ...v, utilPct: pctOrNull(v.utilPct), memUsedPct: pctOrNull(v.memUsedPct), memUsedMB: mbOrNull(v.memUsedMB), memTotalMB: mbOrNull(v.memTotalMB), tempC: tempOrNull(v.tempC), gpus: cntOrNull(v.gpus) }));
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
    byVm.set(v.vmId, { utilPct: v.utilNA ? null : v.utilPct, utilNA: !!v.utilNA, memUsedPct: v.memUsedPct ?? null, memUsedMB: v.memUsedMB ?? null, memTotalMB: v.memTotalMB ?? null, tempC: v.tempC ?? null, gpus: v.gpus ?? null, at: now, host: v.host, vcenterId: v.vcenterId, agent });
    nv++;
  }
  return { hosts: nh, vms: nv, omittedHosts, omittedVms };
}

export function getGuestGpuHost(hostId) { return byHost.get(hostId) || null; }
export function getGuestGpuAllHosts() { return byHost; }
export function getGuestGpuVms() { return [...byVm.entries()].map(([vmId, v]) => ({ vmId, ...v })); }

/**
 * 오래된(staleMs 초과) 항목 제거.
 * v2.743(LEFT-02 — 재현): `localOnly` 면 **이 노드의 로컬 폴러가 넣은 항목(agent 없음)만** 지운다. 예전 폴러 정리
 *   (poller.js — 이 노드 폴 주기 × 3 + 30초)는 agent 를 보지 않아 엣지가 push 한 항목까지 지웠다 — 그 경계는 엣지 push 간격
 *   (AGENT_INVENTORY_INTERVAL_MS)·첫 폴 보류(최대 15분)·전송 실패와 무관하고, 독립 GC 의 TTL(max(30분, 주기 × 3 + 30초))과도 갈렸다.
 *   중앙 폴 주기가 짧거나(약 10초) 엣지 push 가 그 경계보다 늦으면 받은 GPU 사용률이 다음 push 전에 화면에서 사라졌다.
 *   엣지 항목은 독립 GC(runGuestGpuGc)가 그 엣지의 주기로 정리한다.
 */
export function pruneGuestGpu(staleMs, { localOnly = false } = {}) {
  const cut = Date.now() - staleMs;
  const hit = (v) => v.at < cut && (!localOnly || !agentKeyOf(v.agent));
  for (const [k, v] of byHost) if (hit(v)) byHost.delete(k);
  for (const [k, v] of byVm) if (hit(v)) byVm.delete(k);
}

/**
 * v2.743(LEFT-02): 엣지 항목 정리 — 엣지마다 자기 TTL(ttlOf(agentKey) ms)로 지운다. ttlOf 가 유한한 양수를 주지 않으면 그 엣지는 건너뛴다
 * (지우지 않는 쪽 — 모르는 값으로 지우지 않는다). 반환: 지운 개수.
 */
export function pruneEdgeGuestGpu(ttlOf) {
  const now = Date.now();
  const cache = new Map();
  const ttl = (ak) => { if (!cache.has(ak)) { const t = numOrNull(ttlOf(ak)); cache.set(ak, t != null && t > 0 ? t : null); } return cache.get(ak); };
  let n = 0;
  for (const m of [byHost, byVm]) {
    for (const [k, v] of m) {
      const ak = agentKeyOf(v.agent);
      if (!ak) continue;
      const t = ttl(ak);
      if (t != null && v.at < now - t) { m.delete(k); n++; }
    }
  }
  return n;
}

export function guestGpuCounts() { return { hosts: byHost.size, vms: byVm.size }; }

/** 테스트용 — 두 Map 을 비운다. */
export function _resetGuestGpuForTest() { byHost.clear(); byVm.clear(); }

// 독립 GC — 로컬 GPU 폴러가 꺼진 중앙(오버레이가 POST /api/central/gpu-guest-data 로만 들어오는)
// 배치에서는 poller의 pruneGuestGpu가 실행되지 않아 삭제된 VM의 stale 항목이 영구 누적된다.
// 폴러 상태와 무관하게 오래된 항목을 만료시켜 byVm/byHost Map의 무한 증가를 막는다.
/*
 * v2.742(VC-01 — 재현): 예전 TTL 은 모듈 로드 때 굳힌 **30분 고정**이었다. 그런데 폴 주기는 설정에서 최대 24시간까지 허용된다
 *   (settings.js — 10초~86,400초). 주기를 60분으로 두면 수집 35분 뒤 독립 GC 가 오버레이를 비워, 다음 수집까지 호스트 요약의
 *   사용률·온도·메모리가 null 이 되고 원인 판정은 근거 없는 'unknown(완료)' 가 됐다(값은 멀쩡히 수집되고 있는데 화면이 비었다).
 *   폴러 자신의 정리(poller.js — 주기 × 3 + 30초)·지표 샘플러의 신선도(sampler.js — 주기 × 3)와도 어긋났다.
 *   이제 GC 가 **돌 때마다 설정을 읽어** max(기본 30분, 주기 × 3 + 30초) 로 정한다(주기를 바꾸면 다음 GC 부터 바로 먹는다 —
 *   v2.409 '주기를 모듈 로드 때 굳히지 말 것' 규약). 설정을 못 읽으면 기본값만 쓴다(넓히지 않는다 — 추측 금지).
 */
export const GUEST_GPU_TTL_BASE_MS = envInt(process.env.GUEST_GPU_TTL_MS, 30 * 60_000); // 30분 무갱신 시 만료(하한)
/** 독립 GC 의 만료 시간(순수) — max(기본, 폴 주기 × 3 + 30초). 주기를 모르면 기본값. */
export function guestGpuTtlMs(pollIntervalMs, baseMs = GUEST_GPU_TTL_BASE_MS) {
  const p = numOrNull(pollIntervalMs);
  return Math.max(baseMs, p != null && p > 0 ? p * 3 + 30_000 : 0);
}
/**
 * v2.743(LEFT-02): 엣지 항목의 독립 TTL — max(기본 30분, 그 엣지 주기 × 3 + 30초). 엣지 주기는 그 엣지가 GPU 진단 push 에 실어 보낸
 *   자기 push 주기(central/gpuGuestDiag.js intervalMs — 구버전 엣지·재시작 직후에는 없다)이고, 모르면 예전처럼 이 노드의 폴 주기를 쓴다
 *   (예전 정리 기준보다 짧아지지 않게 — 넓히는 쪽만 바꾼다). 순수.
 * @param {number|null} edgeIntervalMs 엣지가 보고한 push 주기
 * @param {number|null} localPollMs 이 노드의 GPU 게스트 폴 주기
 */
export function edgeGuestGpuTtlMs(edgeIntervalMs, localPollMs) {
  const e = numOrNull(edgeIntervalMs);
  return guestGpuTtlMs(e != null && e > 0 ? e : localPollMs);
}
/** 엣지(소문자 키) → 보고한 push 주기(ms). 진단을 못 읽으면 빈 맵(= 이 노드 주기로 정리). */
function edgeIntervals() {
  const out = new Map();
  try {
    for (const d of getAllGpuGuestDiag()) {
      const ak = agentKeyOf(d?.agent);
      const n = numOrNull(d?.intervalMs);
      if (ak && n != null && n > 0) out.set(ak, Math.max(out.get(ak) || 0, n));
    }
  } catch { /* 진단 없음 — 이 노드 주기 */ }
  return out;
}
/** 독립 GC 한 번 — 실행할 때 설정을 읽는다. 반환: 이번에 쓴 로컬 TTL(ms). 엣지 항목은 엣지마다 edgeGuestGpuTtlMs 로 정리한다. */
export function runGuestGpuGc() {
  let poll = null;
  try { poll = loadGpuGuestSettings()?.pollIntervalMs ?? null; } catch { poll = null; }
  const ttl = guestGpuTtlMs(poll);
  pruneGuestGpu(ttl, { localOnly: true });
  const iv = edgeIntervals();
  pruneEdgeGuestGpu((ak) => edgeGuestGpuTtlMs(iv.get(ak) ?? null, poll));
  return ttl;
}
const _gcTimer = setInterval(() => { try { runGuestGpuGc(); } catch { /* best effort */ } }, 5 * 60_000);
_gcTimer.unref?.();
