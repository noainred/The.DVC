/**
 * 법인 전산실 온도 시계열(v2.384) — 흡기·배기·CPU 를 **법인 단위 집계**로 metrics DB 에 적재한다.
 *
 * 왜 필요한가: iDRAC 센서는 sensorStore(인메모리 24시간)에만 있어서 '1주·1달·1년 추이' 를
 * 그릴 데이터가 아예 없었다(24시간 넘으면 빈 차트). 이 모듈이 샘플러 틱마다 법인별 평균·최고를
 * 시계열로 남겨 장기 추이를 가능하게 한다.
 *
 * ⚠ 서버별 시계열은 만들지 않는다 — 965 서버 × 3종 × 시간당이면 연 2,500만 행이다.
 *   법인 단위면 (법인 수 × 6) 행/샘플로 유계다. 서버별 현재값은 화면(법인 카드 › 서버별 보기)이
 *   실시간 소스에서 그대로 보여준다.
 *
 * 메트릭 키 규약(공용 metrics DB — 온도/GPU 계열과 같은 테이블):
 *   roomtemp_inlet_avg / roomtemp_inlet_max
 *   roomtemp_exhaust_avg / roomtemp_exhaust_max
 *   roomtemp_cpu_avg / roomtemp_cpu_max
 *   k = 법인 id, k='' = 전체 합계. 60분+ 조회는 samples_hourly 롤업이 자동 사용된다.
 */

import { roomTempReport, UNASSIGNED_KEY } from './roomTemp.js';
import { analysisServersWithRemote } from '../insights/analysisServers.js'; // v2.579: ARCH-04

export const ROOMTEMP_METRICS = [
  'roomtemp_inlet_avg', 'roomtemp_inlet_max',
  'roomtemp_exhaust_avg', 'roomtemp_exhaust_max',
  'roomtemp_cpu_avg', 'roomtemp_cpu_max',
];

/** 종류(inlet/exhaust/cpu) → 메트릭 이름 쌍. */
export const roomTempMetric = (kind, stat) => `roomtemp_${kind}_${stat}`;

/**
 * 샘플러가 호출 — 현재 온도를 법인별로 집계해 metrics 행 배열로 반환.
 * 값이 없는 종류는 행을 만들지 않는다(0 을 기록해 '급냉'처럼 보이는 것을 방지 — 결측은 결측으로).
 */
export function roomTempRows() {
  // 샘플러는 req 가 없다 — analysisFilter 가 req?.query 로 옵셔널 처리하므로 인자 없이 부르면
  // 필터 없는 **전량**이 온다(확인함). scope 는 조회 라우트가 적용한다.
  const servers = analysisServersWithRemote();
  if (!servers.length) return [];
  // stale 표본은 roomTempReport 기본값(15분)으로 이미 제외된다 — 적재 경로에서 특히 중요하다
  // (죽은 서버의 동결 온도를 매 분 새 타임스탬프로 다시 쓰면 장기 차트가 평탄선이 된다).
  const rep = roomTempReport(servers);
  const rows = [];
  const push = (k, kind, agg) => {
    if (!agg || agg.avg == null) return;
    rows.push({ metric: roomTempMetric(kind, 'avg'), k, v: agg.avg });
    if (agg.max != null) rows.push({ metric: roomTempMetric(kind, 'max'), k, v: agg.max });
  };
  for (const g of rep.groups || []) {
    // 미지정 그룹은 예약키로 적재된다 — '' 는 전체 합계 전용이라 섞이면 두 계열이 오염된다(v2.387).
    push(g.id, 'inlet', g.inlet); push(g.id, 'exhaust', g.exhaust); push(g.id, 'cpu', g.cpu);
  }
  const t = rep.totals || {};
  push('', 'inlet', t.inlet); push('', 'exhaust', t.exhaust); push('', 'cpu', t.cpu);
  return rows;
}

/** 기간 프리셋 — 화면 버튼과 1:1(1일/1주/1달/3개월/6개월/1년). */
export const ROOMTEMP_RANGES = {
  '1d': { spanMs: 86_400_000, bucketMs: 30 * 60_000 },        // 30분(원본 — 1분 샘플이라 촘촘)
  '7d': { spanMs: 7 * 86_400_000, bucketMs: 3_600_000 },      // 1시간(롤업 사용)
  '30d': { spanMs: 30 * 86_400_000, bucketMs: 6 * 3_600_000 },
  '90d': { spanMs: 90 * 86_400_000, bucketMs: 12 * 3_600_000 },
  '180d': { spanMs: 180 * 86_400_000, bucketMs: 86_400_000 },
  '365d': { spanMs: 365 * 86_400_000, bucketMs: 86_400_000 },
};

/**
 * 추이 조회 — { range, bucketMs, collectedSince, points:[{ts, avg, max}] }.
 * 60분 정배수 버킷이면 metrics db.history 가 samples_hourly 롤업을 자동으로 써서
 * 365일 조회도 원본 풀스캔 없이 끝난다(이벤트 루프 보호).
 */
