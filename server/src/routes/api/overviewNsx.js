// 헬스/개요 집계 + NSX 조회 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { currentVersion, config } from '../../config.js';
import { getGuestGpuHost } from '../../gpu/store.js';
import { nsxStore } from '../../nsx/store.js';
import { loadRegistry as loadNsxRegistry } from '../../nsx/registry.js';
import { fetchGroupMembers } from '../../nsx/client.js';
import { memoJson, hash, scopeKey } from './shared.js';

export function registerOverviewNsx(api) {

api.get('/health', (_req, res) => {
  const snap = store.get();
  const byStatus = (s) => snap.vcenters.filter((v) => v.status === s).length;
  const connected = byStatus('connected');
  const g = snap.rollups?.global || {};
  res.json({
    status: 'ok',
    version: currentVersion(),
    source: snap.source,
    generatedAt: snap.generatedAt,
    uptimeSec: Math.floor(process.uptime()),
    vcenters: snap.vcenters.length,
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
  if (allowed && rollups) {
    const regions = new Set((snap.vcenters || []).filter((v) => allowed.has(v.id)).map((v) => v.location?.region));
    rollups = {
      ...rollups,
      sites: (rollups.sites || []).filter((s) => allowed.has(s.id)),
      byRegion: (rollups.byRegion || []).filter((r) => regions.has(r.region)),
    };
  }
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
  return { generatedAt: snap.generatedAt, source: snap.source, ...rollups, gpuCards, gpuVms, gpuUtilPct, gpuUtilHosts: utilN };
}, { extraKey: scopeKey(req.user, store.get()) }));

// NSX overview — aggregated snapshot from the NSX Manager poller (separate from
// vCenter). Optional ?managerId= / ?region= scoping for the detail tables.
api.get('/nsx', (req, res) => {
  const snap = nsxStore.get();
  const { managerId, region } = req.query;
  const mIds = new Set(
    snap.managers
      .filter((m) => (!managerId || m.id === managerId) && (!region || m.region === region))
      .map((m) => m.id),
  );
  const scoped = managerId || region;
  res.json({
    generatedAt: snap.generatedAt,
    source: snap.source,
    rollup: snap.rollup,
    managers: snap.managers.filter((m) => mIds.has(m.id)),
    gateways: scoped ? snap.gateways.filter((g) => mIds.has(g.managerId)) : snap.gateways,
    segments: scoped ? snap.segments.filter((s) => mIds.has(s.managerId)) : snap.segments,
    transportNodes: scoped ? snap.transportNodes.filter((t) => mIds.has(t.managerId)) : snap.transportNodes,
    dfw: scoped ? (snap.dfw || []).filter((p) => mIds.has(p.managerId)) : (snap.dfw || []),
    securityGroups: scoped ? (snap.securityGroups || []).filter((g) => mIds.has(g.managerId)) : (snap.securityGroups || []),
    collectionErrors: snap.collectionErrors,
  });
});

// NSX 보안그룹 라이브 멤버 조회(온디맨드). groupId는 스냅샷의 "managerId:rawId" 형식.
api.get('/nsx/group-members', async (req, res) => {
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
  try {
    const data = await fetchGroupMembers(mgr, rawId);
    res.json({ mock: false, ...data });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
}
