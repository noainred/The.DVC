/**
 * vmpower/watcher.js — VM 전원 구간 관측기(v3.39.0). 10분마다 수집 결과(store 스냅샷)의 전원 상태를 읽어 바뀐 VM 만 기록한다.
 *   vCenter 왕복 없음 · 60초 틱 + 재진입 가드 · vCenter 하나당 트랜잭션 하나 + 사이사이 양보.
 *   - 못 읽은 vCenter(점검중 · 연결 실패 · 낡음 · 긴급중단 — metrics/sampler.js samplingUnreadReasons 하나)는 관측에서 뺀다 →
 *     다음 관측 때 그 사이가 '기록 없음'(power_gaps)으로 남는다. 빈 목록으로 열린 구간을 닫지 않는다(v2.590 P6 와 같은 이유).
 *   - 스냅샷 자체가 GAP_MS 보다 오래됐으면(수집이 통째로 멈춤) 관측하지 않는다.
 *   - vCenter 의 첫 관측 때 한 번 VM 추적 기록으로 지난 구간을 소급한다(spans.js planBackfill).
 *   - 하루 한 번(기동 첫 틱 제외) 보존 기간(VMTRACK_RETENTION_DAYS, 기본 1095일)보다 오래 전에 끝난 구간을 지운다.
 */
import { store } from '../store.js';
import { samplingUnreadReasons } from '../metrics/sampler.js';
import { numOrNull } from '../util/numOrNull.js';
import { WATCH_EVERY_MS, GAP_MS, powerStateOf, planObservation, planBackfill, backfillGaps } from './spans.js';
import { powerDb, openSpansOf, watchOf, commitObservation, backfillSourceOf, commitBackfill, prunePower, lastWatchTs, repairFuture, markHold } from './db.js';

const TICK_MS = 60_000;
const PRUNE_EVERY = 144;   // 관측 144회(약 하루)마다
/** 마지막 관측이 이만큼 넘게 미래면 시계가 앞으로 튀었다 돌아온 것 — 마지막 관측을 지금으로 되돌린다(재검토 #7). */
//   이보다 작은 역행(NTP 보정 등)은 시계가 따라잡을 때까지 건너뛴다 — 데이터를 건드리지 않는다(3회차 R1: 20분으로 줄였더니 1시간 역행에 구간이 깨졌다).
//   틱 게이트는 미래 관측에서도 매 틱 돌므로(2회차 N4) 따라잡는 즉시 관측이 이어진다.
const CLOCK_REPAIR_MS = 6 * 3_600_000;
/** 기동 직후 이 시간 동안은 큰 역행이어도 지우지 않고 건너뛰기만 한다 — 부팅 때 RTC 를 잘못 읽어 시계가 뒤처진 채 떴다가 NTP 가 맞추는 경우(5회차 결정 위험) 맞던 기록을 지우지 않게. */
const REPAIR_AFTER_UPTIME_MS = 30 * 60_000;
/** 인벤토리를 아직 서빙하지 못하는 상태(VM 0 과 함께면 '모른다'). */
const NOT_SERVING = new Set(['unreachable', 'pending', 'maintenance', 'disabled']);

let running = false;
let lastRun = null;      // { at, ok, ... }
let lastResult = null;
let lastAt = 0;
let runs = 0;
let timer = null;

export function powerWatchStatus() {
  return { running, intervalMs: WATCH_EVERY_MS, gapMs: GAP_MS, lastRun, lastResult };
}

const tickYield = () => new Promise((r) => { setImmediate(r); });

/** 관측 1회(자동 · 시험 공용). snap 을 넘기면 그것을 쓴다(시험). */
export async function runPowerWatchOnce({ now = Date.now(), snap = null, trigger = 'tick', uptimeMs = process.uptime() * 1000 } = {}) {
  if (running) return { ok: false, skipped: true, reason: '이미 관측 중입니다.' };
  running = true;
  const started = Date.now();
  let r = null;
  try {
    r = await runInner({ now, snap: snap || store.get(), trigger, uptimeMs });
    return r;
  } catch (e) {
    r = { ok: false, reason: String(e?.message || e).slice(0, 200) };
    console.warn(`[vmpower] 관측 실패: ${r.reason}`);
    return r;
  } finally {
    running = false;
    lastAt = now;
    lastRun = { at: now, ok: !!r && r.ok !== false, trigger, ms: Date.now() - started, ...(r?.idle === 'emergency-stop' ? { emergencyStop: true } : {}) };
    if (r && !r.skipped) lastResult = { at: now, ...r };
  }
}

