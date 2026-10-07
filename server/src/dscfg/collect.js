// 데이터스토어 운영 속성 갱신(v2.700 — A17). 인벤토리 수집 한 주기 안에서 오래된 DS 부터 상한만큼.
// 캐시는 vmcfg 처럼 인메모리이고 DS 전용이다(다른 캐시의 prune 이 지우지 않게). 실패는 격리한다.
import { config } from '../config.js';
import { DS_CFG_PATHS, parseDsCfgProps } from './parse.js';

const _byVc = new Map();
const _status = new Map();
export const DS_CFG_BUDGET_MS = 10_000;

export function getDsCfg(vcId, ref) { return _byVc.get(vcId)?.get(ref) || null; }
export function dsCfgStatus() {
  const out = [];
  for (const [vcId, m] of _byVc) out.push({ vcenterId: vcId, datastores: m.size, ...(_status.get(vcId) || {}) });
  return { vcenters: out.slice(0, 64), omitted: Math.max(0, out.length - 64) };
}
/** v2.720(감사 S1-01): 그 vCenter 의 캐시를 통째로 버린다 — 삭제됐거나 접속처가 바뀌었다(hostcfg/cache.js syncVcConfigCaches). */
export function dropVcCache(vcId) { _byVc.delete(vcId); _status.delete(vcId); }
export function _resetDsCfg() { _byVc.clear(); _status.clear(); }

export async function refreshDsCfg(c, vcId, dsRefs, { now = Date.now(), budgetMs = DS_CFG_BUDGET_MS, settings = config } = {}) {
  if (!settings.dsCfgScan) return { skipped: 'off' };
  let m = _byVc.get(vcId);
  if (!m) { m = new Map(); _byVc.set(vcId, m); }
  const live = new Set(dsRefs);
  for (const k of m.keys()) if (!live.has(k)) m.delete(k);
  const st = _status.get(vcId) || {};
  if (st.backoffUntil > now) return { skipped: 'backoff' };
  const due = dsRefs.map((r) => [r, m.get(r)?.at || 0]).filter(([, at]) => !at || now - at >= settings.dsCfgRefreshMs)
    .sort((a, b) => a[1] - b[1]).slice(0, settings.dsCfgPerCycle).map((x) => x[0]);
  if (!due.length) return { due: 0 };
  const end = Date.now() + budgetMs;
  let fetched = 0; let cut = 0;
  try {
    for (let i = 0; i < due.length; i += 100) {
      if (Date.now() >= end) { cut = due.length - i; break; }
      for (const o of await c.retrieveManyObjectProps('Datastore', due.slice(i, i + 100), DS_CFG_PATHS, 100)) {
        m.set(o.ref, parseDsCfgProps(o.props, now)); fetched += 1;
      }
    }
    _status.set(vcId, { at: now, error: null, fetched, cut });
    return { due: due.length, fetched, cut };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 300);
    _status.set(vcId, { ...st, error: msg, errorAt: now, backoffUntil: /InvalidProperty|InvalidArgument/i.test(msg) ? now + settings.dsCfgRefreshMs : 0 });
    console.warn(`[dscfg] ${vcId} 데이터스토어 운영 속성 갱신 실패: ${msg}`);
    return { error: msg };
  }
}
