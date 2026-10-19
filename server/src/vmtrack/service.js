/**
 * vmtrack/service.js — VM 수량 추이 수집·조회 서비스(v2.345).
 * store 스냅샷을 vCenter별로 갈라 직전 로스터와 diff 하고(순수 로직은 diff.js), DB 에 커밋한다.
 * 조회는 차트용 시계열과 '증감 클릭' 상세(생성/삭제 VM + 클러스터·호스트·데이터스토어)를 제공.
 */

import { diffVcenter, diffDatastores, totalsOf, slotKey, slotStartMs, inventoryUnreadReason } from './diff.js';
import { commitSnapshot, loadRoster, loadDsRoster, readSeries, readChanges, readDsChanges, rosterVcenters, dropRoster, vmtrackMeta, vmtrackStatus, readDsSeries, listDsRoster, dsSeriesWindow, dsSeriesCarry, dsSeriesBoundary, dsSeriesGeneration, vmtrackGeneration, snapsBoundary, dsChangesBoundary, slotsSince, readDsChangesOfSlot } from './db.js';
import { createYielder } from '../util/timeSlice.js';

/**
 * 스냅샷 1회 — 현재 store 스냅샷 기준.
 * 위임(엣지 push) vCenter 도 스냅샷에 병합돼 있으므로 동일하게 추적된다.
 * 등록 해제된(스냅샷에 없는) vCenter 의 로스터는 삭제해, 재등록 시 전량 '신규'로 잡히는 오탐을
 * 막고(그 vCenter 는 다시 baseline 부터) 잔여 행이 남지 않게 한다.
 */
