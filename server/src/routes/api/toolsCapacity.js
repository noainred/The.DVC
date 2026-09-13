// 용량/낭비/씬/VM파인더/온도/용량예측 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { scopedVcenterIds } from '../../auth/scope.js';
import { requireRole, requirePerm } from '../../auth/auth.js'; // v2.478(감사 S5): /tools/* 조회도 tools 권한 게이트   // 설정 변경/데이터 삭제는 관리자 전용
import { logAudit } from '../../audit.js';           // 수집 정책 변경·데이터 삭제는 감사 기록
import { store } from '../../store.js';
import { loadVcenterConfig } from '../../config.js';
import { fetchVmMetric, fetchVmRightsizeSeries, fetchVmsRightsizeBatch, fetchVmsUsageBatch, fetchHostsPerfSeries, PERF_INTERVALS } from '../../vcenter/soapClient.js';
import { USAGE_DAYS, normDays, intervalForDays, intervalForRangeMs, averageByTimestamp } from '../../vcenter/perfBatch.js'; // v2.492: 트리 행 기간 사용률 · v2.494: 호스트/클러스터 추이
import { analyzeRightsize } from '../../tools/rightsize.js';
import { buildWasteSheets, reportTargets, reportFileName, exportZipName } from '../../tools/wasteExport.js'; // v2.497: 낭비 리소스 엑셀 내보내기
import { sheetsToWorkbook } from '../../tools/wasteExportXlsx.js';
import { renderRightsizeHtml } from '../../tools/rightsizeHtml.js';
import { zipMany } from '../../util/zip.js';
import { withJob, withJobSync } from '../../perf/monitor.js'; // v2.498: 루프 정체가 관측되면 '그때 이 작업이 돌았다' 를 남긴다
import { poweredOffSinceFor } from '../../tools/powerOff.js'; // v2.483: 전원 꺼진 VM 의 꺼진 시각
import { loadPowerOffSettings, savePowerOffSettings, LIMITS as POWEROFF_LIMITS } from '../../tools/powerOffSettings.js'; // v2.484
import { powerOffPollerStatus, runPowerOffCheckNow } from '../../tools/powerOffPoller.js';
import { diskBreakdown, analyzeDiskTrend, diskTrendPolicyFromEnv } from '../../tools/diskTrend.js';
import { getMetricsDb } from '../../metrics/db.js';
import { vmperfHistory, vmperfMeta, vmperfDiskUsage, dropVmperfDb, dbFileName, VMPERF_METRICS, VMPERF_DISK_METRICS, VMPERF_VMDISK_METRICS } from '../../metrics/vmperfDb.js';
import { loadVmperfSettings, saveVmperfSettings, VMPERF_LIMITS } from '../../metrics/vmperfSettings.js';
import { memoJson, hash, linregSlope, eachLimited, scopeSlice, scopeKey } from './shared.js';
import { normGroupQuery, filterVmsByGroup, inventoryGroups, hasGroup } from './groupFilter.js'; // v2.491: 클러스터·폴더 하위 범위

