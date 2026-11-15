/**
 * focusmon/summary.js — 긴 구간(v3.13.0 ⑭ — 시안 History · 사용자 "기본값대로 모두 구현해줘")의 **요약 표** 한 곳.
 * 컨펌 ② '1분 요약과 1시간 요약 — 최저 · 평균 · 최고 · 표본 수 · 기록할 때 같이 만들고 · 30일 보관(원본 2초 표본도 30일)'.
 *
 *  · 1분 요약 = 1분 묶음(codec 묶음) 하나의 열마다 [표본 수, 평균, 최저, 최고]. 묶음이 닫힐 때(store) · 늦은 표본으로 다시 쓸 때 · 이미 쌓인 기록(백필)에 만든다.
 *  · 1시간 요약 = 그 시간의 1분 요약을 **표본 수로 가중**해 합친 것(평균은 가중 평균 · 최저 · 최고는 그대로).
 *  · 요약에 넣는 열(`summaryKeep`): 코어별(c.k*)은 빼고, 장치별은 물리 디스크(k='disk')의 util · rAwait · wAwait · rMB · wMB, 인터페이스별은 가상이 아닌 것의 rx · tx · u,
 *    그 밖(요약 s.* · CPU · 메모리 · 부하 · 전체 디스크 t.* · 더할 지표 k/v/p/q · 파일시스템 f.*)은 모두. 열 상한 `SUM_KEYS_MAX`.
 *  · 못 읽은 값(null · NaN)은 표본 수에 넣지 않는다 — 다 못 읽었으면 그 열을 싣지 않는다(0 이 아니다).
 *  · 바이트 = deflateRaw(JSON) · 깨진 행은 null(던지지 않는다 — 한 줄이 조회 전체를 깨지 않게).
 */
import zlib from 'node:zlib';

export const SUM_VERSION = 1;
export const SUM_KEYS_MAX = 600;
const DISK_COLS = new Set(['util', 'rAwait', 'wAwait', 'rMB', 'wMB']);
const NET_COLS = new Set(['rx', 'tx', 'u']);
const r2 = (v) => Math.round(v * 100) / 100;

/** 이 열을 요약에 넣는가(묶음 메타로 장치 · 인터페이스 종류를 본다). */
export function summaryKeep(k, meta) {
  if (/^c\.k\d+$/.test(k)) return false;
  if (k.startsWith('d.')) {
    const i = k.lastIndexOf('.'); if (i <= 2) return false;
    return meta?.dsk?.[k.slice(2, i)]?.k === 'disk' && DISK_COLS.has(k.slice(i + 1));
  }
  if (k.startsWith('n.')) {
    const i = k.lastIndexOf('.'); if (i <= 2) return false;
    const m = meta?.net?.[k.slice(2, i)];
    return !!m && m.k !== 'virt' && NET_COLS.has(k.slice(i + 1));
  }
  return true;
}

/**
 * 묶음 하나 → 1분 요약. block.cols 의 값은 배열(null) 또는 Float32Array(NaN) 둘 다 받는다.
 * @returns {{v:number, m:number, t0:number|null, t1:number|null, keys:string[], n:number[], a:number[], lo:number[], hi:number[], meta:object}|null}
 */
export function summarizeBlock(block) {
  if (!block || !block.cols || !block.ts || !block.ts.length) return null;
  const keys = []; const n = []; const a = []; const lo = []; const hi = [];
  for (const [k, arr] of block.cols) {
    if (keys.length >= SUM_KEYS_MAX) break;
    if (!summaryKeep(k, block.meta)) continue;
    let c = 0; let s = 0; let mn = Infinity; let mx = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v == null || Number.isNaN(v)) continue;
      c += 1; s += v; if (v < mn) mn = v; if (v > mx) mx = v;
    }
    if (!c) continue;
    keys.push(k); n.push(c); a.push(r2(s / c)); lo.push(r2(mn)); hi.push(r2(mx));
  }
  if (!keys.length) return null;
  const meta = { net: block.meta?.net || {}, dsk: block.meta?.dsk || {}, fs: block.meta?.fs || {} };
  return { v: SUM_VERSION, m: block.minute, t0: block.ts[0] ?? null, t1: block.ts[block.ts.length - 1] ?? null, keys, n, a, lo, hi, meta };
}

/**
 * 요약 여럿 → 하나(1시간 요약 · 화면 칸). 평균은 표본 수 가중 · 최저 · 최고는 그대로 · 메타는 뒤 것이 이긴다(이름표).
 * @param {object[]} list  summarizeBlock 결과(또는 이것의 결과)
 */
export function mergeSums(list) {
  const acc = new Map(); let t0 = null; let t1 = null; let meta = null;
  for (const s of list || []) {
    if (!s || !Array.isArray(s.keys)) continue;
    if (s.t0 != null) t0 = t0 == null ? s.t0 : Math.min(t0, s.t0);
    if (s.t1 != null) t1 = t1 == null ? s.t1 : Math.max(t1, s.t1);
    if (s.meta) meta = { net: { ...(meta?.net || {}), ...(s.meta.net || {}) }, dsk: { ...(meta?.dsk || {}), ...(s.meta.dsk || {}) }, fs: { ...(meta?.fs || {}), ...(s.meta.fs || {}) } };
    for (let i = 0; i < s.keys.length; i++) {
      const k = s.keys[i]; const c = s.n[i];
      if (!(c > 0)) continue;
      let x = acc.get(k);
      if (!x) { if (acc.size >= SUM_KEYS_MAX) continue; x = { n: 0, s: 0, lo: Infinity, hi: -Infinity }; acc.set(k, x); }
      x.n += c; x.s += s.a[i] * c; if (s.lo[i] < x.lo) x.lo = s.lo[i]; if (s.hi[i] > x.hi) x.hi = s.hi[i];
    }
  }
  if (!acc.size) return null;
  const keys = [...acc.keys()];
  return { v: SUM_VERSION, t0, t1, keys, n: keys.map((k) => acc.get(k).n), a: keys.map((k) => r2(acc.get(k).s / acc.get(k).n)), lo: keys.map((k) => acc.get(k).lo), hi: keys.map((k) => acc.get(k).hi), meta: meta || { net: {}, dsk: {}, fs: {} } };
}

/** 요약 → 바이트. */
export function encodeSum(s) { return zlib.deflateRawSync(Buffer.from(JSON.stringify(s), 'utf8'), { level: 6 }); }
/** 바이트 → 요약(모양이 다르면 null). */
export function decodeSum(buf) {
  try {
    const s = JSON.parse(zlib.inflateRawSync(buf, { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8'));
    if (s?.v !== SUM_VERSION || !Array.isArray(s.keys) || s.keys.length > SUM_KEYS_MAX) return null;
    for (const f of ['n', 'a', 'lo', 'hi']) if (!Array.isArray(s[f]) || s[f].length !== s.keys.length) return null;
    return s;
  } catch { return null; }
}
/** 요약의 열 하나 → {n, a, lo, hi} | null. */
export function sumCol(s, key) {
  if (!s) return null;
  const i = s.keys.indexOf(key);
  return i < 0 ? null : { n: s.n[i], a: s.a[i], lo: s.lo[i], hi: s.hi[i] };
}