// v2.595(감사 WT-06): 사용량이나 용량을 모르면 사용률은 0% 가 아니라 null — 같은 파일의 증감 계산·diff.js 와 같은 규칙.
const dsPct = (used, cap) => (cap > 0 && used != null ? Math.round((Number(used) / cap) * 1000) / 10 : null);

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
  // 데이터스토어도 같은 방식으로 vCenter별 1회 그룹핑(v2.348).
  const dsByVc = new Map();
  for (const d of snap.datastores || []) {
    const k = String(d.vcenterId || '');
    let arr = dsByVc.get(k);
    if (!arr) dsByVc.set(k, arr = []);
    arr.push(d);
  }
  // 추적 대상 vCenter: 스냅샷의 vcenters 목록(수집 실패로 인벤토리가 비어도 0 대로 기록하면
  // 차트가 '전멸'로 보이므로, 인벤토리를 서빙하지 못하는 상태는 건너뛴다).
  // ⚠ v2.743(감사 VC-01 — 재현): 예전에는 unreachable·pending + VM 0 만 걸렀다 — **비활성**(store.js 가 VM·DS 없이 status 만 넣는다)과
  //   **캐시 없는 점검중**(재시작 직후 VM 0)이 diff 로 들어가 직전 로스터 전부가 '삭제' 로 적재됐고 skipped 도 0 이었다(다시 켜면 기준선이 되어
  //   그 사이 생성분도 '신규' 로 잡히지 않았다). 판정은 diff.js inventoryUnreadReason 한 벌(VM 생성·삭제 이력의 이름 대조와 같은 판정)이고,
  //   건너뛴 vCenter 는 VM·데이터스토어 diff 를 **둘 다** 하지 않는다(빈 DS 목록을 diff 하면 DS 전부가 '해제' 로 적재된다). 로스터는 지우지 않는다(아래).
  const targets = [];
  const skippedVcenters = [];
  for (const vc of snap.vcenters || []) {
    const id = String(vc?.id || '');
    if (!id) continue;
    const why = inventoryUnreadReason(vc, (byVc.get(id) || []).length);
    if (why) skippedVcenters.push({ id, status: vc.status || '', reason: why });
    else targets.push({ id, status: vc.status });
  }

  const perVc = [];
  for (const vc of targets) {
    const prev = await loadRoster(vc.id);
    const d = diffVcenter(byVc.get(vc.id) || [], prev);
    const dsPrev = await loadDsRoster(vc.id);
    const ds = diffDatastores(dsByVc.get(vc.id) || [], dsPrev);
    perVc.push({ vcenterId: vc.id, ...d, ds });
  }
  if (!perVc.length) return { ok: false, reason: '추적할 vCenter 가 없습니다(첫 수집 중·연결 실패·비활성·점검중이라 인벤토리를 읽은 vCenter 가 없음).', ...(skippedVcenters.length ? { skippedCount: skippedVcenters.length } : {}) };

  // 등록 해제(스냅샷 vcenters 목록에서 아예 사라진) vCenter 만 로스터를 정리한다.
  // liveIds(이번에 실제 처리한 vc)로 판단하면, 일시 unreachable(+인벤토리 0)로 targets 에서
  // 빠진 vc 의 로스터까지 지워져, 복구 시 그 vc 의 전 VM 이 '신규(+N)'로 잡히는 오탐이 난다.
  // 그래서 '이번에 처리했는가'가 아니라 '스냅샷에 등록돼 있는가(status 무관)'로만 판단한다.
  const knownIds = new Set((snap.vcenters || []).map((vc) => String(vc.id || '')).filter(Boolean));
  for (const id of await rosterVcenters()) if (!knownIds.has(id)) await dropRoster(id);

  const totalRow = totalsOf(perVc);
  // v2.594: 이번 슬롯에서 빠진 vCenter(수집 실패·첫 수집 중·v2.743 비활성·캐시 없는 점검중 — 인벤토리를 읽지 못함)를 결과에 밝힌다.
  //   사유는 항목마다(reason) + 사유별 개수(skippedByReason — 비활성은 'disabled' 로 따로). skippedCount 는 예전처럼 diff 를 건너뛴 전부다.
  // ⚠⚠ v2.744(감사 RECENT-01 — v2.743 회귀, 재현): 예전에는 DB 의 skipped 열(차트 '부분 합' 표지)에 **사유와 무관하게** 빠진 수를 넣었다.
  //   경영 보기 VM 추이(overview/trend.js vmTrend)는 skipped>0 인 칸을 통째로 비우므로, 비활성 vCenter 가 하나라도 등록돼 있으면 그 상태가
  //   끝날 때까지 **모든 슬롯이 부분 합**이 되어 추이가 영구히 비었다(VM 수량 추이 화면의 '부분 합' 배지도 사라지지 않았다). 사유별로 나눈다:
  //   · skipped(부분 합) = '기다리면 다시 읽힐' 사유 — 첫 수집 중·연결 실패 · 모르는 상태(unknown·그 밖)는 단정하지 않고 부분 합 쪽에 둔다.
  //   · 비활성(disabled) = 원래 합계 대상이 아니다(v2.617 '비활성은 분모에서 뺀다' — 카드 값 virtual.count 에도 없다). skippedByReason 에만 남긴다.
  //   · 캐시 없는 점검중(maintenance) = 기한 없는 상태라 합계를 막는 집합에 넣지 않는다(v2.622 RECENT-01) — maint_excluded 열·maintExcluded 로
  //     따로 남기고 화면이 '점검중 N곳 제외' 로 말한다(추이를 null 로 만들지 않는다).
  //   diff 를 건너뛰는 판정(inventoryUnreadReason)은 그대로다(로스터 보존 — v2.743 VC-01).
  const skippedByReason = {};
  for (const x of skippedVcenters) skippedByReason[x.reason] = (skippedByReason[x.reason] || 0) + 1;
  const maintExcluded = skippedByReason.maintenance || 0;
  const partialSkipped = skippedVcenters.length - (skippedByReason.disabled || 0) - maintExcluded;
  totalRow.skipped = partialSkipped;
  totalRow.maintExcluded = maintExcluded;
  const r = await commitSnapshot({ slot, ts, perVc, totalRow });
  if (!r.ok) return r;
  return {
    ok: true, slot, ts, trigger,
    vcenters: perVc.length, total: totalRow.total,
    onCount: totalRow.onCount, offCount: totalRow.offCount,
    added: totalRow.added, removed: totalRow.removed,
    poweredOn: totalRow.poweredOn, poweredOff: totalRow.poweredOff,
    dsCount: totalRow.dsCount, dsCapGB: totalRow.dsCapGB, dsUsedGB: totalRow.dsUsedGB,
    ...(totalRow.dsUsedUnknown ? { dsUsedUnknown: totalRow.dsUsedUnknown } : {}),
    baseline: totalRow.baseline,
    ...(skippedVcenters.length ? { skippedVcenters: skippedVcenters.slice(0, 64), skippedCount: skippedVcenters.length, skippedByReason, partialSkipped, maintExcluded } : {}),
  };
}