export function registerToolsCapacity(api) {

// Capacity report — per-cluster compute capacity, allocation, overcommit, headroom.
api.get('/tools/capacity', requirePerm('tools'), (req, res) => memoJson(req, res, 'tools-capacity', (snap) => {
  const vcId = req.query.vcenterId;
  const scoped = scopeSlice(snap, req.user, vcId);   // 사용자 scope + ?vcenterId
  const hosts = scoped.hosts;
  const vms = scoped.vms.filter((v) => !v.template);
  const r1 = (x) => Number((x || 0).toFixed(1));
  const byCluster = new Map();
  const key = (h) => `${h.vcenterId}|${h.cluster || 'standalone'}`;
  for (const h of hosts) {
    const k = key(h);
    const c = byCluster.get(k) || { vcenterId: h.vcenterId, cluster: h.cluster || 'standalone', hosts: 0, cores: 0, cpuTotalMhz: 0, cpuUsedMhz: 0, memTotalGB: 0, memUsedGB: 0, vcpuOn: 0, vcpuAll: 0, ramOnGB: 0, vmsOn: 0, vms: 0 };
    c.hosts++; c.cores += h.cpuCores || 0; c.cpuTotalMhz += h.cpuTotalMhz || 0; c.cpuUsedMhz += h.cpuUsageMhz || 0;
    c.memTotalGB += (h.memTotalMB || 0) / 1024; c.memUsedGB += (h.memUsageMB || 0) / 1024;
    byCluster.set(k, c);
  }
  for (const v of vms) {
    const k = `${v.vcenterId}|${v.cluster || 'standalone'}`;
    const c = byCluster.get(k); if (!c) continue;
    c.vms++; const on = v.powerState === 'POWERED_ON';
    c.vcpuAll += v.cpuCount || 0;
    if (on) { c.vcpuOn += v.cpuCount || 0; c.ramOnGB += (v.memMB || 0) / 1024; c.vmsOn++; }
  }
  const clusters = [...byCluster.values()].map((c) => ({
    vcenterId: c.vcenterId, cluster: c.cluster, hosts: c.hosts, vms: c.vms, vmsOn: c.vmsOn,
    cores: c.cores, memTotalGB: Math.round(c.memTotalGB),
    vcpuAllocated: c.vcpuOn, vcpuTotal: c.vcpuAll, ramAllocatedGB: Math.round(c.ramOnGB),
    vcpuPerCore: c.cores ? r1(c.vcpuOn / c.cores) : 0,
    ramOvercommitPct: c.memTotalGB ? Math.round((c.ramOnGB / c.memTotalGB) * 100) : 0,
    cpuUsedPct: c.cpuTotalMhz ? Math.round((c.cpuUsedMhz / c.cpuTotalMhz) * 100) : 0,
    memUsedPct: c.memTotalGB ? Math.round((c.memUsedGB / c.memTotalGB) * 100) : 0,
    ramHeadroomGB: Math.round(c.memTotalGB - c.ramOnGB),
  })).sort((a, b) => b.ramOvercommitPct - a.ramOvercommitPct);
  const sum = (f) => clusters.reduce((a, x) => a + f(x), 0);
  return {
    scope: vcId || 'all',
    clusters,
    totals: {
      clusters: clusters.length, hosts: sum((c) => c.hosts), cores: sum((c) => c.cores),
      memTotalGB: sum((c) => c.memTotalGB), vcpuAllocated: sum((c) => c.vcpuAllocated), ramAllocatedGB: sum((c) => c.ramAllocatedGB),
      vcpuPerCore: sum((c) => c.cores) ? r1(sum((c) => c.vcpuAllocated) / sum((c) => c.cores)) : 0,
      ramHeadroomGB: sum((c) => c.ramHeadroomGB),
    },
  };
}, { extraKey: scopeKey(req.user, store.get()) }));

/**
 * 과할당(rightsizing) 리포트 — "할당했지만 쓰지 않는" CPU clock·메모리를 집계한다(v2.373).
 *
 * 데이터 출처(스냅샷 필드만 사용 — 추가 vCenter 호출 없음):
 *  - VM 할당: `cpuCount`(vCPU), `memMB`.
 *  - VM 사용률: `cpuUsagePct` = overallCpuUsage(MHz)/(vCPU×호스트코어MHz),
 *               `memUsagePct` = guestMemoryUsage/memMB  (soapClient.js 산출).
 *  - vCPU → clock 환산: VM 이 올라간 **호스트의 코어당 MHz**(= host.cpuTotalMhz/host.cpuCores).
 *    VM 객체에는 MHz 원값이 없어 호스트를 조인해 환산한다(호스트 정보가 없으면 그 VM 은
 *    clock 집계에서 제외하고 excludedNoHostMhz 로 센다 — 임의값으로 추정하지 않는다).
 *
 * ⚠ 한계(정직): 이 수치는 **스냅샷 시점(현재)의 순간 사용률** 기준이다. vCenter quickStats 의
 *   순간값이라 '평소 한가하지만 지금 바쁜' VM 은 절감 후보에서 빠지고 그 반대도 가능하다.
 *   실제 리사이징 결정에는 기간 평균/피크(예: 1주 P95)가 필요하며, 그 데이터는 이 스냅샷에
 *   없다 — 그래서 이 리포트는 '후보 탐색·규모 감각' 용도이고 화면에도 그렇게 표기한다.
 *   전원이 꺼진 VM 은 사용률이 0 이라 여기서 제외한다(이미 poweredOff 항목이 다룬다).
 */
function overAllocatedReport(scoped, vms, { top = 50 } = {}) {
  const r1 = (x) => Number((x || 0).toFixed(1));
  const pctOf = (used, alloc) => (alloc > 0 ? Math.round((used / alloc) * 100) : 0);
  // 호스트 코어당 MHz — VM 의 vCPU 를 clock(MHz) 으로 환산하는 유일한 근거.
  // 키를 `${vcenterId}|${name}` 로 — 이름만 쓰면 vCenter 간 동명 호스트(localhost.localdomain
  // 등)가 서로 덮어써 다른 사이트의 코어당 MHz 로 환산된다.
  const hostMhz = new Map();
  for (const h of scoped.hosts || []) {
    const cores = Number(h.cpuCores) || 0;
    const total = Number(h.cpuTotalMhz) || 0;
    if (cores > 0 && total > 0) hostMhz.set(`${h.vcenterId}|${h.name}`, total / cores); // v2.478(감사 B13): 주석대로 vCenter 별 키
  }
  const on = vms.filter((v) => v.powerState === 'POWERED_ON');
  let cpuAllocMhz = 0; let cpuUsedMhz = 0; let excludedNoHostMhz = 0;
  let memAllocMB = 0; let memUsedMB = 0;
  const items = [];
  for (const v of on) {
    const vcpu = Number(v.cpuCount) || 0;
    const memMB = Number(v.memMB) || 0;
    const cpuPct = Number(v.cpuUsagePct) || 0;
    const memPct = Number(v.memUsagePct) || 0;
    const mhzPerCore = hostMhz.get(`${v.vcenterId}|${v.host}`);
    // 메모리는 호스트 정보 없이도 계산 가능(MB 단위 그대로).
    const mUsed = memMB * (memPct / 100);
    memAllocMB += memMB; memUsedMB += mUsed;
    let cAlloc = null; let cUsed = null;
    if (mhzPerCore && vcpu > 0) {
      cAlloc = vcpu * mhzPerCore;
      cUsed = cAlloc * (cpuPct / 100);
      cpuAllocMhz += cAlloc; cpuUsedMhz += cUsed;
    } else if (vcpu > 0) {
      excludedNoHostMhz += 1; // 호스트 MHz 미상 — clock 합계에서 제외(추정 금지)
    }
    items.push({
      id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host || '', cluster: v.cluster || '',
      guestOS: v.guestOS || '', vcpu, cpuUsagePct: Math.round(cpuPct), memUsagePct: Math.round(memPct),
      cpuAllocMhz: cAlloc == null ? null : Math.round(cAlloc),
      cpuUsedMhz: cUsed == null ? null : Math.round(cUsed),
      cpuIdleMhz: cAlloc == null ? null : Math.round(cAlloc - cUsed),
      memAllocGB: r1(memMB / 1024), memUsedGB: r1(mUsed / 1024), memIdleGB: r1((memMB - mUsed) / 1024),
      // 절감 가능(%) = 미사용 비율. 100 - 사용률 과 같지만 의미를 명시적으로 둔다.
      cpuSavingPct: cAlloc == null ? null : Math.max(0, 100 - Math.round(cpuPct)),
      memSavingPct: memMB > 0 ? Math.max(0, 100 - Math.round(memPct)) : null,
    });
  }
  // 후보: 사용률이 낮아 줄일 여지가 큰 VM(임계는 화면에서 조정 가능하도록 값도 함께 반환).
  const CPU_IDLE_PCT = 20;   // 이 이하면 CPU 과할당 후보
  const MEM_IDLE_PCT = 40;   // 이 이하면 메모리 과할당 후보
  const cpuCand = items.filter((x) => x.cpuAllocMhz != null && x.cpuUsagePct <= CPU_IDLE_PCT && x.vcpu > 1);
  const memCand = items.filter((x) => x.memAllocGB > 0 && x.memUsagePct <= MEM_IDLE_PCT);
  const byIdleMhz = (a, b) => (b.cpuIdleMhz || 0) - (a.cpuIdleMhz || 0);
  const byIdleGB = (a, b) => (b.memIdleGB || 0) - (a.memIdleGB || 0);
  return {
    // wasteReport 가 vCenter 별 후보 수를 세고 지운다(응답에는 실리지 않음).
    cpuCandidatesList: cpuCand.map((x) => ({ vcenterId: x.vcenterId })), memCandidatesList: memCand.map((x) => ({ vcenterId: x.vcenterId })),
    thresholds: { cpuIdlePct: CPU_IDLE_PCT, memIdlePct: MEM_IDLE_PCT },
    poweredOnVms: on.length,
    excludedNoHostMhz,     // 호스트 코어 MHz 를 몰라 clock 집계에서 빠진 VM 수(투명성)
    cpu: {
      allocGHz: r1(cpuAllocMhz / 1000), usedGHz: r1(cpuUsedMhz / 1000), idleGHz: r1((cpuAllocMhz - cpuUsedMhz) / 1000),
      usedPct: pctOf(cpuUsedMhz, cpuAllocMhz), savingPct: Math.max(0, 100 - pctOf(cpuUsedMhz, cpuAllocMhz)),
      candidates: cpuCand.length,
    },
    mem: {
      allocGB: r1(memAllocMB / 1024), usedGB: r1(memUsedMB / 1024), idleGB: r1((memAllocMB - memUsedMB) / 1024),
      usedPct: pctOf(memUsedMB, memAllocMB), savingPct: Math.max(0, 100 - pctOf(memUsedMB, memAllocMB)),
      candidates: memCand.length,
    },
    // 상위 후보 목록(각 50개 상한 — 응답 크기 유계. 엑셀 내보내기 '전량' 은 top=Infinity).
    cpuTop: [...cpuCand].sort(byIdleMhz).slice(0, top),
    memTop: [...memCand].sort(byIdleGB).slice(0, top),
  };
}

/**
 * 낭비 리소스 본문(v2.497: /tools/waste 콜백에서 추출) — 화면 응답과 엑셀 내보내기가 **같은 함수**를 쓴다
 * (수치 불일치 방지). topOff/topOther 로 상위 N 절단을 제어한다(화면 300/50, 내보내기 전량은 Infinity).
 * byVcenter: vCenter 별 현황(사용자 요구 'vCenter 별 전체 현황') — 절단 전 전체 기준.
 */
function wasteReport(scoped, vms, { topOff = 300, topOther = 50 } = {}) {
  const r1 = (x) => Number((x || 0).toFixed(1));
  const off = vms.filter((v) => v.powerState !== 'POWERED_ON');
  const snaps = vms.filter((v) => (v.snapshotCount || 0) > 0);
  const thin = vms.filter((v) => v.thin);
  const noTools = vms.filter((v) => v.powerState === 'POWERED_ON' && v.toolsStatus && v.toolsStatus !== 'RUNNING');
  const top = (arr, fn, n = 50) => [...arr].sort((a, b) => fn(b) - fn(a)).slice(0, n);
  const overAllocated = overAllocatedReport(scoped, vms, { top: topOther });
  // vCenter 별 집계(전체 기준, 절단 무관). 과할당 후보 수는 items 가 아닌 후보 판정을 다시 세지 않고
  // cpuTop/memTop(전량일 때만 완전) 대신 임계로 직접 센다 — 화면 KPI 의 candidates 와 같은 규칙.
  const byVc = new Map();
  const bump = (id, f) => { let e = byVc.get(id); if (!e) { e = { vcenterId: id, vms: 0, poweredOff: 0, poweredOffGB: 0, snapshots: 0, snapshotGB: 0, noTools: 0, thinReclaimGB: 0, cpuCandidates: 0, memCandidates: 0 }; byVc.set(id, e); } f(e); };
  for (const v of vms) bump(v.vcenterId, (e) => { e.vms++; });
  for (const v of off) bump(v.vcenterId, (e) => { e.poweredOff++; e.poweredOffGB += v.storageGB || 0; });
  for (const v of snaps) bump(v.vcenterId, (e) => { e.snapshots++; e.snapshotGB += v.snapshotSizeGB || 0; });
  for (const v of noTools) bump(v.vcenterId, (e) => { e.noTools++; });
  for (const v of thin) bump(v.vcenterId, (e) => { e.thinReclaimGB += v.uncommittedGB || 0; });
  for (const v of overAllocated.cpuCandidatesList || []) bump(v.vcenterId, (e) => { e.cpuCandidates++; });
  for (const v of overAllocated.memCandidatesList || []) bump(v.vcenterId, (e) => { e.memCandidates++; });
  delete overAllocated.cpuCandidatesList; delete overAllocated.memCandidatesList;
  return {
    overAllocated,
    poweredOff: { count: off.length, storageGB: off.reduce((a, v) => a + (v.storageGB || 0), 0),
      vms: top(off, (v) => v.storageGB || 0, topOff).map((v) => ({ id: v.id, name: v.name, vcenterId: v.vcenterId, storageGB: v.storageGB, guestOS: v.guestOS })) },
    snapshots: { count: snaps.length, sizeGB: r1(snaps.reduce((a, v) => a + (v.snapshotSizeGB || 0), 0)),
      vms: top(snaps, (v) => v.snapshotSizeGB || 0, topOther).map((v) => ({ id: v.id, name: v.name, vcenterId: v.vcenterId, snapshotCount: v.snapshotCount, snapshotSizeGB: v.snapshotSizeGB })) },
    thinReclaim: { count: thin.length, reclaimableGB: thin.reduce((a, v) => a + (v.uncommittedGB || 0), 0) },
    noTools: { count: noTools.length, vms: noTools.slice(0, topOther).map((v) => ({ id: v.id, name: v.name, vcenterId: v.vcenterId, toolsStatus: v.toolsStatus })) },
    byVcenter: [...byVc.values()].sort((a, b) => a.vcenterId.localeCompare(b.vcenterId)).map((e) => ({ ...e, poweredOffGB: r1(e.poweredOffGB), snapshotGB: r1(e.snapshotGB), thinReclaimGB: r1(e.thinReclaimGB) })),
  };
}

// Waste report — 자원 낭비 후보 모음(스냅샷 기반): 전원 꺼진 VM, 스냅샷 보유 VM,
// thin 회수가능, Tools 미설치. (고아 VMDK는 데이터스토어 파일 스캔이 필요해 미포함)
api.get('/tools/waste', requirePerm('tools'), (req, res) => memoJson(req, res, 'tools-waste', (snap) => {
  const vcId = req.query.vcenterId;
  // scope(vcenterId) 교집합이 먼저, 그 다음 클러스터·폴더(v2.491). 호스트는 거르지 않는다 —
  // overAllocatedReport 가 '코어당 MHz' 조회표로만 쓰므로, 폴더 선택(클러스터를 넘나듦)에서
  // 호스트까지 거르면 CPU clock 환산이 통째로 '근거 없음' 이 된다.
  const scoped = scopeSlice(snap, req.user, vcId);
  const group = normGroupQuery(req.query);
  const vms = filterVmsByGroup(scoped.vms, group).filter((v) => !v.template);
  return {
    scope: vcId || 'all',
    // v2.491: 적용된 하위 범위를 응답에 실어 화면이 '무엇을 기준으로 센 수치' 인지 표시할 수 있게 한다.
    group: hasGroup(group) ? group : null,
    // 본문은 wasteReport(v2.497 추출) — 할당했지만 쓰지 않는 CPU clock·메모리(v2.373), 전원 꺼짐(v2.483:
    // 상위 50 → 300, '꺼진 지 N일' 정렬·검토용), 스냅샷·thin·Tools 미실행 + vCenter 별 현황.
    ...wasteReport(scoped, vms),
  };
}, { extraKey: scopeKey(req.user, store.get()) }));

/**
 * VM 기간 사용률 배치 조회(v2.492) — POST /vms/usage
 *   body { vmIds: string[], days: 7|30|90|180|365 }
 *   → { days, interval, intervalSec, maxVms, truncated, synthesized, source, usage: { vmId: {…}|null } }
 *
 * 왜 이 엔드포인트인가: Platform › 'VM 및 폴더' 트리 행에는 지금 **할당 사양**(vCPU·GB)만 있고
 * 실제로 얼마나 쓰는지가 없다. 기간 실사용률의 유일한 출처는 vCenter 가 보관하는 성능 롤업이며,
 * 우리 DB 에는 per-VM 시계열이 없다(sampler.js 주석 — 5,850 VM × 시간당 1행 = 연 5천만 행이라
 * 의도적으로 적재하지 않는다). 그래서 **필요할 때 화면에 보이는 행만** 빌려온다.
 *
 * 폭주 방지(28 vCenter · 일부 RTT 800ms 초과):
 *  - 요청당 VM 상한 MAX_VMS(기본 60) — 초과분은 잘라내고 truncated 로 알린다.
 *  - vCenter 당 **로그인 1회 + 청크(25 VM)당 QueryPerf 1회**(fetchVmsUsageBatch). VM 1대씩
 *    로그인하는 기존 경로(fetchVmMetric)로 60 VM 을 돌리면 왕복이 수백 회가 된다.
 *  - vCenter 동시성 4(eachLimited) — 느린 한 곳이 나머지를 막지 않게.
 *  - 결과 5분 캐시(usageCache, 키 `vmId|days`) — 폴더 접기/펼치기·재렌더로 같은 VM 을 반복 조회하지 않게.
 *  - per-vCenter best effort: 한 vCenter 실패가 전체를 깨지 않고 그 VM 들만 null.
 *
 * scope: 요청 vmId 중 '허용 vCenter 소속으로 **스냅샷에 실재하는**' VM 만 남긴다(범위 밖 VM 성능
 * 유출 차단 — spark 와 같은 규약). 전량 조회 라우트가 아니므로 memoJson 을 쓰지 않는다.
 * 권한: 트리는 Platform 화면이라 /tools 아래에 두지 않는다(도구별 접근 거부가 인벤토리 화면을
 * 막지 않게). 읽기성 POST 이므로 상태변경 RBAC 대상이 아니다.
 */
const usageCache = new Map(); // `${vmId}|${days}` -> { at, u }
const USAGE_TTL_MS = 5 * 60_000;
const USAGE_MAX_VMS = Math.max(1, Math.min(200, Number(process.env.VM_USAGE_MAX_VMS) || 60));

api.post('/vms/usage', async (req, res) => {
  const days = normDays(req.body?.days);
  const interval = intervalForDays(days);
  const ids = Array.isArray(req.body?.vmIds) ? req.body.vmIds.map(String) : [];
  const base = { days, interval, intervalSec: PERF_INTERVALS[interval], maxVms: USAGE_MAX_VMS, allDays: USAGE_DAYS };
  if (!ids.length) return res.json({ ...base, truncated: false, synthesized: false, usage: {} });
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const byId = new Map((snap.vms || []).map((v) => [v.id, v]));
  const targets = [];
  for (const id of ids) {
    const v = byId.get(id);
    if (!v) continue;
    if (allowed && !allowed.has(v.vcenterId)) continue;
    targets.push(v);
    if (targets.length >= USAGE_MAX_VMS) break;
  }
  const truncated = ids.length > targets.length;
  const now = Date.now();
  const usage = {};
  const need = [];
  for (const v of targets) {
    const hit = usageCache.get(`${v.id}|${days}`);
    if (hit && now - hit.at < USAGE_TTL_MS) usage[v.id] = hit.u;
    else need.push(v);
  }
  const put = (id, u) => { usage[id] = u; usageCache.set(`${id}|${days}`, { at: now, u }); };
  if (need.length) {
    if (snap.source === 'mock') {
      // 데모(mock): 실데이터가 없으므로 스냅샷 순간값 주변으로 **결정적** 합성값을 만든다.
      // 응답에 synthesized:true 로 표기해 화면이 '합성' 임을 밝힌다(실측처럼 보이면 안 된다).
      for (const v of need) {
        const jit = (seed, span) => ((hash(`${v.id}|${days}|${seed}`) % 1000) / 1000 - 0.5) * span;
        const mk = (cur) => {
          const avg = Math.max(0, Math.min(100, Math.round(((cur || 0) * 0.8 + jit('a', 12)) * 10) / 10));
          return { avg, max: Math.max(avg, Math.min(100, Math.round((avg + 8 + jit('m', 20)) * 10) / 10)) };
        };
        const c = mk(v.cpuUsagePct); const mm = mk(v.memUsagePct);
        put(v.id, v.powerState === 'POWERED_ON'
          ? { cpuPct: c.avg, cpuMax: c.max, memPct: mm.avg, memMax: mm.max, samples: days <= 30 ? days * 12 : days, coverageDays: days }
          : null);
      }
    } else {
      const cfgs = loadVcenterConfig().vcenters;
      // vCenter 별로 묶어 로그인을 1회로 줄인다(VM 1대당 로그인 금지 — 이 엔드포인트의 존재 이유).
      const groups = new Map();
      for (const v of need) {
        if (!groups.has(v.vcenterId)) groups.set(v.vcenterId, []);
        groups.get(v.vcenterId).push(v);
      }
      const end = now;
      const start = now - days * 86_400_000;
      await eachLimited([...groups.entries()], 4, async ([vcId, list]) => {
        const vc = cfgs.find((x) => x.id === vcId);
        if (!vc) { for (const v of list) put(v.id, null); return; }
        // vm.id = `${vc.id}:${moref}` 이고 vc.id 자체에 콜론이 있을 수 있다 → split 대신 길이로 자른다
        // (dsBrowse.js·spark 와 같은 패턴. split 이면 moref 가 깨져 그 vCenter 전체가 조용히 빈다).
        const refOf = (v) => v.id.slice(String(v.vcenterId || '').length + 1);
        try {
          const r = await fetchVmsUsageBatch(vc, list.map(refOf), interval, { start, end });
          for (const v of list) put(v.id, r.usage.get(refOf(v)) || null);
        } catch {
          for (const v of list) put(v.id, null); // 이 vCenter 만 실패(권한·사이트 위임 수집 등) — 트리는 계속 그린다
        }
      });
    }
  }
  if (usageCache.size > 8000) {
    for (const [k, e] of usageCache) if (now - e.at > USAGE_TTL_MS) usageCache.delete(k);
  }
  res.json({ ...base, truncated, synthesized: snap.source === 'mock', source: snap.source || '', usage });
});

/**
 * 클러스터·폴더 선택 목록(v2.491) — GET /tools/groups?vcenterId=
 *
 * 특수 기능 헤더의 콤보 박스가 **실재하는 값만** 고르게 하기 위한 목록(자유 입력 금지 → 오타로
 * '결과 0건' 이 나오는 사고를 막는다). scope 를 먼저 적용하므로 범위 제한 계정은 자기 vCenter 의
 * 클러스터·폴더만 본다. 폴더는 SOAP 수집 경로에서만 채워지므로 REST 수집 vCenter 는 빈 배열이 정상.
 */
api.get('/tools/groups', requirePerm('tools'), (req, res) => memoJson(req, res, 'tools-groups', (snap) => {
  const vcId = req.query.vcenterId;
  return { scope: vcId || 'all', ...inventoryGroups(scopeSlice(snap, req.user, vcId)) };
}, { ttlMs: 30_000, extraKey: scopeKey(req.user, store.get()) }));

/**
 * 전원 꺼진 VM 의 '꺼진 지 N일'(v2.483) — GET /tools/waste/off-since?vcenterId=
 * /tools/waste 와 같은 scope 규칙. 출처(이벤트/추적/first_seen)·정확도는 tools/powerOff.js 참조.
 * 비동기(DB 조회)라 memoJson 동기 콜백인 /tools/waste 에 합치지 않고 별도 엔드포인트 — 화면이 목록을
 * 먼저 그리고 이 값을 뒤이어 채운다.
 */
api.get('/tools/waste/off-since', requirePerm('tools'), async (req, res) => {
  const vcId = req.query.vcenterId ? String(req.query.vcenterId) : '';
  const snap = store.get();
  const off = filterVmsByGroup(scopeSlice(snap, req.user, vcId).vms, normGroupQuery(req.query))
    .filter((v) => !v.template && v.powerState !== 'POWERED_ON');
  try {
    const r = await poweredOffSinceFor(off.map((v) => ({ id: v.id, name: v.name, vcenterId: v.vcenterId })));
    res.json({ scope: vcId || 'all', generatedAt: Date.now(), ...r });
  } catch (e) {
    res.status(500).json({ ok: false, reason: `꺼진 시각 조회 실패: ${e.message}` });
  }
});

/**
 * 낭비 리소스 엑셀 내보내기(v2.497) — GET /tools/waste/export?vcenterId=&cluster=&folder=&days=30&full=0
 *   → application/zip = waste-<scope>-<stamp>.xlsx + reports/<vm>.html
 *
 * 사용자 요구: "vCenter 별 전체 현황을 엑셀로 — 이 표를 그대로, 근거/리포트 파일을 엑셀에서 클릭해 볼 수 있게
 * 첨부파일로". xlsx 는 화면 하위 탭과 같은 6시트(tools/wasteExport.js), CPU/메모리 과할당 VM 마다 자원 축소
 * 근거 리포트(HTML, tools/rightsizeHtml.js)를 ZIP 안 reports/ 에 넣고 시트의 '근거 리포트' 셀이 상대 링크로
 * 가리킨다. 리포트 형식이 HTML 인 이유: 서버에 PDF 엔진이 없고(웹 jsPDF 전용) 에어갭 패키지에 의존성을
 * 추가하지 않기 위해서(브라우저 인쇄 → PDF 가능).
 *
 * 부하 설계(28 vCenter · RTT 800ms 초과 사이트):
 *  - 리포트 계열은 vCenter 당 로그인 1회 + 8 VM 청크당 QueryPerf 1회(fetchVmsRightsizeBatch), vCenter 동시 4.
 *  - 5분 rightsizeCache 공유 — 모달에서 이미 본 VM 은 왕복 0, 내보내기 뒤 모달을 열면 즉시.
 *  - 리포트 상한 WASTE_EXPORT_MAX_REPORTS(기본 200) — 넘는 VM 은 '리포트 생략(상한)' 으로 정직 표기.
 *  - 서버 전체 동시 1건(wasteExportBusy) — 반복 클릭으로 vCenter/포탈 CPU 가 몰리지 않게(폴러 재진입 가드와
 *    같은 원칙). 진행 중이면 409 export_busy.
 *  - HTML 생성 10건마다·xlsx 200행마다 setImmediate 양보.
 * scope: /tools/waste 와 동일(scopeSlice → cluster/folder). 리포트 대상도 그 결과에서만 나온다.
 * full=1: 상위 N 절단 없이 전량(전원 꺼짐 300·그 외 50 → 전부). 리포트 상한은 그대로 적용된다.
 */
let wasteExportBusy = null; // { user, at }
const WASTE_EXPORT_MAX_REPORTS = Math.max(1, Math.min(1000, Number(process.env.WASTE_EXPORT_MAX_REPORTS) || 200));
const WASTE_EXPORT_CHUNK = Math.max(1, Math.min(50, Number(process.env.WASTE_EXPORT_CHUNK) || 8));
api.get('/tools/waste/export', requirePerm('tools'), async (req, res) => {
  res.locals.perfExpectSlow = true; // v2.498: vCenter 성능 조회를 동반해 수십 초가 정상인 내보내기
  if (wasteExportBusy) {
    const sec = Math.round((Date.now() - wasteExportBusy.at) / 1000);
    // v2.500(감사 L-2): 진행자 계정명은 **본인일 때만** 밝힌다. tools 권한만 있는 계정이 연타해
    // 관리자 로그인 ID 를 알아내는 계정 열거 단서였다(미인증 응답에 계정명을 싣지 않는 규칙의 형제).
    const mine = wasteExportBusy.user && wasteExportBusy.user === (req.user?.username || '');
    const who = mine ? '내 요청' : '다른 사용자';
    return res.status(409).json({ ok: false, error: 'export_busy', reason: `다른 내보내기가 진행 중입니다(${who} · ${sec}초 경과). 끝난 뒤 다시 시도하세요.` });
  }
  wasteExportBusy = { user: req.user?.username || '', at: Date.now() };
  const t0 = Date.now();
  try {
    const vcId = req.query.vcenterId ? String(req.query.vcenterId) : '';
    const days = normDays(req.query.days);
    const full = ['1', 'true', 'yes'].includes(String(req.query.full || '').toLowerCase());
    const snap = store.get();
    const scoped = scopeSlice(snap, req.user, vcId);
    const group = normGroupQuery(req.query);
    const vms = filterVmsByGroup(scoped.vms, group).filter((v) => !v.template);
    const waste = wasteReport(scoped, vms, full ? { topOff: Infinity, topOther: Infinity } : {});
    // 화면의 VM 이름 검색(q)을 그대로 반영한다 — 사용자 요구가 '이 표를 그대로' 이므로, 검색 중이면
    // 화면에 보이는 행만 나간다. KPI·vCenter 별 현황은 화면과 같이 **전체 기준**을 유지하고(카드 수치와
    // 표가 어긋나지 않게) 필터 사실은 요약 시트에 적는다. 리포트 대상도 필터 후 목록에서만 고른다.
    const q = String(req.query.q || '').trim().slice(0, 100);   // v2.500(감사 L-6): 감사로그·시트 문구 팽창 방지
    if (q) {
      const lower = q.toLowerCase();
      const byName = (rows) => (rows || []).filter((r) => (r.name || '').toLowerCase().includes(lower));
      waste.poweredOff.vms = byName(waste.poweredOff.vms);
      waste.snapshots.vms = byName(waste.snapshots.vms);
      waste.noTools.vms = byName(waste.noTools.vms);
      waste.overAllocated.cpuTop = byName(waste.overAllocated.cpuTop);
      waste.overAllocated.memTop = byName(waste.overAllocated.memTop);
    }
    // '꺼진 지' — 실패해도 내보내기는 계속(시트 주석에 사유).
    let offSince = null;
    try {
      const off = vms.filter((v) => v.powerState !== 'POWERED_ON');
      offSince = await poweredOffSinceFor(off.map((v) => ({ id: v.id, name: v.name, vcenterId: v.vcenterId })));
    } catch (e) { offSince = { rows: [], error: e.message }; }
    // 근거 리포트(CPU ∪ 메모리 과할당 VM, id 중복 제거).
    const targets = reportTargets(waste);
    const capped = targets.slice(0, WASTE_EXPORT_MAX_REPORTS);
    const reports = new Map();
    for (const v of targets.slice(WASTE_EXPORT_MAX_REPORTS)) reports.set(v.id, { skipped: `상한 ${WASTE_EXPORT_MAX_REPORTS}대` });
    const results = await withJob('waste.export.perf', () => rightsizeReportsFor(snap, capped, days));
    const files = []; let failed = 0; let n = 0;
    for (const v of capped) {
      const r = results.get(v.id);
      if (!r || r.error) { reports.set(v.id, { error: r?.error || '알 수 없음' }); failed++; continue; }
      const file = reportFileName(v);
      files.push({ name: file, data: withJobSync('waste.export.html', () => renderRightsizeHtml({ report: r.report, vm: r.report.vm || v, days, generatedAt: t0 })) });
      reports.set(v.id, { file, verdict: r.report.verdict });
      // 양보 간격 3건 — v2.498 계측 실측(mock 전체 범위)에서 10건 간격은 루프를 한 번에 ~830ms
      // 막았다(리포트 1건이 SVG 3개 × 360점). 간격을 줄여 한 덩어리를 수십 ms 로 쪼갠다.
      if ((++n % 3) === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    const reportNote = `리포트 ${files.length}건 생성${failed ? ` · vCenter 조회 실패 ${failed}건` : ''}${targets.length > capped.length ? ` · 상한 초과로 생략 ${targets.length - capped.length}건(WASTE_EXPORT_MAX_REPORTS=${WASTE_EXPORT_MAX_REPORTS})` : ''}${snap.source === 'mock' ? ' · 데모(mock) 합성 데이터' : ''}`;
    const sheets = buildWasteSheets({ waste, offSince, reports, scopeLabel: vcId || 'all', cluster: group.cluster, folder: group.folder, days, full, generatedAt: t0, reportNote, nameFilter: q });
    const wb = await sheetsToWorkbook(sheets);
    // xlsx 직렬화·zip deflate 는 쪼갤 수 없는 동기 구간이다(exceljs·zlib 동기 API) — 작업 이름을
    // 달아 루프 정체가 관측되면 설정 › 서버 성능 측정의 hang 기록에서 원인이 바로 보이게 한다.
    const xlsx = await withJob('waste.export.xlsx', async () => Buffer.from(await wb.xlsx.writeBuffer()));
    const zipName = exportZipName({ scope: vcId || 'all', cluster: group.cluster, folder: group.folder, at: t0 });
    const zip = await withJob('waste.export.zip', async () => zipMany([{ name: zipName.replace(/\.zip$/, '.xlsx'), data: xlsx }, ...files]));
    logAudit({ user: req.user?.username, action: '낭비 리소스 엑셀 내보내기', target: vcId || 'all',
      detail: `days=${days} full=${full} cluster=${group.cluster || ''} folder=${group.folder || ''} q=${q} reports=${files.length} failed=${failed} skipped=${targets.length - capped.length} bytes=${zip.length} ms=${Date.now() - t0}`, ip: req.ip || '' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(zip);
  } catch (e) {
    console.error('[waste-export] 실패:', e);
    if (!res.headersSent) res.status(500).json({ ok: false, reason: `내보내기 실패: ${e.message}` });
  } finally {
    wasteExportBusy = null;
  }
});

/**
 * 여러 VM 의 자원 축소 근거 리포트를 만든다(v2.497, 엑셀 내보내기용). /tools/rightsize 단건과 같은 판정·캐시.
 * 반환 Map&lt;vmId, { report } | { error }&gt;. vCenter 별로 묶어 배치 조회(동시 4), 한 vCenter 실패는 그 VM 들만 error.
 */
async function rightsizeReportsFor(snap, targets, days) {
  const out = new Map();
  const interval = days <= 7 ? 'week' : days <= 30 ? 'month' : 'year';
  const end = Date.now(); const start = end - days * 86_400_000;
  const hostMhz = new Map();
  for (const h of snap.hosts || []) {
    const cores = Number(h.cpuCores) || 0; const total = Number(h.cpuTotalMhz) || 0;
    if (cores > 0 && total > 0) hostMhz.set(`${h.vcenterId}|${h.name}`, total / cores);
  }
  const mhzOf = (vm) => hostMhz.get(`${vm.vcenterId}|${vm.host}`) ?? null;
  const vmById = new Map((snap.vms || []).map((v) => [v.id, v]));
  const analyze = (vm, fetched) => {
    const report = analyzeRightsize({
      vm, hostMhzPerCore: mhzOf(vm), intervalSec: fetched.intervalSec, days, series: fetched.series,
      missing: fetched.missing, empty: fetched.empty, noData: fetched.noData, policy: rightsizePolicy(), now: end, realtime: fetched.realtime || null,
    });
    return { ...report, series: fetched.series, realtime: fetched.realtime || null, synthesized: !!fetched.synthesized };
  };
  const remember = (vm, rep) => {
    rightsizeCache.set(`${vm.id}|${days}`, { at: Date.now(), report: rep });
    if (rightsizeCache.size > 2000) for (const [k, e] of rightsizeCache) if (Date.now() - e.at > RIGHTSIZE_TTL_MS) rightsizeCache.delete(k);
  };
  const byVc = new Map();
  let localN = 0;
  for (const t of targets) {
    const vm = vmById.get(t.id);
    if (!vm) { out.set(t.id, { error: 'VM 을 스냅샷에서 찾을 수 없습니다' }); continue; }
    const hit = rightsizeCache.get(`${vm.id}|${days}`);
    if (hit && end - hit.at < RIGHTSIZE_TTL_MS) { out.set(vm.id, { report: { ...hit.report, cached: true } }); continue; }
    if (snap.source === 'mock') {
      const rep = analyze(vm, mockRightsizeSeries(vm, days, interval, mhzOf(vm), start));
      remember(vm, rep); out.set(vm.id, { report: rep });
      // 데모(mock)는 8계열 × 360표본을 VM 마다 **합성**하므로 이 루프가 순수 동기 CPU 다 —
      // v2.498 계측에서 100 VM 전량 내보내기가 이벤트 루프를 한 번에 ~800ms 막는 것을 관측했다.
      // 5건마다 양보해 덩어리를 수십 ms 로 쪼갠다(운영 경로는 vCenter 왕복 사이에 자연히 양보된다).
      if ((++localN % 5) === 0) await new Promise((r) => setImmediate(r));
      continue;
    }
    if (!byVc.has(vm.vcenterId)) byVc.set(vm.vcenterId, []);
    byVc.get(vm.vcenterId).push(vm);
  }
  if (!byVc.size) return out;
  const cfg = loadVcenterConfig().vcenters || [];
  const morefOf = (vm) => vm.id.slice(String(vm.vcenterId || '').length + 1); // vc.id 에 콜론이 있을 수 있어 split 금지
  await eachLimited([...byVc.entries()], 4, async ([vcenterId, list]) => {
    const vc = cfg.find((x) => x.id === vcenterId);
    if (!vc) { for (const vm of list) out.set(vm.id, { error: 'vCenter 설정을 찾을 수 없습니다' }); return; }
    try {
      const m = await fetchVmsRightsizeBatch(vc, list.map(morefOf), interval, { start, end, chunkSize: WASTE_EXPORT_CHUNK });
      let n = 0;
      for (const vm of list) {
        const fetched = m.get(morefOf(vm));
        if (!fetched) { out.set(vm.id, { error: 'vCenter 가 이 VM 의 계열을 돌려주지 않았습니다' }); continue; }
        const rep = analyze(vm, fetched); remember(vm, rep); out.set(vm.id, { report: rep });
        // 판정(analyzeRightsize)은 8계열 × 수백 표본을 순회하는 동기 계산이다 — 한 vCenter 에
        // VM 이 많으면 이 루프가 연속 동기 구간이 되므로 8건마다 양보한다(값은 이미 받아 뒀다).
        if ((++n % 8) === 0) await new Promise((r) => setImmediate(r));
      }
    } catch (e) {
      for (const vm of list) out.set(vm.id, { error: `vCenter 성능 조회 실패: ${e.message}` });
    }
  });
  return out;
}

/** 데모(mock)용 합성 리포트 계열 — 현재 사용률 주변의 시계열(synthesized 로 표기). 벌룬/스왑은 0. */
function mockRightsizeSeries(vm, days, interval, hostMhzPerCore, start) {
  const n = Math.floor((days * 86_400) / (interval === 'week' ? 1800 : interval === 'month' ? 7200 : 86_400));
  const step = (days * 86_400_000) / n;
  const mk = (base, amp) => Array.from({ length: n }, (_, i) => ({ t: new Date(start + i * step).toISOString(), v: Math.max(0, Math.round((base + Math.sin(i / 7) * amp + Math.cos(i / 13) * amp * 0.5) * 10) / 10) }));
  const mhz = hostMhzPerCore || 2400; const allocMhz = (vm.cpuCount || 1) * mhz;
  return { intervalSec: interval === 'week' ? 1800 : interval === 'month' ? 7200 : 86_400, missing: [], empty: [], noData: [], series: {
    cpuUsageMhz: mk(allocMhz * ((vm.cpuUsagePct || 5) / 100), allocMhz * 0.03),
    cpuUsagePct: mk(vm.cpuUsagePct || 5, 3), cpuReadyMs: mk(60, 30),
    memActiveMB: mk((vm.memMB || 4096) * ((vm.memUsagePct || 5) / 100), (vm.memMB || 4096) * 0.02),
    memConsumedMB: mk((vm.memMB || 4096) * (((vm.memUsagePct || 5) + 15) / 100), (vm.memMB || 4096) * 0.02),
    memBalloonMB: mk(0, 0), memSwappedMB: mk(0, 0), memUsagePct: mk(vm.memUsagePct || 5, 2),
  }, synthesized: true };
}

// v2.484 전원 꺼짐 점검 설정/상태(조회는 tools 권한, 변경·수동 점검은 admin — 게스트 디스크 설정과 같은 경계).
api.get('/tools/waste/off-check', requirePerm('tools'), (_req, res) => {
  res.json({ ok: true, ...powerOffPollerStatus(), limits: POWEROFF_LIMITS });
});
api.put('/tools/waste/off-check/settings', requireRole('admin'), (req, res) => {
  const next = savePowerOffSettings(req.body || {});
  logAudit({ user: req.user?.username, action: '전원 꺼짐 점검 설정 변경', detail: `enabled=${next.enabled} interval=${next.intervalHours}h`, ip: req.ip || '' });
  res.json({ ok: true, settings: next });
});
api.post('/tools/waste/off-check/run', requireRole('admin'), async (req, res) => {
  logAudit({ user: req.user?.username, action: '전원 꺼짐 수동 점검', ip: req.ip || '' });
  res.json(await runPowerOffCheckNow('manual'));
});

/**
 * 할당 vs 실사용 트렌드(v2.374) — '주기적 실사용률을 보고 할당량을 조절' 하기 위한 시계열.
 * 샘플러(기본 1분)가 적재한 vCenter별/전체 집계를 시간당 이상 버킷으로 집계해 돌려준다.
 * metrics db.history 는 60분 정배수 버킷이면 samples_hourly 롤업을 자동으로 써서 원본
 * 풀스캔을 피한다(이벤트 루프 보호 — ARCH-HEAVY-JOB-ISOLATION 참조).
 *
 * query: vcenterId(생략=전체 합계) · days(1~1830, 기본 30) · bucket(hour|day|week, 기본 auto)
 * 응답 points: { ts, cpuAllocGHz, cpuUsedGHz, cpuUsedPct, memAllocGB, memUsedGB, memUsedPct }
 *   — 사용률·절감 가능(%)은 할당/사용에서 파생 계산한다(중복 저장하지 않음).
 */
api.get('/tools/waste/history', requirePerm('tools'), async (req, res) => {
  const vcId = String(req.query.vcenterId || '');
  const days = Math.max(1, Math.min(1830, Number(req.query.days) || 30));
  // scope: 특정 vCenter 요청은 소유 검사, 전체('')는 범위 제한 계정에 주지 않는다
  // (전체 합계는 범위 밖 vCenter 를 포함하므로 — '귀속 없는 데이터 미노출' 불변조건).
  const allowed = scopedVcenterIds(req.user, store.get());
  if (allowed) {
    if (!vcId) return res.status(403).json({ ok: false, reason: '전체 합계 트렌드는 전체 범위 계정만 조회할 수 있습니다. vCenter 를 선택하세요.' });
    if (!allowed.has(vcId)) return res.json({ vcenterId: vcId, days, bucketMs: 0, points: [] }); // 존재 은닉
  }
  // vcId 실재 검증(전체 범위 계정 포함) — getVmperfDb 는 없는 파일을 **생성**하므로,
  // 임의 문자열을 바꿔가며 호출하면 vmperf/ 에 DB 파일이 무한 생성된다(inode·디스크 고갈).
  // /vcenters/:id/usage-history 는 이미 실재 검사를 한다 — 이 라우트만 빠져 있었다.
  if (vcId && !(store.get().vcenters || []).some((v) => v.id === vcId)) {
    return res.json({ vcenterId: vcId, days, bucketMs: 0, points: [] });
  }
  const since = Date.now() - days * 86_400_000;
  const BUCKET = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 };
  const bucketMs = BUCKET[req.query.bucket]
    || (days <= 3 ? 3_600_000 : days <= 60 ? 6 * 3_600_000 : days <= 400 ? 86_400_000 : 7 * 86_400_000);
  const limit = bucketMs <= 3_600_000 ? 3000 : 1500;
  let points = [];
  let meta = null;
  try {
    // v2.376: 이 계열은 **vCenter 별 독립 DB**(metrics/vmperfDb.js)에 있다. 요청한 vCenter 의
    // DB 하나만 열어 조회하므로 28개 순회가 없다(전체 합계는 '' → _all.db).
    const [ca, cu, ma, mu] = await Promise.all(
      VMPERF_METRICS.map((m) => vmperfHistory(vcId, m, since, bucketMs, limit)),
    );
    // ts 기준으로 4계열을 합친다(같은 버킷 경계라 ts 가 일치한다).
    const byTs = new Map();
    const put = (arr, field) => { for (const p of arr || []) { let e = byTs.get(p.ts); if (!e) { e = { ts: p.ts }; byTs.set(p.ts, e); } e[field] = p.avg; } };
    put(ca, 'cpuAllocMhz'); put(cu, 'cpuUsedMhz'); put(ma, 'memAllocMB'); put(mu, 'memUsedMB');
    const r1 = (x) => (x == null ? null : Number(x.toFixed(1)));
    const pct = (u, a) => (a > 0 && u != null ? Math.round((u / a) * 100) : null);
    points = [...byTs.values()].sort((a, b) => a.ts - b.ts).map((e) => ({
      ts: e.ts,
      cpuAllocGHz: r1(e.cpuAllocMhz == null ? null : e.cpuAllocMhz / 1000),
      cpuUsedGHz: r1(e.cpuUsedMhz == null ? null : e.cpuUsedMhz / 1000),
      cpuUsedPct: pct(e.cpuUsedMhz, e.cpuAllocMhz),
      memAllocGB: r1(e.memAllocMB == null ? null : e.memAllocMB / 1024),
      memUsedGB: r1(e.memUsedMB == null ? null : e.memUsedMB / 1024),
      memUsedPct: pct(e.memUsedMB, e.memAllocMB),
    }));
    const m = await vmperfMeta(vcId, 'vm_cpu_alloc_mhz');
    meta = { firstTs: m.firstTs, lastTs: m.lastTs };
  } catch (e) { console.warn('[toolsCapacity] 시계열 조회 실패 — 빈 배열로 응답(감사 B8):', e?.message); points = []; }
  // 관측 시작 이전 구간은 데이터가 없다 — 프론트가 '수집 시작' 을 표기할 수 있게 meta 를 준다.
  res.json({ vcenterId: vcId || 'all', days, bucketMs, collectedSince: meta?.firstTs ?? null, points });
});

/**
 * vCenter 사용량/할당량 추이(v2.377) — Platform › vCenter 상세의 '📈 추이' 탭·상단 미니차트.
 *
 * 기간 프리셋 9종(1h/6h/12h/24h/7d/30d/60d/120d/365d)에 맞춰 버킷을 자동으로 고른다:
 *  - 24시간 이하는 원본(분 단위 샘플)에서 5~30분 버킷 — '오늘 무슨 일이 있었나'를 본다.
 *  - 7일 이상은 60분 정배수 버킷 → vmperfDb 가 **시간당 롤업(samples_hourly)** 을 자동 사용해
 *    원본 풀스캔을 피한다(365일 × 분 단위 원본을 훑으면 이벤트 루프가 멈춘다).
 *
 * 계열: cpu(사용/할당 GHz) · mem(사용/할당 GB) · disk(사용/용량 GB, v2.377 신규 집계).
 * 사용률(%)은 저장하지 않고 사용/할당에서 파생 계산한다(중복 저장 금지).
 *
 * ⚠ 데이터는 수집이 시작된 시점부터만 있다(vm_* 는 v2.374, disk 는 v2.377). 그 이전 구간은
 *   결측이며 응답 collectedSince 로 알려 프론트가 '언제부터 쌓였는지' 표기한다.
 */
const USAGE_RANGES = {
  '1h': { ms: 3_600_000, bucket: 5 * 60_000 },
  '6h': { ms: 6 * 3_600_000, bucket: 10 * 60_000 },
  '12h': { ms: 12 * 3_600_000, bucket: 15 * 60_000 },
  '24h': { ms: 24 * 3_600_000, bucket: 30 * 60_000 },
  '7d': { ms: 7 * 86_400_000, bucket: 3_600_000 },
  '30d': { ms: 30 * 86_400_000, bucket: 6 * 3_600_000 },
  '60d': { ms: 60 * 86_400_000, bucket: 12 * 3_600_000 },
  '120d': { ms: 120 * 86_400_000, bucket: 86_400_000 },
  '365d': { ms: 365 * 86_400_000, bucket: 86_400_000 },
};

api.get('/vcenters/:id/usage-history', async (req, res) => {
  const vcId = String(req.params.id || '');
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  // scope: 범위 밖 vCenter 는 404(존재 은닉 — 단건 라우트 불변조건).
  if (allowed && !allowed.has(vcId)) return res.status(404).json({ ok: false, reason: 'not found' });
  if (!(snap.vcenters || []).some((v) => v.id === vcId)) return res.status(404).json({ ok: false, reason: 'not found' });

  const rangeKey = USAGE_RANGES[req.query.range] ? req.query.range : '24h';
  const { ms, bucket: bucketMs } = USAGE_RANGES[rangeKey];
  const since = Date.now() - ms;
  // 점 수 상한 — 버킷이 작은 구간(1h/5분=12점)엔 여유가 크고, 365일/1일=365점도 안전하다.
  const limit = 2000;

  // ── v2.494: scope=host:<hostId> | cluster:<이름> — 호스트·클러스터 단위 추이 ────────────────
  // 우리 DB 에는 vCenter 단위 합계만 있다(sampler 가 per-호스트 계열을 만들지 않는다). 그래서 이
  // 두 범위는 vCenter 성능 롤업을 **요청 시** 빌려온다(fetchHostsPerfSeries — 로그인 1회 + 청크당
  // QueryPerf 1회). 디스크는 호스트 성능 카운터에 대응하는 값이 없어 null 로 두고 화면이 '해당 없음'
  // 을 표시한다(0 으로 채우지 않는다). 클러스터는 호스트별 계열의 타임스탬프별 평균(결측 제외).
  const scopeRaw = String(req.query.scope || '').trim();
  const scopeM = /^(host|cluster):(.+)$/.exec(scopeRaw);
  if (scopeM) {
    const [, kind, key] = scopeM;
    const vcHosts = (snap.hosts || []).filter((h) => h.vcenterId === vcId);
    let targets = kind === 'host'
      ? vcHosts.filter((h) => h.id === key)
      : vcHosts.filter((h) => (h.cluster || 'standalone') === key).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    // 범위 밖·없는 대상은 404(존재 은닉 — 단건 라우트 불변조건). vCenter scope 는 위에서 이미 검사했다.
    if (!targets.length) return res.status(404).json({ ok: false, reason: 'not found' });
    const totalHosts = targets.length;
    // 클러스터 호스트 상한 — 89대 클러스터 × 24h(5분 롤업 288표본) 이면 표본 5만 개다. 상한을 넘으면
    // 이름순 앞 N 대의 평균이며 hostsOmitted 로 정직하게 알린다(조용히 잘라 '전체 평균' 처럼 보이지 않게).
    const MAX_HOSTS = Math.max(1, Math.min(200, Number(process.env.TREND_CLUSTER_MAX_HOSTS) || 40));
    if (targets.length > MAX_HOSTS) targets = targets.slice(0, MAX_HOSTS);
    const interval = intervalForRangeMs(ms);
    const intervalSec = PERF_INTERVALS[interval];
    if (snap.source === 'mock') {
      // 데모: 스냅샷 순간값 주변의 합성 곡선(실측 아님 — synthesized 표기).
      const n = Math.max(2, Math.min(288, Math.round(ms / (intervalSec * 1000))));
      const base = targets.reduce((a, h) => ({ c: a.c + (h.cpuUsagePct || 0), m: a.m + (h.memUsagePct || 0) }), { c: 0, m: 0 });
      const bc = base.c / targets.length; const bm = base.m / targets.length;
      const points = Array.from({ length: n }, (_, i) => {
        const ts = Date.now() - (n - 1 - i) * intervalSec * 1000;
        const w = Math.sin(i / 7) * 6 + Math.cos(i / 13) * 3;
        return { ts, cpuPct: Math.max(0, Math.min(100, Math.round(bc + w))), memPct: Math.max(0, Math.min(100, Math.round(bm + w / 2))), diskPct: null, cpuHosts: targets.length, memHosts: targets.length };
      });
      return res.json({ vcenterId: vcId, scope: scopeRaw, range: rangeKey, bucketMs: intervalSec * 1000, ranges: Object.keys(USAGE_RANGES), collectedSince: null, points, source: 'vcenter-perf', synthesized: true, hosts: targets.length, hostsTotal: totalHosts, hostsOmitted: totalHosts - targets.length, diskAvailable: false });
    }
    const vc = loadVcenterConfig().vcenters.find((x) => x.id === vcId);
    if (!vc) return res.json({ vcenterId: vcId, scope: scopeRaw, range: rangeKey, bucketMs: intervalSec * 1000, ranges: Object.keys(USAGE_RANGES), collectedSince: null, points: [], source: 'vcenter-perf', hosts: 0, hostsTotal: totalHosts, hostsOmitted: 0, diskAvailable: false, reason: 'vCenter 설정 없음(위임 수집 vCenter 는 중앙에서 성능 조회 불가)' });
    try {
      const refOf = (h) => h.id.slice(String(h.vcenterId || '').length + 1); // vc.id 에 콜론이 있을 수 있어 split 금지
      const r = await fetchHostsPerfSeries(vc, targets.map(refOf), interval, { start: since, end: Date.now() });
      const cpu = r.cpuId ? averageByTimestamp(r.series, r.cpuId, 100) : [];
      const mem = r.memId ? averageByTimestamp(r.series, r.memId, 100) : [];
      const byTs = new Map();
      for (const p of cpu) { const e = byTs.get(p.ts) || { ts: p.ts }; e.cpuPct = p.avg; e.cpuHosts = p.n; byTs.set(p.ts, e); }
      for (const p of mem) { const e = byTs.get(p.ts) || { ts: p.ts }; e.memPct = p.avg; e.memHosts = p.n; byTs.set(p.ts, e); }
      const points = [...byTs.values()].sort((a, b) => a.ts - b.ts).map((e) => ({ diskPct: null, ...e }));
      return res.json({
        vcenterId: vcId, scope: scopeRaw, range: rangeKey, bucketMs: intervalSec * 1000, ranges: Object.keys(USAGE_RANGES),
        collectedSince: null, points, source: 'vcenter-perf', interval, hosts: targets.length, hostsTotal: totalHosts,
        hostsOmitted: totalHosts - targets.length, diskAvailable: false,
        counters: { cpu: !!r.cpuId, mem: !!r.memId },
      });
    } catch (e) {
      // 조회 실패는 500 이 아니라 빈 점 + reason — 화면이 '데이터 없음' 과 '조회 실패' 를 구분해 안내한다.
      return res.json({ vcenterId: vcId, scope: scopeRaw, range: rangeKey, bucketMs: intervalSec * 1000, ranges: Object.keys(USAGE_RANGES), collectedSince: null, points: [], source: 'vcenter-perf', hosts: 0, hostsTotal: totalHosts, hostsOmitted: 0, diskAvailable: false, reason: `vCenter 성능 조회 실패: ${e?.message || e}` });
    }
  }

  let points = [];
  let collectedSince = null;
  try {
    const metrics = [...VMPERF_METRICS, ...VMPERF_DISK_METRICS];
    const series = await Promise.all(metrics.map((m) => vmperfHistory(vcId, m, since, bucketMs, limit)));
    const byTs = new Map();
    metrics.forEach((m, i) => {
      for (const p of series[i] || []) {
        let e = byTs.get(p.ts);
        if (!e) { e = { ts: p.ts }; byTs.set(p.ts, e); }
        e[m] = p.avg;
      }
    });
    const r1 = (x) => (x == null ? null : Number(x.toFixed(1)));
    const pct = (u, a) => (a > 0 && u != null ? Math.round((u / a) * 100) : null);
    points = [...byTs.values()].sort((a, b) => a.ts - b.ts).map((e) => ({
      ts: e.ts,
      cpuAllocGHz: r1(e.vm_cpu_alloc_mhz == null ? null : e.vm_cpu_alloc_mhz / 1000),
      cpuUsedGHz: r1(e.vm_cpu_used_mhz == null ? null : e.vm_cpu_used_mhz / 1000),
      cpuPct: pct(e.vm_cpu_used_mhz, e.vm_cpu_alloc_mhz),
      memAllocGB: r1(e.vm_mem_alloc_mb == null ? null : e.vm_mem_alloc_mb / 1024),
      memUsedGB: r1(e.vm_mem_used_mb == null ? null : e.vm_mem_used_mb / 1024),
      memPct: pct(e.vm_mem_used_mb, e.vm_mem_alloc_mb),
      diskCapGB: r1(e.ds_cap_gb_vc),
      diskUsedGB: r1(e.ds_used_gb_vc),
      diskPct: pct(e.ds_used_gb_vc, e.ds_cap_gb_vc),
    }));
    const m1 = await vmperfMeta(vcId, 'vm_cpu_alloc_mhz');
    const m2 = await vmperfMeta(vcId, 'ds_cap_gb_vc');
    const firsts = [m1.firstTs, m2.firstTs].filter((x) => x != null);
    collectedSince = firsts.length ? Math.min(...firsts) : null;
  } catch (e) { console.warn('[toolsCapacity] 시계열 조회 실패 — 빈 배열로 응답(감사 B8):', e?.message); points = []; }

  res.json({ vcenterId: vcId, range: rangeKey, bucketMs, ranges: Object.keys(USAGE_RANGES), collectedSince, points });
});

/**
 * VM 성능 트래킹 설정(v2.376) — 보존기간 + 대상 vCenter 선택 + 디스크 사용 현황.
 * 6,000 VM 규모에서 이 계열은 용량이 빠르게 늘어(실측 행당 ~308B) 운영자가 통제해야 한다.
 * GET 은 로그인 사용자, 변경(PUT)·삭제(DELETE)는 관리자 전용(수집 정책·데이터 삭제라서).
 */
api.get('/tools/waste/settings', requirePerm('tools'), (req, res) => {
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const s = loadVmperfSettings();
  // 선택 가능한 vCenter 목록은 사용자 범위로 좁힌다(범위 밖 id 노출 금지).
  const vcenters = (snap.vcenters || [])
    .filter((v) => !allowed || allowed.has(v.id))
    .map((v) => ({ id: v.id, name: v.name || v.id }));
  // 디스크 사용량도 범위 밖은 감춘다(전체 합계 '' 는 전체 범위 계정에만).
  // usage 도 파일명 축으로 비교한다(위와 같은 이유 — 특수문자 id 가 범위 내인데 숨는 문제 방지).
  const allowedFiles = allowed ? new Set([...allowed].map((id) => dbFileName(id))) : null;
  const usage = vmperfDiskUsage().filter((u) => (!allowedFiles ? true : (u.vcenterId !== '' && allowedFiles.has(dbFileName(u.vcenterId)))));
  // 범위 제한 계정에는 settings.vcenterIds 를 교집합만 노출한다 — 원본을 그대로 주면
  // 범위 밖 vCenter id 가 열거된다('범위 밖 id 노출 금지' 불변조건).
  const safeSettings = allowed ? { ...s, vcenterIds: (s.vcenterIds || []).filter((id) => allowed.has(id)) } : s;
  res.json({
    settings: safeSettings, limits: VMPERF_LIMITS, vcenters, usage,
    totalBytes: usage.reduce((a, u) => a + u.bytes, 0),
  });
});

api.put('/tools/waste/settings', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const snap = store.get();
  const validIds = new Set((snap.vcenters || []).map((v) => v.id));
  // 유령 vCenter id 를 저장하지 않는다(설정 파일 오염 방지). 빈 배열 = 전체 대상.
  if (b.vcenterIds !== undefined) {
    if (!Array.isArray(b.vcenterIds)) return res.status(400).json({ ok: false, reason: 'vcenterIds 는 배열이어야 합니다.' });
    const bad = b.vcenterIds.filter((x) => !validIds.has(String(x)));
    if (bad.length) return res.status(400).json({ ok: false, reason: `존재하지 않는 vCenter id: ${bad.slice(0, 5).join(', ')}` });
  }
  const before = loadVmperfSettings();
  const next = saveVmperfSettings(b);
  // 대상에서 제외된 vCenter 의 DB 는 파일째 삭제해 **용량을 즉시 회수**한다(분리 아키텍처의 이점).
  // 전체 대상(빈 배열)에서 특정 목록으로 좁힌 경우에도 빠진 vCenter 를 정리한다.
  let dropped = [];
  if (next.vcenterIds.length) {
    // ⚠ vmperfDiskUsage() 의 vcenterId 는 **sanitize 된 파일명에서 역산한 값**이다
    //   (dbFileName 이 [^A-Za-z0-9._-] 를 '_' 로 치환). 원본 id 와 직접 비교하면 콜론 등
    //   특수문자가 있는 vCenter(이 저장소는 vc.id 에 콜론이 있는 사례를 문서화)는 항상 불일치가
    //   되어 **수집 대상으로 지정한 vCenter 의 DB 를 삭제**한다 → 비교축을 파일명으로 통일한다.
    const keep = new Set(next.vcenterIds.map((id) => dbFileName(id)));
    for (const u of vmperfDiskUsage()) {
      if (u.vcenterId === '') continue;              // 전체 합계는 trackTotal 로 따로 관리
      if (!keep.has(dbFileName(u.vcenterId))) { dropVmperfDb(u.vcenterId); dropped.push(u.vcenterId); }
    }
  }
  if (!next.trackTotal && before.trackTotal) { dropVmperfDb(''); dropped.push('(전체 합계)'); }
  logAudit({
    user: req.user?.username, action: 'VM 성능 트래킹 설정 변경',
    target: next.enabled ? `보존 ${next.retentionDays}일 · 대상 ${next.vcenterIds.length || '전체'}` : '비활성',
    detail: dropped.length ? `DB 삭제: ${dropped.join(', ')}` : '', ip: req.ip || '',
  });
  res.json({ ok: true, settings: next, dropped });
});

/** 특정 vCenter(또는 전체 합계)의 수집 데이터 삭제 — 용량 회수용. 관리자 전용. */
api.delete('/tools/waste/settings/data', requireRole('admin'), (req, res) => {
  // ?vcenterId 를 아예 안 보내면 ''(전체 합계 DB)가 되어 무경고로 지워진다 → 명시 요구.
  // 전체 합계를 지우려면 ?vcenterId= (빈 값 명시) 또는 ?all=1 을 보내야 한다.
  if (req.query.vcenterId === undefined && req.query.all !== '1') {
    return res.status(400).json({ ok: false, reason: 'vcenterId 를 명시하세요(전체 합계 삭제는 ?all=1).' });
  }
  const vcId = String(req.query.vcenterId ?? '');
  const removed = dropVmperfDb(vcId);
  logAudit({ user: req.user?.username, action: 'VM 성능 트래킹 데이터 삭제', target: vcId || '(전체 합계)', detail: `파일 ${removed}개`, ip: req.ip || '' });
  res.json({ ok: true, vcenterId: vcId, filesRemoved: removed });
});

/**
 * VM 7일 사용량 스파크라인 배치 조회(v2.375) — 과할당 표의 각 행에 '최근 추이' 미니차트를
 * 그리기 위한 데이터. 낭비 리소스 표는 후보가 수천 개라 한 번에 다 조회하면 안 되므로
 * **화면에 보이는 행만** 프론트가 vmId 배열로 요청한다(POST body).
 *
 * 데이터 출처: vCenter 가 자체 보관하는 성능 히스토리(fetchVmMetric, interval='week' =
 * 30분 해상도). **우리 시계열 DB 에 VM 별 행을 쌓지 않는다** — 5,850 VM × 시간당 1행이면
 * 연 5천만 행이라 감당이 안 되기 때문(sampler vmAllocRows 주석과 같은 이유). vCenter 에
 * 이미 있는 데이터를 필요할 때만 빌려온다.
 *
 * 폭주 방지(28 vCenter·고RTT 환경 필수):
 *  - 요청당 VM 상한 MAX_VMS(기본 24) — 초과분은 잘라내고 truncated 로 알린다.
 *  - vCenter SOAP 동시성 6(eachLimited) — vm-finder 의 평균 조회와 같은 상한.
 *  - 결과 5분 캐시(sparkCache) — 스크롤/재렌더로 같은 VM 을 반복 조회하지 않게.
 *  - per-VM best effort: 한 VM 실패가 전체를 깨지 않고 그 행만 points=null.
 */
const sparkCache = new Map(); // `${vmId}|${type}` -> { at, points }
const SPARK_TTL_MS = 5 * 60_000;
const SPARK_MAX_VMS = Math.max(1, Math.min(64, Number(process.env.WASTE_SPARK_MAX_VMS) || 24));

api.post('/tools/waste/spark', requirePerm('tools'), async (req, res) => {
  const type = req.body?.type === 'mem' ? 'mem' : 'cpu';
  const ids = Array.isArray(req.body?.vmIds) ? req.body.vmIds.map(String) : [];
  if (!ids.length) return res.json({ type, series: {}, truncated: false });
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  // scope: 요청 vmId 중 '허용 vCenter 소속으로 실재하는' VM 만 남긴다(범위 밖 VM 성능 유출 차단).
  const byId = new Map((snap.vms || []).map((v) => [v.id, v]));
  // v2.502: '상한 때문에 잘림'(capped)과 '범위 밖·스냅샷에 없음'(skipped)을 **구분**한다.
  // 예전에는 둘을 `ids.length > targets.length` 하나로 뭉쳐 truncated 로 내려보냈는데, 화면이
  // 이미 상한만큼 잘라 보내면 둘이 같아져 false 가 됐다 — 잘라 놓고 잘랐다는 말을 못 하는 상태였다
  // (표 아래쪽 행이 안내 없이 '…' 로 남던 사용자 신고의 원인 중 하나).
  const targets = [];
  let capped = false;
  let skipped = 0;
  for (const id of ids) {
    if (targets.length >= SPARK_MAX_VMS) { capped = true; break; }
    const v = byId.get(id);
    if (!v) { skipped += 1; continue; }
    if (allowed && !allowed.has(v.vcenterId)) { skipped += 1; continue; }
    targets.push(v);
  }
  const truncated = capped || skipped > 0;   // 하위호환(구버전 화면이 읽는 키)
  const now = Date.now();
  const series = {};
  const need = [];
  for (const v of targets) {
    const ck = `${v.id}|${type}`;
    const hit = sparkCache.get(ck);
    if (hit && now - hit.at < SPARK_TTL_MS) series[v.id] = hit.points;
    else need.push(v);
  }
  if (need.length) {
    if (snap.source === 'mock') {
      // 데모: 현재 사용률 주변으로 7일 합성(실데이터가 아님을 응답에 synthesized 로 표기).
      for (const v of need) {
        const base = type === 'mem' ? (v.memUsagePct || 0) : (v.cpuUsagePct || 0);
        const pts = Array.from({ length: 84 }, (_, i) => {
          const wave = Math.sin(i / 6) * (base * 0.25) + Math.cos(i / 11) * (base * 0.12);
          return { t: now - (84 - i) * 2 * 3_600_000, v: Math.max(0, Math.min(100, Math.round((base + wave) * 10) / 10)) };
        });
        series[v.id] = pts;
        sparkCache.set(`${v.id}|${type}`, { at: now, points: pts });
      }
    } else {
      const cfgs = loadVcenterConfig().vcenters;
      await eachLimited(need, 6, async (v) => {
        const vc = cfgs.find((x) => x.id === v.vcenterId);
        if (!vc) { series[v.id] = null; return; }
        // vm.id = `${vc.id}:${moref}` 인데 vc.id 자체에 콜론이 있을 수 있다 → split 대신
        // vcenterId 길이만큼 잘라낸다(dsBrowse.js 와 동일 패턴). split 이면 moref 가 깨져
        // fetchVmMetric 이 조용히 실패해 그 vCenter 스파크라인이 전부 빈다.
        const moref = v.id.slice(String(v.vcenterId || '').length + 1);
        try {
          // interval 'week' = 1800초(30분) 해상도. 7일 ≈ 336점 → 스파크라인에 충분.
          const m = await fetchVmMetric(vc, moref, type, 'week');
          const pts = (m?.points || []).filter((p) => p && p.v != null).map((p) => ({ t: p.t, v: p.v }));
          series[v.id] = pts.length ? pts : null;
          sparkCache.set(`${v.id}|${type}`, { at: now, points: series[v.id] });
        } catch {
          series[v.id] = null; // 이 VM 만 실패(권한·엣지 수집·전원 OFF 등) — 표는 계속 그린다
        }
      });
    }
  }
  // 캐시 크기 상한 — 오래된 항목 정리(무한 증가 방지).
  if (sparkCache.size > 4000) {
    for (const [k, e] of sparkCache) if (now - e.at > SPARK_TTL_MS) sparkCache.delete(k);
  }
  res.json({ type, interval: 'week', unit: '%', maxVms: SPARK_MAX_VMS, truncated, capped, skipped, synthesized: snap.source === 'mock', series });
});

/**
 * VM 자원 축소 **근거 리포트**(v2.445) — GET /tools/rightsize?vmId=&days=7|30|90
 *
 * 사용자 요구: '줄여도 되는 구체적 근거 — 기간별 추이 차트·벌룬/스왑·설명·공식 문서'.
 * 데이터 출처: vCenter 가 자체 보관하는 성능 롤업(우리가 5,850 VM 분을 쌓지 않는다). 한 VM 당
 * 로그인 1회 + QueryPerf 1회(8계열 동시)라 고RTT 사이트에서도 리포트 한 장 ≈ 왕복 3회.
 * 판정은 순수 모듈(tools/rightsize.js)이 하고 여기서는 scope·캐시·실재 검사만 한다.
 *  - scope: VM 이 허용 vCenter 소속으로 스냅샷에 실재해야 한다(범위 밖은 404 — 존재 은닉).
 *  - 캐시 5분(vmId|days) — 기간 탭을 오가며 같은 조회를 반복하지 않게.
 *  - 정책은 env 로 조정(RIGHTSIZE_HEADROOM_PCT 등) — 응답에 실어 화면이 '무엇 기준인지' 보여준다.
 */
const rightsizeCache = new Map(); // `${vmId}|${days}` -> { at, report }
const RIGHTSIZE_TTL_MS = 5 * 60_000;
const rightsizePolicy = () => ({
  headroomPct: Number(process.env.RIGHTSIZE_HEADROOM_PCT) || undefined,
  minDays: Number(process.env.RIGHTSIZE_MIN_DAYS) || undefined,
  minCoveragePct: Number(process.env.RIGHTSIZE_MIN_COVERAGE_PCT) || undefined,
  capReductionPct: Number(process.env.RIGHTSIZE_CAP_REDUCTION_PCT) || undefined,
  readyWarnPct: Number(process.env.RIGHTSIZE_READY_WARN_PCT) || undefined,
  memBasis: process.env.RIGHTSIZE_MEM_BASIS || undefined, // 'active'(기본, v2.481) | 'consumed'(구 산식)
});

api.get('/tools/rightsize', requirePerm('tools'), async (req, res) => {
  const vmId = String(req.query.vmId || '');
  const days = [7, 30, 90, 180, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
  const snap = store.get();
  const vm = (snap.vms || []).find((v) => v.id === vmId);
  const allowed = scopedVcenterIds(req.user, snap);
  if (!vm || (allowed && !allowed.has(vm.vcenterId))) return res.status(404).json({ ok: false, reason: 'VM 을 찾을 수 없습니다.' });
  const ck = `${vmId}|${days}`;
  const hit = rightsizeCache.get(ck);
  if (hit && Date.now() - hit.at < RIGHTSIZE_TTL_MS) return res.json({ ok: true, cached: true, ...hit.report });

  // 호스트 코어당 MHz — 샘플러와 같은 계산(총 MHz ÷ 코어). 모르면 null(추정 금지).
  const host = (snap.hosts || []).find((h) => h.vcenterId === vm.vcenterId && h.name === vm.host);
  const cores = Number(host?.cpuCores) || 0; const total = Number(host?.cpuTotalMhz) || 0;   // 샘플러와 동일 필드
  const hostMhzPerCore = cores > 0 && total > 0 ? total / cores : null;
  // 기간 → vCenter 롤업 간격. 1주=30분, 1달=2시간, 그 이상=1일(기본 통계 레벨 1 의 보관 규약).
  const interval = days <= 7 ? 'week' : days <= 30 ? 'month' : 'year';
  const end = Date.now(); const start = end - days * 86_400_000;

  let fetched;
  if (snap.source === 'mock') {
    fetched = mockRightsizeSeries(vm, days, interval, hostMhzPerCore, start);
  } else {
    const vc = loadVcenterConfig().vcenters.find((x) => x.id === vm.vcenterId);
    if (!vc) return res.status(404).json({ ok: false, reason: 'vCenter 설정을 찾을 수 없습니다.' });
    const moref = vm.id.slice(String(vm.vcenterId || '').length + 1);   // vc.id 에 콜론이 있을 수 있어 split 금지
    try { fetched = await fetchVmRightsizeSeries(vc, moref, interval, { start, end }); }
    catch (e) { return res.status(502).json({ ok: false, reason: `vCenter 성능 조회 실패: ${e.message}` }); }
  }
  const report = analyzeRightsize({
    vm, hostMhzPerCore, intervalSec: fetched.intervalSec, days, series: fetched.series,
    // 계열이 빈 이유 3종(카탈로그 없음 / 표본 없음 / 전부 결측)을 그대로 넘겨 화면이 원인을 말하게 한다(v2.449).
    missing: fetched.missing, empty: fetched.empty, noData: fetched.noData,
    policy: rightsizePolicy(), now: end, // v2.481: window.start/end 가 실제 vCenter 조회 창과 같게
    realtime: fetched.realtime || null,   // v2.481: 이력에 active 가 없을 때 실시간 active 최대를 워킹셋 하한에 반영
  });
  // realtime: 이력 롤업에 안 잡힌 level-2 mem 카운터의 실시간(최근 1시간) 현재값(참고). 감축 하한엔 미반영.
  const out = { ...report, series: fetched.series, realtime: fetched.realtime || null, synthesized: !!fetched.synthesized };
  rightsizeCache.set(ck, { at: Date.now(), report: out });
  if (rightsizeCache.size > 2000) for (const [k, e] of rightsizeCache) if (Date.now() - e.at > RIGHTSIZE_TTL_MS) rightsizeCache.delete(k);
  res.json({ ok: true, cached: false, ...out });
});

// Thin-provisioned VM finder. thin = uncommitted(여유)이 큰 VM(추정). committed=실사용,
// provisioned=committed+uncommitted. 회수 가능 추정 = uncommitted 합계.
api.get('/tools/thin-vms', requirePerm('tools'), (req, res) => memoJson(req, res, 'tools-thin-vms', (snap) => {
  let vms = snap.vms;
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) vms = vms.filter((v) => allowed.has(v.vcenterId));
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  const round = (v, d = 1) => Number((v || 0).toFixed(d));
  const items = vms.filter((v) => v.thin).map((v) => ({
    id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host, cluster: v.cluster,
    powerState: v.powerState, guestOS: v.guestOS,
    committedGB: v.storageGB || 0,
    uncommittedGB: v.uncommittedGB || 0,
    provisionedGB: (v.storageGB || 0) + (v.uncommittedGB || 0),
  })).sort((a, b) => b.uncommittedGB - a.uncommittedGB);
  return {
    scope: req.query.vcenterId || 'all',
    totalVms: vms.length,
    thinVms: items.length,
    thinPct: vms.length ? Math.round((items.length / vms.length) * 100) : 0,
    committedTB: round(items.reduce((a, x) => a + x.committedGB, 0) / 1024, 1),
    provisionedTB: round(items.reduce((a, x) => a + x.provisionedGB, 0) / 1024, 1),
    reclaimableTB: round(items.reduce((a, x) => a + x.uncommittedGB, 0) / 1024, 1),
    items,
  };
}, { extraKey: scopeKey(req.user, store.get()) }));

// Advanced VM finder: scope by 다수 vCenter + folder/cluster/resourcePool +
// conditions. Optional withAvg → 1일/1주 평균 CPU(유휴 판정). 평균은 live는
// vCenter 성능 API 온디맨드(상한 있음), mock은 현재값 기반 합성.
api.post('/tools/vm-finder', requirePerm('tools'), async (req, res) => {
  const b = req.body || {};
  const snap = store.get();
  const inList = (v, arr) => !arr || !arr.length || arr.includes(v);
  // 사용자 scope 를 요청 vcenterIds 보다 먼저 강제 — facets·items·avg 계산 전 선필터라
  // 폴더/클러스터/풀/vcenters facet 과 결과가 전부 허용 vCenter 로만 파생된다(범위 밖 id 누출 차단).
  const allowed = scopedVcenterIds(req.user, snap);
  const scopeVms = snap.vms.filter((v) => (!allowed || allowed.has(v.vcenterId)) && inList(v.vcenterId, b.vcenterIds));
  const facets = {
    vcenters: [...new Set(scopeVms.map((v) => v.vcenterId))].sort(),
    folders: [...new Set(scopeVms.map((v) => v.folder).filter(Boolean))].sort(),
    clusters: [...new Set(scopeVms.map((v) => v.cluster).filter(Boolean))].sort(),
    resourcePools: [...new Set(scopeVms.map((v) => v.resourcePool).filter(Boolean))].sort(),
  };
  const term = String(b.q || '').trim().toLowerCase();
  let vms = scopeVms.filter((v) =>
    inList(v.folder, b.folders) && inList(v.cluster, b.clusters) && inList(v.resourcePool, b.resourcePools)
    && (!b.powerState || v.powerState === b.powerState)
    && (!b.os || String(v.guestOS || '').toLowerCase().includes(String(b.os).toLowerCase()))
    && (!term || String(v.name || '').toLowerCase().includes(term) || String(v.ipAddress || '').includes(term))
    && (b.includeTemplates || !v.template));

  const round1 = (x) => Number((x || 0).toFixed(1));
  const items = vms.map((v) => ({
    id: v.id, name: v.name, vcenterId: v.vcenterId, folder: v.folder, cluster: v.cluster, resourcePool: v.resourcePool,
    host: v.host, powerState: v.powerState, guestOS: v.guestOS, cpuCount: v.cpuCount, memMB: v.memMB,
    cpuUsagePct: v.cpuUsagePct, memUsagePct: v.memUsagePct, storageGB: v.storageGB,
    avgDayCpu: null, avgWeekCpu: null, idle: null,
  }));

  const result = { facets, total: items.length, items, avgComputed: false };

  if (b.withAvg && items.length) {
    const threshold = Number(b.idleThreshold) || 5;
    const CAP = 40;
    const targets = items.slice(0, CAP);
    result.avgCap = CAP; result.avgComputed = true; result.avgTruncated = items.length > CAP;
    if (snap.source === 'mock') {
      for (const it of targets) {
        // 합성: 현재값 주변으로 일/주 평균(전원 꺼짐=0).
        const base = it.powerState === 'POWERED_ON' ? it.cpuUsagePct : 0;
        it.avgDayCpu = round1(Math.max(0, base * 0.85));
        it.avgWeekCpu = round1(Math.max(0, base * 0.7));
      }
    } else {
      const cfgs = loadVcenterConfig().vcenters;
      await eachLimited(targets, 6, async (it) => {
        const vc = cfgs.find((x) => x.id === it.vcenterId);
        if (!vc) return;
        const moref = it.id.slice(String(it.vcenterId || '').length + 1);   // 콜론 포함 vc.id 안전
        try {
          const [day, week] = await Promise.all([
            fetchVmMetric(vc, moref, 'cpu', 'day').catch(() => null),
            fetchVmMetric(vc, moref, 'cpu', 'week').catch(() => null),
          ]);
          const avg = (m) => { const pts = (m?.points || []).map((p) => p.v).filter((x) => x != null); return pts.length ? round1(pts.reduce((a, x) => a + x, 0) / pts.length) : null; };
          it.avgDayCpu = avg(day); it.avgWeekCpu = avg(week);
        } catch { /* per-VM best effort */ }
      });
    }
    for (const it of targets) {
      const a = it.avgWeekCpu ?? it.avgDayCpu;
      it.idle = it.powerState === 'POWERED_ON' && a != null && a <= threshold;
    }
    result.idleCount = targets.filter((x) => x.idle).length;
    result.idleThreshold = threshold;
  }
  res.json(result);
});

// ESXi 온도 — 현재 값(호스트/클러스터/법인별 그룹) + 5년 히스토리 시계열.
api.get('/tools/esxi-temp', requirePerm('tools'), async (req, res) => {
  const snap = store.get();
  const vcId = req.query.vcenterId;
  const allowed = scopedVcenterIds(req.user, snap);
  const hosts = (snap.hosts || []).filter((h) => (!allowed || allowed.has(h.vcenterId)) && (!vcId || h.vcenterId === vcId) && h.tempC != null);
  const r1 = (x) => (x == null ? null : Number(x.toFixed(1)));
  // 최근 5분 평균/최대(시계열). 표시 컬럼: 현재온도 / 5분 평균 / 최대 온도.
  let avg5Host = new Map(); let avg5Cluster = new Map(); let avg5Vc = new Map();
  try {
    const db = await getMetricsDb();
    const since = Date.now() - 5 * 60_000;
    avg5Host = db.recentAvg('temp_host', since);
    avg5Cluster = db.recentAvg('temp_cluster', since);
    avg5Vc = db.recentAvg('temp_vc', since);
  } catch { /* 시계열 없으면 5분 평균은 null */ }
  const grp = (keyFn, avg5Map) => {
    const m = new Map();
    for (const h of hosts) { const k = keyFn(h); const g = m.get(k) || { key: k, count: 0, sum: 0, max: -Infinity }; g.count++; g.sum += h.tempC; g.max = Math.max(g.max, h.tempMaxC ?? h.tempC); m.set(k, g); }
    return [...m.values()].map((g) => {
      const a5 = avg5Map.get(g.key);
      return { key: g.key, hosts: g.count, curC: r1(g.sum / g.count), avg5C: a5 ? a5.avg : null, maxC: r1(Math.max(g.max, a5?.max ?? -Infinity)) };
    }).sort((a, b) => b.curC - a.curC);
  };
  res.json({
    scope: vcId || 'all',
    reportingHosts: hosts.length,
    totalHosts: (snap.hosts || []).filter((h) => (!allowed || allowed.has(h.vcenterId)) && (!vcId || h.vcenterId === vcId)).length,
    hosts: hosts.map((h) => {
      const a5 = avg5Host.get(h.id);
      return { id: h.id, name: h.name, vcenterId: h.vcenterId, cluster: h.cluster, curC: h.tempC, avg5C: a5 ? a5.avg : null, tempMaxC: r1(Math.max(h.tempMaxC ?? h.tempC, a5?.max ?? -Infinity)), temps: h.temps || [] };
    }).sort((a, b) => b.curC - a.curC),
    clusters: grp((h) => `${h.vcenterId}|${h.cluster || 'standalone'}`, avg5Cluster),
    vcenters: grp((h) => h.vcenterId, avg5Vc),
  });
});

// Temperature history (5년까지). level=host|cluster|vc, key=대상키, days=기간.
api.get('/tools/esxi-temp/history', requirePerm('tools'), async (req, res) => {
  const level = ['host', 'cluster', 'vc'].includes(req.query.level) ? req.query.level : 'host';
  const metric = { host: 'temp_host', cluster: 'temp_cluster', vc: 'temp_vc' }[level];
  const key = String(req.query.key || '');
  const days = Math.max(1, Math.min(1830, Number(req.query.days) || 7));
  // key(호스트/클러스터/vc)의 vCenter 귀속을 scope 로 검사 — 범위 밖 대상 히스토리 조회 차단.
  // cluster key 는 `${vcenterId}|${cluster}`(grp keyFn), host key 는 host.id → snap 역참조.
  const allowedH = scopedVcenterIds(req.user, store.get());
  if (allowedH) {
    const snapH = store.get();
    const owns = level === 'vc' ? allowedH.has(key)
      : level === 'cluster' ? allowedH.has(key.split('|')[0])
        : allowedH.has((snapH.hosts || []).find((h) => h.id === key)?.vcenterId);
    if (!owns) return res.json({ level, key, days, bucket: req.query.bucket || 'auto', bucketMs: 0, synthesized: false, points: [] });
  }
  const since = Date.now() - days * 86_400_000;
  // 집계 단위(기준): 분/시간/일 명시 선택, 미지정 시 기간에 따라 자동.
  const BUCKET = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
  const bucket = BUCKET[req.query.bucket] ? req.query.bucket : 'auto';
  const bucketMs = BUCKET[req.query.bucket]
    || (days <= 2 ? 3_600_000 : days <= 14 ? 6 * 3_600_000 : days <= 120 ? 86_400_000 : days <= 800 ? 7 * 86_400_000 : 30 * 86_400_000);
  // 분 단위 등 미세 집계는 점이 많아질 수 있어 상한을 넉넉히.
  const limit = bucketMs <= 60_000 ? 5000 : bucketMs <= 3_600_000 ? 3000 : 1500;
  let points = [];
  try { const db = await getMetricsDb(); points = db.history(metric, key, since, bucketMs, limit); } catch (e) { console.warn('[toolsCapacity] 시계열 조회 실패 — 빈 배열로 응답(감사 B8):', e?.message); points = []; }
  let synthesized = false;
  if (points.length < 2 && store.get().source === 'mock') {
    // 데모: 합성 시계열(계절·일교차·분 변동 반영). 분 단위는 점이 많아 최근 구간만.
    synthesized = true; points = [];
    const cap = limit;
    let startT = since;
    if ((Date.now() - since) / bucketMs > cap) startT = Date.now() - cap * bucketMs;
    const base = 26 + (hash(key) % 8);
    for (let t = startT; t <= Date.now(); t += bucketMs) {
      const day = t / 86_400_000; const minute = t / 60_000;
      const v = base + 6 * Math.sin(day / 58) + 3 * Math.sin(day) + 1.2 * Math.sin(minute / 7) + (hash(key + t) % 3);
      points.push({ ts: Math.floor(t), avg: Number(v.toFixed(1)), min: Number((v - 2).toFixed(1)), max: Number((v + 4).toFixed(1)) });
    }
  }
  res.json({ level, key, days, bucket, bucketMs, synthesized, points });
});

// 데이터스토어 용량 추세/예측 — ds_usedgb 히스토리로 선형회귀 → 가득 찰 예상일.
/**
 * 디스크 트렌드(v2.446) — 용량 리포트 › 디스크 트렌드. "할당(프로비저닝)·사용·회수 가능" 의
 * 현재 구성 + 기간별 시계열 + 판정·근거·참고 문서. 정의·판정은 tools/diskTrend.js(순수).
 *
 * 시계열 출처: 샘플러가 vCenter 별 독립 DB(vmperfDb)에 적재한 집계 — 용량/사용(ds_*_vc, v2.377)과
 * VM 디스크(vm_disk_*, vm_snap_gb, v2.446). 전체('')는 _all.db. /tools/waste/history 와 같은 scope 규칙:
 * 범위 제한 계정은 전체 합계를 볼 수 없고(범위 밖 포함), 범위 밖 vCenter 는 빈 결과(존재 은닉).
 *
 * query: vcenterId(생략=전체) · days(1~1830, 기본 30) · bucket(hour|day|week, 기본 auto)
 */
api.get('/tools/capacity/disk-history', requirePerm('tools'), async (req, res) => {
  const snap = store.get();
  const vcId = String(req.query.vcenterId || '');
  const days = Math.max(1, Math.min(1830, Number(req.query.days) || 30));
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) {
    if (!vcId) return res.status(403).json({ ok: false, reason: '전체 합계 트렌드는 전체 범위 계정만 조회할 수 있습니다. vCenter 를 선택하세요.' });
    if (!allowed.has(vcId)) return res.json({ ok: true, vcenterId: vcId, days, bucketMs: 0, points: [], breakdown: null, analysis: null });
  }
  if (vcId && !(snap.vcenters || []).some((v) => v.id === vcId)) {
    return res.json({ ok: true, vcenterId: vcId, days, bucketMs: 0, points: [], breakdown: null, analysis: null });
  }
  const since = Date.now() - days * 86_400_000;
  const BUCKET = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 };
  const bucketMs = BUCKET[req.query.bucket]
    || (days <= 3 ? 3_600_000 : days <= 60 ? 6 * 3_600_000 : days <= 400 ? 86_400_000 : 7 * 86_400_000);
  const limit = bucketMs <= 3_600_000 ? 3000 : 1500;

  const scoped = scopeSlice(snap, req.user, vcId || undefined);
  const policy = diskTrendPolicyFromEnv();
  const breakdown = diskBreakdown(scoped.vms, scoped.datastores, { policy });

  const METRICS = [...VMPERF_DISK_METRICS, ...VMPERF_VMDISK_METRICS];
  let points = [];
  let collectedSince = { ds: null, vm: null };
  let synthesized = false;
  try {
    const series = await Promise.all(METRICS.map((m) => vmperfHistory(vcId, m, since, bucketMs, limit)));
    const byTs = new Map();
    METRICS.forEach((m, i) => {
      for (const p of series[i] || []) {
        let e = byTs.get(p.ts); if (!e) { e = { ts: p.ts }; byTs.set(p.ts, e); }
        e[m] = p.avg;
      }
    });
    const r1 = (x) => (x == null ? null : Number(Number(x).toFixed(1)));
    points = [...byTs.values()].sort((a, b) => a.ts - b.ts).map((e) => {
      const off = r1(e.vm_disk_off_gb); const sn = r1(e.vm_snap_gb);
      return {
        ts: e.ts,
        dsCapGB: r1(e.ds_cap_gb_vc), dsUsedGB: r1(e.ds_used_gb_vc),
        provGB: r1(e.vm_disk_prov_gb), usedGB: r1(e.vm_disk_used_gb),
        offGB: off, snapGB: sn,
        reclaimGB: off == null && sn == null ? null : r1((off || 0) + (sn || 0)),
      };
    });
    const [m1, m2] = await Promise.all([vmperfMeta(vcId, 'ds_cap_gb_vc'), vmperfMeta(vcId, 'vm_disk_prov_gb')]);
    collectedSince = { ds: m1.firstTs ?? null, vm: m2.firstTs ?? null };
  } catch (e) { console.warn('[toolsCapacity] 시계열 조회 실패 — 빈 배열로 응답(감사 B8):', e?.message); points = []; }

  // 데모(mock): 실 시계열이 없으므로 현재 구성에서 되감은 **합성** 추이를 만들어 화면 동작을 보여준다.
  // 응답에 synthesized 를 달아 화면이 '데모 합성 데이터' 로 표시한다(실데이터로 오인 방지).
  if (snap.source === 'mock' && breakdown.ds.capGB > 0) {
    synthesized = true;
    const n = Math.max(2, Math.min(400, Math.round(days * 86_400_000 / bucketMs)));
    const b = breakdown;
    const g = 0.0006 + (hash(vcId || 'all') % 5) * 0.0002; // 일 증가율(용량 대비)
    points = [];
    for (let i = n; i >= 0; i--) {
      const ts = Date.now() - i * bucketMs;
      const back = (i * bucketMs) / 86_400_000;
      const f = Math.max(0.5, 1 - g * back);
      const wob = 1 + 0.01 * Math.sin(i / 3);
      const used = b.ds.usedGB * f * wob; const vmUsed = b.vm.committedGB * f * wob;
      const off = b.reclaim.off.gb * (0.8 + 0.2 * Math.abs(Math.sin(i / 7)));
      const sn = b.reclaim.snap.gb * (0.6 + 0.4 * Math.abs(Math.cos(i / 5)));
      points.push({ ts, dsCapGB: b.ds.capGB, dsUsedGB: Math.round(used), provGB: Math.round(b.vm.provGB * (0.97 + 0.03 * f)), usedGB: Math.round(vmUsed), offGB: Math.round(off), snapGB: Math.round(sn * 10) / 10, reclaimGB: Math.round((off + sn) * 10) / 10 });
    }
    collectedSince = { ds: points[0].ts, vm: points[0].ts };
  }

  const analysis = analyzeDiskTrend({ points, breakdown, days, policy });
  res.json({ ok: true, vcenterId: vcId || 'all', days, bucketMs, collectedSince, synthesized, points, breakdown, analysis });
});

/**
 * 데이터스토어 용량 예측 — GET /tools/capacity-forecast
 *
 * ⚠️ v2.503 성능 수정(측정 근거): 이 라우트는 **DS 하나마다 시계열 조회 2회**(metrics `history()` 는
 * 시간버킷이면 `hourlyMin` + `bucketHourly`)를 동기로 돈다. `node:sqlite` 는 동기 API 뿐이라
 * 루프 전체가 **이벤트 루프를 한 번도 양보하지 않는다**. 1,100 DS × 120일 시간버킷(3.17M행)을
 * 실제로 만들어 재면 **요청당 1,563ms 하드블록**이었고(선형회귀 비용은 별도), memo 도 없어
 * 새로고침·다중 사용자마다 그대로 반복됐다(바로 위 형제 엔드포인트들은 전부 memoJson 을 쓴다).
 *
 * 두 가지를 같이 건다:
 *  1. `memoJson` — 스냅샷 리비전 + URL + scope 키로 30초 memo. 반복 조회 비용이 0 이 된다.
 *  2. `YIELD_EVERY` 마다 `setImmediate` 양보 — 총 CPU 는 그대로지만 1.5초 하드블록이 사라져
 *     같은 시간대의 다른 요청·폴러가 진행한다(`gpuSeriesExport`·`chunkedPrune` 과 같은 원칙).
 *
 * ⚠️ **'전 키 1쿼리 병합' 로 바꾸지 말 것** — 직관과 달리 **2.3배 느렸다**(실측 1,563ms → 3,586ms).
 * `samples_hourly` PK 가 `(metric,k,h)` 라 키별 조회는 인덱스 선탐색이지만,
 * `WHERE metric=? AND h>=? GROUP BY k,b` 는 metric 파티션 전체를 훑고 temp b-tree 로 정렬한다.
 */
const FORECAST_YIELD_EVERY = 100;   // DS 이만큼마다 이벤트 루프에 양보

api.get('/tools/capacity-forecast', requirePerm('tools'), (req, res) => memoJson(req, res, 'capacity-forecast', async (snap) => {
  const vcId = req.query.vcenterId;
  const allowed = scopedVcenterIds(req.user, snap);
  const dss = (snap.datastores || []).filter((d) => (!allowed || allowed.has(d.vcenterId)) && (!vcId || d.vcenterId === vcId));
  let db = null; try { db = await getMetricsDb(); } catch { /* */ }
  const mock = snap.source === 'mock';
  const items = [];
  let i = 0;
  for (const d of dss) {
    if (++i % FORECAST_YIELD_EVERY === 0) await new Promise((r) => { setImmediate(r); });
    let pts = [];
    if (db) { try { pts = db.history('ds_usedgb', d.id, Date.now() - 120 * 86_400_000, 86_400_000, 200); } catch { /* */ } }
    let slope = null; let synthesized = false; // GB/day
    if (pts.length >= 3) {
      slope = linregSlope(pts.map((p) => p.ts / 86_400_000), pts.map((p) => p.avg));
    } else if (mock) {
      synthesized = true; slope = Math.max(0, (d.capacityGB * 0.0008) + (hash(d.id) % 5) * 0.2); // 합성 증가율
    }
    const freeGB = d.freeGB ?? Math.max(0, (d.capacityGB || 0) - (d.usedGB || 0));
    const daysToFull = slope && slope > 0.01 ? Math.round(freeGB / slope) : null;
    items.push({ id: d.id, name: d.name, vcenterId: d.vcenterId, type: d.type, capacityGB: d.capacityGB, usedGB: d.usedGB, freeGB, usagePct: d.usagePct, growthGBperDay: slope == null ? null : Number(slope.toFixed(2)), daysToFull, synthesized });
  }
  items.sort((a, b) => (a.daysToFull ?? Infinity) - (b.daysToFull ?? Infinity));
  return { scope: vcId || 'all', mock, items };
}, { ttlMs: 30_000, extraKey: scopeKey(req.user, store.get()) }));
}
