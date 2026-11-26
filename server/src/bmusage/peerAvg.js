/**
 * bmusage/peerAvg.js — **여러 서버의 구간 평균(CPU · 메모리 · 전력) + 지금 값(흡기 온도)** 을 한 번에(v3.47 물리서버 ‘같은 묶음 대비’).
 *
 *  · 그 서버를 수집하는 노드가 만든다 — 이 노드 서버는 라우트가, 엣지 위임 서버는 그 엣지의 collector 대행(`POST /api/collector/bm-usage/peer-avg`)이 같은 함수로.
 *    중앙은 **엣지마다 요청 1개**만 보낸다(서버마다 WAN 을 왕복하지 않는다 — 루트 CLAUDE.md ‘작업 하나를 법인 쪽에’). 보관 없음(중앙은 받기만).
 *  · 평균은 서버 비교(6단계)와 같은 계열 통계(`multiCompare.compareSeriesFor` — 추이 `trendFor` · 해상도 자동 · 결측은 뺀다)에서 낸다(판정 복제 없음).
 *    전력 평균은 이 노드의 전력 시간당 롤업(`idrac/db.js hourlyStats` — 변화분만 저장해도 롤업은 생략분까지 센다 · 서버당 행 25개 안팎의 PK 범위 조회).
 *    흡기 온도는 이 노드가 이미 가진 iDRAC 사실(`hwFacts` — 장비 왕복 0 · 오래된 값은 null).
 *  · 통계마다 **구간 비율 `cov`**(창을 같은 길이로 나눈 칸 중 값이 있는 칸의 비율)을 함께 낸다 — ‘24시간 평균’ 으로 볼지는 중앙의 판정 코어가 정한다(bmcheck/peer.js avgValueOf).
 *  · **사용률 수집 대상이 아니어도**(그 법인 수집 꺼짐 · OS 계정 없음 — `currentTargets().skipped`) 이 노드에 등록된 서버면 전력 · 흡기 온도는 답한다 —
 *    그 값은 주 iDRAC 폴러가 사용률 수집과 무관하게 읽고 있다(CPU · 메모리는 null). 다른 노드가 맡은 서버(엣지 위임)는 여기 값이 없다(모르는 키로 센다).
 *    iDRAC 값은 등록부 id 로 찾는다(`target.idrac.regId` — 사용률의 iDRAC 경로가 켜진 대상 · 없으면 함대 목록의 `serverId`).
 *  · 이 노드의 목록에 없는 키는 건너뛰고 수를 밝힌다(`unknown`). 못 읽은 값은 null(0 으로 채우지 않는다) · 자격증명 · 주소를 싣지 않는다(키와 수뿐).
 */
import { config } from '../config.js';
import { numOrNull } from '../util/numOrNull.js';

export const PEER_KEYS_MAX = 80;
export const PEER_AVG_METRICS = Object.freeze(['cpu_pct', 'mem_pct']);
const n = numOrNull;
const t = (v) => (typeof v === 'string' ? v.trim().slice(0, 256) : '');
const HOUR = 3_600_000;
/** 흡기 온도 ‘지금 값’ 의 신선도 상한 — 사용률 수집 주기(최대 6시간)에 묶지 않는다(반증 A6: 17시간 전 표본이 ‘지금 값’ 으로 실렸다). */
export const PEER_INLET_FRESH_MS = 30 * 60_000;
/** 이 노드가 수집하지 않는 서버의 제외 사유(bmusage/targets.js) — 값은 그 서버를 맡은 노드에 있다. */
const ELSEWHERE = new Set(['edge-delegated', 'remote-collector-unknown']);
const r2 = (v) => Math.round(v * 100) / 100;

/** 계열 통계(`seriesStats`) → { avg, n, expected, cov } — cov = 값이 있는 스파크 칸 ÷ 칸 수(칸이 없으면 null). */
export function statWithCoverage(s) {
  if (!s || typeof s !== 'object' || s.error) return null;
  const spark = Array.isArray(s.spark) ? s.spark : [];
  const filled = spark.filter((p) => Array.isArray(p) && n(p[1]) != null).length;
  return { avg: n(s.avg), n: n(s.n), expected: n(s.expected), cov: spark.length ? r2(filled / spark.length) : null };
}
/** 전력 시간당 행([{ ts, avg }]) → { avg, n(값이 있는 시간 수), expected(창의 시간 수), cov }. 시간마다 같은 무게(표본이 많은 시간이 평균을 끌지 않는다). */
export function powerStatOf(rows, from, to) {
  if (!Array.isArray(rows)) return null;
  const vals = rows.map((r) => n(r?.avg)).filter((v) => v != null);
  const hours = Math.max(1, Math.ceil((to - from) / HOUR));
  return { avg: vals.length ? Math.round((vals.reduce((x, y) => x + y, 0) / vals.length) * 10) / 10 : null, n: vals.length, expected: hours, cov: Math.min(1, r2(vals.length / hours)) };
}

