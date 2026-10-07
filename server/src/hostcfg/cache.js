// 호스트 구성 캐시(v2.699) — vCenter 별 · 호스트 moref 별. 인메모리(재시작하면 비고 몇 주기에 걸쳐 다시 찬다 —
// 그동안 host.hcfg 가 없으면 화면은 '아직 읽지 않음' 이라 말한다). VM 캐시(vmcfg/cache.js)와 나눈 이유:
// 그 캐시의 prune 은 VM ref 집합 기준이라 같은 저장소에 두면 호스트 항목이 매 주기 지워진다.
import { dropVcCache as dropVmCfg } from '../vmcfg/cache.js';
import { dropVcCache as dropContention } from '../contention/cache.js';
import { dropVcCache as dropDsCfg } from '../dscfg/collect.js';
import { dropVcCache as dropClusterCfg } from '../clustercfg/collect.js';
import { dropVcCache as dropTags } from '../tags/collect.js';
const _byVc = new Map();
const _status = new Map();
// v2.720(감사 R1-02): 요청 시한으로 계속 못 읽는 호스트 — vcId -> Map(ref -> { count, retryAt }).
//   예전(v2.719)에는 캐시에 넣지 않아 at=0 으로 매 주기 맨 먼저 다시 골라져 그 호스트의 시한(최대 30초)이 매 주기 수집을 붙잡았다.
//   이제 다시 고르기 전에 쉬고(10분 → 20분 → …, 갱신 주기 상한), HOST_FAIL_MAX 회 연속이면 호출자가 null 로 캐시한다(예전 동작).
const _fail = new Map();
export const HOST_RETRY_BASE_MS = 10 * 60_000;
export const HOST_FAIL_MAX = 3;

export function pickDue(vcId, refs, { now = Date.now(), periodMs, max }) {
  const m = _byVc.get(vcId);
  const f = _fail.get(vcId);
  const due = [];
  for (const ref of refs) {
    if ((f?.get(ref)?.retryAt || 0) > now) continue; // v2.720(R1-02): 쉬는 중인 호스트는 고르지 않는다
    const at = m?.get(ref)?.at || 0;
    if (!at || now - at >= periodMs) due.push([ref, at]);
  }
  due.sort((a, b) => a[1] - b[1]);
  return due.slice(0, Math.max(0, max)).map((x) => x[0]);
}
export function put(vcId, ref, value) {
  let m = _byVc.get(vcId);
  if (!m) { m = new Map(); _byVc.set(vcId, m); }
  m.set(ref, value);
  _fail.get(vcId)?.delete(ref); // 다 읽었다 — 연속 실패 기록을 지운다
}
/** v2.720(R1-02): 요청 시한 실패 1회 기록 — 다음 시도 시각을 정한다. @returns {{count:number, retryAt:number}} */
export function noteTransientFail(vcId, ref, { now = Date.now(), periodMs = 6 * 3_600_000 } = {}) {
  let f = _fail.get(vcId);
  if (!f) { f = new Map(); _fail.set(vcId, f); }
  const count = (f.get(ref)?.count || 0) + 1;
  const wait = Math.min(Math.max(HOST_RETRY_BASE_MS, Number(periodMs) || 0), HOST_RETRY_BASE_MS * 2 ** (count - 1));
  const rec = { count, retryAt: now + wait };
  f.set(ref, rec);
  return rec;
}
export function failOf(vcId, ref) { return _fail.get(vcId)?.get(ref) || null; }
export function get(vcId, ref) { return _byVc.get(vcId)?.get(ref) || null; }
export function prune(vcId, liveRefs) {
  const live = liveRefs instanceof Set ? liveRefs : new Set(liveRefs);
  const f = _fail.get(vcId);
  if (f) for (const ref of f.keys()) if (!live.has(ref)) f.delete(ref); // v2.720(R1-02): 사라진 호스트의 실패 기록도
  const m = _byVc.get(vcId);
  if (!m) return 0;
  let n = 0;
  for (const ref of m.keys()) if (!live.has(ref)) { m.delete(ref); n += 1; }
  return n;
}
export function setStatus(vcId, patch) { _status.set(vcId, { ...(_status.get(vcId) || {}), ...patch }); }
export function statusOf(vcId) { return _status.get(vcId) || null; }
function backoffOf(vcId) {
  const f = _fail.get(vcId);
  if (!f || !f.size) return { backoffHosts: 0, nextRetryAt: null };
  let next = null;
  for (const r of f.values()) if (next == null || r.retryAt < next) next = r.retryAt;
  return { backoffHosts: f.size, nextRetryAt: next };
}
export function hostCfgStatus() {
  const vcenters = [];
  // v2.720(R1-02): 시한으로 쉬는 호스트 수·다음 시도 시각을 함께 싣는다(조용히 쉬지 않는다).
  for (const [vcId, m] of _byVc) vcenters.push({ vcenterId: vcId, hosts: m.size, ...(_status.get(vcId) || {}), ...backoffOf(vcId) });
  for (const [vcId, st] of _status) if (!_byVc.has(vcId)) vcenters.push({ vcenterId: vcId, hosts: 0, ...st, ...backoffOf(vcId) });
  return { vcenters: vcenters.slice(0, 64), omitted: Math.max(0, vcenters.length - 64) };
}
/** v2.720(감사 S1-01): 이 캐시의 그 vCenter 항목을 통째로 버린다 — 6종을 함께 버리는 것은 아래 syncVcConfigCaches. */
export function dropVcCache(vcId) { _byVc.delete(vcId); _status.delete(vcId); _fail.delete(vcId); }

