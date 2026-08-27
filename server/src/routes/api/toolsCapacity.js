// 용량/낭비/씬/VM파인더/온도/용량예측 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { loadVcenterConfig } from '../../config.js';
import { fetchVmMetric } from '../../vcenter/soapClient.js';
import { getMetricsDb } from '../../metrics/db.js';
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
