/**
 * vmseries/spikes.js — 20초 표본 → 스파이크 순간 판정·패킹·run 계산(순수, v2.510).
 *
 * 입력은 vCenter QueryPerf(realtime, intervalId 20) 의 엔티티 하나분: Map<counterId, [{t:ISO, v:int}]>.
 * 같은 엔티티의 계열들은 sampleInfo 를 공유하므로 타임스탬프가 같다 — 그래도 계열마다 `t` 로
 * 맞춰 합친다(한 계열이 빠지거나 짧게 올 수 있다).
 *
 * 정직 규약
 *  - 결측(-1)은 값으로 남기고 판정에서만 제외한다. 0 으로 바꾸지 않는다.
 *  - 표본 0 이면 아무것도 만들지 않는다(빈 행을 '스파이크 없음' 으로 읽게 두지 않는다 —
 *    '없음' 은 coverage 행이 있을 때만 성립한다).
 *  - 임계를 넘는 순간이 하나도 없으면 spikes 는 빈 배열이고 coverage 만 남긴다.
 */
import { REALTIME_STEP_SEC } from './counters.js';

/**
 * 계열들을 시각 기준으로 합쳐 순간 배열로.
 * @param byCounter Map<counterId, [{t,v}]>
 * @param cols [{name, cid}] — 저장 순서(카탈로그 순). cid 가 null 이면(카탈로그에 없음) 그 열은 -1.
 * @returns [{ ts:number(ms), vals:number[] }] ts 오름차순, 중복 시각은 첫 값.
 */
export function alignMoments(byCounter, cols) {
  const byTs = new Map();
  cols.forEach((c, ci) => {
    if (!c.cid) return;
    for (const p of byCounter?.get?.(String(c.cid)) || byCounter?.get?.(c.cid) || []) {
      const ts = Date.parse(p.t);
      if (!Number.isFinite(ts)) continue;
      let m = byTs.get(ts);
      if (!m) { m = { ts, vals: new Array(cols.length).fill(-1) }; byTs.set(ts, m); }
      const v = Number(p.v);
      m.vals[ci] = Number.isFinite(v) ? Math.trunc(v) : -1;
    }
  });
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * 스파이크 순간인가. 트리거 열(cols[i].trigger)마다 임계와 비교한다.
 *  - cpuPct / memPct : 값(×100) ÷ 100 ≥ 임계(%)
 *  - readyPct        : ms ÷ (20초×1000) ÷ vCPU × 100 ≥ 임계(%)  (vCPU 를 모르면 판정 안 함)
 *  - nonzero         : 값 > 0 (벌룬·스왑 — 0 이 아닌 것 자체가 신호)
 * 결측(-1)은 어느 트리거도 만족하지 않는다.
 */
export function isSpike(vals, cols, thresholds, ctx = {}) {
  const thr = thresholds || {};
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i]; const v = vals[i];
    if (!c.trigger || v == null || v < 0) continue;
    if (c.trigger === 'cpuPct' && thr.cpuPct > 0 && v / (c.div || 1) >= thr.cpuPct) return true;
    if (c.trigger === 'memPct' && thr.memPct > 0 && v / (c.div || 1) >= thr.memPct) return true;
    if (c.trigger === 'readyPct' && thr.readyPct > 0 && ctx.vcpu > 0) {
      const pct = (v / (REALTIME_STEP_SEC * 1000) / ctx.vcpu) * 100;
      if (pct >= thr.readyPct) return true;
    }
    if (c.trigger === 'nonzero' && v > 0) return true;
  }
  return false;
}

/**
 * 순간 배열 → { spikes, samples, firstTs, lastTs, perHour:Map<h, n> }.
 * afterTs 이하의 순간은 이미 저장된 것(겹침 구간)이라 버린다 — 50분 주기 × 60분 버퍼의 10분 겹침.
 */
