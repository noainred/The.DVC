/**
 * cvp/collectRequests.js — 엣지 위임 CVP 의 '지금 수집' 요청 큐(v2.608). 코어는 util/collectRequestQueue.js(claim→ack — v2.590 P16·v2.591).
 * 중앙은 엣지에 명령을 밀어넣을 수 없다(pull 구조) — 요청을 큐에 두고 엣지가 `/api/central/cvp-config` 로 인출한다.
 * 완료는 그 CVP 의 **새 수집 결과**(상태의 collectedAt 이 인출 때 기준선보다 새 값)가 push 로 도착했을 때다.
 */
import { createCollectRequestQueue } from '../util/collectRequestQueue.js';
import { reqTimeoutMs } from '../agent/envTimeout.js';
import { loadSettings } from './settings.js';

export const TAKE_MAX = 10;
// 결과 시한 = 인출 대수 × CVP 한 대 시한(엣지 설정의 기본 deviceTimeoutMs 와 같은 축) + ackMs.
const PER_ITEM_MS = reqTimeoutMs(process.env.CVP_DEVICE_TIMEOUT_MS, 120_000, { min: 30_000, max: 30 * 60_000 });
/**
 * v2.611(TIM2611-02): 엣지가 실제로 쓰는 장비 시한은 **중앙 설정 deviceTimeoutMs**(설정 › CVP — 엣지가 cvp-config 로 받는다)다.
 *   env 로 굳히면 설정을 12분 넘게 올린 현장에서 정상 수집이 '결과 없이 폐기' 로 보였다. 인출 시점 설정값, 못 읽으면 env 폴백.
 */
export function perItemMs() {
  try { const v = Number(loadSettings().deviceTimeoutMs); if (Number.isFinite(v) && v > 0) return v; } catch { /* 폴백 */ }
  return PER_ITEM_MS;
}
let _baseOf = null;
/** 엣지 수신 모듈이 등록한다 — cvpId → 보관 중인 엣지 상태의 collectedAt(엣지 시계 값). 순환 import 를 피하려는 등록식. */
export function setCvpCollectBaseResolver(fn) { _baseOf = typeof fn === 'function' ? fn : null; }
const Q = createCollectRequestQueue({ ttlMs: 15 * 60_000, perItemMs, baseOf: (id) => (_baseOf ? _baseOf(id) : null) });

export function requestCvpCollect(cvpId, agent) { const r = Q.request(cvpId, agent); return { pending: r.pending, duplicate: r.duplicate }; }
export function takeCvpRequests(agent) { return Q.take(agent, Date.now(), TAKE_MAX); }
export function ackCvpCollect(cvpId, collectedAt = null) { return Q.ack(cvpId, collectedAt); }
export function hasPendingCvpRequest(cvpId) { return Q.has(cvpId); }
export function recentCvpCollectDrops() { return Q.drops(); }
export function _resetForTest() { Q._reset(); }
