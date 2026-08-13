// 요약·호스트·VM·데이터스토어·네트워크·알람·도구사용 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds, inUserScope } from '../../auth/scope.js';
import { store } from '../../store.js';
import { browseDatastore } from '../../vcenter/dsBrowse.js';
import { listMutes, addMute, removeMute } from '../../alarm-mutes.js';
import { recordToolUse, getTopTools } from '../../tool-usage.js';
import { memoJson, applyFilters, sortBy, scopeKey, osFamily } from './shared.js';

export function registerInventory(api) {

// Consolidated summary: SUM of every resource across all vCenters, with
// allocation totals, overcommit ratios, OS distribution and per-vCenter
// contribution. Optional ?vcenterId= / ?region= scoping.
// 랜딩/요약 화면 — 전 사용자가 15초마다 폴링하는 무거운 경로. single-flight로 동시요청을 1회
// 계산에 합류시켜 '다수 동시 클릭 시 사용자 수만큼 재계산'을 제거한다.
api.get('/summary', (req, res) => memoJson(req, res, 'summary', (snap) => {
  const vcenters = applyFilters(snap.vcenters.map((v) => ({ ...v, vcenterId: v.id })), req.query, snap, ['name'], req.user);
  const vcIds = new Set(vcenters.map((v) => v.id));
  const hosts = snap.hosts.filter((h) => vcIds.has(h.vcenterId));
  const vms = snap.vms.filter((v) => vcIds.has(v.vcenterId));
  const datastores = snap.datastores.filter((d) => vcIds.has(d.vcenterId));
  const networks = snap.networks.filter((n) => vcIds.has(n.vcenterId));
  const alarms = snap.alarms.filter((a) => vcIds.has(a.vcenterId));
  const sum = (arr, fn) => arr.reduce((a, x) => a + (fn(x) || 0), 0);

  const clusters = new Set(hosts.map((h) => `${h.vcenterId}/${h.cluster}`)).size;
  const cpuCores = sum(hosts, (h) => h.cpuCores);
  const cpuTotalMhz = sum(hosts, (h) => h.cpuTotalMhz);
  const cpuUsedMhz = sum(hosts, (h) => h.cpuUsageMhz);
  const memTotalMB = sum(hosts, (h) => h.memTotalMB);
  const memUsedMB = sum(hosts, (h) => h.memUsageMB);
  const storCapGB = sum(datastores, (d) => d.capacityGB);
  const storUsedGB = sum(datastores, (d) => d.usedGB);

  // VM allocation totals (what is provisioned, regardless of host capacity)
  const vmVcpu = sum(vms, (v) => v.cpuCount);
  const vmRamMB = sum(vms, (v) => v.memMB);
  const vmProvGB = sum(vms, (v) => v.storageGB);

  // OS allocation table can be filtered by power state and VM/template.
  const osVms = vms.filter((v) => {
    if (req.query.power === 'on' && v.powerState !== 'POWERED_ON') return false;
    // 'off' = POWERED_ON이 아님(정지+일시중단 포함) — vmsPoweredOff·guest-os 엔드포인트와 정의 통일.
    if (req.query.power === 'off' && v.powerState === 'POWERED_ON') return false;
    if (req.query.kind === 'template' && !v.template) return false;
    if (req.query.kind === 'vm' && v.template) return false;
    return true;
  });
  const osDist = {};
  const osAlloc = {}; // OS family -> { vms, vcpu, ramMB, diskGB }
  for (const v of osVms) {
    const f = osFamily(v.guestOS);
    osDist[f] = (osDist[f] || 0) + 1;
    const a = osAlloc[f] || (osAlloc[f] = { name: f, vms: 0, vcpu: 0, ramMB: 0, diskGB: 0 });
    a.vms += 1;
    a.vcpu += v.cpuCount || 0;
    a.ramMB += v.memMB || 0;
    a.diskGB += v.storageGB || 0;
  }

  const round = (v, d = 0) => Number((v || 0).toFixed(d));
  const pct = (u, t) => (t > 0 ? Math.round((u / t) * 100) : 0);

  // Per-vCenter contribution (the SUM each site adds to the whole).
  // vCenter마다 hosts/vms/datastores 전체를 재필터하면 O(vCenter×N)이라 28×5,800으로 커진다.
  // 호스트/VM/DS를 vcenterId 기준으로 '1회' 그룹핑(O(N))한 뒤 누적한다(롤업 규칙).
  const acc = new Map(); // vcId -> { hosts, vms, vmsOn, cpuCores, memMB, dsCapGB, vcpu, ramMB, provGB, powerW }
  const bucket = (id) => { let b = acc.get(id); if (!b) { b = { hosts: 0, vms: 0, vmsOn: 0, cpuCores: 0, memMB: 0, dsCapGB: 0, vcpu: 0, ramMB: 0, provGB: 0, powerW: 0 }; acc.set(id, b); } return b; };
  for (const h of hosts) { const b = bucket(h.vcenterId); b.hosts++; b.cpuCores += h.cpuCores || 0; b.memMB += h.memTotalMB || 0; b.powerW += h.powerWatts || 0; }
  for (const v of vms) { const b = bucket(v.vcenterId); b.vms++; if (v.powerState === 'POWERED_ON') b.vmsOn++; b.vcpu += v.cpuCount || 0; b.ramMB += v.memMB || 0; b.provGB += v.storageGB || 0; }
  for (const d of datastores) { const b = bucket(d.vcenterId); b.dsCapGB += d.capacityGB || 0; }
  const byVcenter = vcenters.map((vc) => {
    const b = acc.get(vc.id) || bucket(vc.id);
    return {
      id: vc.id, name: vc.name, region: vc.location?.region, status: vc.status,
      hosts: b.hosts,
      vms: b.vms,
      vmsPoweredOn: b.vmsOn,
      cpuCores: b.cpuCores,
      memTotalGB: round(b.memMB / 1024),
      storageTotalTB: round(b.dsCapGB / 1024, 1),
      vcpuAllocated: b.vcpu,
      ramAllocatedGB: round(b.ramMB / 1024),
      provisionedTB: round(b.provGB / 1024, 1),
      powerKw: round(b.powerW / 1000, 1),
    };
  }).sort((a, b) => b.vms - a.vms);

  const powerWatts = sum(hosts, (h) => h.powerWatts);
  const powerReporting = hosts.filter((h) => h.powerWatts > 0).length;

  return {
    generatedAt: snap.generatedAt,
    source: snap.source,
    counts: {
      vcenters: vcenters.length,
      vcentersConnected: vcenters.filter((v) => v.status === 'connected').length,
      clusters,
      hosts: hosts.length,
      hostsConnected: hosts.filter((h) => h.connectionState === 'CONNECTED').length,
      hostsMaintenance: hosts.filter((h) => h.connectionState === 'MAINTENANCE').length,
      hostsDisconnected: hosts.filter((h) => h.connectionState === 'DISCONNECTED').length,
      vms: vms.length,
      vmsPoweredOn: vms.filter((v) => v.powerState === 'POWERED_ON').length,
      vmsPoweredOff: vms.filter((v) => v.powerState !== 'POWERED_ON').length,
      datastores: datastores.length,
      networks: networks.length,
      alarms: alarms.length,
      alarmsCritical: alarms.filter((a) => a.severity === 'critical').length,
      alarmsWarning: alarms.filter((a) => a.severity === 'warning').length,
    },
    compute: {
      cpuCores,
      cpuTotalGhz: round(cpuTotalMhz / 1000, 1),
      cpuUsedGhz: round(cpuUsedMhz / 1000, 1),
      cpuUsagePct: pct(cpuUsedMhz, cpuTotalMhz),
      memTotalGB: round(memTotalMB / 1024),
      memUsedGB: round(memUsedMB / 1024),
      memUsagePct: pct(memUsedMB, memTotalMB),
    },
    storage: {
      capacityTB: round(storCapGB / 1024, 1),
      usedTB: round(storUsedGB / 1024, 1),
      freeTB: round((storCapGB - storUsedGB) / 1024, 1),
      usagePct: pct(storUsedGB, storCapGB),
    },
    power: {
      watts: powerWatts,
      kw: round(powerWatts / 1000, 1),
      reporting: powerReporting,
      // Rough annual energy & cost projection (24/7), informational only.
      annualMwh: round((powerWatts * 24 * 365) / 1e9, 1),
    },
    allocation: {
      vcpuAllocated: vmVcpu,
      ramAllocatedGB: round(vmRamMB / 1024),
      provisionedStorageTB: round(vmProvGB / 1024, 1),
      // Overcommit: allocated vCPU / physical cores, allocated RAM / physical RAM
      vcpuPerCore: cpuCores > 0 ? round(vmVcpu / cpuCores, 2) : 0,
      ramOvercommitPct: memTotalMB > 0 ? Math.round((vmRamMB / memTotalMB) * 100) : 0,
      avgVmPerHost: hosts.length > 0 ? round(vms.length / hosts.length, 1) : 0,
    },
    osDistribution: Object.entries(osDist).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    osAllocation: Object.values(osAlloc).map((a) => ({
      name: a.name,
      vms: a.vms,
      vcpu: a.vcpu,
      ramGB: round(a.ramMB / 1024),
      diskGB: a.diskGB,
      diskTB: round(a.diskGB / 1024, 1),
    })).sort((a, b) => b.vcpu - a.vcpu),
    byVcenter,
  };
  // 본문은 applyFilters(req.user)로 스코프되지만 memoJson 캐시 키에 scope 서명이 없으면 무제한
  // 계정의 전체 요약이 범위 제한 계정에 캐시로 새어 나간다(상시 폴링 경로 — 실제 유출). extraKey 필수.
}, { extraKey: scopeKey(req.user, store.get()) }));

api.get('/hosts', (req, res) => {
  const snap = store.get();
  let hosts = applyFilters(snap.hosts, req.query, snap, ['name', 'cluster'], req.user);
  if (req.query.state) hosts = hosts.filter((h) => h.connectionState === req.query.state);

  // Global host summary for the top of the 호스트 screen.
  const sm = (fn) => hosts.reduce((a, h) => a + (fn(h) || 0), 0);
  // vCore = vCPU allocated to VMs running on the in-scope hosts. 호스트는 (vcenterId, name) 로 키잉한다 —
  // 이름만으로 매칭하면 여러 사이트의 동명 호스트(esxi-01 등)가 섞여, 범위/사이트 필터한 호스트 화면에
  // 타 사이트 VM 의 vCPU 가 합산돼 vcoreAllocated 가 부풀려진다(28개 vCenter 환경 실제 발생 가능).
  const hostKeys = new Set(hosts.map((h) => `${h.vcenterId}\t${h.name}`));
  // in-scope 호스트에 올라간 VM 만 한 번에 골라 vCPU·메모리 할당을 합산한다((vcenterId, host) 키 —
  // 동명 호스트가 여러 사이트에 있어도 섞이지 않게).
  const hostVms = snap.vms.filter((v) => hostKeys.has(`${v.vcenterId}\t${v.host}`));
  const vcoreAllocated = hostVms.reduce((a, v) => a + (v.cpuCount || 0), 0);
  const vmemAllocatedMB = hostVms.reduce((a, v) => a + (v.memMB || 0), 0);
  const verMap = {};
  for (const h of hosts) { const v = h.version || 'unknown'; verMap[v] = (verMap[v] || 0) + 1; }
  const physicalCores = sm((h) => h.cpuCores);
  const physicalMemMB = sm((h) => h.memTotalMB);
  const summary = {
    total: hosts.length,
    connected: hosts.filter((h) => h.connectionState === 'CONNECTED').length,
    maintenance: hosts.filter((h) => h.connectionState === 'MAINTENANCE').length,
    disconnected: hosts.filter((h) => h.connectionState === 'DISCONNECTED').length,
    poweredOn: hosts.filter((h) => h.powerState === 'POWERED_ON').length,
    poweredOff: hosts.filter((h) => h.powerState && h.powerState !== 'POWERED_ON').length,
    physicalCores,
    logicalCores: sm((h) => h.cpuThreads || h.cpuCores),
    vcoreAllocated,
    vcorePerCore: physicalCores > 0 ? Math.round((vcoreAllocated / physicalCores) * 100) / 100 : 0,
    memTotalGB: Math.round(physicalMemMB / 1024),
    // 메모리 가상화율(오버커밋) = 할당된 VM 메모리 합 / 물리 호스트 메모리 합. 1.0 초과면 오버커밋.
    vmemAllocatedGB: Math.round(vmemAllocatedMB / 1024),
    memOvercommit: physicalMemMB > 0 ? Math.round((vmemAllocatedMB / physicalMemMB) * 100) / 100 : 0,
    powerKw: Math.round(sm((h) => h.powerWatts) / 100) / 10,
    esxiVersions: Object.entries(verMap).map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count),
  };
  res.json({ total: hosts.length, items: hosts, summary });
});

