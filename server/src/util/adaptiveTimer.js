/**
 * util/adaptiveTimer.js — 주기를 스스로 다시 잡는 타이머(v2.409 에서 storage/intervals.js 로
 * 도입, v2.410 에서 공용 유틸로 분리 — SAN 스위치 폴러도 같은 규칙을 쓴다).
 *
 * setInterval 은 **생성 시점의 상수 간격**에 묶여 있어, 주기를 바꾸려면 프로세스 재시작이
 * 필요하다. 여기서는 매 회 `getMs()` 를 다시 읽어 재무장하므로 설정 변경이 다음 틱부터
 * (변경 알림이 오면 즉시) 반영된다.
 *
 * 부수효과: 간격이 **'이전 실행 종료 기준'** 이 된다 — 수집이 주기를 넘겨도 틱이 겹쳐 쌓이지
 * 않는다(CLAUDE.md 재진입 규칙과 같은 방향. 폴러의 재진입 가드는 그대로 유지할 것).
 *
 * @param getMs      매 회 호출되는 '다음 간격(ms)' 공급자
 * @param fn         실행할 작업(비동기 가능 — 자기 오류는 스스로 삼킨다)
 * @param subscribe  선택. 주기 변경 알림 구독자 등록 함수(cb) → 해제 함수. 주면 변경 시
 *                   **이미 무장된 타이머를 즉시 재무장**한다(없으면 60분 주기에서 최대
 *                   1시간 뒤에야 새 주기가 먹는다).
 */
export function startAdaptiveTimer(getMs, fn, { firstDelayMs = 0, name = '', subscribe = null } = {}) {
  let timer = null;
  let stopped = false;
  let lastRunAt = Date.now();
  const arm = (ms) => {
    clearTimeout(timer);
    // 하한 1초 — 0/음수 주기로 이벤트 루프를 태우지 않게(설정 실수·시계 역행 방어).
    timer = setTimeout(tick, Math.max(1_000, ms));
    timer.unref?.();
  };
  const tick = async () => {
    lastRunAt = Date.now();
    try { await fn(); } catch { /* 폴러는 자기 오류를 삼킨다(기존 .catch(()=>{}) 와 동일) */ }
    if (!stopped) arm(getMs());
  };
  arm(firstDelayMs);
  // 주기 변경 시 재무장 — 이미 흘린 시간을 빼고 다시 잡는다(주기를 늘렸다고 방금 돈 작업을
  // 또 돌리지 않고, 줄였다면 남은 시간이 음수가 되어 바로 다음 틱으로 간다).
  const off = subscribe ? subscribe(() => {
    if (stopped) return;
    const next = getMs() - (Date.now() - lastRunAt);
    if (name) console.log(`[adaptive-timer] ${name} 타이머 재무장: ${Math.round(Math.max(1_000, next) / 1000)}초 후`);
    arm(next);
  }) : null;
  return { stop() { stopped = true; off?.(); clearTimeout(timer); } };
}
