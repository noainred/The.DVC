/**
 * vmtrack/service.js — VM 수량 추이 수집·조회 서비스(v2.345).
 * store 스냅샷을 vCenter별로 갈라 직전 로스터와 diff 하고(순수 로직은 diff.js), DB 에 커밋한다.
 * 조회는 차트용 시계열과 '증감 클릭' 상세(생성/삭제 VM + 클러스터·호스트·데이터스토어)를 제공.
 */

import { diffVcenter, diffDatastores, totalsOf, slotKey, slotStartMs } from './diff.js';
import { commitSnapshot, loadRoster, loadDsRoster, readSeries, readChanges, readDsChanges, rosterVcenters, dropRoster, vmtrackMeta, vmtrackStatus, readDsSeries, listDsRoster, dsSeriesWindow, dsSeriesCarry } from './db.js';

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

// ── 데이터스토어별 증감 추이(v2.353, 사용자 요구) ──

const clampDays = (days) => Math.max(1, Math.min(1095, Number(days) || 30));

/** 데이터스토어 선택 목록 — 현재 로스터(연결 중인 DS). scope 강제, 사용량 내림차순. */
export async function vmtrackDsList({ scopeIds = null, vcenterId = '' } = {}) {
  const rows = await listDsRoster();
  return rows
    .filter((r) => (!vcenterId || r.vcenter_id === vcenterId) && (!scopeIds || scopeIds.has(r.vcenter_id)))
    .map((r) => ({
      dsId: r.ds_id, vcenterId: r.vcenter_id, name: r.name || r.ds_id, type: r.type || '',
      capGB: r.cap_gb || 0, usedGB: r.used_gb || 0,
      usagePct: r.cap_gb ? Math.round(((r.used_gb || 0) / r.cap_gb) * 1000) / 10 : 0,
      firstSeen: r.first_seen,
    }))
    .sort((a, b) => b.usedGB - a.usedGB);
}

/** diff-압축 관측(carry-in + 윈도우 행)을 스냅샷 슬롯 축 위에 '마지막 관측값 유지(step)'로 펼친다. */
function stepFill(slots, carryIn, rows) {
  const obs = [...(carryIn ? [carryIn] : []), ...rows];
  let i = -1;
  let cur = null;
  return slots.map((s) => {
    while (i + 1 < obs.length && obs[i + 1].ts <= s.ts) { i += 1; cur = obs[i]; }
    if (!cur) return { slot: s.slot, ts: slotStartMs(s.slot) ?? s.ts, collectedAt: s.ts, capGB: null, usedGB: null, usagePct: null };
    const capGB = cur.cap_gb ?? null;
    const usedGB = cur.used_gb ?? null;
    return {
      slot: s.slot, ts: slotStartMs(s.slot) ?? s.ts, collectedAt: s.ts, capGB, usedGB,
      usagePct: (capGB && usedGB != null) ? Math.round((usedGB / capGB) * 1000) / 10 : null,
      observed: cur.slot === s.slot, // 이 슬롯에 실제 관측(변화) 기록이 있었는가
    };
  });
}

/**
 * 개별 DS 시계열 — 첫 관측 이전 슬롯은 null(값을 지어내지 않는다).
 * scope: 해당 DS 의 vCenter 가 사용자 범위 밖이면 빈 결과.
 */
export async function vmtrackDsSeries({ dsId, days = 30, scopeIds = null } = {}) {
  const sinceTs = Date.now() - clampDays(days) * 86_400_000;
  const { carryIn, rows } = await readDsSeries({ dsId, sinceTs });
  const vcId = rows[0]?.vcenter_id || carryIn?.vcenter_id || null;
  if (!vcId) return { points: [], vcenterId: null };
  if (scopeIds && !scopeIds.has(vcId)) return { points: [], vcenterId: null, scoped: true };
  const slots = await readSeries({ vcenterId: vcId, sinceTs });
  return { points: stepFill(slots, carryIn, rows), vcenterId: vcId };
}

/**
 * 선택한 vCenter 의 전체 DS 일괄 시계열(v2.354, 사용자 요구: "모든 데이터스토어별로 각각").
 * 전체 vCenter(1,100 DS)를 한 번에 내리면 응답이 수 MB 라(고RTT 환경), vCenter 지정을
 * 필수로 하고 페이지(기본 12, 최대 24)로 자른다 — 화면도 vCenter 선택 시에만 그리드를 그린다.
 * 슬롯 축 조회는 vCenter 당 1회, DS 별 관측 조회는 페이지 항목만(인덱스 2회/DS).
 */
