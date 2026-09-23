// 헬스/개요 집계 + NSX 조회 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { requirePerm } from '../../auth/auth.js'; // v2.536: inv.nsx 서버 집행(그전까지 탭 표시 조건일 뿐이었다)
import { instanceId } from '../../instanceId.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store, scopedRollups } from '../../store.js';
import { currentVersion, config } from '../../config.js';
import { upgradeManager } from '../../upgrade/manager.js';
import { getGuestGpuHost } from '../../gpu/store.js';
import { nsxStore } from '../../nsx/store.js';
import { loadRegistry as loadNsxRegistry } from '../../nsx/registry.js';
import { fetchGroupMembers } from '../../nsx/client.js';
import { memoJson, hash, scopeKey } from './shared.js';
import { visibleNsxManagers, managerInScope, scopedNsxRollup } from '../../nsx/scope.js';
import { loadRegistry as loadIdracRegistry } from '../../idrac/registry.js';
import { remoteServersResolved, invForServer } from '../admin/shared.js';
import { aggregatePhysical } from '../../idrac/physicalCapacity.js'; // v2.486: iDRAC 인식 전체 물리 서버 코어·메모리
import { serversByCorp } from '../../idrac/serverByCorp.js';          // v2.526: 법인(vCenter)별 물리 서버 수
import { loadFleetAssign } from '../../insights/fleetAssign.js';       // v2.583: 관리자 지정 귀속(특수 기능 › 통합 서버 인벤토리)
import { listDatacenters, getDatacenterAssign } from '../../datacenter/store.js'; // v2.583: 법인 ↔ vCenter 할당

/**
 * v2.486: iDRAC 가 인식한 모든 물리 서버(중앙 직접 등록 + 위임 법인 원격, OME 엔트리 제외, id 중복은 중앙 우선)의
 * 코어·메모리 합계. Overview CPU/메모리 카드가 vCenter(ESXi) 수치와 나란히 보인다. 스냅샷마다 1회(memoJson).
 */
function allPhysicalServers() {
  const local = loadIdracRegistry().filter((s) => s.type !== 'ome');
  const seen = new Set(local.map((s) => String(s.id)));
  return local.concat(remoteServersResolved().filter((s) => !seen.has(String(s.id))));
}

/**
 * 법인(vCenter)별 물리 서버 수(v2.526, 사용자 요청 "법인별 서버 수량과 guestos 수량").
 * 귀속 판정은 `idrac/serverByCorp.js` — 전력 귀속과 **같은 신호 순서**를 쓴다(그 파일 머리말).
 * ⚠ 범위 제한 계정에는 **허용 vCenter 만** 남긴다(전 법인 서버 대수 유출 차단). 귀속되지 않은
 *   서버(unassigned)는 어느 법인 것인지 모르므로 범위 계정에 **주지 않는다**.
 */
/**
 * v2.583 보조 귀속 재료 — 관리자 지정(fleet-assign) · 법인(DataCenter) → vCenter 목록 · 살아 있는 vCenter.
 * 법인 id 는 대소문자를 무시해 맞춘다(`matchDatacenterId` 와 같은 관례). 이름도 함께 준다(화면의 행 이름).
 */
function corpAttribution(vcenters) {
  const known = new Set((vcenters || []).map((v) => String(v.id)));
  const byLower = new Map();
  for (const id of known) byLower.set(id.toLowerCase(), id);
  const dcVcenters = new Map();
  for (const [vcRaw, dc] of Object.entries(getDatacenterAssign() || {})) {
    const vc = byLower.get(String(vcRaw).trim().toLowerCase());
    const k = String(dc || '').trim().toLowerCase();
    if (!vc || !k) continue;
    const arr = dcVcenters.get(k) || [];
    if (!arr.includes(vc)) arr.push(vc);
    dcVcenters.set(k, arr);
  }
  const dcNames = {};
  for (const d of listDatacenters() || []) if (d?.id) dcNames[String(d.id)] = String(d.name || d.id);
  let fleetAssign = {};
  try { fleetAssign = loadFleetAssign() || {}; } catch { fleetAssign = {}; }
  return { opts: { fleetAssign, dcVcenters, knownVcenters: known }, dcNames };
}

