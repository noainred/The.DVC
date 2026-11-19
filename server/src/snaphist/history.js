/**
 * snaphist/history.js — 스냅샷 이력 DB 읽기(v3.26.0 · 설계 docs/design/snapshots §4 · §5).
 *
 * 규칙:
 *   · **부분 합은 추이에 넣지 않는다**(루트 CLAUDE.md): 고른 범위의 vCenter 중 그날 기록이 없는(못 읽은 · 일부만 읽은) 것이 있으면
 *     그날 점은 값이 아니라 `null` + missing 수다. ‘기록이 아직 시작되지 않은’ vCenter(그 vCenter 의 첫 행보다 앞)는 빠진 것으로 세지 않는다.
 *   · 반증 3: 점검중(maintenance) · 비활성(disabled)은 그날 묶음에서 **뺀다**(빠진 것으로 세면 한 곳이 오래 점검중이면 전 함대 추이가 매일 비었다 —
 *     metrics/unreadVcenters.js 의 v2.621 RECENT-03 과 같은 함정). 뺀 수는 excluded 로 따로 싣는다.
 *   · 크기를 못 읽은 VM 이 있는 날의 크기 합은 null(개수 · 기준 넘김 수는 그대로 — 그 VM 은 행이 있다).
 *   · 법인(묶음) 판정은 view.js 와 같다(DataCenter → 없으면 vCenter). 법인별 추이도 같은 규칙으로 서버가 만든다(화면에 두 번째 판정을 두지 않는다).
 *   · 범위 · 고른 법인 교집합은 부르는 라우트가 먼저 건 집합(vcIds)으로만 읽는다.
 */
import { dayKeyOf } from './record.js';
import { snapHistStmts, snapHistMeta, snapHistDbStatus, retentionDays } from './db.js';
import { snapHistPollerStatus } from './poller.js';

const DAY = 86_400_000;
export const DAYS_MAX = 400;
export const GONE_MAX = 2000;
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

export function clampDays(v, def = 30) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(DAYS_MAX, n) : def;
}

/** 기간의 날 열쇠 목록(오래된 날부터, 오늘 포함). */
export function dayKeys(now, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(dayKeyOf(now - i * DAY));
  return out;
}

/**
 * 날별 합(순수 — 시험용). rows = snap_vcday 행, vcIds = 이 묶음의 vCenter, firstOk = vcId → 첫 'ok' 날.
 * @returns {{day:string, vms:number|null, snaps:number|null, gb:number|null, gbUnknown:number|null, over:number|null, missing:number}[]}
 */
export function aggregateDays(days, rows, vcIds, firstOk) {
  const byDay = new Map();
  for (const r of rows) {
    if (!vcIds.has(r.vcenter_id)) continue;
    if (!byDay.has(r.day)) byDay.set(r.day, new Map());
    byDay.get(r.day).set(r.vcenter_id, r);
  }
  return days.map((day) => {
    const m = byDay.get(day) || new Map();
    let missing = 0; let excluded = 0; let any = false;
    const acc = { vms: 0, snaps: 0, gb: 0, gbUnknown: 0, over: 0 };
    for (const id of vcIds) {
      const f = firstOk.get(id);
      if (!f || day < f) continue;            // 이 vCenter 는 그날 아직 기록을 시작하지 않았다
      const r = m.get(id);
      if (r && (r.status === 'maintenance' || r.status === 'disabled')) { excluded += 1; continue; }
      if (!r || r.status !== 'ok') { missing += 1; continue; }
      any = true;
      acc.vms += r.vms || 0; acc.snaps += r.snaps || 0; acc.gb += r.gb || 0; acc.gbUnknown += r.gb_unknown || 0; acc.over += r.over || 0;
    }
    if (missing || !any) return { day, vms: null, snaps: null, gb: null, gbUnknown: null, over: null, missing, excluded };
    return { day, vms: acc.vms, snaps: acc.snaps, gb: acc.gbUnknown ? null : r1(acc.gb), gbUnknown: acc.gbUnknown, over: acc.over, missing: 0, excluded };
  });
}

export async function historyStatus() {
  const meta = await snapHistMeta();
  const db = snapHistDbStatus();
  const p = snapHistPollerStatus();
  return {
    available: db.available && !!meta, error: db.error, started: meta?.started || null, lastDay: meta?.lastDay || null,
    retentionDays: p.retentionDays, recordHour: p.recordHour,
    last: p.lastResult ? { at: p.lastResult.at, day: p.lastResult.day, ok: p.lastResult.ok, recorded: p.lastResult.recorded, missing: p.lastResult.missing, gone: p.lastResult.gone } : null,
  };
}

/**
 * 추이 — 전체(고른 범위) + 법인별. corpOf(vcId) → { corpId }.
 * @param {{vcIds:Set<string>, days:number, now:number, corpOf:(id:string)=>{corpId:string}}} o
 */
