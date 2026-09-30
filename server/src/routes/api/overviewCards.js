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
  const out = buildPowerTotal({ servers, network, storage, dcOfVc: (vc) => String(assign[vc] || ''), dcName });
  return { ...out, errors };
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
        power = { totalWatts: p.totalWatts, servers: { watts: p.servers.watts, measured: p.servers.measured },
          network: { watts: p.network.watts, measured: p.network.measured, devices: p.network.devices },
          storage: { watts: p.storage.watts, measured: p.storage.measured, devices: p.storage.devices, unsupported: p.storage.unsupported },
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

  api.get('/tools/power-total', toolsPerm, fullScopeOnly, async (req, res) => {
    await memoJson(req, res, 'powerTotal', async () => ({ ok: true, ...(await powerTotal()) }), { ttlMs: 20_000 });
  });
}