/** v2.744(감사 RECENT-01): 사유별로 나눠 저장하기 시작한 열 — 옛 행(열 추가 이전)은 0 이다. */
const maintOf = (r) => Number(r?.maint_excluded) || 0;

/**
 * 차트/표 데이터. scopeIds(사용자 데이터 범위)가 주어지면 그 vCenter 만 집계한다 —
 * 전체 합계도 '허용 vCenter 합'으로 다시 계산해야 범위 밖 수량이 새지 않는다(CLAUDE.md scope 규칙).
 * @param {{days:number, vcenterId:string, scopeIds:Set<string>|null}} opts
 */
/**
 * v2.601(감사 LO2601-05): 집계 사용률. 사용량을 읽은 DS 의 용량 합이 0 이면(DS 없음·전부 사용량 미상) 0% 가 아니라 **모른다**(null).
 * 화면은 null 을 '—'(단위 없이)로 그린다.
 */
export function dsAggPct(usedGB, capGB) {
  const c = Number(capGB); const u = Number(usedGB);
  if (capGB == null || usedGB == null || !(c > 0) || !Number.isFinite(u)) return null;
  return Math.round((u / c) * 1000) / 10;
}

/**
 * v2.744(감사 DB-05·DB-01): 세대 + 창 경계 + 조건 키의 결과 기억(진행 중 조회 공유 포함).
 *   데이터는 슬롯 커밋(하루 2회)·prune 때만 바뀌는데 스토리지 추적 화면이 30초마다 같은 365일 조회(스냅샷 2만 행 읽기 + 묶기)를
 *   다시 돌렸다(합성 0.12~0.2초 정지 × 30초마다). 세대(vmtrackGeneration)는 snaps·ds_changes 를 바꾸는 커밋·prune 이 올린다.
 *   ⚠ 키에 days 가 아니라 **창 경계**(경계 ≥ sinceTs 인 첫 행 시각 — 인덱스 끝점 1회)를 쓴다 — sinceTs 는 요청마다 움직이지만
 *   '행 ts >= sinceTs' 와 '행 ts >= 경계' 는 같은 집합이다(v2.630 dsStartValues 와 같은 판단). 반환 객체는 **공유**다 — 호출부는 고치지 말 것.
 *   DB 를 못 연 상태는 기억하지 않는다(빈 결과가 남으면 잠금이 풀린 뒤에도 '스냅샷 없음' 이라는 거짓이 된다).
 */
function createGenMemo(max) {
  const m = new Map();
  const memo = (gen, key, fn) => {
    const k = `${gen}|${key}`;
    const hit = m.get(k);
    if (hit) { m.delete(k); m.set(k, hit); return hit; }
    // 세대가 바뀌면 옛 세대 항목은 다시 맞을 수 없다 — 지운다(v2.580 TUNE-B 규약).
    for (const kk of m.keys()) if (!kk.startsWith(`${gen}|`)) m.delete(kk);
    const p = Promise.resolve().then(fn);
    m.set(k, p);
    p.catch(() => { if (m.get(k) === p) m.delete(k); });
    // 조회 중에 세대가 바뀌었으면(커밋·정리가 끼어들었으면) 이 결과를 기억으로 남기지 않는다.
    p.then(() => { if (vmtrackGeneration() !== gen && m.get(k) === p) m.delete(k); }, () => {});
    while (m.size > max) m.delete(m.keys().next().value);
    return p;
  };
  memo.size = () => m.size;
  memo.clear = () => m.clear();
  return memo;
}
const scopeKeyOf = (scopeIds) => (scopeIds ? `s:${[...scopeIds].map(String).sort().join(',')}` : '*');
const _seriesMemo = createGenMemo(6);
const _changeLogMemo = createGenMemo(6);   // v2.744(감사 DB-01): 스토리지 변경 이력 — 시각별
/** 테스트용 — 기억 크기·비우기. */
export function _vmtrackMemoForTest() { return { series: _seriesMemo.size(), clear: () => { _seriesMemo.clear(); _changeLogMemo.clear(); } }; }

