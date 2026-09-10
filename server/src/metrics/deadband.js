/**
 * metrics/deadband.js — 시계열 '변화분만 저장'(dead-band) 판정 (순수 모듈, v2.451).
 *
 * 사용자 관측: "온도는 27, 27, 27, 27... 로 거의 그대로인데 1분마다 다 저장된다."
 * 실제로 host-temp.db 가 34.3GB(운영 실측), idrac-power.db 가 26.9GB 까지 자랐다.
 * 658 호스트 x 1440분 = 94.8만 행/일 이고 보존이 1830일(5년)이라, 채우면 170억 행(약 240GB)이다.
 *
 * 어떻게 줄이나 — **원본만 건너뛰고 롤업은 그대로 갱신한다**:
 *   · 직전 저장값과의 차이가 임계(온도 0.5도 · 전력 3W) 이내면 `samples`/`power_samples` INSERT 를 생략.
 *   · 단 **최대 간격**(기본 30분)이 지나면 값이 같아도 1행을 남긴다. 안 그러면
 *     (1) 짧은 버킷 조회에서 구간 시작점을 못 찾고 (2) '수집 중단' 과 '값이 안 변함' 을 구분할 수 없다.
 *   · 시간당 롤업(samples_hourly / power_hourly)은 **모든 샘플로 갱신**한다. 시간당 1행이라 용량
 *     부담이 없고, 평균·최소·최대가 정확히 남아 생략된 미세 진동도 관측할 수 있다.
 *   · 조회는 마지막 값을 유지(step)해 이어붙이므로 화면상 공백이 생기지 않는다 — vmtrack 의
 *     diff-저장(v2.353)과 같은 방식이며 그때 이미 검증된 패턴이다.
 *
 * 정직한 한계: 생략된 구간의 **분 단위 원본은 복원되지 않는다**(그 시간대 평균·최소·최대만 남는다).
 * 임계보다 작은 진동을 분 단위로 봐야 하는 분석에는 맞지 않으므로, 임계를 0 으로 두면 기능이 꺼진다.
 */

/** 계열별 기본 정책. eps=0 이면 그 계열은 dead-band 를 쓰지 않는다(전량 저장). */
export const DEFAULT_POLICY = Object.freeze({
  // 온도 — 0.5도 미만 변화는 운영 판단에 영향이 없다(경고선은 32/40도 단위).
  temp: { eps: 0.5, maxGapMs: 30 * 60_000 },
  // 전력(W) — 유휴 서버는 몇 W 안에서 진동한다. 3W 는 500W 서버 기준 0.6%.
  power: { eps: 3, maxGapMs: 30 * 60_000 },
});

/** metric 이름 -> 정책 키. 매핑에 없으면 null(= dead-band 미적용, 전량 저장). */
export function policyKeyFor(metric) {
  const m = String(metric || '');
  if (m.startsWith('temp_') || m.startsWith('roomtemp_')) return 'temp';
  if (m === 'power' || m.startsWith('power_')) return 'power';
  return null;
}

/**
 * 이 샘플을 원본 테이블에 저장해야 하는가.
 * @param {{v:number, ts:number}|null} prev  같은 (metric,k) 의 **마지막으로 저장한** 샘플
 * @param {{v:number, ts:number}} cur        이번 샘플
 * @param {{eps:number, maxGapMs:number}} p  정책
 * @returns {boolean}
 */
export function shouldStore(prev, cur, p) {
  if (!p || !(p.eps > 0)) return true;              // 정책 없음/비활성 -> 전량 저장
  if (!prev) return true;                            // 첫 샘플은 반드시 저장(기준선)
  if (!Number.isFinite(cur?.v)) return true;         // 이상값 판단은 여기서 하지 않는다
  if (!Number.isFinite(prev.v)) return true;
  if (cur.ts - prev.ts >= p.maxGapMs) return true;   // 최대 간격 — 값이 같아도 살아있음을 남긴다
  return Math.abs(cur.v - prev.v) >= p.eps;          // 임계 이상 변화만 저장
}

/**
 * 행 묶음을 '저장할 것'과 '생략할 것'으로 가른다. 롤업은 호출부가 **생략분까지 전부** 갱신한다.
 * @param {{metric:string,k:string,v:number}[]} rows
 * @param {number} ts 이 묶음의 공통 시각
 * @param {Map<string,{v:number,ts:number}>} lastKept  `${metric} ${k}` -> 마지막 저장 샘플(호출부가 보관)
 * @param {object} policy
 * @returns {{store: object[], skipped: number}}
 */
export function splitByDeadband(rows, ts, lastKept, policy = DEFAULT_POLICY) {
  const store = [];
  let skipped = 0;
  for (const r of rows || []) {
    const pk = policyKeyFor(r.metric);
    const p = pk ? policy[pk] : null;
    if (!p) { store.push(r); continue; }
    const key = `${r.metric} ${r.k}`;
    const prev = lastKept.get(key) || null;
    if (shouldStore(prev, { v: r.v, ts }, p)) {
      store.push(r);
      lastKept.set(key, { v: r.v, ts });
    } else {
      skipped++;
    }
  }
  return { store, skipped };
}

/** env 로 정책 조정(0 = 그 계열 비활성). 값이 없거나 이상하면 기본값 유지. */
export function policyFromEnv(env = process.env) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    temp: {
      eps: num(env.METRICS_DEADBAND_TEMP_C, DEFAULT_POLICY.temp.eps),
      maxGapMs: Math.max(60_000, num(env.METRICS_DEADBAND_MAX_GAP_MS, DEFAULT_POLICY.temp.maxGapMs)),
    },
    power: {
      eps: num(env.METRICS_DEADBAND_POWER_W, DEFAULT_POLICY.power.eps),
      maxGapMs: Math.max(60_000, num(env.METRICS_DEADBAND_MAX_GAP_MS, DEFAULT_POLICY.power.maxGapMs)),
    },
  };
}
