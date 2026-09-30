/**
 * overview/trend.js — 경영 보기 Overview 핵심 지표 추이(v2.670, 순수 모듈).
 *
 * 사용자 제공 시안 `design_handoff_exec_overview`(경영 보기)의 스파크라인·증감('+12 · 7일')을 만든다.
 * 새로 수집하지 않는다 — 이미 쌓고 있는 세 시계열을 같은 격자로 다시 묶을 뿐이다.
 *   · 가상 서버 수   ← vmtrack(매일 00·12시 스냅샷)       — 카드 값(/overview/cards virtual.count)과 같은 기준(템플릿 포함)
 *   · 스토리지 사용량 ← 스토리지 용량 이력(capacityHistoryAll) — 카드 값(스토리지 모니터링 총용량)과 같은 장비 집합
 *   · 소비 전력      ← iDRAC 전력 시간당 롤업(power_hourly)  — ⚠ **서버 전력만**이다(카드 값은 서버+네트워크+스토리지)
 *   · 물리 서버 수   ← 기록하는 시계열이 없다 → 추이를 만들지 않는다(null — 지어내지 않는다)
 *
 * 정직성 규칙(각 함수 머리말에서 다시 적는다):
 *   ① 격자는 epoch 정렬 버킷이다 — 세 원천이 전부 epoch 정렬로 묶여 있어(vmtrack 슬롯 12시간 간격 · SQL CAST(ts/b)) 한 버킷에
 *      한 원천의 칸이 1:1(또는 정수 배)로 떨어진다.
 *   ② **부분 합은 점을 만들지 않는다**(null) — 빠진 vCenter·장비·서버가 있는 버킷을 그리면 '감소' 라는 거짓이 된다(v2.606 규약).
 *   ③ 관측 이전 구간은 null 이다(값 소급 없음 — v2.345 vmtrack 규약).
 *   ④ 증감은 첫 유효 점과 마지막 유효 점의 차이다. 유효 점이 2개 미만이면 null('—').
 */

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** 기간 → 버킷(시안: 7일=14점 · 30일=30점 · 90일=60점). */
export const TREND_SPECS = Object.freeze({
  7: { days: 7, bucketMs: 12 * HOUR_MS, points: 14 },
  30: { days: 30, bucketMs: 24 * HOUR_MS, points: 30 },
  90: { days: 90, bucketMs: 36 * HOUR_MS, points: 60 },
});

/** 아는 기간만 받는다. 모르면 7일(시안 기본값). */
export function normTrendDays(v) {
  const n = Number(v);
  return TREND_SPECS[n] ? n : 7;
}

/** 격자 — 끝 버킷(지금이 든 버킷)에서 거꾸로 points 개. 오름차순 버킷 시작 시각 배열. */
export function trendGrid(days, nowMs = Date.now()) {
  const s = TREND_SPECS[normTrendDays(days)];
  const last = Math.floor(Number(nowMs) / s.bucketMs) * s.bucketMs;
  const out = [];
  for (let i = s.points - 1; i >= 0; i--) out.push(last - i * s.bucketMs);
  return out;
}

const bucketOf = (ts, b) => Math.floor(Number(ts) / b) * b;

/**
 * 가상 서버 수 — vmtrack 점(`{ts, total, skipped}`) → 버킷마다 **마지막 슬롯**의 VM 수.
 * 그 슬롯에 빠진 vCenter 가 있으면(`skipped > 0`, v2.594 부분 합) 그 버킷은 null + partial.
 */
export function vmTrend(points, days, nowMs = Date.now()) {
  const s = TREND_SPECS[normTrendDays(days)];
  const grid = trendGrid(days, nowMs);
  const last = new Map();
  for (const p of Array.isArray(points) ? points : []) {
    if (!p || !Number.isFinite(Number(p.ts))) continue;
    const k = bucketOf(p.ts, s.bucketMs);
    const cur = last.get(k);
    if (!cur || Number(p.ts) >= Number(cur.ts)) last.set(k, p);
  }
  return grid.map((t) => {
    const p = last.get(t);
    if (!p) return { ts: t, v: null };
    const total = Number(p.total);
    if ((Number(p.skipped) || 0) > 0 || !Number.isFinite(total)) return { ts: t, v: null, partial: true };
    return { ts: t, v: total };
  });
}

/**
 * 스토리지 사용량(바이트) — capacityHistoryAll 점(`{ts, used_bytes, total_bytes, missing, used_unknown}`) 을 격자에 옮긴다.
 * 점은 이미 같은 버킷으로 묶여 온다(호출부가 bucketMs 를 같게 준다). 빠진 장비(missing)나 사용량을 못 읽은 장비가 있으면 null.
 */
export function storageTrend(points, days, nowMs = Date.now()) {
  const s = TREND_SPECS[normTrendDays(days)];
  const grid = trendGrid(days, nowMs);
  const by = new Map();
  for (const p of Array.isArray(points) ? points : []) if (p && Number.isFinite(Number(p.ts))) by.set(bucketOf(p.ts, s.bucketMs), p);
  return grid.map((t) => {
    const p = by.get(t);
    if (!p) return { ts: t, v: null };
    const used = p.used_bytes == null ? null : Number(p.used_bytes);
    if ((Number(p.missing) || 0) > 0 || (Number(p.used_unknown) || 0) > 0 || used == null || !Number.isFinite(used)) return { ts: t, v: null, partial: true };
    return { ts: t, v: used };
  });
}

