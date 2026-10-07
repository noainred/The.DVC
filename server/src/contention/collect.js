// CPU 경합·디스크 지연 갱신(v2.706 C2·C3) — 인벤토리 수집 한 주기 안에서 '오래된 것부터 상한만큼' 실시간 통계를 다시 읽는다.
// 시간 예산(기본 15초)을 넘기면 다음 묶음을 시작하지 않는다(시작해 놓고 잘리면 버려진다 — v2.528 판단).
// 실패는 격리한다 — 이 갱신이 실패해도 인벤토리 수집은 성공이고, 직전 캐시 값은 그대로(at 으로 낡음이 보인다).
import { config } from '../config.js';
import { VM_COUNTERS, HOST_COUNTERS, REALTIME_INTERVAL, parsePerfInstances, summarizeVm, summarizeHost } from './parse.js';
import { pickDue, put, prune, setStatus, statusOf } from './cache.js';
import { createRetryTracker, isRequestTimeout } from '../dscfg/collect.js'; // v2.721(감사 S1-03) — 대상별 재시도 백오프(한 벌)

export const CONTENTION_BUDGET_MS = 15_000;
const VM_CHUNK = 50;
const HOST_CHUNK = 25;
// v2.721(감사 S1-03): 요청 시한에 걸린 묶음의 VM·호스트는 쉬었다가 다시 묻는다 — 예전에는 묶음 실패가 put 되지 않아
//   at=0 으로 남고 매 주기 맨 먼저 다시 골라져 매 주기 요청 시한(최대 30초)을 먹었다. 수집 중단(abort)은 세지 않는다.
const _retry = { vm: createRetryTracker(), host: createRetryTracker() };
export function contentionRetryOf(vcId, kind, ref) { return _retry[kind]?.get(vcId, ref) || null; }
/** vCenter 삭제·접속처 변경 때 함께 버린다(hostcfg/cache.js syncVcConfigCaches 에 연결할 것). */
export function dropVcRetry(vcId) { _retry.vm.drop(vcId); _retry.host.drop(vcId); }
export function _resetContentionRetry() { _retry.vm.reset(); _retry.host.reset(); }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 카운터 키 → id(그 vCenter 카탈로그). 없는 키는 빠지고 missing 에 남는다. */
export function resolveIds(map, spec) {
  const ids = {}; const missing = [];
  for (const [k, key] of Object.entries(spec)) { const id = map?.get?.(key); if (id) ids[k] = String(id); else missing.push(key); }
  return { ids, missing };
}

/** QueryPerf 요청 본문 — 엔티티마다 querySpec. metric 은 [{id, instance}]. */
export function perfQueryBody(perfManager, entityType, refs, metrics, samples) {
  const mids = metrics.map((m) => `<metricId><counterId>${esc(m.id)}</counterId><instance>${esc(m.instance)}</instance></metricId>`).join('');
  const specs = refs.map((ref) => `<querySpec><entity type="${entityType}">${esc(ref)}</entity><maxSample>${samples}</maxSample>${mids}<intervalId>${REALTIME_INTERVAL}</intervalId></querySpec>`).join('');
  return `<QueryPerf xmlns="urn:vim25"><_this type="PerformanceManager">${esc(perfManager)}</_this>${specs}</QueryPerf>`;
}

/**
 * @param c        로그인된 SOAP 클라이언트(perfCounterMap·callRaw·sc.perfManager)
 * @param vcId
 * @param opts.vms   [{ref, numCpu}] 켜진 VM · opts.hostRefs 연결된 호스트
 */