api.get('/vms', (req, res) => {
  const snap = store.get();
  const q = req.query;
  let vms = applyFilters(snap.vms, q, snap, ['name', 'guestOS', 'ipAddress', 'host'], req.user);
  if (q.powerState) vms = vms.filter((v) => v.powerState === q.powerState);
  if (q.host) vms = vms.filter((v) => v.host === q.host); // 특정 ESXi 호스트의 VM만(호스트 상세 → VM 목록)

  // Spec-based search: numeric range filters on VM sizing & live usage.
  const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
  const ranges = [
    ['cpuCount', num(q.vcpuMin), num(q.vcpuMax)],
    ['memMB', num(q.ramMinGB) != null ? num(q.ramMinGB) * 1024 : undefined, num(q.ramMaxGB) != null ? num(q.ramMaxGB) * 1024 : undefined],
    ['storageGB', num(q.diskMinGB), num(q.diskMaxGB)],
    ['cpuUsagePct', num(q.cpuUsageMin), num(q.cpuUsageMax)],
    ['memUsagePct', num(q.memUsageMin), num(q.memUsageMax)],
  ];
  for (const [field, min, max] of ranges) {
    if (min != null && !Number.isNaN(min)) vms = vms.filter((v) => v[field] >= min);
    if (max != null && !Number.isNaN(max)) vms = vms.filter((v) => v[field] <= max);
  }
  if (q.os) vms = vms.filter((v) => String(v.guestOS).toLowerCase().includes(String(q.os).toLowerCase()));
  if (q.toolsStatus) vms = vms.filter((v) => v.toolsStatus === q.toolsStatus);

  // GPU 할당 VM 집계(현재 필터 범위) + GPU 전용/종류 필터.
  const gpuType = (v) => v.gpu?.type || null;
  const gpuCounts = {
    total: vms.filter((v) => v.gpu).length,
    vgpu: vms.filter((v) => gpuType(v) === 'vgpu').length,
    passthrough: vms.filter((v) => gpuType(v) === 'passthrough').length,
    mixed: vms.filter((v) => gpuType(v) === 'mixed').length,
  };
  if (q.gpu === '1' || q.gpu === 'true') vms = vms.filter((v) => v.gpu);
  if (q.gpuType) vms = vms.filter((v) => gpuType(v) === q.gpuType);

  if (q.sortBy) vms = sortBy(vms, q.sortBy, q.order);
  const limit = Math.max(1, Math.min(Number(q.limit) || 500, 5000)); // Math.max(1,…): 음수 limit 이 slice(0,-n)로 뒤에서 잘리는 것 방지

  // Aggregate over ALL matched VMs (not just the page) so the UI can show the
  // sum of the searched resources: vCPU/RAM/disk allocation + avg usage.
  const sm = (fn) => vms.reduce((a, v) => a + (fn(v) || 0), 0);
  const on = vms.filter((v) => v.powerState === 'POWERED_ON');
  const avg = (arr, fn) => (arr.length ? Math.round((arr.reduce((a, v) => a + (fn(v) || 0), 0) / arr.length) * 10) / 10 : 0);
  const totals = {
    count: vms.length,
    poweredOn: on.length,
    poweredOff: vms.length - on.length,
    vcpu: sm((v) => v.cpuCount),
    ramGB: Math.round(sm((v) => v.memMB) / 1024),
    diskGB: sm((v) => v.storageGB),
    diskTB: Math.round(sm((v) => v.storageGB) / 1024 * 10) / 10,
    avgCpuUsagePct: avg(on, (v) => v.cpuUsagePct),
    avgMemUsagePct: avg(on, (v) => v.memUsagePct),
    // 평균 디스크 사용율 = 프로비저닝(committed+uncommitted) 대비 실제 사용(committed).
    // thick 디스크는 uncommitted=0 → 100%. 게스트 파일시스템 사용율과는 다름.
    avgDiskUsagePct: avg(vms.filter((v) => (v.storageGB || 0) + (v.uncommittedGB || 0) > 0),
      (v) => ((v.storageGB || 0) / ((v.storageGB || 0) + (v.uncommittedGB || 0))) * 100),
    gpu: gpuCounts,
  };
  res.json({ total: vms.length, items: vms.slice(0, limit), totals });
});

