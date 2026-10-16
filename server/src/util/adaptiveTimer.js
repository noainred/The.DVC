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
import { createChangeLogger } from './logThrottle.js'; // v2.733(감사 C4-03): fn 실패 로그 — 같은 오류 반복을 줄인다
import { numOrNull } from './numOrNull.js';

export function startAdaptiveTimer(getMs, fn, { firstDelayMs = 0, name = '', subscribe = null } = {}) {
  let timer = null;
  // v2.733(감사 C4-03): fn 이 던진 오류를 **로그 없이** 삼키지 않는다 — 스토리지 폴러가 스냅샷 쓰기 ENOSPC 로 매 주기 던지는데
  //   콘솔에 아무것도 남지 않아 수집이 왜 멈췄는지 알 수 없었다. 같은 오류는 1시간에 한 번만 적는다(타이머 동작은 그대로 —
  //   다음 주기로 재무장한다). 폴러는 여전히 자기 오류를 스스로 다뤄야 한다 — 이 줄은 마지막 안전망이다.
  const shouldLogFail = createChangeLogger({ windowMs: 3_600_000, maxKeys: 4 });
  let stopped = false;
  // v2.741(감사 TIMING-05): 변경 알림의 재무장 기준은 **마지막 실행이 끝난 시각**이다(머리말의 '이전 실행 종료 기준' 약속).
  //   예전에는 실행 **시작** 시각(lastRunAt)으로 남은 시간을 셌다 — 2.5초 걸린 실행 직후 같은 주기(3초)로 알림이 오면
  //   3 − 2.6 = 0.4초가 남은 것으로 보고 하한 1초 뒤에 다시 돌았다(알림 없는 대조군은 3초). bmusage 처럼 어떤 필드를 저장해도
  //   알리는 설정에서 실제로 닿는다. 첫 실행 전에는 타이머를 만든 시각이 기준이다(예전과 같다 — 다만 v2.743 부터 첫 실행 전
  //   알림은 firstDelay 보다 늦추지 않는다. 아래 subscribe 의 TIMING-01 주석).
  let lastEndAt = Date.now();
  // 지금 무장된 주기(getMs 값) — 알림이 와도 값이 그대로면 재무장하지 않는다(남은 시간을 다시 셀 이유가 없다). 첫 실행 전은 null.
  let armedMs = null;
  // v2.598 T2598-04: 실행 중에 주기 변경 알림이 오면 예전엔 즉시 재무장해 **진행 중인 fn 과 겹쳐 두 번째 fn 이
  // 돌 수 있었다**(실측: 4초 걸리는 작업 중 주기를 2초로 바꾸면 동시 실행 2). 호출부 폴러가 전부 재진입 가드를
  // 가져 피해는 없었지만, 이 유틸의 약속('틱이 겹쳐 쌓이지 않는다')이 깨져 있었다. 실행 중에는 재무장하지 않고
  // 끝날 때 getMs() 로 새 주기를 잡는다.
  let inFlight = false;
  // v2.743(감사 TIMING-01): 첫 tick 이 한 번이라도 끝났는가. armedMs 는 getMs 를 못 읽으면 첫 실행 뒤에도 null 이라 따로 둔다.
  let ranOnce = false;
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
  // v2.743(감사 TIMING-01): 지금 무장된 타이머가 울릴 시각 — 첫 실행 전 알림이 '같은 시각' 이면 재무장하지 않는 데 쓴다.
  let fireAt = 0;
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
    const delay = Math.min(2_147_000_000, Math.max(1_000, n));
    fireAt = Date.now() + delay;
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };
  const tick = async () => {
    inFlight = true;
    try { await fn(); } catch (e) {
      // 폴러는 자기 오류를 삼킨다(기존 .catch(()=>{}) 와 동일) — 다만 무음은 아니다(위 v2.733 주석).
      const msg = String(e?.message || e);
      try { if (shouldLogFail('fn', msg)) console.warn(`[adaptive-timer] ${name || '(이름 없음)'} 실행 실패: ${msg} — 다음 주기에 다시 실행합니다(같은 오류는 1시간에 한 번만 적습니다)`); } catch { /* 로그가 타이머를 멈추지 않게 */ }
    }
    finally { inFlight = false; lastEndAt = Date.now(); ranOnce = true; }
    if (!stopped) {
      const ms = safeMs();
      armedMs = numOrNull(ms);   // 못 읽은 주기(null·빈 값)를 0 으로 기억하지 않는다
      arm(ms);
    }
  };
  arm(firstDelayMs);
  // 첫 실행 예정 시각(하한·상한·NaN 처리를 거친 값) — 첫 실행 전 알림은 이보다 늦게 미루지 않는다.
  const firstFireAt = fireAt;
  // 주기 변경 시 재무장 — 마지막 실행 종료 뒤 이미 흘린 시간을 빼고 다시 잡는다(주기를 늘렸다고 방금 돈 작업을
  // 또 돌리지 않고, 줄였다면 남은 시간이 음수가 되어 바로 다음 틱으로 간다). 주기가 그대로면 아무것도 하지 않는다.
  // v2.743(감사 TIMING-01 — 재현): 첫 실행 전에 알림이 오면 예전에는 firstDelayMs 를 버리고 '주기 − 경과(생성 기준)' 로 재무장했다.
  //   엣지 재시작마다 설정 pull(첫 실행 10~20초)이 중앙 주기를 적용하며 알리므로, 스토리지 첫 수집이 15초가 아니라 약 1시간 뒤,
  //   PDU 첫 수집이 45초가 아니라 약 5분 뒤가 됐다(armedMs 가 null 이라 '값이 같으면 건너뜀' 도 동작하지 않았다).
  //   첫 실행 전에는 min(첫 실행 예정 시각, 생성 시각 + 새 주기) 로 잡는다 — firstDelay 를 지키되 새 주기가 더 짧으면 당긴다.
  //   그 시각이 지금 무장된 시각과 같으면 건드리지 않는다. 주기를 못 읽으면 firstDelay 그대로(못 읽은 값으로 첫 실행을 미루지 않는다).
  //   첫 실행이 끝난 뒤의 규칙(실행 끝 기준 · 같은 값 알림은 그대로 — v2.741 TIMING-05)은 바꾸지 않는다.
  const off = subscribe ? subscribe(() => {
    if (stopped || inFlight) return;   // 실행 중이면 종료 시 tick 이 새 주기로 재무장한다
    const ms = safeMs();
    const n = numOrNull(ms);
    if (!ranOnce) {
      const target = n != null ? Math.min(firstFireAt, lastEndAt + Math.max(1_000, n)) : firstFireAt;
      const now = Date.now();
      if (target === fireAt) return;
      if (target < fireAt && fireAt <= now + 1_000) return;   // 이미 하한(1초) 안에 울린다 — 더 당길 수 없고, 다시 걸면 밀리기만 한다
      const next = target - now;
      if (name) console.log(`[adaptive-timer] ${name} 타이머 재무장(첫 실행 전): ${Math.round(Math.max(1_000, next) / 1000)}초 후`);
      arm(next);
      return;
    }
    if (armedMs != null && n != null && n === armedMs) return;
    armedMs = n;
    const next = n != null ? n - (Date.now() - lastEndAt) : ms; // 못 읽으면 arm 이 60초로
    if (name) console.log(`[adaptive-timer] ${name} 타이머 재무장: ${Math.round(Math.max(1_000, next) / 1000)}초 후`);
    arm(next);
  }) : null;
  return { stop() { stopped = true; off?.(); clearTimeout(timer); } };
}