// v2.720(감사 S1-01): vCenter 단위 구성 캐시 6종(호스트·VM 구성·경합·DS·클러스터·태그)은 키가 (vcId, moref) 뿐이다.
//   등록 id 를 그대로 두고 접속처(host)만 바꾸면 새 vCenter 의 같은 moref(host-10·vm-101)에 옛 vCenter 값이 갱신 주기(최대 6시간)
//   동안 붙고(오류 없이 틀린 값), 삭제된 vCenter 의 항목은 재시작까지 남아 상태 표에 유령으로 나왔다.
//   store.refresh 가 매 주기 등록부를 넘기면 여기서 둘 다 정리한다(updateSession.js accessKey 와 같은 판단 — 주소만 본다:
//   계정만 바뀐 것은 같은 vCenter 다).
const _accessByVc = new Map(); // vcId -> 접속처 키
const accessKeyOf = (vc) => String(vc?.host ?? '').trim().toLowerCase();
const CACHE_DROPPERS = [
  dropVcCache, dropVmCfg, dropContention, dropDsCfg, dropClusterCfg, dropTags,
];
export function dropVcConfigCaches(vcId) { for (const d of CACHE_DROPPERS) d(vcId); }
/** @param {Array<{id:string, host?:string}>} vcenters 등록부 전체 @returns {{dropped:string[]}} */
export function syncVcConfigCaches(vcenters) {
  const list = Array.isArray(vcenters) ? vcenters : [];
  const live = new Map();
  for (const vc of list) if (vc && vc.id != null) live.set(String(vc.id), accessKeyOf(vc));
  const dropped = [];
  const known = new Set([..._accessByVc.keys(), ..._byVc.keys(), ..._status.keys()]);
  for (const id of known) if (!live.has(id)) { dropVcConfigCaches(id); _accessByVc.delete(id); dropped.push(id); }
  for (const [id, key] of live) {
    const prev = _accessByVc.get(id);
    if (prev != null && prev !== key) { dropVcConfigCaches(id); dropped.push(id); }
    _accessByVc.set(id, key);
  }
  return { dropped };
}
export function _resetHostCfgCache() { _byVc.clear(); _status.clear(); _fail.clear(); _accessByVc.clear(); }
