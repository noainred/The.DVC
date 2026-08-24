/**
 * vmtrack/service.js — VM 수량 추이 수집·조회 서비스(v2.345).
 * store 스냅샷을 vCenter별로 갈라 직전 로스터와 diff 하고(순수 로직은 diff.js), DB 에 커밋한다.
 * 조회는 차트용 시계열과 '증감 클릭' 상세(생성/삭제 VM + 클러스터·호스트·데이터스토어)를 제공.
 */

import { diffVcenter, diffDatastores, totalsOf, slotKey, slotStartMs } from './diff.js';
import { commitSnapshot, loadRoster, loadDsRoster, readSeries, readChanges, readDsChanges, rosterVcenters, dropRoster, vmtrackMeta, vmtrackStatus } from './db.js';

/**
 * 스냅샷 1회 — 현재 store 스냅샷 기준.
 * 위임(엣지 push) vCenter 도 스냅샷에 병합돼 있으므로 동일하게 추적된다.
 * 등록 해제된(스냅샷에 없는) vCenter 의 로스터는 삭제해, 재등록 시 전량 '신규'로 잡히는 오탐을
 * 막고(그 vCenter 는 다시 baseline 부터) 잔여 행이 남지 않게 한다.
 */
export async function takeVmSnapshot(snap, { trigger = 'manual', now = new Date() } = {}) {
  if (!vmtrackStatus().available) {
    // getDb() 는 poller/route 에서 먼저 호출되므로 여기 도달 시 실제 불가 상태.
    const st = vmtrackStatus();
    if (!st.available && st.error) return { ok: false, reason: `vmtrack DB 사용 불가: ${st.error}` };
  }
  const slot = slotKey(now);
  const ts = Date.now();

  // vCenter별 VM 그룹핑 — 스냅샷 전체를 vCenter 수만큼 재순회하지 않게 1회 그룹핑(O(N)).
  const byVc = new Map();
  for (const v of snap.vms || []) {
    const k = String(v.vcenterId || '');
    let arr = byVc.get(k);
    if (!arr) byVc.set(k, arr = []);
    arr.push(v);
  }
  // 추적 대상 vCenter: 스냅샷의 vcenters 목록(수집 실패로 인벤토리가 비어도 0 대로 기록하면
  // 차트가 '전멸'로 보이므로, 인벤토리를 서빙하지 못하는 상태(unreachable + VM 0)는 건너뛴다).
  const targets = (snap.vcenters || [])
    .map((vc) => ({ id: String(vc.id || ''), status: vc.status }))
    .filter((vc) => vc.id && !(vc.status === 'unreachable' && !(byVc.get(vc.id) || []).length)
      && !(vc.status === 'pending' && !(byVc.get(vc.id) || []).length));

  // 데이터스토어도 같은 방식으로 vCenter별 1회 그룹핑(v2.348).
  const dsByVc = new Map();
  for (const d of snap.datastores || []) {
    const k = String(d.vcenterId || '');
    let arr = dsByVc.get(k);
    if (!arr) dsByVc.set(k, arr = []);
    arr.push(d);
  }

  const perVc = [];
  for (const vc of targets) {
    const prev = await loadRoster(vc.id);
    const d = diffVcenter(byVc.get(vc.id) || [], prev);
    const dsPrev = await loadDsRoster(vc.id);
    const ds = diffDatastores(dsByVc.get(vc.id) || [], dsPrev);
    perVc.push({ vcenterId: vc.id, ...d, ds });
  }
  if (!perVc.length) return { ok: false, reason: '추적할 vCenter 가 없습니다(수집 대기 또는 전부 unreachable).' };

  // 스냅샷에서 사라진 vCenter(등록 해제) 로스터 정리.
  const liveIds = new Set(perVc.map((v) => v.vcenterId));
  for (const id of await rosterVcenters()) if (!liveIds.has(id)) await dropRoster(id);

  const totalRow = totalsOf(perVc);
  const r = await commitSnapshot({ slot, ts, perVc, totalRow });
  if (!r.ok) return r;
  return {
    ok: true, slot, ts, trigger,
    vcenters: perVc.length, total: totalRow.total,
    onCount: totalRow.onCount, offCount: totalRow.offCount,
    added: totalRow.added, removed: totalRow.removed,
    poweredOn: totalRow.poweredOn, poweredOff: totalRow.poweredOff,
    dsCount: totalRow.dsCount, dsCapGB: totalRow.dsCapGB, dsUsedGB: totalRow.dsUsedGB,
    baseline: totalRow.baseline,
  };
}

