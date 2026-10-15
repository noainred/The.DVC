/**
 * isidu/collectRequests.js — 엣지가 조사하는 아이실론 대상의 '지금 수집' 요청 큐(v2.736). 코어는 util/collectRequestQueue.js(claim→ack).
 * 중앙은 엣지에 명령을 밀어넣을 수 없다(pull 구조) — 요청을 큐에 두고 엣지가 `/api/central/isidu-config` 로 인출한다.
 * 완료는 그 대상의 **새 스캔**(엣지 시각이 인출 때 기준선보다 새 값)이 push 로 도착했을 때다.
 * 결과 시한 = 대상 시한(최대 180분 — v2.739 · 인출 시점 설정의 가장 긴 값) + 여유 — du 는 오래 걸린다.
 */
import { createCollectRequestQueue } from '../util/collectRequestQueue.js';
import { loadSettings, timeoutMsOf } from './settings.js';

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
export function _resetForTest() { Q._reset(); }
