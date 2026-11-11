/**
 * bmstor/compareSet.js — ‘비교 세트’ 조립(순수, v2.962 — 사용자 요청 2026-11-10 "SAN 스토리지 A / SAN 스토리지 B · 가 법인의 SAN 스토리지 A / 가 법인의 베어메탈 AA
 * 이런 식으로 다양하게 각각의 스토리지의 성능을 비교" · 컨펌 '바로 구현 · IOPS · 응답 시간까지 · 표준').
 *
 * 대상(2~4개 · 섞어서) → 같은 격자 위의 지표 넷: 전송 속도(B/s) · IOPS · 응답 시간(ms) · 바쁨(%) — 각각 평균(avg[]) · 피크(peak[]).
 *   bm:<서버 id>      베어메탈 서버 한 대(diskstats — 평균 = 카운터 차분 · 피크 = 2초 표본 최댓값)
 *   bmg:<그룹 이름>   베어메탈 그룹(그룹에 든 서버 합 — 서버가 여러 그룹에 속할 수 있다)
 *   bmc:<법인 id>     그 법인의 베어메탈 전체(`__none__` = 법인 미지정)
 *   san:<시리얼>      SAN 어레이 — 전송 속도는 스위치 포트 트래픽(어레이 시리얼로 묶음), IOPS · 응답 시간 · 바쁨은 어레이가 보고한 5분 표본(REST 수집 어레이만)
 *
 * 규칙(설계 bm-san-compare §3 · 루트 '못 읽은 값은 0 이 아니다'):
 *  · 못 읽은 칸은 null · 사유는 **코드**(문장은 웹 compareSetText.js).
 *  · 합(전송 속도 · IOPS)은 **측정된 구성원 전부에 값이 있는 칸만**(부분 합 금지 — ioSeries.sumSeries 와 같은 규칙).
 *  · v2.971: **피크 = 2초 표본과 구간 평균 중 큰 값**(구간의 실제 최고치는 그 구간 평균보다 작을 수 없다 — 2초 표본만 쓰면 한가한 순간에 걸려
 *    피크 < 평균이 나왔다. 사용자 화면 2026-11-11). 묶음의 피크 합 = 구성원 피크(하한)의 합 — 같은 시각에 일어났다는 보장은 없다
 *    (v2.962 의 ‘동시 피크의 상한’ 은 틀린 설명이었다 — 정정).
 *  · 응답 시간은 평균의 평균이 아니라 **I/O 가중**(Σ소요 ms ÷ ΣI/O 횟수) — 칸 · 서버를 묶을 때도 합으로 낸다.
 *  · 바쁨은 ‘가장 바쁜 것’ — 서버는 가장 바쁜 디스크, 묶음은 가장 바쁜 서버, 어레이는 가장 바쁜 디렉터(FA busy) 또는 노드 · SP CPU. 뜻이 달라 화면이 출처를 함께 쓴다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { sumSeries, summarize } from './ioSeries.js';

export const MAX_TARGETS = 4;
export const SET_KINDS = Object.freeze(['bm', 'bmg', 'bmc', 'san']);
export const METRIC_KEYS = Object.freeze(['tput', 'iops', 'lat', 'busy']);

/** `ids=bm:x,san:y,…` → [{ kind, key, id }] — 아는 종류만 · 중복 제거 · 상한 4 · 키 128자. */
export function parseSetIds(q, { max = MAX_TARGETS } = {}) {
  const out = []; const seen = new Set();
  for (const raw of String(q || '').split(',')) {
    const t = raw.trim();
    const m = /^(bm|bmg|bmc|san):(.{1,128})$/.exec(t);
    if (!m) continue;
    const id = `${m[1]}:${m[2]}`;
    if (seen.has(id)) continue;
    seen.add(id); out.push({ kind: m[1], key: m[2], id });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 격자(ms) — 기본 격자(SAN 포트 사용량과 같은 rangeOf 결과)가 표본 간격보다 촘촘하면 **표본 간격으로 넓힌다**.
 * 이유: 수집 주기 10분인 서버를 1분 격자에 놓으면 10칸 중 9칸이 비어 선이 끊긴 점들만 남는다(점 표시 없이 그리면 아예 안 보인다).
 * 15분 · 1시간 집계 격자(기본이 표본보다 넓은 경우)는 그대로. 1분 단위로 올림.
 */
export function gridMs(baseMs, sampleFloorMs = 0) {
  const b = Math.max(60_000, Math.round(Number(baseMs) || 60_000));
  const f = Math.max(0, Number(sampleFloorMs) || 0);
  if (f <= b) return b;
  return Math.ceil(f / 60_000) * 60_000;
}

const blank = (n) => ({ avg: new Array(n).fill(null), peak: new Array(n).fill(null) });
/** 둘 중 큰 값 — 한쪽이 없으면 있는 쪽(피크 하한 = max(2초 표본, 구간 평균)). */
const up = (a, b) => { const x = numOrNull(a); const y = numOrNull(b); return x == null ? y : y == null ? x : Math.max(x, y); };
/** 칸마다 피크를 평균 위로(평균만 있는 칸은 평균이 피크의 하한). 제자리 수정. */
function liftPeak(m) {
  for (let i = 0; i < m.avg.length; i++) m.peak[i] = up(m.peak[i], m.avg[i]);
  return m;
}
const idxOf = (t, b0, bucketMs, n) => { const i = Math.floor((Number(t) - b0) / bucketMs); return i >= 0 && i < n ? i : -1; };

/**
 * 점 목록 → 격자. 점: { t, v(평균에 들어갈 값), p(피크 후보 — 없으면 v) }. 평균 = 칸 안 v 의 평균 · 피크 = 칸 안 p 의 최댓값. 값 없는 칸은 null.
 */
export function bucketize(points, buckets, bucketMs) {
  const n = buckets.length; const out = blank(n);
  if (!n) return out;
  const b0 = buckets[0]; const sum = new Array(n).fill(0); const cnt = new Array(n).fill(0);
  for (const pt of points || []) {
    const i = idxOf(pt?.t, b0, bucketMs, n);
    if (i < 0) continue;
    const v = numOrNull(pt.v);
    if (v != null) { sum[i] += v; cnt[i] += 1; }
    const p = numOrNull(pt.p ?? pt.v);
    if (p != null) out.peak[i] = out.peak[i] == null ? p : Math.max(out.peak[i], p);
  }
  for (let i = 0; i < n; i++) out.avg[i] = cnt[i] ? sum[i] / cnt[i] : null;
  return out;
}

/** 베어메탈 원시 행(ioDb.ioRawRows) → 지표 넷. 응답 시간 평균은 칸 안 Σd_ticks ÷ Σd_ios(I/O 가 0 이면 null). */
export function bmMetricsFromRaw(rows, buckets, bucketMs) {
  const n = buckets.length;
  // v2.971: 피크 후보 = max(2초 표본, 그 행의 구간 평균) — 행마다 올린 뒤 칸의 최댓값.
  const tput = bucketize((rows || []).map((r) => ({ t: r.ts, v: r.avgTotal, p: up(r.instTotal, r.avgTotal) })), buckets, bucketMs);
  const iops = bucketize((rows || []).map((r) => ({ t: r.ts, v: r.avgIops, p: up(r.instIops, r.avgIops) })), buckets, bucketMs);
  const busy = bucketize((rows || []).map((r) => ({ t: r.ts, v: r.avgBusy, p: up(r.busy, r.avgBusy) })), buckets, bucketMs);
  const lat = { ...blank(n), sDios: new Array(n).fill(null), sDticks: new Array(n).fill(null) };
  if (n) {
    const b0 = buckets[0];
    for (const r of rows || []) {
      const i = idxOf(r.ts, b0, bucketMs, n);
      if (i < 0) continue;
      const di = numOrNull(r.dIos); const dt = numOrNull(r.dTicks);
      if (di != null && dt != null && di >= 0 && dt >= 0) { lat.sDios[i] = (lat.sDios[i] ?? 0) + di; lat.sDticks[i] = (lat.sDticks[i] ?? 0) + dt; }
      const rowLat = di != null && dt != null && di > 0 && dt >= 0 ? Math.round((dt / di) * 100) / 100 : null;
      const p = up(r.instLat, rowLat);
      if (p != null) lat.peak[i] = lat.peak[i] == null ? p : Math.max(lat.peak[i], p);
    }
    for (let i = 0; i < n; i++) lat.avg[i] = lat.sDios[i] > 0 ? Math.round((lat.sDticks[i] / lat.sDios[i]) * 100) / 100 : null;
  }
  liftPeak(tput); liftPeak(iops); liftPeak(lat); liftPeak(busy);
  return { tput, iops, lat, busy };
}

/** 베어메탈 집계 표 행(ioDb.ioRollupRows) → 지표 넷. 격자가 표 단위의 정배수라 여러 행이 한 칸에 들어간다. */
export function bmMetricsFromRollup(rows, buckets, bucketMs) {
  const n = buckets.length;
  const z = () => new Array(n).fill(0);
  const acc = { nAvg: z(), sAvg: z(), nIops: z(), sIops: z(), nBusy: z(), sBusy: z(), sDios: z(), sDticks: z(), seen: new Array(n).fill(false) };
  const out = { tput: blank(n), iops: blank(n), lat: { ...blank(n), sDios: new Array(n).fill(null), sDticks: new Array(n).fill(null) }, busy: blank(n) };
  if (!n) return out;
  const b0 = buckets[0];
  const mx = (arr, i, v) => { const x = numOrNull(v); if (x != null) arr[i] = arr[i] == null ? x : Math.max(arr[i], x); };
  for (const r of rows || []) {
    const i = idxOf(r.b, b0, bucketMs, n);
    if (i < 0) continue;
    acc.seen[i] = true;
    if (r.nAvg > 0) { acc.nAvg[i] += r.nAvg; acc.sAvg[i] += r.sumAvg; }
    if (r.nIops > 0) { acc.nIops[i] += r.nIops; acc.sIops[i] += r.sumIops; }
    if (r.nAbusy > 0) { acc.nBusy[i] += r.nAbusy; acc.sBusy[i] += r.sumAbusy; }
    if (r.sumDios > 0) { acc.sDios[i] += r.sumDios; acc.sDticks[i] += r.sumDticks; }
    mx(out.tput.peak, i, r.maxInst); mx(out.iops.peak, i, r.maxIops); mx(out.lat.peak, i, r.maxLat); mx(out.busy.peak, i, r.maxBusy);
  }
  for (let i = 0; i < n; i++) {
    out.tput.avg[i] = acc.nAvg[i] ? Math.round(acc.sAvg[i] / acc.nAvg[i]) : null;
    out.iops.avg[i] = acc.nIops[i] ? Math.round((acc.sIops[i] / acc.nIops[i]) * 100) / 100 : null;
    out.busy.avg[i] = acc.nBusy[i] ? Math.round((acc.sBusy[i] / acc.nBusy[i]) * 10) / 10 : null;
    if (acc.seen[i] && acc.nIops[i]) { out.lat.sDios[i] = acc.sDios[i]; out.lat.sDticks[i] = acc.sDticks[i]; }
    out.lat.avg[i] = acc.sDios[i] > 0 ? Math.round((acc.sDticks[i] / acc.sDios[i]) * 100) / 100 : null;
  }
  // v2.971: v2.971 이전 집계 행의 max_* 는 2초 표본뿐이다 — 읽을 때 칸 평균 위로 올린다(새 행은 적재 때 이미 올라가 있다).
  liftPeak(out.tput); liftPeak(out.iops); liftPeak(out.lat); liftPeak(out.busy);
  return out;
}

/**
 * 베어메탈 여러 대 → 묶음(그룹 · 법인). 측정된 구성원(그 지표에 값이 하나라도 있는 서버)만 보고, 칸마다 그 구성원 **전부**에 값이 있을 때만 낸다.
 *  · 전송 속도 · IOPS: 합(sumSeries — 피크도 구성원 전부의 합 · 구성원 피크가 비면 그 구성원의 평균) · 응답 시간: Σd_ticks ÷ Σd_ios · 바쁨: 최댓값(가장 바쁜 서버).
 * @returns {{ metrics:{tput,iops,lat,busy}, measured:Object<string,number>, partial:Object<string,number> }}
 */
export function combineBm(members, n) {
  const list = (members || []).filter(Boolean);
  const tput = sumSeries(list.map((m) => m.tput), n);
  const iops = sumSeries(list.map((m) => m.iops), n);
  const latMembers = list.filter((m) => (m.lat?.sDios || []).some((v) => v != null));
  const lat = { ...blank(n), sDios: new Array(n).fill(null), sDticks: new Array(n).fill(null) };
  let latPartial = 0;
  for (let i = 0; i < n; i++) {
    if (!latMembers.length) break;
    let di = 0; let dt = 0; let pk = null; let broken = false;
    for (const m of latMembers) {
      if (m.lat.sDios[i] == null) { broken = true; break; }
      di += m.lat.sDios[i]; dt += m.lat.sDticks[i] ?? 0;
      const p = numOrNull(m.lat.peak?.[i]); if (p != null) pk = pk == null ? p : Math.max(pk, p);
    }
    if (broken) { latPartial += 1; continue; }
    lat.sDios[i] = di; lat.sDticks[i] = dt; lat.avg[i] = di > 0 ? Math.round((dt / di) * 100) / 100 : null; lat.peak[i] = pk;
  }
  const busyMembers = list.filter((m) => (m.busy?.avg || []).some((v) => v != null));
  const busy = blank(n); let busyPartial = 0;
  for (let i = 0; i < n; i++) {
    // 피크는 **최댓값**이라 구성원 일부만 있어도 실제 최고치의 하한이다(합과 달리 부분이 아래로 끌어내리지 않는다) — 평균이 없는 구성원
    //   (구버전 엣지 — 바쁨 평균을 모름)의 2초 표본도 넣는다(반증 F3: 예전에는 그 구성원이 빠져 묶음 피크 12 < 그 서버 2초 바쁨 35).
    for (const m of list) { const q = numOrNull(m.busy?.peak?.[i]); if (q != null) busy.peak[i] = busy.peak[i] == null ? q : Math.max(busy.peak[i], q); }
    if (!busyMembers.length) continue;
    let a = null; let broken = false;
    for (const m of busyMembers) {
      const v = numOrNull(m.busy.avg[i]);
      if (v == null) { broken = true; break; }
      a = a == null ? v : Math.max(a, v);
    }
    if (broken) { busyPartial += 1; continue; }
    busy.avg[i] = a;
  }
  liftPeak(busy);
  return {
    metrics: { tput: { avg: tput.avg, peak: tput.peak }, iops: { avg: iops.avg, peak: iops.peak }, lat, busy },
    measured: { tput: tput.measured, iops: iops.measured, lat: latMembers.length, busy: busyMembers.length },
    partial: { tput: tput.partial.length, iops: iops.partial.length, lat: latPartial, busy: busyPartial },
  };
}

/** 스위치 포트 합(storageSeriesMulti 계열의 sum · peak — 희소 버킷) → 우리 격자. */
export function switchTput(aggBuckets, sum, peak, buckets, bucketMs) {
  const pts = [];
  for (let i = 0; i < (aggBuckets || []).length; i++) {
    const v = numOrNull(sum?.[i]); const p = numOrNull(peak?.[i]);
    if (v == null && p == null) continue;
    pts.push({ t: aggBuckets[i], v, p: p ?? v });
  }
  return bucketize(pts, buckets, bucketMs);
}

/**
 * 어레이 측 5분 표본(storage db.nodeLoadQuery group 'fe' 의 행) → IOPS · 응답 시간 · 바쁨 · 호스트 처리량. 단위는 부모(fa · node · sp)만 — 포트는 중복이라 뺀다.
 *  · 시각마다: IOPS · 처리량 = 부모 **전부**의 합(하나라도 없으면 그 시각은 null — arraySide.summarizeLatest 와 같은 규칙) · 응답 시간 = 최댓값 ·
 *    바쁨 = FA busy 최댓값(PowerMax) 또는 노드 · SP CPU 최댓값(PowerStore · Unity).
 *  · 집계 행(시간 요약 · 일 롤업)은 v = 평균 · mx = 최댓값 — 피크는 mx 로.
 * @param {Array<{node:number, ts:number, v:object, mx?:object}>} rows
 * @param {Array<{id:number, kind:string}>} units unitsForArray 결과
 */
export function feMetrics(rows, units, buckets, bucketMs) {
  const n = buckets.length;
  const parents = (units || []).filter((u) => u && u.kind !== 'port');
  const catalog = new Set(parents.map((u) => Number(u.id)));
  const kindOf = new Map(parents.map((u) => [Number(u.id), u.kind]));
  const byTs = new Map();
  // 합의 '전부' 는 **이 창에 한 번이라도 나온 부모 단위**다 — 카탈로그 전체로 하면 오래전에 빠진 디렉터 하나 때문에 모든 합이 null 이 된다.
  const parentIds = new Set();
  for (const r of rows || []) {
    const id = numOrNull(r?.node); const ts = numOrNull(r?.ts);
    if (id == null || ts == null || !catalog.has(id)) continue;
    parentIds.add(id);
    if (!byTs.has(ts)) byTs.set(ts, []);
    byTs.get(ts).push(r);
  }
  const pts = { iops: [], lat: [], busy: [], hbps: [] };
  for (const [ts, list] of byTs) {
    const sumOf = (k, which) => {
      let s = 0;
      for (const id of parentIds) {
        const r = list.find((x) => Number(x.node) === id);
        const v = numOrNull(which === 'mx' ? (r?.mx?.[k] ?? r?.v?.[k]) : r?.v?.[k]);
        if (v == null) return null;
        s += v;
      }
      return s;
    };
    const maxOf = (pick, which) => {
      let m = null;
      for (const r of list) {
        const k = pick(kindOf.get(Number(r.node)));
        if (!k) continue;
        const v = numOrNull(which === 'mx' ? (r?.mx?.[k] ?? r?.v?.[k]) : r?.v?.[k]);
        if (v != null) m = m == null ? v : Math.max(m, v);
      }
      return m;
    };
    pts.iops.push({ t: ts, v: sumOf('iops'), p: sumOf('iops', 'mx') });
    pts.hbps.push({ t: ts, v: sumOf('hbps'), p: sumOf('hbps', 'mx') });
    pts.lat.push({ t: ts, v: maxOf(() => 'lat'), p: maxOf(() => 'lat', 'mx') });
    const busyKey = (kind) => (kind === 'fa' ? 'busy' : kind === 'node' || kind === 'sp' ? 'cpu' : null);
    pts.busy.push({ t: ts, v: maxOf(busyKey), p: maxOf(busyKey, 'mx') });
  }
  const busyBasis = [...parentIds].some((id) => kindOf.get(id) === 'fa') ? 'fa-busy' : parentIds.size ? 'cpu' : null;
  return {
    iops: bucketize(pts.iops, buckets, bucketMs), lat: bucketize(pts.lat, buckets, bucketMs),
    busy: bucketize(pts.busy, buckets, bucketMs), hbps: bucketize(pts.hbps, buckets, bucketMs),
    units: parentIds.size, busyBasis, samples: byTs.size, n,
  };
}

/** 지표 하나 마무리 — 요약(평균의 평균 · 피크 최댓값 · 점 수)과 출처 · 사유. 값이 하나도 없으면 사유를 남긴다. */
export function finishMetric(m, { source = null, reason = null, extra = {} } = {}) {
  const avg = m?.avg || []; const peak = m?.peak || [];
  const sm = summarize({ avg, peak });
  // ioSeries.summarize 는 평균을 정수로 반올림한다(B/s · IOPS 용). 응답 시간(ms) · 바쁨(%)은 소수가 뜻이라 그대로 쓰면
  // 평균 2.6 ms 가 3 으로 올라가 피크(2.6)보다 커 보였다(v2.962 화면 확인에서 발견) — 평균은 반올림 없이 다시 낸다(소수 셋째 자리).
  const av = avg.filter((v) => v != null);
  if (av.length) sm.avgTotal = Math.round((av.reduce((a, b) => a + b, 0) / av.length) * 1000) / 1000;
  return { avg, peak, ...sm, source, reason: sm.points ? null : (reason || 'no-data'), ...extra };
}

/** 대상 순서(입력 순서)대로 기준(첫 대상) 대비 비율 — 웹이 쓰는 값과 같은 정의를 서버도 싣는다(테스트 대조용). 기준이 0 · null 이면 null. */
export function ratioToBase(value, base) {
  const v = numOrNull(value); const b = numOrNull(base);
  if (v == null || b == null || b === 0) return null;
  return Math.round((v / b) * 100) / 100;
}