export async function historySeries({ vcIds, days, now = Date.now(), corpOf }) {
  const st = await snapHistStmts();
  if (!st) return null;
  const keys = dayKeys(now, days);
  const rows = st.vcdaySince.all(keys[0]);
  const firstOk = new Map();
  for (const id of vcIds) { const d = st.firstDay.get(id)?.d; if (d) firstOk.set(id, d); }
  const groups = new Map();
  for (const id of vcIds) { const c = corpOf(id).corpId; if (!groups.has(c)) groups.set(c, new Set()); groups.get(c).add(id); }
  const byCorp = {};
  for (const [c, ids] of groups) byCorp[c] = aggregateDays(keys, rows, ids, firstOk);
  // 빠진 날 — vCenter 별(그 기간 안에서 기록을 시작한 뒤 'ok' 가 아닌 날)
  const gaps = [];
  for (const id of vcIds) {
    const f = firstOk.get(id);
    if (!f) continue;
    const ok = new Set(rows.filter((r) => r.vcenter_id === id && (r.status === 'ok' || r.status === 'maintenance' || r.status === 'disabled')).map((r) => r.day));
    const miss = keys.filter((d) => d >= f && !ok.has(d) && d !== keys[keys.length - 1]);   // 오늘은 아직 기록 전일 수 있어 세지 않는다
    if (miss.length) gaps.push({ vcenterId: id, days: miss.length, last: miss[miss.length - 1] });
  }
  return { days: keys, series: aggregateDays(keys, rows, vcIds, firstOk), byCorp, gaps, recordingVcenters: firstOk.size };
}

/** 없어진 스냅샷(기간 안). */
export async function goneList({ vcIds, sinceTs, limit = GONE_MAX }) {
  const st = await snapHistStmts();
  if (!st) return null;
  const out = [];
  let more = false;
  // gone_at 인덱스로 최근부터 읽어 범위 밖은 건너뛴다 — 범위 계정이 많이 버려도 상한(limit × 4) 안에서 멈춘다
  const rows = st.goneSince.all(sinceTs, limit * 4);
  for (const r of rows) {
    if (!vcIds.has(r.vcenter_id)) continue;
    if (out.length >= limit) { more = true; break; }
    out.push({ vcenterId: r.vcenter_id, vmId: r.vm_id, vmName: r.vm_name, name: r.name, createTs: r.create_ts, firstSeen: r.first_seen, lastSeen: r.last_seen,
      goneAt: r.gone_at, reason: r.gone_reason === 'vm' ? 'vm' : 'snap' });
  }
  // 반증 7: 읽기 창(limit × 4)을 다 썼으면 그 뒤에 범위 안 항목이 더 있을 수 있다 — ‘더 있음’ 으로 말한다(조용한 상한 금지)
  if (rows.length >= limit * 4) more = true;
  return { items: out, more };
}

/** VM 하나의 이력 — 날별 개수 · 크기 + 스냅샷 생애. 빠진 날은 그 vCenter 의 기록 상태로 가린다. */
export async function vmHistory({ vcenterId, vmId, days, now = Date.now() }) {
  const st = await snapHistStmts();
  if (!st) return null;
  const keys = dayKeys(now, days);
  const rows = new Map(st.vmDays.all(vcenterId, vmId, keys[0]).map((r) => [r.day, r]));
  const ok = new Set(st.okDaysOf.all(vcenterId, keys[0]).map((r) => r.day));
  const series = keys.map((day) => {
    const r = rows.get(day);
    if (r) return { day, count: r.count, gb: r.gb, over: !!r.over };
    // 그날 그 vCenter 를 'ok' 로 기록했는데 행이 없으면 = 스냅샷이 없었다(0). 기록이 없으면 모름(null).
    return ok.has(day) ? { day, count: 0, gb: 0, over: false } : { day, count: null, gb: null, over: null };
  });
  const items = st.itemsOfVm.all(vcenterId, vmId).map((r) => ({ name: r.name, createTs: r.create_ts, mem: r.mem == null ? null : !!r.mem, quiesced: r.quiesced == null ? null : !!r.quiesced,
    firstSeen: r.first_seen, lastSeen: r.last_seen, goneAt: r.gone_at, reason: r.gone_reason || null }));
  return { days: keys, series, items };
}

/**
 * 7일 변화의 재료 — n일 전 그 vCenter 를 'ok' 로 기록한 날의 VM 별 크기. 그날 기록이 없으면 그 vCenter 는 모름.
 * @returns {{day:string, okVcenters:string[], rows:{vcenterId:string, vmId:string, count:number, gb:number|null}[]}|null}
 */
export async function dayAgo({ vcIds, n = 7, now = Date.now() }) {
  const st = await snapHistStmts();
  if (!st) return null;
  const day = dayKeyOf(now - n * DAY);
  const okVc = new Set(st.dayStatuses.all(day).filter((r) => r.status === 'ok' && vcIds.has(r.vcenter_id)).map((r) => r.vcenter_id));
  const rows = st.dayRows.all(day).filter((r) => okVc.has(r.vcenter_id)).map((r) => ({ vcenterId: r.vcenter_id, vmId: r.vm_id, count: r.count, gb: r.gb }));
  return { day, okVcenters: [...okVc], rows };
}

export { retentionDays };