export async function vmtrackSeries({ days = 30, vcenterId = '', scopeIds = null } = {}) {
  const sinceTs = Date.now() - Math.max(1, Math.min(1095, days)) * 86_400_000;
  if (!vmtrackStatus().available) return computeSeries({ sinceTs, vcenterId, scopeIds });
  const gen = vmtrackGeneration();
  const boundary = await snapsBoundary(sinceTs);
  return _seriesMemo(gen, `${boundary ?? 'none'}|${vcenterId}|${scopeKeyOf(scopeIds)}`, () => computeSeries({ sinceTs, vcenterId, scopeIds }));
}

async function computeSeries({ sinceTs, vcenterId = '', scopeIds = null }) {

  // 특정 vCenter 요청: 범위 검사 후 그 계열만.
  if (vcenterId) {
    if (scopeIds && !scopeIds.has(vcenterId)) return { points: [], vcenters: [], scoped: true };
    const rows = await readSeries({ vcenterId, sinceTs });
    return {
      points: rows.map((r) => ({ snapId: r.id, slot: r.slot, ts: slotStartMs(r.slot) ?? r.ts, collectedAt: r.ts,
        total: r.total, onCount: r.on_count, offCount: r.total - r.on_count,
        added: r.added, removed: r.removed, poweredOn: r.powered_on, poweredOff: r.powered_off,
        dsCount: r.ds_count || 0, dsCapGB: r.ds_cap_gb || 0, dsUsedGB: r.ds_used_gb || 0,
        dsUsagePct: dsAggPct(r.ds_used_gb, r.ds_cap_gb),
        baseline: !!r.baseline, dsUsedUnknown: r.ds_used_unknown || 0 })),
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
        dsUsagePct: dsAggPct(r.ds_used_gb, r.ds_cap_gb),
        baseline: !!r.baseline, skipped: r.skipped || 0, maintExcluded: maintOf(r), dsUsedUnknown: r.ds_used_unknown || 0 })),
      vcenters: vcs,
      bySlotVc: groupBySlot(perVcRows),
    };
  }
  const perVcRows = (await readSeries({ vcenterId: 'ALL', sinceTs })).filter((r) => scopeIds.has(r.vcenter_id));
  const bySlot = new Map();
  for (const r of perVcRows) {
    let a = bySlot.get(r.slot);
    if (!a) bySlot.set(r.slot, a = { slot: r.slot, ts: slotStartMs(r.slot) ?? r.ts, collectedAt: r.ts, total: 0, onCount: 0, offCount: 0, added: 0, removed: 0, poweredOn: 0, poweredOff: 0, dsCount: 0, dsCapGB: 0, dsUsedGB: 0, dsUsagePct: null, dsUsedUnknown: 0, baseline: true });
    a.total += r.total; a.onCount += r.on_count; a.offCount += (r.total - r.on_count);
    a.added += r.added; a.removed += r.removed;
    a.poweredOn += (r.powered_on || 0); a.poweredOff += (r.powered_off || 0);
    a.dsCount += (r.ds_count || 0); a.dsCapGB += (r.ds_cap_gb || 0); a.dsUsedGB += (r.ds_used_gb || 0);
    a.dsUsedUnknown += (r.ds_used_unknown || 0);
    if (!r.baseline) a.baseline = false;
  }
  // v2.598(감사 RECENT2598-02 — 재현: a 5대 + b 7대 → 다음 슬롯 b 수집 실패 · 범위 a,b 계정은 12→5 를 배지 없이 봤다):
  // 저장된 합계 행의 skipped 는 **전 함대** 기준이라 범위 계정에 그대로 줄 수 없고, 예전에는 아예 버렸다. 범위 안에서
  // 다시 센다 — 슬롯 S 에 행이 없는 범위 안 vCenter 중 **S 이전에 행이 있던 것**(조회 구간 안에서 추적 중이던 것)을
  // 후보로 보고, 그 슬롯의 전 함대 skipped 를 넘지 않게 자른다(그 슬롯에 '빠진 vCenter' 가 없었다면 등록 해제·신규라
  // 부분 합이 아니다). 범위 밖 vCenter 의 skipped 가 섞여 한 대까지 과대할 수 있다 — 과소(급감을 정상으로 보이게)보다 낫다.
  const totalRows = await readSeries({ vcenterId: '', sinceTs });
  const totalSkipped = new Map(totalRows.map((r) => [r.slot, Number(r.skipped) || 0]));
  // v2.744(감사 RECENT-01): 점검중 제외 수도 같은 방식으로 범위 안에서 다시 센다 — 후보 중 부분 합으로 센 몫을 뺀 나머지를
  //   그 슬롯의 전 함대 점검중 제외 수 이하로 자른다(비활성은 어느 쪽에도 세지 않는다 — 전 함대 값이 둘 다 0 이면 0 이다).
  const totalMaint = new Map(totalRows.map((r) => [r.slot, maintOf(r)]));
  const firstSlotOf = new Map();
  for (const r of perVcRows) { const f = firstSlotOf.get(r.vcenter_id); if (f == null || r.slot < f) firstSlotOf.set(r.vcenter_id, r.slot); }
  const presentBySlot = new Map();
  for (const r of perVcRows) (presentBySlot.get(r.slot) || presentBySlot.set(r.slot, new Set()).get(r.slot)).add(r.vcenter_id);
  for (const a of bySlot.values()) {
    const present = presentBySlot.get(a.slot) || new Set();
    let cand = 0;
    for (const [id, first] of firstSlotOf) if (first < a.slot && !present.has(id)) cand += 1;
    a.skipped = Math.min(cand, totalSkipped.get(a.slot) || 0);
    a.maintExcluded = Math.min(cand - a.skipped, totalMaint.get(a.slot) || 0);
  }
  // 사용률은 합산 후 1회 계산 — '전체 사용량 ÷ 전체 용량'(vCenter별 사용률의 평균이 아니다).
  for (const a of bySlot.values()) {
    a.dsCapGB = Math.round(a.dsCapGB * 10) / 10;
    a.dsUsedGB = Math.round(a.dsUsedGB * 10) / 10;
    a.dsUsagePct = dsAggPct(a.dsUsedGB, a.dsCapGB);
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
      dsUsagePct: dsAggPct(r.ds_used_gb, r.ds_cap_gb),
      baseline: !!r.baseline, dsUsedUnknown: r.ds_used_unknown || 0 });
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
      capGB: r.cap_gb || 0, usedGB: r.used_gb ?? null,   // v2.596: 모르면 null(사용률과 같은 규칙)
      usagePct: dsPct(r.used_gb, r.cap_gb),
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
  const { carry, firstIn } = await dsStartValues(sinceTs);
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
      capGB: r.cap_gb || 0, usedGB: r.used_gb ?? null,   // v2.596: 모르면 null(사용률과 같은 규칙)
      usagePct: dsPct(r.used_gb, r.cap_gb),
      deltaGB,
      points: stepFill(slots, carryIn, rows),
    });
  }
  return { items, total, offset: off, limit: lim };
}

