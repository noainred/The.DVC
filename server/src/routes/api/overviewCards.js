/**
 * routes/api/overviewCards.js — Overview 카드 8장 + 특수 기능 '전체 소비 전력'(v2.664).
 *
 *   GET /overview/cards       — 데이터센터·서버 Farm·물리 서버·가상 서버·GPU·스토리지 용량·네트워크 장비·소비 전력
 *   GET /tools/power-total    — 전체 소비 전력(서버/네트워크/스토리지) · 법인별 · 장비 목록
 *
 * 사용자 요청(2026-09-30): Overview 카드를 아래로 교체 —
 *   데이터센터 수량(설정 DataCenter) · 서버 Farm 수량(설정 수집 Agent) · 물리 서버(서버분석 등록 수, 그 화면으로) ·
 *   가상 서버(vCenter VM 수, vCenter 화면으로) · GPU 수량(서버분석 GPU, 그 탭으로) · 스토리지 용량(스토리지 모니터링 총용량) ·
 *   네트워크 장비(CVP 등록 장비 수) · 소비 전력(iDRAC 서버 + CVP 네트워크 + 스토리지).
 * 원칙: 새로 수집하지 않는다 — 이미 가진 값(등록부·스냅샷·DB 최신값)만 조합한다(장비 왕복 0). 못 읽은 값은 null 이고
 *   0 으로 채우지 않는다. 범위 제한 계정에는 vCenter 축이 없는 값(수집 Agent·스토리지·CVP)을 null + 사유로 준다(v2.525 규약).
 */
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { memoJson, scopeKey } from './shared.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { analysisServersWithRemote, invForServer } from '../../insights/analysisServers.js';
import { scopeIdracServers } from '../admin/idracCore.js';
import { listDatacenters, getDatacenterAssign } from '../../datacenter/store.js';
import { listCollectors } from '../../collector/registry.js';
import { listDevices as listStorageDevices } from '../../storage/registry.js';
import { localSnapshots } from '../../storage/store.js';
import { edgeStorageSnapshots } from '../../central/storageEdge.js';
import { latestMapByDevice } from '../../storage/latestSnapshots.js';
import { allMeasuredPower } from '../../idrac/service.js';
import { buildPowerTotal } from '../../power/total.js';
import { numOrNull } from '../../util/numOrNull.js';
import { isAdminReq, addressMatcher, maskedIdToken, maskedAddressName } from '../../auth/addressMask.js';
import { vmtrackSeries } from '../../vmtrack/service.js';
import { capacityHistoryAll } from '../../storage/db.js';
import { devicePollMsByAgent } from './storageMon.js';
import { getDb as getPowerDb } from '../../idrac/db.js';
import { TREND_SPECS, normTrendDays, trendGrid, vmTrend, storageTrend, powerTrend, powerSampleHours, POWER_SAMPLES_PER_BUCKET, deltaOf, partialCount } from '../../overview/trend.js';

const toolsPerm = requirePerm('tools');
const fullScopeOnly = fullScopeOnlyWith('전체 소비 전력은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다 — 네트워크·스토리지는 vCenter 축이 없습니다.');
const FLEET_ONLY = '전체 범위 계정만 — vCenter 축이 없는 값입니다';

/** 스토리지 용량 합(순수) — 전체 용량을 읽은 장비만 더하고, 사용량은 읽은 장비끼리만(웹 storageUnits.capacityTotals 와 같은 규칙). */
export function storageCapacityTotals(items) {
  let total = 0; let used = 0; let usedTotal = 0; let read = 0; let unread = 0; let devices = 0;
  for (const d of items || []) {
    if (!d || d.enabled === false) continue;
    devices += 1;
    const t = numOrNull(d.snap?.capacity?.totalBytes);
    if (!(t > 0) || d.snap?.ok === false) { unread += 1; continue; }
    total += t; read += 1;
    const u = numOrNull(d.snap?.capacity?.usedBytes);
    if (u != null && u >= 0) { used += u; usedTotal += t; }
  }
  return { devices, read, unread, totalBytes: read ? total : null, usedBytes: usedTotal ? used : null, usedPct: usedTotal ? Math.round((used / usedTotal) * 1000) / 10 : null };
}