export function splitSpikes(moments, cols, thresholds, { afterTs = 0, ctx = {} } = {}) {
  const spikes = []; const perHour = new Map();
  let samples = 0; let firstTs = null; let lastTs = null;
  for (const m of moments) {
    if (m.ts <= afterTs) continue;
    samples++;
    if (firstTs == null) firstTs = m.ts;
    lastTs = m.ts;
    const h = Math.floor(m.ts / 3_600_000) * 3_600_000;
    perHour.set(h, (perHour.get(h) || 0) + 1);
    if (isSpike(m.vals, cols, thresholds, ctx)) spikes.push(m);
  }
  return { spikes, samples, firstTs, lastTs, perHour };
}

/**
 * 스파이크 순간들 → 연속 구간(run). 표본 간격의 1.5배 안에 이어지면 같은 run.
 * 반환 { count, maxSec, totalSec, runs:[{t0,t1,n}] }. 각 run 의 길이는 표본 수 × 20초로 센다
 * (마지막 표본의 구간까지 포함 — (t1-t0) 만 세면 1표본 run 이 0초가 된다).
 */
export function runsOf(spikeMoments, stepSec = REALTIME_STEP_SEC) {
  const runs = [];
  const gap = stepSec * 1500;
  let cur = null;
  for (const m of [...spikeMoments].sort((a, b) => a.ts - b.ts)) {
    if (cur && m.ts - cur.t1 <= gap) { cur.t1 = m.ts; cur.n++; continue; }
    cur = { t0: m.ts, t1: m.ts, n: 1 }; runs.push(cur);
  }
  let maxSec = 0; let totalSec = 0;
  for (const r of runs) { const s = r.n * stepSec; totalSec += s; if (s > maxSec) maxSec = s; }
  return { count: runs.length, maxSec, totalSec, runs };
}

/**
 * 순간들을 BLOB 로. 레이아웃: Int32 배열, 순간마다 [초 오프셋(t0 기준), v0, v1, …].
 * t0 = 첫 순간(ms, 초 단위로 내림). 반환 { t0, t1, n, buf }. n=0 이면 null.
 */
export function packMoments(moments, ncols) {
  if (!moments?.length) return null;
  const sorted = [...moments].sort((a, b) => a.ts - b.ts);
  const t0 = Math.floor(sorted[0].ts / 1000) * 1000;
  const stride = ncols + 1;
  const arr = new Int32Array(sorted.length * stride);
  sorted.forEach((m, i) => {
    arr[i * stride] = Math.round((m.ts - t0) / 1000);
    for (let k = 0; k < ncols; k++) {
      const v = m.vals[k];
      arr[i * stride + 1 + k] = (v == null || !Number.isFinite(v)) ? -1 : Math.max(-2147483648, Math.min(2147483647, v));
    }
  });
  return { t0, t1: sorted[sorted.length - 1].ts, n: sorted.length, buf: Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength) };
}

/** BLOB → 순간 배열. cols 길이가 저장 당시와 다르면(스키마 진화) 저장 당시 길이(ncols)를 쓴다. */
export function unpackMoments(buf, t0, ncols) {
  if (!buf || !buf.length || !(ncols > 0)) return [];
  const stride = ncols + 1;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const arr = new Int32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
  const out = [];
  for (let i = 0; i + stride <= arr.length; i += stride) {
    const vals = new Array(ncols);
    for (let k = 0; k < ncols; k++) vals[k] = arr[i + 1 + k];
    out.push({ ts: t0 + arr[i] * 1000, vals });
  }
  return out;
}

/** 순간 값을 표시 단위로(카탈로그 div). 결측(-1)은 null. */
export function momentToObject(m, cols) {
  const o = { t: m.ts };
  cols.forEach((c, i) => {
    const v = m.vals[i];
    o[c.name] = (v == null || v < 0) ? null : (c.div > 1 ? Math.round((v / c.div) * 100) / 100 : v);
  });
  return o;
}
