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
 *  - one-shot: 엣지에 서빙되는 순간 큐에서 제거(전달 보장 아님 — 엣지가 그 직후 죽으면 유실.
 *    수동 재시도 버튼 용도라 재클릭으로 충분, 영속/재전송 복잡도를 들이지 않는다. 정직 표기).
 *  - TTL 15분: 엣지가 오랫동안 pull 하지 않으면 요청을 폐기(낡은 요청이 몇 시간 뒤 갑자기
 *    실행되는 놀람 방지). 인메모리 — 중앙 재시작 시 소실(동일 이유로 수용).
 *  - 같은 장비 재클릭은 requestedAt 갱신(중복 항목 없음 — 멱등).
 */

const TTL_MS = 15 * 60_000;
const _pending = new Map(); // deviceId → { agent(소문자), requestedAt }

function prune() {
  const cut = Date.now() - TTL_MS;
  for (const [id, r] of _pending) if (r.requestedAt < cut) _pending.delete(id);
}

/** 수집 요청 등록(중앙에서 '수집' 클릭). agent 는 그 장비의 위임 엣지 이름. */
export function requestCollect(deviceId, agent) {
  prune();
  _pending.set(String(deviceId), { agent: String(agent || '').toLowerCase(), requestedAt: Date.now() });
  return { pending: _pending.size };
}

/** 이 엣지 몫 요청을 꺼내며 큐에서 제거(one-shot — config 서빙 시 호출). */
export function takeRequestsForAgent(agentName) {
  prune();
  const me = String(agentName || '').toLowerCase();
  const ids = [];
  for (const [id, r] of _pending) {
    if (r.agent === me) { ids.push(id); _pending.delete(id); }
  }
  return ids;
}

/** 장비별 대기 중 요청 여부(UI 배지·중복 안내용). */
export function hasPendingRequest(deviceId) { prune(); return _pending.has(String(deviceId)); }

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
const _perfPending = new Map(); // agent(소문자) → requestedAt

function prunePerf() {
  const cut = Date.now() - TTL_MS;
  for (const [a, at] of _perfPending) if (at < cut) _perfPending.delete(a);
}

/** 사용량 재수집 요청 등록. 반환 `{ duplicate }` — 이미 대기 중이면 true(화면이 그대로 말한다). */
export function requestPerfCollect(agent) {
  prunePerf();
  const a = String(agent || '').toLowerCase();
  if (!a) return { duplicate: false, pending: _perfPending.size };
  const duplicate = _perfPending.has(a);
  _perfPending.set(a, Date.now());
  return { duplicate, pending: _perfPending.size };
}

/** 이 엣지 몫 요청을 꺼내며 제거(one-shot — config 서빙 시 호출). */
export function takePerfRequestForAgent(agentName) {
  prunePerf();
  const a = String(agentName || '').toLowerCase();
  if (!a || !_perfPending.has(a)) return false;
  _perfPending.delete(a);
  return true;
}

export function hasPendingPerfRequest(agent) {
  prunePerf();
  return _perfPending.has(String(agent || '').toLowerCase());
}

export function _resetForTest() { _pending.clear(); _perfPending.clear(); }