function storageItems() {
  const byId = latestMapByDevice([localSnapshots(), edgeStorageSnapshots()]);
  return listStorageDevices().map((d) => ({ ...d, snap: byId.get(d.id) || null }));
}

async function cvpItems() {
  const { listDeviceRows } = await import('../../cvp/db.js');
  const { listServers } = await import('../../cvp/registry.js');
  const { corpResolver } = await import('../../cvp/overview.js');
  const servers = listServers();
  const ids = new Set(servers.map((s) => String(s.id)));
  const corp = corpResolver(servers, listDatacenters());
  const r = await listDeviceRows({});
  return { unavailable: !!r.unavailable, rows: (r.rows || []).filter((d) => ids.has(String(d.cvpId))).map((d) => ({ ...d, corp: corp(d.cvpId) })), servers: servers.length };
}

async function powerTotal() {
  const snap = store.get() || {};
  const assign = getDatacenterAssign();
  const dcName = new Map(listDatacenters().map((d) => [String(d.id), d.name || String(d.id)]));
  const errors = {};
  let servers = []; let network = []; let storage = [];
  try { servers = await allMeasuredPower({ hosts: snap.hosts || [] }); } catch (e) { errors.servers = e?.message || String(e); }
  try { network = (await cvpItems()).rows; } catch (e) { errors.network = e?.message || String(e); }
  try { storage = storageItems(); } catch (e) { errors.storage = e?.message || String(e); }
  // v2.680 A-06: 서버 분모 — 서버 분석 등록(활성 · OME 콘솔 제외 · 엣지 보고분 포함). 못 읽으면 null(분모를 모른다고 밝힌다).
  let serversRegistered = null; let serverHosts = [];
  try {
    const reg = analysisServersWithRemote().filter((s) => s && s.enabled !== false);
    serversRegistered = reg.length;
    serverHosts = reg.flatMap((s) => [s.host, s.ip, ...(Array.isArray(s.hostNames) ? s.hostNames : [])]).filter((h) => typeof h === 'string' && h);
  } catch (e) { errors.serversRegistry = e?.message || String(e); }
  const out = buildPowerTotal({ servers, network, storage, dcOfVc: (vc) => String(assign[vc] || ''), dcName, serversRegistered });
  return { ...out, errors, serverHosts };
}

/**
 * v2.680 C-02: 비-admin(operator 는 tools 기본 보유)에게는 서버 목록의 주소형 id·이름을 가린다. 스캔 등록 iDRAC 은
 *   id = name = 관리 IP 이고 엣지 서버는 remote:<수집기>:<IP> 다. 형제 /tools/esxi-temp/sensors 와 같은 규칙(같은 값 → 같은 토큰).
 */
export function maskPowerServers(out, hosts = []) {
  const match = addressMatcher(hosts);
  const items = (out?.servers?.items || []).map((x) => {
    const o = { ...x };
    if (match(o.id)) o.id = maskedIdToken(o.id);
    if (match(o.name)) o.name = maskedAddressName(o.name);
    return o;
  });
  return { ...out, servers: { ...out.servers, items } };
}

