/**
 * GPU '실제로 동작하는가' 판정(v2.650 — 사용자 요청 "GPU 메모리 점유/사용량" + "GPU 온도도 같이 수집해서 실제로 GPU 가
 * 동작하는지 점검"). 순수 함수 — 서버 응답과 테스트가 같이 쓴다(웹은 결과 `state` 를 읽기만 한다).
 *
 * 판정 근거는 게스트 nvidia-smi 의 세 값이고 **서로 다른 것을 잰다**:
 *   · 사용률(utilization.gpu) — 샘플 구간 중 커널(연산)이 돌던 시간 비율
 *   · 메모리 점유(memory.used/total) — VRAM 을 얼마나 잡고 있나(모델을 올려 두기만 해도 높다)
 *   · 온도(temperature.gpu) — 센서값. **판정에 쓰지 않는다** — GPU 모델·냉각·흡기 온도에 따라 유휴/부하 온도가 달라
 *     포탈이 임계를 정하면 틀린 판정이 된다(CLAUDE.md '임계값을 지어내지 말 것'). 대신 '센서가 응답했다' 는 사실과
 *     값 자체를 근거로 나란히 보여 준다 — 사용률이 높다는데 온도가 유휴 수준이면 사람이 이상을 알아챈다.
 *
 * 상태(겹치지 않는다):
 *   busy    연산 중          사용률 ≥ BUSY_UTIL_PCT
 *   held    메모리 점유·유휴  사용률 < BUSY_UTIL_PCT 이고 메모리 점유 ≥ HELD_MEM_PCT (모델을 올려 두고 요청이 없는 서버 등)
 *   idle    유휴             사용률 < BUSY_UTIL_PCT 이고 메모리 점유가 낮거나 모름
 *   unknown 판정 불가         사용률을 모름(미수집·MIG) — **정상으로도 유휴로도 세지 않는다**
 */
import { numOrNull } from '../util/numOrNull.js';

export const BUSY_UTIL_PCT = 10;
export const HELD_MEM_PCT = 10;
export const ACTIVITY_STATES = Object.freeze(['busy', 'held', 'idle', 'unknown']);

/**
 * @param {{utilPct?:number|null, utilNA?:boolean, memUsedPct?:number|null, tempC?:number|null}} g
 * @returns {{state:string, reason:string|null, tempRead:boolean}}
 */
export function gpuActivity(g) {
  if (!g || typeof g !== 'object') return { state: 'unknown', reason: 'no-data', tempRead: false };
  const util = numOrNull(g.utilPct);
  const mem = numOrNull(g.memUsedPct);
  const tempRead = numOrNull(g.tempC) != null;
  if (g.utilNA) return { state: 'unknown', reason: 'mig', tempRead };
  if (util == null) return { state: 'unknown', reason: 'no-util', tempRead };
  if (util >= BUSY_UTIL_PCT) return { state: 'busy', reason: null, tempRead };
  if (mem != null && mem >= HELD_MEM_PCT) return { state: 'held', reason: null, tempRead };
  return { state: 'idle', reason: mem == null ? 'no-mem' : null, tempRead };
}

/** 상태별 개수 — 합계 = busy + held + idle + unknown(겹치지 않는다). */
export function activityCounts(list) {
  const out = { busy: 0, held: 0, idle: 0, unknown: 0 };
  for (const x of list || []) out[ACTIVITY_STATES.includes(x) ? x : 'unknown'] += 1;
  return out;
}
