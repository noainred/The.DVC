/**
 * Ping 모니터링 조회 서비스 — 대상별 현재 상태(최신 RTT + baseline 대비 분류)와
 * 시계열(다운샘플 + 버킷별 색상 상태)을 제공한다.
 *
 * 상태 분류(파이썬 원본의 baseline 편차 규칙 이식):
 *   down : 무응답(최신 샘플 ok=false)
 *   crit : rtt ≥ baseline × 1.5 (기준 대비 +50% 이상)
 *   warn : rtt ≥ baseline × 1.2 (기준 대비 +20% 이상)
 *   ok   : 그 외 정상
 *   unknown: 샘플/기준 없음
 * baseline은 대상의 수동 baselineMs가 있으면 그 값, 없으면 최근 OK 샘플의 중앙값(자동).
 */

import { getPingDb, HOUR_MS } from './db.js';
import { snapMemo } from '../util/snapCache.js';
import { listTargets, getTarget } from './store.js';
import { config } from '../config.js';

const WARN = 1.2;
const CRIT = 1.5;
const BASELINE_SAMPLES = 200; // 자동 baseline 산출에 쓰는 최근 OK 샘플 수
// v2.605(감사 DB2605-01): baseline 은 최근 7일 안의 OK 표본만 본다 — 하한이 없으면 OK 가 없던 대상의 조회가
// 그 대상 이력 전체를 훑는다(1년 보존 ≈ 52만 행). 7일 동안 OK 가 없으면 baseline 은 null(자동 기준 없음)이다.
export const BASELINE_LOOKBACK_MS = 7 * 86_400_000;

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function baselineOf(db, target) {
  if (target.baselineMs) return { baseline: target.baselineMs, auto: false };
  const recent = db.recentOkRtt(target.id, BASELINE_SAMPLES, Date.now() - BASELINE_LOOKBACK_MS);
  const med = median(recent);
  return { baseline: med == null ? null : Number(med.toFixed(2)), auto: true };
}

function classify(rtt, ok, baseline) {
  if (!ok || rtt == null) return 'down';
  if (baseline == null) return 'ok';
  if (rtt >= baseline * CRIT) return 'crit';
  if (rtt >= baseline * WARN) return 'warn';
  return 'ok';
}

/**
 * v2.604(감사 DB2604-01 — 재현: 28대상 × 1분 주기 1년 = 1,470만 행에서 365일 개요가 동기 10.2초, 30일 0.9초).
 * 버킷이 1시간 이상이면 **시간당 롤업**(ping/db.js samples_hourly)을 읽는다 — 그러려면 버킷이 1시간의 배수여야
 * 하므로 올림한다(30일 = 2.4h → 3h, 365일 = 29.2h → 30h). 점 수가 조금 줄 뿐이고 실제 버킷은 응답의
 * `bucketMs` 가 말한다(숫자를 화면에 박지 않는다). 롤업 시드가 끝나지 않았으면 원시로 떨어지고 `source` 가 그렇게 말한다.
 */
export function planBuckets(rangeMs, points) {
  const raw = Math.max(1000, Math.round(rangeMs / points));
  if (raw < HOUR_MS) return { bucketMs: raw, hourly: false };
  return { bucketMs: Math.ceil(raw / HOUR_MS) * HOUR_MS, hourly: true };
}
function readHistory(db, id, since, plan, points) {
  if (plan.hourly && db.historyHourly) {
    const r = db.historyHourly(id, since, plan.bucketMs, points);
    if (r) return { rows: r, source: 'hourly' };
  }
  return { rows: db.history(id, since, plan.bucketMs, points), source: 'raw' };
}

/** 대상의 현재 상태 요약(대시보드 상단 카드/목록용). sources 지정 시 해당 출처만. */
export async function statusAll(sources = null) {
  const db = await getPingDb();
  const set = Array.isArray(sources) ? new Set(sources) : null;
  const targets = listTargets().filter((t) => (set ? set.has(t.source) : true));
  const rows = [];
  let first = true;
  for (const t of targets) {
    // v2.605(감사 DB2605-01): 대상 사이 양보 — 대상마다 동기 SQL 이라 한 턴에 몰리면 루프를 막는다(overviewGroupedNow 와 같게).
    // await baselineOf 는 마이크로태스크라 양보가 아니다.
    if (!first) await new Promise((r) => setImmediate(r));
    first = false;
    const latest = db.latest(t.id);
    const { baseline, auto } = await baselineOf(db, t);
    const status = latest ? classify(latest.rtt, latest.ok, baseline) : 'unknown';
    rows.push({
      id: t.id, name: t.name, host: t.host, port: t.port, kind: t.kind, enabled: t.enabled, note: t.note, source: t.source,
      rtt: latest ? latest.rtt : null, ok: latest ? latest.ok : null, lastTs: latest ? latest.ts : null,
      baseline, baselineAuto: auto, status,
    });
  }
  const counts = rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  // v2.575 BUG-16: 화면이 '기다리면 채워진다' 와 '기다려도 안 된다' 를 구분할 수 있게 폴러
  // 전역 스위치와 주기를 함께 싣는다(주기 숫자를 화면에 박지 말 것 — 루트 CLAUDE.md v2.493).
  return {
    targets: rows, counts, total: rows.length,
    monitorEnabled: !!config.ping.enabled, intervalMs: config.ping.pollIntervalMs,
  };
}

