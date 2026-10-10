/**
 * v2.715 — 목업(mock) 모드 SAN 포트 사용량은 DB 를 조회하지 않고 수식으로 만든다(사용자 지시 "mock 모드에서 SAN 스위치
 *   모니터링이 계속 멈춘다 · 그냥 랜덤 숫자를 발생해서 채우는 걸로 · demo 서버 사양이 낮아 대기가 1분이 넘는다").
 *
 * 왜: 데모 SAN 86대 × 포트 약 70개를 5분마다 적재하면 하루 약 40만 행이 쌓이고, 트래픽 합계 조회 한 번이 그 전부를
 *   묶어 조립했다(빠른 장비에서 1.5~2.9초 — 사양이 낮은 데모 서버는 수십 초, 그동안 다른 요청이 전부 밀렸다).
 *   데모 숫자에는 의미가 없으므로 저장·집계를 하지 않고 응답 모양만 같게 만든다.
 *
 * 규칙: 실제 집계(perfDb.storageSeriesMulti 등)와 **같은 응답 모양**(buckets·series·sum·peak·avgTotal…)이어야 화면·
 *   trafficTotal 이 그대로 동작한다. 값은 포트 정보(port_meta — 장비×포트 수천 행)만 읽고 시각·키의 해시로 정한다
 *   (새로고침마다 바뀌지 않게 — 같은 시각이면 같은 값). 비용은 버킷 수 × 시리즈 수의 사인 계산뿐이다.
 *   이 경로는 **mock 모드 + 전부 `mock-san-` 장비**일 때만 탄다 — 사람이 등록한 장비는 예전처럼 DB 를 읽는다.
 */
const HOUR = 3600_000;
export const SAN_DEMO_PREFIX = 'mock-san-';

/** 이 조회를 수식으로 만들어도 되는가 — mock 모드이고 장비가 하나 이상이며 전부 데모 장비일 때만. */
export function isDemoPerfQuery(mock, deviceIds = []) {
  return !!mock && deviceIds.length > 0 && deviceIds.every((id) => String(id).startsWith(SAN_DEMO_PREFIX));
}

function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/** 한국 시각 낮에 오르고 밤에 내려가는 모양(데모 백필 sanDemoPortBps 와 같은 꼴). */
function diurnal(ts) {
  const h = (((ts / HOUR) + 9) % 24 + 24) % 24;
  return 0.45 + 0.55 * Math.max(0, Math.sin(((h - 6) / 24) * 2 * Math.PI)) + 0.12 * Math.sin((h / 24) * 4 * Math.PI);
}

/** 포트 기준 처리량(바이트/초): 어레이·호스트 포트는 수십~수백 MB/s, 이름 없는 포트는 작게. */
function portBase(deviceId, port, name) {
  const r = hash01(`${deviceId}|${port}`);
  return (name ? 20e6 + r * 380e6 : 1e6 + r * 30e6);
}

/** 키·버킷 시각으로 정하는 흔들림(0.7~1.3). 사인 두 개 — 해시 호출 없이 빠르다. */
function wobble(seed, ts) {
  const k = ts / 600_000;
  return 1 + 0.18 * Math.sin(seed * 31 + k * 1.7) + 0.12 * Math.sin(seed * 97 + k * 0.37);
}

/** 버킷 시작 시각 목록 — 실제 집계(ts / bucketMs 정수 나눗셈)와 같은 경계. */
export function demoBuckets(since, until, bucketMs) {
  const out = [];
  if (!(bucketMs > 0)) return out;
  for (let b = Math.floor(since / bucketMs); b * bucketMs <= until; b++) out.push(b * bucketMs);
  return out;
}

function totals(sum, peak) {
  const vals = sum.filter((v) => v != null);
  const pv = peak.filter((v) => v != null);
  return {
    avgTotal: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,
    maxTotal: vals.length ? Math.max(...vals) : 0,
    peakAvg: pv.length ? pv.reduce((a, b) => a + b, 0) / pv.length : 0,
    peakTotal: pv.length ? Math.max(...pv) : 0,
  };
}

/** 한 시계열(기준값 base)을 버킷마다 만든다 — 평균과 피크(평균의 1.1~1.4배). */
function seriesOf(base, seed, buckets) {
  const sum = new Array(buckets.length);
  const peak = new Array(buckets.length);
  for (let i = 0; i < buckets.length; i++) {
    const v = Math.max(0, Math.round(base * diurnal(buckets[i]) * wobble(seed, buckets[i])));
    sum[i] = v;
    peak[i] = Math.round(v * (1.1 + 0.3 * (0.5 + 0.5 * Math.sin(seed * 13 + i))));
  }
  return { sum, peak };
}