// VM 단건 조회 — 이름/IP/호스트명으로 스냅샷에서 찾아 상세 팝업에 쓴다(모든 화면 공용).
api.get('/vms/lookup', (req, res) => {
  const { name, ip, vcenterId } = req.query;
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const vms = (snap.vms || [])
    .filter((v) => !allowed || allowed.has(v.vcenterId))   // scope 강제(요청 필터로 우회 불가)
    .filter((v) => !vcenterId || v.vcenterId === vcenterId);
  let vm = null;
  if (ip) {
    // 같은 vCenter 안에서 같은 IP 를 여러 VM 이 주장하는 '중복 IP'가 있으므로, ip 매칭이 여럿이면
    // name 으로 정확히 지목한다(v2.287, 확정 버그 #16). name 이 있으면 ip+name 일치 VM 을 우선,
    // 없거나 불일치면 첫 ip 매칭(기존 동작 유지).
    const ipMatches = vms.filter((v) => (v.ipAddresses || []).includes(ip) || v.ipAddress === ip);
    if (name && ipMatches.length > 1) {
      const n = String(name).toLowerCase();
      vm = ipMatches.find((v) => (v.name || '').toLowerCase() === n) || ipMatches[0] || null;
    } else {
      vm = ipMatches[0] || null;
    }
  }
  if (!vm && name) {
    const n = String(name).toLowerCase();
    vm = vms.find((v) => (v.name || '').toLowerCase() === n) || vms.find((v) => (v.name || '').toLowerCase().includes(n));
  }
  res.json({ vm: vm || null });
});

