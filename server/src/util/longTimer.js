/**
 * 긴 간격 타이머(v2.591 L2).
 *
 * Node 의 setTimeout/setInterval 은 지연이 2^31−1ms(약 24.8일)를 넘으면 **경고 한 줄과 함께 1ms 로 바꾼다**
 * (`TimeoutOverflowWarning`). 그 값으로 setInterval 을 걸면 **1ms 마다** 실행된다 — 백업 '매 30일' 설정이 3초 만에 보관 슬롯
 * 30개를 같은 내용으로 교체하던 사고(재현)가 그것이다. `idrac/scanPoller.js` 는 같은 한계를 알고 조각 setTimeout 체인으로
 * 피했다 — 그 방식을 공용으로 올린 것이다.
 *
 * `every(fn, ms)` 는 목표 시각까지 상한 이하 조각으로 나눠 기다린 뒤 fn 을 부르고 다시 무장한다. 반환값의 `clear()` 로 멈춘다.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export function every(fn, ms, { unref = true } = {}) {
  const period = Math.max(1, Number(ms) || 1);
  let handle = null;
  let stopped = false;
  const arm = () => {
    const due = Date.now() + period;
    const step = () => {
      if (stopped) return;
      const left = due - Date.now();
      if (left > 0) {
        handle = setTimeout(step, Math.min(left, MAX_TIMER_MS));
        if (unref) handle.unref?.();
        return;
      }
      try { fn(); } finally { if (!stopped) arm(); }
    };
    step();
  };
  arm();
  return { clear() { stopped = true; if (handle) clearTimeout(handle); handle = null; } };
}