/**
 * DS 별 '윈도우 시작값' 맵 — carry-in(직전 마지막 관측) 우선, 없으면 윈도우 내 첫 관측.
 *
 * v2.630(감사 PERF2630-01): 결과를 메모한다. 데이터는 vmtrack 슬롯 커밋(하루 2회)·prune 때만 바뀌는데 ds-top(V4 스토리지 5분
 *   폴링)·ds-pivot·ds-series-all 이 요청마다 창 전량 + 'GROUP BY MAX(ts) JOIN' 이월 조회를 동기로 돌렸다(합성 최악 0.35~0.58초 정지).
 *   ⚠ 키는 'days' 가 아니라 **창 경계**(ts>=sinceTs 인 첫 관측 시각)다 — sinceTs 는 매 요청 움직이지만 행 ts 가 슬롯 커밋 시각이라
 *   창 = ts>=경계, 이월 = ts<경계 로 결과가 **정확히** 같다(경계가 없으면 창은 비고 이월은 전체 마지막). 경계는 인덱스 끝점 1회다.
 *   세대(dsSeriesGeneration)는 ds_series 를 바꾸는 커밋·prune 이 올린다. 반환 Map 은 공유 객체다 — **호출부는 수정하지 말 것**.
 */
const DS_START_MEMO_MAX = 8;
const _dsStartMemo = new Map();   // key → Promise<{carry, firstIn}>
async function dsStartValues(sinceTs) {
  const boundary = await dsSeriesBoundary(sinceTs);
  const gen = dsSeriesGeneration();
  // DB 를 못 연 상태(빈 결과)는 메모하지 않는다 — 잠금이 풀린 뒤에도 빈 값이 남으면 '증감 없음' 이라는 거짓이 된다.
  if (!vmtrackStatus().available) {
    const [windowRows, carryRows] = await Promise.all([dsSeriesWindow(sinceTs), dsSeriesCarry(sinceTs)]);
    return startMaps(windowRows, carryRows);
  }
  const key = `${gen}|${boundary ?? 'none'}`;
  const hit = _dsStartMemo.get(key);
  if (hit) { _dsStartMemo.delete(key); _dsStartMemo.set(key, hit); return hit; }
  // 세대가 바뀌면 옛 세대 항목은 다시 맞을 수 없다 — 지운다(v2.580 TUNE-B 규약).
  for (const k of _dsStartMemo.keys()) if (!k.startsWith(`${gen}|`)) _dsStartMemo.delete(k);
  const p = (async () => {
    const [windowRows, carryRows] = await Promise.all([dsSeriesWindow(sinceTs), dsSeriesCarry(sinceTs)]);
    return startMaps(windowRows, carryRows);
  })();
  _dsStartMemo.set(key, p);
  p.catch(() => { if (_dsStartMemo.get(key) === p) _dsStartMemo.delete(key); });
  // 조회 중에 세대가 바뀌었으면(커밋이 끼어들었으면) 이 결과를 메모로 남기지 않는다.
  p.then(() => { if (dsSeriesGeneration() !== gen && _dsStartMemo.get(key) === p) _dsStartMemo.delete(key); }, () => {});
  while (_dsStartMemo.size > DS_START_MEMO_MAX) _dsStartMemo.delete(_dsStartMemo.keys().next().value);
  return p;
}

