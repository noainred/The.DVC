// vCenter 목록 + 중복IP/솔루션/VMtools/스냅샷 도구 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { sortByOrder } from '../../vcenter/order.js';
import { nsxStore } from '../../nsx/store.js';
import { visibleNsxManagers } from '../../nsx/scope.js';
import { listDatacenters, datacenterOfVcenter } from '../../datacenter/store.js';

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

// 전 vCenter의 VMware 솔루션 버전(vCenter·ESXi·NSX 포함) — 특수기능 'VMware 솔루션 / NSX'.
// v2.327(사용자 요구 '모든 vCenter 설치된 NSX 포함 솔루션 버전'): vCenter 확장(vc.solutions)뿐
// 아니라 ① 사이트별 ESXi 버전 분포(hosts) ② 실제 NSX Manager 버전(nsxStore — vCenter 확장 항목
// 보다 권위 있음)을 함께 반환하고, 전 함대 버전 드리프트(vCenter/ESXi/NSX 분포)를 요약한다.
// scope: 조회 라우트 규칙(v2.322) — vCenter 는 scopedVcenterIds, NSX 는 nsx/scope.js 귀속 판정.
api.get('/tools/solutions', (req, res) => {
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const vcs = (snap.vcenters || []).filter((vc) => !allowed || allowed.has(vc.id));
  // NSX Manager(실수집 버전) — scope 안 매니저만. vCenter 귀속(vcenterId)·region 매핑으로 사이트에 붙인다.
  const nsxSnap = nsxStore.get();
  const mgrs = visibleNsxManagers(nsxSnap.managers || [], snap.vcenters, allowed);
  // 법인(datacenter) 라벨 맵(v2.327 사용자 요구 — NSX 버전이 어느 법인에 설치됐는지 표시).
  // vCenter → 배정된 datacenter 이름, 없으면 region, 그것도 없으면 vCenter 이름.
  let dcById = new Map();
  try { dcById = new Map(listDatacenters().map((d) => [d.id, d.name || d.id])); } catch { /* 목록 실패 시 region 폴백 */ }
  const corpOfVc = (vc) => {
    let dcName = '';
    try { dcName = dcById.get(datacenterOfVcenter(vc.id)) || ''; } catch { dcName = ''; }
    return dcName || vc.location?.region || vc.region || vc.name || vc.id;
  };
  const corpByVcId = new Map(vcs.map((vc) => [vc.id, corpOfVc(vc)]));
  const corpOfMgr = (m) => (m.vcenterId && corpByVcId.get(m.vcenterId)) || m.region || m.location?.region || '(법인 미지정)';

  const items = vcs.map((vc) => {
    const sols = vc.solutions || [];
    const hosts = (snap.hosts || []).filter((h) => h.vcenterId === vc.id);
    const esxiMap = new Map();
    for (const h of hosts) {
      const key = `${h.version || 'unknown'}${h.build ? ` (b${h.build})` : ''}`;
      esxiMap.set(key, (esxiMap.get(key) || 0) + 1);
    }
    const region = vc.location?.region || vc.region || '';
    // 사이트에 붙는 NSX 매니저: vcenterId 정확 매칭 우선, 없으면 같은 region 의 무귀속 매니저.
    const siteNsx = mgrs.filter((m) => (m.vcenterId && m.vcenterId === vc.id) || (!m.vcenterId && region && (m.region || m.location?.region) === region));
    return {
      vcenterId: vc.id, name: vc.name, status: vc.status, region, corp: corpByVcId.get(vc.id),
      version: vc.version, build: vc.build, fullName: vc.fullName,
      esxi: [...esxiMap.entries()].map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count),
      nsxManagers: siteNsx.map((m) => ({ name: m.name, version: m.version || '', status: m.status, host: m.host, region: m.region || m.location?.region || '' })),
      solutions: sols,
      nsx: sols.filter((s) => /nsx/i.test(s.key) || /nsx/i.test(s.label)), // vCenter 확장에 등록된 NSX(참고)
    };
  });

  // 전 함대 버전 드리프트 요약(같은 솔루션의 버전이 사이트마다 다른지 한눈에).
  const dist = (pairs) => { const m = {}; for (const v of pairs) { const k = v || '?'; m[k] = (m[k] || 0) + 1; } return Object.entries(m).map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count); };
  // NSX 버전 분포 + 각 버전이 설치된 법인 목록(v2.327 사용자 요구). 법인별 매니저 수까지.
  const nsxByVer = new Map();
  for (const m of mgrs) {
    const v = m.version || '?';
    const corp = corpOfMgr(m);
    if (!nsxByVer.has(v)) nsxByVer.set(v, { version: v, count: 0, corps: new Map() });
    const e = nsxByVer.get(v); e.count++; e.corps.set(corp, (e.corps.get(corp) || 0) + 1);
  }
  const nsxVersions = [...nsxByVer.values()]
    .map((e) => ({ version: e.version, count: e.count, corps: [...e.corps.entries()].map(([corp, count]) => ({ corp, count })).sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.count - a.count);
  res.json({
    generatedAt: snap.generatedAt,
    items,
    vcenterVersions: dist(items.map((it) => it.version)),                                  // vCenter 버전 분포(사이트 수)
    esxiVersions: dist((snap.hosts || []).filter((h) => !allowed || allowed.has(h.vcenterId)).map((h) => `${h.version || 'unknown'}${h.build ? ` (b${h.build})` : ''}`)), // ESXi 버전 분포(호스트 수)
    nsxVersions,                                                                            // NSX Manager 버전 분포(매니저 수·설치 법인) — 실수집
    nsxManagerCount: mgrs.length,
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
