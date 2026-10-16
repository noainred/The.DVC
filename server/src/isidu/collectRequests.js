/**
 * isidu/collectRequests.js — 엣지가 조사하는 아이실론 대상의 '지금 수집' 요청 큐(v2.736). 코어는 util/collectRequestQueue.js(claim→ack).
 * 중앙은 엣지에 명령을 밀어넣을 수 없다(pull 구조) — 요청을 큐에 두고 엣지가 `/api/central/isidu-config` 로 인출한다.
 * 완료는 그 대상의 **새 스캔**(엣지 시각이 인출 때 기준선보다 새 값)이 push 로 도착했을 때다.
 * 결과 시한 = 대상 시한(최대 180분 — v2.739 · 인출 시점 설정의 가장 긴 값) + 여유 — du 는 오래 걸린다.
 * v2.743(감사 LEFT-08): 엣지가 받은 요청을 **시작하지 않고 버리면**(동시 실행 대기 6시간 초과 등) push 상태의 `runDropped` 로 알려 오고,
 *   중앙은 그 요청을 결과 시한(5건 × 121분 + 10분 ≈ 10시간)까지 기다리지 않고 그 사유로 폐기한다(`applyIsiduEdgeDrops`). 구버전 엣지는
 *   그 필드가 없다 — 예전처럼 시한이 지나야 'no-result' 로 정리된다.
 */
import { createCollectRequestQueue } from '../util/collectRequestQueue.js';
import { loadSettings, timeoutMsOf } from './settings.js';
import { numOrNull } from '../util/numOrNull.js';

/**
 * 엣지가 알리는 '시작하지 않고 버린 요청' 사유 — 엣지(isidu/poller.js · util/scanJournal.js)가 내는 코드와 같고,
 * 웹 collectDropText.js EDGE_DROP_TEXT 와 1:1(server/test/audit2743i 가 대조한다). 모르는 코드는 'edge-other' 로 받는다.
 *  · queue-hold   — 엣지의 동시 실행 대기가 대기 시한(6시간)을 넘었다(재시작 전 대기 요청이 시한을 넘긴 것 포함)
 *  · target-gone  — 기다리는 동안 대상이 그 엣지의 목록에서 빠졌다
 *  · not-here     — 요청을 받았을 때 그 엣지의 대상 사본에 그 대상이 없다
 *  · not-restored — 엣지가 재시작하며 대기 요청을 다시 넣지 않았다(SCAN_RESUME=0)
 */
export const EDGE_DROP_REASONS = Object.freeze(['queue-hold', 'target-gone', 'not-here', 'not-restored', 'edge-other']);
const EDGE_DROPS_MAX = 50;      // 한 보고에서 읽는 개수(엣지 상한과 같다)
const EDGE_HELD_MAX = 200;

export const TAKE_MAX = 5;
let _baseOf = null;
/** 수신 모듈이 등록한다 — targetId → 중앙이 받은 마지막 엣지 스캔 시각. */
export function setIsiduBaseResolver(fn) { _baseOf = typeof fn === 'function' ? fn : null; }
/** 대상 하나의 결과 시한 — 설정 중 가장 긴 명령 시한(인출 시점 값 — 설정에서 늘린 시한이 바로 먹게, v2.611 TIM2611-02 규약). */
export function perItemMs() {
  let max = 30 * 60_000;
  try { for (const x of loadSettings().targets) max = Math.max(max, timeoutMsOf(x)); } catch { /* 설정을 못 읽으면 기본 */ }
  return max + 60_000;
}
const Q = createCollectRequestQueue({ ttlMs: 30 * 60_000, ackMs: 10 * 60_000, perItemMs, baseOf: (id) => (_baseOf ? _baseOf(id) : null) });

export function requestIsiduCollect(targetId, agent) { const r = Q.request(targetId, agent); return { pending: r.pending, duplicate: r.duplicate }; }
export function takeIsiduRequests(agent) { return Q.take(agent, Date.now(), TAKE_MAX); }
export function ackIsiduCollect(targetId, ts = null) { return Q.ack(targetId, ts); }
export function isiduRequestState(targetId) { return Q.state(targetId); }
export function recentIsiduDrops() { return Q.drops(); }

/**
 * v2.743(LEFT-08): 엣지 push 상태의 버린 요청을 큐에 반영한다. 아는 필드만 읽고(id·reason·ageMs) 개수를 자른다.
 *  · 그 엣지(agent — 인증된 이름)가 가져간 요청만 · 엣지가 지금 돌리거나 기다리는 대상(runHeld)은 건드리지 않는다(버린 뒤 다시 받았다).
 *  · ageMs(엣지 시계의 길이)를 받은 시각에서 빼어 '버린 시각' 을 어림하고, 그 뒤에 다시 인출한 요청은 건드리지 않는다(두 시계를 비교하지 않는다).
 * @returns {null|{reported:number, applied:number, omitted?:number}} 필드가 없으면 null(구버전 엣지 — 예전처럼 시한으로 정리)
 */
export function applyIsiduEdgeDrops(agent, status, now = Date.now()) {
  const raw = status && typeof status === 'object' && !Array.isArray(status) ? status.runDropped : null;
  if (!Array.isArray(raw)) return null;
  const heldRaw = Array.isArray(status.runHeld) ? status.runHeld.slice(0, EDGE_HELD_MAX) : [];
  const held = new Set(heldRaw.filter((x) => typeof x === 'string' && x).map((x) => x.slice(0, 64)));
  const list = raw.slice(0, EDGE_DROPS_MAX);
  let applied = 0;
  for (const d of list) {
    if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id) continue;
    const id = d.id.slice(0, 64);
    if (held.has(id)) continue;
    const reason = typeof d.reason === 'string' && EDGE_DROP_REASONS.includes(d.reason) ? d.reason : 'edge-other';
    const age = numOrNull(d.ageMs);
    const before = age != null && age >= 0 ? now - age : now;
    if (Q.dropTaken(id, agent, reason, { before }, now)) applied++;
  }
  return { reported: list.length, applied, ...(raw.length > list.length ? { omitted: raw.length - list.length } : {}) };
}
export function _resetForTest() { Q._reset(); }
