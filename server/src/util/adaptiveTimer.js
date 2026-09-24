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
  // v2.598 T2598-04: 실행 중에 주기 변경 알림이 오면 예전엔 즉시 재무장해 **진행 중인 fn 과 겹쳐 두 번째 fn 이
  // 돌 수 있었다**(실측: 4초 걸리는 작업 중 주기를 2초로 바꾸면 동시 실행 2). 호출부 폴러가 전부 재진입 가드를
  // 가져 피해는 없었지만, 이 유틸의 약속('틱이 겹쳐 쌓이지 않는다')이 깨져 있었다. 실행 중에는 재무장하지 않고
  // 끝날 때 getMs() 로 새 주기를 잡는다.
  let inFlight = false;
  let warnedNaN = false;
  let warnedThrow = false;
  // v2.601(감사 TIM2601-02 — 재현): getMs() 가 던지면(설정 파일 손상 등 — TIM2601-03) tick 이 reject 되어 **재무장 없이
  // 타이머가 영구히 멈추고** unhandledRejection 만 남았다(5초에 fn 1회). 던지면 undefined 로 보고 arm 의 NaN 경로(60초)로
  // 보내고 한 번 알린다 — 설정이 고쳐지면 다음 틱부터 다시 그 값을 쓴다.
  const safeMs = () => {
    try { return getMs(); } catch (e) {
      if (!warnedThrow) { warnedThrow = true; console.warn(`[adaptive-timer] ${name || '(이름 없음)'} 주기를 읽지 못했습니다(${e?.message || e}) — 60초로 대신합니다.`); }
      return undefined;
    }
  };
  const arm = (ms) => {
    clearTimeout(timer);
    // 하한 1초 — 0/음수 주기로 이벤트 루프를 태우지 않게(설정 실수·시계 역행 방어).
    // 상한 약 24.8일 — setTimeout 은 2^31−1ms 를 넘으면 1ms 가 된다(v2.591 L2·L3).
    // v2.600 T2600-04: Math.max(1000, NaN) 은 NaN 이고 setTimeout(NaN) 은 1ms 다 — 하한 가드가 NaN·undefined 를
    // 막지 못했다(현재 호출부는 전부 클램프해 도달하지 않는다 — 잠재). 숫자가 아니면 60초로 잡고 한 번 알린다.
    let n = Number(ms);
    if (!Number.isFinite(n)) {
      if (!warnedNaN && !warnedThrow) { warnedNaN = true; console.warn(`[adaptive-timer] ${name || '(이름 없음)'} 주기가 숫자가 아닙니다(${String(ms)}) — 60초로 대신합니다.`); }
      n = 60_000;
    }
    timer = setTimeout(tick, Math.min(2_147_000_000, Math.max(1_000, n)));
    timer.unref?.();
  };
  const tick = async () => {
    lastRunAt = Date.now();
    inFlight = true;
    try { await fn(); } catch { /* 폴러는 자기 오류를 삼킨다(기존 .catch(()=>{}) 와 동일) */ }
    finally { inFlight = false; }
    if (!stopped) arm(safeMs());
  };
  arm(firstDelayMs);
  // 주기 변경 시 재무장 — 이미 흘린 시간을 빼고 다시 잡는다(주기를 늘렸다고 방금 돈 작업을
  // 또 돌리지 않고, 줄였다면 남은 시간이 음수가 되어 바로 다음 틱으로 간다).
  const off = subscribe ? subscribe(() => {
    if (stopped || inFlight) return;   // 실행 중이면 종료 시 tick 이 새 주기로 재무장한다
    const ms = safeMs();
    const next = Number.isFinite(Number(ms)) ? Number(ms) - (Date.now() - lastRunAt) : ms; // 못 읽으면 arm 이 60초로
    if (name) console.log(`[adaptive-timer] ${name} 타이머 재무장: ${Math.round(Math.max(1_000, next) / 1000)}초 후`);
    arm(next);
  }) : null;
  return { stop() { stopped = true; off?.(); clearTimeout(timer); } };
}