/**
 * 차트/표 데이터. scopeIds(사용자 데이터 범위)가 주어지면 그 vCenter 만 집계한다 —
 * 전체 합계도 '허용 vCenter 합'으로 다시 계산해야 범위 밖 수량이 새지 않는다(CLAUDE.md scope 규칙).
 * @param {{days:number, vcenterId:string, scopeIds:Set<string>|null}} opts
 */
export async function vmtrackSeries({ days = 30, vcenterId = '', scopeIds = null } = {}) {
  const sinceTs = Date.now() - Math.max(1, Math.min(1095, days)) * 86_400_000;

  // 특정 vCenter 요청: 범위 검사 후 그 계열만.
  if (vcenterId) {
    if (scopeIds && !scopeIds.has(vcenterId)) return { points: [], vcenters: [], scoped: true };
    const rows = await readSeries({ vcenterId, sinceTs });
    return {
      points: rows.map((r) => ({ snapId: r.id, slot: r.slot, ts: slotStartMs(r.slot) ?? r.ts, collectedAt: r.ts,
        total: r.total, onCount: r.on_count, offCount: r.total - r.on_count,
        added: r.added, removed: r.removed, poweredOn: r.powered_on, poweredOff: r.powered_off,
        dsCount: r.ds_count || 0, dsCapGB: r.ds_cap_gb || 0, dsUsedGB: r.ds_used_gb || 0,
        dsUsagePct: r.ds_cap_gb ? Math.round((r.ds_used_gb / r.ds_cap_gb) * 1000) / 10 : 0,
        baseline: !!r.baseline })),
      vcenters: [vcenterId],
    };
  }

  // 전체: scope 가 없으면 저장된 합계 행을 그대로(빠름), 있으면 vCenter별 행을 합산.
  if (!scopeIds) {
    const rows = await readSeries({ vcenterId: '', sinceTs });
    const perVcRows = await readSeries({ vcenterId: 'ALL', sinceTs });
    const vcs = [...new Set(perVcRows.map((r) => r.vcenter_id))].sort();
    return {
      points: rows.map((r) => ({ slot: r.slot, ts: slotStartMs(r.slot) ?? r.ts, collectedAt: r.ts,
        total: r.total, onCount: r.on_count, offCount: r.total - r.on_count,
        added: r.added, removed: r.removed, poweredOn: r.powered_on, poweredOff: r.powered_off,
        dsCount: r.ds_count || 0, dsCapGB: r.ds_cap_gb || 0, dsUsedGB: r.ds_used_gb || 0,
        dsUsagePct: r.ds_cap_gb ? Math.round((r.ds_used_gb / r.ds_cap_gb) * 1000) / 10 : 0,
        baseline: !!r.baseline })),
      vcenters: vcs,
      bySlotVc: groupBySlot(perVcRows),
    };
  }
  const perVcRows = (await readSeries({ vcenterId: 'ALL', sinceTs })).filter((r) => scopeIds.has(r.vcenter_id));
  const bySlot = new Map();
  for (const r of perVcRows) {
    let a = bySlot.get(r.slot);
    if (!a) bySlot.set(r.slot, a = { slot: r.slot, ts: slotStartMs(r.slot) ?? r.ts, collectedAt: r.ts, total: 0, onCount: 0, offCount: 0, added: 0, removed: 0, poweredOn: 0, poweredOff: 0, dsCount: 0, dsCapGB: 0, dsUsedGB: 0, dsUsagePct: 0, baseline: true });
    a.total += r.total; a.onCount += r.on_count; a.offCount += (r.total - r.on_count);
    a.added += r.added; a.removed += r.removed;
    a.poweredOn += (r.powered_on || 0); a.poweredOff += (r.powered_off || 0);
    a.dsCount += (r.ds_count || 0); a.dsCapGB += (r.ds_cap_gb || 0); a.dsUsedGB += (r.ds_used_gb || 0);
    if (!r.baseline) a.baseline = false;
  }
  // 사용률은 합산 후 1회 계산 — '전체 사용량 ÷ 전체 용량'(vCenter별 사용률의 평균이 아니다).
  for (const a of bySlot.values()) {
    a.dsCapGB = Math.round(a.dsCapGB * 10) / 10;
    a.dsUsedGB = Math.round(a.dsUsedGB * 10) / 10;
    a.dsUsagePct = a.dsCapGB > 0 ? Math.round((a.dsUsedGB / a.dsCapGB) * 1000) / 10 : 0;
  }
  return {
    points: [...bySlot.values()].sort((x, y) => x.ts - y.ts),
    vcenters: [...new Set(perVcRows.map((r) => r.vcenter_id))].sort(),
    bySlotVc: groupBySlot(perVcRows),
    scoped: true,
  };
}