export async function roomTempHistory(db, { kind = 'inlet', group = '', range = '7d' } = {}) {
  const k = ['inlet', 'exhaust', 'cpu'].includes(kind) ? kind : 'inlet';
  // group 은 법인 id | UNASSIGNED_KEY | ''(전체). 프론트가 빈 문자열 파라미터를 생략해도
  // 여기서 ''(전체)로 해석되는 것이 의도다 — 미지정 그룹은 예약키를 명시해야 조회된다.
  const key = String(group || '');
  void UNASSIGNED_KEY;   // 키 규약이 이 모듈에 있음을 명시(적재/조회가 같은 상수를 공유)
  const r = ROOMTEMP_RANGES[range] ? range : '7d';
  const { spanMs, bucketMs } = ROOMTEMP_RANGES[r];
  const since = Date.now() - spanMs;
  const limit = bucketMs <= 3_600_000 ? 3000 : 1500;
  let avgPts = []; let maxPts = []; let meta = { firstTs: null, lastTs: null };
  try {
    avgPts = db.history(roomTempMetric(k, 'avg'), key, since, bucketMs, limit) || [];
    maxPts = db.history(roomTempMetric(k, 'max'), key, since, bucketMs, limit) || [];
    // v2.607 DB2607-01: 그 법인(key)의 첫 관측이다 — meta(metric) 는 k 조건이 없어 계열 전체(전 법인)의
    // 첫 표본을 돌려줘 2일 전부터 수집된 법인에 '수집 시작: 30일 전' 이 떴다. metaKey 는 롤업 포함·
    // aggregate 단독이라 파티션 풀스캔도 없다(v2.504). key '' 는 전체 합계 계열의 키다.
    meta = (typeof db.metaKey === 'function' ? db.metaKey(roomTempMetric(k, 'avg'), key) : null) || meta;
  } catch { /* 시계열 없음 — 빈 결과 */ }
  const byTs = new Map();
  for (const p of avgPts) byTs.set(p.ts, { ts: p.ts, avg: p.avg, max: null });
  for (const p of maxPts) {
    const e = byTs.get(p.ts) || { ts: p.ts, avg: null, max: null };
    e.max = p.max ?? p.avg;          // max 계열은 버킷 내 최댓값이 의미 있다
    byTs.set(p.ts, e);
  }
  return {
    kind: k, group: key, range: r, spanMs, bucketMs,
    collectedSince: meta.firstTs ?? null,
    points: [...byTs.values()].sort((a, b) => a.ts - b.ts),
  };
}

/**
 * 여러 법인의 짧은 추이를 한 번에(v2.534) — 상황실 월보드의 타일 스파크라인용.
 *
 * 왜 따로 두는가: 월보드는 16개 법인 타일을 한 화면에 그리므로 `roomTempHistory` 를 법인마다
 * 부르면 요청이 16번이다. 여기서는 **1시간 버킷**만 쓴다 — `samples_hourly` 롤업이 걸려
 * (metric, k, h) 인덱스 선탐색이 되므로 법인당 비용이 거의 없다(CLAUDE.md: '전 키 1쿼리' 로
 * 합치면 오히려 느려진다 — v2.503 실측).
 *
 * ⚠ **없는 값을 0 으로 만들지 않는다.** 수집이 없던 시간은 점이 없고, 화면은 선을 잇지 않는다.
 *
 * @param {object} db metrics DB
 * @param {{kind?:string, hours?:number, groups?:string[]}} opts
 * @returns {Promise<{kind:string, hours:number, bucketMs:number, since:number,
 *                    groups:Record<string, Array<{ts:number, avg:number|null, max:number|null}>>}>}
 */
export async function roomTempSparks(db, { kind = 'inlet', hours = 24, groups = [] } = {}) {
  const k = ['inlet', 'exhaust', 'cpu'].includes(kind) ? kind : 'inlet';
  const h = Math.max(1, Math.min(168, Number(hours) || 24));
  const bucketMs = 3_600_000;                       // 시간당 롤업을 쓰게 하는 값(60분 정배수)
  const since = Date.now() - h * bucketMs;
  const keys = [...new Set((groups || []).map((g) => String(g ?? '')))].slice(0, 64);
  const out = {};
  for (const key of keys) {
    let avgPts = []; let maxPts = [];
    try {
      avgPts = db.history(roomTempMetric(k, 'avg'), key, since, bucketMs, h + 2) || [];
      maxPts = db.history(roomTempMetric(k, 'max'), key, since, bucketMs, h + 2) || [];
    } catch { /* 시계열 없음 — 빈 배열 */ }
    const byTs = new Map();
    for (const p of avgPts) byTs.set(p.ts, { ts: p.ts, avg: p.avg, max: null });
    for (const p of maxPts) {
      const e = byTs.get(p.ts) || { ts: p.ts, avg: null, max: null };
      e.max = p.max ?? p.avg;
      byTs.set(p.ts, e);
    }
    out[key] = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  }
  return { kind: k, hours: h, bucketMs, since, groups: out };
}
