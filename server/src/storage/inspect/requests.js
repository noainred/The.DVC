/**
 * storage/inspect/requests.js — 엣지 위임 장비 '점검' 요청 큐(v2.965). 코어는 util/collectRequestQueue.js(claim → ack — 수집 요청 큐와 같은 규칙).
 *
 *  · 중앙(주간 회차 · '지금 점검')이 위임 장비를 여기 넣는다 → 엣지가 다음 storage 설정 pull 때 `inspectNow` 로 받아 로컬에서 점검 →
 *    다음 storage push 의 `inspectRuns` 로 결과가 오면 ack(기준선 = 중앙이 받은 그 장비의 마지막 점검 at — 같은 엣지 시계의 두 값 비교).
 *  · 수집 요청 큐와 따로 둔다(공유하면 '지금 수집' 이 점검을, 점검이 수집을 완료로 오인한다).
 *  · 시한 = 인출 대수 × (장비 점검 시한 + push 주기) + ack 여유. 결과가 없으면 한 번 재인출 · 그다음 폐기를 drops 에 남긴다(조용한 소실 금지).
 */
import { createCollectRequestQueue } from '../../util/collectRequestQueue.js';
import { INSPECT_TIMEOUT_MS } from './runner.js';
import { latestAtOf } from './store.js';

export const TAKE_MAX = 10;
const Q = createCollectRequestQueue({ ttlMs: 60 * 60_000, ackMs: 15 * 60_000, perItemMs: INSPECT_TIMEOUT_MS + 5 * 60_000, baseOf: (id) => latestAtOf(id) });

export function requestInspect(deviceId, agent) { return Q.request(String(deviceId), String(agent || '')); }
export function takeInspectRequests(agent) { return Q.take(String(agent || ''), Date.now(), TAKE_MAX); }
export function ackInspect(deviceId, at) { return Q.ack(String(deviceId), at); }
export function inspectRequestState(deviceId) { return Q.state(String(deviceId)); }
export function recentInspectDrops() { return Q.drops(); }
export function _resetRequestsForTest() { Q._reset(); }
