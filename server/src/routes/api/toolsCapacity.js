// 용량/낭비/씬/VM파인더/온도/용량예측 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { scopedVcenterIds } from '../../auth/scope.js';
import { requireRole } from '../../auth/auth.js';   // 설정 변경/데이터 삭제는 관리자 전용
import { logAudit } from '../../audit.js';           // 수집 정책 변경·데이터 삭제는 감사 기록
import { store } from '../../store.js';
import { loadVcenterConfig } from '../../config.js';
import { fetchVmMetric } from '../../vcenter/soapClient.js';
import { getMetricsDb } from '../../metrics/db.js';
import { vmperfHistory, vmperfMeta, vmperfDiskUsage, dropVmperfDb, VMPERF_METRICS, VMPERF_DISK_METRICS } from '../../metrics/vmperfDb.js';
import { loadVmperfSettings, saveVmperfSettings, VMPERF_LIMITS } from '../../metrics/vmperfSettings.js';
import { memoJson, hash, linregSlope, eachLimited, scopeSlice, scopeKey } from './shared.js';

export function registerToolsCapacity(api) {

// Capacity report — per-cluster compute capacity, allocation, overcommit, headroom.
api.get('/tools/capacity', (req, res) => memoJson(req, res, 'tools-capacity', (snap) => {
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
function overAllocatedReport(scoped, vms) {
  const r1 = (x) => Number((x || 0).toFixed(1));
  const pctOf = (used, alloc) => (alloc > 0 ? Math.round((used / alloc) * 100) : 0);
  // 호스트 코어당 MHz — VM 의 vCPU 를 clock(MHz) 으로 환산하는 유일한 근거.
  const hostMhz = new Map();
  for (const h of scoped.hosts || []) {
    const cores = Number(h.cpuCores) || 0;
    const total = Number(h.cpuTotalMhz) || 0;
    if (cores > 0 && total > 0) hostMhz.set(h.name, total / cores);
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
    const mhzPerCore = hostMhz.get(v.host);
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
    // 상위 후보 목록(각 50개 상한 — 응답 크기 유계).
    cpuTop: [...cpuCand].sort(byIdleMhz).slice(0, 50),
    memTop: [...memCand].sort(byIdleGB).slice(0, 50),
  };
}

// Waste report — 자원 낭비 후보 모음(스냅샷 기반): 전원 꺼진 VM, 스냅샷 보유 VM,
// thin 회수가능, Tools 미설치. (고아 VMDK는 데이터스토어 파일 스캔이 필요해 미포함)
api.get('/tools/waste', (req, res) => memoJson(req, res, 'tools-waste', (snap) => {
  const vcId = req.query.vcenterId;
  const vms = scopeSlice(snap, req.user, vcId).vms.filter((v) => !v.template);
  const r1 = (x) => Number((x || 0).toFixed(1));
  const off = vms.filter((v) => v.powerState !== 'POWERED_ON');
  const snaps = vms.filter((v) => (v.snapshotCount || 0) > 0);
  const thin = vms.filter((v) => v.thin);
  const noTools = vms.filter((v) => v.powerState === 'POWERED_ON' && v.toolsStatus && v.toolsStatus !== 'RUNNING');
  const top = (arr, fn, n = 50) => [...arr].sort((a, b) => fn(b) - fn(a)).slice(0, n);
  return {
    scope: vcId || 'all',
    // 할당했지만 쓰지 않는 CPU clock·메모리(v2.373). 아래 idle 헬퍼가 계산한다.
    overAllocated: overAllocatedReport(scopeSlice(snap, req.user, vcId), vms),
    poweredOff: { count: off.length, storageGB: off.reduce((a, v) => a + (v.storageGB || 0), 0),
      vms: top(off, (v) => v.storageGB || 0).map((v) => ({ id: v.id, name: v.name, vcenterId: v.vcenterId, storageGB: v.storageGB, guestOS: v.guestOS })) },
    snapshots: { count: snaps.length, sizeGB: r1(snaps.reduce((a, v) => a + (v.snapshotSizeGB || 0), 0)),
      vms: top(snaps, (v) => v.snapshotSizeGB || 0).map((v) => ({ id: v.id, name: v.name, vcenterId: v.vcenterId, snapshotCount: v.snapshotCount, snapshotSizeGB: v.snapshotSizeGB })) },
    thinReclaim: { count: thin.length, reclaimableGB: thin.reduce((a, v) => a + (v.uncommittedGB || 0), 0) },
    noTools: { count: noTools.length, vms: noTools.slice(0, 50).map((v) => ({ id: v.id, name: v.name, vcenterId: v.vcenterId, toolsStatus: v.toolsStatus })) },
  };
}, { extraKey: scopeKey(req.user, store.get()) }));

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
api.get('/tools/waste/history', async (req, res) => {
  const vcId = String(req.query.vcenterId || '');
  const days = Math.max(1, Math.min(1830, Number(req.query.days) || 30));
  // scope: 특정 vCenter 요청은 소유 검사, 전체('')는 범위 제한 계정에 주지 않는다
  // (전체 합계는 범위 밖 vCenter 를 포함하므로 — '귀속 없는 데이터 미노출' 불변조건).
  const allowed = scopedVcenterIds(req.user, store.get());
  if (allowed) {
    if (!vcId) return res.status(403).json({ ok: false, reason: '전체 합계 트렌드는 전체 범위 계정만 조회할 수 있습니다. vCenter 를 선택하세요.' });
    if (!allowed.has(vcId)) return res.json({ vcenterId: vcId, days, bucketMs: 0, points: [] }); // 존재 은닉
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
  } catch { points = []; }
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
  } catch { points = []; }

  res.json({ vcenterId: vcId, range: rangeKey, bucketMs, ranges: Object.keys(USAGE_RANGES), collectedSince, points });
});

/**
 * VM 성능 트래킹 설정(v2.376) — 보존기간 + 대상 vCenter 선택 + 디스크 사용 현황.
 * 6,000 VM 규모에서 이 계열은 용량이 빠르게 늘어(실측 행당 ~308B) 운영자가 통제해야 한다.
 * GET 은 로그인 사용자, 변경(PUT)·삭제(DELETE)는 관리자 전용(수집 정책·데이터 삭제라서).
 */
api.get('/tools/waste/settings', (req, res) => {
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const s = loadVmperfSettings();
  // 선택 가능한 vCenter 목록은 사용자 범위로 좁힌다(범위 밖 id 노출 금지).
  const vcenters = (snap.vcenters || [])
    .filter((v) => !allowed || allowed.has(v.id))
    .map((v) => ({ id: v.id, name: v.name || v.id }));
  // 디스크 사용량도 범위 밖은 감춘다(전체 합계 '' 는 전체 범위 계정에만).
  const usage = vmperfDiskUsage().filter((u) => (!allowed ? true : (u.vcenterId !== '' && allowed.has(u.vcenterId))));
  res.json({
    settings: s, limits: VMPERF_LIMITS, vcenters, usage,
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
    const keep = new Set(next.vcenterIds);
    for (const u of vmperfDiskUsage()) {
      if (u.vcenterId === '') continue;              // 전체 합계는 trackTotal 로 따로 관리
      if (!keep.has(u.vcenterId)) { dropVmperfDb(u.vcenterId); dropped.push(u.vcenterId); }
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

api.post('/tools/waste/spark', async (req, res) => {
  const type = req.body?.type === 'mem' ? 'mem' : 'cpu';
  const ids = Array.isArray(req.body?.vmIds) ? req.body.vmIds.map(String) : [];
  if (!ids.length) return res.json({ type, series: {}, truncated: false });
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  // scope: 요청 vmId 중 '허용 vCenter 소속으로 실재하는' VM 만 남긴다(범위 밖 VM 성능 유출 차단).
  const byId = new Map((snap.vms || []).map((v) => [v.id, v]));
  const targets = [];
  for (const id of ids) {
    const v = byId.get(id);
    if (!v) continue;
    if (allowed && !allowed.has(v.vcenterId)) continue;
    targets.push(v);
    if (targets.length >= SPARK_MAX_VMS) break;
  }
  const truncated = ids.length > targets.length;
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
        const moref = v.id.split(':').slice(1).join(':');
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
  res.json({ type, interval: 'week', unit: '%', maxVms: SPARK_MAX_VMS, truncated, synthesized: snap.source === 'mock', series });
});

// Thin-provisioned VM finder. thin = uncommitted(여유)이 큰 VM(추정). committed=실사용,
// provisioned=committed+uncommitted. 회수 가능 추정 = uncommitted 합계.
api.get('/tools/thin-vms', (req, res) => memoJson(req, res, 'tools-thin-vms', (snap) => {
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
api.post('/tools/vm-finder', async (req, res) => {
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
        const moref = it.id.split(':').slice(1).join(':');
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
api.get('/tools/esxi-temp', async (req, res) => {
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
api.get('/tools/esxi-temp/history', async (req, res) => {
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
  try { const db = await getMetricsDb(); points = db.history(metric, key, since, bucketMs, limit); } catch { points = []; }
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
api.get('/tools/capacity-forecast', async (req, res) => {
  const snap = store.get();
  const vcId = req.query.vcenterId;
  const allowed = scopedVcenterIds(req.user, snap);
  const dss = (snap.datastores || []).filter((d) => (!allowed || allowed.has(d.vcenterId)) && (!vcId || d.vcenterId === vcId));
  let db = null; try { db = await getMetricsDb(); } catch { /* */ }
  const mock = snap.source === 'mock';
  const items = [];
  for (const d of dss) {
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
  res.json({ scope: vcId || 'all', mock, items });
});
}