export function registerOverviewCards(api) {
  api.get('/overview/cards', async (req, res) => {
    const snap = store.get() || {};
    const allowed = scopedVcenterIds(req.user, snap); // null = 제한 없음
    const full = allowed == null;
    await memoJson(req, res, 'overviewCards', async () => {
      // 데이터센터 — 설정 DataCenter. 범위 계정은 허용 vCenter 가 배정된 것만.
      const dcs = listDatacenters();
      const assign = getDatacenterAssign();
      const dcIn = full ? dcs : dcs.filter((d) => Object.entries(assign).some(([vc, id]) => String(id) === String(d.id) && allowed.has(vc)));
      // 물리 서버·GPU — 서버 분석 등록(OME 콘솔 제외). 범위 절단은 서버 분석과 같은 판정(scopeIdracServers).
      const phys = scopeIdracServers(req, analysisServersWithRemote().filter((s) => s.type !== 'ome')).servers;
      let gpus = 0; let invRead = 0;
      for (const s of phys) {
        const inv = invForServer(s);
        if (!inv?.collectedAt) continue;
        invRead += 1;
        for (const g of inv.gpus || []) if (String(g?.model || g?.name || '').trim()) gpus += 1;
      }
      // 가상 서버 — vCenter VM(범위 적용). 롤업(global.vms)과 같은 기준(템플릿 포함 — 개수는 따로 밝힌다).
      const vms = (snap.vms || []).filter((v) => full || allowed.has(v.vcenterId));
      const vcs = (snap.vcenters || []).filter((v) => full || allowed.has(v.id));
      const vcPending = vcs.filter((v) => v.status === 'pending').length;
      let storage = null; let network = null; let power = null; let farms = null;
      if (full) {
        farms = { count: listCollectors().length };
        storage = storageCapacityTotals(storageItems());
        try { const c = await cvpItems(); network = { count: c.unavailable ? null : c.rows.length, cvpServers: c.servers, unavailable: c.unavailable }; }
        catch (e) { network = { count: null, error: e?.message || String(e) }; }
        const p = await powerTotal();
        power = { totalWatts: p.totalWatts, servers: { watts: p.servers.watts, measured: p.servers.measured, devices: p.servers.devices, unread: p.servers.unread },
          network: { watts: p.network.watts, measured: p.network.measured, partial: p.network.partial, devices: p.network.devices },
          storage: { watts: p.storage.watts, measured: p.storage.measured, devices: p.storage.devices, unsupported: p.storage.unsupported, unread: p.storage.unread },
          errors: p.errors };
      }
      return {
        ok: true, scoped: !full,
        datacenters: { count: dcIn.length },
        farms: farms || { count: null, reason: FLEET_ONLY },
        physical: { count: phys.length, inventoryRead: invRead },
        virtual: { count: vms.length, poweredOn: vms.filter((v) => v.powerState === 'POWERED_ON').length, templates: vms.filter((v) => v.template).length, vcenters: vcs.length, vcentersPending: vcPending },
        gpus: { count: gpus, inventoryRead: invRead, servers: phys.length },
        storage: storage || { totalBytes: null, reason: FLEET_ONLY },
        network: network || { count: null, reason: FLEET_ONLY },
        power: power || { totalWatts: null, reason: FLEET_ONLY },
      };
    }, { extraKey: scopeKey(req.user, snap), ttlMs: 20_000 });
  });

  /**
   * GET /overview/trend?days=7|30|90 — 경영 보기 Overview 핵심 지표 추이(v2.670, 시안 design_handoff_exec_overview).
   * 이미 쌓는 시계열만 읽는다(장비 왕복 0). 계산·판정은 overview/trend.js(순수). 권한은 /overview/cards 와 같다(집계 수치).
   * 범위 계정: VM 은 허용 vCenter 만 합산하고, 스토리지·전력은 vCenter 축이 없어 null + 사유(카드와 같은 규칙).
   * ⚠ 스냅샷 세대(30초)가 아니라 **5분 캐시**다 — 전력 90일 창은 power_hourly 를 수백만 행 훑을 수 있고, 12시간·1일 버킷의
   *   추이는 5분 안에 바뀌지 않는다. 캐시 키에 범위(scopeKey)를 넣어 범위 계정 사이에 섞이지 않게 한다.
   */
  api.get('/overview/trend', async (req, res) => {
    try {
      const snap = store.get() || {};
      const allowed = scopedVcenterIds(req.user, snap);
      const days = normTrendDays(req.query.days);
      const key = `${days}|${scopeKey(req.user, snap)}`;
      const hit = TREND_CACHE.get(key);
      const now = Date.now();
      let p = hit && now - hit.at < TREND_TTL_MS ? hit.p : null;
      if (!p) {
        p = computeTrend(days, allowed, now);
        TREND_CACHE.set(key, { at: now, p });
        p.catch(() => TREND_CACHE.delete(key));
        if (TREND_CACHE.size > 64) TREND_CACHE.delete(TREND_CACHE.keys().next().value);
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json(await p);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ ok: false, reason: e?.message || String(e) });
    }
  });

  api.get('/tools/power-total', toolsPerm, fullScopeOnly, async (req, res) => {
    // v2.667: 못 읽은 스토리지의 세부(오류 원문)는 관리 주소를 담을 수 있다 — admin 에게만(operator 는 tools 를 기본 보유).
    const admin = isAdminReq(req);
    await memoJson(req, res, 'powerTotal', async () => {
      const { serverHosts, ...raw } = await powerTotal();
      let out = raw;
      if (!admin) {
        out = maskPowerServers(out, serverHosts);
        out.storage = { ...out.storage, issues: out.storage.issues.map(({ detail, ...x }) => ({ ...x, detailHidden: !!detail })) };
        out.addressHidden = true;
      }
      return { ok: true, ...out };
    }, { ttlMs: 20_000, extraKey: `role:${admin ? 'admin' : 'user'}` });
  });
}

