// 데이터스토어 운영 속성 갱신(v2.700 — A17). 인벤토리 수집 한 주기 안에서 오래된 DS 부터 상한만큼.
// 캐시는 vmcfg 처럼 인메모리이고 DS 전용이다(다른 캐시의 prune 이 지우지 않게). 실패는 격리한다.
import { config } from '../config.js';
import { DS_CFG_PATHS, parseDsCfgProps } from './parse.js';

const _byVc = new Map();
const _status = new Map();
export const DS_CFG_BUDGET_MS = 10_000;

// v2.721(감사 S1-03): 부가 갱신(DS·클러스터·VM 구성·경합)의 대상별 재시도 백오프 — hostcfg/cache.js noteTransientFail 과 같은 규칙.
//   요청 시한에 걸린 대상은 put 되지 않아 at=0 으로 남고, 다음 주기에 맨 먼저 다시 골라져 매 주기 최대 요청 시한(30초)을 먹었다.
//   이제 10분 → 20분 → …(갱신 주기 상한)을 쉬었다가 다시 묻는다. 수집 중단(abort)은 그 대상 탓이 아니라 세지 않고, 읽으면 지운다.
//   ⚠ 여기 둔 이유: hostcfg/cache.js 가 이 모듈들(dscfg·clustercfg)의 dropVcCache 를 import 하므로 hostcfg 쪽에서 가져오면 순환이 된다.
export const AUX_RETRY_BASE_MS = 10 * 60_000;
/** 요청 시한 실패인가(수집 중단은 아니다) — hostcfg/collect.js isTimeoutErr 와 같은 판정. signal 은 수집 신호(없으면 클라이언트 신호). */
export function isRequestTimeout(err, signal = null) {
  if (signal?.aborted) return false;
  if (err?.name === 'TimeoutError') return true;
  if (err?.name === 'AbortError') return false;
  return /timed? ?out|timeout|데드라인|시한/i.test(String(err?.message || err || ''));
}
/** vcId -> Map(ref -> {count, retryAt}) 재시도 기록. */
export function createRetryTracker() {
  const byVc = new Map();
  return {
    resting(vcId, ref, now) { return (byVc.get(vcId)?.get(ref)?.retryAt || 0) > now; },
    note(vcId, refs, { now = Date.now(), periodMs } = {}) {
      let f = byVc.get(vcId);
      if (!f) { f = new Map(); byVc.set(vcId, f); }
      for (const ref of refs) {
        const count = (f.get(ref)?.count || 0) + 1;
        const wait = Math.min(Math.max(AUX_RETRY_BASE_MS, Number(periodMs) || 0), AUX_RETRY_BASE_MS * 2 ** Math.min(30, count - 1));
        f.set(ref, { count, retryAt: now + wait });
      }
      return refs.length;
    },
    clear(vcId, ref) { byVc.get(vcId)?.delete(ref); },
    prune(vcId, live) { const f = byVc.get(vcId); if (f) for (const ref of f.keys()) if (!live.has(ref)) f.delete(ref); },
    drop(vcId) { byVc.delete(vcId); },
    get(vcId, ref) { return byVc.get(vcId)?.get(ref) || null; },
    /** 상태에 싣는다 — 쉬는 대상 수·가장 이른 다음 시도 시각(조용히 쉬지 않는다). */
    summary(vcId) {
      const f = byVc.get(vcId);
      if (!f || !f.size) return { backoffTargets: 0, nextRetryAt: null };
      let next = null;
      for (const r of f.values()) if (next == null || r.retryAt < next) next = r.retryAt;
      return { backoffTargets: f.size, nextRetryAt: next };
    },
    reset() { byVc.clear(); },
  };
}
const _retry = createRetryTracker();
export function dsCfgRetryOf(vcId, ref) { return _retry.get(vcId, ref); }

export function getDsCfg(vcId, ref) { return _byVc.get(vcId)?.get(ref) || null; }
export function dsCfgStatus() {
  const out = [];
  for (const [vcId, m] of _byVc) out.push({ vcenterId: vcId, datastores: m.size, ...(_status.get(vcId) || {}), ..._retry.summary(vcId) });
  return { vcenters: out.slice(0, 64), omitted: Math.max(0, out.length - 64) };
}
/** v2.720(감사 S1-01): 그 vCenter 의 캐시를 통째로 버린다 — 삭제됐거나 접속처가 바뀌었다(hostcfg/cache.js syncVcConfigCaches). */
export function dropVcCache(vcId) { _byVc.delete(vcId); _status.delete(vcId); _retry.drop(vcId); }
export function _resetDsCfg() { _byVc.clear(); _status.clear(); _retry.reset(); }

export async function refreshDsCfg(c, vcId, dsRefs, { now = Date.now(), budgetMs = DS_CFG_BUDGET_MS, settings = config } = {}) {
  if (!settings.dsCfgScan) return { skipped: 'off' };
  let m = _byVc.get(vcId);
  if (!m) { m = new Map(); _byVc.set(vcId, m); }
  const live = new Set(dsRefs);
  for (const k of m.keys()) if (!live.has(k)) m.delete(k);
  _retry.prune(vcId, live);
  const st = _status.get(vcId) || {};
  if (st.backoffUntil > now) return { skipped: 'backoff' };
  const due = dsRefs.filter((r) => !_retry.resting(vcId, r, now)).map((r) => [r, m.get(r)?.at || 0]).filter(([, at]) => !at || now - at >= settings.dsCfgRefreshMs)
    .sort((a, b) => a[1] - b[1]).slice(0, settings.dsCfgPerCycle).map((x) => x[0]);
  if (!due.length) return { due: 0 };
  const end = Date.now() + budgetMs;
  let fetched = 0; let cut = 0; let slice = [];
  try {
    for (let i = 0; i < due.length; i += 100) {
      if (Date.now() >= end) { cut = due.length - i; break; }
      slice = due.slice(i, i + 100);
      for (const o of await c.retrieveManyObjectProps('Datastore', slice, DS_CFG_PATHS, 100)) {
        m.set(o.ref, parseDsCfgProps(o.props, now)); fetched += 1; _retry.clear(vcId, o.ref);
      }
    }
    _status.set(vcId, { at: now, error: null, fetched, cut, ..._retry.summary(vcId) });
    return { due: due.length, fetched, cut };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 300);
    // v2.721(감사 S1-03): 그 조각이 요청 시한에 걸렸으면 그 DS 들만 쉰다(나머지 DS 는 다음 주기에 그대로 읽힌다).
    const rested = isRequestTimeout(err, c?.signal) ? _retry.note(vcId, slice, { now, periodMs: settings.dsCfgRefreshMs }) : 0;
    _status.set(vcId, { ...st, error: msg, errorAt: now, backoffUntil: /InvalidProperty|InvalidArgument/i.test(msg) ? now + settings.dsCfgRefreshMs : 0, rested, ..._retry.summary(vcId) });
    console.warn(`[dscfg] ${vcId} 데이터스토어 운영 속성 갱신 실패: ${msg}`);
    return { error: msg };
  }
}
