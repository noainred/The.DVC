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
 *  - one-shot: 엣지에 서빙되는 순간 큐에서 제거(전달 보장 아님 — 수동 재시도 버튼 용도라
 *    재클릭으로 충분. 영속/재전송 복잡도를 들이지 않는다. 정직 표기).
 *  - TTL 15분: 엣지가 오래 pull 하지 않으면 폐기(낡은 요청이 몇 시간 뒤 실행되는 놀람 방지).
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

export function hasPendingRequest(deviceId) {
  prune();
  return _pending.has(String(deviceId));
}

/** 이 엣지 몫 요청을 꺼내며 큐에서 제거(one-shot — config 서빙 시 호출). */
export function takeRequestsForAgent(agentName) {
  prune();
  const me = String(agentName || '').trim().toLowerCase();
  const ids = [];
  for (const [id, r] of _pending) {
    if (r.agent === me) { ids.push(id); _pending.delete(id); }
  }
  return ids;
}

export function pendingCount() { prune(); return _pending.size; }
export function _resetForTest() { _pending.clear(); }
