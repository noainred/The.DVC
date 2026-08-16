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

export function _resetForTest() { _pending.clear(); }
