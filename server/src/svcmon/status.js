/**
 * 점검 표시 상태 판정 — **'중지'와 '아직 점검 안 됨'과 '갱신 안 됨'을 반드시 구분한다.**
 *
 * 왜 별 모듈인가: 라우트와 화면이 같은 규칙을 써야 하고(화면은 서버가 내려준 값을 그대로
 * 쓴다), 나이 판정 기준을 두 곳에 두면 갈라진다. 단위 테스트로 고정하기도 쉽다.
 *
 * 왜 구분이 중요한가 — 실측 근거:
 *  - 폴러는 만기가 틱 상한을 넘으면 뒤쪽 항목을 실행하지 못했다(v2.244 에서 원형 커서로
 *    완화). 시뮬레이션에서 15만 항목·주기 60초 구성의 **68%(102,000개)가 1시간 동안 한 번도
 *    실행되지 않았고**, 결과가 없으니 전부 화면에서 '중지(의도적)'로 집계됐다.
 *    감시 공백이 정상 설정으로 위장되는 상태였다.
 *  - 한 번 돈 뒤 굶은 항목은 마지막 결과(예 ok)를 계속 들고 있다. 나이를 보지 않으면
 *    **한 시간 전 ok 가 현재 ok 로 표시된다.** 그래서 `stale` 을 별도 상태로 둔다.
 */

/** 주기의 몇 배를 넘기면 낡음으로 볼지. 3배면 정상 지터·타임아웃에 오탐하지 않는다. */
export const STALE_FACTOR = 3;
/** 주기가 아주 짧은 항목(10초)에서 오탐하지 않도록 두는 하한. */
export const STALE_MIN_MS = 60_000;

export const STATES = ['ok', 'warn', 'bad', 'stale', 'pending', 'disabled'];

/** 그 점검의 결과가 낡았다고 볼 시각 한계(ms). */
export function staleLimitMs(intervalSec) {
  return Math.max(STALE_MIN_MS, (Number(intervalSec) || 60) * 1000 * STALE_FACTOR);
}

/**
 * @param {{enabled?:boolean}} target
 * @param {{id:string, enabled?:boolean, intervalSec?:number}} test
 * @param {Map<string,{status:string, ts:number}>} results
 * @param {number} [now]
 * @returns {'ok'|'warn'|'bad'|'stale'|'pending'|'disabled'}
 */
export function testState(target, test, results, now = Date.now()) {
  if (target?.enabled === false || test?.enabled === false) return 'disabled';
  const r = results?.get(test.id);
  if (!r) return 'pending';                                   // 등록됐지만 아직 실행 안 됨
  if (now - (r.ts || 0) > staleLimitMs(test.intervalSec)) return 'stale';
  return STATES.includes(r.status) ? r.status : 'pending';
}

/** 빈 요약 객체 — 키를 한 곳에서만 정의한다(화면 KPI 와 어긋나지 않게). */
export function emptySummary() {
  return { total: 0, ok: 0, warn: 0, bad: 0, stale: 0, pending: 0, disabled: 0 };
}
