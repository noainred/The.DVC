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
import { WATCH_EVERY_MS, GAP_MS, powerStateOf, planObservation, planBackfill } from './spans.js';
import { powerDb, openSpansOf, watchOf, commitObservation, backfillSourceOf, commitBackfill, prunePower, lastWatchTs } from './db.js';

const TICK_MS = 60_000;
const PRUNE_EVERY = 144;   // 관측 144회(약 하루)마다
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
export async function runPowerWatchOnce({ now = Date.now(), snap = null, trigger = 'tick' } = {}) {
  if (running) return { ok: false, skipped: true, reason: '이미 관측 중입니다.' };
  running = true;
  const started = Date.now();
  let r = null;
  try {
    r = await runInner({ now, snap: snap || store.get(), trigger });
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

async function runInner({ now, snap }) {
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
    if (NOT_SERVING.has(vc.status) && !list.length) { out.held.push([id, vc.status]); continue; }
    const watch = await watchOf(id);
    if (!watch) {
      if (!list.length) { out.held.push([id, 'empty']); continue; }
      const src = await backfillSourceOf(id);
      const rows = planBackfill({ vms: list, firstSeen: src?.firstSeen || new Map(), changes: src?.changes || [], snapTs: src?.snapTs || [], ts: now });
      const c = await commitBackfill(id, rows, now);
      if (c?.backfill) out.backfilled += c.backfill;
      out.opened += c?.inserted || 0;
      out.vcenters++;
      await tickYield();
      continue;
    }
    const open = await openSpansOf(id);
    // 열린 구간이 있는데 목록이 비었다 — 수집 이상(인벤토리 일시 누락)일 수 있다. 전부 '삭제됨' 으로 닫지 않는다.
    if (!list.length && open?.size) { out.held.push([id, 'empty']); continue; }
    const plan = planObservation({ open: open || new Map(), watchLast: watch.lastTs, vms: list, ts: now });
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
      if (Date.now() - lastAt < WATCH_EVERY_MS) return;
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
