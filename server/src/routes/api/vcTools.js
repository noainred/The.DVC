// vCenter 목록 + 중복IP/솔루션/VMtools/스냅샷 도구 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { sortByOrder } from '../../vcenter/order.js';

export function registerVcTools(api) {

api.get('/vcenters', (req, res) => {
  const snap = store.get();
  let sites = snap.rollups?.sites ?? [];
  // 사용자 scope 제한 시 허용된 vCenter(사이트)만 노출 — 필터 드롭다운/데이터 경계 일치.
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) sites = sites.filter((s) => allowed.has(s.id));
  res.json(sortByOrder(sites, (s) => s.id));
});

// Special tool: find IPv4 addresses assigned to more than one VM, optionally
// scoped to one vCenter (?vcenterId=). Helps catch duplicate/conflicting IPs.
api.get('/tools/duplicate-ips', (req, res) => {
  const snap = store.get();
  let vms = snap.vms;
  // scope 는 요청 필터보다 먼저 — 범위 제한 계정이 ?vcenterId 로 우회해 전 사이트 VM 을 못 보게.
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) vms = vms.filter((v) => allowed.has(v.vcenterId));
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  const map = new Map();
  for (const v of vms) {
    const ips = v.ipAddresses?.length ? v.ipAddresses : (v.ipAddress ? [v.ipAddress] : []);
    for (const ip of new Set(ips)) {
      if (!map.has(ip)) map.set(ip, []);
      map.get(ip).push({ id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host, cluster: v.cluster, powerState: v.powerState, guestOS: v.guestOS, ipAddresses: v.ipAddresses, ipAddress: v.ipAddress });
    }
  }
  const items = [...map.entries()]
    .filter(([, vs]) => vs.length > 1)
    .map(([ip, vs]) => ({
      ip, count: vs.length, vms: vs,
      crossVcenter: new Set(vs.map((x) => x.vcenterId)).size > 1,
    }))
    .sort((a, b) => b.count - a.count || a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  res.json({
    scope: req.query.vcenterId || 'all',
    duplicateIps: items.length,
    affectedVms: items.reduce((a, d) => a + d.count, 0),
    scannedVms: vms.length,
    items,
  });
});

// Installed VMware solutions (vCenter extensions) per vCenter, NSX highlighted.
api.get('/tools/solutions', (req, res) => {
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const items = (snap.vcenters || []).filter((vc) => !allowed || allowed.has(vc.id)).map((vc) => {
    const sols = vc.solutions || [];
    return {
      vcenterId: vc.id, name: vc.name, status: vc.status,
      version: vc.version, build: vc.build, fullName: vc.fullName,
      solutions: sols,
      nsx: sols.filter((s) => /nsx/i.test(s.key) || /nsx/i.test(s.label)),
    };
  });
  const nsxVer = {};
  for (const it of items) for (const s of it.nsx) { const v = s.version || '?'; nsxVer[v] = (nsxVer[v] || 0) + 1; }
  const vcVer = {};
  for (const it of items) { const v = it.version || '?'; vcVer[v] = (vcVer[v] || 0) + 1; }
  res.json({
    items,
    nsxVersions: Object.entries(nsxVer).map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count),
    vcenterVersions: Object.entries(vcVer).map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count),
  });
});

// VMware Tools version distribution (optionally per vCenter).
api.get('/tools/vmtools', (req, res) => {
  const snap = store.get();
  let vms = snap.vms;
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) vms = vms.filter((v) => allowed.has(v.vcenterId));
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  const map = new Map();
  for (const v of vms) {
    const ver = v.toolsVersion || '없음';
    if (!map.has(ver)) map.set(ver, { version: ver, count: 0, running: 0, outdated: 0, notRunning: 0, ids: [] });
    const e = map.get(ver); e.count++;
    if (e.ids.length < 2000) e.ids.push(v.id);
    if (v.toolsStatus === 'RUNNING') e.running++;
    else if (v.toolsStatus === 'OUTDATED') e.outdated++;
    else e.notRunning++;
  }
  res.json({
    scannedVms: vms.length,
    versions: [...map.values()].sort((a, b) => b.count - a.count),
  });
});

// VMs that have snapshots (optionally per vCenter).
api.get('/tools/snapshots', (req, res) => {
  const snap = store.get();
  let vms = snap.vms.filter((v) => (v.snapshotCount || 0) > 0);
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) vms = vms.filter((v) => allowed.has(v.vcenterId));
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  const items = vms.map((v) => ({
    id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host, cluster: v.cluster,
    snapshotCount: v.snapshotCount, snapshotSizeGB: v.snapshotSizeGB || 0,
    powerState: v.powerState, guestOS: v.guestOS,
  }));
  res.json({
    count: items.length,
    totalSizeGB: Math.round(items.reduce((a, v) => a + (v.snapshotSizeGB || 0), 0) * 10) / 10,
    items,
  });
});
}