/** 단일 대상의 시계열(다운샘플). rangeMs 범위를 최대 points개 버킷으로 나눠 avg/min/max/loss + 상태. */
export async function seriesOf(id, { rangeMs = 6 * 3_600_000, points = 240 } = {}) {
  const t = getTarget(id);
  if (!t) return { ok: false, reason: '없는 대상' };
  const db = await getPingDb();
  const now = Date.now();
  const since = now - rangeMs;
  // 버킷 크기: 범위/포인트, 최소 1초(1시간 이상이면 1시간 배수로 올려 롤업을 읽는다). 최근 points개 버킷만.
  const plan = planBuckets(rangeMs, points);
  const { bucketMs } = plan;
  const { rows: raw, source } = readHistory(db, t.id, since, plan, points);
  const { baseline, auto } = await baselineOf(db, t);
  const series = raw.map((b) => ({
    ts: b.ts, avg: b.avg, min: b.min, max: b.max, loss: b.loss, n: b.n,
    status: b.loss >= 1 ? 'down' : classify(b.avg, b.avg != null, baseline),
  }));
  // v2.612 LEFT2612-05: 건수(COUNT)는 대상 이력 전체를 훑는데 화면이 쓰지 않는다 — 첫/끝 시각만(구현이 없으면 예전 meta).
  const meta = db.bounds ? db.bounds(t.id) : db.meta(t.id);
  // v2.575 BUG-16: rangeMs 를 함께 실어 화면이 '마지막 측정이 조회 기간 밖' 을 구분할 수 있게 한다.
  return { ok: true, target: { id: t.id, name: t.name, host: t.host, port: t.port, kind: t.kind, enabled: t.enabled }, baseline, baselineAuto: auto, bucketMs, rangeMs, series, source, meta };
}

/**
 * 특정 출처(source)의 모든 대상 시계열을 groupKey로 그룹핑해 한 번에 반환(그룹 대시보드용).
 * 각 대상마다 baseline 대비 상태가 색상 코딩된 다운샘플 포인트를 포함한다.
 * @param source 'edge' | 'vcport'
 * @param groupKey 'datacenterId' | 'vcenterId'
 * @param groupName (id)=>표시명 리졸버
 * @param groupOrder 그룹 표시 순서(id 배열; 없는 것은 뒤로)
 */
// 같은 (출처·범위·점 수) 개요는 짧게 공유한다 — 동시 요청·탭이 같은 집계를 반복하지 않게(single-flight + TTL).
// 결과에는 주소가 들어 있으나 가림은 라우트가 요청자마다 따로 한다(캐시 값은 가리기 전 원본 — 라우트가 복사해 가린다).
const OVERVIEW_TTL_MS = 10_000;
export async function overviewGrouped(source, groupKey, opts = {}) {
  const { rangeMs = 86_400_000, points = 300 } = opts;
  return snapMemo('ping-overview', `${source}:${groupKey}:${rangeMs}:${points}`, OVERVIEW_TTL_MS, () => overviewGroupedNow(source, groupKey, opts));
}

async function overviewGroupedNow(source, groupKey, { rangeMs = 86_400_000, points = 300, groupName = (x) => x, groupOrder = [] } = {}) {
  const db = await getPingDb();
  const targets = listTargets(source);
  const now = Date.now();
  const since = now - rangeMs;
  const plan = planBuckets(rangeMs, points);
  const { bucketMs } = plan;
  const groups = new Map();
  const sources = new Set();
  let first = true;
  for (const t of targets) {
    // 대상 사이에 양보한다 — 대상 하나의 조회는 짧아도 28개를 한 턴에 몰면 그만큼 루프가 멈춘다.
    if (!first) await new Promise((r) => setImmediate(r));
    first = false;
    const { baseline } = await baselineOf(db, t);
    const { rows: raw, source: src } = readHistory(db, t.id, since, plan, points);
    sources.add(src);
    const latest = db.latest(t.id);
    const series = raw.map((b) => ({ ts: b.ts, rtt: b.avg, loss: b.loss, status: b.loss >= 1 ? 'down' : classify(b.avg, b.avg != null, baseline) }));
    const item = {
      id: t.id, name: t.name, host: t.host, port: t.port, enabled: t.enabled,
      baseline, status: latest ? classify(latest.rtt, latest.ok, baseline) : 'unknown', rtt: latest ? latest.rtt : null, lastTs: latest ? latest.ts : null,
      series,
    };
    const gid = t[groupKey] || '';
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push(item);
  }
  const rank = new Map(groupOrder.map((id, i) => [String(id), i]));
  const out = [...groups.entries()]
    .map(([gid, items]) => ({ id: gid, name: gid ? groupName(gid) : '미지정', items: items.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true })) }))
    .sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ra - rb || a.name.localeCompare(b.name, 'ko', { numeric: true });
    });
  // source: 'hourly'(롤업) · 'raw'(원시) · 'mixed'(롤업 시드 중 일부만) — 대상이 없으면 계획대로.
  const srcOut = sources.size > 1 ? 'mixed' : (sources.size ? [...sources][0] : (plan.hourly ? 'hourly' : 'raw'));
  return { ok: true, bucketMs, rangeMs, source: srcOut, groups: out, total: targets.length };
}
