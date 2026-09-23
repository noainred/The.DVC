/**
 * sanswitch/collectRequests.js — 엣지 위임 스위치 '지금 수집' 요청 큐(v2.410).
 *
 * storage/collectRequests.js 와 같은 구조다(별도 파일로 둔 이유: 큐를 공유하면 스토리지
 * 장비 id 와 스위치 id 가 한 맵에 섞여, 한쪽 TTL 정리가 다른 쪽 요청을 지운다).
 *
 * 문제: 엣지 위임 장비의 '수집' 버튼이 안내 메시지만 띄우고 실제로 아무것도 하지 않았다 —
 * 위임 축이 pull 구조(중앙은 엣지에 직접 명령을 밀어넣을 수 없음)라 재수집 경로 자체가 없었다.
 *
 * 해결: 중앙이 여기 인메모리 큐에 요청을 남기고, 엣지가 다음 config pull(≤5분) 때
 * /api/central/sanswitch-config 응답의 collectNow 배열로 받아 **즉시 수집 + 즉시 push** 한다.
 * 최악 대기: pull 주기(≤5분) + 수집 시간 — 기존 '다음 폴링 주기(≤10분) + push(≤5분)' 대비 단축.
 *
 * 의미론:
 *  - ⚠ v2.590 P16: 아래 one-shot 은 **claim→ack 로 바뀌었다**(util/collectRequestQueue.js). 기록으로 남긴다.
 *  - (옛) one-shot: 엣지에 서빙되는 순간 큐에서 제거(전달 보장 아님 — 엣지가 그 직후 죽으면 유실.
 *    수동 재시도 버튼 용도라 재클릭으로 충분, 영속/재전송 복잡도를 들이지 않는다. 정직 표기).
 *  - TTL 15분: 엣지가 오랫동안 pull 하지 않으면 요청을 폐기(낡은 요청이 몇 시간 뒤 갑자기
 *    실행되는 놀람 방지). 인메모리 — 중앙 재시작 시 소실(동일 이유로 수용).
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

/* ── 포트 사용량(portperfshow) '지금 수집' 위임 큐(v2.517) ─────────────────────────
 * 왜 별도 큐인가: 위 큐의 항목은 엣지에서 **기본 수집**(`collectDeviceNow`)으로 실행된다. 사용량
 * 수집은 다른 폴러이고(세션을 수 초 붙잡는 캡처) 같은 배열에 섞으면 엣지가 어느 쪽을 돌려야
 * 하는지 구분할 수 없다.
 *
 * 왜 필요한가: v2.516 까지 중앙의 '지금 수집'(`/tools/sanswitch/perf/collect`)은 `pollPerfOnce`
 * 를 불렀고, 그 안의 `devicesForThisNode()` 는 중앙에서 **agent 가 없는 장비만** 돌려준다
 * (`registry.js:135`) — 즉 엣지 위임 장비는 목록에서 빠져 **아무 일도 일어나지 않았고 화면은
 * 그 사실을 말하지 않았다**. 기본 수집은 v2.516 에 '즉시 N대 / 요청 M대' 로 나눠 말하게 고쳤는데
 * 사용량 수집은 빠져 있었다.
 *
 * 의미론은 위 큐와 같다: one-shot(서빙 순간 제거) · TTL 15분 · 멱등(재클릭은 시각 갱신) ·
 * 인메모리(중앙 재시작 시 소실 — 수동 버튼용). 단위는 **엣지 단위**다(엣지의 `pollPerfOnce` 는
 * 자기 몫 전체를 한 주기에 수집하므로 장비별로 나눠 요청할 이유가 없다).
 */
// v2.590 P16: 사용량 요청도 claim→ack — 엣지가 사용량 상태를 올리면(sanSwitchPerfEdge 수신) 완료.
const PQ = createCollectRequestQueue({ ttlMs: TTL_MS });

/** 사용량 재수집 요청 등록. 반환 `{ duplicate }` — 이미 대기·진행 중이면 true(화면이 그대로 말한다). */
export function requestPerfCollect(agent) {
  const a = String(agent || '').toLowerCase();
  if (!a) return { duplicate: false, pending: PQ.pendingCount() };
  const duplicate = PQ.has(a);
  PQ.request(a, a);
  return { duplicate, pending: PQ.pendingCount() };
}

/** 이 엣지 몫 요청을 인출(config 서빙 시 호출) — 진행 중으로 옮긴다. */
export function takePerfRequestForAgent(agentName) { return PQ.take(agentName).length > 0; }

/** 엣지가 사용량 상태를 올렸다 — 인출 이후면 완료. */
export function ackPerfCollect(agent, at = null) { return PQ.ack(String(agent || '').toLowerCase(), at); }

export function hasPendingPerfRequest(agent) { return PQ.has(String(agent || '').toLowerCase()); }

export function _resetForTest() { Q._reset(); PQ._reset(); }