const TREND_TTL_MS = 5 * 60_000;
const TREND_CACHE = new Map();

/** 추이 계산 — 원천마다 실패해도 나머지는 준다(그 지표만 error). */
async function computeTrend(days, allowed, now) {
  const spec = TREND_SPECS[days];
  const full = allowed == null;
  const since = now - spec.days * DAY_MS_T - spec.bucketMs;
  const out = { ok: true, days, bucketMs: spec.bucketMs, points: spec.points, grid: trendGrid(days, now), scoped: !full, generatedAt: now };
  // 가상 서버 — vmtrack(매일 00·12시). 범위 계정은 허용 vCenter 합산.
  try {
    const r = await vmtrackSeries({ days: spec.days + 2, vcenterId: '', scopeIds: allowed });
    const series = vmTrend(r.points, days, now);
    out.virtual = { series, delta: deltaOf(series), partial: partialCount(series), source: 'vm-track' };
  } catch (e) { out.virtual = { series: null, error: e?.message || String(e) }; }
  // 물리 서버 — 수를 기록하는 시계열이 없다. 지어내지 않는다.
  out.physical = { series: null, reason: 'no-series' };
  if (!full) {
    out.storage = { series: null, reason: FLEET_ONLY };
    out.power = { series: null, reason: FLEET_ONLY };
    return out;
  }
  // 스토리지 사용량 — 스토리지 모니터링 용량 이력(카드와 같은 장비 집합). 빠진 장비가 있는 버킷은 null.
  try {
    const devs = listStorageDevices();
    const { envPoll, pollOf } = devicePollMsByAgent(devs);
    const staleByDevice = new Map(devs.map((d) => [d.id, 2 * pollOf.get(d.agent || '')]));
    const pts = await capacityHistoryAll(since, spec.bucketMs, { nowMs: now, staleMs: 2 * envPoll, staleByDevice });
    const series = storageTrend(pts, days, now);
    out.storage = { series, delta: deltaOf(series), partial: partialCount(series), unit: 'bytes', source: 'storage-history', devices: pts.expectedDevices ?? null };
  } catch (e) { out.storage = { series: null, error: e?.message || String(e) }; }
  // 소비 전력 — iDRAC 서버 전력 시간당 롤업만(카드는 서버+네트워크+스토리지 — 화면이 그 차이를 말한다).
  try {
    const db = await getPowerDb();
    const rows = typeof db?.fleetHourSums === 'function' ? db.fleetHourSums(powerSampleHours(days, now)) : [];
    const r = powerTrend(rows, days, now);
    out.power = { series: r.series, delta: deltaOf(r.series), partial: partialCount(r.series), maxServers: r.maxServers, fullRatio: r.fullRatio,
      samplesPerBucket: POWER_SAMPLES_PER_BUCKET, unit: 'watts', scope: 'servers', source: 'power-hourly' };
  } catch (e) { out.power = { series: null, error: e?.message || String(e) }; }
  return out;
}
const DAY_MS_T = 86_400_000;

/** 테스트용 — 캐시 비우기. */
export function _resetTrendCacheForTest() { TREND_CACHE.clear(); }
