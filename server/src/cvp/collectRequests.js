/**
 * cvp/collectRequests.js — 엣지 위임 CVP 의 '지금 수집' 요청 큐(v2.608). 코어는 util/collectRequestQueue.js(claim→ack — v2.590 P16·v2.591).
 * 중앙은 엣지에 명령을 밀어넣을 수 없다(pull 구조) — 요청을 큐에 두고 엣지가 `/api/central/cvp-config` 로 인출한다.
 * 완료는 그 CVP 의 **새 수집 결과**(상태의 collectedAt 이 인출 때 기준선보다 새 값)가 push 로 도착했을 때다.
 */
import { createCollectRequestQueue } from '../util/collectRequestQueue.js';

export const TAKE_MAX = 10;
const PER_ITEM_MS = Math.max(30_000, Number(process.env.CVP_DEVICE_TIMEOUT_MS) || 120_000);
let _baseOf = null;
/** 엣지 수신 모듈이 등록한다 — cvpId → 보관 중인 엣지 상태의 collectedAt(엣지 시계 값). 순환 import 를 피하려는 등록식. */
export function setCvpCollectBaseResolver(fn) { _baseOf = typeof fn === 'function' ? fn : null; }
const Q = createCollectRequestQueue({ ttlMs: 15 * 60_000, perItemMs: PER_ITEM_MS, baseOf: (id) => (_baseOf ? _baseOf(id) : null) });

export function requestCvpCollect(cvpId, agent) { const r = Q.request(cvpId, agent); return { pending: r.pending, duplicate: r.duplicate }; }
export function takeCvpRequests(agent) { return Q.take(agent, Date.now(), TAKE_MAX); }
export function ackCvpCollect(cvpId, collectedAt = null) { return Q.ack(cvpId, collectedAt); }
export function hasPendingCvpRequest(cvpId) { return Q.has(cvpId); }
export function recentCvpCollectDrops() { return Q.drops(); }
export function _resetForTest() { Q._reset(); }