function startMaps(windowRows, carryRows) {
  const carry = new Map(carryRows.map((r) => [r.ds_id, r.used_gb]));
  const firstIn = new Map();
  for (const r of windowRows) if (!firstIn.has(r.ds_id)) firstIn.set(r.ds_id, r.used_gb);
  return { carry, firstIn };
}

/** 테스트용 — 메모 크기·초기화. */
export function _dsStartMemoSize() { return _dsStartMemo.size; }
export function _dsStartValuesForTest(sinceTs) { return dsStartValues(sinceTs); }

/**
 * 스토리지 변경 이력 — 시각별(v2.355, 목업 A): 슬롯 행마다 그 슬롯에 변화한 DS 칩 목록.
 * ds_changes(변경분만 저장)를 슬롯으로 그룹핑 — 무변화 DS 는 애초에 행이 없어 응답이 작다.
 * 칩은 |증감| 큰 순, 슬롯당 chipLimit 개 + 나머지는 more(개수)로 접는다(상세는 기존 슬롯
 * 클릭 모달이 전량을 보여준다).
 */
export async function vmtrackDsChangeLog({ days = 30, vcenterId = '', scopeIds = null, chipLimit = 24 } = {}) {
  const sinceTs = Date.now() - clampDays(days) * 86_400_000;
  const lim = Math.max(1, Math.min(100, chipLimit));   // 예전과 같은 식(라우트가 숫자로 넘긴다)
  // ⚠ v2.744(감사 DB-01 — 측정: 합성 365일 ds_changes 16.4만 행 · 28 vCenter 에서 옛 한 문장 조회 1,478ms 동안 이벤트 루프가 멈췄다 →
  //   새 경로 전체 709ms · 최장 멈춤 34ms · 기억 적중 0ms. 감사 보고는 운영 규모에서 1.5~9.6초): 예전에는 기간 전체를
  //   정렬해 한 번에 읽었다(readDsChangesWindow — LIMIT·양보·vCenter 조건 없음). 이제 창 안 슬롯마다 나눠 읽고(슬롯 안 정렬은 예전 조회와
  //   같다 — 묶음·칩 상한·합계가 슬롯 단위라 결과가 같다) 슬롯 사이에 시간 기준으로 양보한다. vCenter 조건은 SQL 로 내렸다.
  //   결과는 세대 + 창 경계(snaps·ds_changes 둘 다) + 조건 키로 기억한다 — 탭을 오갈 때마다 다시 읽지 않는다.
  //   ⚠ 한계(정직 기록): 읽는 사이에 커밋·정리가 끼면 슬롯마다 그 시점의 값이다(한 문장 조회처럼 한 순간의 사진이 아니다) — 그 결과는
  //   세대가 바뀌어 기억에 남지 않는다. 슬롯 목록은 snaps.ts>=since 로 고른다 — 시계가 거꾸로 간 경우(스냅샷 ts 가 줄어든 경우)만 다를 수 있다.
  const compute = async () => {
    const slots = await slotsSince(sinceTs);
    const yieldMaybe = createYielder(15);
    const bySlot = new Map();
    for (const slot of slots) {
      const rows = (await readDsChangesOfSlot(slot, sinceTs, vcenterId))
        .filter((r) => (!vcenterId || r.vcenter_id === vcenterId) && (!scopeIds || scopeIds.has(r.vcenter_id)));
      for (const r of rows) {
        let g = bySlot.get(r.slot);
        if (!g) bySlot.set(r.slot, g = { slot: r.slot, ts: slotStartMs(r.slot) ?? r.slot_ts, items: [], more: 0, sumDeltaGB: 0 });
        g.sumDeltaGB = Math.round((g.sumDeltaGB + (r.delta_gb || 0)) * 10) / 10;
        if (g.items.length >= lim) { g.more += 1; continue; }
        g.items.push({
          dsId: r.ds_id, name: r.name || r.ds_id, vcenterId: r.vcenter_id, type: r.type || '',
          kind: r.kind, deltaGB: r.delta_gb ?? null, usedGB: r.used_gb ?? null, capGB: r.cap_gb ?? null,
          usagePct: r.usage_pct ?? null,
        });
      }
      await yieldMaybe();
    }
    return { slots: [...bySlot.values()].sort((a, b) => b.ts - a.ts) };
  };
  if (!vmtrackStatus().available) return compute();
  const gen = vmtrackGeneration();
  const [snapB, dsB] = await Promise.all([snapsBoundary(sinceTs), dsChangesBoundary(sinceTs)]);
  return _changeLogMemo(gen, `${snapB ?? 'none'}|${dsB ?? 'none'}|${vcenterId}|${lim}|${scopeKeyOf(scopeIds)}`, compute);
}

