/**
 * vmseries/poller.js — 실시간 스파이크 주기 수집(v2.510). 기본 50분(사용자 결정), 설정에서 변경.
 *
 * CLAUDE.md 규약 전부 적용:
 *  - 재진입 가드(폴러 + 수동 실행 공유) — 이전 주기가 안 끝났으면 이번 틱은 건너뛴다.
 *  - 적응형 타이머(startAdaptiveTimer) + 설정 변경 즉시 재무장 — 주기를 모듈 로드 시 굳히지 않는다.
 *  - vCenter 동시 수집 제한(VMSERIES_CONCURRENCY 기본 4 — 응답이 크므로 인벤토리 폴러(8)보다 낮게).
 *  - per-vCenter 데드라인(기본 10분, 상한은 주기보다 짧게) — 느린 1곳이 다음 주기를 막지 않는다.
 *    ⚠ Promise.race 만으로는 SOAP 세션이 계속 돈다(v2.417 교훈) — signal 을 collect 에 넘겨 청크 경계에서
 *    중단시키고, 건별 SOAP 타임아웃(vc.timeoutMs)이 나머지를 끊는다.
 *  - site 위임·mock vCenter 는 건너뛴다(중앙은 직접 SOAP 불가 — 엣지가 push).
 *  - 디스크 여유 가드(VMSERIES_MIN_FREE_GB 기본 5): 부족하면 이번 주기 저장을 건너뛰고 상태에 남긴다 —
 *    포탈 디스크를 채워 다른 DB(ipam·metrics)까지 죽이지 않는다.
 *  - prune 스로틀: `(++tick % N) === 0` — 기동 첫 틱을 피한다(v2.453 규칙).
 *
 * 정직 규약: 한 주기 실패 = 그 vCenter 의 그 구간은 **영구 소실**이다(ESXi 버퍼 60분). 상태 API 가
 * 실패 목록을 그대로 내보내고, 화면의 커버리지가 그 구멍을 '스파이크 0' 이 아니라 '미측정' 으로 그린다.
 */
import { store } from '../store.js';
import { config, loadVcenterConfig } from '../config.js';
import { isMockVcenter } from '../mock/generator.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { withJob } from '../perf/monitor.js';
import { describeError } from '../util/errors.js';
import { loadVmSeriesSettings, onVmSeriesSettingsChange } from './settings.js';
import { resolveTargets, vcenterSelected } from './scope.js';
import { collectVcenterSpikes } from './collect.js';
import { commitVmSeries, loadCursors, pruneVmSeries, vmSeriesFreeBytes, setVmSeriesMeta, vmSeriesDiskUsage } from './db.js';
import { pushVmSeriesSlice, vmSeriesPushEnabled } from '../agent/vmSeriesPush.js';
import { poolSettled } from '../util/pool.js'; // v2.579: 동시성 풀 단일 소스

const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.VMSERIES_CONCURRENCY) || 4));
const MIN_FREE_BYTES = Math.max(0, Number(process.env.VMSERIES_MIN_FREE_GB ?? 5)) * 1024 ** 3;
const PRUNE_EVERY_RUNS = 12;                 // 50분 × 12 ≈ 10시간
const FIRST_DELAY_MS = Number(process.env.VMSERIES_FIRST_DELAY_MS) || 180_000; // 첫 인벤토리 수집이 자리잡은 뒤

let running = false;
let tick = 0;
let lastResult = null;   // { at, trigger, vcenters, vms, hosts, samples, moments, spikeRows, errors, skipped, ms, paused }
let lastRunTs = 0;
let timer = null;

export function vmSeriesPollerStatus() {
  const s = loadVmSeriesSettings();
  return { running, lastResult, lastRunTs, intervalMs: s.intervalMin * 60_000, enabled: s.enabled, concurrency: CONCURRENCY, minFreeBytes: MIN_FREE_BYTES };
}

// v2.579(ARCH-01): 풀 스캐폴드는 util/pool.js 하나다 — 항목별 결과 모양(예전 그대로)만 여기서 입힌다.
async function pool(items, n, fn) {
  return (await poolSettled(items, n, fn)).map((r) => (r.status === 'fulfilled' ? { ok: true, value: r.value } : { ok: false, error: r.reason }));
}

