// ESXi 경로 카운터 갱신(v2.929 C-①) — 인벤토리 수집 한 주기 안에서 '오래된 호스트부터 상한만큼' 실시간 통계 최근 창을 읽는다.
// contention/collect.js 와 같은 틀: 시간 예산을 넘기면 다음 묶음을 시작하지 않고, 실패는 격리한다(인벤토리 수집은 성공 · 직전 캐시 값은 그대로).
// 기본 주기 1시간 · 표본 15(5분) — 경로 계열이 많아 응답이 크다(storpath/parse.js 머리말). 호스트 묶음은 작게(HOST_CHUNK).
import { config } from '../config.js';
import { STORPATH_COUNTERS, summarizeHostPaths, rtMapOf, hbaByWwnOf } from './parse.js';
import { pickDue, put, prune, setStatus, statusOf } from './cache.js';
import { parsePerfInstances } from '../contention/parse.js';
import { resolveIds, perfQueryBody } from '../contention/collect.js';
import { createRetryTracker, isRequestTimeout } from '../dscfg/collect.js';

export const STORPATH_BUDGET_MS = 10_000;
export const HOST_CHUNK = 4;
const _retry = createRetryTracker();
export function storPathRetryOf(vcId, ref) { return _retry.get(vcId, ref); }
export function dropVcRetry(vcId) { _retry.drop(vcId); }
export function _resetStorPathRetry() { _retry.reset(); }

/** FC HBA(WWN 이 있는 어댑터)가 있는 호스트만 — iSCSI·로컬 디스크만 쓰는 호스트에 경로 계열을 묻지 않는다. */
export function hasFcHba(host) {
  return (Array.isArray(host?.hbas) ? host.hbas : []).some((h) => /^[0-9a-f]{2}(:[0-9a-f]{2}){7}$/i.test(String(h?.wwn || '')));
}

/**
 * @param c        로그인된 SOAP 클라이언트(perfCounterMap · callRaw · sc.perfManager)
 * @param vcId
 * @param opts.hosts [{ ref, host }] 연결된 FC 호스트(host = 인벤토리 객체 — hbas · hcfg.mp.targets 로 경로 이름을 푼다)
 */
export async function refreshStorPath(c, vcId, { hosts = [], now = Date.now(), budgetMs = STORPATH_BUDGET_MS, settings = config, signal = null } = {}) {
  if (!settings.storPathScan) return { skipped: 'off' };
  const live = new Set(hosts.map((h) => h.ref));
  prune(vcId, live);
  _retry.prune(vcId, live);
  const st = statusOf(vcId) || {};
  if (st.backoffUntil > now) return { skipped: 'backoff' };
  if (!c?.sc?.perfManager) return { skipped: 'no-perf-manager' };
  const periodMs = settings.storPathRefreshMs;
  const samples = settings.storPathSamples;
  const byRef = new Map(hosts.map((h) => [h.ref, h.host]));
  const due = pickDue(vcId, hosts.map((h) => h.ref).filter((r) => !_retry.resting(vcId, r, now)), { now, periodMs, max: settings.storPathPerCycle });
  if (!due.length) return { due: 0 };
  const budgetEnd = Date.now() + budgetMs;
  try {
    const map = await c.perfCounterMap();
    const { ids, missing } = resolveIds(map, STORPATH_COUNTERS);
    if (!ids.read && !ids.write) {
      setStatus(vcId, { at: now, error: null, fetched: 0, cut: 0, missingCounters: missing, samples, unparsed: 0 });
      return { fetched: 0, missing };
    }
    const metrics = ['read', 'write', 'latR', 'latW'].filter((k) => ids[k]).map((k) => ({ id: ids[k], instance: '*' }));
    let fetched = 0; let cut = 0; let rested = 0; let unparsed = 0; let instances = 0; const chunkErrors = [];
    for (let i = 0; i < due.length; i += HOST_CHUNK) {
      if (signal?.aborted || Date.now() >= budgetEnd) { cut += due.length - i; break; }
      const slice = due.slice(i, i + HOST_CHUNK);
      try {
        const xml = await c.callRaw(perfQueryBody(c.sc.perfManager, 'HostSystem', slice, metrics, samples));
        const parsed = parsePerfInstances(xml, 'HostSystem');
        for (const ref of slice) {
          const h = byRef.get(ref);
          const sum = summarizeHostPaths(parsed.get(ref) || new Map(), ids, { rtMap: rtMapOf(h), hbaByWwn: hbaByWwnOf(h), at: now, samples });
          put(vcId, ref, sum);
          _retry.clear(vcId, ref);
          fetched += 1; unparsed += sum.unparsed; instances += sum.instances;
        }
      } catch (err) {
        chunkErrors.push(String(err?.message || err).slice(0, 200));
        if (isRequestTimeout(err, signal || c?.signal)) rested += _retry.note(vcId, slice, { now, periodMs });
      }
    }
    setStatus(vcId, { at: now, error: chunkErrors[0] || null, errors: chunkErrors.length, fetched, cut, rested, missingCounters: missing, samples, unparsed, instances,
      backoffHosts: _retry.summary(vcId).backoffTargets });
    if (chunkErrors.length) console.warn(`[storpath] ${vcId} 경로 카운터 묶음 ${chunkErrors.length}개 실패: ${chunkErrors[0]}`);
    if (fetched && instances && unparsed === instances) console.warn(`[storpath] ${vcId} 경로 인스턴스 ${instances}개를 하나도 타깃 WWN 으로 풀지 못했습니다(이름 형식 미확인 — 귀속은 IPF 로 갑니다)`);
    return { fetched, cut, missing, errors: chunkErrors.length, unparsed };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 300);
    setStatus(vcId, { error: msg, errorAt: now, backoffUntil: signal?.aborted ? 0 : now + Math.min(periodMs, 3_600_000) });
    console.warn(`[storpath] ${vcId} 경로 카운터 갱신 실패: ${msg}`);
    return { error: msg };
  }
}