api.get('/datastores', (req, res) => {
  const snap = store.get();
  let ds = applyFilters(snap.datastores, req.query, snap, ['name', 'type'], req.user);
  if (req.query.type) ds = ds.filter((d) => String(d.type || '').toLowerCase().includes(String(req.query.type).toLowerCase()));
  res.json({ total: ds.length, items: ds });
});

// 데이터스토어 브라우즈 — 할당 VM + 실제 파일 목록(라이브, 60초 캐시). id 를 직접 받는
// 단건 라우트이므로 vCenter 단위 scope 를 별도 검사하고 범위 밖은 404(존재 여부 미노출).
api.get('/datastores/:id/browse', async (req, res) => {
  const id = req.params.id;
  const snap = store.get();
  const ds = (snap.datastores || []).find((d) => d.id === id);
  if (!ds || !inUserScope(req.user, snap, ds.vcenterId)) return res.status(404).json({ error: '데이터스토어를 찾을 수 없습니다.' });
  try {
    res.json(await browseDatastore(id));
  } catch (e) { res.status(e.status === 404 ? 404 : 502).json({ error: e.message }); }
});

api.get('/networks', (req, res) => {
  const snap = store.get();
  let nets = applyFilters(snap.networks, req.query, snap, ['name', 'type'], req.user);
  if (req.query.type) nets = nets.filter((n) => n.type === req.query.type);
  res.json({ total: nets.length, items: nets });
});