// v2.591 C4: `sink` 를 주면 범위 계정의 **허용 vCenter 에 귀속된 서버**를 담아 돌려준다 —
//   개요의 물리 용량(`physical`)이 같은 귀속 판정으로 다시 집계되게(함대 전체 70대와 범위 9대를 한 화면에서
//   동시에 말하던 결함).
function physicalByCorp(hosts, allowed, vcenters = [], sink = null) {
  try {
    const { opts, dcNames } = corpAttribution(vcenters);
    const inScope = [];
    const onAttributed = allowed ? (s, vc) => { if (vc && allowed.has(vc)) inScope.push(s); } : null;
    const r0 = serversByCorp(allPhysicalServers(), hosts, { ...opts, onAttributed });
    if (sink) sink.servers = inScope;
    // 법인 이름표 — 미배치 행에 나오는 법인만(전체 목록을 싣지 않는다).
    const r = { ...r0, datacenterNames: Object.fromEntries(Object.keys(r0.unplacedByDatacenter || {}).map((id) => [id, dcNames[id] || id])) };
    if (!allowed) return r;
    // ⚠ v2.527: 법인별 맵이 여러 개가 됐다 — **전부** 같은 기준으로 잘라야 한다.
    //   하나라도 빠뜨리면 범위 계정 화면에 범위 밖 법인의 대수가 그대로 남는다.
    const trim = (m) => {
      const o = {};
      for (const [id, n] of Object.entries(m || {})) if (allowed.has(id)) o[id] = n;
      return o;
    };
    const byVcenter = trim(r.byVcenter);
    const byVcenterPhysicalOnly = trim(r.byVcenterPhysicalOnly);
    const byVcenterMatched = trim(r.byVcenterMatched);
    const byVcenterHosts = trim(r.byVcenterHosts);
    const byVcenterUnion = trim(r.byVcenterUnion);
    const sum = (m) => Object.values(m).reduce((a, b) => a + b, 0);
    return {
      ...r,
      byVcenter, byVcenterPhysicalOnly, byVcenterMatched, byVcenterHosts, byVcenterUnion,
      byDatacenter: {},
      total: sum(byVcenter),
      hostsTotal: sum(byVcenterHosts),
      matchedCount: sum(byVcenterMatched),
      physicalOnly: sum(byVcenterPhysicalOnly),
      union: sum(byVcenterUnion),
      // v2.591 C4: 등록 비활성·귀속 경로 집계도 함대 전체 값이었다 — 범위 안에서 다시 센다(disabled) /
      //   귀속 경로 분포는 범위 밖 서버의 판정 근거라 주지 않는다(matchedBy).
      disabled: inScope.filter((s) => s.enabled === false).length,
      matchedBy: null,
      // 귀속되지 않은 서버는 어느 법인 것인지 모르므로 범위 계정에 주지 않는다(대수 유출 차단).
      unassigned: null,
      physicalOnlyUnassigned: null,
      // v2.583: vCenter 행을 정하지 못한 서버도 같은 이유로 범위 계정에 주지 않는다.
      unplacedByDatacenter: {}, datacenterNames: {}, physicalOnlyNoDatacenter: null,
      scoped: true,
    };
  } catch (e) {
    return {
      total: 0, byVcenter: {}, byDatacenter: {}, unassigned: 0,
      hostsTotal: 0, matchedCount: 0, physicalOnly: 0, union: 0,
      byVcenterPhysicalOnly: {}, byVcenterMatched: {}, byVcenterHosts: {}, byVcenterUnion: {},
      error: e?.message || String(e),
    };
  }
}

