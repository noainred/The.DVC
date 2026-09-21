/**
 * 동시성 제한 실행 풀 — **단일 소스**(v2.575 IMP-08).
 *
 * 이 저장소는 '수집 동시성 제한' 을 회귀 방지 불변조건으로 못 박고 있다(루트 CLAUDE.md
 * `store.collectPool`·`COLLECT_CONCURRENCY`). 그런데 v2.574 까지 그 스캐폴드가
 * **손으로 쓴 23벌**이었고 오류 처리가 둘로 갈려 있었다 — 항목별 `catch` 가 있는 것 8곳,
 * 없는 것 15곳. 없는 쪽은 한 항목의 rejection 이 `Promise.all` 을 통째로 거부시켜
 * **남은 항목의 결과까지 버린다**(오늘은 호출부가 `fn` 안에서 삼켜 드러나지 않을 뿐이다).
 * 그 선택을 **함수 이름으로 드러나게** 하는 것이 이 모듈의 존재 이유다.
 *
 *  - `poolSettled(items, limit, fn)` — 항목마다 성패를 따로 담는다. 한 항목이 던져도 나머지는
 *    끝까지 돈다. 반환은 `Promise.allSettled` 와 **같은 형태**(`{status,value|reason}[]`)이고
 *    **입력 순서를 보존**한다.
 *  - `poolRun(items, limit, fn)` — 반환값이 필요 없고 **첫 rejection 을 그대로 올리는** 경우.
 *    `fn` 이 스스로 catch 하는 수집기가 여기 해당한다.
 *
 * 공통 규칙
 *  - 워커 수는 `min(limit, items.length)` 이고 **최소 1**이다(`limit<=0` 이면 순차).
 *  - `fn(item, index)` 로 index 를 함께 준다(진행률·결과 배열 채우기).
 *  - 빈 배열이면 즉시 끝난다(워커를 만들지 않는다).
 */

const workerCount = (limit, n) => {
  const l = Number(limit);
  const cap = Number.isFinite(l) && l > 0 ? Math.floor(l) : 1;
  return Math.max(0, Math.min(cap, n));
};

/** 항목별 성패를 따로 담는다(allSettled 형태, 입력 순서 보존). */
export async function poolSettled(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const idx = next++;
      if (idx >= list.length) return;
      try { results[idx] = { status: 'fulfilled', value: await fn(list[idx], idx) }; }
      catch (reason) { results[idx] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: workerCount(limit, list.length) }, worker));
  return results;
}

/** 반환값 없이 돌린다 — `fn` 이 던지면 **그대로 올라간다**(그 선택을 이름이 말한다). */
export async function poolRun(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const idx = next++;
      if (idx >= list.length) return;
      await fn(list[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: workerCount(limit, list.length) }, worker));
}

export default { poolSettled, poolRun };