/** 데드라인: 주기의 절반 또는 10분 중 작은 값(다음 주기를 넘기지 않게), 최소 90초. */
function deadlineMs(settings) {
  return Math.max(90_000, Math.min(10 * 60_000, Math.floor((settings.intervalMin * 60_000) / 2)));
}

/** 한 vCenter 수집 + 저장(+ 엣지면 push). */
async function collectOne(vc, snap, settings) {
  const targets = resolveTargets(snap, settings, vc.id);
  if (!targets.vms.length && !targets.hosts.length) return { vcenterId: vc.id, skipped: 'no-targets', vms: 0, hosts: 0 };
  const cursors = await loadCursors(vc.id);
  const ac = new AbortController();
  const dl = deadlineMs(settings);
  const timerId = setTimeout(() => ac.abort(), dl); timerId.unref?.();
  let res;
  try {
    res = await collectVcenterSpikes(vc, targets, settings, cursors, { signal: ac.signal });
  } finally { clearTimeout(timerId); }
  const commit = await commitVmSeries(vc.id, res);
  if (res.historicalInterval) await setVmSeriesMeta(vc.id, 'historicalInterval', { at: Date.now(), intervals: res.historicalInterval });
  await setVmSeriesMeta(vc.id, 'vcenter', { id: vc.id, name: vc.name || vc.id, lastPollAt: Date.now() });
  let pushed = null;
  if (vmSeriesPushEnabled()) {
    try { pushed = await pushVmSeriesSlice(vc, res); }
    catch (e) { pushed = { ok: false, error: e?.message || String(e) }; }
  }
  return { vcenterId: vc.id, vms: res.stats.vms, hosts: res.stats.hosts, targetVms: targets.vms.length, targetHosts: targets.hosts.length, samples: res.stats.samples, moments: res.stats.moments, spikeRows: commit.spikes, commitMs: commit.ms, missing: res.stats.missing, pushed };
}