/**
 * 스토리지 변경 이력 — DS별 피벗(v2.355, 목업 B): 행 = 데이터스토어, 열 = 최근 슬롯들의 증감.
 * 슬롯 열은 최근 slotCount(기본 6)개만(가로 폭), 누적은 days 윈도우 전체(현재값 − 시작값).
 * changedOnly(기본 true)면 열/누적에 변화가 있는 DS 만 — 1,091개 중 실제로 움직인 것만 보인다.
 */
export async function vmtrackDsPivot({ days = 30, vcenterId = '', scopeIds = null, q = '', changedOnly = true, sort = 'cum', offset = 0, limit = 20, slotCount = 6 } = {}) {
  const sinceTs = Date.now() - clampDays(days) * 86_400_000;
  const [roster, startVals] = await Promise.all([listDsRoster(), dsStartValues(sinceTs)]);
  const scoped = (vc) => (!vcenterId || vc === vcenterId) && (!scopeIds || scopeIds.has(vc));

  // 슬롯 열: 윈도우 내 스냅샷 슬롯 최근 N 개(전체 합계 행 기준 — 변화가 0 인 슬롯도 열로 나와야
  // '변화 없음'이 보인다). vCenter 지정 시 그 vCenter 의 스냅샷 슬롯.
  const snapRows = await readSeries({ vcenterId: vcenterId || '', sinceTs });
  const slotCols = snapRows.map((r) => ({ slot: r.slot, ts: slotStartMs(r.slot) ?? r.ts }))
    .sort((a, b) => b.ts - a.ts).slice(0, Math.max(1, Math.min(14, slotCount)));
  const colSet = new Set(slotCols.map((c) => c.slot));

  // DS별 슬롯 증감 맵(변경분만 존재 — 없는 칸은 0 또는 관측 전).
  // ⚠ v2.744(감사 DB-01 — 감사 보고: 365일 ds-pivot 1.5~9.6초 정지, 검색어 한 글자마다 반복 · 같은 합성 16.4만 행에서 새 경로 11ms): 예전에는 기간 전체 변경 행을 읽고 열(최근 N 슬롯)
  //   밖 행을 버렸다. 열로 쓰는 슬롯의 행만 슬롯마다 읽는다(누적 증감은 dsStartValues·로스터로 계산하므로 창 전체 행이 필요 없다).
  //   슬롯 안 순서는 예전 조회와 같다 — 같은 (DS, 슬롯) 이 두 번 나오면 뒤 행이 이기는 규칙도 그대로다.
  const perDs = new Map();
  for (const c of slotCols) {
    for (const r of await readDsChangesOfSlot(c.slot, sinceTs, vcenterId)) {
      if (!scoped(r.vcenter_id) || !colSet.has(r.slot)) continue;
      let m = perDs.get(r.ds_id);
      if (!m) perDs.set(r.ds_id, m = {});
      m[r.slot] = { kind: r.kind, deltaGB: r.delta_gb ?? null, usedGB: r.used_gb ?? null };
    }
  }

  const ql = String(q || '').trim().toLowerCase();
  const items = [];
  for (const r of roster) {
    if (!scoped(r.vcenter_id)) continue;
    if (ql && !String(r.name || '').toLowerCase().includes(ql) && !String(r.type || '').toLowerCase().includes(ql)) continue;
    const start = startVals.carry.has(r.ds_id) ? startVals.carry.get(r.ds_id) : startVals.firstIn.get(r.ds_id);
    const cumGB = (start == null || r.used_gb == null) ? 0 : Math.round((r.used_gb - start) * 10) / 10;
    const slots = {};
    let any = false;
    for (const c of slotCols) {
      const hit = perDs.get(r.ds_id)?.[c.slot];
      if (hit) { slots[c.slot] = hit; if (hit.deltaGB || hit.kind !== 'ds_changed') any = true; continue; }
      // 변경 행이 없는 칸: 관측 전(first_seen 이후 슬롯이 아니면)이면 null(—), 아니면 0.
      slots[c.slot] = (r.first_seen != null && c.ts < r.first_seen) ? null : { kind: 'none', deltaGB: 0 };
    }
    if (changedOnly && !any && !cumGB) continue;
    items.push({
      dsId: r.ds_id, name: r.name || r.ds_id, vcenterId: r.vcenter_id, type: r.type || '',
      capGB: r.cap_gb || 0, usedGB: r.used_gb ?? null,   // v2.596: 모르면 null(사용률과 같은 규칙)
      usagePct: dsPct(r.used_gb, r.cap_gb),
      cumGB, slots,
    });
  }
  if (sort === 'name') items.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  else if (sort === 'used') items.sort((a, b) => b.usedGB - a.usedGB);
  else items.sort((a, b) => Math.abs(b.cumGB) - Math.abs(a.cumGB) || b.usedGB - a.usedGB);
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Math.min(50, Number(limit) || 20));
  return { slotCols, items: items.slice(off, off + lim), total: items.length, offset: off, limit: lim };
}

