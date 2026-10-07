// 클러스터 HA·DRS 구성 갱신(v2.701 — A6). 인벤토리 수집 한 주기 안에서 오래된 클러스터부터 상한만큼.
// 캐시는 인메모리이고 클러스터 전용이다(다른 캐시의 prune 이 지우지 않게). 실패는 격리한다(인벤토리 수집은 성공).
// configurationEx 는 VM 별 재정의(dasVmConfig·drsVmConfig)를 함께 실어 큰 클러스터에서 응답이 커진다 — 5개씩 나눠 읽는다.
import { config } from '../config.js';
import { CLUSTER_CFG_PATHS, parseClusterCfgProps } from './parse.js';
import { createRetryTracker, isRequestTimeout } from '../dscfg/collect.js'; // v2.721(감사 S1-03) — 대상별 재시도 백오프(한 벌)

const _byVc = new Map();
const _status = new Map();
export const CLUSTER_CFG_BUDGET_MS = 10_000;
const CHUNK = 5;
// v2.721(감사 S1-03): 요청 시한에 걸린 클러스터는 쉬었다가 다시 묻는다 — 예전에는 InvalidProperty 가 아니면 backoffUntil 0 이라
//   같은 클러스터를 매 주기 맨 먼저 다시 골라 매 주기 요청 시한(최대 30초)을 먹었다. 수집 중단(abort)은 세지 않는다.
const _retry = createRetryTracker();
export function clusterCfgRetryOf(vcId, ref) { return _retry.get(vcId, ref); }

export function getClusterCfg(vcId, ref) { return _byVc.get(vcId)?.get(ref) || null; }
export function clusterCfgStatus() {
  const out = [];
  for (const [vcId, m] of _byVc) out.push({ vcenterId: vcId, clusters: m.size, ...(_status.get(vcId) || {}), ..._retry.summary(vcId) });
  return { vcenters: out.slice(0, 64), omitted: Math.max(0, out.length - 64) };
}
/** v2.720(감사 S1-01): 그 vCenter 의 캐시를 통째로 버린다 — 삭제됐거나 접속처가 바뀌었다(hostcfg/cache.js syncVcConfigCaches). */
export function dropVcCache(vcId) { _byVc.delete(vcId); _status.delete(vcId); _retry.drop(vcId); }
export function _resetClusterCfg() { _byVc.clear(); _status.clear(); _retry.reset(); }

export async function refreshClusterCfg(c, vcId, clusterRefs, { now = Date.now(), budgetMs = CLUSTER_CFG_BUDGET_MS, settings = config } = {}) {
  if (!settings.clusterCfgScan) return { skipped: 'off' };
  let m = _byVc.get(vcId);
  if (!m) { m = new Map(); _byVc.set(vcId, m); }
  const live = new Set(clusterRefs);
  for (const k of m.keys()) if (!live.has(k)) m.delete(k);
  _retry.prune(vcId, live);
  const st = _status.get(vcId) || {};
  if (st.backoffUntil > now) return { skipped: 'backoff' };
  const due = clusterRefs.filter((r) => !_retry.resting(vcId, r, now)).map((r) => [r, m.get(r)?.at || 0]).filter(([, at]) => !at || now - at >= settings.clusterCfgRefreshMs)
    .sort((a, b) => a[1] - b[1]).slice(0, settings.clusterCfgPerCycle).map((x) => x[0]);
  if (!due.length) return { due: 0 };
  const end = Date.now() + budgetMs;
  let fetched = 0; let cut = 0; let slice = [];
  try {
    for (let i = 0; i < due.length; i += CHUNK) {
      if (Date.now() >= end) { cut = due.length - i; break; }
      slice = due.slice(i, i + CHUNK);
      for (const o of await c.retrieveManyObjectProps('ClusterComputeResource', slice, CLUSTER_CFG_PATHS, CHUNK)) {
        m.set(o.ref, parseClusterCfgProps(o.ref, o.props, now)); fetched += 1; _retry.clear(vcId, o.ref);
      }
    }
    _status.set(vcId, { at: now, error: null, fetched, cut, ..._retry.summary(vcId) });
    return { due: due.length, fetched, cut };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 300);
    // v2.721(감사 S1-03): 그 조각(5개)만 쉰다 — 나머지 클러스터는 다음 주기에 그대로 읽힌다.
    const rested = isRequestTimeout(err, c?.signal) ? _retry.note(vcId, slice, { now, periodMs: settings.clusterCfgRefreshMs }) : 0;
    _status.set(vcId, { ...st, error: msg, errorAt: now, backoffUntil: /InvalidProperty|InvalidArgument/i.test(msg) ? now + settings.clusterCfgRefreshMs : 0, rested, ..._retry.summary(vcId) });
    console.warn(`[clustercfg] ${vcId} 클러스터 HA·DRS 구성 갱신 실패: ${msg}`);
    return { error: msg };
  }
}