export async function refreshContention(c, vcId, { vms = [], hostRefs = [], now = Date.now(), budgetMs = CONTENTION_BUDGET_MS, settings = config, signal = null } = {}) {
  if (!settings.contentionScan) return { skipped: 'off' };
  // 꺼진 VM·끊긴 호스트의 옛 값은 버린다 — 그 값을 '지금' 경합처럼 보이면 거짓이다.
  const liveVm = new Set(vms.map((v) => v.ref)); const liveHost = new Set(hostRefs);
  prune(vcId, 'vm', liveVm);
  prune(vcId, 'host', liveHost);
  _retry.vm.prune(vcId, liveVm); _retry.host.prune(vcId, liveHost);
  const st = statusOf(vcId) || {};
  if (st.backoffUntil > now) return { skipped: 'backoff' };
  if (!c?.sc?.perfManager) return { skipped: 'no-perf-manager' };
  const periodMs = settings.contentionRefreshMs;
  const samples = settings.contentionSamples;
  const dueVm = pickDue(vcId, vms.map((v) => v.ref).filter((r) => !_retry.vm.resting(vcId, r, now)), 'vm', { now, periodMs, max: settings.contentionPerCycle });
  const dueHost = pickDue(vcId, hostRefs.filter((r) => !_retry.host.resting(vcId, r, now)), 'host', { now, periodMs, max: Math.max(1, Math.ceil(settings.contentionPerCycle / 8)) });
  if (!dueVm.length && !dueHost.length) return { due: 0 };
  const budgetEnd = Date.now() + budgetMs;
  try {
    const map = await c.perfCounterMap();
    const v = resolveIds(map, VM_COUNTERS);
    const h = resolveIds(map, HOST_COUNTERS);
    const cpuOf = new Map(vms.map((x) => [x.ref, x.numCpu]));
    const vmMetrics = [
      ...['ready', 'costop', 'latency'].filter((k) => v.ids[k]).map((k) => ({ id: v.ids[k], instance: '' })),
      ...['read', 'write'].filter((k) => v.ids[k]).map((k) => ({ id: v.ids[k], instance: '*' })),
    ];
    const hostMetrics = [
      ...(h.ids.diskMax ? [{ id: h.ids.diskMax, instance: '' }] : []),
      ...['dsRead', 'dsWrite'].filter((k) => h.ids[k]).map((k) => ({ id: h.ids[k], instance: '*' })),
    ];
    let vmFetched = 0; let hostFetched = 0; let cut = 0; const chunkErrors = [];
    let rested = 0;
    const run = async (refs, chunk, entityType, metrics, onEach, tracker) => {
      if (!metrics.length) return;
      for (let i = 0; i < refs.length; i += chunk) {
        if (signal?.aborted || Date.now() >= budgetEnd) { cut += refs.length - i; return; }
        const slice = refs.slice(i, i + chunk);
        try {
          const xml = await c.callRaw(perfQueryBody(c.sc.perfManager, entityType, slice, metrics, samples));
          const byRef = parsePerfInstances(xml, entityType);
          // 응답에 없는 ref 도 '측정했는데 표본 없음' 으로 기록한다(빈 요약 — 다음 주기까지 다시 묻지 않는다).
          for (const ref of slice) { onEach(ref, byRef.get(ref) || new Map()); tracker.clear(vcId, ref); }
        } catch (err) {
          chunkErrors.push(String(err?.message || err).slice(0, 200));
          // v2.721(S1-03): 그 묶음이 요청 시한에 걸렸으면 그 묶음만 쉰다(수집 중단은 세지 않는다).
          if (isRequestTimeout(err, signal || c?.signal)) rested += tracker.note(vcId, slice, { now, periodMs });
        }
      }
    };
    await run(dueVm, VM_CHUNK, 'VirtualMachine', vmMetrics, (ref, byC) => { put(vcId, 'vm', ref, summarizeVm(byC, v.ids, cpuOf.get(ref), now)); vmFetched += 1; }, _retry.vm);
    await run(dueHost, HOST_CHUNK, 'HostSystem', hostMetrics, (ref, byC) => { put(vcId, 'host', ref, summarizeHost(byC, h.ids, now)); hostFetched += 1; }, _retry.host);
    const missing = [...v.missing, ...h.missing];
    setStatus(vcId, { at: now, error: chunkErrors[0] || null, errors: chunkErrors.length, vmFetched, hostFetched, cut, missingCounters: missing, samples,
      rested, backoffVms: _retry.vm.summary(vcId).backoffTargets, backoffHosts: _retry.host.summary(vcId).backoffTargets });
    if (chunkErrors.length) console.warn(`[contention] ${vcId} 실시간 통계 묶음 ${chunkErrors.length}개 실패: ${chunkErrors[0]}`);
    return { vmFetched, hostFetched, cut, missing, errors: chunkErrors.length };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 300);
    // v2.719(감사 S1-01): 수집 중단(데드라인)은 이 갱신의 실패가 아니다 — 쉬지 않고 다음 주기에 다시 시도한다.
    setStatus(vcId, { error: msg, errorAt: now, backoffUntil: signal?.aborted ? 0 : now + Math.min(periodMs, 3_600_000) });
    console.warn(`[contention] ${vcId} CPU 경합·디스크 지연 갱신 실패: ${msg}`);
    return { error: msg };
  }
}