// Top resource consumers across the whole estate (or a filtered scope).
// ?vcenterId= / ?region= scope it; ?limit= controls list length (default 10).
api.get('/top', (req, res) => {
  const snap = store.get();
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 10, 100)); // Math.max(1,…): 음수 limit slice(0,-n) 방지
  const vms = applyFilters(snap.vms, req.query, snap, ['name'], req.user);
  const hosts = applyFilters(snap.hosts, req.query, snap, ['name'], req.user);
  const datastores = applyFilters(snap.datastores, req.query, snap, ['name'], req.user);
  const onVms = vms.filter((v) => v.powerState === 'POWERED_ON');

  const top = (arr, key, n = limit) =>
    [...arr].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, n);

  res.json({
    generatedAt: snap.generatedAt,
    scope: { vms: vms.length, hosts: hosts.length, datastores: datastores.length },
    vmsByCpuUsage: top(onVms, 'cpuUsagePct'),
    vmsByMemUsage: top(onVms, 'memUsagePct'),
    vmsByVcpu: top(vms, 'cpuCount'),
    vmsByRam: top(vms, 'memMB'),
    vmsByStorage: top(vms, 'storageGB'),
    hostsByCpu: top(hosts, 'cpuUsagePct'),
    hostsByMem: top(hosts, 'memUsagePct'),
    hostsByVmCount: top(hosts, 'vmCount'),
    hostsByPower: top(hosts.filter((h) => h.powerWatts > 0), 'powerWatts'),
    datastoresByUsage: top(datastores, 'usagePct'),
  });
});

