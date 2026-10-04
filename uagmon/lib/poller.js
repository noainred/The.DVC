/**
 * UAG 폴러 — 재진입 가드 + 대상 변경 직후 재실행 예약.
 *
 * - 재진입 가드: 이전 주기가 느리면(고RTT UAG) 이번 틱을 건너뛴다(중첩 실행 금지).
 * - 재실행 예약(`{again:true}`): 대상 추가·수정 직후 호출했는데 이미 진행 중이면, 진행 중인
 *   주기는 새 대상을 모른다(시작 시점의 목록을 돈다). 예전에는 `skipped` 로 끝나 새 대상이
 *   다음 주기(기본 30초)까지 '미확인' 이었다 → 끝난 뒤 한 번 더 돈다.
 *   주기 타이머 틱은 예약하지 않는다 — 예약하면 느린 UAG 에서 주기가 쉬지 않고 이어진다.
 * - 반영 직전 그 대상이 지금도 목록에 있는지(같은 객체인지) 본다: 폴링 중 삭제된 대상의
 *   결과가 latest/history 에 되살아나지 않게, 수정 전 설정(옛 host)으로 받은 결과가 수정된
 *   대상의 값으로 기록되지 않게. (수정된 대상은 재실행 예약이 곧 새 값을 채운다.)
 */
export function createPoller(store, fetchFn) {
  let polling = false;
  let again = false;
  let follow = null; // 예약된 재실행 프라미스(테스트·대기용)

  async function pollOnce({ again: want = false } = {}) {
    if (polling) {
      if (want) again = true;
      return { skipped: true, queued: Boolean(want) };
    }
    polling = true;
    try {
      await Promise.allSettled(store.targets.map(async (t) => {
        const r = await fetchFn(t);
        if (!store.targets.includes(t)) return; // 삭제·수정된 대상 — 옛 결과를 버린다
        store.pushSample(t.id, r);
      }));
      return { ok: true, at: Date.now() };
    } finally {
      polling = false;
      if (again) {
        again = false;
        follow = new Promise((resolve) => setImmediate(resolve)).then(() => pollOnce());
        follow.catch((err) => console.error(`[uagmon] 재실행 폴링 실패: ${err?.message || err}`));
      }
    }
  }

  return {
    pollOnce,
    get polling() { return polling; },
    /** 예약된 재실행이 끝날 때까지 기다린다(없으면 즉시). */
    async settled() { while (follow) { const f = follow; follow = null; await f.catch(() => {}); } },
  };
}