function physicalCapacity(servers = null) {
  try {
    return aggregatePhysical(servers || allPhysicalServers(), invForServer);
  } catch (e) {
    return { servers: 0, withInventory: 0, withCores: 0, withMemory: 0, cores: 0, threads: 0, sockets: 0, memGiB: 0, memGB: 0, error: e?.message || String(e) };
  }
}

// /health 는 헤더가 15초마다 부른다 — 범위 계정의 재계산은 (스냅샷 세대, 범위) 당 1회. 세대가 바뀌면 옛 항목을
// 버린다(v2.580 TUNE-B '세대 키 캐시는 옛 세대를 버린다').
const _healthScoped = new Map();
function healthScopedGlobal(snap, allowed) {
  const key = `${snap.generatedAt}|${[...allowed].sort().join(',')}`;
  const hit = _healthScoped.get(key);
  if (hit) return hit;
  for (const k of _healthScoped.keys()) if (!k.startsWith(`${snap.generatedAt}|`)) _healthScoped.delete(k);
  if (_healthScoped.size >= 64) _healthScoped.clear();
  const g = scopedRollups(snap, allowed).global;
  _healthScoped.set(key, g);
  return g;
}

export function registerOverviewNsx(api) {

api.get('/health', (req, res) => {
  const snap = store.get();
  // v2.583 #20: 범위 계정의 헤더 수치(vCenter·호스트·VM·알람)는 허용 vCenter 기준이다 — 전 함대 합을 주지 않는다.
  const allowed = scopedVcenterIds(req.user, snap);
  const vcs = allowed ? snap.vcenters.filter((v) => allowed.has(v.id)) : snap.vcenters;
  const byStatus = (s) => vcs.filter((v) => v.status === s).length;
  const connected = byStatus('connected');
  const g = (allowed ? healthScopedGlobal(snap, allowed) : snap.rollups?.global) || {};
  // 업그레이드 가용 요약(비민감 — 버전 문자열뿐). 헤더가 '새 버전 있음'을 표시하고,
  // 서버 불응답(폴링 실패)과 결합해 '업그레이드 중' 점멸을 판정하는 데 쓴다(v2.458).
  // lastCheck 는 백그라운드 폴러/수동 확인이 채운다. 접근 제어와 무관(전 사용자 헤더).
  const lc = upgradeManager.lastCheck || null;
  const upW = lc?.watch?.available ? String(lc.watch.version || '') : '';
  const upR = lc?.remote?.available ? String(lc.remote.latest || '') : '';
  const updateAvailable = Boolean(upW || upR);
  res.json({
    instance: instanceId(), agent: config.agent?.name || '', // v2.429: HAProxy 경로 점검이 '이 응답이 나 자신인지' 대조

    status: 'ok',
    version: currentVersion(),
    source: snap.source,
    generatedAt: snap.generatedAt,
    uptimeSec: Math.floor(process.uptime()),
    vcenters: vcs.length,
    vcentersConnected: connected,
    // 상태 분류 — 'pending'(첫 수집 전/수집 중)을 'unreachable'(연결 실패)과 구분해 헤더가
    // 수집 직후 잠깐을 '불가'로 잘못 표시하지 않게 한다.
    vcentersPending: byStatus('pending'),
    vcentersUnreachable: byStatus('unreachable'),
    vcentersMaintenance: byStatus('maintenance'),
    hosts: g.hosts || 0,
    vms: g.vms || 0,
    vmsPoweredOn: g.vmsPoweredOn || 0,
    alarms: g.alarms || 0,
    alarmsCritical: g.alarmsCritical || 0,
    cpuUsagePct: g.cpuUsagePct || 0,
    updateAvailable,
    latestVersion: upR || upW || null,
    features: { upgradeTab: config.ui.showUpgradeTab },
  });
});

// High-level KPIs + regional / per-site rollups for the dashboard landing view.
// 랜딩 화면이라 전 사용자가 15초마다 폴링 → single-flight로 동시요청을 1회 계산에 합류.
api.get('/overview', (req, res) => memoJson(req, res, 'overview', (snap) => {
  // 사용자 scope: 범위 제한 계정에는 per-vCenter 식별정보(rollups.sites/byRegion)를 허용 vCenter 로
  // 좁힌다(전 사이트 id·name·메트릭 열거 차단). GPU 집계도 허용 호스트만 대상으로 한다.
  const allowed = scopedVcenterIds(req.user, snap);
  const hostInScope = (h) => !allowed || allowed.has(h.vcenterId);
  let rollups = snap.rollups;
  // v2.583 #20: 걸러내지 않고 허용 vCenter 원소로 **다시 계산**한다(store.scopedRollups 주석 참고).
  if (allowed && rollups) rollups = { ...scopedRollups(snap, allowed), scoped: true };
  // GPU 집계: 설치된 GPU 카드 총 장수 + GPU 평균 사용률(글로벌 현황 KPI용).
  // 사용률은 GPU 보유 호스트의 util(ESXi 보고 + 게스트 오버레이)을 평균.
  let gpuCards = 0, gpuVms = 0;
  let utilSum = 0, utilN = 0;
  for (const h of snap.hosts) {
    if (!hostInScope(h)) continue;
    const gn = (h.gpus || []).length;
    gpuCards += gn;
    if (gn) {
      const u = h.gpuUtilPct ?? getGuestGpuHost(h.id)?.utilPct;
      if (u != null && Number.isFinite(u)) { utilSum += u; utilN++; }
    }
  }
  for (const v of snap.vms) if (v.gpu && (!allowed || allowed.has(v.vcenterId))) gpuVms++;
  const gpuUtilPct = utilN ? Math.round(utilSum / utilN) : 0;
  // v2.526: 법인(vCenter)별 물리 서버 수 — 화면이 사이트별 호스트·VM 과 나란히 보여준다.
  const sink = {};
  const pbc = physicalByCorp(snap.hosts.filter(hostInScope), allowed, snap.vcenters || [], sink);
  // v2.591 C4: 범위 계정의 물리 용량은 허용 vCenter 귀속 서버만으로 다시 집계한다(귀속을 못 한 서버는
  //   어느 법인 것인지 모르므로 넣지 않는다). 귀속 판정 자체가 실패했으면 null — 함대 값을 내보내지 않는다.
  const physical = !allowed ? physicalCapacity()
    : (Array.isArray(sink.servers) ? { ...physicalCapacity(sink.servers), scoped: true } : null);
  return {
    generatedAt: snap.generatedAt, source: snap.source, ...rollups,
    gpuCards, gpuVms, gpuUtilPct, gpuUtilHosts: utilN,
    physical,
    physicalByCorp: pbc,
  };
}, { extraKey: scopeKey(req.user, store.get()) }));

// NSX overview — aggregated snapshot from the NSX Manager poller (separate from
// vCenter). Optional ?managerId= / ?region= scoping for the detail tables.
// v2.320(2026-08-13 감사 보류 갭 적용): 범위 계정에는 귀속 매니저(vcenterId∈허용 ∪
// region∈허용 vCenter region)만 노출 — 하위 리소스(게이트웨이/세그먼트/DFW/보안그룹)·
// rollup·collectionErrors 도 보이는 매니저 기준으로 절단(nsx/scope.js — 순수 판정 테스트 고정).
// ⚠ v2.536 — `inv.nsx` 는 여기까지 **클라이언트 전용**이었다(routes/api/inventory.js 머리말 참조).
// 키는 `web/src/views/specialToolsList.js` 의 NSX 도구 `perm: 'inv.nsx'` 와 같아야 한다.
const invNsx = requirePerm('inv.nsx');

api.get('/nsx', invNsx, (req, res) => {
  const snap = nsxStore.get();
  const { managerId, region } = req.query;
  const allowed = scopedVcenterIds(req.user, store.get());
  const base = visibleNsxManagers(snap.managers, store.get().vcenters, allowed);
  const mIds = new Set(
    base
      .filter((m) => (!managerId || m.id === managerId) && (!region || m.region === region))
      .map((m) => m.id),
  );
  // 범위 계정은 쿼리 유무와 무관하게 항상 mIds 필터를 강제한다(요청 필터보다 scope 가 먼저 —
  // CLAUDE.md 규칙). 전체 범위 + 쿼리 없음일 때만 기존처럼 전량 반환.
  const scoped = !!allowed || managerId || region;
  const managers = base.filter((m) => mIds.has(m.id));
  const gateways = scoped ? snap.gateways.filter((g) => mIds.has(g.managerId)) : snap.gateways;
  const segments = scoped ? snap.segments.filter((s) => mIds.has(s.managerId)) : snap.segments;
  const transportNodes = scoped ? snap.transportNodes.filter((t) => mIds.has(t.managerId)) : snap.transportNodes;
  res.json({
    generatedAt: snap.generatedAt,
    source: snap.source,
    // rollup 은 전 함대 집계 — 범위 계정에는 보이는 리소스로 재계산해 총계 유출을 막는다.
    rollup: allowed ? scopedNsxRollup({ managers, gateways, segments, transportNodes }) : snap.rollup,
    managers,
    gateways,
    segments,
    transportNodes,
    dfw: scoped ? (snap.dfw || []).filter((p) => mIds.has(p.managerId)) : (snap.dfw || []),
    securityGroups: scoped ? (snap.securityGroups || []).filter((g) => mIds.has(g.managerId)) : (snap.securityGroups || []),
    // 수집 오류에는 매니저 이름/호스트가 실린다 — 범위 계정에는 보이는 매니저 것만.
    collectionErrors: allowed ? (snap.collectionErrors || []).filter((e) => mIds.has(e.managerId)) : snap.collectionErrors,
  });
});

// NSX 보안그룹 라이브 멤버 조회(온디맨드). groupId는 스냅샷의 "managerId:rawId" 형식.
api.get('/nsx/group-members', invNsx, async (req, res) => {
  const full = String(req.query.groupId || '');
  const sep = full.indexOf(':');
  const managerId = req.query.managerId || (sep > 0 ? full.slice(0, sep) : '');
  const rawId = sep > 0 ? full.slice(sep + 1) : full;
  if (!managerId || !rawId) return res.status(400).json({ error: 'managerId/groupId가 필요합니다.' });
  if (nsxStore.get().source === 'mock') {
    // 데모: 합성 멤버.
    const n = 3 + (hash(rawId) % 12);
    const vms = Array.from({ length: n }, (_, i) => ({ name: `${rawId.slice(0, 8)}-vm-${i + 1}`, os: 'Linux', powerState: 'POWERED_ON', ips: [`10.94.${hash(rawId) % 200}.${i + 10}`] }));
    return res.json({ mock: true, vmCount: vms.length, vms, ipCount: vms.length, ips: vms.map((v) => v.ips[0]) });
  }
  const mgr = loadNsxRegistry().find((m) => m.id === managerId);
  if (!mgr) return res.status(404).json({ error: `NSX Manager를 찾을 수 없습니다: ${managerId}` });
  // v2.320 scope: 범위 계정은 귀속(vcenterId/region) 범위 안 매니저의 그룹만 조회 — 범위 밖은
  // 403 이 아니라 **404**(존재 은닉 — 단건 라우트 규칙). 라이브 VM 멤버 IP 유출 차단.
  if (!managerInScope(mgr, store.get().vcenters, scopedVcenterIds(req.user, store.get()))) {
    return res.status(404).json({ error: `NSX Manager를 찾을 수 없습니다: ${managerId}` });
  }
  try {
    const data = await fetchGroupMembers(mgr, rawId);
    res.json({ mock: false, ...data });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
}