api.get('/alarms', (req, res) => {
  const snap = store.get();
  let alarms = applyFilters(snap.alarms, req.query, snap, ['message', 'entity'], req.user);
  if (req.query.severity) alarms = alarms.filter((a) => a.severity === req.query.severity);
  res.json({ total: alarms.length, items: alarms });
});

// Alarm mute rules — "이 알람 앞으로 무시". Muted alarms are filtered globally.
api.get('/alarm-mutes', (_req, res) => res.json({ mutes: listMutes() }));
api.post('/alarm-mutes', requirePerm('inv.alarms'), (req, res) => {
  const result = addMute(req.body || {});
  if (result.ok) store.refresh().catch(() => {}); // re-apply immediately
  res.status(result.ok ? 200 : 400).json(result);
});
api.delete('/alarm-mutes/:id', requirePerm('inv.alarms'), (req, res) => {
  // req.params.id는 Express가 이미 1회 URL 디코드한 값 — 추가 decodeURIComponent는 이중
  // 디코드가 되어 '%' 포함 규칙(사용률 알람 등)에서 값 손상/URIError(500)를 유발한다.
  const result = removeMute(req.params.id);
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 200 : 404).json(result);
});

// 특수 기능 사용 빈도 — 자주 쓰는 메뉴 자동 추천. 모든 로그인 사용자 합산 집계.
api.get('/tool-usage/top', (req, res) => {
  const n = Math.min(12, Math.max(1, Number(req.query.n) || 3));
  res.json({ top: getTopTools(n) });
});
api.post('/tool-usage', (req, res) => {
  res.json(recordToolUse(req.body?.k));
});

}