/** 수집 1회(수동/자동 공용). 진행 중이면 skipped. */
export async function runVmSeriesNow(trigger = 'manual') {
  if (running) return { ok: false, skipped: true, reason: '이미 수집이 진행 중입니다.' };
  running = true;
  const started = Date.now();
  try {
    const settings = loadVmSeriesSettings();
    if (!settings.enabled && trigger !== 'manual') return { ok: false, reason: '수집이 꺼져 있습니다(설정에서 켜세요).' };
    const snap = store.get();
    if (!snap?.vcenters?.length) return { ok: false, reason: '수집된 vCenter 스냅샷이 없습니다(폴링 전).' };
    if (snap.source === 'mock') {
      lastRunTs = Date.now();
      lastResult = { at: lastRunTs, trigger, vcenters: 0, mock: true, errors: [], skipped: [], ms: 0, vms: 0, hosts: 0, samples: 0, moments: 0, spikeRows: 0 };
      return { ok: true, ...lastResult, note: '데모(mock) 모드 — 실시간 표본이 없어 수집하지 않습니다(없는 스파이크를 지어내지 않는다).' };
    }
    // 디스크 여유 가드 — 부족하면 저장 자체를 건너뛴다(수집만 하고 버리는 낭비도 하지 않는다).
    const free = vmSeriesFreeBytes();
    if (free != null && MIN_FREE_BYTES > 0 && free < MIN_FREE_BYTES) {
      lastRunTs = Date.now();
      lastResult = { at: lastRunTs, trigger, paused: 'disk', freeBytes: free, minFreeBytes: MIN_FREE_BYTES, vcenters: 0, errors: [], skipped: [], ms: 0, vms: 0, hosts: 0, samples: 0, moments: 0, spikeRows: 0 };
      console.warn(`[vmseries] 디스크 여유 ${(free / 1024 ** 3).toFixed(1)}GB < ${(MIN_FREE_BYTES / 1024 ** 3).toFixed(0)}GB — 이번 주기 저장 건너뜀(구간 소실)`);
      return { ok: false, ...lastResult, reason: '디스크 여유 부족 — 저장을 건너뛰었습니다(보존일을 줄이거나 대상을 좁히세요).' };
    }
    const { vcenters } = loadVcenterConfig();
    const skipped = [];
    const vcs = (vcenters || []).filter((vc) => {
      if (vc.enabled === false || vc.maintenance) { skipped.push({ vcenterId: vc.id, why: vc.maintenance ? 'maintenance' : 'disabled' }); return false; }
      if (vc.collectMode === 'site') { skipped.push({ vcenterId: vc.id, why: 'site' }); return false; }     // 엣지가 push
      if (vc.mock === true || isMockVcenter(vc)) { skipped.push({ vcenterId: vc.id, why: 'mock' }); return false; }
      if (!vcenterSelected({ ...settings, enabled: true }, vc.id)) { skipped.push({ vcenterId: vc.id, why: 'not-selected' }); return false; }
      return true;
    });
    const results = await pool(vcs, CONCURRENCY, (vc) => withJob(`vmseries.collect:${vc.id}`, () => collectOne(vc, snap, settings)));
    const errors = []; const per = [];
    let vms = 0; let hosts = 0; let samples = 0; let moments = 0; let spikeRows = 0;
    results.forEach((r, i) => {
      const vc = vcs[i];
      if (!r.ok) {
        const d = describeError(r.error);
        errors.push({ vcenterId: vc.id, error: d.message, hint: d.hint || '' });
        console.error(`[vmseries] ${vc.id} (${vc.name}) 수집 실패: ${d.message}${d.hint ? ` — ${d.hint}` : ''}`);
        return;
      }
      per.push(r.value);
      if (r.value.skipped) { skipped.push({ vcenterId: vc.id, why: r.value.skipped }); return; }
      vms += r.value.vms; hosts += r.value.hosts; samples += r.value.samples; moments += r.value.moments; spikeRows += r.value.spikeRows;
    });
    // prune — 기동 첫 틱을 피한다. push 로 받는 site vCenter 파일까지 전부(usage 기준) 정리한다.
    if ((++tick % PRUNE_EVERY_RUNS) === 0 && settings.retentionDays > 0) {
      for (const u of vmSeriesDiskUsage()) { try { await pruneVmSeries(u.vcenterId, settings.retentionDays); } catch { /* */ } }
    }
    lastRunTs = Date.now();
    lastResult = { at: lastRunTs, trigger, vcenters: vcs.length - skipped.filter((s) => s.why === 'no-targets').length, vms, hosts, samples, moments, spikeRows, errors, skipped, per, ms: Date.now() - started, freeBytes: free };
    return { ok: errors.length === 0, ...lastResult };
  } finally {
    running = false;
  }
}

/** 적응형 타이머 기동 — 설정 변경(주기·on/off)은 즉시 재무장된다. */
export function startVmSeriesPoller() {
  if (timer) return;
  const getMs = () => Math.max(60_000, loadVmSeriesSettings().intervalMin * 60_000);
  timer = startAdaptiveTimer(getMs, async () => {
    if (running) return;                         // 재진입 가드
    if (!loadVmSeriesSettings().enabled) return; // opt-in — 꺼져 있으면 틱만 돈다
    try { await runVmSeriesNow('auto'); } catch (e) { console.warn(`[vmseries] 폴러 틱 오류: ${e.message}`); }
  }, { firstDelayMs: FIRST_DELAY_MS, name: 'vmseries', subscribe: onVmSeriesSettingsChange });
  if (loadVmSeriesSettings().enabled) console.log(`[vmseries] started — 주기 ${loadVmSeriesSettings().intervalMin}분 · 동시 ${CONCURRENCY} · 첫 실행 ${Math.round(FIRST_DELAY_MS / 1000)}초 후${vmSeriesPushEnabled() ? ' · 중앙 push 켜짐' : ''}`);
}

/** 위임(엣지)이 아닌 중앙에서 push 로 받은 vCenter 도 prune 대상에 들어가도록 usage 를 쓴다 — 별도 export 없음. */
export const _internal = { deadlineMs, pool };