/*
 * v2.732(감사 B6-07): 계산 본체는 생성기 하나다 — 동기판(demoStorageMulti)과 양보판(demoStorageMultiAsync)이 **같은 코드**를 돈다
 *   (결과가 갈라지지 않게 — v2.731 ipam ledger 와 같은 방식). 생성기는 포트 행 256개마다·시리즈 하나마다 한 번 멈추고, 양보판은 그때
 *   호출자가 준 onYield(시간 기준 양보·취소 확인)를 부른다. 데모 260대(시리즈 수천 × 버킷 97)는 한 덩어리 약 430ms 였다(verify-B6).
 */
function* storageMultiSteps(metaRows, { since, until, bucketMs, groupOf = null, storageKey, carryMs = null }) {
  const buckets = demoBuckets(since, until, bucketMs);
  const byGroup = new Map();
  let n = 0;
  for (const m of metaRows) {
    const st = storageKey(m.attached_name);
    const g = groupOf ? (groupOf.get(String(m.device_id)) ?? '') : null;
    const gk = groupOf ? `${g}\u0000${st}` : st;
    if (!byGroup.has(gk)) byGroup.set(gk, { key: st, group: g, ports: [], base: 0 });
    const s = byGroup.get(gk);
    s.ports.push({ deviceId: String(m.device_id), port: Number(m.port) });
    s.base += portBase(m.device_id, m.port, m.attached_name);
    if ((++n & 255) === 0) yield;
  }
  const series = [];
  for (const [gk, s] of byGroup) {
    const { sum, peak } = seriesOf(s.base, hash01(gk) * 1000, buckets);
    series.push({
      key: s.key, group: s.group, ports: s.ports, deviceIds: [...new Set(s.ports.map((p) => p.deviceId))], sum, peak,
      ...totals(sum, peak), partial: [], partialBuckets: 0, carriedCells: 0,
    });
    yield;
  }
  series.sort((a, b) => b.avgTotal - a.avgTotal);
  return { buckets, bucketMs, since, until, series, carryMs, demo: true };
}

/**
 * storageSeriesMulti 와 같은 모양. metaRows: [{device_id, port, attached_name}] · storageKey: 이름 → 스토리지 키.
 */
export function demoStorageMulti(metaRows, opts) {
  const it = storageMultiSteps(metaRows, opts);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

/** 같은 계산의 양보판 — 생성기가 멈출 때마다 `onYield()`(시간 기준 양보·취소 확인 — 던지면 멈춘다)를 기다린다. 결과는 동기판과 같다. */
export async function demoStorageMultiAsync(metaRows, opts, onYield = null) {
  const it = storageMultiSteps(metaRows, opts);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    if (onYield) await onYield();
  }
}

/** storageSeries(장비 하나) 와 같은 모양. */
export function demoStorageOne(metaRows, { since, until, bucketMs, storageKey }) {
  const r = demoStorageMulti(metaRows, { since, until, bucketMs, storageKey });
  return {
    buckets: r.buckets, bucketMs, since, until, demo: true,
    series: r.series.map((s) => ({ key: s.key, ports: s.ports.map((p) => p.port).sort((a, b) => a - b), sum: s.sum, peak: s.peak,
      avgTotal: s.avgTotal, maxTotal: s.maxTotal, peakAvg: s.peakAvg, peakTotal: s.peakTotal })),
  };
}

/** portSeries 와 같은 모양. metaRows: [{port, attached_name, speed, port_type}] */
export function demoPortSeries(deviceId, metaRows, { since, until, bucketMs, ports = null }) {
  const buckets = demoBuckets(since, until, bucketMs);
  const want = ports?.length ? new Set(ports.map(Number)) : null;
  const series = [];
  for (const m of metaRows) {
    const p = Number(m.port);
    if (want && !want.has(p)) continue;
    const { sum, peak } = seriesOf(portBase(deviceId, p, m.attached_name), hash01(`${deviceId}|${p}`) * 1000, buckets);
    series.push({ port: p, name: m.attached_name || '', speed: m.speed || '', portType: m.port_type || '', avg: sum, peak, max: peak.length ? Math.max(...peak) : 0 });
  }
  series.sort((a, b) => a.port - b.port);
  return { buckets, bucketMs, since, until, series, demo: true };
}