/** 전력 시간이 '온전하다' 고 보는 서버 수 비율 — 창 안 최대 보고 서버 수 대비. */
export const POWER_FULL_RATIO = 0.9;
/** 칸마다 읽는 대표 시간 수(버킷 안에서 고르게). */
export const POWER_SAMPLES_PER_BUCKET = 2;

/**
 * 전력 표본 시간 — 칸마다 `POWER_SAMPLES_PER_BUCKET` 개의 시간 인덱스(hb)를 고르게 고른다. 지금 이후 시간은 뺀다.
 * ⚠ 창 전체를 서버별로 훑지 않는 이유: 90일 × 서버 1천 대 = 216만 행 → 실측 3.7초 동기 정지(v2.670). 칸 값은
 *   '칸 전체 평균' 이 아니라 **대표 시간들의 평균**이다 — 화면 각주가 그렇게 말한다.
 */
export function powerSampleHours(days, nowMs = Date.now()) {
  const s = TREND_SPECS[normTrendDays(days)];
  const per = Math.round(s.bucketMs / HOUR_MS);
  const k = Math.min(POWER_SAMPLES_PER_BUCKET, per);
  const nowHb = Math.floor(Number(nowMs) / HOUR_MS);
  const out = [];
  for (const t of trendGrid(days, nowMs)) {
    const hb0 = Math.floor(t / HOUR_MS);
    for (let i = 0; i < k; i++) {
      const hb = hb0 + Math.floor(((i + 0.5) * per) / k);
      if (hb <= nowHb) out.push(hb);
    }
  }
  return out;
}

/**
 * 서버 전력(와트) — 시간별 합(`{hb, watts, servers}` — 그 시간 서버별 평균의 합) → 칸 값.
 * ⚠ 보고 서버 수가 **직전 2칸(자기 칸 포함) 안의 최대**의 90% 미만인 시간은 버린다 — 엣지 push 가 늦거나 서버 몇 대가 빠진
 *   시간을 '전력 감소' 로 그리지 않는다. 기준을 '창 전체 최대' 로 두면 서버가 늘어난 현장(90일에 20% 증설)에서 증설 이전 칸이
 *   **전부** 지워진다(v2.670 목 데이터로 재현) — 그래서 뒤를 보는 짧은 창이다. 증설은 곧바로 기준이 되고, 영구 감축은 2칸 뒤부터
 *   다시 그려진다. 칸에 남은 시간이 없으면 null + partial. 90% 는 판단이다 — 응답의 `fullRatio` 로 밝힌다.
 */
export function powerTrend(hourRows, days, nowMs = Date.now()) {
  const s = TREND_SPECS[normTrendDays(days)];
  const grid = trendGrid(days, nowMs);
  const rows = (Array.isArray(hourRows) ? hourRows : [])
    .filter((r) => r && Number.isFinite(Number(r.hb)) && Number.isFinite(Number(r.watts)))
    .map((r) => ({ hb: Number(r.hb), watts: Number(r.watts), servers: Number(r.servers) || 0 }))
    .sort((a, b) => a.hb - b.hb);
  const lookback = 2 * Math.round(s.bucketMs / HOUR_MS);
  let maxServers = 0;
  const by = new Map();
  for (let i = 0, j = 0; i < rows.length; i++) {
    const r = rows[i];
    while (rows[j].hb < r.hb - lookback) j += 1;
    let ref = 0;
    for (let k = j; k <= i; k++) ref = Math.max(ref, rows[k].servers);
    if (r.hb * HOUR_MS >= grid[0]) maxServers = Math.max(maxServers, r.servers);
    const bk = bucketOf(r.hb * HOUR_MS, s.bucketMs);
    const a = by.get(bk) || { ok: [] };
    if (r.servers >= Math.ceil(ref * POWER_FULL_RATIO)) a.ok.push(r.watts);
    by.set(bk, a);
  }
  const series = grid.map((t) => {
    const a = by.get(t);
    if (!a) return { ts: t, v: null };
    if (!a.ok.length) return { ts: t, v: null, partial: true };
    return { ts: t, v: Math.round(a.ok.reduce((x, y) => x + y, 0) / a.ok.length) };
  });
  return { series, maxServers, fullRatio: POWER_FULL_RATIO };
}

/** 증감 — 첫 유효 점 → 마지막 유효 점. 유효 점이 2개 미만이면 null. */
export function deltaOf(series) {
  const valid = (Array.isArray(series) ? series : []).filter((p) => p && p.v != null && Number.isFinite(Number(p.v)));
  if (valid.length < 2) return null;
  const a = valid[0]; const b = valid[valid.length - 1];
  return { first: a.v, last: b.v, diff: b.v - a.v, firstTs: a.ts, lastTs: b.ts, points: valid.length };
}

/** 부분 합으로 비운 버킷 수(화면이 '일부 구간을 그리지 않았다' 고 밝힌다). */
export function partialCount(series) {
  return (Array.isArray(series) ? series : []).filter((p) => p && p.partial).length;
}
