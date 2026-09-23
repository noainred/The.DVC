/**
 * pdu/collectRequests.js — 엣지 위임 PDU '지금 수집' 요청 큐.
 *
 * sanswitch/collectRequests.js 와 같은 구조다(별도 파일로 둔 이유: 큐를 공유하면 스위치 id 와
 * PDU id 가 한 맵에 섞여 한쪽 TTL 정리가 다른 쪽 요청을 지운다).
 *
 * 위임 축은 pull 구조라 중앙이 엣지에 명령을 밀어넣을 수 없다. 중앙이 여기 인메모리 큐에
 * 요청을 남기고, 엣지가 다음 config pull 때 `/api/central/pdu-config` 응답의 collectNow 로
 * 받아 즉시 수집 + 즉시 push 한다.
 *
 * 의미론:
 *  - ⚠ v2.590 P16: 아래 one-shot 은 **claim→ack 로 바뀌었다**(util/collectRequestQueue.js). 기록으로 남긴다.
 *  - (옛) one-shot: 엣지에 서빙되는 순간 큐에서 제거(전달 보장 아님 — 수동 재시도 버튼 용도라
 *    재클릭으로 충분. 영속/재전송 복잡도를 들이지 않는다. 정직 표기).
 *  - TTL 15분: 엣지가 오래 pull 하지 않으면 폐기(낡은 요청이 몇 시간 뒤 실행되는 놀람 방지).
 *  - 같은 장비 재클릭은 requestedAt 갱신(중복 항목 없음 — 멱등).
 */

import { createCollectRequestQueue } from '../util/collectRequestQueue.js';

// v2.590 P16: 인출 즉시 지우던 one-shot 을 claim→ack 로 바꿨다(코어 util/collectRequestQueue.js 머리말 참조).
// 엣지가 인출한 뒤에도 그 장비의 새 수집 결과가 올 때까지 '요청 대기' 가 유지되고, 결과가 없으면 한 번 재인출한다.
const TTL_MS = 15 * 60_000;
const Q = createCollectRequestQueue({ ttlMs: TTL_MS });

/** 수집 요청 등록(중앙에서 '수집' 클릭). agent 는 그 장비의 위임 엣지 이름. */
export function requestCollect(deviceId, agent) { const r = Q.request(deviceId, agent); return { pending: r.pending }; }

/** 이 엣지 몫 요청을 인출(config 서빙 시 호출) — 지우지 않고 진행 중으로 옮긴다(결과 도착 시 ackCollect). */
export function takeRequestsForAgent(agentName) { return Q.take(agentName); }

/** 엣지 push 로 그 장비의 새 수집 결과가 도착했다 — 인출 이후 수집이면 요청 완료. */
export function ackCollect(deviceId, collectedAt = null) { return Q.ack(deviceId, collectedAt); }

/** 장비별 대기·진행 중 요청 여부(UI 배지·중복 안내용). 결과가 올 때까지 true. */
export function hasPendingRequest(deviceId) { return Q.has(deviceId); }
export function requestState(deviceId) { return Q.state(deviceId); }
export function lastDroppedRequest() { return Q.lastDropped(); }
export function pendingCount() { return Q.pendingCount(); }
export function _resetForTest() { Q._reset(); }
