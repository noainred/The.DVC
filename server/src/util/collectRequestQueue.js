/**
 * util/collectRequestQueue.js — 엣지 위임 '지금 수집' 요청 큐의 공용 코어(v2.590 P16 · v2.591 재설계).
 *
 * 문제(감사 확정): 스토리지·SAN·PDU 의 위임 요청 큐는 엣지의 설정 pull 응답에 실으면서 **그 즉시 큐에서 지웠다**
 * (one-shot). 고RTT 회선에서 pull 응답이 엣지에 닿지 않거나 엣지가 받은 직후 재시작하면 요청이 사라지는데,
 * 화면의 '요청 대기' 배지는 인출과 동시에 꺼져 **'처리됐다' 로 보였다**. CLAUDE.md '새 위임 잡 큐는 claim→ack'
 * (captureJobs·idracScanJobs·edgeLogJobs 와 같은 패턴) 위반이었다.
 *
 * ⚠⚠ v2.591 정정(3차 감사 R-Q1·PR-3 — 두 축이 독립 재현) — v2.590 초판의 결함 셋:
 *  ① 완료 판정이 **엣지 시계**(push 의 collectedAt)와 **중앙 시계**(인출 시각)를 비교했다. 엣지 시계가 60초 넘게
 *     늦으면 결과가 와도 완료가 안 돼 같은 장비를 **두 번 수집**하고 결국 **조용히 폐기**했다(빠르면 인출 전 스냅샷을
 *     완료로 받았다). → 인출하는 순간 그 장비의 **마지막 수집 시각(엣지 시계 값)을 기준선**으로 잡고, 그보다 새 값이
 *     오면 완료다. 비교가 **같은 시계의 두 값**이라 시계 차이와 무관하다.
 *  ② 인출이 대기 전량을 진행으로 옮겼는데 엣지는 pull 당 **20대만** 처리한다(`*ConfigPull.js slice(0,20)`) —
 *     50대면 30대가 시도조차 안 된 채 '진행 중' 으로 시한을 먹고 두 번 만에 폐기됐다(10대는 한 번도 수집 안 됨).
 *     → `take(agent, now, max)` 로 엣지가 처리하는 만큼만 인출한다. 남은 것은 대기로 남고 시도 횟수도 안 올린다.
 *  ③ 결과 시한이 대수와 무관한 10분이었다. 엣지는 받은 장비를 **순차로** 수집한 뒤 한 번에 push 하므로 장비 시한
 *     3분 × 5대면 15분이 걸려 뒤 장비들이 재인출돼 **두 번 수집**됐다. → 시한 = max(ackMs, 인출 대수 × perItemMs + ackMs).
 *  그리고 재대기로 돌아간 뒤 도착한 결과도 완료로 인정한다(기준선이 있으면). 폐기는 `drops()` 링으로 남기고
 *  목록 API 가 화면에 실어 말한다(v2.590 의 `lastDropped` 는 소비처가 0건이었다 — '밝힌다' 가 사실이 아니었다).
 *
 * 의미론(2단계):
 *  - request(id, agent)       : 대기(pending). 같은 id 재요청은 시각만 갱신(멱등).
 *  - take(agent, now, max)    : 그 엣지 몫을 최대 max 개 인출 — 지우지 않고 **진행(inflight)** 으로 옮긴다.
 *                               그 장비의 기준선(seen → 없으면 baseOf(id): 보관 중인 엣지 스냅샷의 수집 시각)을 적어 둔다.
 *  - ack(id, collectedAt)     : 엣지 push 로 그 장비의 수집 결과가 도착했다(주기 push 포함 **매번** 부른다).
 *                               기준선보다 새 collectedAt 이면 완료. 기준선이 없으면(한 번도 못 본 장비) 도착 자체가 완료.
 *                               collectedAt 을 모르면(null) 도착 자체를 완료로 본다(예전 동작).
 *  - reap                     : 시한 안에 결과가 없으면 한 번 더 대기로 되돌리고(재인출), maxTries 를 넘으면
 *                               폐기하고 그 사실을 drops 에 남긴다(조용한 소실 금지).
 *  - has(id)                  : 대기 또는 진행 중이면 true — 결과가 올 때까지 배지가 유지된다.
 * 인메모리다 — 중앙 재시작 시 사라지는 저비용 요청이라 영속하지 않는다(edgeLogJobs 와 같은 판단).
 */

const DROPS_MAX = 20;