/** 슬롯별 vCenter 분해(표의 'vCenter별' 열·증감 클릭 대상 id 확보용). */
function groupBySlot(rows) {
  const m = {};
  for (const r of rows) {
    (m[r.slot] ||= []).push({ snapId: r.id, vcenterId: r.vcenter_id, total: r.total, onCount: r.on_count,
      offCount: r.total - r.on_count, added: r.added, removed: r.removed,
      poweredOn: r.powered_on || 0, poweredOff: r.powered_off || 0,
      dsCount: r.ds_count || 0, dsCapGB: r.ds_cap_gb || 0, dsUsedGB: r.ds_used_gb || 0,
      dsUsagePct: r.ds_cap_gb ? Math.round((r.ds_used_gb / r.ds_cap_gb) * 1000) / 10 : 0,
      baseline: !!r.baseline });
  }
  return m;
}

/**
 * 증감 클릭 상세 — 생성/삭제된 VM 과 그 위치(클러스터·호스트·데이터스토어).
 * snapId(특정 vCenter 스냅샷) 또는 slot(그 시각의 전 vCenter)로 조회. scope 강제.
 */
export async function vmtrackChanges({ snapId = null, slot = null, scopeIds = null } = {}) {
  const rows = await readChanges({ snapId, slot });
  const filtered = scopeIds ? rows.filter((r) => !r.vcenter_id || scopeIds.has(r.vcenter_id)) : rows;
  return filtered.map((r) => ({
    kind: r.kind, vmId: r.vm_id, name: r.name, cluster: r.cluster, host: r.host, datastore: r.datastore,
    powerState: r.power_state, cpu: r.cpu, memMB: r.mem_mb, storageGB: r.storage_gb, guestOS: r.guest_os,
    vcenterId: r.vcenter_id || undefined,
  }));
}

/**
 * 데이터스토어 사용량 변경 상세(v2.348) — 연결/해제된 DS 와 사용량이 임계 이상 바뀐 DS.
 * snapId(특정 vCenter 스냅샷) 또는 slot(그 시각 전 vCenter). scope 강제.
 */
export async function vmtrackDsChanges({ snapId = null, slot = null, scopeIds = null } = {}) {
  const rows = await readDsChanges({ snapId, slot });
  const filtered = scopeIds ? rows.filter((r) => !r.vcenter_id || scopeIds.has(r.vcenter_id)) : rows;
  return filtered.map((r) => ({
    kind: r.kind, dsId: r.ds_id, name: r.name, type: r.type,
    capGB: r.cap_gb, usedGB: r.used_gb, freeGB: r.free_gb, usagePct: r.usage_pct,
    prevUsedGB: r.prev_used_gb, deltaGB: r.delta_gb,
    vcenterId: r.vcenter_id || undefined,
  }));
}

export async function vmtrackInfo() {
  return { status: vmtrackStatus(), meta: await vmtrackMeta() };
}
