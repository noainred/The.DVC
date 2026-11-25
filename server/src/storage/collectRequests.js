/**
 * storage/collectRequests.js — 엣지 위임 장비 '지금 수집' 요청 큐(v2.316, 사용자 버그 신고).
 *
 * 문제: 엣지 위임 장비의 '수집' 버튼이 안내 메시지만 띄우고 실제로 아무것도 하지 않았다 —
 * 위임 축이 pull 구조(중앙은 엣지에 직접 명령을 밀어넣을 수 없음)라 재수집 경로 자체가 없었다.
 *
 * 해결: 중앙이 여기 인메모리 큐에 요청을 남기고, 엣지가 다음 config pull(≤5분) 때
 * /api/central/storage-config 응답의 collectNow 배열로 받아 **즉시 수집 + 즉시 push** 한다.
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
import { maxConfiguredIntervalMs } from './intervals.js';
import { isiDeviceTimeoutFor, ISI_CMD_TIMEOUT_DEF_MS } from './isiTimeouts.js';
import { envPositive, ENV_INT_MAX } from '../util/envNumber.js'; // 결정(56~75 남긴 것) 57 · 58: 시한 · 개수 env 의 Infinity · 2^31 초과 · 음수는 기본값(예전 `Math.max(하한, Number(env) || 기본)` 은 Infinity · 3e9 를 통과시켜 setTimeout 이 1ms 로 바꿨다 · 개수는 무제한)

// v2.590 P16: 인출 즉시 지우던 one-shot 을 claim→ack 로 바꿨다(코어 util/collectRequestQueue.js 머리말 참조).
// 엣지가 인출한 뒤에도 그 장비의 새 수집 결과가 올 때까지 '요청 대기' 가 유지되고, 결과가 없으면 한 번 재인출한다.
const TTL_MS = 15 * 60_000;
// v2.591: 엣지는 pull 당 20대만 처리한다(`agent/*ConfigPull.js slice(0,20)`) — 그만큼만 인출하고,
// 결과 시한은 인출 대수 × 장비 시한(엣지가 순차 수집 후 한 번에 push 한다)을 더해 잡는다. 기준선은 보관 중인 엣지 스냅샷에서.
export const TAKE_MAX = 20;
const PER_ITEM_MS = Math.max(10_000, envPositive(process.env.STORAGE_DEVICE_TIMEOUT_MS, 180_000, { max: ENV_INT_MAX }));
/**
 * v3.39.0: 장비 한 대의 결과를 기다리는 시간 — Isilon SSH 장비의 수집 시한은 이제 설정값(PowerScale SSH 명령 대기)에서 계산돼
 * 위 값보다 길 수 있다(기본 3분 → 장비 시한 5분). 짧게 잡으면 엣지가 아직 수집 중인 장비를 재인출해 **두 번 수집**한다(v2.591 과 같은 유형).
 * 중앙이 아는 것은 자기가 배포한 값뿐이라 **저장된 설정 중 가장 긴 값**으로 잡는다(지정이 없으면 기본값 — 엣지가 portal.env 로 더 길게
 * 잡은 것은 알 수 없다. 그 차이는 큐의 ackMs 여유가 받는다). 인출 시점마다 읽는다(설정을 바꾸면 바로 먹게 — 큐가 함수를 받는다 v2.611).
 */
export function perItemMs() {
  let cmd = ISI_CMD_TIMEOUT_DEF_MS;
  try { cmd = Math.max(cmd, maxConfiguredIntervalMs('isiCmdTimeoutMs') || 0); } catch { /* 설정을 못 읽으면 기본값 */ }
  return isiDeviceTimeoutFor(cmd, PER_ITEM_MS);
}
let _baseOf = null;
/** 엣지 수신 모듈이 등록한다 — deviceId → 보관 중인 엣지 스냅샷의 collectedAt(엣지 시계 값). 순환 import 를 피하려는 등록식. */
export function setCollectBaseResolver(fn) { _baseOf = typeof fn === 'function' ? fn : null; }
const Q = createCollectRequestQueue({ ttlMs: TTL_MS, perItemMs, baseOf: (id) => (_baseOf ? _baseOf(id) : null) });

/** 수집 요청 등록(중앙에서 '수집' 클릭). agent 는 그 장비의 위임 엣지 이름. */
export function requestCollect(deviceId, agent) { const r = Q.request(deviceId, agent); return { pending: r.pending }; }

/** 이 엣지 몫 요청을 인출(config 서빙 시 호출) — 지우지 않고 진행 중으로 옮긴다(결과 도착 시 ackCollect). */
export function takeRequestsForAgent(agentName) { return Q.take(agentName, Date.now(), TAKE_MAX); }

/** 엣지 push 로 그 장비의 새 수집 결과가 도착했다 — 인출 이후 수집이면 요청 완료. */
export function ackCollect(deviceId, collectedAt = null) { return Q.ack(deviceId, collectedAt); }

/** 장비별 대기·진행 중 요청 여부(UI 배지·중복 안내용). 결과가 올 때까지 true. */
export function hasPendingRequest(deviceId) { return Q.has(deviceId); }
export function requestState(deviceId) { return Q.state(deviceId); }
export function lastDroppedRequest() { return Q.lastDropped(); }
/** 최근 폐기된 요청(결과가 오지 않아 재인출까지 해 보고 버린 것) — 목록 API 가 화면에 싣는다(v2.591). */
export function recentCollectDrops() { return Q.drops(); }
export function _resetForTest() { Q._reset(); }