export function createCollectRequestQueue({ ttlMs = 15 * 60_000, ackMs = 10 * 60_000, perItemMs = 0, maxTries = 2, lower = true, baseOf = null } = {}) {
  const pending = new Map();   // id → { agent, requestedAt, tries, base? }
  const inflight = new Map();  // id → { agent, requestedAt, takenAt, deadline, tries, base }
  const seen = new Map();      // id → 마지막으로 받은 collectedAt(엣지 시계 값 그대로 — 중앙 시계와 비교하지 않는다)
  const drops = [];            // 최근 폐기 { id, agent, at, tries } (최신이 앞)
  const norm = (a) => (lower ? String(a || '').trim().toLowerCase() : String(a || '').trim());

  function reap(now = Date.now()) {
    // v2.593(감사 R2593-03): TTL 만료도 폐기다 — 예전엔 drops 에 남기지 않아, 가장 흔한 경우(엣지가 꺼져 있거나 pull 을
    //   안 해 요청을 한 번도 가져가지 않음)가 화면에서 **조용히 사라졌다**. 사유를 나눈다: 'untaken'(엣지가 가져가지 않았다) /
    //   'requeued-expired'(한 번 가져갔는데 결과가 오지 않았고 재대기 뒤 다시 가져가지 않았다) / 'no-result'(시도 상한).
    for (const [id, r] of pending) {
      if (now - r.requestedAt <= ttlMs) continue;
      pending.delete(id);
      drops.unshift({ id, agent: r.agent, at: now, tries: r.tries || 0, reason: r.tries ? 'requeued-expired' : 'untaken' });
      if (drops.length > DROPS_MAX) drops.length = DROPS_MAX;
    }
    for (const [id, f] of inflight) {
      if (now <= f.deadline) continue;
      inflight.delete(id);
      if (f.tries >= maxTries) {
        drops.unshift({ id, agent: f.agent, at: now, tries: f.tries, reason: 'no-result' });
        if (drops.length > DROPS_MAX) drops.length = DROPS_MAX;
        continue;
      }
      // 재대기 — 기준선은 유지한다(그 사이 늦게 도착한 결과도 완료로 인정하려고).
      pending.set(id, { agent: f.agent, requestedAt: now, tries: f.tries, base: f.base });
    }
  }
  const complete = (entry, t) => {
    if (t == null) return true;                          // 시각을 모르면 도착 자체를 완료로 본다(예전 동작)
    if (!('base' in entry)) return false;                // 인출된 적 없는 대기 요청 — 요청 이전 수집일 수 있다
    return entry.base == null || t > entry.base;         // 기준선보다 새 수집만 완료
  };
  return {
    request(id, agent, now = Date.now()) {
      reap(now);
      const k = String(id);
      const prev = pending.get(k);
      inflight.delete(k); // 다시 눌렀다면 새 요청으로 본다(진행 중 표시를 새 대기로 바꾼다)
      pending.set(k, { agent: norm(agent), requestedAt: now, tries: prev?.tries || 0 });
      return { pending: pending.size, duplicate: !!prev };
    },
    /** 그 엣지 몫을 최대 max 개 인출(엣지가 pull 당 처리하는 수와 맞출 것 — 넘기면 나머지가 시도 없이 시한을 먹는다). */
    take(agent, now = Date.now(), max = Infinity) {
      reap(now);
      const me = norm(agent);
      const lim = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : Infinity;
      const ids = [];
      for (const [id] of pending) {
        if (ids.length >= lim) break;
        const r = pending.get(id);
        if (r.agent !== me) continue;
        ids.push(id);
      }
      // v2.611(TIM2611-02): perItemMs 는 숫자 또는 함수(인출 시점의 설정값 — 설정 화면에서 바꾼 장비 시한이 바로 먹게).
      const per = Math.max(0, Number(typeof perItemMs === 'function' ? perItemMs() : perItemMs) || 0);
      const deadline = now + ackMs + ids.length * per;
      for (const id of ids) {
        const r = pending.get(id);
        pending.delete(id);
        // 기준선: 이 큐가 본 마지막 수집 시각 → 없으면(중앙 재시작 직후) 보관 중인 엣지 스냅샷의 수집 시각(baseOf).
        let base = 'base' in r ? r.base : (seen.has(id) ? seen.get(id) : null);
        if (base == null && !('base' in r) && typeof baseOf === 'function') {
          try { const b = Number(baseOf(id)); base = Number.isFinite(b) && b > 0 ? b : null; } catch { base = null; }
        }
        inflight.set(id, { agent: r.agent, requestedAt: r.requestedAt, takenAt: now, deadline, tries: (r.tries || 0) + 1, base });
      }
      return ids;
    },
    /** 수집 결과 도착(엣지 push 수신마다 호출) — 기준선보다 새 수집이면 그 요청을 완료한다. 완료했으면 true. */
    ack(id, collectedAt = null) {
      const k = String(id);
      const n = Number(collectedAt);
      const t = collectedAt == null || collectedAt === '' || !Number.isFinite(n) ? null : n;
      let done = false;
      const f = inflight.get(k);
      if (f && complete(f, t)) { inflight.delete(k); done = true; }
      const p = pending.get(k);
      // 재대기 중인 요청(한 번 인출돼 기준선이 있는 것)만 — 인출된 적 없는 요청은 이 push 가 그 결과일 수 없다.
      if (!done && p && ('base' in p) && complete(p, t)) { pending.delete(k); done = true; }
      if (t != null) seen.set(k, Math.max(t, seen.get(k) ?? -Infinity));
      return done;
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
    /** 최근 폐기 목록(최신이 앞, 최대 20). 화면이 '결과 없이 폐기된 요청' 을 말하는 근거. */
    drops(now = Date.now()) { reap(now); return drops.map((d) => ({ ...d })); },
    lastDropped(now = Date.now()) { reap(now); return drops[0] ? { ...drops[0] } : null; },
    _reset() { pending.clear(); inflight.clear(); seen.clear(); drops.length = 0; },
  };
}