export async function vmtrackDsSeriesAll({ days = 30, vcenterId = '', scopeIds = null, q = '', sort = 'used', offset = 0, limit = 12 } = {}) {
  const vcId = String(vcenterId || '').trim();
  if (!vcId) return { items: [], total: 0, offset: 0, limit: 0, reason: 'vcenterId 필요' };
  if (scopeIds && !scopeIds.has(vcId)) return { items: [], total: 0, offset: 0, limit: 0, scoped: true };
  const sinceTs = Date.now() - clampDays(days) * 86_400_000;

  // 대상 DS: 로스터(현재 연결 중) 중 그 vCenter + 검색어.
  const ql = String(q || '').trim().toLowerCase();
  let roster = (await listDsRoster()).filter((r) => r.vcenter_id === vcId
    && (!ql || String(r.name || '').toLowerCase().includes(ql) || String(r.type || '').toLowerCase().includes(ql)));

  // 기간 증감(시작값 = 윈도우 직전 마지막 관측, 없으면 윈도우 내 첫 관측 — v2.351 기준선 원칙).
  const [windowRows, carryRows] = await Promise.all([dsSeriesWindow(sinceTs), dsSeriesCarry(sinceTs)]);
  const carry = new Map(carryRows.map((r) => [r.ds_id, r.used_gb]));
  const firstIn = new Map();
  for (const r of windowRows) if (!firstIn.has(r.ds_id)) firstIn.set(r.ds_id, r.used_gb);
  const deltaOf = (r) => {
    const start = carry.has(r.ds_id) ? carry.get(r.ds_id) : firstIn.get(r.ds_id);
    return (start == null || r.used_gb == null) ? 0 : Math.round((r.used_gb - start) * 10) / 10;
  };

  roster = roster.map((r) => ({ r, deltaGB: deltaOf(r) }));
  if (sort === 'delta') roster.sort((a, b) => Math.abs(b.deltaGB) - Math.abs(a.deltaGB) || (b.r.used_gb || 0) - (a.r.used_gb || 0));
  else if (sort === 'name') roster.sort((a, b) => String(a.r.name || '').localeCompare(String(b.r.name || ''), undefined, { numeric: true }));
  else roster.sort((a, b) => (b.r.used_gb || 0) - (a.r.used_gb || 0));

  const total = roster.length;
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Math.min(24, Number(limit) || 12));
  const page = roster.slice(off, off + lim);

  const slots = await readSeries({ vcenterId: vcId, sinceTs }); // 슬롯 축은 vCenter 당 1회
  const items = [];
  for (const { r, deltaGB } of page) {
    const { carryIn, rows } = await readDsSeries({ dsId: r.ds_id, sinceTs });
    items.push({
      dsId: r.ds_id, vcenterId: r.vcenter_id, name: r.name || r.ds_id, type: r.type || '',
      capGB: r.cap_gb || 0, usedGB: r.used_gb || 0,
      usagePct: r.cap_gb ? Math.round(((r.used_gb || 0) / r.cap_gb) * 1000) / 10 : 0,
      deltaGB,
      points: stepFill(slots, carryIn, rows),
    });
  }
  return { items, total, offset: off, limit: lim };
}

/**
 * 기간 증감 상위 DS — 현재값(로스터) − 윈도우 시작값. 시작값은 윈도우 직전 마지막 관측
 * (carry-in), 없으면 윈도우 내 첫 관측(그 DS 는 첫 관측 이후 변화만 — v2.351 기준선 원칙).
 */
export async function vmtrackDsTop({ days = 30, vcenterId = '', scopeIds = null, limit = 15 } = {}) {
  const sinceTs = Date.now() - clampDays(days) * 86_400_000;
  const [roster, windowRows, carryRows] = await Promise.all([
    listDsRoster(), dsSeriesWindow(sinceTs), dsSeriesCarry(sinceTs),
  ]);
  const carry = new Map(carryRows.map((r) => [r.ds_id, r.used_gb]));
  const firstIn = new Map();
  for (const r of windowRows) if (!firstIn.has(r.ds_id)) firstIn.set(r.ds_id, r.used_gb);
  const items = [];
  for (const r of roster) {
    if (vcenterId && r.vcenter_id !== vcenterId) continue;
    if (scopeIds && !scopeIds.has(r.vcenter_id)) continue;
    const startVal = carry.has(r.ds_id) ? carry.get(r.ds_id) : firstIn.get(r.ds_id);
    if (startVal == null || r.used_gb == null) continue;
    const deltaGB = Math.round((r.used_gb - startVal) * 10) / 10;
    items.push({
      dsId: r.ds_id, vcenterId: r.vcenter_id, name: r.name || r.ds_id, type: r.type || '',
      capGB: r.cap_gb || 0, usedGB: r.used_gb || 0,
      usagePct: r.cap_gb ? Math.round(((r.used_gb || 0) / r.cap_gb) * 1000) / 10 : 0,
      deltaGB,
    });
  }
  items.sort((a, b) => Math.abs(b.deltaGB) - Math.abs(a.deltaGB) || b.usedGB - a.usedGB);
  return {
    items: items.slice(0, Math.max(1, Math.min(100, Number(limit) || 15))),
    total: items.length,
    changedCount: items.filter((x) => x.deltaGB !== 0).length,
  };
}