/** 요청 키 정리 — 글자만 · 256자 · 중복 제거 · 상한. */
export function cleanPeerKeys(keys) {
  const out = []; const seen = new Set();
  for (const k of Array.isArray(keys) ? keys.slice(0, PEER_KEYS_MAX * 4) : []) {
    const s = t(k);
    if (!s || seen.has(s)) continue;
    seen.add(s); out.push(s);
    if (out.length >= PEER_KEYS_MAX) break;
  }
  return out;
}

/**
 * @param {{ keys:string[], from:number, to:number, now?:number, deps?:object }} o
 * @returns {Promise<{ ok:true, from:number, to:number, rows:Array<{ key:string, cpu:{avg:number|null,n:number|null,expected:number|null,cov:number|null}|null, mem:object|null, power:object|null, inletC:number|null, sensorAt:number|null }>, unknown?:number } | { __status:number, ok:false, reason:string }>}
 */
export async function peerAvgFor({ keys, from, to, now = Date.now(), deps = {} } = {}) {
  const a = n(from); const b = n(to);
  if (a == null || b == null || !(a < b) || b - a > 8 * 86_400_000) return { __status: 400, ok: false, reason: 'from · to 가 올바르지 않습니다(최대 8일).' };
  const agent = config.agent?.name || '';
  const D = {
    settings: async () => (await import('./settings.js')).loadBmUsageSettings(),
    targets: async () => (await import('./poller.js')).currentTargets(),
    trend: async (o) => (await import('./trendQuery.js')).trendFor(o),
    hwReader: async (o) => (await import('./hwFacts.js')).hwFactsReader(o),
    freshMs: async (ms) => (await import('./useJudge.js')).freshMsFor(ms),
    powerDb: async () => (await import('../idrac/db.js')).getDb(),
    ...deps,
  };
  const [settings, tg, M, { createYielder }] = await Promise.all([D.settings(), D.targets(), import('./multiCompare.js'), import('../util/timeSlice.js')]);
  // 같은 키가 둘이면 첫 대상(엣지 대행의 다른 경로 bmSnapTarget 과 같다)
  const byKey = new Map();
  for (const x of Array.isArray(tg?.targets) ? tg.targets : []) if (x && typeof x.key === 'string' && !byKey.has(x.key)) byKey.set(x.key, x);
  // 사용률 수집 대상은 아니지만 이 노드에 등록된 서버 — 전력 · 흡기 온도만. 다른 노드가 맡은 서버는 뺀다.
  const idOnly = new Map();
  for (const x of Array.isArray(tg?.skipped) ? tg.skipped : []) {
    if (!x || typeof x.key !== 'string' || !t(x.serverId) || ELSEWHERE.has(x.reason) || byKey.has(x.key) || idOnly.has(x.key)) continue;
    idOnly.set(x.key, x);
  }
  let hwOf = () => null;
  try { hwOf = await D.hwReader({ agent, now, freshMs: Math.min(PEER_INLET_FRESH_MS, (await D.freshMs(settings?.intervalMs)) || PEER_INLET_FRESH_MS) }); } catch { hwOf = () => null; }
  let idb = null;
  try { idb = await D.powerDb(); } catch { idb = null; }
  const powerOf = async (id) => {
    if (!id || typeof idb?.hourlyStats !== 'function') return null;   // 등록부 id 를 모르는 서버 · 전력 DB 없음 — 평균 없음(0 이 아니다)
    try { return powerStatOf(await idb.hourlyStats(id, Math.floor(a), Math.floor(b)), a, b); } catch { return null; }
  };
  const yieldFn = createYielder(15);
  const rows = []; let unknown = 0;
  for (const k of cleanPeerKeys(keys)) {
    const target = byKey.get(k) || null;
    const who = target || idOnly.get(k) || null;
    if (!who) { unknown += 1; continue; }
    let r = null;
    if (target) { try { r = await M.compareSeriesFor({ agent, key: k, metrics: PEER_AVG_METRICS, from: Math.floor(a), to: Math.floor(b), settings, trendFor: D.trend, yieldFn }); } catch { r = null; } }
    const regId = t(target?.idrac?.regId) || t(who.serverId);
    let hw = null;
    try { hw = regId ? hwOf({ serviceTag: who.serviceTag, idrac: { regId } }) : null; } catch { hw = null; }
    rows.push({ key: k, cpu: statWithCoverage(r?.metrics?.cpu_pct), mem: statWithCoverage(r?.metrics?.mem_pct), power: await powerOf(regId), inletC: n(hw?.inletC), sensorAt: n(hw?.sensorAt) });
    await yieldFn();
  }
  return { ok: true, from: Math.floor(a), to: Math.floor(b), rows, ...(unknown ? { unknown } : {}) };
}
