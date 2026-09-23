/**
 * util/collectRequestQueue.js — 엣지 위임 '지금 수집' 요청 큐의 공용 코어(v2.590 P16).
 *
 * 문제(감사 확정): 스토리지·SAN·PDU 의 위임 요청 큐는 엣지의 설정 pull 응답에 실으면서 **그 즉시 큐에서 지웠다**
 * (one-shot). 고RTT 회선에서 pull 응답이 엣지에 닿지 않거나 엣지가 받은 직후 재시작하면 요청이 사라지는데,
 * 화면의 '요청 대기' 배지는 인출과 동시에 꺼져 **'처리됐다' 로 보였다**. CLAUDE.md '새 위임 잡 큐는 claim→ack'
 * (captureJobs·idracScanJobs·edgeLogJobs 와 같은 패턴) 위반이었다.
 *
 * 의미론(2단계):
 *  - request(id, agent)  : 대기(pending). 같은 id 재요청은 시각만 갱신(멱등).
 *  - take(agent)         : 그 엣지 몫을 인출 — 지우지 않고 **진행(inflight)** 으로 옮긴다.
 *  - ack(id, collectedAt): 엣지가 그 장비의 새 수집 결과를 올렸을 때(push 수신) — 인출 이후의 수집이면 완료.
 *  - reap                : 인출 뒤 ackMs 안에 결과가 없으면 한 번 더 대기로 되돌리고(재인출), maxTries 를 넘으면
 *                          폐기하고 그 사실을 `lastDropped` 로 남긴다(조용한 소실 금지).
 *  - has(id)             : 대기 또는 진행 중이면 true — 결과가 올 때까지 배지가 유지된다.
 * 인메모리다 — 중앙 재시작 시 사라지는 저비용 요청이라 영속하지 않는다(edgeLogJobs 와 같은 판단).
 */

export function createCollectRequestQueue({ ttlMs = 15 * 60_000, ackMs = 10 * 60_000, maxTries = 2, lower = true } = {}) {
  const pending = new Map();   // id → { agent, requestedAt, tries }
  const inflight = new Map();  // id → { agent, requestedAt, takenAt, tries }
  let lastDropped = null;      // { id, agent, at, tries }
  const norm = (a) => (lower ? String(a || '').trim().toLowerCase() : String(a || '').trim());

  function reap(now = Date.now()) {
    for (const [id, r] of pending) if (now - r.requestedAt > ttlMs) pending.delete(id);
    for (const [id, f] of inflight) {
      if (now - f.takenAt <= ackMs) continue;
      inflight.delete(id);
      if (f.tries >= maxTries) { lastDropped = { id, agent: f.agent, at: now, tries: f.tries }; continue; }
      pending.set(id, { agent: f.agent, requestedAt: now, tries: f.tries });
    }
  }
  return {
    request(id, agent, now = Date.now()) {
      reap(now);
      const k = String(id);
      const prev = pending.get(k);
      inflight.delete(k); // 다시 눌렀다면 새 요청으로 본다(진행 중 표시를 새 대기로 바꾼다)
      pending.set(k, { agent: norm(agent), requestedAt: now, tries: prev?.tries || 0 });
      return { pending: pending.size, duplicate: !!prev };
    },
    take(agent, now = Date.now()) {
      reap(now);
      const me = norm(agent);
      const ids = [];
      for (const [id, r] of pending) {
        if (r.agent !== me) continue;
        ids.push(id);
        pending.delete(id);
        inflight.set(id, { agent: r.agent, requestedAt: r.requestedAt, takenAt: now, tries: (r.tries || 0) + 1 });
      }
      return ids;
    },
    /** 새 수집 결과 도착 — collectedAt(ms)이 인출 이후면 완료로 본다. 시각을 모르면(null) 도착 자체를 완료로 본다. */
    ack(id, collectedAt = null) {
      const k = String(id);
      const f = inflight.get(k);
      if (!f) return false;
      const t = Number(collectedAt);
      if (collectedAt != null && Number.isFinite(t) && t < f.takenAt - 60_000) return false; // 인출 전(1분 여유) 수집분은 요청의 결과가 아니다
      inflight.delete(k);
      return true;
    },
    has(id, now = Date.now()) { reap(now); const k = String(id); return pending.has(k) || inflight.has(k); },
    state(id, now = Date.now()) {
      reap(now);
      const k = String(id);
      if (pending.has(k)) return { state: 'pending', ...pending.get(k) };
      if (inflight.has(k)) return { state: 'taken', ...inflight.get(k) };
      return null;
    },
    pendingCount(now = Date.now()) { reap(now); return pending.size + inflight.size; },
    lastDropped() { return lastDropped; },
    _reset() { pending.clear(); inflight.clear(); lastDropped = null; },
  };
}