/**
 * 기간 증감 상위 DS — 현재값(로스터) − 윈도우 시작값. 시작값은 윈도우 직전 마지막 관측
 * (carry-in), 없으면 윈도우 내 첫 관측(그 DS 는 첫 관측 이후 변화만 — v2.351 기준선 원칙).
 */
export async function vmtrackDsTop({ days = 30, vcenterId = '', scopeIds = null, limit = 15 } = {}) {
  const sinceTs = Date.now() - clampDays(days) * 86_400_000;
  const [roster, { carry, firstIn }] = await Promise.all([listDsRoster(), dsStartValues(sinceTs)]);
  const items = [];
  for (const r of roster) {
    if (vcenterId && r.vcenter_id !== vcenterId) continue;
    if (scopeIds && !scopeIds.has(r.vcenter_id)) continue;
    const startVal = carry.has(r.ds_id) ? carry.get(r.ds_id) : firstIn.get(r.ds_id);
    if (startVal == null || r.used_gb == null) continue;
    const deltaGB = Math.round((r.used_gb - startVal) * 10) / 10;
    items.push({
      dsId: r.ds_id, vcenterId: r.vcenter_id, name: r.name || r.ds_id, type: r.type || '',
      capGB: r.cap_gb || 0, usedGB: r.used_gb ?? null,   // v2.596: 모르면 null(사용률과 같은 규칙)
      usagePct: dsPct(r.used_gb, r.cap_gb),
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