async function runInner({ now, snap, uptimeMs }) {
  if (!(await powerDb())) return { ok: false, reason: '추적 DB 사용 불가(node:sqlite 없음 또는 초기화 실패)' };
  if (!snap?.vcenters?.length) return { ok: true, idle: 'no-inventory' };
  const unread = samplingUnreadReasons(snap);
  if ([...unread.values()].includes('stopped')) return { ok: true, idle: 'emergency-stop', emergencyStop: true };
  const gen = Date.parse(snap.generatedAt);
  if (Number.isFinite(gen) && now - gen > GAP_MS) return { ok: true, idle: 'stale-snapshot' };

  const byVc = new Map();
  for (const v of snap.vms || []) {
    if (!v || v.template || v.id == null) continue;
    const k = String(v.vcenterId);
    if (!byVc.has(k)) byVc.set(k, []);
    byVc.get(k).push({ vmId: String(v.id), name: v.name || '', state: powerStateOf(v.powerState) });
  }
  const out = { ok: true, vcenters: 0, held: [], opened: 0, closed: 0, gaps: 0, backfilled: 0 };
  for (const vc of snap.vcenters) {
    if (!vc || vc.id == null) continue;
    const id = String(vc.id);
    const list = byVc.get(id) || [];
    if (unread.has(id)) { out.held.push([id, unread.get(id)]); continue; }
    // 첫 수집 전(pending) · 비활성(disabled)은 VM 이 남아 있어도(지난 캐시) 지금 상태가 아니다 — 관측하지 않는다(그 사이는 '기록 없음').
    if (NOT_SERVING.has(vc.status)) { out.held.push([id, vc.status]); continue; }
    const watch = await watchOf(id);
    if (!watch) {
      if (!list.length) { out.held.push([id, 'empty']); continue; }
      const src = await backfillSourceOf(id);
      const rows = planBackfill({ vms: list, firstSeen: src?.firstSeen || new Map(), changes: src?.changes || [], snapTs: src?.snapTs || [], ts: now });
      const c = await commitBackfill(id, rows, now, backfillGaps({ snapTs: src?.snapTs || [], ts: now }));
      if (c?.backfill) out.backfilled += c.backfill;
      out.opened += c?.inserted || 0;
      out.vcenters++;
      await tickYield();
      continue;
    }
    // 시계가 뒤로 갔다(직전 관측 ≥ 지금) — 이번 관측은 쓰지 않는다. 미래로 크게 앞선 기록은 지금으로 되돌린다(그 사이는 다음 관측 때 끊김).
    if (watch.lastTs >= now) {
      if (watch.lastTs - now > CLOCK_REPAIR_MS && uptimeMs >= REPAIR_AFTER_UPTIME_MS) {
        const rr = await repairFuture(id, now);
        console.warn(`[vmpower] ${id}: 마지막 관측 시각이 미래(${new Date(watch.lastTs).toISOString()}) — 시계가 바뀐 것으로 보고 미래에 쓰인 구간 ${rr?.deleted ?? 0}개를 지우고 ${rr?.reopened ?? 0}개를 다시 열었습니다`);
      } else {
        await markHold(id, now);   // 건너뛰기 시작 — 다시 관측할 때 그 사이를 '기록 없음' 으로(4회차 R3)
      }
      out.held.push([id, 'clock']);
      continue;
    }
    const open = await openSpansOf(id);
    // 열린 구간이 있는데 목록이 비었다 — 수집 이상(인벤토리 일시 누락)일 수 있다. 전부 '삭제됨' 으로 닫지 않는다.
    if (!list.length && open?.size) { out.held.push([id, 'empty']); continue; }
    const plan = planObservation({ open: open || new Map(), watchLast: watch.lastTs, vms: list, ts: now });
    // 작은 시계 역행으로 건너뛴 동안은 관측하지 않았다 — 건너뛰기 시작(지금 시계) ~ 지금을 '기록 없음' 으로(시각 자체를 믿을 수 없어 앞선 기록과 겹쳐도 그렇게 칠한다).
    if (!plan.skip && watch.holdFrom != null && watch.holdFrom < now) plan.holdGap = { from: watch.holdFrom, to: now };
    const c = await commitObservation(id, plan, now);
    out.opened += c?.opened || 0; out.closed += c?.closed || 0; if (c?.gap) out.gaps++;
    out.vcenters++;
    await tickYield();
  }
  if (out.held.length) out.held = out.held.slice(0, 50);
  return out;
}

export function retentionDays() {
  const d = numOrNull(process.env.VMTRACK_RETENTION_DAYS);
  return d != null && d > 0 ? d : 1095;
}

export function startPowerWatch() {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    try {
      if (!lastAt) { const t = await lastWatchTs(); if (t) lastAt = t; }   // 재시작 직후 곧바로 다시 관측하지 않는다(기록이 있으면)
      // 마지막 관측이 미래면(시계가 앞으로 튀었다 돌아옴) 기다리지 않고 돈다 — runInner 가 vCenter 별 미래 기록을 지금으로 되돌린다(2회차 N4:
      //   예전에는 이 게이트가 매 틱 return 해 관측기 전체가 멈췄다 · 재시작 때도 lastWatchTs 가 미래 최댓값).
      const since = Date.now() - lastAt;
      if (since >= 0 && since < WATCH_EVERY_MS) return;
      if (!store.get()?.vcenters?.length) return;
      await runPowerWatchOnce();
      runs += 1;
      if (runs % PRUNE_EVERY === 0) {
        const r = await prunePower(Date.now() - retentionDays() * 86_400_000);
        if (r?.spans || r?.gaps) console.log(`[vmpower] 오래된 전원 구간 정리: 구간 ${r.spans} · 끊김 ${r.gaps}`);
      }
    } catch (e) {
      console.warn('[vmpower] 관측 실패:', e?.message || e);
    }
  }, TICK_MS);
  timer.unref?.();
}
